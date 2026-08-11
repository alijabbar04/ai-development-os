export {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  isPersistenceError,
  type PersistenceErrorCode,
  type PersistenceErrorDetailValue,
  type PersistenceErrorDetails,
} from "./errors.js";

export {
  CHECKSUM_ALGORITHMS,
  parseChecksum,
  computeChecksumOfText,
  canonicalizeWithChecksum,
  checksumEquals,
  verifyChecksum,
  type ChecksumAlgorithm,
  type Checksum,
} from "./checksum.js";

export {
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  encodeCursor,
  decodeCursor,
  normalizePageSize,
  buildPage,
  type Page,
  type StringKeyCursor,
  type SequenceCursor,
  type ListCursor,
} from "./cursor.js";

export {
  AGGREGATE_TYPES,
  MAX_AGGREGATE_VERSION,
  MAX_SCHEMA_VERSION,
  MAX_PAYLOAD_TEXT_LENGTH,
  MAX_LEASE_DURATION_MS,
  MAX_CLAIM_LIMIT,
  OUTBOX_STATUSES,
  parsePersistedId,
  parseAggregateType,
  preparePayload,
  validateCreateAggregateInput,
  validateUpdateAggregateInput,
  validateAppendEventInput,
  validateEnqueueOutboxInput,
  validateClaimOutboxInput,
  parseFailureCategory,
  type AggregateType,
  type AggregateEnvelope,
  type CreateAggregateInput,
  type UpdateAggregateInput,
  type ValidatedAggregateWrite,
  type EventRecord,
  type AppendEventInput,
  type ValidatedEventAppend,
  type OutboxStatus,
  type OutboxMessage,
  type EnqueueOutboxInput,
  type ValidatedOutboxEnqueue,
  type ClaimOutboxInput,
  type ValidatedOutboxClaim,
} from "./records.js";

export {
  isClaimable,
  applyClaim,
  applyAcknowledge,
  applyScheduleRetry,
  applyDeadLetter,
  leaseExpiry,
  type OutboxTransitionState,
} from "./outbox-logic.js";

export {
  MAX_MIGRATION_DEFINITIONS,
  parseMigrationId,
  migrationChecksum,
  parseAppliedMigration,
  planMigrations,
  type MigrationDefinition,
  type AppliedMigration,
  type MigrationStatus,
} from "./migration.js";

export {
  systemClock,
  OPERATION_OUTCOMES,
  type Clock,
  type OperationOutcome,
  type OperationRecord,
  type PersistenceObserver,
  type AdapterOptions,
  type AggregateStore,
  type EventStore,
  type OutboxStore,
  type ArtifactMetadataStore,
  type TransactionContext,
  type PersistenceAdapter,
} from "./ports.js";

export { AsyncMutex } from "./mutex.js";

export {
  outcomeOfError,
  observeOperation,
  TransactionGuard,
  SessionGate,
} from "./adapter-support.js";
