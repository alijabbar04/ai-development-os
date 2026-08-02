export {
  parseOllamaEndpoint,
  isLoopbackOllamaEndpoint,
  type OllamaEndpoint,
} from "./endpoint.js";

export {
  OLLAMA_ADAPTER_SCHEMA_VERSION,
  OLLAMA_EXTENSION_NAMESPACE,
  OLLAMA_MODEL_ROLES,
  parseOllamaAdapterConfiguration,
  createOllamaAdapterConfiguration,
  resolveOllamaConfiguration,
  normalizeOllamaDigest,
  type OllamaModelRole,
  type OllamaKeepAlivePolicy,
  type OllamaModelConcurrencyLimit,
  type OllamaDigestPin,
  type OllamaRolePreference,
  type OllamaCapabilityOverride,
  type OllamaAdapterConfiguration,
  type OllamaAdapterConfigurationInput,
} from "./config.js";

export {
  systemOllamaScheduler,
  ollamaSchedulerFromManual,
  type OllamaScheduler,
  type OllamaDelayHandle,
} from "./scheduler.js";

export {
  OLLAMA_ENDPOINTS,
  MAX_JSON_RESPONSE_BYTES,
  MAX_ERROR_BODY_BYTES,
  createFetchOllamaTransport,
  type OllamaEndpointName,
  type OllamaTransport,
  type OllamaTransportRequestOptions,
  type OllamaJsonResponse,
  type OllamaStreamResponse,
  type FetchOllamaTransportOptions,
} from "./transport.js";

export {
  DEFAULT_MAX_RECORD_TEXT,
  DEFAULT_MAX_STREAM_BYTES,
  DEFAULT_MAX_STREAM_RECORDS,
  createNdjsonParser,
  type NdjsonParser,
  type NdjsonParserOptions,
} from "./ndjson.js";

export {
  normalizeOllamaTimestamp,
  parseOllamaTagsResponse,
  parseOllamaShowResponse,
  parseOllamaPsResponse,
  parseOllamaVersionResponse,
  parseOllamaChatRecord,
  isOllamaErrorRecord,
  type OllamaWireModelDetails,
  type OllamaWireInstalledModel,
  type OllamaWireTagsResponse,
  type OllamaWireShowResponse,
  type OllamaWireRunningModel,
  type OllamaWirePsResponse,
  type OllamaWireVersionResponse,
  type OllamaWireToolCall,
  type OllamaWireChatCounters,
  type OllamaWireChatRecord,
} from "./wire.js";

export {
  OLLAMA_FAMILY_KNOWLEDGE_VERSION,
  DEFAULT_UNKNOWN_CONTEXT_LENGTH,
  normalizeOllamaCapabilities,
  toStage2ModelCapabilities,
  type OllamaCapabilityProvenance,
  type OllamaNormalizedCapabilities,
} from "./capabilities.js";

export {
  discoverOllamaCatalog,
  findCatalogEntry,
  ollamaModelNamesEqual,
  type OllamaDigestPinStatus,
  type OllamaCatalogEntry,
  type OllamaModelCatalog,
  type OllamaDiscoveryOptions,
} from "./catalog.js";

export {
  selectOllamaModel,
  type OllamaSelectionRequirements,
  type OllamaSelectionQuery,
  type OllamaRejectedCandidate,
  type OllamaCapabilityEvidence,
  type OllamaSelectionResult,
} from "./selection.js";

export {
  createOllamaCapacityManager,
  capacityManagerFromConfiguration,
  keepAliveWireValue,
  planOllamaResidency,
  type OllamaCapacityLease,
  type OllamaCapacitySnapshot,
  type OllamaAdmissionRequest,
  type OllamaCapacityManager,
  type OllamaCapacityManagerOptions,
  type OllamaResidencyAction,
  type OllamaResidencyPlan,
} from "./capacity.js";

export { nanosToMillis, type OllamaObservation, type OllamaObserver } from "./observability.js";

export {
  OLLAMA_PROVIDER_ID,
  createOllamaProvider,
  type OllamaHealthCategory,
  type OllamaHealthSnapshot,
  type OllamaInferenceProvider,
  type CreateOllamaProviderOptions,
} from "./provider.js";
