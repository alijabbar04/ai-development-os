/**
 * Deterministic selection and packing.
 *
 * `planContextPack` is a pure function. Given the same candidates, budget,
 * configuration, and estimator it returns a byte-identical plan — regardless of
 * the order the candidates arrived in, the locale, the wall clock, or any
 * hash-map iteration order. Everything that could vary is normalized first:
 *
 * - Candidates are sorted by (category priority, score descending, identity,
 *   digest). Every tie has a total order.
 * - Deduplication is by body digest, and the winner is the first in that
 *   sorted order, not the first in the input.
 * - Category reservations are filled in a first pass before anything competes
 *   for the general pool, so a high-scoring repository excerpt cannot starve
 *   the constraint category.
 * - Byte accounting is exact UTF-8 bytes; truncation cuts on a character
 *   boundary so a multi-byte character is never split.
 * - Omission reasons name the binding constraint, most specific first.
 */

import { compareDataClassification } from "@ai-dev-os/domain";
import {
  contextFailure,
  diagnostic,
  failed,
  ok,
  type ContextDiagnostic,
  type ContextResult,
  type OmissionReason,
} from "./errors.js";
import { truncateToBytes, utf8ByteLength, validateEstimator, type ContextUnitEstimator } from "./estimator.js";
import { countFrameSentinels, sanitizeContextText } from "./framing.js";
import {
  categoryPriority,
  CONTEXT_CATEGORIES,
  CONTEXT_SOURCE_KINDS,
  type ContextCandidate,
  type ContextCategory,
  type ContextConfiguration,
  type ContextSourceKind,
} from "./model.js";
import type { ContextOmission, ContextPackItem, ContextUsage, ScoreComponent } from "./pack.js";

export interface SelectionPlan {
  readonly items: readonly ContextPackItem[];
  readonly omissions: readonly ContextOmission[];
  readonly omissionsTruncated: boolean;
  readonly usage: ContextUsage;
  readonly diagnostics: readonly ContextDiagnostic[];
  readonly diagnosticsTruncated: boolean;
}

export interface PlanContextPackInput {
  readonly candidates: readonly ContextCandidate[];
  readonly configuration: ContextConfiguration;
  readonly estimator: ContextUnitEstimator;
  /**
   * Identities the authorizer refused. They are omitted with `policy-denied`
   * and their bodies never reach the plan — the denial is applied before any
   * disclosure, not after.
   */
  readonly deniedIdentities?: readonly string[];
  /** Omissions decided during collection (unresolved artifacts, and so on). */
  readonly priorOmissions?: readonly ContextOmission[];
  readonly priorDiagnostics?: readonly ContextDiagnostic[];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareCandidates(a: ContextCandidate, b: ContextCandidate): number {
  return (
    categoryPriority(a.category) - categoryPriority(b.category) ||
    b.baseScore - a.baseScore ||
    compareText(a.identity, b.identity) ||
    compareText(a.digest, b.digest)
  );
}

function zeroByCategory(): Record<ContextCategory, number> {
  const result = {} as Record<ContextCategory, number>;
  for (const category of CONTEXT_CATEGORIES) {
    result[category] = 0;
  }
  return result;
}

function zeroBySourceKind(): Record<ContextSourceKind, number> {
  const result = {} as Record<ContextSourceKind, number>;
  for (const kind of CONTEXT_SOURCE_KINDS) {
    result[kind] = 0;
  }
  return result;
}

interface PreparedCandidate {
  readonly candidate: ContextCandidate;
  readonly body: string;
  readonly byteLength: number;
  readonly frameSentinelOccurrences: number;
}

interface BudgetState {
  bytes: number;
  units: number;
  items: number;
  readonly bytesByCategory: Record<ContextCategory, number>;
  readonly bytesBySourceKind: Record<ContextSourceKind, number>;
  readonly itemsByCategory: Record<ContextCategory, number>;
}

type AdmissionOutcome =
  | { readonly kind: "admitted"; readonly item: ContextPackItem }
  | { readonly kind: "deferred" }
  | { readonly kind: "omitted"; readonly reason: OmissionReason };

export function planContextPack(input: PlanContextPackInput): ContextResult<SelectionPlan> {
  const estimatorFailure = validateEstimator(input.estimator);
  if (estimatorFailure !== null) {
    return failed<SelectionPlan>(estimatorFailure);
  }
  const { configuration } = input;
  const budget = configuration.budget;
  const denied = new Set(input.deniedIdentities ?? []);
  const omissions: ContextOmission[] = [...(input.priorOmissions ?? [])];
  const diagnostics: ContextDiagnostic[] = [...(input.priorDiagnostics ?? [])];

  const omit = (candidate: ContextCandidate, reason: OmissionReason, requestedBytes: number): void => {
    omissions.push(
      Object.freeze({
        identity: candidate.identity,
        sourceKind: candidate.sourceKind,
        category: candidate.category,
        digest: candidate.digest,
        reason,
        requestedBytes,
      }),
    );
  };

  // Phase one: eligibility. Everything decided here is independent of budget,
  // so a denial or a classification ceiling can never be "used up" by ordering.
  const prepared: PreparedCandidate[] = [];
  const seenDigests = new Set<string>();
  for (const candidate of [...input.candidates].sort(compareCandidates)) {
    if (denied.has(candidate.identity)) {
      omit(candidate, "policy-denied", 0);
      continue;
    }
    if (compareDataClassification(candidate.classification, configuration.maxClassification) > 0) {
      omit(candidate, "classification-ceiling", 0);
      continue;
    }
    const sanitized = sanitizeContextText(candidate.body);
    if (sanitized.removed > 0) {
      diagnostics.push(
        diagnostic(
          "control-characters-removed",
          candidate.identity,
          `${sanitized.removed} characters removed`,
        ),
      );
    }
    if (sanitized.text.length === 0) {
      omit(candidate, "empty-after-sanitization", 0);
      continue;
    }
    if (seenDigests.has(candidate.digest)) {
      omit(candidate, "duplicate-digest", utf8ByteLength(sanitized.text));
      continue;
    }
    seenDigests.add(candidate.digest);
    const sentinels = countFrameSentinels(sanitized.text);
    if (sentinels > 0) {
      diagnostics.push(
        diagnostic(
          "frame-sentinel-in-body",
          candidate.identity,
          `${sentinels} frame markers present; length prefix governs`,
        ),
      );
    }
    prepared.push(
      Object.freeze({
        candidate,
        body: sanitized.text,
        byteLength: utf8ByteLength(sanitized.text),
        frameSentinelOccurrences: sentinels,
      }),
    );
  }

  const state: BudgetState = {
    bytes: 0,
    units: 0,
    items: 0,
    bytesByCategory: zeroByCategory(),
    bytesBySourceKind: zeroBySourceKind(),
    itemsByCategory: zeroByCategory(),
  };
  const accepted: ContextPackItem[] = [];

  function admit(entry: PreparedCandidate, phase: "reserved" | "general"): AdmissionOutcome {
    const candidate = entry.candidate;
    const allocation = budget.categories[candidate.category];

    if (state.items >= budget.maxItems) {
      return { kind: "omitted", reason: "budget-items-exhausted" };
    }
    if ((state.itemsByCategory[candidate.category] ?? 0) >= allocation.maxItems) {
      return { kind: "omitted", reason: "category-allocation-full" };
    }

    const categoryRemaining = allocation.maxBytes - (state.bytesByCategory[candidate.category] ?? 0);
    const sourceRemaining =
      budget.maxBytesPerSourceKind - (state.bytesBySourceKind[candidate.sourceKind] ?? 0);
    const globalRemaining = budget.maxTotalBytes - state.bytes;
    const reservationRemaining =
      allocation.reservedBytes - (state.bytesByCategory[candidate.category] ?? 0);

    // In the reservation pass an item is admitted only if it fits whole inside
    // what is still reserved for its category; otherwise it waits for the
    // general pool rather than being truncated to fit a reservation.
    if (phase === "reserved") {
      if (reservationRemaining <= 0 || entry.byteLength > reservationRemaining) {
        return { kind: "deferred" };
      }
    }

    const limits: readonly (readonly [number, OmissionReason])[] = [
      [budget.maxItemBytes, "item-too-large"],
      [categoryRemaining, "category-allocation-full"],
      [sourceRemaining, "per-source-cap"],
      [globalRemaining, "budget-bytes-exhausted"],
    ];
    let allowedBytes = entry.byteLength;
    let bindingReason: OmissionReason = "budget-bytes-exhausted";
    for (const [limit, reason] of limits) {
      if (limit < allowedBytes) {
        allowedBytes = limit;
        bindingReason = reason;
      }
    }

    let body = entry.body;
    let byteLength = entry.byteLength;
    let truncated = false;
    if (allowedBytes < entry.byteLength) {
      if (!budget.allowTruncation || allowedBytes < budget.minItemBytes) {
        return { kind: "omitted", reason: bindingReason };
      }
      const cut = truncateToBytes(entry.body, allowedBytes);
      body = cut.text;
      byteLength = cut.byteLength;
      truncated = true;
    }

    // Units are checked after bytes because the estimator is a black box: the
    // only reliable way to know what a body costs is to ask it.
    let units = input.estimator.estimate(body);
    if (state.units + units > budget.maxTotalUnits) {
      const unitsRemaining = budget.maxTotalUnits - state.units;
      const byUnits = unitsRemaining * input.estimator.bytesPerUnit;
      if (!budget.allowTruncation || byUnits < budget.minItemBytes) {
        return { kind: "omitted", reason: "budget-units-exhausted" };
      }
      const cut = truncateToBytes(body, Math.min(byUnits, byteLength));
      body = cut.text;
      byteLength = cut.byteLength;
      truncated = true;
      units = input.estimator.estimate(body);
      if (state.units + units > budget.maxTotalUnits || byteLength < budget.minItemBytes) {
        return { kind: "omitted", reason: "budget-units-exhausted" };
      }
    }

    if (truncated) {
      diagnostics.push(
        diagnostic(
          "candidate-truncated",
          candidate.identity,
          `${entry.byteLength} bytes reduced to ${byteLength}`,
        ),
      );
    }

    const scoreComponents: readonly ScoreComponent[] = Object.freeze([
      Object.freeze({ name: "base-relevance", value: candidate.baseScore }),
      Object.freeze({ name: "category-priority", value: categoryPriority(candidate.category) }),
    ]);

    state.bytes += byteLength;
    state.units += units;
    state.items += 1;
    state.bytesByCategory[candidate.category] =
      (state.bytesByCategory[candidate.category] ?? 0) + byteLength;
    state.bytesBySourceKind[candidate.sourceKind] =
      (state.bytesBySourceKind[candidate.sourceKind] ?? 0) + byteLength;
    state.itemsByCategory[candidate.category] =
      (state.itemsByCategory[candidate.category] ?? 0) + 1;

    return {
      kind: "admitted",
      item: Object.freeze({
        ordinal: accepted.length + 1,
        sourceKind: candidate.sourceKind,
        category: candidate.category,
        identity: candidate.identity,
        digest: candidate.digest,
        classification: candidate.classification,
        disclosure: candidate.disclosure,
        scopeLabel: candidate.scopeLabel,
        provenance: candidate.provenance,
        observedAt: candidate.observedAt,
        score: candidate.baseScore,
        scoreComponents,
        byteContribution: byteLength,
        unitContribution: units,
        truncated,
        extractionRange: candidate.extractionRange,
        trust: "untrusted" as const,
        frameSentinelOccurrences: entry.frameSentinelOccurrences,
        body,
      }),
    };
  }

  const remaining: PreparedCandidate[] = [];
  for (const entry of prepared) {
    const outcome = admit(entry, "reserved");
    if (outcome.kind === "admitted") {
      accepted.push(outcome.item);
      continue;
    }
    // A candidate refused during the reservation pass is not lost: only a
    // refusal in the general pass is final.
    remaining.push(entry);
  }
  for (const entry of remaining) {
    const outcome = admit(entry, "general");
    if (outcome.kind === "admitted") {
      accepted.push(outcome.item);
      continue;
    }
    if (outcome.kind === "omitted") {
      omit(entry.candidate, outcome.reason, entry.byteLength);
    }
  }

  // Ordinals follow the final pack order, which is the canonical sort rather
  // than the order in which the two passes happened to admit items.
  const orderedItems = [...accepted]
    .sort(
      (a, b) =>
        categoryPriority(a.category) - categoryPriority(b.category) ||
        b.score - a.score ||
        compareText(a.identity, b.identity) ||
        compareText(a.digest, b.digest),
    )
    .map((item, index) => Object.freeze({ ...item, ordinal: index + 1 }));

  const sortedOmissions = [...omissions].sort(
    (a, b) =>
      compareText(a.reason, b.reason) ||
      compareText(a.identity, b.identity) ||
      compareText(a.digest, b.digest),
  );
  const omissionsTruncated = sortedOmissions.length > budget.maxOmissions;
  if (omissionsTruncated) {
    diagnostics.push(
      diagnostic(
        "omissions-truncated",
        null,
        `${sortedOmissions.length} omissions capped at ${budget.maxOmissions}`,
      ),
    );
  }
  diagnostics.push(
    diagnostic(
      "estimator-conservative",
      null,
      `${input.estimator.estimatorId} is an upper bound, not a model token count`,
    ),
  );

  const sortedDiagnostics = [...diagnostics].sort(
    (a, b) =>
      compareText(a.code, b.code) ||
      compareText(a.identity ?? "", b.identity ?? "") ||
      compareText(a.detail, b.detail),
  );
  const diagnosticsTruncated = sortedDiagnostics.length > budget.maxDiagnostics;

  return ok(
    Object.freeze({
      items: Object.freeze(orderedItems),
      omissions: Object.freeze(sortedOmissions.slice(0, budget.maxOmissions)),
      omissionsTruncated,
      usage: Object.freeze({
        bytes: state.bytes,
        units: state.units,
        itemCount: orderedItems.length,
        bytesByCategory: Object.freeze({ ...state.bytesByCategory }),
        bytesBySourceKind: Object.freeze({ ...state.bytesBySourceKind }),
      }),
      diagnostics: Object.freeze(sortedDiagnostics.slice(0, budget.maxDiagnostics)),
      diagnosticsTruncated,
    }),
  );
}

/** Rejects a plan request whose budget cannot admit even one minimal item. */
export function assertBudgetSatisfiable(
  configuration: ContextConfiguration,
): ContextResult<true> {
  const budget = configuration.budget;
  if (budget.minItemBytes > budget.maxTotalBytes) {
    return failed<true>(
      contextFailure("BUDGET_UNSATISFIABLE", "The minimum item size exceeds the total byte budget."),
    );
  }
  if (budget.minItemBytes > budget.maxTotalUnits * 64) {
    return failed<true>(
      contextFailure("BUDGET_UNSATISFIABLE", "The unit budget cannot admit a minimal item."),
    );
  }
  return ok(true as const);
}
