export {
  CONTEXT_DIAGNOSTIC_CODES,
  CONTEXT_ERROR_CODES,
  ContextError,
  OMISSION_REASONS,
  causeCategory,
  contextFailure,
  diagnostic,
  failed,
  ok,
  type ContextDiagnostic,
  type ContextDiagnosticCode,
  type ContextErrorCode,
  type ContextFailure,
  type ContextResult,
  type FailureDetailValue,
  type FailureDetails,
  type OmissionReason,
} from "./errors.js";

export {
  CONSERVATIVE_BYTES_PER_UNIT,
  conservativeUnitEstimator,
  safeUtf8Cut,
  truncateToBytes,
  utf8ByteLength,
  validateEstimator,
  type ContextUnitEstimator,
} from "./estimator.js";

export {
  CONTEXT_CATEGORIES,
  CONTEXT_PURPOSES,
  CONTEXT_SCHEMA_VERSION,
  CONTEXT_SELECTION_ALGORITHM_VERSION,
  CONTEXT_SOURCE_KINDS,
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_CONTEXT_CONFIGURATION,
  MAX_CANDIDATE_BODY_BYTES,
  candidateDigest,
  categoryPriority,
  contextRequestFingerprint,
  parseCandidateList,
  parseContextBudget,
  parseContextCandidate,
  parseContextConfiguration,
  parseContextRequest,
  withContextOverrides,
  type CandidateProvenance,
  type CategoryAllocation,
  type ContextBudget,
  type ContextCandidate,
  type ContextCategory,
  type ContextConfiguration,
  type ContextPurpose,
  type ContextRequest,
  type ContextSourceKind,
  type ExtractionRange,
} from "./model.js";

export {
  CONTEXT_FRAME_VERSION,
  FRAME_BODY,
  FRAME_END,
  FRAME_HEADER,
  FRAME_ITEM,
  countFrameSentinels,
  renderContextPack,
  sanitizeContextText,
  type RenderableItem,
  type RenderablePack,
  type SanitizedText,
} from "./framing.js";

export {
  CONTEXT_AUTHORIZATION_OUTCOMES,
  authorizeCandidates,
  createProjectContextAuthorizer,
  denyAllContextAuthorizer,
  parseContextAuthorizationDecision,
  type AuthorizationOutcomeSet,
  type ContextAuthorizationDecision,
  type ContextAuthorizationOutcome,
  type ContextAuthorizationRequest,
  type ContextAuthorizer,
} from "./authorization.js";

export {
  collectContextCandidates,
  type CollectionResult,
  type ContextArtifactPort,
  type ContextSources,
  type RepositorySource,
} from "./collect.js";

export {
  contextPackFingerprint,
  sealContextPack,
  summarizeContextPack,
  type ContextOmission,
  type ContextPack,
  type ContextPackAudit,
  type ContextPackItem,
  type ContextUsage,
  type ScoreComponent,
} from "./pack.js";

export {
  assertBudgetSatisfiable,
  planContextPack,
  type PlanContextPackInput,
  type SelectionPlan,
} from "./select.js";

export {
  buildContextPack,
  createContextPacker,
  type BuildContextPackOptions,
  type CancellationSignal,
  type ContextClock,
  type ContextPacker,
} from "./packer.js";
