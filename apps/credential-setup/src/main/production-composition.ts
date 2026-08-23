import { join, resolve, sep } from "node:path";
import { createDeterministicPolicyBroker, parsePolicyRule } from "@ai-dev-os/policy";
import type { SecretAuditRecord, SecretClock } from "@ai-dev-os/secrets";
import { APP_VAULT_BROKER_SCHEMA_VERSION, APP_VAULT_SLOTS, appVaultReferenceForSlot, type AppVaultSecretBroker, type AppVaultSlotId } from "@ai-dev-os/secrets-app-vault";
import { createAppVaultManager, createAppVaultSecretBroker } from "@ai-dev-os/secrets-app-vault-electron";
import { createFileCredentialMetadataStore } from "./metadata-store.js";
import { CredentialHostService, createCredentialResolverBinding, type CredentialResolverBinding } from "./host-service.js";
import {
  anthropicValidationAuthorizationRoot,
  createAnthropicValidationAuthorizationGate,
  loadStage18eICandidateBinding,
} from "./anthropic-validation-authorization.js";
import { createAnthropicCredentialValidationPort } from "./anthropic-validation.js";

function fixedMetadataRoot(appDataPath: string, appName: string): string {
  const root = resolve(appDataPath);
  const target = resolve(root, appName, "credential-setup");
  if (!target.startsWith(root + sep)) throw new Error("CREDENTIAL_METADATA_PATH_INVALID");
  return target;
}

export async function createProductionCredentialHost(electron: Readonly<{
  app: typeof import("electron").app;
  clipboard: typeof import("electron").clipboard;
  safeStorage: typeof import("electron").safeStorage;
}>): Promise<CredentialHostService> {
  const clock: SecretClock = Object.freeze({ now: () => new Date() });
  const auditRecords: SecretAuditRecord[] = [];
  const audit = (record: SecretAuditRecord): void => {
    auditRecords.unshift(record);
    if (auditRecords.length > 128) auditRecords.length = 128;
  };
  const manager = await createAppVaultManager({ schemaVersion: APP_VAULT_BROKER_SCHEMA_VERSION, clock, audit });
  const mutable = {} as Record<AppVaultSlotId, CredentialResolverBinding>;
  const constructedBrokers: AppVaultSecretBroker[] = [];
  try {
    const policy = createDeterministicPolicyBroker({
      policyVersion: "credential-validation.v1",
      rules: [parsePolicyRule({
        schemaVersion: 1,
        id: "credential-secret-access",
        authority: "organization",
        effect: "allow",
        actions: ["provider-disclosure", "secret-access"],
        classifications: ["internal"],
        risks: ["low"],
        requiredTransformations: [],
        approval: null,
        requiredLocality: "any",
        forbidInputLogging: true,
        forbidOutputLogging: true,
        forbidArtifactPersistence: true,
        forbidRetention: true,
        maxRetentionDays: 0,
        forbiddenCapabilities: [],
      })],
      clock,
    });
    for (const slot of APP_VAULT_SLOTS) {
      const broker = await createAppVaultSecretBroker({ schemaVersion: APP_VAULT_BROKER_SCHEMA_VERSION, reference: appVaultReferenceForSlot(slot.slotId), clock, audit });
      constructedBrokers.push(broker);
      mutable[slot.slotId] = createCredentialResolverBinding(broker, policy);
    }
    const metadataRoot = fixedMetadataRoot(electron.app.getPath("appData"), electron.app.getName());
    const candidateBinding = await loadStage18eICandidateBinding(electron.app.getAppPath());
    const authorizationGate = await createAnthropicValidationAuthorizationGate({
      root: anthropicValidationAuthorizationRoot(
        electron.app.getPath("appData"),
        electron.app.getName(),
      ),
      candidateBinding,
      now: clock.now,
    });
    return new CredentialHostService({
      manager,
      resolvers: Object.freeze(mutable),
      metadata: createFileCredentialMetadataStore(metadataRoot),
      validation: createAnthropicCredentialValidationPort({ gate: authorizationGate, now: clock.now }),
      validationEnabled: true,
      validationTimeoutMs: 20_000,
      clock,
      encryptionAvailable: async () => await electron.safeStorage.isAsyncEncryptionAvailable(),
      clipboard: Object.freeze({ async clear() { electron.clipboard.clear(); return true; } }),
    });
  } catch (error) {
    await Promise.allSettled([
      Promise.resolve().then(async () => await manager.close()),
      ...constructedBrokers.map(async (broker) => await broker.close()),
    ]);
    throw error;
  }
}

export function credentialRendererRoot(applicationPath: string): string {
  return join(applicationPath, "dist", "renderer", "credential");
}
