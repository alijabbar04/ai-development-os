import { createHash } from "node:crypto";
import { toCanonicalJson } from "@ai-dev-os/domain";
import { httpStatusError } from "./errors.js";
import type { OllamaAdapterConfiguration } from "./config.js";
import {
  normalizeOllamaCapabilities,
  type OllamaNormalizedCapabilities,
} from "./capabilities.js";
import type { OllamaTransport } from "./transport.js";
import {
  parseOllamaPsResponse,
  parseOllamaShowResponse,
  parseOllamaTagsResponse,
  type OllamaWireRunningModel,
} from "./wire.js";

/** Digest-pin status of one installed model. */
export type OllamaDigestPinStatus = "none" | "matched" | "mismatched" | "unverifiable";

export interface OllamaCatalogEntry {
  readonly name: string;
  /** Bare lowercase hex sha256 digest; null when reported malformed. */
  readonly digest: string | null;
  readonly sizeBytes: number | null;
  readonly modifiedAt: string | null;
  readonly format: string | null;
  readonly family: string | null;
  readonly families: readonly string[];
  readonly parameterSize: string | null;
  readonly quantizationLevel: string | null;
  readonly reportedCapabilities: readonly string[];
  readonly capabilities: OllamaNormalizedCapabilities;
  readonly contextLength: number | null;
  readonly running: boolean;
  readonly pin: OllamaDigestPinStatus;
  readonly eligible: boolean;
  /** Stable, sorted machine reason codes; empty when eligible. */
  readonly ineligibilityReasons: readonly string[];
}

export interface OllamaModelCatalog {
  readonly observedAt: string;
  readonly entries: readonly OllamaCatalogEntry[];
  readonly skippedInvalidEntries: number;
  /**
   * Deterministic sha256 fingerprint over the canonical entries with the
   * volatile `running` flag removed: identical installed catalogs (models,
   * digests, capabilities, eligibility) produce byte-identical
   * fingerprints regardless of response ordering or runtime state.
   */
  readonly fingerprint: string;
}

const DOMAIN_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function catalogFingerprint(entries: readonly OllamaCatalogEntry[]): string {
  const stable = entries.map((entry) => {
    const { running: _running, ...rest } = entry;
    return rest;
  });
  return createHash("sha256").update(toCanonicalJson(stable), "utf8").digest("hex");
}

/** Names match exactly, or modulo the implicit ":latest" tag. */
export function ollamaModelNamesEqual(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const strip = (name: string): string =>
    name.endsWith(":latest") ? name.slice(0, -":latest".length) : name;
  return strip(a) === strip(b);
}

export interface OllamaDiscoveryOptions {
  readonly transport: OllamaTransport;
  readonly configuration: OllamaAdapterConfiguration;
  readonly now: () => Date;
}

/**
 * Deterministic native discovery: GET /api/tags for the installed set,
 * POST /api/show per model for capabilities and context length, and
 * GET /api/ps for the running set. Results are ordered by model name so
 * discovery is independent of server response ordering. Large fields
 * (templates, licenses, modelfiles, token tables) are never extracted.
 */
export async function discoverOllamaCatalog(
  options: OllamaDiscoveryOptions,
): Promise<OllamaModelCatalog> {
  const { transport, configuration } = options;
  const timeoutMs = configuration.discoveryTimeoutMs;

  const tagsResponse = await transport.requestJson("tags", null, { timeoutMs });
  if (tagsResponse.status < 200 || tagsResponse.status >= 300 || tagsResponse.value === null) {
    throw httpStatusError({ status: tagsResponse.status, endpoint: "tags", retryAfterMs: tagsResponse.retryAfterMs });
  }
  const tags = parseOllamaTagsResponse(tagsResponse.value);

  // Running models are telemetry: a ps failure degrades to "none running"
  // rather than failing discovery.
  let running: readonly OllamaWireRunningModel[] = [];
  try {
    const psResponse = await transport.requestJson("ps", null, { timeoutMs });
    if (psResponse.status >= 200 && psResponse.status < 300 && psResponse.value !== null) {
      running = parseOllamaPsResponse(psResponse.value).models;
    }
  } catch {
    running = [];
  }
  const runningNames = new Set(running.map((model) => model.name));

  const pinsByModel = new Map(configuration.digestPins.map((pin) => [pin.model, pin.digest]));
  const overridesByModel = new Map(
    configuration.capabilityOverrides.map((override) => [override.model, override]),
  );
  const allowlist = configuration.modelAllowlist;
  const denylist = new Set(configuration.modelDenylist);

  const entries: OllamaCatalogEntry[] = [];
  for (const installed of tags.models) {
    let reportedCapabilities: readonly string[] = [];
    let contextLength: number | null = null;
    let showAvailable = false;
    try {
      const showResponse = await transport.requestJson("show", { model: installed.name }, { timeoutMs });
      if (showResponse.status >= 200 && showResponse.status < 300 && showResponse.value !== null) {
        const show = parseOllamaShowResponse(showResponse.value);
        reportedCapabilities = show.capabilities;
        contextLength = show.contextLength;
        showAvailable = true;
      }
    } catch {
      showAvailable = false;
    }

    const override = overridesByModel.get(installed.name) ?? null;
    const capabilities = normalizeOllamaCapabilities({
      reportedCapabilities,
      contextLength,
      override,
    });

    const pinDigest = pinsByModel.get(installed.name) ?? null;
    let pin: OllamaDigestPinStatus = "none";
    if (pinDigest !== null) {
      pin = installed.digest === null ? "unverifiable" : installed.digest === pinDigest ? "matched" : "mismatched";
    }

    const reasons: string[] = [];
    if (denylist.has(installed.name)) {
      reasons.push("model-denied");
    }
    if (allowlist !== null && !allowlist.includes(installed.name)) {
      reasons.push("not-allowlisted");
    }
    if (installed.digest === null) {
      reasons.push("invalid-digest");
    }
    if (pin === "mismatched") {
      reasons.push("digest-mismatch");
    }
    if (pin === "unverifiable") {
      reasons.push("digest-unverifiable");
    }
    if (!showAvailable) {
      reasons.push("details-unavailable");
    }
    if (!capabilities.chat) {
      reasons.push("no-chat-capability");
    }
    if (!DOMAIN_MODEL_ID_PATTERN.test(installed.name)) {
      reasons.push("name-unsupported");
    }

    entries.push(
      Object.freeze({
        name: installed.name,
        digest: installed.digest,
        sizeBytes: installed.sizeBytes,
        modifiedAt: installed.modifiedAt,
        format: installed.details.format,
        family: installed.details.family,
        families: installed.details.families,
        parameterSize: installed.details.parameterSize,
        quantizationLevel: installed.details.quantizationLevel,
        reportedCapabilities,
        capabilities,
        contextLength: capabilities.contextLength,
        running: runningNames.has(installed.name),
        pin,
        eligible: reasons.length === 0,
        ineligibilityReasons: Object.freeze(reasons.sort()),
      }),
    );
  }

  const frozenEntries = Object.freeze(entries);
  return Object.freeze({
    observedAt: options.now().toISOString(),
    entries: frozenEntries,
    skippedInvalidEntries: tags.skippedInvalidEntries,
    fingerprint: catalogFingerprint(frozenEntries),
  });
}

/** Finds a catalog entry by requested model id (modulo ":latest"). */
export function findCatalogEntry(
  catalog: OllamaModelCatalog,
  modelId: string,
): OllamaCatalogEntry | null {
  const exact = catalog.entries.find((entry) => entry.name === modelId);
  if (exact !== undefined) {
    return exact;
  }
  return catalog.entries.find((entry) => ollamaModelNamesEqual(entry.name, modelId)) ?? null;
}
