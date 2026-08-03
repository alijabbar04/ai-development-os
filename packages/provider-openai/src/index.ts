export {
  OPENAI_ENDPOINT_PROFILES,
  OPENAI_ENDPOINT_PROFILE_NAMES,
  DEFAULT_OPENAI_ENDPOINT_PROFILE,
  OPENAI_ROUTES,
  parseOpenAiEndpoint,
  isOpenAiEndpoint,
  parseOpenAiResponseId,
  buildOpenAiUrl,
  type OpenAiEndpoint,
  type OpenAiEndpointProfileName,
  type OpenAiRouteName,
  type RouteQuery,
} from "./endpoint.js";

export {
  EMPTY_UPSTREAM_ERROR,
  httpStatusError,
  invalidConfigurationError,
  malformedResponseError,
  operationMayStillRunError,
  policyDeniedError,
  protocolViolationError,
  providerClosedError,
  redirectRejectedError,
  responseFailureError,
  summarizeUpstreamError,
  toolProtocolError,
  unsafeEndpointError,
  unsupportedCapabilityError,
  type HttpErrorInput,
  type UpstreamErrorSummary,
} from "./errors.js";

export {
  systemOpenAiScheduler,
  openAiSchedulerFromManual,
  fixedJitterSource,
  computeBackoffMs,
  type OpenAiScheduler,
  type OpenAiDelayHandle,
  type JitterSource,
  type BackoffPlan,
} from "./scheduler.js";

export type {
  AdminCredentialPort,
  ArtifactResolverPort,
  CredentialPort,
  CredentialRequest,
  DisclosureAuthorization,
  DisclosureAuthorizationRequest,
  DisclosurePort,
  FetchLike,
  IdSource,
  ResolvedArtifactBytes,
  SafetyIdentifierPort,
  SafetyIdentifierRequest,
} from "./ports.js";

export {
  OPENAI_CATALOG_SCHEMA_VERSION,
  OPENAI_REASONING_EFFORTS,
  OPENAI_REASONING_SUMMARIES,
  OPENAI_LATENCY_CLASSES,
  UNKNOWN_COMPUTED_COST,
  applyCapabilityOverride,
  computeCost,
  emptyOpenAiModelCatalog,
  listCatalogModelIds,
  parseOpenAiCapabilityOverride,
  parseOpenAiModelCatalog,
  selectCatalogEntry,
  selectPricingSlice,
  toModelCapabilities,
  type ComputedCost,
  type OpenAiCapabilityEvidence,
  type OpenAiCapabilityOverride,
  type OpenAiCatalogEntry,
  type OpenAiModelCatalog,
  type OpenAiPricingSlice,
  type OpenAiReasoningEffort,
  type OpenAiReasoningSummary,
} from "./catalog.js";

export {
  OPENAI_ADAPTER_SCHEMA_VERSION,
  OPENAI_EXTENSION_NAMESPACE,
  OPENAI_BACKGROUND_MODES,
  OPENAI_STORE_MODES,
  OPENAI_SERVICE_TIERS,
  OPENAI_VERBOSITIES,
  createOpenAiAdapterConfiguration,
  findCapabilityOverride,
  parseOpenAiAdapterConfiguration,
  type OpenAiAdapterConfiguration,
  type OpenAiAdapterConfigurationInput,
  type OpenAiBackgroundMode,
  type OpenAiBackgroundPolicy,
  type OpenAiDeadlines,
  type OpenAiLimits,
  type OpenAiReasoningControls,
  type OpenAiRetentionDeclaration,
  type OpenAiRetryPolicy,
  type OpenAiServiceTier,
  type OpenAiStoreMode,
  type OpenAiStoragePolicy,
  type OpenAiVerbosity,
} from "./config.js";

export {
  MAX_SAFETY_IDENTIFIER_LENGTH,
  assertSafetyIdentifier,
  bindingFingerprint,
  createHashedSafetyIdentifierPort,
  createStaticSafetyIdentifierPort,
  safetyIdentifierMatchesSubject,
  type HashedSafetyIdentifierOptions,
} from "./safety.js";

export { createSseParser, type SseEvent, type SseParser, type SseParserOptions } from "./sse.js";

export {
  OPENAI_RESPONSE_STATUSES,
  OPENAI_TERMINAL_STATUSES,
  ZERO_WIRE_USAGE,
  classifyStreamEvent,
  isTerminalStatus,
  parseOutputItem,
  parseResponseSnapshot,
  parseWireUsage,
  toTokenUsage,
  type OpenAiContentPart,
  type OpenAiFunctionCallItem,
  type OpenAiMessageItem,
  type OpenAiOutputItem,
  type OpenAiReasoningItem,
  type OpenAiResponseSnapshot,
  type OpenAiResponseStatus,
  type OpenAiStreamEvent,
  type OpenAiWireUsage,
  type WireLimits,
} from "./wire.js";

export {
  parseResetDurationMs,
  createFetchOpenAiTransport,
  type FetchOpenAiTransportOptions,
  type OpenAiJsonResponse,
  type OpenAiRequestOptions as OpenAiTransportRequestOptions,
  type OpenAiResponseMetadata,
  type OpenAiStreamResponse,
  type OpenAiTransport,
} from "./transport.js";

export {
  buildResponsesRequest,
  collectImageArtifacts,
  mapMessagesToInput,
  mapToolChoice,
  mapTools,
  parseRequestExtensions,
  type BuildRequestInput,
  type InputMappingOptions,
  type OpenAiRequestOptions as OpenAiRequestAdapterOptions,
  type ResolvedImage,
} from "./request.js";

export { validateAgainstSchema, type SchemaValidationResult, type SchemaViolation } from "./schema.js";

export {
  ACTIVE_BACKGROUND_STATUSES,
  advanceCursor,
  assertHandleUsable,
  assertResumeContinuity,
  computeBackgroundBinding,
  createBackgroundHandle,
  createSequenceGuard,
  isActiveStatus,
  type BackgroundBindingInput,
  type BackgroundHandle,
  type SequenceGuard,
} from "./background.js";

export {
  safelyObserve,
  type OpenAiExecutionMode,
  type OpenAiObservation,
  type OpenAiObserver,
  type OpenAiRetentionObservation,
} from "./observability.js";

export {
  createPolicyAwareCredentialPort,
  createPolicyBrokerDisclosurePort,
  type CredentialPortOptions,
  type DisclosurePortOptions,
  type PolicyContextSource,
} from "./composition.js";

export {
  OPENAI_PROVIDER_ID,
  createOpenAiProvider,
  type CreateOpenAiProviderOptions,
  type OpenAiInferenceProvider,
  type OpenAiRetentionDisclosure,
} from "./provider.js";
