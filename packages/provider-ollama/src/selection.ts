import type { OllamaAdapterConfiguration, OllamaModelRole, OllamaRolePreference } from "./config.js";
import { ollamaModelNamesEqual, type OllamaCatalogEntry, type OllamaModelCatalog } from "./catalog.js";

/**
 * Capability-aware, deterministic, explainable LOCAL model selection.
 *
 * Selection never matches on model-name substrings: preferences rank exact
 * configured names and reported model families; every other filter is a
 * validated capability, context, size, quantization, or digest-pin check.
 * Stage 7 does not route between local and cloud providers — when nothing
 * local qualifies the result is a structured "no-eligible-local-model" for
 * the later router.
 */

export interface OllamaSelectionRequirements {
  readonly minContextLength: number | null;
  readonly requireReasoning: boolean;
  readonly requireStructuredOutput: boolean;
  readonly requireToolCalling: boolean;
  readonly requireVision: boolean;
}

export interface OllamaSelectionQuery {
  readonly role: OllamaModelRole | null;
  readonly requirements?: Partial<OllamaSelectionRequirements>;
}

export interface OllamaRejectedCandidate {
  readonly model: string;
  /** Stable sorted reason codes. */
  readonly reasonCodes: readonly string[];
}

export interface OllamaCapabilityEvidence {
  readonly chat: boolean;
  readonly structuredOutput: boolean;
  readonly toolCalling: boolean;
  readonly reasoning: boolean;
  readonly vision: boolean;
  readonly contextLength: number | null;
  readonly provenance: Readonly<Record<string, string>>;
}

export type OllamaSelectionResult =
  | {
      readonly status: "selected";
      readonly model: string;
      readonly digest: string | null;
      readonly matchedRole: OllamaModelRole | null;
      readonly matchedBy: "model-preference" | "family-preference" | "fallback";
      readonly preferenceRank: number | null;
      readonly fallbackUsed: boolean;
      readonly capabilityEvidence: OllamaCapabilityEvidence;
      readonly rejectedCandidates: readonly OllamaRejectedCandidate[];
      readonly catalogFingerprint: string;
    }
  | {
      readonly status: "no-eligible-local-model";
      readonly matchedRole: OllamaModelRole | null;
      readonly rejectedCandidates: readonly OllamaRejectedCandidate[];
      readonly catalogFingerprint: string;
    };

function effectiveRequirements(
  preference: OllamaRolePreference | null,
  overrides: Partial<OllamaSelectionRequirements> | undefined,
): OllamaSelectionRequirements {
  return Object.freeze({
    minContextLength:
      overrides?.minContextLength ?? preference?.minContextLength ?? null,
    requireReasoning: overrides?.requireReasoning ?? preference?.requireReasoning ?? false,
    requireStructuredOutput:
      overrides?.requireStructuredOutput ?? preference?.requireStructuredOutput ?? false,
    requireToolCalling: overrides?.requireToolCalling ?? preference?.requireToolCalling ?? false,
    requireVision: overrides?.requireVision ?? preference?.requireVision ?? false,
  });
}

function candidateRejections(
  entry: OllamaCatalogEntry,
  requirements: OllamaSelectionRequirements,
  preference: OllamaRolePreference | null,
): readonly string[] {
  const reasons: string[] = [];
  for (const reason of entry.ineligibilityReasons) {
    reasons.push(`ineligible:${reason}`);
  }
  if (requirements.requireToolCalling && !entry.capabilities.toolCalling) {
    reasons.push("missing-tool-calling");
  }
  if (requirements.requireStructuredOutput && !entry.capabilities.structuredOutput) {
    reasons.push("missing-structured-output");
  }
  if (requirements.requireReasoning && !entry.capabilities.reasoning) {
    reasons.push("missing-reasoning");
  }
  if (requirements.requireVision && !entry.capabilities.vision) {
    reasons.push("missing-vision");
  }
  if (
    requirements.minContextLength !== null &&
    (entry.contextLength === null || entry.contextLength < requirements.minContextLength)
  ) {
    reasons.push("context-too-small");
  }
  if (preference !== null) {
    if (
      preference.maxModelSizeBytes !== null &&
      (entry.sizeBytes === null || entry.sizeBytes > preference.maxModelSizeBytes)
    ) {
      reasons.push("model-too-large");
    }
    if (
      preference.allowedQuantizations !== null &&
      (entry.quantizationLevel === null ||
        !preference.allowedQuantizations.includes(entry.quantizationLevel))
    ) {
      reasons.push("quantization-not-allowed");
    }
    if (preference.requireDigestPin && entry.pin !== "matched") {
      reasons.push("digest-pin-required");
    }
  }
  return Object.freeze(reasons.sort());
}

function entryMatchesFamily(entry: OllamaCatalogEntry, family: string): boolean {
  return entry.family === family || entry.families.includes(family);
}

function evidenceOf(entry: OllamaCatalogEntry): OllamaCapabilityEvidence {
  return Object.freeze({
    chat: entry.capabilities.chat,
    structuredOutput: entry.capabilities.structuredOutput,
    toolCalling: entry.capabilities.toolCalling,
    reasoning: entry.capabilities.reasoning,
    vision: entry.capabilities.vision,
    contextLength: entry.contextLength,
    provenance: entry.capabilities.provenance,
  });
}

export function selectOllamaModel(
  catalog: OllamaModelCatalog,
  configuration: OllamaAdapterConfiguration,
  query: OllamaSelectionQuery,
): OllamaSelectionResult {
  const preference =
    query.role === null
      ? null
      : configuration.rolePreferences.find((candidate) => candidate.role === query.role) ?? null;
  const requirements = effectiveRequirements(preference, query.requirements);

  const rejected: OllamaRejectedCandidate[] = [];
  const passing: OllamaCatalogEntry[] = [];
  for (const entry of catalog.entries) {
    const reasons = candidateRejections(entry, requirements, preference);
    if (reasons.length > 0) {
      rejected.push(Object.freeze({ model: entry.name, reasonCodes: reasons }));
    } else {
      passing.push(entry);
    }
  }

  const finish = (
    selected: OllamaCatalogEntry,
    matchedBy: "model-preference" | "family-preference" | "fallback",
    preferenceRank: number | null,
  ): OllamaSelectionResult => {
    for (const entry of passing) {
      if (entry !== selected) {
        rejected.push(
          Object.freeze({ model: entry.name, reasonCodes: Object.freeze(["not-selected-lower-preference"]) }),
        );
      }
    }
    rejected.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
    return Object.freeze({
      status: "selected",
      model: selected.name,
      digest: selected.digest,
      matchedRole: query.role,
      matchedBy,
      preferenceRank,
      fallbackUsed: matchedBy === "fallback" && query.role !== null,
      capabilityEvidence: evidenceOf(selected),
      rejectedCandidates: Object.freeze([...rejected]),
      catalogFingerprint: catalog.fingerprint,
    });
  };

  if (preference !== null) {
    for (const [rank, preferredModel] of preference.models.entries()) {
      const match = passing.find((entry) => ollamaModelNamesEqual(entry.name, preferredModel));
      if (match !== undefined) {
        return finish(match, "model-preference", rank);
      }
    }
    for (const [rank, family] of preference.families.entries()) {
      // Candidates within one family are ordered deterministically by name.
      const match = passing.find((entry) => entryMatchesFamily(entry, family));
      if (match !== undefined) {
        return finish(match, "family-preference", rank);
      }
    }
  }

  if (passing.length > 0) {
    // Deterministic fallback: catalog entries are already name-sorted.
    return finish(passing[0]!, "fallback", null);
  }

  rejected.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  return Object.freeze({
    status: "no-eligible-local-model",
    matchedRole: query.role,
    rejectedCandidates: Object.freeze([...rejected]),
    catalogFingerprint: catalog.fingerprint,
  });
}
