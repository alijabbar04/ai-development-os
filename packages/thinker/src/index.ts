export {
  THINKER_ERROR_CODES,
  ThinkerError,
  asThinkerError,
  safeCauseCode,
  thinkerFailed,
  thinkerFailure,
  thinkerOk,
  type ThinkerErrorCode,
  type ThinkerFailure,
  type ThinkerFailureDetail,
  type ThinkerFailureDetails,
  type ThinkerResult
} from "./errors.js";

export {
  DEFAULT_THINKER_CONFIGURATION,
  THINKER_FINGERPRINT_ALGORITHM_VERSION,
  THINKER_PLAN_SCHEMA_VERSION,
  THINKER_SCHEMA_VERSION,
  parseThinkerConfiguration,
  type ThinkerConfiguration
} from "./configuration.js";

export {
  THINKER_OUTPUT_JSON_SCHEMA,
  THINKER_PLAN_FINGERPRINT_ALGORITHM_VERSION,
  THINKER_PLAN_VIOLATION_CODES,
  THINKER_PROPOSAL_STATUSES,
  parseThinkerProposal,
  thinkerPlanFingerprint,
  validateThinkerPlan,
  type ProposedThinkerTask,
  type ThinkerEvidenceReference,
  type ThinkerPlanValidation,
  type ThinkerPlanViolation,
  type ThinkerPlanViolationCategory,
  type ThinkerPlanViolationCode,
  type ThinkerProposal,
  type ThinkerProposalStatus
} from "./proposal.js";

export { parseThinkerRequest, type ThinkerRequest } from "./request.js";

export {
  createProviderGatewayThinkerPort,
  resolveThinkerTarget,
  type ResolvedThinkerTarget,
  type ThinkerInferencePort
} from "./target.js";

export {
  createManualThinkerClock,
  createThinker,
  summarizeThinkerResult,
  type ManualThinkerClock,
  type Thinker,
  type ThinkerAssistantSummary,
  type ThinkerAuditRecord,
  type ThinkerEventSummary,
  type ThinkerObserver,
  type ThinkerOutcome,
  type ThinkerProviderReceipt,
  type ThinkerSuccess,
  type ThinkerSummary,
  type ThinkerWarningSummary
} from "./thinker.js";
