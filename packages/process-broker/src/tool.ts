/**
 * Executable identity.
 *
 * Executables are never resolved through an ambient `PATH`. A caller names a
 * trusted tool by descriptor; the broker resolves exactly that path, checks
 * the file type, refuses link indirection, and verifies the content digest
 * immediately before the process starts.
 *
 * Honest limitation: on a same-user backend the digest check is a
 * time-of-check/time-of-use guarantee only. Between the final verification and
 * the kernel's image load, a process running as the same user can replace the
 * file. The digest check raises the cost of substitution and produces audit
 * evidence; it is not a security boundary. A secure backend supplies an
 * immutable mount or backend tool reference instead, and that reference — not
 * the digest — is the enforcing mechanism.
 */

import { createHash } from "node:crypto";
import { open, lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { validation } from "@ai-dev-os/domain";
import { ProcessBrokerError, errorCategory, invalidRequest } from "./errors.js";

const { ensureArray, ensureBoolean, ensureEnum, ensureExactKeys, ensureRecord, ensureString } =
  validation;

export const TOOL_PLATFORMS = Object.freeze(["win32", "darwin", "linux"] as const);
export type ToolPlatform = (typeof TOOL_PLATFORMS)[number];

export const TOOL_ARCHITECTURES = Object.freeze(["x64", "arm64"] as const);
export type ToolArchitecture = (typeof TOOL_ARCHITECTURES)[number];

/**
 * Where the trust in this tool comes from. This is recorded in audit records
 * so a reviewer can tell an operator-pinned tool from a discovered one.
 */
export const TOOL_TRUST_SOURCES = Object.freeze([
  "operator-pinned",
  "backend-provided",
  "package-manifest",
] as const);
export type ToolTrustSource = (typeof TOOL_TRUST_SOURCES)[number];

export const DIGEST_ALGORITHMS = Object.freeze(["sha-256", "sha-512"] as const);
export type ToolDigestAlgorithm = (typeof DIGEST_ALGORITHMS)[number];

export interface ToolDigest {
  readonly algorithm: ToolDigestAlgorithm;
  readonly hex: string;
}

export const MAX_TOOL_ARGUMENTS = 4_096;
export const MAX_ARGUMENT_BYTES = 131_072;
export const MAX_TOTAL_ARGUMENT_BYTES = 1_048_576;
const MAX_EXECUTABLE_PATH_LENGTH = 1_024;
const DIGEST_LENGTHS: Readonly<Record<ToolDigestAlgorithm, number>> = Object.freeze({
  "sha-256": 64,
  "sha-512": 128,
});
const NODE_DIGEST_NAMES: Readonly<Record<ToolDigestAlgorithm, string>> = Object.freeze({
  "sha-256": "sha256",
  "sha-512": "sha512",
});

export function parseToolDigest(value: unknown, path = "digest"): ToolDigest {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ["algorithm", "hex"], path);
  const algorithm = ensureEnum(record["algorithm"], `${path}.algorithm`, DIGEST_ALGORITHMS);
  const expected = DIGEST_LENGTHS[algorithm];
  const hex = ensureString(record["hex"], `${path}.hex`, {
    minLength: expected,
    maxLength: expected,
    pattern: /^[0-9a-f]+$/,
    patternName: "lowercase hexadecimal",
  });
  return Object.freeze({ algorithm, hex });
}

/**
 * Constrains what may be passed to one tool.
 *
 * `pinnedLeadingArguments`, when present, fixes an exact argv prefix. This is
 * how a package-manager style tool is represented safely on Windows: a trusted
 * `node.exe` plus the verified CLI entry point, rather than a `.cmd` shim that
 * would require shell interpretation.
 */
export interface ToolArgumentPolicy {
  readonly maxArguments: number;
  readonly maxArgumentBytes: number;
  readonly pinnedLeadingArguments: readonly string[] | null;
  /** Rejects arguments starting with `-` beyond the pinned prefix. */
  readonly denyOptionArguments: boolean;
}

export interface TrustedToolDescriptor {
  readonly toolId: string;
  /** Absolute path to the exact image. Never a shim, never resolved via PATH. */
  readonly executablePath: string;
  readonly expectedDigest: ToolDigest | null;
  /**
   * A backend-supplied immutable reference (a read-only mount identifier, a
   * container image digest, or an equivalent). When a secure backend provides
   * one, it — not the same-user digest check — is the enforcing identity.
   */
  readonly immutableReference: string | null;
  /** Absolute directory the resolved image must stay inside, when required. */
  readonly containmentRoot: string | null;
  readonly platform: ToolPlatform;
  readonly architecture: ToolArchitecture;
  readonly argumentPolicy: ToolArgumentPolicy;
  readonly versionEvidence: string | null;
  readonly trustSource: ToolTrustSource;
  /** Set when the descriptor knowingly points at a link. Default false. */
  readonly allowLinkIndirection: boolean;
}

const DESCRIPTOR_KEYS = [
  "toolId",
  "executablePath",
  "expectedDigest",
  "immutableReference",
  "containmentRoot",
  "platform",
  "architecture",
  "argumentPolicy",
  "versionEvidence",
  "trustSource",
  "allowLinkIndirection",
] as const;

const ARGUMENT_POLICY_KEYS = [
  "maxArguments",
  "maxArgumentBytes",
  "pinnedLeadingArguments",
  "denyOptionArguments",
] as const;

function parseAbsolutePath(value: unknown, path: string): string {
  const text = ensureString(value, path, { maxLength: MAX_EXECUTABLE_PATH_LENGTH });
  if (text.includes("\u0000")) {
    throw invalidRequest("A filesystem path contains a NUL character.", { field: path });
  }
  if (!isAbsolute(text)) {
    throw invalidRequest("A filesystem path must be absolute.", { field: path });
  }
  return resolve(text);
}

function parseArgumentPolicy(value: unknown, path: string): ToolArgumentPolicy {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, ARGUMENT_POLICY_KEYS, path);
  const maxArguments = validation.ensureSafeInteger(
    record["maxArguments"],
    `${path}.maxArguments`,
    0,
    MAX_TOOL_ARGUMENTS,
  );
  const maxArgumentBytes = validation.ensureSafeInteger(
    record["maxArgumentBytes"],
    `${path}.maxArgumentBytes`,
    1,
    MAX_ARGUMENT_BYTES,
  );
  const rawPinned = record["pinnedLeadingArguments"];
  let pinned: readonly string[] | null = null;
  if (rawPinned !== undefined && rawPinned !== null) {
    const entries = ensureArray(rawPinned, `${path}.pinnedLeadingArguments`, MAX_TOOL_ARGUMENTS);
    pinned = Object.freeze(
      entries.map((entry, index) =>
        ensureString(entry, `${path}.pinnedLeadingArguments[${index}]`, {
          maxLength: maxArgumentBytes,
        }),
      ),
    );
    if (pinned.length > maxArguments) {
      throw invalidRequest("The pinned argument prefix exceeds the tool argument limit.", {
        pinnedCount: pinned.length,
        maxArguments,
      });
    }
  }
  return Object.freeze({
    maxArguments,
    maxArgumentBytes,
    pinnedLeadingArguments: pinned,
    denyOptionArguments: ensureBoolean(
      record["denyOptionArguments"],
      `${path}.denyOptionArguments`,
    ),
  });
}

export function parseTrustedToolDescriptor(
  value: unknown,
  path = "tool",
): TrustedToolDescriptor {
  const record = ensureRecord(value, path);
  ensureExactKeys(record, DESCRIPTOR_KEYS, path);
  const executablePath = parseAbsolutePath(record["executablePath"], `${path}.executablePath`);
  const containmentRootValue = record["containmentRoot"];
  const containmentRoot =
    containmentRootValue === undefined || containmentRootValue === null
      ? null
      : parseAbsolutePath(containmentRootValue, `${path}.containmentRoot`);
  const digestValue = record["expectedDigest"];
  const immutableValue = record["immutableReference"];
  const versionValue = record["versionEvidence"];
  return Object.freeze({
    toolId: ensureString(record["toolId"], `${path}.toolId`, {
      maxLength: 64,
      pattern: /^[a-z][a-z0-9._-]{0,63}$/,
      patternName: "tool identifier",
    }),
    executablePath,
    expectedDigest:
      digestValue === undefined || digestValue === null
        ? null
        : parseToolDigest(digestValue, `${path}.expectedDigest`),
    immutableReference:
      immutableValue === undefined || immutableValue === null
        ? null
        : ensureString(immutableValue, `${path}.immutableReference`, { maxLength: 256 }),
    containmentRoot,
    platform: ensureEnum(record["platform"], `${path}.platform`, TOOL_PLATFORMS),
    architecture: ensureEnum(record["architecture"], `${path}.architecture`, TOOL_ARCHITECTURES),
    argumentPolicy: parseArgumentPolicy(record["argumentPolicy"], `${path}.argumentPolicy`),
    versionEvidence:
      versionValue === undefined || versionValue === null
        ? null
        : ensureString(versionValue, `${path}.versionEvidence`, { maxLength: 128 }),
    trustSource: ensureEnum(record["trustSource"], `${path}.trustSource`, TOOL_TRUST_SOURCES),
    allowLinkIndirection: ensureBoolean(
      record["allowLinkIndirection"],
      `${path}.allowLinkIndirection`,
    ),
  });
}

export function createTrustedToolDescriptor(input: {
  readonly toolId: string;
  readonly executablePath: string;
  readonly platform: ToolPlatform;
  readonly architecture: ToolArchitecture;
  readonly trustSource: ToolTrustSource;
  readonly expectedDigest?: ToolDigest | null;
  readonly immutableReference?: string | null;
  readonly containmentRoot?: string | null;
  readonly versionEvidence?: string | null;
  readonly allowLinkIndirection?: boolean;
  readonly argumentPolicy?: Partial<ToolArgumentPolicy>;
}): TrustedToolDescriptor {
  const policy = input.argumentPolicy ?? {};
  return parseTrustedToolDescriptor({
    toolId: input.toolId,
    executablePath: input.executablePath,
    expectedDigest: input.expectedDigest ?? null,
    immutableReference: input.immutableReference ?? null,
    containmentRoot: input.containmentRoot ?? null,
    platform: input.platform,
    architecture: input.architecture,
    argumentPolicy: {
      maxArguments: policy.maxArguments ?? 256,
      maxArgumentBytes: policy.maxArgumentBytes ?? 32_768,
      pinnedLeadingArguments: policy.pinnedLeadingArguments ?? null,
      denyOptionArguments: policy.denyOptionArguments ?? false,
    },
    versionEvidence: input.versionEvidence ?? null,
    trustSource: input.trustSource,
    allowLinkIndirection: input.allowLinkIndirection ?? false,
  });
}

/** Rejects Windows shim executables that only work through a shell. */
const WINDOWS_SHELL_SHIM = /\.(cmd|bat)$/i;

export interface ResolvedTool {
  readonly toolId: string;
  /** The exact path handed to the operating system. */
  readonly executablePath: string;
  readonly digest: ToolDigest | null;
  readonly immutableReference: string | null;
}

/**
 * Validates a descriptor against the live filesystem and returns the exact
 * image to execute. Callers run this immediately before spawning; running it
 * earlier only widens the check-to-use window.
 */
export async function resolveTrustedTool(
  descriptor: TrustedToolDescriptor,
  options: { readonly platform?: NodeJS.Platform } = {},
): Promise<ResolvedTool> {
  const platform = options.platform ?? process.platform;
  if (descriptor.platform !== platform) {
    throw new ProcessBrokerError(
      "EXECUTABLE_UNAVAILABLE",
      "The tool descriptor targets a different platform.",
      { toolId: descriptor.toolId, descriptorPlatform: descriptor.platform },
    );
  }
  if (platform === "win32" && WINDOWS_SHELL_SHIM.test(descriptor.executablePath)) {
    throw new ProcessBrokerError(
      "EXECUTABLE_UNSAFE",
      "Windows command-script shims require shell interpretation and are refused. Reference the interpreter and the verified entry point instead.",
      { toolId: descriptor.toolId },
    );
  }

  let info;
  try {
    info = await lstat(descriptor.executablePath);
  } catch (error) {
    throw new ProcessBrokerError("EXECUTABLE_UNAVAILABLE", "The tool image could not be inspected.", {
      toolId: descriptor.toolId,
      cause: errorCategory(error),
    });
  }
  // A symbolic link, junction, or other reparse point is indirection the
  // descriptor did not authorize: the bytes verified may not be the bytes run.
  if (info.isSymbolicLink() && !descriptor.allowLinkIndirection) {
    throw new ProcessBrokerError(
      "EXECUTABLE_UNSAFE",
      "The tool path is a link or reparse point and the descriptor does not allow indirection.",
      { toolId: descriptor.toolId },
    );
  }
  if (!info.isFile() && !info.isSymbolicLink()) {
    throw new ProcessBrokerError("EXECUTABLE_UNSAFE", "The tool path is not a regular file.", {
      toolId: descriptor.toolId,
    });
  }

  if (descriptor.containmentRoot !== null) {
    let resolved: string;
    try {
      resolved = await realpath(descriptor.executablePath);
    } catch (error) {
      throw new ProcessBrokerError(
        "EXECUTABLE_UNAVAILABLE",
        "The tool image could not be resolved.",
        { toolId: descriptor.toolId, cause: errorCategory(error) },
      );
    }
    const root = descriptor.containmentRoot;
    if (resolved !== root && !resolved.startsWith(root.endsWith(sep) ? root : root + sep)) {
      throw new ProcessBrokerError(
        "EXECUTABLE_UNSAFE",
        "The resolved tool image lies outside its containment root.",
        { toolId: descriptor.toolId },
      );
    }
  }

  let digest: ToolDigest | null = null;
  if (descriptor.expectedDigest !== null) {
    const actual = await digestFile(descriptor.executablePath, descriptor.expectedDigest.algorithm, {
      toolId: descriptor.toolId,
    });
    if (actual !== descriptor.expectedDigest.hex) {
      throw new ProcessBrokerError(
        "EXECUTABLE_DIGEST_MISMATCH",
        "The tool image digest does not match the trusted descriptor.",
        { toolId: descriptor.toolId, algorithm: descriptor.expectedDigest.algorithm },
      );
    }
    digest = descriptor.expectedDigest;
  }

  return Object.freeze({
    toolId: descriptor.toolId,
    executablePath: descriptor.executablePath,
    digest,
    immutableReference: descriptor.immutableReference,
  });
}

async function digestFile(
  path: string,
  algorithm: ToolDigestAlgorithm,
  context: { readonly toolId: string },
): Promise<string> {
  const hash = createHash(NODE_DIGEST_NAMES[algorithm]);
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    throw new ProcessBrokerError("EXECUTABLE_UNAVAILABLE", "The tool image could not be read.", {
      toolId: context.toolId,
      cause: errorCategory(error),
    });
  }
  try {
    const buffer = new Uint8Array(65_536);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
  } catch (error) {
    throw new ProcessBrokerError("EXECUTABLE_UNAVAILABLE", "The tool image could not be read.", {
      toolId: context.toolId,
      cause: errorCategory(error),
    });
  } finally {
    try {
      await handle.close();
    } catch {
      // A close failure cannot change the digest result or replace the read error.
    }
  }
  return hash.digest("hex");
}

/**
 * Validates an argument array against the tool's policy and returns the exact
 * argv the operating system will receive.
 */
export function applyArgumentPolicy(
  descriptor: TrustedToolDescriptor,
  args: readonly string[],
): readonly string[] {
  const policy = descriptor.argumentPolicy;
  const pinned = policy.pinnedLeadingArguments ?? [];
  const combined = [...pinned, ...args];
  if (combined.length > policy.maxArguments) {
    throw invalidRequest("The command exceeds the tool argument count limit.", {
      toolId: descriptor.toolId,
      argumentCount: combined.length,
      maxArguments: policy.maxArguments,
    });
  }
  let total = 0;
  for (const [index, argument] of combined.entries()) {
    if (typeof argument !== "string") {
      throw invalidRequest("Arguments must be strings.", { index });
    }
    if (argument.includes("\u0000")) {
      throw invalidRequest("An argument contains a NUL character.", { index });
    }
    const bytes = Buffer.byteLength(argument, "utf8");
    if (bytes > policy.maxArgumentBytes) {
      throw invalidRequest("An argument exceeds the per-argument byte limit.", {
        index,
        byteLength: bytes,
        maxArgumentBytes: policy.maxArgumentBytes,
      });
    }
    total += bytes;
    if (total > MAX_TOTAL_ARGUMENT_BYTES) {
      throw invalidRequest("The command exceeds the aggregate argument byte limit.", {
        maxTotalBytes: MAX_TOTAL_ARGUMENT_BYTES,
      });
    }
    if (policy.denyOptionArguments && index >= pinned.length && argument.startsWith("-")) {
      throw invalidRequest("This tool does not accept option arguments from callers.", {
        toolId: descriptor.toolId,
        index,
      });
    }
  }
  return Object.freeze([...combined]);
}
