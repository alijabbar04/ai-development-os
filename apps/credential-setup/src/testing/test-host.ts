import { createDeterministicPolicyBroker, parsePolicyRule, type PolicyAction } from "@ai-dev-os/policy";
import type { SecretAuditRecord, SecretClock } from "@ai-dev-os/secrets";
import { APP_VAULT_BROKER_SCHEMA_VERSION, APP_VAULT_SLOTS, appVaultReferenceForSlot, type AppVaultSlotId } from "@ai-dev-os/secrets-app-vault";
import {
  createAppVaultManagerForTesting,
  createAppVaultSecretBrokerForTesting,
  createDeterministicAppVaultCryptoPort,
  createDeterministicAppVaultRandomPort,
  createMemoryAppVaultStoragePort,
} from "@ai-dev-os/secrets-app-vault/testing";
import { CredentialHostService, createCredentialResolverBinding, type CredentialResolverBinding } from "../main/host-service.js";
import { createMemoryCredentialMetadataStore } from "../main/metadata-store.js";
import { createDeterministicCredentialValidationPort, type CredentialValidationPort } from "../main/validation.js";

export interface TestCredentialHostControl {
  readonly manager: ReturnType<typeof createAppVaultManagerForTesting>;
  readonly resolvers: Readonly<Record<AppVaultSlotId, CredentialResolverBinding>>;
  readonly metadata: ReturnType<typeof createMemoryCredentialMetadataStore>;
  readonly storage: ReturnType<typeof createMemoryAppVaultStoragePort>;
  readonly audit: readonly SecretAuditRecord[];
  readonly clock: SecretClock & { advance(ms: number): void };
  readonly clipboard: { readonly clears: number; readonly succeeds: boolean };
  readonly policyActions: readonly PolicyAction[];
  readonly policyTraceIds: readonly string[];
  createService(options?: Readonly<{ validation?: CredentialValidationPort; validationEnabled?: boolean; validationTimeoutMs?: number; clipboardSucceeds?: boolean; encryptionAvailable?: boolean | (() => boolean | Promise<boolean>) }>): CredentialHostService;
}

export function createTestCredentialHost(options: Readonly<{ shouldReEncrypt?: boolean | (() => boolean); failDecrypt?: boolean | (() => boolean); validationPolicyEffect?: "allow" | "deny" }> = {}): TestCredentialHostControl {
  let now = new Date("2026-08-20T10:00:00.000Z").valueOf();
  const clock: SecretClock & { advance(ms: number): void } = Object.freeze({ now: () => new Date(now), advance(ms: number) { now += ms; } });
  const crypto = createDeterministicAppVaultCryptoPort({
    ...(options.shouldReEncrypt === undefined ? {} : { shouldReEncrypt: options.shouldReEncrypt }),
    ...(options.failDecrypt === undefined ? {} : { failDecrypt: options.failDecrypt }),
  });
  const storage = createMemoryAppVaultStoragePort();
  const random = createDeterministicAppVaultRandomPort(31);
  const identity = Object.freeze({ name: "AI Development OS Credential Setup Test", appDataPath: "c:/bounded-test-app-data" });
  const audit: SecretAuditRecord[] = [];
  const auditHook = (record: SecretAuditRecord): void => { audit.push(record); };
  const manager = createAppVaultManagerForTesting({ schemaVersion: APP_VAULT_BROKER_SCHEMA_VERSION, appIdentity: identity, clock, crypto, storage: storage.port, random, audit: auditHook });
  const policyActions: PolicyAction[] = [];
  const policyTraceIds: string[] = [];
  const policy = createDeterministicPolicyBroker({
    policyVersion: "credential-test.v1",
    rules: [parsePolicyRule({ schemaVersion: 1, id: "credential-test-access", authority: "organization", effect: options.validationPolicyEffect ?? "allow", actions: ["provider-disclosure", "secret-access"], classifications: ["internal"], risks: ["low"], requiredTransformations: [], approval: null, requiredLocality: "any", forbidInputLogging: true, forbidOutputLogging: true, forbidArtifactPersistence: true, forbidRetention: true, maxRetentionDays: 0, forbiddenCapabilities: [] })],
    clock,
    observer(record) { policyActions.push(record.action); policyTraceIds.push(record.traceId); },
  });
  const bindings = {} as Record<AppVaultSlotId, CredentialResolverBinding>;
  for (const slot of APP_VAULT_SLOTS) {
    const broker = createAppVaultSecretBrokerForTesting({ schemaVersion: APP_VAULT_BROKER_SCHEMA_VERSION, reference: appVaultReferenceForSlot(slot.slotId), appIdentity: identity, clock, crypto, storage: storage.port, random, audit: auditHook });
    bindings[slot.slotId] = createCredentialResolverBinding(broker, policy);
  }
  const metadata = createMemoryCredentialMetadataStore();
  let idSequence = 0;
  const randomPort = Object.freeze({ hex(bytes: number): string { idSequence += 1; return idSequence.toString(16).padStart(bytes * 2, "0").slice(-bytes * 2); } });
  const clipboardState = { clears: 0, succeeds: true };
  return {
    manager,
    resolvers: Object.freeze(bindings),
    metadata,
    storage,
    audit,
    clock,
    policyActions,
    policyTraceIds,
    get clipboard() { return Object.freeze({ clears: clipboardState.clears, succeeds: clipboardState.succeeds }); },
    createService(options = {}) {
      clipboardState.succeeds = options.clipboardSucceeds ?? true;
      const encryptionAvailable = options.encryptionAvailable;
      return new CredentialHostService({
        manager,
        resolvers: bindings,
        metadata,
        validation: options.validation ?? createDeterministicCredentialValidationPort(),
        validationEnabled: options.validationEnabled ?? true,
        ...(options.validationTimeoutMs === undefined ? {} : { validationTimeoutMs: options.validationTimeoutMs }),
        clock,
        random: randomPort,
        encryptionAvailable: typeof encryptionAvailable === "function" ? encryptionAvailable : () => encryptionAvailable ?? true,
        clipboard: Object.freeze({ async clear() { clipboardState.clears += 1; return clipboardState.succeeds; } }),
      });
    },
  };
}
