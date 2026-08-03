import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { ExecutionTrace } from "@ai-dev-os/process-broker";
import type { CodexAdapterConfiguration } from "./config.js";
import { resolveCodexCompatibility, type CodexCompatibilityProfile } from "./compatibility.js";
import type { CodexProcessPort } from "./ports.js";

export const CODEX_PROBE_STATUSES = Object.freeze(["ready", "incompatible", "failed"] as const);
export type CodexProbeStatus = (typeof CODEX_PROBE_STATUSES)[number];
export interface CodexProbeResult {
  readonly status: CodexProbeStatus;
  readonly version: string | null;
  readonly schemaDigest: string | null;
  readonly schemaFileCount: number;
  readonly methods: readonly string[];
  readonly compatibility: CodexCompatibilityProfile | null;
  readonly detailCode: "probe-failed" | "probe-unparseable" | "version-unsupported" | "schema-incompatible" | null;
}

export function parseCodexVersionBanner(text: string): string | null {
  const match = /^codex-cli\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/m.exec(text.slice(0, 512));
  return match?.[1] ?? null;
}

interface SchemaBundle { readonly digest: string; readonly methods: readonly string[]; readonly fileCount: number }

export async function readCodexSchemaBundle(directory: string, limits: { readonly maxFiles: number; readonly maxBytes: number }): Promise<SchemaBundle> {
  const root = resolve(directory);
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const name of await readdir(current)) {
      const target = join(current, name);
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink()) throw new Error("schema-link");
      if (metadata.isDirectory()) await walk(target);
      else if (metadata.isFile() && name.endsWith(".json")) files.push(target);
      if (files.length > limits.maxFiles) throw new Error("schema-file-limit");
    }
  }
  await walk(root);
  files.sort();
  const digest = createHash("sha256");
  const methods = new Set<string>();
  let total = 0;
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) inspect(item); return; }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    const properties = record["properties"];
    if (typeof properties === "object" && properties !== null && !Array.isArray(properties)) {
      const method = (properties as Record<string, unknown>)["method"];
      if (typeof method === "object" && method !== null && !Array.isArray(method)) {
        const methodRecord = method as Record<string, unknown>;
        const constant = methodRecord["const"];
        if (typeof constant === "string" && constant.length <= 128) methods.add(constant);
        const enumeration = methodRecord["enum"];
        if (Array.isArray(enumeration)) for (const entry of enumeration) if (typeof entry === "string" && entry.length <= 128) methods.add(entry);
      }
    }
    for (const [key, child] of Object.entries(record)) if (key !== "__proto__" && key !== "constructor" && key !== "prototype") inspect(child);
  };
  for (const file of files) {
    const bytes = await readFile(file);
    total += bytes.byteLength;
    if (total > limits.maxBytes) throw new Error("schema-byte-limit");
    const name = relative(root, file).replace(/\\/g, "/");
    digest.update(name).update("\0").update(bytes).update("\0");
    inspect(JSON.parse(bytes.toString("utf8")) as unknown);
  }
  return Object.freeze({ digest: digest.digest("hex"), methods: Object.freeze([...methods].sort()), fileCount: files.length });
}

export async function probeCodex(input: {
  readonly configuration: CodexAdapterConfiguration;
  readonly process: CodexProcessPort;
  readonly workspaceId: string;
  readonly schemaOutputDirectory: string;
  readonly trace: ExecutionTrace;
  readonly signal?: AbortSignal;
}): Promise<CodexProbeResult> {
  try {
    const versionResult = await input.process.execute({
      kind: "probe", args: ["--version"], deadline: null,
      wallClockMs: input.configuration.deadlines.handshakeMs,
      outputBytes: Math.min(65_536, input.configuration.ceilings.maxProcessOutputBytes),
      environment: [], workspaceId: input.workspaceId, trace: input.trace,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (!versionResult.succeeded) return failed("probe-failed");
    const version = parseCodexVersionBanner(Buffer.from(versionResult.output.stdout.bytes).toString("utf8"));
    if (version === null) return failed("probe-unparseable");
    const schemaResult = await input.process.execute({
      kind: "schema", args: ["app-server", "generate-json-schema", "--out", input.schemaOutputDirectory], deadline: null,
      wallClockMs: input.configuration.deadlines.handshakeMs,
      outputBytes: Math.min(65_536, input.configuration.ceilings.maxProcessOutputBytes),
      environment: [], workspaceId: input.workspaceId, trace: input.trace,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (!schemaResult.succeeded) return failed("probe-failed", version);
    const schema = await readCodexSchemaBundle(input.schemaOutputDirectory, { maxFiles: 2_048, maxBytes: 64 * 1_024 * 1_024 });
    const compatibility = resolveCodexCompatibility({
      version,
      minimum: input.configuration.compatibility.minimum,
      validatedMaximum: input.configuration.compatibility.validatedMaximum,
      schemaDigest: schema.digest,
      methods: schema.methods,
    });
    const detailCode = compatibility.tier === "unsupported-too-old" ? "version-unsupported" : compatibility.tier === "schema-incompatible" ? "schema-incompatible" : null;
    return Object.freeze({
      status: detailCode === null ? "ready" : "incompatible",
      version,
      schemaDigest: schema.digest,
      schemaFileCount: schema.fileCount,
      methods: schema.methods,
      compatibility,
      detailCode,
    });
  } catch {
    return failed("probe-failed");
  }
}

function failed(detailCode: CodexProbeResult["detailCode"], version: string | null = null): CodexProbeResult {
  return Object.freeze({ status: "failed", version, schemaDigest: null, schemaFileCount: 0, methods: Object.freeze([]), compatibility: null, detailCode });
}
