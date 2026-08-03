/**
 * The packer: collect, authorize, plan, seal.
 *
 * Order matters and is fixed:
 *
 * 1. **Collect** — gather candidates through authorized read ports, verifying
 *    source digests and recording every gathering failure as an omission.
 * 2. **Authorize** — one decision per candidate, before any body reaches the
 *    plan. An unavailable authorizer aborts the whole assembly rather than
 *    producing a pack that looks complete.
 * 3. **Plan** — deterministic, pure selection under the budget.
 * 4. **Seal** — fingerprint the result.
 *
 * The pack is returned, never written. Persisting assembled context is a
 * disclosure decision for the caller and an explicitly authorized sink.
 */

import {
  authorizeCandidates,
  type ContextAuthorizationRequest,
  type ContextAuthorizer,
} from "./authorization.js";
import {
  collectContextCandidates,
  type ContextSources,
} from "./collect.js";
import {
  contextFailure,
  failed,
  ok,
  type ContextResult,
} from "./errors.js";
import { conservativeUnitEstimator, validateEstimator, type ContextUnitEstimator } from "./estimator.js";
import { renderContextPack } from "./framing.js";
import {
  contextRequestFingerprint,
  DEFAULT_CONTEXT_CONFIGURATION,
  parseContextRequest,
  CONTEXT_SCHEMA_VERSION,
  CONTEXT_SELECTION_ALGORITHM_VERSION,
  type ContextConfiguration,
  type ContextRequest,
} from "./model.js";
import { sealContextPack, type ContextPack } from "./pack.js";
import { assertBudgetSatisfiable, planContextPack, type SelectionPlan } from "./select.js";

export interface ContextClock {
  now(): Date;
}

export interface CancellationSignal {
  readonly aborted: boolean;
}

/**
 * Read through a function rather than inline, so the check is re-evaluated at
 * each await boundary. Inlining lets the compiler narrow the first read and
 * treat every later one as dead, which is exactly wrong for a flag another
 * task sets while this one is suspended.
 */
function isCancelled(signal: CancellationSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

export interface BuildContextPackOptions {
  readonly request: ContextRequest | unknown;
  readonly sources: ContextSources;
  readonly authorizer: ContextAuthorizer;
  readonly clock: ContextClock;
  readonly configuration?: ContextConfiguration;
  readonly estimator?: ContextUnitEstimator;
  readonly signal?: CancellationSignal;
}

export async function buildContextPack(
  options: BuildContextPackOptions,
): Promise<ContextResult<ContextPack>> {
  const configuration = options.configuration ?? DEFAULT_CONTEXT_CONFIGURATION;
  const estimator = options.estimator ?? conservativeUnitEstimator;

  const estimatorFailure = validateEstimator(estimator);
  if (estimatorFailure !== null) {
    return failed<ContextPack>(estimatorFailure);
  }
  const satisfiable = assertBudgetSatisfiable(configuration);
  if (!satisfiable.ok) {
    return failed<ContextPack>(satisfiable.failure);
  }
  if (isCancelled(options.signal)) {
    return failed<ContextPack>(contextFailure("CANCELLED", "Context assembly was cancelled."));
  }

  let request: ContextRequest;
  try {
    request = parseContextRequest(options.request);
  } catch (error) {
    const issueCount =
      error !== null && typeof error === "object" && "issues" in error && Array.isArray(error.issues)
        ? error.issues.length
        : 0;
    return failed<ContextPack>(
      contextFailure("INVALID_REQUEST", "The context request is invalid.", { issueCount }),
    );
  }

  const collected = await collectContextCandidates({
    request,
    sources: options.sources,
    configuration,
    now: options.clock.now(),
  });

  if (isCancelled(options.signal)) {
    return failed<ContextPack>(contextFailure("CANCELLED", "Context assembly was cancelled."));
  }

  const authorizationRequests: readonly ContextAuthorizationRequest[] = Object.freeze(
    collected.candidates.map((candidate) =>
      Object.freeze({
        purpose: request.purpose,
        projectId: request.projectId,
        workspaceId: request.workspaceId,
        sourceKind: candidate.sourceKind,
        identity: candidate.identity,
        classification: candidate.classification,
        disclosure: candidate.disclosure,
        scopeLabel: candidate.scopeLabel,
      }),
    ),
  );
  const authorization = await authorizeCandidates(options.authorizer, authorizationRequests);
  if (authorization.failure !== null) {
    return failed<ContextPack>(authorization.failure);
  }

  if (isCancelled(options.signal)) {
    return failed<ContextPack>(contextFailure("CANCELLED", "Context assembly was cancelled."));
  }

  const planned = planContextPack({
    candidates: collected.candidates,
    configuration,
    estimator,
    deniedIdentities: authorization.deniedIdentities,
    priorOmissions: collected.omissions,
    priorDiagnostics: collected.diagnostics,
  });
  if (!planned.ok) {
    return failed<ContextPack>(planned.failure);
  }

  return ok(
    sealContextPack({
      schemaVersion: CONTEXT_SCHEMA_VERSION,
      selectionAlgorithmVersion: CONTEXT_SELECTION_ALGORITHM_VERSION,
      requestFingerprint: contextRequestFingerprint({
        request,
        configuration,
        estimatorId: estimator.estimatorId,
        policyDecisionFingerprint: authorization.decisionFingerprint,
      }),
      generatedAt: options.clock.now().toISOString(),
      items: planned.value.items,
      omissions: planned.value.omissions,
      omissionsTruncated: planned.value.omissionsTruncated,
      usage: planned.value.usage,
      estimator: Object.freeze({
        estimatorId: estimator.estimatorId,
        exact: false as const,
        bytesPerUnit: estimator.bytesPerUnit,
      }),
      diagnostics: planned.value.diagnostics,
    }),
  );
}

export interface ContextPacker {
  readonly configuration: ContextConfiguration;
  readonly estimator: ContextUnitEstimator;
  plan(input: {
    readonly candidates: Parameters<typeof planContextPack>[0]["candidates"];
    readonly deniedIdentities?: readonly string[];
  }): ContextResult<SelectionPlan>;
  build(input: {
    readonly request: ContextRequest | unknown;
    readonly sources: ContextSources;
    readonly signal?: CancellationSignal;
  }): Promise<ContextResult<ContextPack>>;
  render(pack: ContextPack): string;
  close(): void;
}

export function createContextPacker(options: {
  readonly authorizer: ContextAuthorizer;
  readonly clock: ContextClock;
  readonly configuration?: ContextConfiguration;
  readonly estimator?: ContextUnitEstimator;
}): ContextPacker {
  const configuration = options.configuration ?? DEFAULT_CONTEXT_CONFIGURATION;
  const estimator = options.estimator ?? conservativeUnitEstimator;
  let closed = false;

  const packer: ContextPacker = {
    configuration,
    estimator,
    plan: (input) =>
      closed
        ? failed<SelectionPlan>(contextFailure("PACKER_CLOSED", "The context packer is closed."))
        : planContextPack({
            candidates: input.candidates,
            configuration,
            estimator,
            ...(input.deniedIdentities === undefined
              ? {}
              : { deniedIdentities: input.deniedIdentities }),
          }),
    build: async (input) =>
      closed
        ? failed<ContextPack>(contextFailure("PACKER_CLOSED", "The context packer is closed."))
        : buildContextPack({
            request: input.request,
            sources: input.sources,
            authorizer: options.authorizer,
            clock: options.clock,
            configuration,
            estimator,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          }),
    render: (pack) => renderContextPack(pack),
    close: (): void => {
      closed = true;
    },
  };
  return Object.freeze(packer);
}
