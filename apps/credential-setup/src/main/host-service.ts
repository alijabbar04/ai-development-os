import { createHash, randomBytes } from "node:crypto";
import { createDataHandlingPolicy, toCanonicalJson } from "@ai-dev-os/domain";
import { parsePolicyRequest, type PolicyBroker, type PolicyDecision, type PolicyRequest } from "@ai-dev-os/policy";
import {
  createPolicyAwareSecretResolver,
  parseSecretAccessContext,
  SecretBrokerError,
  secretRefDisplay,
  secretRefFingerprint,
  type PolicyAwareSecretResolver,
  type SecretAccessContext,
  type SecretClock,
  type SecretMaterial,
  type SecretRef,
} from "@ai-dev-os/secrets";
import {
  APP_VAULT_SLOTS,
  appVaultReferenceForSlot,
  appVaultSlot,
  type AppVaultManager,
  type AppVaultContainerBinding,
  type AppVaultRecordSummary,
  type AppVaultSecretBroker,
  type AppVaultSlotId,
  type AppVaultSnapshot,
} from "@ai-dev-os/secrets-app-vault";
import type {
  ClipboardResult,
  CredentialActivitySentence,
  CredentialDeveloperFacts,
  CredentialErrorCode,
  CredentialMutationResult,
  CredentialResponse,
  CredentialSlotView,
  CredentialSlotsResult,
  CredentialValidatedResult,
  CredentialValidationAuthorizationState,
  CredentialValidationAuthorizationView,
  CredentialValidationOutcome,
} from "@ai-dev-os/credential-ui";
import { CredentialEntrySession } from "./session-machine.js";
import { CredentialHostError, finiteCredentialError } from "./host-error.js";
import { assertCredentialMetadataSeparatedFromSecret } from "./metadata-safety.js";
import type { CancelPayload, DescribePayload, RemovePayload, RotatePayload, SavePayload, SetEnabledPayload, ValidatePayload } from "./ipc-schema.js";
import {
  emptyCredentialMetadata,
  replaceSlotMetadata,
  type CredentialMetadataSnapshot,
  type CredentialMetadataStore,
  type CredentialSlotMetadata,
  type StoredValidation,
} from "./metadata-store.js";
import { parseCredentialValidationResult, validationDefinitive, type CredentialValidationPort, type CredentialValidationResult } from "./validation.js";
import type { AnthropicValidationSuccessReceiptStore } from "./anthropic-validation-receipt-store.js";

const PROVIDER_FACTS: Readonly<Record<AppVaultSlotId, Readonly<{ productName: string; providerHost: string }>>> = Object.freeze({
  anthropic: Object.freeze({ productName: "Claude", providerHost: "api.anthropic.com" }),
  openai: Object.freeze({ productName: "GPT & Codex", providerHost: "api.openai.com" }),
  gemini: Object.freeze({ productName: "Gemini", providerHost: "generativelanguage.googleapis.com" }),
  openrouter: Object.freeze({ productName: "Many models through one provider", providerHost: "openrouter.ai" }),
});

function validationProvider(slotId: AppVaultSlotId) {
  const slot = appVaultSlot(slotId);
  return Object.freeze({
    schemaVersion: 1,
    providerId: slot.slotId,
    instanceId: slot.providerInstanceId,
    kind: "inference",
    displayName: slot.displayName,
    locality: "cloud",
    retainsData: true,
    trainsOnInputs: false,
    supportedClassifications: Object.freeze(["internal"]),
    capabilities: Object.freeze({
      streaming: false,
      structuredOutput: false,
      toolCalling: false,
      imageInput: false,
      repositoryEditing: false,
      commandExecution: false,
      networkAccess: true,
      resumability: false,
      cancellation: "best-effort",
      deadlineEnforcement: true,
      usageReporting: false,
      pricingAvailable: false,
    }),
  });
}

const VALIDATION_HANDLING_POLICY = createDataHandlingPolicy({
  classification: "internal",
  cloudProvidersAllowed: true,
  localExecutionRequired: false,
  redactionsRequiredBeforeDisclosure: [],
  logRetentionAllowed: false,
  artifactPersistenceAllowed: false,
  humanApprovalRequired: false,
  disallowedProviderCapabilities: Object.freeze(["model-training", "third-party-sharing"]),
});

function validationDisclosureSubject(slotId: AppVaultSlotId): string {
  const slot = appVaultSlot(slotId);
  return createHash("sha256").update(toCanonicalJson({ action: "credential-validation", providerInstanceId: slot.providerInstanceId, purpose: "provider-authentication", requestCount: 1 })).digest("hex");
}

export interface CredentialHostRandomPort {
  hex(bytes: number): string;
}

export interface CredentialClipboardPort {
  clear(): Promise<boolean>;
}

export interface CredentialResolverBinding {
  describeContainerBinding(): AppVaultContainerBinding;
  resolve<T>(input: { readonly ref: SecretRef; readonly context: SecretAccessContext; readonly policyRequest: PolicyRequest }, callback: (secret: SecretMaterial, decisionFingerprint: string) => T | Promise<T>): Promise<{ readonly value: T; readonly decisionFingerprint: string }>;
  evaluatePolicy(request: PolicyRequest): PolicyDecision;
  close(): Promise<void>;
}

export const CREDENTIAL_RESOLVER_BINDING_KEYS = Object.freeze(["close", "describeContainerBinding", "evaluatePolicy", "resolve"] as const satisfies readonly (keyof CredentialResolverBinding)[]);
type UnexpectedCredentialResolverBindingKey = Exclude<keyof CredentialResolverBinding, typeof CREDENTIAL_RESOLVER_BINDING_KEYS[number]>;
const CREDENTIAL_RESOLVER_BINDING_KEYS_ARE_COMPLETE: UnexpectedCredentialResolverBindingKey extends never ? true : false = true;
void CREDENTIAL_RESOLVER_BINDING_KEYS_ARE_COMPLETE;

export interface CredentialHostServiceOptions {
  readonly manager: AppVaultManager;
  readonly resolvers: Readonly<Record<AppVaultSlotId, CredentialResolverBinding>>;
  readonly metadata: CredentialMetadataStore;
  readonly validation: CredentialValidationPort;
  readonly successReceiptStore?: AnthropicValidationSuccessReceiptStore;
  readonly successReceiptCandidateBinding?: Readonly<{
    head: string;
    tree: string;
    manifestAggregate: string;
  }> | null;
  readonly validationEnabled: boolean;
  readonly validationTimeoutMs?: number;
  readonly clock: SecretClock;
  readonly random?: CredentialHostRandomPort;
  readonly clipboard: CredentialClipboardPort;
  readonly encryptionAvailable?: () => boolean | Promise<boolean>;
  readonly session?: CredentialEntrySession;
}

function defaultRandom(): CredentialHostRandomPort {
  return Object.freeze({ hex: (bytes: number) => randomBytes(bytes).toString("hex") });
}

function requestId(payload: { readonly requestId: string }): string { return payload.requestId; }

function refused(id: string, error: unknown): CredentialResponse {
  const finite = finiteCredentialError(error);
  if (finite.code === "UNKNOWN_OUTCOME") return Object.freeze({ schemaVersion: 1, requestId: id, ok: false, kind: "unknown", code: "UNKNOWN_OUTCOME", retryable: false });
  return Object.freeze({ schemaVersion: 1, requestId: id, ok: false, kind: "refused", code: finite.code, retryable: finite.retryable });
}

function recordToken(slotId: AppVaultSlotId, summary: AppVaultSnapshot["slots"][number]): string | null {
  if (summary.revision === null || summary.generation === null || summary.state === "absent") return null;
  return createHash("sha256").update(toCanonicalJson({ slotId, state: summary.state, generation: summary.generation, createdAt: summary.createdAt, rotatedAt: summary.rotatedAt, revokedAt: summary.revokedAt })).digest("hex");
}

function issueCode(snapshot: AppVaultSnapshot): CredentialErrorCode | null {
  if (snapshot.issue === null) return null;
  const map: Readonly<Record<string, CredentialErrorCode>> = Object.freeze({
    VAULT_CORRUPT: "VAULT_CORRUPT",
    VAULT_BACKUP_ONLY: "VAULT_BACKUP_ONLY",
    VAULT_IDENTITY_MISMATCH: "VAULT_IDENTITY_MISMATCH",
    VAULT_BACKEND_MISMATCH: "VAULT_BACKEND_MISMATCH",
    VAULT_SCHEMA_AHEAD: "VAULT_SCHEMA_AHEAD",
    ENCRYPTION_UNAVAILABLE: "ENCRYPTION_UNAVAILABLE",
  });
  return map[snapshot.issue] ?? "REFUSED";
}

function fallbackCredentialId(slotId: AppVaultSlotId, summary: AppVaultSnapshot["slots"][number]): string | null {
  if (summary.state === "absent") return null;
  const digest = createHash("sha256").update(JSON.stringify({ slotId, createdAt: summary.createdAt, generation: summary.generation })).digest("hex");
  return `cred-${digest.slice(0, 32)}`;
}

function snapshotWithSummary(snapshot: AppVaultSnapshot, changed: AppVaultRecordSummary): AppVaultSnapshot {
  return Object.freeze({
    ...snapshot,
    vaultState: "ready",
    revision: changed.revision,
    slots: Object.freeze(snapshot.slots.map((slot) => slot.slotId === changed.slotId ? changed : slot)),
    issue: null,
    recovery: null,
  });
}

function validationActivityCopy(outcome: CredentialValidationOutcome): Readonly<{ tone: CredentialActivitySentence["tone"]; sentence: string }> {
  if (outcome === "valid") return Object.freeze({ tone: "ok", sentence: "accepted it" });
  if (outcome === "invalid") return Object.freeze({ tone: "danger", sentence: "did not accept it" });
  if (outcome === "unauthorized") return Object.freeze({ tone: "warn", sentence: "accepted it with limited permission" });
  if (outcome === "evidence-incomplete") return Object.freeze({ tone: "warn", sentence: "accepted it, but the audit receipt was not saved" });
  return Object.freeze({ tone: "warn", sentence: "did not judge it" });
}

function authorizationStateError(state: CredentialValidationAuthorizationState): CredentialErrorCode {
  if (state === "invalid") return "VALIDATION_AUTHORIZATION_INVALID";
  if (state === "expired") return "VALIDATION_AUTHORIZATION_EXPIRED";
  if (state === "consumed") return "VALIDATION_AUTHORIZATION_CONSUMED";
  return "VALIDATION_AUTHORIZATION_UNAVAILABLE";
}

const AMBIGUOUS_VALIDATION_RESULT: CredentialValidationResult = Object.freeze({ outcome: "ambiguous", resultCode: "RESULT_AMBIGUOUS" });
const EVIDENCE_INCOMPLETE_VALIDATION_RESULT: CredentialValidationResult = Object.freeze({ outcome: "evidence-incomplete", resultCode: "EVIDENCE_RECEIPT_UNAVAILABLE" });

function finiteValidationResult(value: unknown, requiresSuccessReceipt: boolean): CredentialValidationResult {
  try {
    const result = parseCredentialValidationResult(value);
    if (requiresSuccessReceipt && result.outcome === "valid" && (result.successReceiptId === undefined || result.successReceiptSha256 === undefined)) return EVIDENCE_INCOMPLETE_VALIDATION_RESULT;
    return result;
  }
  catch { return AMBIGUOUS_VALIDATION_RESULT; }
}

function applicableStoredValidation(stored: StoredValidation | null, token: string | null): StoredValidation | null {
  if (stored === null || token === null || stored.recordToken !== token) return null;
  return stored;
}

function clearStoredValidationForToken(slot: CredentialSlotMetadata | null, token: string): CredentialSlotMetadata | null {
  if (slot === null) return null;
  const validation = slot.validation?.recordToken === token ? null : slot.validation;
  const lastValidationAttempt = slot.lastValidationAttempt?.recordToken === token ? null : slot.lastValidationAttempt;
  return validation === slot.validation && lastValidationAttempt === slot.lastValidationAttempt
    ? slot
    : Object.freeze({ ...slot, validation, lastValidationAttempt });
}

function validationForView(stored: StoredValidation | null, receiptMismatch = false) {
  if (stored === null) return null;
  return Object.freeze({
    outcome: receiptMismatch ? "evidence-incomplete" as const : stored.outcome,
    checkedAt: stored.checkedAt,
    recordRevision: stored.recordRevision,
    recordToken: stored.recordToken,
    definitive: receiptMismatch ? false : stored.definitive,
    receiptState: receiptMismatch ? "mismatch" as const : stored.receiptState,
  });
}

function activity(random: CredentialHostRandomPort, clock: SecretClock, tone: CredentialActivitySentence["tone"], text: string): CredentialActivitySentence {
  return Object.freeze({ id: `activity-${random.hex(12)}`, at: clock.now().toISOString(), tone, text });
}

function requiredIsoTimestamp(clock: SecretClock): string {
  try {
    const value = clock.now().toISOString();
    if (!Number.isFinite(Date.parse(value))) throw new Error("invalid-clock");
    return value;
  } catch {
    throw new CredentialHostError("REFUSED");
  }
}

function bestEffortIsoTimestamp(clock: SecretClock, fallback: string): string {
  try {
    const value = clock.now().toISOString();
    return Number.isFinite(Date.parse(value)) ? value : fallback;
  } catch { return fallback; }
}

function requiredActivityId(random: CredentialHostRandomPort): string {
  let value: string;
  try { value = random.hex(12); }
  catch { throw new CredentialHostError("REFUSED"); }
  if (!/^[a-f0-9]{24}$/u.test(value)) throw new CredentialHostError("REFUSED");
  return `activity-${value}`;
}

function activityFromReservedFacts(id: string, at: string, tone: CredentialActivitySentence["tone"], text: string): CredentialActivitySentence {
  return Object.freeze({ id, at, tone, text });
}

export class CredentialHostService {
  readonly #manager: AppVaultManager;
  readonly #resolvers: Readonly<Record<AppVaultSlotId, CredentialResolverBinding>>;
  readonly #metadata: CredentialMetadataStore;
  readonly #validation: CredentialValidationPort;
  readonly #successReceiptStore: AnthropicValidationSuccessReceiptStore | null;
  readonly #successReceiptCandidateBinding: Readonly<{
    head: string;
    tree: string;
    manifestAggregate: string;
  }> | null;
  readonly #validationEnabled: boolean;
  readonly #validationTimeoutMs: number;
  readonly #clock: SecretClock;
  readonly #random: CredentialHostRandomPort;
  readonly #clipboard: CredentialClipboardPort;
  readonly #encryptionAvailable: () => boolean | Promise<boolean>;
  readonly #session: CredentialEntrySession;
  readonly #validating = new Set<string>();
  readonly #validationControllers = new Set<AbortController>();
  #closed = false;
  #active = 0;
  #closePromise: Promise<void> | null = null;
  #idleWaiters: Array<() => void> = [];

  constructor(options: CredentialHostServiceOptions) {
    this.#manager = options.manager;
    this.#resolvers = options.resolvers;
    this.#metadata = options.metadata;
    this.#validation = options.validation;
    this.#successReceiptStore = options.successReceiptStore ?? null;
    const receiptCandidate = options.successReceiptCandidateBinding ?? null;
    if (
      receiptCandidate !== null &&
      (!/^[a-f0-9]{40}$/u.test(receiptCandidate.head) ||
        !/^[a-f0-9]{40}$/u.test(receiptCandidate.tree) ||
        !/^[a-f0-9]{64}$/u.test(receiptCandidate.manifestAggregate))
    ) throw new CredentialHostError("REFUSED");
    this.#successReceiptCandidateBinding = receiptCandidate === null
      ? null
      : Object.freeze({
        head: receiptCandidate.head,
        tree: receiptCandidate.tree,
        manifestAggregate: receiptCandidate.manifestAggregate,
      });
    if (this.#validation.requiresSuccessReceipt === true && this.#successReceiptStore === null) throw new CredentialHostError("REFUSED");
    this.#validationEnabled = options.validationEnabled;
    this.#validationTimeoutMs = options.validationTimeoutMs ?? 20_000;
    if (!Number.isSafeInteger(this.#validationTimeoutMs) || this.#validationTimeoutMs < 1 || this.#validationTimeoutMs > 20_000) throw new CredentialHostError("REFUSED");
    this.#clock = options.clock;
    this.#random = options.random ?? defaultRandom();
    this.#clipboard = options.clipboard;
    this.#encryptionAvailable = options.encryptionAvailable ?? (() => true);
    this.#session = options.session ?? new CredentialEntrySession();
  }

  get session(): CredentialEntrySession { return this.#session; }

  #enter(): void {
    if (this.#closed) throw new CredentialHostError("APP_NOT_READY");
    this.#active += 1;
  }

  #leave(): void {
    this.#active -= 1;
    if (this.#active === 0) {
      const waiters = this.#idleWaiters;
      this.#idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  #trackBackground(promise: Promise<unknown>): void {
    this.#active += 1;
    const settle = (): void => { this.#leave(); };
    void promise.then(settle, settle);
  }

  async #awaitIdle(): Promise<void> {
    if (this.#active > 0) await new Promise<void>((resolve) => { this.#idleWaiters.push(resolve); });
  }

  async #metadataRead(): Promise<{ snapshot: CredentialMetadataSnapshot; available: boolean }> {
    try { return { snapshot: await this.#metadata.read(), available: true }; }
    catch { return { snapshot: emptyCredentialMetadata(), available: false }; }
  }

  async #metadataUpdateRequired(transform: (current: CredentialMetadataSnapshot) => CredentialMetadataSnapshot): Promise<CredentialMetadataSnapshot> {
    try { return await this.#metadata.update(transform); }
    catch (error) {
      if (finiteCredentialError(error).code === "VAULT_REVISION_CONFLICT") throw error;
      throw new CredentialHostError("METADATA_UNAVAILABLE");
    }
  }

  async #recordValidationPolicyDenial(slotId: AppVaultSlotId, credentialId: string): Promise<void> {
    await this.#metadataUpdateRequired((currentMetadata) => {
      const currentSlot = currentMetadata.slots[slotId];
      if (currentSlot?.credentialId !== credentialId) throw new CredentialHostError("VAULT_REVISION_CONFLICT");
      return replaceSlotMetadata(currentMetadata, slotId, currentSlot, activity(this.#random, this.#clock, "warn", `Validation wasn't allowed by policy for ${appVaultSlot(slotId).displayName} — nothing was sent.`));
    });
  }

  async #projection(snapshot: AppVaultSnapshot, metadataInput?: { snapshot: CredentialMetadataSnapshot; available: boolean }): Promise<CredentialSlotsResult> {
    let encryptionAvailable = false;
    try { encryptionAvailable = await this.#encryptionAvailable() === true; } catch { encryptionAvailable = false; }
    const metadata = metadataInput ?? await this.#metadataRead();
    const slots: CredentialSlotView[] = [];
    let metadataComplete = metadata.available;
    for (const descriptor of APP_VAULT_SLOTS) {
      const observedSummary = snapshot.slots.find((item) => item.slotId === descriptor.slotId);
      const summary: AppVaultSnapshot["slots"][number] = observedSummary ?? Object.freeze({ slotId: descriptor.slotId, state: "unrecoverable", revision: null, generation: null, createdAt: null, rotatedAt: null, revokedAt: null, lastValidation: null });
      const stored = observedSummary === undefined || summary.state === "absent" ? null : metadata.snapshot.slots[descriptor.slotId];
      if (summary.state !== "absent" && stored === null) metadataComplete = false;
      const credentialId = observedSummary === undefined ? null : stored?.credentialId ?? fallbackCredentialId(descriptor.slotId, summary);
      const token = recordToken(descriptor.slotId, summary);
      const applicableValidation = applicableStoredValidation(stored?.validation ?? null, token);
      const applicableLastAttempt = applicableStoredValidation(stored?.lastValidationAttempt ?? null, token);
      const receiptMismatch = async (slotId: AppVaultSlotId, validation: StoredValidation | null): Promise<boolean> => {
        if (validation?.receiptState !== "committed") return false;
        const candidate = this.#successReceiptCandidateBinding;
        if (
          slotId !== "anthropic" || this.#successReceiptStore === null || candidate === null ||
          validation.successReceiptId === null || validation.successReceiptSha256 === null
        ) return true;
        try {
          const projection = await this.#successReceiptStore.readCommitted(validation.successReceiptId, {
            receiptSha256: validation.successReceiptSha256,
            candidateHead: candidate.head,
            candidateTree: candidate.tree,
            candidateManifestAggregate: candidate.manifestAggregate,
          });
          return projection.receipt.slotId !== slotId ||
            projection.receipt.providerInstanceId !== appVaultSlot(slotId).providerInstanceId ||
            projection.receipt.candidateHead !== candidate.head ||
            projection.receipt.candidateTree !== candidate.tree ||
            projection.receipt.candidateManifestAggregate !== candidate.manifestAggregate;
        } catch { return true; }
      };
      const validationReceiptMismatch = await receiptMismatch(descriptor.slotId, applicableValidation);
      const lastReceiptMismatch = applicableLastAttempt === applicableValidation
        ? validationReceiptMismatch
        : await receiptMismatch(descriptor.slotId, applicableLastAttempt);
      const developerValidation = applicableLastAttempt ?? applicableValidation;
      const developerReceiptMismatch = applicableLastAttempt !== null
        ? lastReceiptMismatch
        : validationReceiptMismatch;
      const binding = this.#resolvers[descriptor.slotId].describeContainerBinding();
      const reference = appVaultReferenceForSlot(descriptor.slotId);
      const developer: CredentialDeveloperFacts = Object.freeze({
        referenceDisplay: secretRefDisplay(reference),
        referenceFingerprint: secretRefFingerprint(reference),
        containerBinding: binding.digest,
        backendKind: binding.backendKind,
        documentRevision: summary.revision,
        recordToken: token,
        operationPhase: this.#validating.has(credentialId ?? "") ? "validation-in-flight" : "idle",
        resultCode: developerReceiptMismatch
          ? "EVIDENCE_RECEIPT_MISMATCH"
          : developerValidation?.resultCode ?? null,
        policyDecisionFingerprint: developerValidation?.policyDecisionFingerprint ?? null,
        successReceiptState: developerReceiptMismatch
          ? "mismatch"
          : developerValidation?.receiptState ?? null,
        successReceiptId: developerValidation?.successReceiptId ?? null,
        successReceiptSha256: developerValidation?.successReceiptSha256 ?? null,
      });
      const facts = PROVIDER_FACTS[descriptor.slotId];
      slots.push(Object.freeze({
        slotId: descriptor.slotId,
        displayName: descriptor.displayName,
        productName: facts.productName,
        providerHost: facts.providerHost,
        credentialId,
        nickname: observedSummary === undefined ? null : stored?.nickname ?? (summary.state === "absent" ? null : `${descriptor.displayName} credential`),
        ownership: stored?.ownership ?? null,
        authorizedBy: stored?.ownership === "authorized" ? stored.authorizedBy : null,
        enabled: summary.state === "present" && (stored?.enabled ?? false),
        state: summary.state,
        revision: summary.revision,
        generation: summary.generation,
        createdAt: summary.createdAt,
        rotatedAt: summary.rotatedAt,
        revokedAt: summary.revokedAt,
        recordToken: token,
        validation: validationForView(applicableValidation, validationReceiptMismatch),
        lastValidationAttempt: validationForView(applicableLastAttempt, lastReceiptMismatch),
        developer,
      }));
    }
    const issue = encryptionAvailable ? issueCode(snapshot) : "ENCRYPTION_UNAVAILABLE";
    const vaultState = encryptionAvailable ? snapshot.vaultState : "encryption-unavailable";
    const hasAuthorizationGate = this.#validation.authorization !== undefined;
    let authorizationReadable = true;
    let validationAuthorization: CredentialValidationAuthorizationView | null = null;
    try { validationAuthorization = this.#validation.authorization?.() ?? null; }
    catch { authorizationReadable = false; validationAuthorization = null; }
    const validationEnabled = this.#validationEnabled &&
      authorizationReadable &&
      (!hasAuthorizationGate || validationAuthorization?.state === "available");
    return Object.freeze({
      schemaVersion: 1,
      requestId: "0".repeat(32),
      ok: true,
      kind: "slots",
      vaultState,
      revision: snapshot.revision,
      slots: Object.freeze(slots),
      recovery: issue === null
        ? null
        : !encryptionAvailable
          ? Object.freeze({ issueCode: issue, primaryDigest: null, backupDigest: null, actions: Object.freeze([]) })
          : snapshot.recovery === null ? null : Object.freeze({ issueCode: issue, primaryDigest: snapshot.recovery.primaryDigest, backupDigest: snapshot.recovery.backupDigest, actions: snapshot.recovery.actions }),
      activity: metadata.snapshot.activity,
      clipboardClearDefault: metadata.snapshot.clipboardClearDefault,
      validationEnabled,
      validationAuthorization,
      productionDisabled: true,
      metadataAvailable: metadataComplete,
    });
  }

  async describe(payload: DescribePayload): Promise<CredentialResponse> {
    let entered = false;
    try {
      this.#enter(); entered = true;
      this.#session.begin("describe");
      const projected = await this.#projection(await this.#manager.describeSnapshot());
      this.#session.described();
      return Object.freeze({ ...projected, requestId: requestId(payload) });
    } catch (error) { return refused(requestId(payload), error); }
    finally { if (entered) this.#leave(); }
  }

  async #authoritative(slotId: AppVaultSlotId, credentialId: string, revision: number, token: string, requireDocumentRevision = true): Promise<{ snapshot: AppVaultSnapshot; summary: AppVaultSnapshot["slots"][number]; metadata: CredentialMetadataSnapshot; slotMetadata: CredentialSlotMetadata }> {
    const snapshot = await this.#manager.describeSnapshot();
    const summary = snapshot.slots.find((item) => item.slotId === slotId);
    if (summary === undefined) throw new CredentialHostError(issueCode(snapshot) ?? "VAULT_CORRUPT");
    const metadataRead = await this.#metadataRead();
    if (!metadataRead.available) throw new CredentialHostError("METADATA_UNAVAILABLE");
    const slotMetadata = metadataRead.snapshot.slots[slotId];
    if (summary.state !== "absent" && slotMetadata === null) throw new CredentialHostError("METADATA_UNAVAILABLE");
    if (slotMetadata === null || slotMetadata.credentialId !== credentialId || (requireDocumentRevision && summary.revision !== revision) || recordToken(slotId, summary) !== token) throw new CredentialHostError("VAULT_REVISION_CONFLICT");
    return { snapshot, summary, metadata: metadataRead.snapshot, slotMetadata };
  }

  async #clipboardResult(requested: boolean): Promise<ClipboardResult> {
    if (!requested) return Object.freeze({ requested: false, outcome: "not-requested" });
    try { return Object.freeze({ requested: true, outcome: await this.#clipboard.clear() ? "cleared" : "failed" }); }
    catch { return Object.freeze({ requested: true, outcome: "failed" }); }
  }

  async #mutationResult(id: string, kind: CredentialMutationResult["kind"], slotId: AppVaultSlotId, clipboard: ClipboardResult, metadataWarning: boolean, snapshot: AppVaultSnapshot, metadata: CredentialMetadataSnapshot): Promise<CredentialMutationResult> {
    const projection = await this.#projection(snapshot, { snapshot: metadata, available: true });
    const slot = projection.slots.find((item) => item.slotId === slotId)!;
    return Object.freeze({ schemaVersion: 1, requestId: id, ok: true, kind, slot, clipboard, metadataWarning });
  }

  async save(payload: SavePayload): Promise<CredentialResponse> {
    let entered = false;
    let ownsWriteSession = false;
    let storageCommitted = false;
    let stagedCredentialId: string | null = null;
    try {
      this.#enter(); entered = true;
      this.#session.begin("save");
      ownsWriteSession = true;
      assertCredentialMetadataSeparatedFromSecret(payload.secret, payload.nickname, payload.authorizedBy);
      const before = await this.#manager.describeSnapshot();
      const beforeIssue = issueCode(before);
      if (beforeIssue !== null) throw new CredentialHostError(beforeIssue);
      const metadataRead = await this.#metadataRead();
      if (!metadataRead.available) throw new CredentialHostError("METADATA_UNAVAILABLE");
      const summary = before.slots.find((item) => item.slotId === payload.slotId);
      if (summary === undefined) throw new CredentialHostError("VAULT_CORRUPT");
      if (summary.state !== "absent") throw new CredentialHostError("SLOT_OCCUPIED");
      const stored: CredentialSlotMetadata = Object.freeze({ credentialId: `cred-${this.#random.hex(16)}`, nickname: payload.nickname, ownership: payload.ownership, authorizedBy: payload.authorizedBy, enabled: true, validation: null, lastValidationAttempt: null });
      let metadata = await this.#metadataUpdateRequired((current) => replaceSlotMetadata(current, payload.slotId, stored));
      stagedCredentialId = stored.credentialId;
      const changed = await this.#manager.create({ slotId: payload.slotId, secret: payload.secret, expectRevision: before.revision });
      storageCommitted = true;
      const after = snapshotWithSummary(before, changed);
      let metadataWarning = false;
      try {
        metadata = await this.#metadata.update((current) => {
          const currentSlot = current.slots[payload.slotId];
          if (currentSlot?.credentialId !== stored.credentialId) throw new CredentialHostError("VAULT_REVISION_CONFLICT");
          return replaceSlotMetadata(current, payload.slotId, currentSlot, activity(this.#random, this.#clock, "ok", `Saved ${appVaultSlot(payload.slotId).displayName} credential locally — not validated.`));
        });
      } catch (error) {
        if (finiteCredentialError(error).code === "VAULT_REVISION_CONFLICT") throw error;
        metadataWarning = true;
        try { metadata = await this.#metadata.read(); } catch { /* retain the already durable staged metadata */ }
      }
      const clipboard = await this.#clipboardResult(payload.clearClipboard);
      if (changed.state !== "present") throw new CredentialHostError("UNKNOWN_OUTCOME");
      const result = await this.#mutationResult(payload.requestId, "saved", payload.slotId, clipboard, metadataWarning, after, metadata);
      this.#session.committed();
      return result;
    } catch (error) {
      if (!storageCommitted && stagedCredentialId !== null) {
        try {
          const observed = await this.#manager.describeSnapshot();
          const observedSummary = observed.slots.find((item) => item.slotId === payload.slotId);
          if (observedSummary === undefined || observedSummary.state !== "absent") storageCommitted = true;
          else {
            try {
              await this.#metadata.update((current) => {
                if (current.slots[payload.slotId]?.credentialId !== stagedCredentialId) return current;
                return replaceSlotMetadata(current, payload.slotId, null);
              });
            } catch { /* a harmless orphan is replaced on the next authoritative absent-slot save */ }
          }
        } catch { storageCommitted = true; }
      }
      const finite = storageCommitted ? finiteCredentialError(new CredentialHostError("UNKNOWN_OUTCOME")) : finiteCredentialError(error);
      if (ownsWriteSession) this.#session.refused(finite.code);
      return refused(payload.requestId, finite);
    }
    finally { if (entered) this.#leave(); }
  }

  async rotate(payload: RotatePayload): Promise<CredentialResponse> {
    let entered = false;
    let ownsWriteSession = false;
    let storageCommitted = false;
    try {
      this.#enter(); entered = true;
      if (this.#validating.has(payload.credentialId)) throw new CredentialHostError("ILLEGAL_TRANSITION");
      this.#session.begin("rotate");
      ownsWriteSession = true;
      const bound = await this.#authoritative(payload.slotId, payload.credentialId, payload.recordRevision, payload.recordToken);
      if (bound.summary.state === "absent") throw new CredentialHostError("SLOT_ABSENT");
      const reentry = payload.entryMode === "reenter";
      if (reentry === (bound.summary.state === "present")) throw new CredentialHostError("ILLEGAL_TRANSITION");
      const nextNickname = reentry ? payload.nickname : bound.slotMetadata.nickname;
      const nextOwnership = reentry ? payload.ownership : bound.slotMetadata.ownership;
      const nextAuthorizedBy = reentry ? payload.authorizedBy : bound.slotMetadata.authorizedBy;
      assertCredentialMetadataSeparatedFromSecret(payload.secret, nextNickname, nextAuthorizedBy);
      const changed = await this.#manager.rotate({ slotId: payload.slotId, secret: payload.secret, expectRevision: bound.snapshot.revision! });
      storageCommitted = true;
      const after = snapshotWithSummary(bound.snapshot, changed);
      let metadata = bound.metadata;
      let metadataWarning = false;
      const transformMetadata = (current: CredentialMetadataSnapshot): CredentialMetadataSnapshot => {
        const currentSlot = current.slots[payload.slotId];
        if (currentSlot?.credentialId !== payload.credentialId) throw new CredentialHostError("VAULT_REVISION_CONFLICT");
        const stored = Object.freeze({ ...currentSlot, nickname: nextNickname, ownership: nextOwnership, authorizedBy: nextAuthorizedBy, enabled: reentry ? true : currentSlot.enabled, validation: null, lastValidationAttempt: null });
        const action = reentry ? "Re-entered" : "Rotated";
        return replaceSlotMetadata(current, payload.slotId, stored, activity(this.#random, this.#clock, "ok", `${action} ${appVaultSlot(payload.slotId).displayName} credential locally — not validated.`));
      };
      if (reentry) {
        // Re-entry is the only v1 path that may correct presentation metadata.
        // Once secure storage commits, failure to commit those requested labels
        // is an unknown overall outcome rather than a false successful rename.
        metadata = await this.#metadataUpdateRequired(transformMetadata);
      } else {
        try { metadata = await this.#metadata.update(transformMetadata); }
        catch (error) {
          if (finiteCredentialError(error).code === "VAULT_REVISION_CONFLICT") throw error;
          metadataWarning = true;
          try { metadata = await this.#metadata.read(); } catch { metadata = bound.metadata; }
        }
      }
      const clipboard = await this.#clipboardResult(payload.clearClipboard);
      const result = await this.#mutationResult(payload.requestId, "rotated", payload.slotId, clipboard, metadataWarning, after, metadata);
      this.#session.committed();
      return result;
    } catch (error) {
      const finite = storageCommitted ? finiteCredentialError(new CredentialHostError("UNKNOWN_OUTCOME")) : finiteCredentialError(error);
      if (ownsWriteSession) this.#session.refused(finite.code);
      return refused(payload.requestId, finite);
    }
    finally { if (entered) this.#leave(); }
  }

  async setEnabled(payload: SetEnabledPayload): Promise<CredentialResponse> {
    let entered = false;
    let ownsWriteSession = false;
    let storageCommitted = false;
    try {
      this.#enter(); entered = true;
      if (this.#validating.has(payload.credentialId)) throw new CredentialHostError("ILLEGAL_TRANSITION");
      this.#session.begin("set-enabled");
      ownsWriteSession = true;
      const bound = await this.#authoritative(payload.slotId, payload.credentialId, payload.recordRevision, payload.recordToken);
      if (bound.summary.state !== "present") throw new CredentialHostError("SLOT_ABSENT");
      const metadata = await this.#metadataUpdateRequired((current) => {
        const currentSlot = current.slots[payload.slotId];
        if (currentSlot?.credentialId !== payload.credentialId) throw new CredentialHostError("VAULT_REVISION_CONFLICT");
        const stored = Object.freeze({ ...currentSlot, enabled: payload.enabled });
        return replaceSlotMetadata(current, payload.slotId, stored, activity(this.#random, this.#clock, payload.enabled ? "ok" : "warn", `${payload.enabled ? "Enabled" : "Disabled"} ${appVaultSlot(payload.slotId).displayName} credential for future use. Production tasks remain disabled.`));
      });
      storageCommitted = true;
      const result = await this.#mutationResult(payload.requestId, payload.enabled ? "enabled" : "disabled", payload.slotId, Object.freeze({ requested: false, outcome: "not-requested" }), false, bound.snapshot, metadata);
      this.#session.committed();
      return result;
    } catch (error) {
      const finite = storageCommitted ? finiteCredentialError(new CredentialHostError("UNKNOWN_OUTCOME")) : finiteCredentialError(error);
      if (ownsWriteSession) this.#session.refused(finite.code);
      return refused(payload.requestId, finite);
    }
    finally { if (entered) this.#leave(); }
  }

  async remove(payload: RemovePayload): Promise<CredentialResponse> {
    let entered = false;
    let ownsWriteSession = false;
    let storageCommitted = false;
    try {
      this.#enter(); entered = true;
      if (this.#validating.has(payload.credentialId)) throw new CredentialHostError("ILLEGAL_TRANSITION");
      this.#session.begin("remove");
      ownsWriteSession = true;
      const bound = await this.#authoritative(payload.slotId, payload.credentialId, payload.recordRevision, payload.recordToken);
      if (bound.summary.state === "absent" || bound.summary.state === "revoked") throw new CredentialHostError("SLOT_ABSENT");
      const changed = await this.#manager.remove({ slotId: payload.slotId, expectRevision: bound.snapshot.revision! });
      storageCommitted = true;
      const after = snapshotWithSummary(bound.snapshot, changed);
      let metadata = bound.metadata;
      let metadataWarning = false;
      try {
        metadata = await this.#metadata.update((current) => {
          const currentSlot = current.slots[payload.slotId];
          if (currentSlot?.credentialId !== payload.credentialId) throw new CredentialHostError("VAULT_REVISION_CONFLICT");
          const stored = Object.freeze({ ...currentSlot, enabled: false, validation: null, lastValidationAttempt: null });
          return replaceSlotMetadata(current, payload.slotId, stored, activity(this.#random, this.#clock, "warn", `Removed ${appVaultSlot(payload.slotId).displayName} encrypted credential from this PC — not revoked at provider.`));
        });
      } catch (error) {
        if (finiteCredentialError(error).code === "VAULT_REVISION_CONFLICT") throw error;
        metadataWarning = true;
        try { metadata = await this.#metadata.read(); } catch { metadata = bound.metadata; }
      }
      const result = await this.#mutationResult(payload.requestId, "removed", payload.slotId, Object.freeze({ requested: false, outcome: "not-requested" }), metadataWarning, after, metadata);
      this.#session.committed();
      return result;
    } catch (error) {
      const finite = storageCommitted ? finiteCredentialError(new CredentialHostError("UNKNOWN_OUTCOME")) : finiteCredentialError(error);
      if (ownsWriteSession) this.#session.refused(finite.code);
      return refused(payload.requestId, finite);
    }
    finally { if (entered) this.#leave(); }
  }

  async validate(payload: ValidatePayload): Promise<CredentialResponse> {
    let entered = false;
    let ownsValidationReservation = false;
    let releaseHostReservation = (): void => undefined;
    let validationController: AbortController | null = null;
    let validationTimer: NodeJS.Timeout | undefined;
    try {
      this.#enter(); entered = true;
      this.#session.begin("validate");
      if (!this.#validationEnabled) throw new CredentialHostError("VALIDATION_DISABLED");
      const authorization = this.#validation.authorization?.() ?? null;
      if (authorization !== null && authorization.state !== "available") {
        throw new CredentialHostError(authorizationStateError(authorization.state));
      }
      if (this.#validating.size > 0) throw new CredentialHostError("ILLEGAL_TRANSITION");
      this.#validating.add(payload.credentialId);
      ownsValidationReservation = true;
      const operationRandom = this.#random.hex(16);
      if (!/^[a-f0-9]{32}$/u.test(operationRandom)) throw new CredentialHostError("REFUSED");
      const operationId = `credential-validate.${operationRandom}`;
      const validationStartedAt = requiredIsoTimestamp(this.#clock);
      const primaryActivityId = requiredActivityId(this.#random);
      const discardActivityId = requiredActivityId(this.#random);
      const trace = Object.freeze({ traceId: `${operationId}.trace`, runId: null, taskId: null, taskRunId: null });
      const abort = new AbortController();
      validationController = abort;
      this.#validationControllers.add(abort);
      const absoluteDeadlineAt = Date.now() + this.#validationTimeoutMs;
      let expired = false;
      let deadlineExpired = false;
      let workSettled = true;
      const expire = (): void => { expired = true; deadlineExpired = true; abort.abort(); };
      const unreachable = Object.freeze({ outcome: "unreachable" as const, resultCode: "PROVIDER_UNREACHABLE" as const });
      const timedOut = new Promise<CredentialValidationResult>((resolve) => {
        validationTimer = setTimeout(() => { expire(); resolve(unreachable); }, this.#validationTimeoutMs);
      });
      const deadline = new Date(Date.parse(validationStartedAt) + this.#validationTimeoutMs).toISOString();
      const authoritativeOperation = this.#authoritative(
        payload.slotId,
        payload.credentialId,
        payload.recordRevision,
        payload.recordToken,
        false,
      );
      let stopAuthoritative!: () => void;
      const authoritativeStopped = new Promise<void>((resolve) => {
        stopAuthoritative = (): void => resolve();
        if (abort.signal.aborted) stopAuthoritative();
        else abort.signal.addEventListener("abort", stopAuthoritative, { once: true });
      });
      let authoritativeResult:
        | Readonly<{ kind: "bound"; bound: Awaited<typeof authoritativeOperation> }>
        | Readonly<{ kind: "stopped" }>;
      try {
        authoritativeResult = await Promise.race([
          authoritativeOperation.then((bound) => Object.freeze({ kind: "bound" as const, bound })),
          authoritativeStopped.then(() => Object.freeze({ kind: "stopped" as const })),
        ]);
      } finally {
        abort.signal.removeEventListener("abort", stopAuthoritative);
      }
      if (authoritativeResult.kind === "stopped") {
        const authoritativeDrain = Promise.allSettled([authoritativeOperation])
          .then(() => { this.#validating.delete(payload.credentialId); });
        ownsValidationReservation = false;
        this.#trackBackground(authoritativeDrain);
        throw new CredentialHostError(this.#closed ? "APP_NOT_READY" : "VALIDATION_CANCELLED");
      }
      const bound = authoritativeResult.bound;
      if (abort.signal.aborted || Date.now() >= absoluteDeadlineAt || this.#closed) {
        expire();
        throw new CredentialHostError(this.#closed ? "APP_NOT_READY" : "VALIDATION_CANCELLED");
      }
      if (bound.summary.state !== "present" || !bound.slotMetadata.enabled) throw new CredentialHostError("SLOT_ABSENT");
      if (bound.summary.revision === null) throw new CredentialHostError("REFUSED");
      const authoritativeRecordRevision = bound.summary.revision;
      let result: CredentialValidationResult;
      let completedResult: CredentialValidationResult | null = null;
      let effectSettledBeforeDeadline = false;
      let policyFingerprint = "";
      let providerDispatched = false;
      let authorizationAttempt: unknown;
      {
        const reference = appVaultReferenceForSlot(payload.slotId);
        const provider = validationProvider(payload.slotId);
        const scope = Object.freeze({ projectId: null, taskId: null, providerInstanceId: appVaultSlot(payload.slotId).providerInstanceId, workspaceId: null, operationId, traceId: trace.traceId });
        const commonPolicy = Object.freeze({ schemaVersion: 1 as const, classification: "internal" as const, handlingPolicy: VALIDATION_HANDLING_POLICY, risk: "low" as const, locality: "cloud" as const, provider, model: null, scope, requestedCapabilities: Object.freeze(["network-access"] as const), transformationsApplied: Object.freeze([]), approvalEvidence: Object.freeze([]), retentionDays: null, trace, requesterKind: "user" as const });
        const disclosureRequest = parsePolicyRequest({ ...commonPolicy, action: "provider-disclosure", subjectDigest: validationDisclosureSubject(payload.slotId) });
        let disclosureDecision: PolicyDecision;
        try { disclosureDecision = this.#resolvers[payload.slotId].evaluatePolicy(disclosureRequest); }
        catch { throw new CredentialHostError("REFUSED"); }
        if (disclosureDecision.outcome !== "allowed") {
          await this.#recordValidationPolicyDenial(payload.slotId, payload.credentialId);
          throw new CredentialHostError("VALIDATION_POLICY_DENIED");
        }
        if (!/^[a-f0-9]{64}$/u.test(disclosureDecision.fingerprint)) throw new CredentialHostError("REFUSED");
        if (Date.now() >= absoluteDeadlineAt) {
          expire();
          result = unreachable;
        } else {
          if (this.#validation.prepare !== undefined) {
            authorizationAttempt = await this.#validation.prepare({
              slotId: payload.slotId,
              providerInstanceId: scope.providerInstanceId,
              secretRefFingerprint: secretRefFingerprint(reference),
              signal: abort.signal,
            });
          }
          if (abort.signal.aborted || Date.now() >= absoluteDeadlineAt) {
            expire();
            result = unreachable;
          } else {
          const context = parseSecretAccessContext({ operationId, providerInstanceId: scope.providerInstanceId, purpose: "provider-authentication", requestedLifetimeMs: this.#validationTimeoutMs, accessForm: "text", classification: "internal", projectId: null, taskId: null, approvalEvidenceRefs: [], disclosureDecisionFingerprint: disclosureDecision.fingerprint, locality: "cloud", trace, deadline, signal: abort.signal });
          const policyRequest = parsePolicyRequest({ ...commonPolicy, action: "secret-access", subjectDigest: secretRefFingerprint(reference) });
          try {
            const resolverOperation = this.#resolvers[payload.slotId].resolve({ ref: reference, context, policyRequest }, async (secret, fingerprint) => {
              if (abort.signal.aborted || Date.now() >= absoluteDeadlineAt) { expire(); return unreachable; }
              policyFingerprint = fingerprint;
              const dispatched = Promise.resolve().then(() => {
                if (abort.signal.aborted || Date.now() >= absoluteDeadlineAt) { expire(); return unreachable; }
                if (this.#validation.preciseDispatchObservation !== true) providerDispatched = true;
                return this.#validation.validate({
                  slotId: payload.slotId,
                  credentialId: payload.credentialId,
                  recordRevision: authoritativeRecordRevision,
                  recordToken: payload.recordToken,
                  secret,
                  signal: abort.signal,
                  policyDecisionFingerprint: fingerprint,
                  authorizationAttempt,
                  observeProviderDispatch: () => { providerDispatched = true; },
                  operationId,
                  validationStartedAt,
                });
              }).then(
                (value) => value,
                () => unreachable,
              );
              const effectValue = await dispatched;
              if (this.#validation.settleAfterSecretRelease === undefined) {
                completedResult = finiteValidationResult(
                  effectValue,
                  this.#validation.requiresSuccessReceipt === true,
                );
              }
              return effectValue;
            });
            workSettled = false;
            const hostReservation = new Promise<void>((resolve) => { releaseHostReservation = resolve; });
            const reservationDrain = Promise.allSettled([resolverOperation, hostReservation]).then(() => { this.#validating.delete(payload.credentialId); });
            ownsValidationReservation = false;
            this.#trackBackground(reservationDrain);
            const resolved = await Promise.race([
              resolverOperation.then((resolution) => Object.freeze({ kind: "settled" as const, resolution })),
              timedOut.then((value) => Object.freeze({ kind: "deadline" as const, resolution: Object.freeze({ value, decisionFingerprint: policyFingerprint }) })),
            ]);
            workSettled = resolved.kind === "settled";
            policyFingerprint = resolved.resolution.decisionFingerprint;
            if (resolved.kind === "settled" && (expired || Date.now() >= absoluteDeadlineAt)) {
              expire();
              result = unreachable;
            } else if (resolved.kind === "settled") {
              effectSettledBeforeDeadline = true;
              if (validationTimer !== undefined) {
                clearTimeout(validationTimer);
                validationTimer = undefined;
              }
              let settledValue: unknown = resolved.resolution.value;
              if (this.#validation.settleAfterSecretRelease !== undefined) {
                try {
                  settledValue = await this.#validation.settleAfterSecretRelease(settledValue);
                } catch {
                  settledValue = this.#validation.requiresSuccessReceipt === true
                    ? EVIDENCE_INCOMPLETE_VALIDATION_RESULT
                    : AMBIGUOUS_VALIDATION_RESULT;
                }
              }
              completedResult = finiteValidationResult(
                settledValue,
                this.#validation.requiresSuccessReceipt === true,
              );
              result = completedResult;
            } else {
              result = resolved.resolution.value;
            }
          } catch (error) {
            workSettled = true;
            if (providerDispatched) {
              result = completedResult ?? unreachable;
            } else if (error instanceof SecretBrokerError && error.code === "ACCESS_DENIED") {
              await this.#recordValidationPolicyDenial(payload.slotId, payload.credentialId);
              throw new CredentialHostError("VALIDATION_POLICY_DENIED");
            } else {
              if (!expired && Date.now() < absoluteDeadlineAt) throw error;
              expire();
              result = unreachable;
            }
          }
          }
        }
      }

      const recordingAllowed = (): boolean => {
        if (this.#closed) return false;
        if (effectSettledBeforeDeadline && !abort.signal.aborted) return true;
        if (!abort.signal.aborted && Date.now() < absoluteDeadlineAt) return true;
        return !validationDefinitive(result.outcome);
      };
      const refuseLateResult = (): void => {
        if (!recordingAllowed()) {
          expire();
          result = unreachable;
        }
      };
      refuseLateResult();

      type Applicability = CredentialValidatedResult["applicability"];
      type ResultRecording = CredentialValidatedResult["resultRecording"];
      type ActivityRecording = CredentialValidatedResult["activityRecording"];
      const observeApplicability = async (): Promise<Applicability> => {
        try {
          const snapshot = await this.#manager.describeSnapshot();
          const summary = snapshot.slots.find((item) => item.slotId === payload.slotId)!;
          return recordToken(payload.slotId, summary) === payload.recordToken ? "current" : "discarded";
        } catch { return "unknown"; }
      };

      let applicability = await observeApplicability();
      refuseLateResult();
      const checkedAt = bestEffortIsoTimestamp(this.#clock, validationStartedAt);
      const hasPolicyFingerprint = /^[a-f0-9]{64}$/u.test(policyFingerprint);
      let resultRecording: ResultRecording = "not-recorded";
      let activityRecording: ActivityRecording = "unknown";
      const attemptsResultRecording = applicability === "current" && providerDispatched && hasPolicyFingerprint;
      if (attemptsResultRecording) {
        let attemptedResultRecording: ResultRecording = "not-recorded";
        try {
          await this.#metadata.update((currentMetadata) => {
            const currentSlot = currentMetadata.slots[payload.slotId];
            if (currentSlot?.credentialId !== payload.credentialId) throw new CredentialHostError("VAULT_REVISION_CONFLICT");
            const definitive = validationDefinitive(result.outcome);
            const receiptState: StoredValidation["receiptState"] = result.outcome === "valid"
              ? result.successReceiptId !== undefined && result.successReceiptSha256 !== undefined ? "committed" : "historical-missing"
              : result.outcome === "evidence-incomplete" ? "write-failed" : "not-applicable";
            const nextValidation: StoredValidation = Object.freeze({
              outcome: result.outcome,
              checkedAt,
              recordRevision: authoritativeRecordRevision,
              recordToken: payload.recordToken,
              definitive,
              resultCode: result.resultCode,
              policyDecisionFingerprint: policyFingerprint,
              receiptState,
              successReceiptId: result.successReceiptId ?? null,
              successReceiptSha256: result.successReceiptSha256 ?? null,
            });
            if (!definitive && currentSlot!.validation?.definitive === true) {
              attemptedResultRecording = "prior-definitive-preserved";
              const stored = Object.freeze({ ...currentSlot!, lastValidationAttempt: nextValidation });
              return replaceSlotMetadata(currentMetadata, payload.slotId, stored);
            } else {
              attemptedResultRecording = "recorded";
              const stored = Object.freeze({ ...currentSlot!, validation: nextValidation, lastValidationAttempt: nextValidation });
              return replaceSlotMetadata(currentMetadata, payload.slotId, stored);
            }
          }, recordingAllowed);
          resultRecording = attemptedResultRecording;
        } catch {
          resultRecording = "unknown";
          refuseLateResult();
        }
      }

      if (applicability === "current") applicability = await observeApplicability();
      else if (applicability === "unknown" && await observeApplicability() === "discarded") applicability = "discarded";

      const copy = validationActivityCopy(result.outcome);
      const resultRecordComplete = (["recorded", "prior-definitive-preserved"] as readonly string[]).includes(resultRecording);
      const activityText = deadlineExpired
        ? workSettled
          ? providerDispatched
            ? `Validation deadline expired for ${appVaultSlot(payload.slotId).displayName} after one provider dispatch attempt settled beyond the absolute limit. Its late outcome was ignored; no retry.`
            : `Validation deadline expired for ${appVaultSlot(payload.slotId).displayName} before provider dispatch. No provider request was sent or may start late.`
          : providerDispatched
            ? `Validation deadline expired for ${appVaultSlot(payload.slotId).displayName} after one provider dispatch attempt. Cancellation was requested; no retry; any late outcome is ignored.`
            : `Validation deadline expired for ${appVaultSlot(payload.slotId).displayName} while credential access was closing. No provider request was sent or may start late.`
        : applicability === "discarded"
        ? `Discarded the ${appVaultSlot(payload.slotId).displayName} validation result because the checked credential version changed before it could be applied.`
        : applicability === "unknown"
          ? providerDispatched
            ? `Validation finished for the checked ${appVaultSlot(payload.slotId).displayName} credential version, but current-version attribution is unconfirmed. One dispatch attempt; no retry.`
            : `Validation ended for ${appVaultSlot(payload.slotId).displayName} before provider dispatch; current-version attribution is unconfirmed. No provider request was sent; nothing was retried.`
          : providerDispatched && !resultRecordComplete
            ? `Validation finished for ${appVaultSlot(payload.slotId).displayName}, but local result recording is unconfirmed. One dispatch attempt; no retry.`
            : providerDispatched
              ? `Validation finished for the checked ${appVaultSlot(payload.slotId).displayName} credential version: provider ${copy.sentence}. One dispatch attempt; no retry.`
              : `Validation ended for ${appVaultSlot(payload.slotId).displayName} before provider dispatch. No provider request was sent; nothing was retried.`;
      const primaryActivity = activityFromReservedFacts(primaryActivityId, checkedAt, workSettled && applicability === "current" && providerDispatched && resultRecordComplete ? copy.tone : "warn", activityText);
      try {
        await this.#metadata.update((currentMetadata) => {
          const currentSlot = currentMetadata.slots[payload.slotId];
          if (applicability === "current" && currentSlot?.credentialId !== payload.credentialId) throw new CredentialHostError("VAULT_REVISION_CONFLICT");
          const stored = applicability === "discarded" ? clearStoredValidationForToken(currentSlot, payload.recordToken) : currentSlot;
          return replaceSlotMetadata(currentMetadata, payload.slotId, stored, primaryActivity);
        }, recordingAllowed);
        activityRecording = "recorded";
        if (applicability === "discarded") resultRecording = "not-recorded";
      } catch { activityRecording = "unknown"; }

      if (applicability === "current") {
        const settledApplicability = await observeApplicability();
        if (settledApplicability === "unknown") applicability = "unknown";
        if (settledApplicability === "discarded") {
          applicability = "discarded";
          const discardActivity = activityFromReservedFacts(discardActivityId, bestEffortIsoTimestamp(this.#clock, checkedAt), "warn", `Discarded the ${appVaultSlot(payload.slotId).displayName} validation result because the checked credential version changed before it could be applied.`);
          try {
            await this.#metadata.update((currentMetadata) => {
              const currentSlot = currentMetadata.slots[payload.slotId];
              const stored = clearStoredValidationForToken(currentSlot, payload.recordToken);
              const withoutSupersededActivity: CredentialMetadataSnapshot = Object.freeze({ ...currentMetadata, activity: Object.freeze(currentMetadata.activity.filter((item) => item.id !== primaryActivity.id)) });
              return replaceSlotMetadata(withoutSupersededActivity, payload.slotId, stored, discardActivity);
            }, recordingAllowed);
            resultRecording = "not-recorded";
            activityRecording = "recorded";
          } catch {
            if (attemptsResultRecording) resultRecording = "unknown";
            activityRecording = "unknown";
          }
        }
      }

      const response: CredentialValidatedResult = Object.freeze({ schemaVersion: 1, requestId: payload.requestId, ok: true, kind: "validated", slotId: payload.slotId, credentialId: payload.credentialId, recordRevision: authoritativeRecordRevision, recordToken: payload.recordToken, outcome: result.outcome, checkedAt, definitive: validationDefinitive(result.outcome), providerDispatched, deadlineExpired, workSettled, applicability, resultRecording, activityRecording, discarded: applicability === "discarded" });
      return response;
    } catch (error) { return refused(payload.requestId, error); }
    finally {
      if (validationTimer !== undefined) clearTimeout(validationTimer);
      validationController?.abort();
      if (validationController !== null) this.#validationControllers.delete(validationController);
      releaseHostReservation();
      if (ownsValidationReservation) this.#validating.delete(payload.credentialId);
      if (entered) this.#leave();
    }
  }

  cancel(payload: CancelPayload): CredentialResponse {
    try {
      if (this.#closed) throw new CredentialHostError("APP_NOT_READY");
      this.#session.begin("cancel");
      return Object.freeze({ schemaVersion: 1, requestId: payload.requestId, ok: true, kind: "cancelled" });
    }
    catch (error) { return refused(payload.requestId, error); }
  }

  async close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    this.#session.destroy();
    for (const controller of this.#validationControllers) controller.abort();
    this.#closePromise = (async () => {
      await this.#awaitIdle();
      const closeOperations: Array<() => Promise<void>> = [
        () => this.#manager.close(),
        ...APP_VAULT_SLOTS.map((slot) => () => this.#resolvers[slot.slotId].close()),
      ];
      const settled = await Promise.allSettled(closeOperations.map(async (close) => await close()));
      if (settled.some((result) => result.status === "rejected")) throw new CredentialHostError("REFUSED");
    })();
    return this.#closePromise;
  }
}

export function createCredentialResolverBinding(broker: AppVaultSecretBroker, policy: PolicyBroker): CredentialResolverBinding {
  const evaluate = policy.evaluate;
  if (typeof evaluate !== "function") throw new CredentialHostError("REFUSED");
  const describeContainerBinding = broker.describeContainerBinding;
  const close = broker.close;
  if (typeof describeContainerBinding !== "function" || typeof close !== "function") throw new CredentialHostError("REFUSED");
  const resolver: PolicyAwareSecretResolver = createPolicyAwareSecretResolver({ policy, broker });
  return Object.freeze({
    describeContainerBinding(): AppVaultContainerBinding { return Reflect.apply(describeContainerBinding, broker, []) as AppVaultContainerBinding; },
    async resolve<T>(input: { readonly ref: SecretRef; readonly context: SecretAccessContext; readonly policyRequest: PolicyRequest }, callback: (secret: SecretMaterial, decisionFingerprint: string) => T | Promise<T>): Promise<{ readonly value: T; readonly decisionFingerprint: string }> {
      return await resolver.withSecret(input, callback);
    },
    evaluatePolicy(request: PolicyRequest): PolicyDecision { return Reflect.apply(evaluate, policy, [request]) as PolicyDecision; },
    async close(): Promise<void> { await Reflect.apply(close, broker, []); },
  });
}
