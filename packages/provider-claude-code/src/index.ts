export {
  CLAUDE_DETAIL_CODES,
  RETRY_TEXT_TABLE_VERSION,
  classifyRetryCategory,
  errorForDetailCode,
  type ClaudeDetailCode,
} from "./errors.js";

export {
  CLAUDE_ADAPTER_SCHEMA_VERSION,
  CLAUDE_AUTHENTICATION_MODES,
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_EXTENSION_NAMESPACE,
  CLAUDE_PROVIDER_ID,
  CLAUDE_SESSION_PERSISTENCE_POLICIES,
  CLAUDE_TOOL_ARCHITECTURES,
  CLAUDE_TOOL_PLATFORMS,
  DEFAULT_MINIMUM_CLI_VERSION,
  DEFAULT_VALIDATED_CLI_VERSION,
  MAX_BUDGET_MICROS,
  MAX_PERMITTED_MODELS,
  MAX_TURN_CAP,
  WINDOWS_SHELL_SHIM_PATTERN,
  claudeConfigurationFingerprint,
  compareCliVersions,
  createClaudeAdapterConfiguration,
  dollarsToMicros,
  isDistributableAuthentication,
  microsToBudgetArgument,
  parseClaudeAdapterConfiguration,
  parseCliVersion,
  resolveClaudeConfiguration,
  type ClaudeAdapterConfiguration,
  type ClaudeAdapterConfigurationInput,
  type ClaudeAuthenticationMode,
  type ClaudeEffortLevel,
  type ClaudeExecutableDescriptor,
  type ClaudeSessionPersistencePolicy,
} from "./config.js";

export {
  CLAUDE_COMPATIBILITY_TIERS,
  COMPATIBILITY_MATRIX_VERSION,
  REQUIRED_CAPABILITIES,
  UNSUPPORTED_PROFILE,
  resolveCompatibilityProfile,
  type ClaudeCliCapabilities,
  type ClaudeCompatibilityProfile,
  type ClaudeCompatibilityTier,
} from "./compatibility.js";

export {
  CLAUDE_AUTHENTICATION_OBSERVATIONS,
  CLAUDE_PROBE_STATUSES,
  inspectExecutable,
  parseVersionBanner,
  probeClaudeCli,
  type ClaudeAuthenticationObservation,
  type ClaudeProbeResult,
  type ClaudeProbeStatus,
} from "./discovery.js";

export {
  CLAUDE_ARTIFACT_CATEGORIES,
  CLAUDE_EXECUTION_KINDS,
  claudeSchedulerFromManual,
  denyingArtifactSink,
  permissiveDevelopmentPolicy,
  systemClaudeClock,
  systemClaudeScheduler,
  type ClaudeArtifactCategory,
  type ClaudeArtifactSink,
  type ClaudeArtifactWrite,
  type ClaudeClock,
  type ClaudeCommitInput,
  type ClaudeDelayHandle,
  type ClaudeExecutionKind,
  type ClaudeExecutionPort,
  type ClaudeExecutionRequest,
  type ClaudeScheduler,
  type ClaudeSessionPolicyDecision,
  type ClaudeSessionPolicyInput,
  type ClaudeSessionPolicyPort,
  type ClaudeTestReport,
  type ClaudeUuidGenerator,
  type ClaudeWorkspaceHandle,
  type ClaudeWorkspacePort,
} from "./ports.js";

export { createNdjsonDecoder, type NdjsonDecoder, type NdjsonLimits, type NdjsonOutcome } from "./ndjson.js";

export {
  MAX_MODEL_USAGE_ENTRIES,
  MAX_PERMISSION_DENIALS,
  MAX_SESSION_ID_LENGTH,
  MAX_TOOL_NAME_LENGTH,
  RESULT_SUBTYPES,
  RESULT_SUBTYPE_TABLE_VERSION,
  parseWireLine,
  type ClaudePermissionDenial,
  type ClaudePerModelUsage,
  type ClaudeUsageCounts,
  type ClaudeWireOutcome,
  type ClaudeWireRecord,
} from "./wire.js";

export {
  ALWAYS_DENIED_TOOLS,
  CLAUDE_PERMISSION_MODE,
  CLAUDE_TOOL_NAMES,
  MCP_DENY_RULE,
  buildInvocation,
  encodeInstructions,
  planTools,
  type ClaudeInvocation,
  type ClaudeInvocationInput,
  type ClaudeToolPlan,
  type ToolPlanOutcome,
} from "./invocation.js";

export {
  RESUME_TOKEN_VERSION,
  SESSION_ID_PATTERN,
  isValidSessionId,
  mintResumeToken,
  parseSessionMetadata,
  resumeFailureError,
  sessionPersistenceAllowed,
  verifyResumeToken,
  type ClaudeSessionBinding,
  type ClaudeSessionMetadata,
  type ResumeVerification,
  type ResumeVerificationInput,
} from "./session.js";

export {
  CLAUDE_COST_SEMANTICS,
  ZERO_CLAUDE_USAGE,
  costSemanticsFor,
  mapCost,
  reconcileUsage,
  sumModelUsage,
  toProviderUsage,
  usageTotal,
  type ClaudeCostMapping,
  type ClaudeCostSemantics,
  type UsageReconciliation,
} from "./usage.js";

export {
  CLAUDE_CAPACITY_CONFIDENCE,
  CLAUDE_CAPACITY_SOURCES,
  CLAUDE_CAPACITY_STATUSES,
  MAX_STATUS_SNAPSHOT_BYTES,
  UNKNOWN_CAPACITY,
  UNSUPPORTED_CAPACITY,
  ageCapacitySnapshot,
  ingestStatusSnapshot,
  type ClaudeCapacityConfidence,
  type ClaudeCapacitySnapshot,
  type ClaudeCapacitySource,
  type ClaudeCapacityStatus,
  type ClaudeCapacityWindow,
} from "./capacity.js";

export {
  CLAUDE_RECONCILIATION_OUTCOMES,
  notifyClaudeObserver,
  type ClaudeObservation,
  type ClaudeObserver,
  type ClaudeReconciliationOutcome,
} from "./observability.js";

export {
  compareClaimedChanges,
  reconcileWorkspace,
  toNeutralChangeKind,
  type ReconciliationInput,
  type ReconciliationResult,
  type ReconciliationViolation,
} from "./reconciliation.js";

export {
  createClaudeWorkspaceHandle,
  parseTestReport,
  readBoundedWorkspaceFile,
  type ClaudeWorkspaceHandleOptions,
} from "./workspace-handle.js";

export {
  classifyBrokerFailure,
  createBrokerExecutionPort,
  type BrokerExecutionOptions,
} from "./execution.js";

export { brokerFailure, failureForDetail } from "./failure-mapping.js";

export {
  createClaudeCodeProvider,
  modelMatches,
  type ClaudeBackendIdentity,
  type ClaudeCodeProvider,
  type CreateClaudeCodeProviderOptions,
} from "./provider.js";
