import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, protocol, session } from "electron";
import type { CredentialSlotView, CredentialSlotsResult, CredentialValidationOutcome } from "@ai-dev-os/credential-ui";
import {
  ANTHROPIC_VALIDATION_AUTHORIZATION_RELATIVE_PATH,
  ANTHROPIC_VALIDATION_MARKER_NAMESPACE_PREFIX,
  STAGE_18E_I_MANIFEST_PATH,
  createAnthropicValidationAuthorizationGate,
  createAnthropicValidationAuthorizationPacket,
  serializeAnthropicValidationAuthorizationPacket,
  type ConsumedAnthropicValidationAuthorization,
  type Stage18eICandidateBinding,
} from "../main/anthropic-validation-authorization.js";
import { createDeterministicCredentialValidationPort, type CredentialValidationPort } from "../main/validation.js";
import { CREDENTIAL_ENTRY_URL, CREDENTIAL_PROTOCOL, CREDENTIAL_SESSION_PARTITION } from "../main/constants.js";
import { createHardenedCredentialWindow, hardenCredentialSession, installGlobalWebContentsGuard, installMinimalEditMenu, loadCredentialWindow } from "../main/hardening.js";
import { installCredentialIpc } from "../main/ipc.js";
import { installCredentialProtocol, resolveCredentialProtocolRequest } from "../main/protocol.js";
import { createTestCredentialHost, type TestCredentialHostControl } from "./test-host.js";

const SYNTHETIC_CANARY = "SYNTHETIC_CREDENTIAL_STAGE18E";
const SYNTHETIC_REPLACEMENT = "SYNTHETIC_REPLACEMENT_STAGE18E";
const SYNTHETIC_ACTIVITY_SHAPE = ["sk", "ant", "api03", "SYNTHETIC_ACTIVITY_CANARY"].join("-");
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SYNTHETIC_CANDIDATE_BINDING: Stage18eICandidateBinding = Object.freeze({
  schemaVersion: 1,
  status: "published",
  head: "1".repeat(40),
  tree: "2".repeat(40),
  sourceCommit: "3".repeat(40),
  sourceTree: "4".repeat(40),
  manifestPath: STAGE_18E_I_MANIFEST_PATH,
  manifestSha256: "5".repeat(64),
  manifestAggregate: "6".repeat(64),
});

function argument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  if (value === undefined || value.length === 0) throw new Error(`SMOKE_ARGUMENT_MISSING_${name.toUpperCase().replaceAll("-", "_")}`);
  return value;
}

function boundedRoot(value: string): string {
  const root = resolve(value);
  const temporary = resolve(tmpdir());
  const rel = relative(temporary, root);
  if (rel === "" || rel.startsWith("..") || resolve(temporary, rel) !== root) throw new Error("SMOKE_ROOT_OUTSIDE_TEMP");
  return root;
}

const smokeRoot = boundedRoot(argument("smoke-root"));
const reportPath = resolve(argument("smoke-report"));
const previewPath = process.argv.find((item) => item.startsWith("--smoke-preview="))?.slice("--smoke-preview=".length) ?? null;
const smokeMode = argument("smoke-mode");
if (!new Set(["default", "reduced", "forced"]).has(smokeMode)) throw new Error("SMOKE_MODE_INVALID");
if (smokeMode === "reduced") app.commandLine.appendSwitch("force-prefers-reduced-motion", "reduce");
if (smokeMode === "forced") app.commandLine.appendSwitch("force-high-contrast");

app.setName("AI Development OS Credential Setup Synthetic Smoke");
installGlobalWebContentsGuard(app);
app.on("window-all-closed", () => { /* The synthetic controller opens several bounded surfaces in sequence. */ });
protocol.registerSchemesAsPrivileged([{ scheme: CREDENTIAL_PROTOCOL, privileges: { standard: true, secure: true } }]);

type SurfaceGateName = "describe" | "save" | "validate" | "remove";
type ViewScenario = "metadata-unavailable" | "backup-only" | "corrupt" | "identity-mismatch" | "backend-mismatch" | "schema-ahead" | "tones" | "multi-anthropic" | "slot-unrecoverable" | "slot-absent";
type MultiCredentialScenario = "mixed" | "all-disabled" | "saved-only" | "inconclusive" | "stale" | "invalid" | "unreadable" | "metadata-unavailable" | "recovery";

interface SurfaceOptions {
  readonly seedCredential?: boolean;
  readonly seedState?: "present" | "revoked" | "unrecoverable";
  readonly seedNickname?: string;
  readonly seedDisabled?: boolean;
  readonly seedValidationOutcomes?: readonly CredentialValidationOutcome[];
  readonly validationOutcome?: CredentialValidationOutcome;
  readonly validationRefusalOnce?: "REFUSED" | "SCHEMA_REJECTED";
  readonly validationCheckedAt?: string;
  readonly validationEnabled?: boolean;
  readonly encryptionAvailable?: boolean;
  readonly viewScenario?: ViewScenario;
  readonly viewScenarioAfterDescribe?: number;
  readonly multiCredentialScenario?: MultiCredentialScenario;
  readonly rotateConflictOnce?: boolean;
  readonly rotateRefusalOnce?: "DECRYPT_FAILED" | "SLOT_ABSENT";
  readonly clipboardSucceeds?: boolean;
  readonly gateInitialDescribe?: boolean;
  readonly describeRefusalAfter?: number;
}

interface Surface {
  readonly window: BrowserWindow;
  readonly control: TestCredentialHostControl;
  readonly validation: ReturnType<typeof createDeterministicCredentialValidationPort>;
  readonly disposeIpc: () => void;
  readonly consoleCanary: () => boolean;
  readonly rendererGone: () => boolean;
  readonly rotateCalls: () => number;
  readonly describeCalls: () => number;
  armGate(name: SurfaceGateName): void;
  waitForGate(name: SurfaceGateName): Promise<void>;
  releaseGate(name: SurfaceGateName): void;
}

const report: Record<string, unknown> = {
  schemaVersion: 1,
  mode: smokeMode,
  electronVersion: process.versions["electron"] ?? null,
  nodeVersion: process.versions.node,
  rootIsTemporary: true,
  appDataPath: null,
  userDataPath: null,
  assertions: Object.create(null) as Record<string, unknown>,
  failures: [] as string[],
};
const assertions = report["assertions"] as Record<string, unknown>;
const failures = report["failures"] as string[];

function record(name: string, passed: boolean, detail: unknown = null): void {
  assertions[name] = Object.freeze({ passed, detail });
  if (!passed) failures.push(name);
}

function safeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "SMOKE_UNKNOWN_FAILURE";
  return message.replaceAll(SYNTHETIC_CANARY, "[synthetic-canary-redacted]").replaceAll(SYNTHETIC_REPLACEMENT, "[synthetic-replacement-redacted]").slice(0, 240);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function mark(stage: string): Promise<void> {
  report["stage"] = stage;
  await writeFile(resolve(smokeRoot, "stage.txt"), stage, "utf8");
}

async function page<T>(window: BrowserWindow, source: string): Promise<T> {
  return await window.webContents.executeJavaScript(source, true) as T;
}

async function waitFor(window: BrowserWindow, predicate: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (window.isDestroyed()) throw new Error("SMOKE_WINDOW_DESTROYED_EARLY");
    if (await page<boolean>(window, `Boolean(${predicate})`)) return;
    await delay(25);
  }
  throw new Error("SMOKE_RENDER_TIMEOUT");
}

async function press(window: BrowserWindow, keyCode: string, modifiers?: Array<"alt" | "control" | "meta" | "shift">, allowExpectedTargetDestruction = false): Promise<void> {
  const keys: Readonly<Record<string, Readonly<{ key: string; code: string; virtualKey: number; text?: string }>>> = Object.freeze({
    Tab: Object.freeze({ key: "Tab", code: "Tab", virtualKey: 9 }),
    Enter: Object.freeze({ key: "Enter", code: "Enter", virtualKey: 13, text: "\r" }),
    Space: Object.freeze({ key: " ", code: "Space", virtualKey: 32, text: " " }),
    Escape: Object.freeze({ key: "Escape", code: "Escape", virtualKey: 27 }),
    Left: Object.freeze({ key: "ArrowLeft", code: "ArrowLeft", virtualKey: 37 }),
    R: Object.freeze({ key: "r", code: "KeyR", virtualKey: 82 }),
    F5: Object.freeze({ key: "F5", code: "F5", virtualKey: 116 }),
  });
  const key = keys[keyCode];
  if (key === undefined) throw new Error("SMOKE_KEY_UNSUPPORTED");
  const modifierMask = (modifiers ?? []).reduce((mask, modifier) => mask | ({ alt: 1, control: 2, meta: 4, shift: 8 } as const)[modifier], 0);
  const debuggerPort = window.webContents.debugger;
  if (!debuggerPort.isAttached()) debuggerPort.attach("1.3");
  const common = { key: key.key, code: key.code, windowsVirtualKeyCode: key.virtualKey, nativeVirtualKeyCode: key.virtualKey, modifiers: modifierMask };
  try {
    await debuggerPort.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", ...common });
    if (key.text !== undefined) await debuggerPort.sendCommand("Input.dispatchKeyEvent", { type: "char", text: key.text, unmodifiedText: key.text, ...common });
    await debuggerPort.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...common });
  } catch (error) {
    if (!allowExpectedTargetDestruction) throw error;
    const deadline = Date.now() + 500;
    while (!window.isDestroyed() && Date.now() < deadline) await delay(10);
    if (!window.isDestroyed()) throw error;
    return;
  }
  await delay(30);
}

let surfaceSequence = 0;

type SyntheticAuthorizedValidationPort = CredentialValidationPort & {
  dispatches(): number;
};

async function createSyntheticAuthorizedValidationPort(
  control: TestCredentialHostControl,
  sequence: number,
  outcome: CredentialValidationOutcome,
): Promise<SyntheticAuthorizedValidationPort> {
  const root = resolve(smokeRoot, "synthetic-anthropic-authorizations", sequence.toString(16).padStart(8, "0"));
  const issuedAt = "2026-08-20T09:59:00.000Z";
  const expiresAt = "2026-08-20T11:00:00.000Z";
  const packet = createAnthropicValidationAuthorizationPacket({
    candidate: SYNTHETIC_CANDIDATE_BINDING,
    authorizationReference: `synthetic-electron-smoke-${sequence}`,
    markerNamespace: `${ANTHROPIC_VALIDATION_MARKER_NAMESPACE_PREFIX}${sequence.toString(16).padStart(32, "0")}`,
    issuedAt,
    expiresAt,
  });
  const packetPath = resolve(root, ...ANTHROPIC_VALIDATION_AUTHORIZATION_RELATIVE_PATH.split("/"));
  await mkdir(dirname(packetPath), { recursive: true });
  await writeFile(packetPath, serializeAnthropicValidationAuthorizationPacket(packet), "utf8");
  const gate = await createAnthropicValidationAuthorizationGate({
    root,
    candidateBinding: SYNTHETIC_CANDIDATE_BINDING,
    now: control.clock.now,
  });
  if (gate.authorization().state !== "available") throw new Error("SMOKE_SYNTHETIC_AUTHORIZATION_UNAVAILABLE");
  const deterministic = createDeterministicCredentialValidationPort({ outcome });
  return Object.freeze({
    authorization: gate.authorization,
    async prepare(input: Parameters<NonNullable<CredentialValidationPort["prepare"]>>[0]) {
      if (
        input.signal.aborted || input.slotId !== "anthropic" ||
        input.providerInstanceId !== "anthropic-default"
      ) throw new Error("SMOKE_SYNTHETIC_AUTHORIZATION_INPUT_INVALID");
      return await gate.consume({
        slotId: "anthropic",
        providerInstanceId: "anthropic-default",
        secretRefFingerprint: input.secretRefFingerprint,
      });
    },
    async validate(input: Parameters<CredentialValidationPort["validate"]>[0]) {
      gate.claim(input.authorizationAttempt as ConsumedAnthropicValidationAuthorization);
      return await deterministic.validate(input);
    },
    dispatches: deterministic.dispatches,
  });
}

async function openSurface(options: SurfaceOptions = {}): Promise<Surface> {
  surfaceSequence += 1;
  let failDecrypt = false;
  const control = createTestCredentialHost(options.seedState === "unrecoverable" ? { failDecrypt: () => failDecrypt } : {});
  const auxiliaryServices: Array<ReturnType<TestCredentialHostControl["createService"]>> = [];
  const shouldSeed = options.seedCredential === true || options.seedState !== undefined || options.seedDisabled === true || options.seedValidationOutcomes !== undefined;
  if (shouldSeed) {
    const seed = control.createService({ validationEnabled: false });
    auxiliaryServices.push(seed);
    const sessionToken = "e".repeat(64);
    const described = await seed.describe({ schemaVersion: 1, requestId: "d".repeat(32), sessionToken, operation: "describe" });
    if (!described.ok || described.kind !== "slots") throw new Error("SMOKE_SEED_DESCRIBE_FAILED");
    const saved = await seed.save({ schemaVersion: 1, requestId: "e".repeat(32), sessionToken, operation: "save", slotId: "anthropic", secret: SYNTHETIC_CANARY, nickname: options.seedNickname ?? "Synthetic smoke", ownership: "owned", authorizedBy: "", clearClipboard: false });
    if (!saved.ok || saved.kind !== "saved") throw new Error("SMOKE_SEED_SAVE_FAILED");
    if (options.seedDisabled === true) {
      const disable = control.createService({ validationEnabled: false });
      auxiliaryServices.push(disable);
      const current = await disable.describe({ schemaVersion: 1, requestId: "a".repeat(32), sessionToken, operation: "describe" });
      if (!current.ok || current.kind !== "slots") throw new Error("SMOKE_DISABLE_DESCRIBE_FAILED");
      const slot = current.slots[0]!;
      if (slot.credentialId === null || slot.revision === null || slot.recordToken === null) throw new Error("SMOKE_DISABLE_IDENTITY_MISSING");
      const disabled = await disable.setEnabled({ schemaVersion: 1, requestId: "b".repeat(32), sessionToken, operation: "set-enabled", slotId: "anthropic", credentialId: slot.credentialId, recordRevision: slot.revision, recordToken: slot.recordToken, enabled: false });
      if (!disabled.ok || disabled.kind !== "disabled") throw new Error("SMOKE_DISABLE_FAILED");
    }
    for (const [index, outcome] of (options.seedValidationOutcomes ?? []).entries()) {
      const validationSeed = control.createService({ validationEnabled: true, validation: createDeterministicCredentialValidationPort({ outcome }) });
      auxiliaryServices.push(validationSeed);
      const current = await validationSeed.describe({ schemaVersion: 1, requestId: (index + 1).toString(16).repeat(32).slice(0, 32), sessionToken, operation: "describe" });
      if (!current.ok || current.kind !== "slots") throw new Error("SMOKE_VALIDATION_SEED_DESCRIBE_FAILED");
      const slot = current.slots[0]!;
      if (slot.credentialId === null || slot.revision === null || slot.recordToken === null) throw new Error("SMOKE_VALIDATION_SEED_IDENTITY_MISSING");
      const validated = await validationSeed.validate({ schemaVersion: 1, requestId: (index + 5).toString(16).repeat(32).slice(0, 32), sessionToken, operation: "validate", slotId: "anthropic", credentialId: slot.credentialId, recordRevision: slot.revision, recordToken: slot.recordToken, acknowledgedDisclosure: true });
      if (!validated.ok || validated.kind !== "validated") throw new Error("SMOKE_VALIDATION_SEED_FAILED");
    }
    if (options.validationCheckedAt !== undefined) {
      await control.metadata.update((current) => {
        const slot = current.slots.anthropic;
        if (slot === null) throw new Error("SMOKE_VALIDATION_METADATA_MISSING");
        const rewrite = (value: typeof slot.validation): typeof slot.validation => value === null ? null : Object.freeze({ ...value, checkedAt: options.validationCheckedAt! });
        return Object.freeze({ ...current, slots: Object.freeze({ ...current.slots, anthropic: Object.freeze({ ...slot, validation: rewrite(slot.validation), lastValidationAttempt: rewrite(slot.lastValidationAttempt) }) }) });
      });
    }
    if (options.seedState === "revoked") {
      const remove = control.createService({ validationEnabled: false });
      auxiliaryServices.push(remove);
      const current = await remove.describe({ schemaVersion: 1, requestId: "c".repeat(32), sessionToken, operation: "describe" });
      if (!current.ok || current.kind !== "slots") throw new Error("SMOKE_REMOVE_SEED_DESCRIBE_FAILED");
      const slot = current.slots[0]!;
      if (slot.credentialId === null || slot.revision === null || slot.recordToken === null) throw new Error("SMOKE_REMOVE_SEED_IDENTITY_MISSING");
      const removed = await remove.remove({ schemaVersion: 1, requestId: "f".repeat(32), sessionToken, operation: "remove", slotId: "anthropic", credentialId: slot.credentialId, recordRevision: slot.revision, recordToken: slot.recordToken, acknowledgedRemoval: true });
      if (!removed.ok || removed.kind !== "removed") throw new Error("SMOKE_REMOVE_SEED_FAILED");
    }
    if (options.seedState === "unrecoverable") {
      failDecrypt = true;
      const recover = control.createService({ validationEnabled: true, validation: createDeterministicCredentialValidationPort() });
      auxiliaryServices.push(recover);
      const current = await recover.describe({ schemaVersion: 1, requestId: "1".repeat(32), sessionToken, operation: "describe" });
      if (!current.ok || current.kind !== "slots") throw new Error("SMOKE_UNRECOVERABLE_DESCRIBE_FAILED");
      const slot = current.slots[0]!;
      if (slot.credentialId === null || slot.revision === null || slot.recordToken === null) throw new Error("SMOKE_UNRECOVERABLE_IDENTITY_MISSING");
      const input = { schemaVersion: 1 as const, sessionToken, operation: "validate" as const, slotId: "anthropic" as const, credentialId: slot.credentialId, recordRevision: slot.revision, recordToken: slot.recordToken, acknowledgedDisclosure: true as const };
      const first = await recover.validate({ ...input, requestId: "2".repeat(32) });
      const retryObservation = await recover.describe({ schemaVersion: 1, requestId: "5".repeat(32), sessionToken, operation: "describe" });
      if (!retryObservation.ok || retryObservation.kind !== "slots" || retryObservation.slots[0]?.state !== "present") throw new Error("SMOKE_UNRECOVERABLE_RETRY_OBSERVATION_FAILED");
      const second = await recover.validate({ ...input, requestId: "3".repeat(32) });
      if (first.ok || first.code !== "DECRYPT_FAILED" || second.ok || second.code !== "DECRYPT_FAILED") throw new Error(`SMOKE_UNRECOVERABLE_FAILURES_NOT_OBSERVED_${first.ok ? first.kind : first.code}_${second.ok ? second.kind : second.code}`);
      const recovered = await recover.describe({ schemaVersion: 1, requestId: "4".repeat(32), sessionToken, operation: "describe" });
      if (!recovered.ok || recovered.kind !== "slots" || recovered.slots[0]?.state !== "unrecoverable") throw new Error("SMOKE_UNRECOVERABLE_STATE_NOT_PERSISTED");
    }
  }
  const validation = options.validationEnabled === true
    ? await createSyntheticAuthorizedValidationPort(control, surfaceSequence, options.validationOutcome ?? "valid")
    : createDeterministicCredentialValidationPort({ outcome: options.validationOutcome ?? "valid" });
  const service = control.createService({ validation, validationEnabled: options.validationEnabled ?? false, encryptionAvailable: options.encryptionAvailable ?? true, clipboardSucceeds: options.clipboardSucceeds ?? true });
  const gates: Partial<Record<SurfaceGateName, Readonly<{ started: Promise<void>; startedNow(): void; released: Promise<void>; releaseNow(): void }>>> = Object.create(null) as Partial<Record<SurfaceGateName, Readonly<{ started: Promise<void>; startedNow(): void; released: Promise<void>; releaseNow(): void }>>>;
  function armGateInternal(name: SurfaceGateName): void {
    if (gates[name] !== undefined) throw new Error("SMOKE_OPERATION_GATE_ALREADY_ARMED");
    let startedNow!: () => void;
    let releaseNow!: () => void;
    const started = new Promise<void>((resolveStarted) => { startedNow = resolveStarted; });
    const released = new Promise<void>((resolveReleased) => { releaseNow = resolveReleased; });
    gates[name] = Object.freeze({ started, startedNow, released, releaseNow });
  }
  if (options.gateInitialDescribe === true) armGateInternal("describe");
  async function passGate(name: SurfaceGateName): Promise<void> {
    const active = gates[name];
    if (active === undefined) return;
    active.startedNow();
    await active.released;
    if (gates[name] === active) delete gates[name];
  }
  const originalDescribe = service.describe.bind(service);
  let describeCount = 0;
  Object.defineProperty(service, "describe", { configurable: false, value: async (...args: Parameters<typeof originalDescribe>) => {
    await passGate("describe");
    const result = await originalDescribe(...args);
    describeCount += 1;
    if (options.describeRefusalAfter !== undefined && describeCount >= options.describeRefusalAfter) return Object.freeze({ schemaVersion: 1, requestId: args[0].requestId, ok: false, kind: "refused", code: "METADATA_UNAVAILABLE", retryable: false } as const);
    if (!result.ok || result.kind !== "slots" || options.viewScenario === undefined) return result;
    if (describeCount < (options.viewScenarioAfterDescribe ?? 1)) return result;
    if (options.viewScenario === "metadata-unavailable") return Object.freeze({
      ...result,
      metadataAvailable: false,
      activity: Object.freeze([{ id: "activity-malformed-sidecar-canary", at: new Date().toISOString(), tone: "danger" as const, text: `Imported ${SYNTHETIC_ACTIVITY_SHAPE}` }]),
      slots: Object.freeze(result.slots.map((slot) => slot.state === "absent" ? slot : Object.freeze({ ...slot, nickname: `${slot.displayName} credential`, ownership: null, authorizedBy: null, enabled: false, validation: null, lastValidationAttempt: null }))),
    });
    if (options.viewScenario === "tones") {
      const checkedAt = new Date().toISOString();
      const outcomes: readonly (CredentialValidationOutcome | null)[] = ["valid", "invalid", "unauthorized", null];
      return Object.freeze({
        ...result,
        vaultState: "ready",
        revision: 9,
        recovery: null,
        metadataAvailable: true,
        slots: Object.freeze(result.slots.map((slot, index) => {
          const outcome = outcomes[index]!;
          const validationView = outcome === null ? null : Object.freeze({ outcome, checkedAt, recordRevision: 9, recordToken: (index + 1).toString().repeat(64), definitive: true });
          return Object.freeze({ ...slot, credentialId: `cred-tone-${slot.slotId}`, nickname: `Tone ${slot.displayName}`, ownership: "owned" as const, enabled: true, state: "present" as const, revision: 9, generation: 1, createdAt: checkedAt, recordToken: (index + 1).toString().repeat(64), validation: validationView, lastValidationAttempt: validationView });
        })),
      });
    }
    if (options.viewScenario === "multi-anthropic") {
      const source = result.slots.find((slot) => slot.slotId === "anthropic");
      if (source === undefined || source.state === "absent") throw new Error("SMOKE_MULTI_ANTHROPIC_SOURCE_MISSING");
      const checkedAt = new Date().toISOString();
      const staleAt = new Date(Date.now() - (8 * 24 * 60 * 60 * 1_000)).toISOString();
      const validation = (outcome: CredentialValidationOutcome, recordToken: string, at = checkedAt): NonNullable<CredentialSlotView["validation"]> => Object.freeze({ outcome, checkedAt: at, recordRevision: 9, recordToken, definitive: outcome === "valid" || outcome === "invalid" || outcome === "unauthorized" });
      const credential = (index: 1 | 2, changes: Partial<CredentialSlotView> = {}): CredentialSlotView => {
        const suffix = index.toString();
        const recordToken = suffix.repeat(64);
        return Object.freeze({ ...source, credentialId: `cred-multi-${suffix.repeat(32)}`, nickname: `Anthropic ${suffix}`, state: "present" as const, enabled: true, revision: 9, generation: index, createdAt: checkedAt, recordToken, validation: null, lastValidationAttempt: null, ...changes });
      };
      const scenario = options.multiCredentialScenario ?? "mixed";
      const firstToken = "1".repeat(64);
      const secondToken = "2".repeat(64);
      let credentials: readonly CredentialSlotView[];
      if (scenario === "mixed" || scenario === "metadata-unavailable" || scenario === "recovery") {
        const accepted = validation("valid", firstToken);
        credentials = Object.freeze([credential(1, { validation: accepted, lastValidationAttempt: accepted }), credential(2)]);
      } else if (scenario === "all-disabled") {
        credentials = Object.freeze([credential(1, { enabled: false }), credential(2, { enabled: false })]);
      } else if (scenario === "saved-only") {
        credentials = Object.freeze([credential(1), credential(2)]);
      } else if (scenario === "inconclusive") {
        const limited = validation("unauthorized", firstToken);
        const unclear = validation("ambiguous", secondToken);
        credentials = Object.freeze([credential(1, { validation: limited, lastValidationAttempt: limited }), credential(2, { lastValidationAttempt: unclear })]);
      } else if (scenario === "stale") {
        const first = validation("valid", firstToken, staleAt);
        const second = validation("valid", secondToken, staleAt);
        credentials = Object.freeze([credential(1, { validation: first, lastValidationAttempt: first }), credential(2, { validation: second, lastValidationAttempt: second })]);
      } else if (scenario === "invalid") {
        const rejected = validation("invalid", firstToken);
        const accepted = validation("valid", secondToken);
        credentials = Object.freeze([credential(1, { validation: rejected, lastValidationAttempt: rejected }), credential(2, { validation: accepted, lastValidationAttempt: accepted })]);
      } else {
        const accepted = validation("valid", secondToken);
        credentials = Object.freeze([credential(1, { state: "unrecoverable", enabled: false }), credential(2, { validation: accepted, lastValidationAttempt: accepted })]);
      }
      const groupedSlots = Object.freeze([...credentials, ...result.slots.filter((slot) => slot.slotId !== "anthropic")]);
      if (scenario === "metadata-unavailable") return Object.freeze({ ...result, vaultState: "ready", revision: 9, recovery: null, metadataAvailable: false, slots: groupedSlots });
      if (scenario === "recovery") return Object.freeze({ ...result, vaultState: "backup-only", revision: null, recovery: Object.freeze({ issueCode: "VAULT_BACKUP_ONLY" as const, primaryDigest: "a".repeat(64), backupDigest: "b".repeat(64), actions: Object.freeze(["restore-backup" as const, "start-over" as const]) }), metadataAvailable: true, slots: groupedSlots });
      return Object.freeze({ ...result, vaultState: "ready", revision: 9, recovery: null, metadataAvailable: true, slots: groupedSlots });
    }
    if (options.viewScenario === "slot-unrecoverable" || options.viewScenario === "slot-absent") return Object.freeze({
      ...result,
      slots: Object.freeze(result.slots.map((slot) => slot.slotId !== "anthropic" ? slot : options.viewScenario === "slot-unrecoverable"
        ? Object.freeze({ ...slot, state: "unrecoverable" as const, enabled: false, validation: null, lastValidationAttempt: null })
        : Object.freeze({ ...slot, state: "absent" as const, nickname: null, ownership: null, authorizedBy: null, enabled: false, generation: null, createdAt: null, rotatedAt: null, revokedAt: null, validation: null, lastValidationAttempt: null }))),
    });
    const issue = {
      "backup-only": { code: "VAULT_BACKUP_ONLY", actions: ["restore-backup", "start-over"] },
      corrupt: { code: "VAULT_CORRUPT", actions: ["restore-backup", "start-over"] },
      "identity-mismatch": { code: "VAULT_IDENTITY_MISMATCH", actions: ["rebind"] },
      "backend-mismatch": { code: "VAULT_BACKEND_MISMATCH", actions: [] },
      "schema-ahead": { code: "VAULT_SCHEMA_AHEAD", actions: [] },
    } as const;
    const recovery = issue[options.viewScenario];
    return Object.freeze({ ...result, vaultState: options.viewScenario, recovery: Object.freeze({ issueCode: recovery.code, primaryDigest: "a".repeat(64), backupDigest: "b".repeat(64), actions: Object.freeze(recovery.actions) }) }) as CredentialSlotsResult;
  } });
  const originalSave = service.save.bind(service);
  Object.defineProperty(service, "save", { configurable: false, value: async (...args: Parameters<typeof originalSave>) => {
    await passGate("save");
    return await originalSave(...args);
  } });
  const originalValidate = service.validate.bind(service);
  let validationRefused = false;
  Object.defineProperty(service, "validate", { configurable: false, value: async (...args: Parameters<typeof originalValidate>) => {
    await passGate("validate");
    if (options.validationRefusalOnce !== undefined && !validationRefused) {
      validationRefused = true;
      return Object.freeze({ schemaVersion: 1, requestId: args[0].requestId, ok: false, kind: "refused", code: options.validationRefusalOnce, retryable: false } as const);
    }
    return await originalValidate(...args);
  } });
  const originalRemove = service.remove.bind(service);
  Object.defineProperty(service, "remove", { configurable: false, value: async (...args: Parameters<typeof originalRemove>) => {
    await passGate("remove");
    return await originalRemove(...args);
  } });
  const originalRotate = service.rotate.bind(service);
  let rotateCalls = 0;
  let conflicted = false;
  let rotateRefused = false;
  Object.defineProperty(service, "rotate", { configurable: false, value: async (...args: Parameters<typeof originalRotate>) => {
    rotateCalls += 1;
    if (options.rotateConflictOnce === true && !conflicted) {
      conflicted = true;
      return Object.freeze({ schemaVersion: 1, requestId: args[0].requestId, ok: false, kind: "refused", code: "VAULT_REVISION_CONFLICT", retryable: true } as const);
    }
    if (options.rotateRefusalOnce !== undefined && !rotateRefused) {
      rotateRefused = true;
      return Object.freeze({ schemaVersion: 1, requestId: args[0].requestId, ok: false, kind: "refused", code: options.rotateRefusalOnce, retryable: false } as const);
    }
    return await originalRotate(...args);
  } });
  const token = surfaceSequence.toString(16).padStart(64, "0");
  const credentialSession = session.fromPartition(`${CREDENTIAL_SESSION_PARTITION}-${surfaceSequence}`, { cache: false });
  hardenCredentialSession(credentialSession);
  installCredentialProtocol(credentialSession, resolve(appRoot, "dist", "renderer", "credential"));
  const window = await createHardenedCredentialWindow({ credentialSession, preloadPath: resolve(appRoot, "dist", "preload", "credential.cjs"), sessionToken: token });
  let consoleCanary = false;
  let rendererGone = false;
  window.webContents.on("console-message", (details) => { if (details.message.includes(SYNTHETIC_CANARY)) consoleCanary = true; });
  window.webContents.on("render-process-gone", () => { rendererGone = true; });
  const disposeIpc = installCredentialIpc(ipcMain, { token, webContentsId: window.webContents.id, credentialSession, service, window, touch() {} });
  await loadCredentialWindow(window);
  if (options.gateInitialDescribe === true) await waitFor(window, `(document.querySelector(".strip strong")?.textContent ?? "").includes("Loading secure storage")`);
  else if (options.describeRefusalAfter === 1) await waitFor(window, `document.querySelector(".notice h2") !== null`);
  else await waitFor(window, `document.querySelectorAll(".provider-card").length === 4`);
  window.show();
  window.focus();
  window.webContents.focus();
  const originalDispose = disposeIpc;
  return {
    window,
    control,
    validation,
    disposeIpc() { originalDispose(); void Promise.allSettled([service.close(), ...auxiliaryServices.map(async (auxiliary) => await auxiliary.close())]); },
    consoleCanary: () => consoleCanary,
    rendererGone: () => rendererGone,
    rotateCalls: () => rotateCalls,
    describeCalls: () => describeCount,
    armGate(name: SurfaceGateName) { armGateInternal(name); },
    async waitForGate(name: SurfaceGateName) {
      const gate = gates[name];
      if (gate === undefined) throw new Error("SMOKE_OPERATION_GATE_NOT_ARMED");
      await gate.started;
    },
    releaseGate(name: SurfaceGateName) { gates[name]?.releaseNow(); },
  };
}

async function closeSurface(surface: Surface): Promise<void> {
  for (const name of ["describe", "save", "validate", "remove"] as const) surface.releaseGate(name);
  if (!surface.window.isDestroyed()) surface.window.destroy();
  surface.disposeIpc();
  await delay(20);
}

async function openEntryWithSyntheticValue(surface: Surface): Promise<void> {
  await page(surface.window, `document.querySelector('[data-focus-key="add-provider"]')?.click()`);
  await waitFor(surface.window, `document.querySelector(".provider-picker button") !== null`);
  await page(surface.window, `document.querySelector(".provider-picker button")?.click()`);
  await waitFor(surface.window, `document.querySelector("#credential-secret") !== null`);
  await page(surface.window, `(() => { const input = document.querySelector("#credential-secret"); if (!(input instanceof HTMLInputElement)) return false; input.value = ${JSON.stringify(SYNTHETIC_CANARY)}; input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
}

async function chooseMode(surface: Surface, selected: "normal" | "developer"): Promise<void> {
  await page(surface.window, `document.querySelector("#mode-toggle")?.click()`);
  await waitFor(surface.window, `document.querySelector('dialog input[value=${JSON.stringify(selected)}]') !== null`);
  await page(surface.window, `(() => { document.querySelector('dialog input[value=${JSON.stringify(selected)}]')?.click(); [...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Apply mode")?.click(); })()`);
  await waitFor(surface.window, `document.querySelector("dialog") === null && document.documentElement.dataset.mode === ${JSON.stringify(selected)}`);
}

async function openAnthropicDetail(surface: Surface): Promise<void> {
  await page(surface.window, `document.querySelector('[data-focus-key="manage-anthropic"]')?.click()`);
  await waitFor(surface.window, `document.querySelector(".detail-card") !== null`);
}

async function openAndSubmitReplacement(surface: Surface, actionLabel: "Rotate credential" | "Re-enter credential"): Promise<void> {
  await page(surface.window, `[...document.querySelectorAll(".detail-card button")].find((node) => node.textContent?.trim() === ${JSON.stringify(actionLabel)})?.click()`);
  await waitFor(surface.window, `document.querySelector("#credential-secret") !== null`);
  await page(surface.window, `(() => { const input = document.querySelector("#credential-secret"); if (!(input instanceof HTMLInputElement)) return; input.value = ${JSON.stringify(SYNTHETIC_REPLACEMENT)}; input.dispatchEvent(new Event("input", { bubbles: true })); [...document.querySelectorAll("dialog button")].find((node) => /^(Replace|Re-enter) securely$/.test(node.textContent?.trim() ?? ""))?.click(); })()`);
}

async function runHappyPath(): Promise<void> {
  await mark("happy-opening");
  const surface = await openSurface();
  try {
    await mark("happy-loaded");
    await waitFor(surface.window, `(document.querySelector("#status-region")?.textContent ?? "").includes("Credential storage loaded")`);
    record("runtime-version", process.versions["electron"] === "43.4.1", process.versions["electron"] ?? null);
    record("exact-entry-url", surface.window.webContents.getURL() === CREDENTIAL_ENTRY_URL, surface.window.webContents.getURL());
    const rendererBoundary = await page<Record<string, unknown>>(surface.window, `({ processType: typeof process, requireType: typeof require, moduleType: typeof module, bridgeType: typeof window.credentialVault })`);
    record("renderer-node-boundary", rendererBoundary["processType"] === "undefined" && rendererBoundary["requireType"] === "undefined" && rendererBoundary["moduleType"] === "undefined" && rendererBoundary["bridgeType"] === "object", rendererBoundary);

    const initial = await page<Record<string, unknown>>(surface.window, `(() => ({
      providers: document.querySelectorAll(".provider-card").length,
      active: document.activeElement?.tagName ?? null,
      heading: document.querySelector("h1")?.textContent ?? null,
      bridge: Object.keys(window.credentialVault ?? {}).sort(),
      duplicateIds: [...document.querySelectorAll("[id]")].length - new Set([...document.querySelectorAll("[id]")].map((node) => node.id)).size,
      liveRegions: document.querySelectorAll("#status-region").length + document.querySelectorAll("#alert-region").length,
      productionDisabled: document.body.textContent?.includes("tasks do not run against providers") ?? false,
      modeText: document.querySelector("#mode-toggle")?.textContent ?? null,
      modePressed: document.querySelector("#mode-toggle")?.getAttribute("aria-pressed") ?? null,
      modePopup: document.querySelector("#mode-toggle")?.getAttribute("aria-haspopup") ?? null,
      modeLabel: document.querySelector("#mode-toggle")?.getAttribute("aria-label") ?? null,
      initialLiveStatus: document.querySelector("#status-region")?.textContent ?? "",
      initialLiveAlert: document.querySelector("#alert-region")?.textContent ?? "",
      providerListRole: document.querySelector(".provider-grid")?.getAttribute("role") ?? null,
      providerListItems: document.querySelectorAll('.provider-grid > [role="listitem"]').length
    }))()`);
    record("initial-contract", initial["providers"] === 4 && initial["providerListRole"] === "list" && initial["providerListItems"] === 4 && initial["active"] === "H1" && initial["duplicateIds"] === 0 && initial["liveRegions"] === 2 && initial["productionDisabled"] === true && initial["modeText"] === "Mode: Normal" && initial["modePressed"] === null && initial["modePopup"] === "dialog" && String(initial["modeLabel"]).includes("Current mode: Normal") && String(initial["initialLiveStatus"]).includes("Credential storage loaded") && initial["initialLiveAlert"] === "", initial);
    record("narrow-preload", JSON.stringify(initial["bridge"]) === JSON.stringify(["cancel", "describe", "remove", "rotate", "save", "setEnabled", "validate"]), initial["bridge"]);

    surface.window.setContentSize(1180, 780);
    await delay(80);
    const defaultContentSize = surface.window.getContentSize();

    await page(surface.window, `document.querySelector('[data-focus-key="add-provider"]')?.focus()`);
    const addFocus = await page<string | null>(surface.window, `document.activeElement?.getAttribute("data-focus-key")`);
    await press(surface.window, "Enter");
    await waitFor(surface.window, `document.querySelector(".provider-picker button") !== null && document.activeElement?.matches(".provider-picker button") === true`);
    await mark("happy-picker");
    const picker = await page<Record<string, unknown>>(surface.window, `(() => { const dialog = document.querySelector("dialog"); const labelledBy = dialog?.getAttribute("aria-labelledby"); return { active: document.activeElement?.tagName, role: document.activeElement?.getAttribute("role"), type: document.activeElement?.getAttribute("type"), count: document.querySelectorAll(".provider-picker > li > button").length, listTag: document.querySelector(".provider-picker")?.tagName, rowTags: [...document.querySelectorAll(".provider-picker > li")].every((node) => node.tagName === "LI"), accessibleName: labelledBy !== null && labelledBy !== undefined && document.getElementById(labelledBy)?.textContent === "Choose a provider" }; })()`);
    await press(surface.window, "Escape");
    await waitFor(surface.window, `document.querySelector("dialog") === null && document.activeElement?.getAttribute("data-focus-key") === "add-provider"`);
    const pickerReturnFocus = await page<string | null>(surface.window, `document.activeElement?.getAttribute("data-focus-key")`);
    await press(surface.window, "Enter");
    await waitFor(surface.window, `document.querySelector(".provider-picker button") !== null && document.activeElement?.matches(".provider-picker button") === true`);
    await press(surface.window, "Enter");
    await waitFor(surface.window, `document.querySelector("#credential-secret") !== null && document.activeElement?.id === "credential-secret"`);
    await mark("happy-entry");
    const entry = await page<Record<string, unknown>>(surface.window, `(() => { const dialog = document.querySelector("dialog"); const labelledBy = dialog?.getAttribute("aria-labelledby"); const describedBy = dialog?.getAttribute("aria-describedby"); const secret = document.querySelector("#credential-secret"); const clear = [...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Clear"); const submit = [...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Save securely"); const cancel = [...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Cancel and close"); const clipboard = document.querySelector(".clipboard-choice input"); const clipboardLabelNode = document.querySelector(".clipboard-choice label"); const clipboardDescriptionId = clipboard?.getAttribute("aria-describedby"); const nickname = document.querySelector("#credential-nickname"); const authorizedBy = document.querySelector("#credential-authorized-by"); const body = document.querySelector("dialog .dialog-body"); return { activeId: document.activeElement?.id, passwordCount: document.querySelectorAll('input[type="password"]').length, secretAutocomplete: secret?.getAttribute("autocomplete"), randomSecretName: /^credential-[a-f0-9]{32}$/.test(secret?.getAttribute("name") ?? ""), duplicateIds: [...document.querySelectorAll("[id]")].length - new Set([...document.querySelectorAll("[id]")].map((node) => node.id)).size, forbiddenControls: [...document.querySelectorAll("dialog button")].filter((node) => /reveal|show credential|copy credential|export credential/i.test(node.textContent ?? "")).length, clearButtons: clear === undefined ? 0 : 1, clearDisabled: clear?.hasAttribute("disabled") ?? false, submitDisabled: submit?.hasAttribute("disabled") ?? false, accessibleName: labelledBy !== null && labelledBy !== undefined && (document.getElementById(labelledBy)?.textContent ?? "") === "Save credential — Anthropic", accessibleDescription: describedBy !== null && describedBy !== undefined && (document.getElementById(describedBy)?.textContent ?? "").includes("never shown again"), cancelLabel: cancel?.textContent?.trim() ?? "", cancelConsequence: document.querySelector(".dialog-foot .local-note")?.textContent?.trim() ?? "", bodyFitsDefaultViewport: body !== null && body.scrollHeight <= body.clientHeight + 1, bodyClientHeight: body?.clientHeight ?? null, bodyScrollHeight: body?.scrollHeight ?? null, innerSize: [innerWidth, innerHeight], acquisition: document.querySelector("#credential-secret-help")?.textContent ?? "", nicknameMax: nickname instanceof HTMLInputElement ? nickname.maxLength : null, authorizedByMax: authorizedBy instanceof HTMLInputElement ? authorizedBy.maxLength : null, clipboardLabel: clipboardLabelNode?.textContent?.trim() ?? "", clipboardTargetHeight: clipboardLabelNode?.getBoundingClientRect().height ?? 0, clipboardDescription: clipboardDescriptionId === null || clipboardDescriptionId === undefined ? "" : document.getElementById(clipboardDescriptionId)?.textContent ?? "" }; })()`);
    record("keyboard-focus-flow", addFocus === "add-provider" && pickerReturnFocus === "add-provider" && picker["active"] === "BUTTON" && entry["activeId"] === "credential-secret", { addFocus, pickerReturnFocus, pickerActive: picker["active"], entryActiveId: entry["activeId"] });
    record("provider-picker-contract", picker["role"] === null && picker["type"] === "button" && picker["count"] === 4 && picker["listTag"] === "UL" && picker["rowTags"] === true && picker["accessibleName"] === true, picker);
    record("entry-secret-surface-contract", entry["passwordCount"] === 1 && entry["secretAutocomplete"] === "new-password" && entry["randomSecretName"] === true && entry["duplicateIds"] === 0 && entry["forbiddenControls"] === 0 && entry["clearButtons"] === 1 && entry["clearDisabled"] === true && entry["submitDisabled"] === true, entry);
    record("entry-accessible-copy", entry["accessibleName"] === true && entry["accessibleDescription"] === true && entry["cancelLabel"] === "Cancel and close" && String(entry["cancelConsequence"]).includes("Nothing is saved") && String(entry["acquisition"]).includes("Anthropic Console → API keys"), entry);
    record("entry-default-content-size-fit", defaultContentSize[0] === 1180 && defaultContentSize[1] === 780 && JSON.stringify(entry["innerSize"]) === JSON.stringify([1180, 780]) && entry["bodyFitsDefaultViewport"] === true, { defaultContentSize, innerSize: entry["innerSize"], bodyClientHeight: entry["bodyClientHeight"], bodyScrollHeight: entry["bodyScrollHeight"] });
    record("entry-metadata-bounds", entry["nicknameMax"] === 40 && entry["authorizedByMax"] === 40, { nicknameMax: entry["nicknameMax"], authorizedByMax: entry["authorizedByMax"] });
    record("entry-clipboard-choice", entry["clipboardLabel"] === "Clear the current clipboard item after confirmed save" && Number(entry["clipboardTargetHeight"]) >= 24 && String(entry["clipboardDescription"]).includes("Windows clipboard history"), { clipboardLabel: entry["clipboardLabel"], clipboardTargetHeight: entry["clipboardTargetHeight"], clipboardDescription: entry["clipboardDescription"] });

    const correctedFieldErrors = await page<Record<string, unknown>>(surface.window, `(async () => {
      const secret = document.querySelector("#credential-secret");
      const nickname = document.querySelector("#credential-nickname");
      const authorized = document.querySelector('input[name="credential-ownership"][value="authorized"]');
      const owned = document.querySelector('input[name="credential-ownership"][value="owned"]');
      const authorizer = document.querySelector("#credential-authorized-by");
      const submit = [...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Save securely");
      if (!(secret instanceof HTMLInputElement) || !(nickname instanceof HTMLInputElement) || !(authorizer instanceof HTMLInputElement)) return {};
      secret.value = ${JSON.stringify(SYNTHETIC_CANARY)}; secret.dispatchEvent(new Event("input", { bubbles: true }));
      nickname.value = ""; nickname.dispatchEvent(new Event("input", { bubbles: true })); submit?.click();
      await Promise.resolve();
      const nicknameLink = document.querySelector(".form-error-summary a");
      const nicknameError = { focused: document.activeElement === nicknameLink, href: nicknameLink?.getAttribute("href") ?? "", visible: !document.querySelector(".form-error-summary")?.hasAttribute("hidden"), inline: document.querySelector("#credential-nickname-error")?.textContent ?? "" };
      nicknameLink?.click();
      nicknameError.targetFocused = document.activeElement?.id === "credential-nickname";
      nickname.value = "Personal"; nickname.dispatchEvent(new Event("input", { bubbles: true }));
      const nicknameCorrected = { summaryHidden: document.querySelector(".form-error-summary")?.hasAttribute("hidden") ?? false, inline: document.querySelector("#credential-nickname-error")?.textContent ?? "" };
      authorized?.click(); submit?.click(); await Promise.resolve();
      const authorizerLink = document.querySelector(".form-error-summary a");
      const authorizerError = { focused: document.activeElement === authorizerLink, href: authorizerLink?.getAttribute("href") ?? "", visible: !document.querySelector(".form-error-summary")?.hasAttribute("hidden"), inline: document.querySelector("#credential-authorized-by-error")?.textContent ?? "" };
      authorizerLink?.click();
      authorizerError.targetFocused = document.activeElement?.id === "credential-authorized-by";
      owned?.click();
      const ownershipCorrected = { summaryHidden: document.querySelector(".form-error-summary")?.hasAttribute("hidden") ?? false, inline: document.querySelector("#credential-authorized-by-error")?.textContent ?? "", authorizerHidden: authorizer.closest(".field")?.hidden ?? false };
      authorized?.click(); submit?.click(); await Promise.resolve();
      authorizer.value = "Synthetic team lead"; authorizer.dispatchEvent(new Event("input", { bubbles: true }));
      const authorizerCorrected = { summaryHidden: document.querySelector(".form-error-summary")?.hasAttribute("hidden") ?? false, inline: document.querySelector("#credential-authorized-by-error")?.textContent ?? "" };
      owned?.click();
      secret.value = ""; secret.dispatchEvent(new Event("input", { bubbles: true }));
      return { nicknameError, nicknameCorrected, authorizerError, ownershipCorrected, authorizerCorrected };
    })()`);
    const nicknameError = correctedFieldErrors["nicknameError"] as Record<string, unknown>;
    const nicknameCorrected = correctedFieldErrors["nicknameCorrected"] as Record<string, unknown>;
    const authorizerError = correctedFieldErrors["authorizerError"] as Record<string, unknown>;
    const ownershipCorrected = correctedFieldErrors["ownershipCorrected"] as Record<string, unknown>;
    const authorizerCorrected = correctedFieldErrors["authorizerCorrected"] as Record<string, unknown>;
    record("entry-errors-clear-on-correction", nicknameError["focused"] === true && nicknameError["href"] === "#credential-nickname" && nicknameError["targetFocused"] === true && nicknameError["visible"] === true && String(nicknameError["inline"]).includes("nickname") && nicknameCorrected["summaryHidden"] === true && nicknameCorrected["inline"] === "" && authorizerError["focused"] === true && authorizerError["href"] === "#credential-authorized-by" && authorizerError["targetFocused"] === true && authorizerError["visible"] === true && String(authorizerError["inline"]).includes("authorised") && ownershipCorrected["summaryHidden"] === true && ownershipCorrected["inline"] === "" && ownershipCorrected["authorizerHidden"] === true && authorizerCorrected["summaryHidden"] === true && authorizerCorrected["inline"] === "", correctedFieldErrors);

    const localBlocking = await page<Record<string, unknown>>(surface.window, `(() => {
      const input = document.querySelector("#credential-secret");
      const submit = [...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Save securely");
      const format = document.querySelector("#credential-secret-format");
      if (!(input instanceof HTMLInputElement)) return {};
      input.value = "   "; input.dispatchEvent(new Event("input", { bubbles: true }));
      const whitespace = { disabled: submit?.hasAttribute("disabled") ?? false, tone: format?.getAttribute("data-tone"), text: format?.textContent ?? "" };
      input.value = "  https://provider.invalid/path"; input.dispatchEvent(new Event("input", { bubbles: true }));
      const url = { disabled: submit?.hasAttribute("disabled") ?? false, tone: format?.getAttribute("data-tone"), text: format?.textContent ?? "" };
      input.value = "prefix\tvalue"; input.dispatchEvent(new Event("input", { bubbles: true }));
      const control = { disabled: submit?.hasAttribute("disabled") ?? false, tone: format?.getAttribute("data-tone"), text: format?.textContent ?? "" };
      input.value = "X".repeat(16_385); input.dispatchEvent(new Event("input", { bubbles: true }));
      const oversized = { disabled: submit?.hasAttribute("disabled") ?? false, tone: format?.getAttribute("data-tone"), text: format?.textContent ?? "", echoed: (format?.textContent ?? "").includes("XXXXX") };
      input.value = "sk-ant-synthetic.value_1234"; input.dispatchEvent(new Event("input", { bubbles: true }));
      const dotted = { disabled: submit?.hasAttribute("disabled") ?? false, tone: format?.getAttribute("data-tone"), text: format?.textContent ?? "" };
      input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true }));
      return { whitespace, url, control, oversized, dotted };
    })()`);
    const whitespace = localBlocking["whitespace"] as Record<string, unknown>;
    const url = localBlocking["url"] as Record<string, unknown>;
    const control = localBlocking["control"] as Record<string, unknown>;
    const oversized = localBlocking["oversized"] as Record<string, unknown>;
    const dotted = localBlocking["dotted"] as Record<string, unknown>;
    record("local-blocking-format-checks", whitespace["disabled"] === true && whitespace["tone"] === "danger" && String(whitespace["text"]).includes("Only spaces") && url["disabled"] === true && url["tone"] === "danger" && String(url["text"]).includes("web address") && control["disabled"] === true && control["tone"] === "danger" && String(control["text"]).includes("unsupported control character") && oversized["disabled"] === true && oversized["tone"] === "danger" && String(oversized["text"]).includes("larger than the supported transport bound") && oversized["echoed"] === false && dotted["disabled"] === false && dotted["tone"] === "ok" && String(dotted["text"]).includes("looks plausible"), localBlocking);

    const ownershipCorrection = await page<Record<string, unknown>>(surface.window, `(() => {
      const authorized = document.querySelector('input[name="credential-ownership"][value="authorized"]');
      const owned = document.querySelector('input[name="credential-ownership"][value="owned"]');
      const authorizer = document.querySelector("#credential-authorized-by");
      authorized?.click();
      if (authorizer) authorizer.value = "Synthetic team lead";
      owned?.click();
      const wrapper = authorizer?.closest(".field");
      return { authorizedChecked: authorized?.checked ?? null, ownedChecked: owned?.checked ?? null, authorizerLength: authorizer?.value.length ?? -1, authorizerHidden: wrapper?.hidden ?? null };
    })()`);
    record("ownership-correction-clears-hidden-authorizer", ownershipCorrection["authorizedChecked"] === false && ownershipCorrection["ownedChecked"] === true && ownershipCorrection["authorizerLength"] === 0 && ownershipCorrection["authorizerHidden"] === true, ownershipCorrection);
    await page(surface.window, `document.querySelector("#credential-secret")?.focus()`);

    surface.window.setContentSize(900, 700);
    await delay(80);
    const compactEntry = await page<Record<string, unknown>>(surface.window, `(() => { const full = document.querySelector(".prod-label-full"); const compact = document.querySelector(".prod-label-compact"); return { horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth || document.querySelector("dialog").scrollWidth > document.querySelector("dialog").clientWidth, clippedRailLabels: [...document.querySelectorAll(".rail button")].some((node) => node.scrollWidth > node.clientWidth + 1), clippedFooterButtons: [...document.querySelectorAll(".dialog-foot button")].some((node) => node.scrollWidth > node.clientWidth + 1), productionFullText: full?.textContent ?? "", productionFullWidth: full?.getBoundingClientRect().width ?? 0, productionCompactDisplay: compact === null ? "none" : getComputedStyle(compact).display, productionCompactText: compact?.textContent ?? "" }; })()`);
    record("compact-entry-layout", compactEntry["horizontalOverflow"] === false && compactEntry["clippedRailLabels"] === false && compactEntry["clippedFooterButtons"] === false && compactEntry["productionFullText"] === "Production disabled" && Number(compactEntry["productionFullWidth"]) <= 1 && compactEntry["productionCompactDisplay"] !== "none" && compactEntry["productionCompactText"] === "Prod. off", compactEntry);
    surface.window.setContentSize(1180, 780);
    await delay(80);

    const entryFocusPath: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 8; index += 1) {
      const focused = await page<Record<string, unknown>>(surface.window, `({ id: document.activeElement?.id ?? null, tag: document.activeElement?.tagName ?? null, text: document.activeElement?.textContent?.trim() ?? null, type: document.activeElement?.getAttribute("type") ?? null })`);
      entryFocusPath.push(focused);
      if (focused["id"] === "credential-secret") break;
      await press(surface.window, "Tab");
    }
    const secretFocused = await page<boolean>(surface.window, `document.activeElement?.id === "credential-secret"`);
    surface.window.webContents.insertText(SYNTHETIC_CANARY);
    const localFormat = await page<Record<string, unknown>>(surface.window, `(() => { const format = document.querySelector("#credential-secret-format"); const clear = [...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Clear"); const submit = [...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Save securely"); return { tone: format?.getAttribute("data-tone"), text: format?.textContent ?? "", clearDisabled: clear?.hasAttribute("disabled") ?? true, submitDisabled: submit?.hasAttribute("disabled") ?? true }; })()`);
    await page(surface.window, `[...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Clear")?.click()`);
    const cleared = await page<Record<string, unknown>>(surface.window, `(() => ({ valueLength: document.querySelector("#credential-secret")?.value.length ?? -1, activeId: document.activeElement?.id ?? null, clearDisabled: [...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Clear")?.hasAttribute("disabled") ?? false, format: document.querySelector("#credential-secret-format")?.textContent ?? "" }))()`);
    record("local-format-and-clear", localFormat["tone"] === "warn" && !String(localFormat["text"]).includes(SYNTHETIC_CANARY) && localFormat["clearDisabled"] === false && localFormat["submitDisabled"] === false && cleared["valueLength"] === 0 && cleared["activeId"] === "credential-secret" && cleared["clearDisabled"] === true && String(cleared["format"]).startsWith("Field cleared"), { localFormat, cleared });
    surface.window.webContents.insertText(SYNTHETIC_CANARY);
    const submitFocusPath: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 8; index += 1) {
      const focused = await page<Record<string, unknown>>(surface.window, `({ id: document.activeElement?.id ?? null, tag: document.activeElement?.tagName ?? null, text: document.activeElement?.textContent?.trim() ?? null, type: document.activeElement?.getAttribute("type") ?? null })`);
      submitFocusPath.push(focused);
      if (focused["text"] === "Save securely") break;
      await press(surface.window, "Tab");
    }
    const submitFocused = await page<string>(surface.window, `document.activeElement?.textContent ?? ""`);
    surface.armGate("save");
    surface.armGate("describe");
    await press(surface.window, "Enter");
    await surface.waitForGate("save");
    await press(surface.window, "Escape");
    await press(surface.window, "Escape");
    await press(surface.window, "Escape");
    const entryMutationPending = await page<Record<string, unknown>>(surface.window, `(() => {
      const actions = [...document.querySelectorAll(".provider-card .button-row button"), document.querySelector('[data-focus-key="add-provider"]')].filter(Boolean);
      const dialogButtons = [...document.querySelectorAll("dialog button")];
      return {
        dialogOpen: document.querySelector("dialog")?.hasAttribute("open") ?? false,
        cancelDisabled: dialogButtons.find((node) => node.textContent?.trim() === "Cancel and close")?.hasAttribute("disabled") ?? false,
        submitDisabled: dialogButtons.find((node) => node.textContent?.trim() === "Save securely")?.hasAttribute("disabled") ?? false,
        fieldsDisabled: [...document.querySelectorAll("dialog fieldset, #credential-authorized-by, #credential-secret, #credential-nickname, dialog input[type=checkbox]")].every((node) => node.hasAttribute("disabled")),
        actionCount: actions.length,
        allDisabled: actions.length > 0 && actions.every((node) => node.hasAttribute("disabled") && node.getAttribute("title") === "A storage change is in progress"),
        progressDuration: getComputedStyle(document.querySelector("dialog .progress"), "::after").animationDuration,
        focusInside: document.querySelector("dialog")?.contains(document.activeElement) ?? false,
        busyFocus: document.activeElement?.getAttribute("data-busy-focus") ?? null,
        busyName: document.activeElement?.textContent?.trim() ?? null
      };
    })()`);
    record("entry-mutation-in-flight-ui-lock", entryMutationPending["dialogOpen"] === true && entryMutationPending["cancelDisabled"] === true && entryMutationPending["submitDisabled"] === true && entryMutationPending["fieldsDisabled"] === true && Number(entryMutationPending["actionCount"]) === 5 && entryMutationPending["allDisabled"] === true && entryMutationPending["progressDuration"] === "30s" && entryMutationPending["focusInside"] === true && entryMutationPending["busyFocus"] === "true" && String(entryMutationPending["busyName"]).includes("Encrypting"), entryMutationPending);
    surface.releaseGate("save");
    await surface.waitForGate("describe");
    const postCommitPending = await page<Record<string, unknown>>(surface.window, `(() => { const actions = [...document.querySelectorAll(".detail-card .button-row button")]; return { dialog: document.querySelector("dialog") !== null, actionCount: actions.length, allDisabled: actions.length > 0 && actions.every((node) => node.hasAttribute("disabled")), reasons: actions.map((node) => node.getAttribute("title")), visible: document.querySelector(".action-reasons")?.textContent ?? null }; })()`);
    record("post-commit-refresh-blocking", postCommitPending["dialog"] === false && Number(postCommitPending["actionCount"]) > 0 && postCommitPending["allDisabled"] === true && (postCommitPending["reasons"] as unknown[]).every((reason) => reason === "A storage change is in progress") && String(postCommitPending["visible"]).includes("A storage change is in progress"), postCommitPending);
    surface.releaseGate("describe");
    await waitFor(surface.window, `document.querySelector("dialog") === null && document.querySelector(".detail-card") !== null && document.querySelector('[data-focus-key="validate-anthropic"]') === null && (document.querySelector("#status-region")?.textContent ?? "").includes("Saved securely")`);
    await delay(100);
    await waitFor(surface.window, `document.activeElement?.tagName === "H1"`);

    const saved = await page<Record<string, unknown>>(surface.window, `(() => ({
      passwordCount: document.querySelectorAll('input[type="password"]').length,
      canaryInValues: [...document.querySelectorAll("input")].some((node) => node.value.includes(${JSON.stringify(SYNTHETIC_CANARY)})),
      canaryInText: (document.body.textContent ?? "").includes(${JSON.stringify(SYNTHETIC_CANARY)}),
      status: document.querySelector(".badge")?.textContent ?? null,
      notice: document.querySelector(".notice")?.textContent ?? null,
      active: document.activeElement?.tagName ?? null,
      validatePresent: document.querySelector('[data-focus-key="validate-anthropic"]') !== null,
      visibleDisabledReason: [...document.querySelectorAll(".action-reasons")].map((node) => node.textContent ?? "").join(" "),
      visibleNoticeRole: document.querySelector(".notice")?.getAttribute("role") ?? null,
      populatedLiveRegions: [document.querySelector("#status-region")?.textContent, document.querySelector("#alert-region")?.textContent].filter((text) => (text ?? "").trim().length > 0).length,
      duplicateIds: [...document.querySelectorAll("[id]")].length - new Set([...document.querySelectorAll("[id]")].map((node) => node.id)).size
    }))()`);
    record("keyboard-save-and-cleanup", secretFocused && submitFocused.trim() === "Save securely" && !entryFocusPath.some((item) => item["id"] === "credential-authorized-by") && saved["passwordCount"] === 0 && saved["canaryInValues"] === false && saved["canaryInText"] === false && saved["status"] === "Saved · not validated" && saved["active"] === "H1" && saved["duplicateIds"] === 0, { secretFocused, submitFocused, entryFocusPath, submitFocusPath, saved });
    await mark("happy-saved");
    record("clipboard-main-result", surface.control.clipboard.clears === 1 && String(saved["notice"]).includes("current clipboard item was cleared") && String(saved["notice"]).includes("history or cloud sync"), { clears: surface.control.clipboard.clears, notice: saved["notice"] });
    record("single-result-announcement", saved["visibleNoticeRole"] === "region" && saved["populatedLiveRegions"] === 1, { visibleNoticeRole: saved["visibleNoticeRole"], populatedLiveRegions: saved["populatedLiveRegions"] });
    record("save-never-validates", surface.validation.dispatches() === 0, surface.validation.dispatches());
    record("validation-authorization-unavailable-hidden", saved["validatePresent"] === false && !String(saved["visibleDisabledReason"]).includes("Live validation is off in this build"), { present: saved["validatePresent"], visible: saved["visibleDisabledReason"] });

    const normalActions = await page<Array<Record<string, unknown>>>(surface.window, `[...document.querySelectorAll(".detail-card .button-row button")].map((node) => ({ label: node.textContent?.trim() ?? "", disabled: node.hasAttribute("disabled"), reason: node.getAttribute("title") }))`);
    const disabledDangerStyle = await page<Record<string, unknown>>(surface.window, `(() => {
      const remove = document.querySelector('[data-focus-key="remove-anthropic"]');
      const rotate = document.querySelector('[data-focus-key="rotate-anthropic"]');
      if (!(remove instanceof HTMLButtonElement) || !(rotate instanceof HTMLButtonElement)) return { comparable: false };
      const removeStyle = getComputedStyle(remove);
      const rotateStyle = getComputedStyle(rotate);
      return { comparable: remove.disabled && rotate.disabled, removeColor: removeStyle.color, rotateColor: rotateStyle.color, removeBorder: removeStyle.borderColor, rotateBorder: rotateStyle.borderColor };
    })()`);
    const renderPerformance = await page<Record<string, unknown>>(surface.window, `(async () => {
      const tasks = [];
      let observer = null;
      try { observer = new PerformanceObserver((list) => tasks.push(...list.getEntries().map((entry) => entry.duration))); observer.observe({ type: "longtask" }); } catch {}
      const started = performance.now();
      document.querySelector("#mode-toggle")?.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      document.querySelector('dialog input[value="developer"]')?.click();
      [...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Apply mode")?.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      observer?.disconnect();
      return { frameMs: performance.now() - started, longTasks: tasks };
    })()`);
    const developerActions = await page<Array<Record<string, unknown>>>(surface.window, `[...document.querySelectorAll(".detail-card .button-row button")].map((node) => ({ label: node.textContent?.trim() ?? "", disabled: node.hasAttribute("disabled"), reason: node.getAttribute("title") }))`);
    const developerFacts = await page<Record<string, unknown>>(surface.window, `(() => { const text = document.querySelector(".dev-block")?.textContent ?? ""; return { count: document.querySelectorAll(".dev-block").length, text, buttons: document.querySelectorAll(".dev-block button").length, fullHexVisible: /\\b[0-9a-f]{64}\\b/iu.test(text), truncatedFingerprints: (text.match(/fp:[0-9a-f]{4}…[0-9a-f]{4}/giu) ?? []).length }; })()`);
    const committedActionsTruthful = normalActions.every((action) => action["label"] !== "Validate connection" && action["disabled"] === true && action["reason"] === "Reopen credential setup before another storage change");
    const disabledDangerNeutral = disabledDangerStyle["comparable"] === true && disabledDangerStyle["removeColor"] === disabledDangerStyle["rotateColor"] && disabledDangerStyle["removeBorder"] === disabledDangerStyle["rotateBorder"];
    record("mode-action-parity", normalActions.length > 0 && JSON.stringify(normalActions) === JSON.stringify(developerActions) && committedActionsTruthful && disabledDangerNeutral && developerFacts["count"] === 1 && developerFacts["buttons"] === 0 && developerFacts["fullHexVisible"] === false && Number(developerFacts["truncatedFingerprints"]) >= 3, { normalActions, developerActions, committedActionsTruthful, disabledDangerNeutral, disabledDangerStyle, developerFacts });
    record("render-performance", Number(renderPerformance["frameMs"]) < 60 && Array.isArray(renderPerformance["longTasks"]) && renderPerformance["longTasks"].length === 0, renderPerformance);

    const contrast = await page<Record<string, unknown>>(surface.window, `(() => {
      const vars = getComputedStyle(document.documentElement);
       const parse = (value) => { let hex = value.trim().replace("#", ""); if (hex.length === 3) hex = [...hex].map((part) => part + part).join(""); return [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16)]; };
      const lum = (rgb) => rgb.map((part) => { const value = part / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126,.7152,.0722][index], 0);
      const ratio = (left, right) => { const a = lum(parse(vars.getPropertyValue(left))); const b = lum(parse(vars.getPropertyValue(right))); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05); };
       const pairs = [["--text","--bg"],["--muted","--bg"],["--muted","--surface-1"],["--accent","--bg"],["--ok","--bg"],["--warn","--bg"],["--danger","--bg"],["--dev","--surface-2"],["--text","--accent-fill"]];
       const values = pairs.map(([foreground, background]) => ({ foreground, background, ratio: foreground === "--text" && background === "--accent-fill" ? (() => { const a = lum(parse("#fff")); const b = lum(parse(vars.getPropertyValue(background))); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05); })() : ratio(foreground, background) }));
       const nonTextPairs = [["--border","--surface-2"],["--border","--bg"],["--border","--surface-1"],["--accent-fill","--surface-2"]];
       const nonTextValues = nonTextPairs.map(([foreground, background]) => ({ foreground, background, ratio: ratio(foreground, background) }));
       const infoBadge = document.querySelector('.badge[data-tone="info"]');
       let infoBadgeBoundary = null;
       if (infoBadge instanceof Element) {
         const surface = infoBadge.closest(".card");
         const borderColor = getComputedStyle(infoBadge).borderTopColor;
         const surfaceColor = surface instanceof Element ? getComputedStyle(surface).backgroundColor : getComputedStyle(document.documentElement).backgroundColor;
         const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
         const context = canvas.getContext("2d", { willReadFrequently: true });
         if (context !== null) {
           context.fillStyle = surfaceColor; context.fillRect(0, 0, 1, 1); const background = [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
           context.fillStyle = borderColor; context.fillRect(0, 0, 1, 1); const composite = [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
           const backgroundLum = lum(background); const compositeLum = lum(composite);
           infoBadgeBoundary = { borderColor, surfaceColor, background, composite, ratio: (Math.max(backgroundLum, compositeLum) + .05) / (Math.min(backgroundLum, compositeLum) + .05) };
         }
       }
       const actualRatios = infoBadgeBoundary === null ? [] : [infoBadgeBoundary.ratio];
       return { minimum: Math.min(...values.map((item) => item.ratio)), values, nonTextMinimum: Math.min(...nonTextValues.map((item) => item.ratio), ...actualRatios), nonTextValues, infoBadgeBoundary };
     })()`);
    record("wcag-aa-contrast", Number(contrast["minimum"]) >= 4.5, contrast);
    record("wcag-non-text-control-boundary-contrast", Number(contrast["nonTextMinimum"]) >= 3, contrast["nonTextValues"]);
    record("info-badge-composited-boundary-contrast", contrast["infoBadgeBoundary"] !== null && Number((contrast["infoBadgeBoundary"] as Record<string, unknown>)["ratio"]) >= 3, contrast["infoBadgeBoundary"]);

    const viewports: Array<Record<string, unknown>> = [];
    for (const [width, height] of [[900, 700], [1180, 780], [2560, 1440]] as const) {
      surface.window.setContentSize(width, height);
      await delay(80);
      viewports.push(await page<Record<string, unknown>>(surface.window, `(() => ({ requested: [${width},${height}], inner: [innerWidth,innerHeight], horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth || document.querySelector("main").scrollWidth > document.querySelector("main").clientWidth, clippedBadges: [...document.querySelectorAll(".badge")].some((node) => node.scrollWidth > node.clientWidth + 1) }))()`));
    }
    record("responsive-viewports", viewports.every((item) => item["horizontalOverflow"] === false && item["clippedBadges"] === false), viewports);
    await mark("happy-viewports");

    surface.window.setContentSize(1180, 780);
    await delay(80);
    if (previewPath !== null) {
      await mkdir(dirname(resolve(previewPath)), { recursive: true });
      surface.window.setContentProtection(false);
      const image = await surface.window.webContents.capturePage();
      await writeFile(resolve(previewPath), image.toPNG());
      surface.window.setContentProtection(true);
      record("synthetic-preview", !image.isEmpty() && image.getSize().width > 800 && image.getSize().height > 600, image.getSize());
    }
    await mark("happy-preview");

    const boundary = await page<Record<string, unknown>>(surface.window, `(async () => {
      const before = location.href;
      const popup = window.open("https://example.invalid/");
      let fetchRejected = false;
      try { await fetch("https://example.invalid/"); } catch { fetchRejected = true; }
      const permission = await navigator.permissions.query({ name: "geolocation" });
      return { popupDenied: popup === null, fetchRejected, permission: permission.state, before, after: location.href };
    })()`);
    record("runtime-boundary-denials", boundary["popupDenied"] === true && boundary["fetchRejected"] === true && boundary["permission"] === "denied" && boundary["before"] === boundary["after"], boundary);
    record("diagnostic-canary", surface.consoleCanary() === false && surface.rendererGone() === false && JSON.stringify(surface.control.audit).includes(SYNTHETIC_CANARY) === false, { consoleCanary: surface.consoleCanary(), rendererGone: surface.rendererGone(), auditRecords: surface.control.audit.length });
    await mark("happy-boundaries");
  } finally {
    await closeSurface(surface);
  }

  const rendererRoot = resolve(appRoot, "dist", "renderer", "credential");
  const protocolResults = {
    entry: resolveCredentialProtocolRequest(CREDENTIAL_ENTRY_URL, rendererRoot),
    unexpected: resolveCredentialProtocolRequest("app-credential://entry/unexpected.json", rendererRoot),
    traversal: resolveCredentialProtocolRequest("app-credential://entry/%2e%2e/main/main.js", rendererRoot),
  };
  record("real-protocol-allowlist", protocolResults.entry.status === 200 && protocolResults.unexpected.status !== 200 && protocolResults.traversal.status !== 200, protocolResults);
  await mark("happy-complete");
}

async function runInFlightActionRegression(): Promise<void> {
  await mark("in-flight-started");
  const surface = await openSurface({ seedCredential: true, validationEnabled: true });
  try {
    await page(surface.window, `document.querySelector('[data-focus-key="manage-anthropic"]')?.click()`);
    await waitFor(surface.window, `document.querySelector('[data-focus-key="validate-anthropic"]') !== null`);
    surface.armGate("validate");
    await page(surface.window, `document.querySelector('[data-focus-key="validate-anthropic"]')?.click()`);
    await waitFor(surface.window, `document.querySelector("dialog") !== null`);
    await page(surface.window, `[...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Confirm and validate")?.click()`);
    await surface.waitForGate("validate");
    const readValidationInFlightLock = async (): Promise<Record<string, unknown>> => await page<Record<string, unknown>>(surface.window, `(() => {
      const actions = [...document.querySelectorAll(".detail-card .button-row button")];
      const dialogButtons = [...document.querySelectorAll("dialog button")];
      const dialog = document.querySelector("dialog");
      const tracker = globalThis["__aiDevOsValidationEscapeTracker"];
      return {
        dialogOpen: dialog?.hasAttribute("open") ?? false,
        cancelDisabled: dialogButtons.find((node) => node.textContent?.trim() === "Cancel")?.hasAttribute("disabled") ?? false,
        submitDisabled: dialogButtons.find((node) => node.textContent?.trim() === "Confirm and validate")?.hasAttribute("disabled") ?? false,
        actionCount: actions.length,
        allDisabled: actions.length > 0 && actions.every((node) => node.hasAttribute("disabled")),
        validateReason: actions.find((node) => node.textContent?.trim() === "Validate connection")?.getAttribute("title") ?? null,
        storageReasons: actions.filter((node) => node.textContent?.trim() !== "Validate connection").map((node) => node.getAttribute("title")),
        visible: document.querySelector(".action-reasons")?.textContent ?? "",
        progressDuration: getComputedStyle(document.querySelector("dialog .progress"), "::after").animationDuration,
        focusInside: dialog?.contains(document.activeElement) ?? false,
        busyFocus: document.activeElement?.getAttribute("data-busy-focus") ?? null,
        busyName: document.activeElement?.textContent?.trim() ?? null,
        escapeTrackerPresent: tracker !== undefined,
        sameDialog: tracker === undefined ? null : tracker.dialog === dialog,
        escapeCancelCount: tracker?.cancelCount ?? null,
        escapePreventedCount: tracker?.preventedCount ?? null,
        escapeUnpreventedCount: tracker?.unpreventedCount ?? null,
        escapeCloseCount: tracker?.closeCount ?? null,
        escapeOpenLost: tracker?.openLost ?? null,
        escapeDialogReplaced: tracker?.dialogReplaced ?? null,
        escapeControlsUnlocked: tracker?.controlsUnlocked ?? null
      };
    })()`);
    const validationInFlightUiLocked = (candidate: Record<string, unknown>): boolean => candidate["dialogOpen"] === true && candidate["cancelDisabled"] === true && candidate["submitDisabled"] === true && Number(candidate["actionCount"]) === 4 && candidate["allDisabled"] === true && candidate["validateReason"] === "A credential validation check is in progress" && Array.isArray(candidate["storageReasons"]) && (candidate["storageReasons"] as unknown[]).every((reason) => reason === "A credential validation check is in progress") && String(candidate["visible"]).includes("A credential validation check is in progress") && candidate["progressDuration"] === "12s" && candidate["focusInside"] === true && candidate["busyFocus"] === "true" && String(candidate["busyName"]).includes("Validating");
    const waitForValidationInFlightLock = async (predicate: (candidate: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + 5_000;
      let candidate = await readValidationInFlightLock();
      while (!predicate(candidate) && Date.now() < deadline) {
        await delay(25);
        candidate = await readValidationInFlightLock();
      }
      return candidate;
    };
    const beforeEscape = await waitForValidationInFlightLock(validationInFlightUiLocked);
    await page(surface.window, `(() => {
      const dialog = document.querySelector("dialog[open]");
      if (dialog === null) return false;
      const tracker = { dialog, cancelCount: 0, preventedCount: 0, unpreventedCount: 0, closeCount: 0, openLost: false, dialogReplaced: false, controlsUnlocked: false, observer: null };
      dialog.addEventListener("cancel", (event) => {
        tracker.cancelCount += 1;
        if (event.defaultPrevented) tracker.preventedCount += 1;
        else tracker.unpreventedCount += 1;
      });
      dialog.addEventListener("close", () => { tracker.closeCount += 1; tracker.openLost = true; });
      const observe = () => {
        if (!dialog.isConnected || !dialog.open) tracker.openLost = true;
        if (document.querySelector("dialog") !== dialog) tracker.dialogReplaced = true;
        const actions = [...document.querySelectorAll(".detail-card .button-row button")];
        const dialogButtons = [...dialog.querySelectorAll("button")];
        if (actions.length !== 4 || dialogButtons.length !== 2 || [...actions, ...dialogButtons].some((node) => !node.hasAttribute("disabled"))) tracker.controlsUnlocked = true;
      };
      tracker.observer = new MutationObserver(observe);
      tracker.observer.observe(document.body, { attributes: true, attributeFilter: ["open", "disabled"], childList: true, subtree: true });
      globalThis["__aiDevOsValidationEscapeTracker"] = tracker;
      return true;
    })()`);
    const validationEscapeLockHeld = (candidate: Record<string, unknown>, escapeCount: number): boolean => {
      const closeCount = Number(candidate["escapeCloseCount"]);
      return validationInFlightUiLocked(candidate) && candidate["escapeTrackerPresent"] === true && candidate["sameDialog"] === true && Number(candidate["escapeCancelCount"]) === escapeCount && Number(candidate["escapePreventedCount"]) + Number(candidate["escapeUnpreventedCount"]) === escapeCount && Number.isInteger(closeCount) && closeCount >= 0 && closeCount <= escapeCount && Number(candidate["escapeUnpreventedCount"]) === closeCount && candidate["escapeOpenLost"] === (closeCount > 0) && candidate["escapeDialogReplaced"] === false && candidate["escapeControlsUnlocked"] === false;
    };
    const escapeObservations: Record<string, unknown>[] = [];
    for (let escapeCount = 1; escapeCount <= 3; escapeCount += 1) {
      await press(surface.window, "Escape");
      escapeObservations.push(await waitForValidationInFlightLock((candidate) => validationEscapeLockHeld(candidate, escapeCount)));
    }
    await page(surface.window, `(() => { const tracker = globalThis["__aiDevOsValidationEscapeTracker"]; tracker?.observer?.disconnect(); delete globalThis["__aiDevOsValidationEscapeTracker"]; })()`);
    const escapeResistanceHeld = escapeObservations.every((candidate, index) => validationEscapeLockHeld(candidate, index + 1));
    record("validation-in-flight-ui-lock", validationInFlightUiLocked(beforeEscape) && escapeResistanceHeld, { beforeEscape, escapeObservations });
    surface.releaseGate("validate");
    await waitFor(surface.window, `document.querySelector("dialog") === null && (document.querySelector(".badge")?.textContent ?? "").startsWith("Validated") && document.activeElement?.tagName === "H1"`);
    const normalValidationLanguage = await page<Record<string, unknown>>(surface.window, `(() => {
      const term = [...document.querySelectorAll(".facts dt")].find((node) => node.textContent?.trim() === "Last validation");
      const value = term?.nextElementSibling?.textContent?.trim() ?? "";
      const view = document.querySelector(".view")?.textContent ?? "";
      return { value, rawOutcomeVisible: /(^|\\s)(valid|invalid|unauthorized|ambiguous|unreachable)(\\s|·|$)/iu.test(view), developerBlocks: document.querySelectorAll(".dev-block").length, focusTag: document.activeElement?.tagName ?? null, validatePresent: document.querySelector('[data-focus-key="validate-anthropic"]') !== null };
    })()`);
    record("normal-validation-language-and-consumed-focus", String(normalValidationLanguage["value"]).startsWith("Accepted · ") && normalValidationLanguage["rawOutcomeVisible"] === false && normalValidationLanguage["developerBlocks"] === 0 && normalValidationLanguage["focusTag"] === "H1" && normalValidationLanguage["validatePresent"] === false, normalValidationLanguage);

    await page(surface.window, `document.querySelector('[data-focus-key="remove-anthropic"]')?.click()`);
    await waitFor(surface.window, `document.querySelector("dialog") !== null`);
    await page(surface.window, `document.querySelector('dialog input[type="checkbox"]')?.click()`);
    surface.armGate("remove");
    await page(surface.window, `[...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Remove from this PC")?.click()`);
    await surface.waitForGate("remove");
    await press(surface.window, "Escape");
    await press(surface.window, "Escape");
    await press(surface.window, "Escape");
    const removing = await page<Record<string, unknown>>(surface.window, `(() => {
      const actions = [...document.querySelectorAll(".detail-card .button-row button")];
      const dialogButtons = [...document.querySelectorAll("dialog button")];
      const acknowledgement = document.querySelector("dialog label.check");
      return {
        dialogOpen: document.querySelector("dialog")?.hasAttribute("open") ?? false,
        keepDisabled: dialogButtons.find((node) => node.textContent?.trim() === "Keep credential")?.hasAttribute("disabled") ?? false,
        submitDisabled: dialogButtons.find((node) => node.textContent?.trim() === "Remove from this PC")?.hasAttribute("disabled") ?? false,
        actionCount: actions.length,
        allDisabled: actions.length > 0 && actions.every((node) => node.hasAttribute("disabled") && node.getAttribute("title") === "A storage change is in progress"),
        visible: document.querySelector(".action-reasons")?.textContent ?? "",
        described: (() => { const dialog = document.querySelector("dialog"); const id = dialog?.getAttribute("aria-describedby") ?? ""; return id.length > 0 && (document.getElementById(id)?.textContent ?? "").includes("does not revoke"); })(),
        acknowledgementTargetHeight: acknowledgement?.getBoundingClientRect().height ?? 0,
        progressDuration: getComputedStyle(document.querySelector("dialog .progress"), "::after").animationDuration,
        focusInside: document.querySelector("dialog")?.contains(document.activeElement) ?? false,
        busyFocus: document.activeElement?.getAttribute("data-busy-focus") ?? null,
        busyName: document.activeElement?.textContent?.trim() ?? null
      };
    })()`);
    record("removal-in-flight-ui-lock", removing["dialogOpen"] === true && removing["keepDisabled"] === true && removing["submitDisabled"] === true && Number(removing["actionCount"]) === 3 && removing["allDisabled"] === true && String(removing["visible"]).includes("A storage change is in progress") && removing["described"] === true && Number(removing["acknowledgementTargetHeight"]) >= 24 && removing["progressDuration"] === "30s" && removing["focusInside"] === true && removing["busyFocus"] === "true" && String(removing["busyName"]).includes("Removing"), removing);
    surface.releaseGate("remove");
    await waitFor(surface.window, `document.querySelector("dialog") === null && document.querySelector(".badge")?.textContent === "Removed"`);
    const removedCommitted = await page<Record<string, unknown>>(surface.window, `(() => {
      const status = document.querySelector(".detail-card > .sub")?.textContent ?? "";
      const storageTerm = [...document.querySelectorAll(".facts dt")].find((node) => node.textContent?.trim() === "Storage");
      const reenter = document.querySelector('[data-focus-key="reenter-anthropic"]');
      return { status, storage: storageTerm?.nextElementSibling?.textContent ?? "", notice: document.querySelector(".notice")?.textContent ?? "", disabled: reenter?.hasAttribute("disabled") ?? false, reason: reenter?.getAttribute("title") ?? "" };
    })()`);
    record("post-remove-reentry-requires-reopen", String(removedCommitted["status"]).includes("Reopen credential setup to re-enter") && String(removedCommitted["storage"]).includes("reopen credential setup to re-enter") && String(removedCommitted["notice"]).includes("provider credential may still work at Anthropic") && String(removedCommitted["notice"]).includes("revoke it there") && removedCommitted["disabled"] === true && removedCommitted["reason"] === "Reopen credential setup before another storage change", removedCommitted);
  } finally {
    await closeSurface(surface);
  }
  await mark("in-flight-complete");
}

async function runRecoveryAndMetadataRegressions(): Promise<void> {
  await mark("recovery-metadata-started");
  const loading = await openSurface({ gateInitialDescribe: true, validationEnabled: true });
  try {
    await loading.waitForGate("describe");
    loading.window.setContentSize(900, 700);
    await delay(80);
    const pending = await page<Record<string, unknown>>(loading.window, `(() => ({ summary: document.querySelector(".strip strong")?.textContent ?? "", validation: document.querySelector(".strip span:last-child")?.textContent ?? "", disabled: document.querySelector('[data-focus-key="add-provider"]')?.hasAttribute("disabled") ?? false, reason: document.querySelector('[data-focus-key="add-provider"]')?.getAttribute("title") ?? "", visible: document.querySelector(".global-action-reason")?.textContent ?? "", pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth, headerFits: document.querySelector(".view-head")?.scrollWidth <= document.querySelector(".view-head")?.clientWidth }))()`);
    record("initial-storage-loading-is-not-recovery", String(pending["summary"]).includes("Loading secure storage") && pending["validation"] === "Loading validation availability" && pending["disabled"] === true && pending["reason"] === "Secure storage is loading" && String(pending["visible"]).includes("Secure storage is loading") && !String(pending["visible"]).includes("recovery") && !String(pending["validation"]).includes("disabled") && pending["pageFits"] === true && pending["headerFits"] === true, pending);
    loading.releaseGate("describe");
    await waitFor(loading.window, `document.querySelectorAll(".provider-card").length === 4`);
  } finally { await closeSurface(loading); }

  const initialRefusal = await openSurface({ describeRefusalAfter: 1 });
  try {
    const refused = await page<Record<string, unknown>>(initialRefusal.window, `(() => ({ notice: document.querySelector(".notice")?.textContent ?? "", addDisabled: document.querySelector('[data-focus-key="add-provider"]')?.hasAttribute("disabled") ?? false, reason: document.querySelector('[data-focus-key="add-provider"]')?.getAttribute("title") ?? "", visible: document.querySelector(".global-action-reason")?.textContent ?? "", loading: (document.querySelector(".global-action-reason")?.textContent ?? "").includes("loading") }))()`);
    record("initial-describe-refusal-is-terminal", String(refused["notice"]).includes("Credential details are unavailable") && String(refused["notice"]).includes("read or update did not complete") && refused["addDisabled"] === true && String(refused["reason"]).toLowerCase().includes("reopen") && String(refused["visible"]).toLowerCase().includes("reopen") && refused["loading"] === false, refused);
    await page(initialRefusal.window, `document.querySelector('button[data-view="activity"]')?.click()`);
    await waitFor(initialRefusal.window, `document.activeElement?.tagName === "H1" && document.activeElement?.textContent?.trim() === "Credential activity"`);
    const activity = await page<Record<string, unknown>>(initialRefusal.window, `(() => ({ body: document.querySelector(".activity-list")?.textContent ?? "", validation: document.querySelector(".strip span:last-child")?.textContent ?? "", focus: document.activeElement?.textContent?.trim() ?? "" }))()`);
    await page(initialRefusal.window, `document.querySelector('button[data-view="providers"]')?.click()`);
    await waitFor(initialRefusal.window, `document.activeElement?.tagName === "H1" && document.activeElement?.textContent?.trim() === "Providers & integrations"`);
    const providersFocus = await page<string>(initialRefusal.window, `document.activeElement?.textContent?.trim() ?? ""`);
    record("initial-describe-refusal-activity-is-unavailable", String(activity["body"]).includes("Credential Activity is unavailable") && String(activity["body"]).includes("no absence of earlier activity is inferred") && !String(activity["body"]).includes("Loading") && activity["validation"] === "" && activity["focus"] === "Credential activity" && providersFocus === "Providers & integrations", { activity, providersFocus });
  } finally { await closeSurface(initialRefusal); }

  const metadata = await openSurface({ seedCredential: true, viewScenario: "metadata-unavailable" });
  try {
    const overview = await page<Record<string, unknown>>(metadata.window, `(() => ({
      summary: document.querySelector(".strip strong")?.textContent ?? "",
      recovery: [...document.querySelectorAll(".notice")].map((node) => node.textContent ?? "").join(" "),
      anthropicBody: document.querySelector('[data-slot-id="anthropic"] .provider-body')?.textContent ?? "",
      manageDisabled: document.querySelector('[data-focus-key="manage-anthropic"]')?.hasAttribute("disabled") ?? false,
      manageReason: document.querySelector(".global-action-reason")?.textContent ?? ""
    }))()`);
    await page(metadata.window, `document.querySelector('.rail button[data-view="activity"]')?.click()`);
    await waitFor(metadata.window, `document.querySelector(".activity-list") !== null`);
    const activity = await page<string>(metadata.window, `document.querySelector(".activity-list")?.textContent ?? ""`);
    record("metadata-unavailable-renderer-truth", String(overview["summary"]).includes("Connection and validation details unavailable") && String(overview["recovery"]).includes("trusted backup of this same installation") && !String(overview["anthropicBody"]).includes("Anthropic credential ·") && String(overview["anthropicBody"]).includes("available actions cannot be determined") && overview["manageDisabled"] === true && String(overview["manageReason"]).includes("Restore this installation") && activity.includes("Activity and presentation details are unavailable") && !activity.includes("No credential activity recorded") && !activity.includes("SYNTHETIC_ACTIVITY_CANARY"), { overview, activity });
  } finally { await closeSurface(metadata); }

  const revokedMetadata = await openSurface({ seedState: "revoked", viewScenario: "metadata-unavailable" });
  try {
    const state = await page<Record<string, unknown>>(revokedMetadata.window, `(() => ({ summary: document.querySelector(".strip strong")?.textContent ?? "", badge: document.querySelector('[data-slot-id="anthropic"] .badge')?.textContent?.trim() ?? "", body: document.querySelector('[data-slot-id="anthropic"] .provider-body')?.textContent ?? "", reason: document.querySelector('[data-focus-key="manage-anthropic"]')?.getAttribute("title") ?? "" }))()`);
    record("revoked-metadata-loss-does-not-promise-reentry", String(state["summary"]).startsWith("0 saved credentials") && state["badge"] === "Details unavailable" && String(state["body"]).includes("Credential storage") && String(state["body"]).includes("available actions cannot be determined") && !String(state["body"]).toLowerCase().includes("re-entry") && !String(state["body"]).includes("saved encrypted credential exists") && String(state["reason"]).includes("Restore this installation"), state);
  } finally { await closeSurface(revokedMetadata); }

  const metadataTransition = await openSurface({ seedCredential: true, viewScenario: "metadata-unavailable", viewScenarioAfterDescribe: 2 });
  try {
    await openAnthropicDetail(metadataTransition);
    const before = await page<Record<string, unknown>>(metadataTransition.window, `(() => ({ detail: document.querySelector(".detail-card") !== null, nickname: document.querySelector(".detail-card h2")?.textContent ?? "" }))()`);
    await page(metadataTransition.window, `[...document.querySelectorAll(".detail-card .button-row button")].find((node) => node.textContent?.trim() === "Disable")?.click()`);
    await waitFor(metadataTransition.window, `document.querySelector(".provider-grid") !== null && document.querySelector(".detail-card") === null && (document.querySelector(".view")?.textContent ?? "").includes("Credential details need external repair")`);
    const after = await page<Record<string, unknown>>(metadataTransition.window, `(() => ({
      detail: document.querySelector(".detail-card") !== null,
      overview: document.querySelector(".provider-grid") !== null,
      fallbackNickname: (document.querySelector('[data-slot-id="anthropic"]')?.textContent ?? "").includes("Anthropic credential"),
      realNickname: (document.querySelector('[data-slot-id="anthropic"]')?.textContent ?? "").includes("Synthetic smoke"),
      instruction: [...document.querySelectorAll(".notice")].map((node) => node.textContent ?? "").join(" ")
    }))()`);
    record("metadata-loss-detail-normalizes-to-overview", before["detail"] === true && before["nickname"] === "Synthetic smoke" && after["detail"] === false && after["overview"] === true && after["fallbackNickname"] === false && after["realNickname"] === false && String(after["instruction"]).includes("trusted backup of this same installation"), { before, after });
  } finally { await closeSurface(metadataTransition); }

  const recoveryStates: Array<Record<string, unknown>> = [];
  for (const scenario of ["backup-only", "corrupt", "identity-mismatch", "backend-mismatch", "schema-ahead"] as const) {
    const surface = await openSurface({ seedCredential: true, viewScenario: scenario });
    try {
      const state = await page<Record<string, unknown>>(surface.window, `(() => ({
        summary: document.querySelector(".strip strong")?.textContent ?? "",
        statuses: [...document.querySelectorAll(".provider-card .badge")].map((node) => node.textContent?.trim()),
        actions: [...document.querySelectorAll(".provider-card button, .view-head > button")].map((node) => ({ disabled: node.hasAttribute("disabled"), reason: node.getAttribute("title") })),
        visibleReasons: [...document.querySelectorAll(".action-reasons")].map((node) => node.textContent ?? "").join(" "),
        globalReasonCount: document.querySelectorAll("#credential-global-action-reason").length,
        disabledReasonsResolved: [...document.querySelectorAll("main button:disabled[data-disabled-reason]")].every((node) => { const id = node.getAttribute("aria-describedby"); return id !== null && (document.getElementById(id)?.textContent?.trim().length ?? 0) > 0; }),
        recovery: [...document.querySelectorAll(".notice")].map((node) => node.textContent ?? "").join(" "),
        rawCode: /VAULT_[A-Z_]+/u.test(document.querySelector(".view")?.textContent ?? "")
      }))()`);
      recoveryStates.push({ scenario, ...state });
      if (scenario === "backup-only") {
        const before = await page<string[]>(surface.window, `[...document.querySelectorAll(".provider-card button, .view-head > button")].map((node) => node.textContent?.trim() ?? "")`);
        await chooseMode(surface, "developer");
        const developer = await page<Record<string, unknown>>(surface.window, `(() => { const text = [...document.querySelectorAll(".dev-block")].map((node) => node.textContent ?? "").join(" "); return { text, buttons: document.querySelectorAll(".dev-block button").length, actions: [...document.querySelectorAll(".provider-card button, .view-head > button")].map((node) => node.textContent?.trim() ?? ""), fullDigestVisible: text.includes("a".repeat(64)) || text.includes("b".repeat(64)), truncatedDigests: text.includes("fp:aaaa…aaaa") && text.includes("fp:bbbb…bbbb") }; })()`);
        record("recovery-developer-stratum", String(developer["text"]).includes("VAULT_BACKUP_ONLY") && String(developer["text"]).includes("primaryFingerprint") && String(developer["text"]).includes("backupFingerprint") && developer["fullDigestVisible"] === false && developer["truncatedDigests"] === true && developer["buttons"] === 0 && JSON.stringify(developer["actions"]) === JSON.stringify(before), developer);
      }
    } finally { await closeSurface(surface); }
  }
  record("finite-recovery-renderer-gates", recoveryStates.every((state) => String(state["summary"]).includes("counts unavailable") && (state["statuses"] as unknown[]).every((status) => status === "Recovery required") && (state["actions"] as Array<Record<string, unknown>>).every((action) => action["disabled"] === true && String(action["reason"]).includes("recovery")) && String(state["visibleReasons"]).toLowerCase().includes("unavailable") && state["globalReasonCount"] === 1 && state["disabledReasonsResolved"] === true && state["rawCode"] === false), recoveryStates);

  const unavailable = await openSurface({ encryptionAvailable: false });
  try {
    const state = await page<Record<string, unknown>>(unavailable.window, `(() => ({ summary: document.querySelector(".strip strong")?.textContent ?? "", notice: document.querySelector(".notice")?.textContent ?? "", statuses: [...document.querySelectorAll(".badge")].map((node) => node.textContent?.trim()), actionsDisabled: [...document.querySelectorAll(".provider-card button, .view-head > button")].every((node) => node.hasAttribute("disabled")), reasons: [...document.querySelectorAll(".action-reasons")].map((node) => node.textContent ?? "").join(" ") }))()`);
    record("encryption-unavailable-before-entry", String(state["summary"]).includes("counts unavailable") && String(state["notice"]).includes("Secure storage is unavailable") && (state["statuses"] as unknown[]).every((status) => status === "Secure storage unavailable") && state["actionsDisabled"] === true && String(state["reasons"]).includes("recovery"), state);
  } finally { await closeSurface(unavailable); }
  await mark("recovery-metadata-complete");
}

async function runValidationPresentationRegressions(): Promise<void> {
  await mark("validation-presentation-started");
  const cases = [
    { name: "inconclusive", outcomes: ["valid", "ambiguous"] as const, checkedAt: undefined, badge: "Check inconclusive", accepted: "0 accepted providers", check: "1 credential needs a check", attention: "0 credentials need attention", lastKnown: true },
    { name: "stale-valid", outcomes: ["valid"] as const, checkedAt: "2026-08-01T10:00:00.000Z", badge: "Check needed", accepted: "1 accepted provider", check: "1 credential needs a check", attention: "0 credentials need attention", lastKnown: false },
    { name: "old-invalid", outcomes: ["invalid"] as const, checkedAt: "2026-08-01T10:00:00.000Z", badge: "Not accepted", accepted: "0 accepted providers", check: "0 credentials need a check", attention: "1 credential needs attention", lastKnown: false },
    { name: "old-limited", outcomes: ["unauthorized"] as const, checkedAt: "2026-08-01T10:00:00.000Z", badge: "Permission limited", accepted: "1 accepted provider", check: "1 credential needs a check", attention: "0 credentials need attention", lastKnown: false },
    { name: "future-limited", outcomes: ["unauthorized"] as const, checkedAt: "2099-01-01T00:00:00.000Z", badge: "Check needed", accepted: "0 accepted providers", check: "1 credential needs a check", attention: "0 credentials need attention", lastKnown: false },
  ];
  const observed: Array<Record<string, unknown>> = [];
  for (const candidate of cases) {
    const surface = await openSurface({ seedCredential: true, seedValidationOutcomes: candidate.outcomes, ...(candidate.checkedAt === undefined ? {} : { validationCheckedAt: candidate.checkedAt }) });
    try {
      const overview = await page<Record<string, unknown>>(surface.window, `(() => ({ badge: document.querySelector('[data-slot-id="anthropic"] .badge')?.textContent?.trim() ?? "", summary: document.querySelector(".strip strong")?.textContent ?? "", raw: /(^|[·:])\\s*(valid|invalid|unauthorized|ambiguous|unreachable)(\\s*[·]|$)/imu.test(document.querySelector(".view")?.textContent ?? "") }))()`);
      await openAnthropicDetail(surface);
      const detail = await page<Record<string, unknown>>(surface.window, `(() => { const facts = Object.fromEntries([...document.querySelectorAll(".facts dt")].map((term) => [term.textContent?.trim(), term.nextElementSibling?.textContent?.trim()])); return { facts, status: document.querySelector(".detail-card .sub")?.textContent ?? "" }; })()`);
      if (candidate.name === "inconclusive") {
        await chooseMode(surface, "developer");
        const developer = await page<string>(surface.window, `[...document.querySelectorAll(".dev-block")].map((node) => node.textContent ?? "").join(" ")`);
        detail["developer"] = developer;
      }
      observed.push({ ...candidate, overview, detail });
    } finally { await closeSurface(surface); }
  }
  record("validation-state-union-and-freshness", observed.every((item) => {
    const overview = item["overview"] as Record<string, unknown>;
    const detail = item["detail"] as Record<string, unknown>;
    const facts = detail["facts"] as Record<string, unknown>;
    return overview["badge"] === item["badge"] && String(overview["summary"]).includes(String(item["accepted"])) && String(overview["summary"]).includes(String(item["check"])) && String(overview["summary"]).includes(String(item["attention"])) && overview["raw"] === false && (item["lastKnown"] !== true || String(facts["Last known result"]).startsWith("Accepted ·")) && (item["name"] !== "future-limited" || String(facts["Last validation"]).startsWith("Provider acceptance unavailable")) && (item["name"] !== "inconclusive" || String(detail["developer"]).includes("lastAttempt.checkedAt") && String(detail["developer"]).includes("validation.checkedAt"));
  }), observed);

  const nearStaleAt = new Date(Date.now() - (7 * 24 * 60 * 60 * 1_000) + 5_000).toISOString();
  const ageTick = await openSurface({ seedCredential: true, seedValidationOutcomes: ["valid"], validationCheckedAt: nearStaleAt });
  try {
    const before = await page<Record<string, unknown>>(ageTick.window, `(() => { const nav = document.querySelector('[data-focus-key="nav-providers"]'); if (nav instanceof HTMLElement) nav.focus(); return { badge: document.querySelector('[data-slot-id="anthropic"] .badge')?.textContent?.trim() ?? "", focus: document.activeElement?.getAttribute("data-focus-key") ?? "", status: document.querySelector("#status-region")?.textContent ?? "", alert: document.querySelector("#alert-region")?.textContent ?? "" }; })()`);
    const describeCallsBefore = ageTick.describeCalls();
    await delay(5_200);
    await page(ageTick.window, `document.dispatchEvent(new Event("visibilitychange"))`);
    await waitFor(ageTick.window, `document.querySelector('[data-slot-id="anthropic"] .badge')?.textContent?.trim() === "Check needed"`);
    const after = await page<Record<string, unknown>>(ageTick.window, `(() => { const view = document.querySelector(".view"); const style = view === null ? null : getComputedStyle(view); return { badge: document.querySelector('[data-slot-id="anthropic"] .badge')?.textContent?.trim() ?? "", focus: document.activeElement?.getAttribute("data-focus-key") ?? "", status: document.querySelector("#status-region")?.textContent ?? "", alert: document.querySelector("#alert-region")?.textContent ?? "", ageOnly: view?.classList.contains("age-only") ?? false, animationName: style?.animationName ?? "", animationDuration: style?.animationDuration ?? "" }; })()`);
    record("relative-validation-age-updates-without-ipc-animation-or-live-repeat", String(before["badge"]).startsWith("Validated") && before["focus"] === "nav-providers" && after["badge"] === "Check needed" && after["focus"] === "nav-providers" && after["status"] === before["status"] && after["alert"] === before["alert"] && after["ageOnly"] === true && after["animationName"] === "none" && after["animationDuration"] === "0s" && ageTick.describeCalls() === describeCallsBefore, { before, after, describeCallsBefore, describeCallsAfter: ageTick.describeCalls() });
  } finally { await closeSurface(ageTick); }

  const groupCases = [
    { scenario: "mixed" as const, badge: "Connected · 1 credential unvalidated", tone: "ok" },
    { scenario: "all-disabled" as const, badge: "All credentials disabled", tone: "neutral" },
    { scenario: "saved-only" as const, badge: "Saved · not validated", tone: "neutral" },
    { scenario: "inconclusive" as const, badge: "Check needed", tone: "warn" },
    { scenario: "stale" as const, badge: "Check getting stale", tone: "warn" },
    { scenario: "invalid" as const, badge: "Needs attention", tone: "danger" },
    { scenario: "unreadable" as const, badge: "Credentials can't be read", tone: "danger" },
    { scenario: "metadata-unavailable" as const, badge: "Details unavailable", tone: "warn" },
    { scenario: "recovery" as const, badge: "Recovery required", tone: "danger" },
  ];
  const groupObservations: Array<Record<string, unknown>> = [];
  for (const candidate of groupCases) {
    const surface = await openSurface({ seedCredential: true, viewScenario: "multi-anthropic", multiCredentialScenario: candidate.scenario });
    try {
      const observation = await page<Record<string, unknown>>(surface.window, `(() => { const card = document.querySelector('[data-slot-id="anthropic"]'); const body = card?.querySelector(".provider-body")?.textContent ?? ""; const disabled = [...document.querySelectorAll("main button:disabled[data-disabled-reason]")]; return { summary: document.querySelector(".strip strong")?.textContent ?? "", providerCards: document.querySelectorAll(".provider-card").length, anthropicCards: document.querySelectorAll('[data-slot-id="anthropic"]').length, credentialCount: card?.getAttribute("data-credential-count") ?? null, badge: card?.querySelector(".badge")?.textContent?.trim() ?? "", tone: card?.querySelector(".badge")?.getAttribute("data-tone") ?? "", body, manageDisabled: card?.querySelector("button")?.hasAttribute("disabled") ?? false, reason: document.querySelector(".global-action-reason")?.textContent ?? card?.querySelector(".action-reasons")?.textContent ?? "", globalReasonCount: document.querySelectorAll("#credential-global-action-reason").length, disabledReasonsResolved: disabled.length > 0 && disabled.every((node) => { const id = node.getAttribute("aria-describedby"); return id !== null && (document.getElementById(id)?.textContent?.trim().length ?? 0) > 0; }), recoveryDisclosureSafe: !/(^|\s)\d+ saved|accepted by the provider|disabled credential/iu.test(body), metadataDisclosureSafe: !/accepted by the provider|needs a check|disabled credential/iu.test(body) }; })()`);
      const observed: Record<string, unknown> = { scenario: candidate.scenario, expectedBadge: candidate.badge, expectedTone: candidate.tone, ...observation };
      if (candidate.scenario === "mixed") {
        await page(surface.window, `document.querySelector('[data-focus-key="add-provider"]')?.click()`);
        await waitFor(surface.window, `document.querySelector(".provider-picker") !== null`);
        const picker = await page<Record<string, unknown>>(surface.window, `(() => { const rows = [...document.querySelectorAll(".provider-picker > li")]; const anthropic = rows.filter((row) => row.getAttribute("data-slot-id") === "anthropic"); const button = anthropic[0]?.querySelector("button"); const active = document.activeElement; return { rows: rows.length, anthropicRows: anthropic.length, text: button?.textContent ?? "", disabled: button?.hasAttribute("disabled") ?? false, reason: anthropic[0]?.querySelector(".action-reasons")?.textContent ?? "", intro: document.querySelector(".dialog-body > .sub")?.textContent ?? "", activeProvider: active?.closest("li")?.getAttribute("data-slot-id") ?? null, activeEnabled: active instanceof HTMLButtonElement && !active.disabled }; })()`);
        observed["picker"] = picker;
      }
      groupObservations.push(observed);
    } finally { await closeSurface(surface); }
  }
  record("same-provider-multiple-credential-renderer-aggregate", groupObservations.every((item) => {
    const scenario = item["scenario"];
    const picker = item["picker"] as Record<string, unknown> | undefined;
    const common = item["providerCards"] === 4 && item["anthropicCards"] === 1 && item["credentialCount"] === "2" && item["manageDisabled"] === true && item["disabledReasonsResolved"] === true;
    const expected = item["badge"] === item["expectedBadge"] && item["tone"] === item["expectedTone"];
    if (scenario === "mixed") return common && expected && String(item["summary"]).includes("1 accepted provider") && String(item["summary"]).includes("2 saved credentials") && String(item["body"]).includes("2 saved credentials") && String(item["body"]).includes("1 credential accepted by the provider") && String(item["body"]).includes("1 credential not validated") && String(item["reason"]).includes("compatible credential setup version") && picker?.["rows"] === 4 && picker["anthropicRows"] === 1 && String(picker["text"]).includes("2 credentials") && picker["disabled"] === true && String(picker["reason"]).includes("compatible credential setup version") && String(picker["intro"]).includes("grouped credentials") && picker["activeProvider"] === "openai" && picker["activeEnabled"] === true;
    if (scenario === "metadata-unavailable") return common && expected && item["globalReasonCount"] === 1 && String(item["body"]).includes("2 saved credentials") && String(item["body"]).includes("details are unavailable") && item["metadataDisclosureSafe"] === true && String(item["reason"]).includes("saved credential details");
    if (scenario === "recovery") return common && expected && item["globalReasonCount"] === 1 && item["recoveryDisclosureSafe"] === true && String(item["body"]).includes("counts and provider-acceptance details are unavailable") && String(item["summary"]).includes("credential counts unavailable") && String(item["reason"]).includes("recovery");
    return common && expected;
  }), groupObservations);

  const anthropicOnlyValidation = await openSurface({ seedCredential: true, viewScenario: "tones", validationEnabled: true });
  try {
    const authority: Array<Record<string, unknown>> = [];
    for (const slotId of ["anthropic", "openai", "gemini", "openrouter"] as const) {
      await page(anthropicOnlyValidation.window, `document.querySelector('[data-focus-key="manage-${slotId}"]')?.click()`);
      await waitFor(anthropicOnlyValidation.window, `document.querySelector(".detail-card") !== null`);
      const action = await page<Record<string, unknown>>(anthropicOnlyValidation.window, `(() => ({ slotId: ${JSON.stringify(slotId)}, validateButtons: document.querySelectorAll('[data-focus-key="validate-${slotId}"]').length, allValidateButtons: document.querySelectorAll('[data-focus-key^="validate-"]').length }))()`);
      if (slotId === "anthropic") {
        await page(anthropicOnlyValidation.window, `document.querySelector('[data-focus-key="validate-anthropic"]')?.click()`);
        await waitFor(anthropicOnlyValidation.window, `document.querySelector("dialog") !== null`);
        action["disclosure"] = await page<Record<string, unknown>>(anthropicOnlyValidation.window, `(() => {
          const dialog = document.querySelector("dialog");
          const text = dialog?.textContent ?? "";
          const ids = (dialog?.getAttribute("aria-describedby") ?? "").split(/\\s+/u).filter(Boolean);
          return {
            title: document.querySelector("dialog h2")?.textContent?.trim() === "Start the one authorised Anthropic validation attempt?",
            oneDispatch: text.includes("One dispatch attempt; no retry"),
            model: text.includes("Anthropic, claude-haiku-4-5-20251001"),
            fixedPhrase: text.includes("Reply with exactly OK."),
            noUserData: text.includes("No user, project, repository, or task data is sent"),
            fourTokens: text.includes("Maximum output: four tokens"),
            standardRetention: text.includes("Standard Anthropic commercial API retention applies") && text.includes("zero-data retention is not claimed"),
            noRetry: text.includes("No automatic or hidden retry"),
            credentialHidden: text.includes("will not be displayed"),
            cancelSemantics: text.includes("Cancel makes no network request and does not consume"),
            confirmSemantics: text.includes("Confirm consumes the one-shot authorization immediately before credential resolution and possible dispatch"),
            boundedTime: text.includes("15 seconds") && text.includes("20-second host effect deadline") && text.includes("audit-receipt settlement is awaited"),
            confirmLabel: [...document.querySelectorAll("dialog button")].some((node) => node.textContent?.trim() === "Confirm and validate"),
            described: ids.length === 2 && ids.every((id) => document.getElementById(id) !== null),
          };
        })()`);
        await page(anthropicOnlyValidation.window, `[...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Cancel")?.click()`);
        await waitFor(anthropicOnlyValidation.window, `document.querySelector("dialog") === null`);
        action["cancelPreservedAuthorization"] = await page<boolean>(anthropicOnlyValidation.window, `document.querySelector('[data-focus-key="validate-anthropic"]') !== null`);
      }
      authority.push(action);
      await page(anthropicOnlyValidation.window, `document.querySelector('[data-focus-key="back-providers"]')?.click()`);
      await waitFor(anthropicOnlyValidation.window, `document.querySelector(".provider-grid") !== null`);
    }
    const anthropic = authority.find((item) => item["slotId"] === "anthropic");
    const otherProvidersHidden = authority.filter((item) => item["slotId"] !== "anthropic").every((item) => item["validateButtons"] === 0 && item["allValidateButtons"] === 0);
    const disclosure = anthropic?.["disclosure"] as Record<string, unknown> | undefined;
    record("anthropic-only-one-shot-validation-disclosure", authority.length === 4 && anthropic?.["validateButtons"] === 1 && anthropic["allValidateButtons"] === 1 && anthropic["cancelPreservedAuthorization"] === true && anthropicOnlyValidation.validation.dispatches() === 0 && disclosure !== undefined && Object.values(disclosure).every((value) => value === true) && otherProvidersHidden, authority);
  } finally { await closeSurface(anthropicOnlyValidation); }

  const acquisitionGuidance: Array<Record<string, unknown>> = [];
  for (const [slotId, expected] of [["anthropic", "Anthropic Console → API keys"], ["openai", "OpenAI dashboard → API keys"], ["gemini", "Google AI Studio → API keys"], ["openrouter", "OpenRouter dashboard → Keys"]] as const) {
    const surface = await openSurface({ seedCredential: true, viewScenario: "tones" });
    try {
      await page(surface.window, `document.querySelector('[data-focus-key="manage-${slotId}"]')?.click()`);
      await waitFor(surface.window, `document.querySelector(".detail-card") !== null`);
      await page(surface.window, `[...document.querySelectorAll(".detail-card button")].find((node) => node.textContent?.trim() === "Rotate credential")?.click()`);
      await waitFor(surface.window, `document.querySelector("#credential-secret-help") !== null`);
      const state = await page<Record<string, unknown>>(surface.window, `(() => ({ expected: (document.querySelector("#credential-secret-help")?.textContent ?? "").includes(${JSON.stringify(expected)}), links: document.querySelectorAll("dialog a").length, passwordCount: document.querySelectorAll('input[type="password"]').length }))()`);
      acquisitionGuidance.push({ slotId, ...state });
    } finally { await closeSurface(surface); }
  }
  record("four-provider-noninteractive-acquisition-guidance", acquisitionGuidance.length === 4 && acquisitionGuidance.every((item) => item["expected"] === true && item["links"] === 0 && item["passwordCount"] === 1), acquisitionGuidance);

  const saveDialogTitles: Array<Record<string, unknown>> = [];
  for (const [slotId, displayName] of [["anthropic", "Anthropic"], ["openai", "OpenAI"], ["gemini", "Google Gemini"], ["openrouter", "OpenRouter"]] as const) {
    const surface = await openSurface();
    try {
      await page(surface.window, `document.querySelector('[data-focus-key="add-provider"]')?.click()`);
      await waitFor(surface.window, `document.querySelector('.provider-picker [data-slot-id="${slotId}"] button') !== null`);
      await page(surface.window, `document.querySelector('.provider-picker [data-slot-id="${slotId}"] button')?.click()`);
      await waitFor(surface.window, `document.querySelector("#credential-secret") !== null`);
      const title = await page<string>(surface.window, `(() => { const dialog = document.querySelector("dialog"); const id = dialog?.getAttribute("aria-labelledby"); return id === null || id === undefined ? "" : document.getElementById(id)?.textContent ?? ""; })()`);
      saveDialogTitles.push({ slotId, title, expected: `Save credential — ${displayName}` });
    } finally { await closeSurface(surface); }
  }
  record("four-provider-save-dialog-grammar", saveDialogTitles.length === 4 && saveDialogTitles.every((item) => item["title"] === item["expected"]), saveDialogTitles);

  const finiteOutcomes = [
    { outcome: "valid" as const, title: "Connection works", fact: "provider accepted the credential" },
    { outcome: "invalid" as const, title: "Credential not accepted", fact: "provider rejected the credential" },
    { outcome: "unauthorized" as const, title: "Permission limited", fact: "accepted the credential but reported limited permission" },
    { outcome: "ambiguous" as const, title: "Check unclear", fact: "did not clearly accept or reject the credential" },
    { outcome: "unreachable" as const, title: "Provider unreachable", fact: "could not be reached or did not complete the check" },
    { outcome: "evidence-incomplete" as const, title: "Audit receipt not saved", fact: "audit receipt could not be saved" },
  ];
  const preservedOutcomes: Array<Record<string, unknown>> = [];
  for (const candidate of finiteOutcomes) {
    const completedRefreshFailure = await openSurface({ seedCredential: true, validationEnabled: true, validationOutcome: candidate.outcome, describeRefusalAfter: 2 });
    try {
      await openAnthropicDetail(completedRefreshFailure);
      await page(completedRefreshFailure.window, `document.querySelector('[data-focus-key="validate-anthropic"]')?.click()`);
      await waitFor(completedRefreshFailure.window, `document.querySelector("dialog") !== null`);
      await page(completedRefreshFailure.window, `[...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Confirm and validate")?.click()`);
      await waitFor(completedRefreshFailure.window, `document.querySelector('[data-notice-kind="refresh-warning"]') !== null`);
      const presentation = await page<Record<string, unknown>>(completedRefreshFailure.window, `(() => { const primary = document.querySelector('[data-notice-kind="outcome"]')?.textContent ?? ""; const warning = document.querySelector('[data-notice-kind="refresh-warning"]')?.textContent ?? ""; const actions = [...document.querySelectorAll(".detail-card .button-row button")]; return { primary, warning, allLocked: actions.length > 0 && actions.every((node) => node.hasAttribute("disabled")), reasons: actions.map((node) => node.getAttribute("title")) }; })()`);
      preservedOutcomes.push({ ...candidate, dispatches: completedRefreshFailure.validation.dispatches(), ...presentation });
    } finally { await closeSurface(completedRefreshFailure); }
  }
  record("finite-validation-outcomes-survive-refresh-failure", preservedOutcomes.length === 6 && preservedOutcomes.every((item) => item["dispatches"] === 1 && String(item["primary"]).includes(String(item["title"])) && String(item["primary"]).includes(String(item["fact"])) && /at \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}/u.test(String(item["primary"])) && !/(?:just now|\d+ (?:minute|hour|day)s? ago)/u.test(String(item["primary"])) && String(item["warning"]).includes("Current details could not be refreshed") && item["allLocked"] === true && (item["reasons"] as unknown[]).every((reason) => String(reason).toLowerCase().includes("reopen"))), preservedOutcomes);

  const terminalValidationRefusals: Array<Record<string, unknown>> = [];
  for (const code of ["REFUSED", "SCHEMA_REJECTED"] as const) {
    const surface = await openSurface({ seedCredential: true, validationEnabled: true, validationRefusalOnce: code });
    try {
      await openAnthropicDetail(surface);
      await page(surface.window, `document.querySelector('[data-focus-key="validate-anthropic"]')?.click()`);
      await waitFor(surface.window, `document.querySelector("dialog") !== null`);
      await page(surface.window, `[...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Confirm and validate")?.click()`);
      await waitFor(surface.window, `document.querySelector("dialog") === null && document.querySelector(".notice h2") !== null && document.querySelector('[data-focus-key="validate-anthropic"]')?.hasAttribute("disabled") === true && document.querySelector('[data-focus-key="validate-anthropic"]')?.getAttribute("title") !== "Current credential state is being refreshed"`);
      const state = await page<Record<string, unknown>>(surface.window, `(() => { const actions = [...document.querySelectorAll(".detail-card .button-row button")]; const validate = actions.find((node) => node.textContent?.trim() === "Validate connection"); return { notice: document.querySelector(".notice")?.textContent ?? "", validatePresent: validate !== undefined, validateDisabled: validate?.hasAttribute("disabled") ?? false, validateReason: validate?.getAttribute("title") ?? "" }; })()`);
      terminalValidationRefusals.push({ code, dispatches: surface.validation.dispatches(), ...state });
    } finally { await closeSurface(surface); }
  }
  record("pre-consumption-validation-refusals-preserve-authorization", terminalValidationRefusals.length === 2 && terminalValidationRefusals.every((item) => String(item["notice"]).toLowerCase().includes("close") && item["dispatches"] === 0 && item["validatePresent"] === true && item["validateDisabled"] === true && /close|reopen/u.test(String(item["validateReason"]).toLowerCase())), terminalValidationRefusals);
  await mark("validation-presentation-complete");
}

async function runValidationAuthorizationRegression(): Promise<void> {
  await mark("validation-authorization-started");
  const surface = await openSurface({ seedCredential: true, validationEnabled: true });
  try {
    await openAnthropicDetail(surface);
    await page(surface.window, `document.querySelector('[data-focus-key="validate-anthropic"]')?.click()`);
    await waitFor(surface.window, `document.querySelector("dialog") !== null`);
    const disclosure = await page<Record<string, unknown>>(surface.window, `(() => {
      const dialog = document.querySelector("dialog");
      const text = dialog?.textContent ?? "";
      const ids = (dialog?.getAttribute("aria-describedby") ?? "").split(/\\s+/u).filter(Boolean);
      return {
        oneDispatch: text.includes("One dispatch attempt; no retry"),
        exactModel: text.includes("Anthropic, claude-haiku-4-5-20251001"),
        fixedPhrase: text.includes("Reply with exactly OK."),
        noProjectData: text.includes("No user, project, repository, or task data is sent"),
        fourTokens: text.includes("Maximum output: four tokens"),
        retention: text.includes("Standard Anthropic commercial API retention applies") && text.includes("zero-data retention is not claimed"),
        noRetry: text.includes("No automatic or hidden retry"),
        noCredentialDisplay: text.includes("will not be displayed"),
        cancelNoConsume: text.includes("Cancel makes no network request and does not consume"),
        confirmConsumes: text.includes("Confirm consumes the one-shot authorization immediately before credential resolution and possible dispatch"),
        boundedTime: text.includes("15 seconds") && text.includes("20-second host effect deadline") && text.includes("audit-receipt settlement is awaited"),
        confirmLabel: [...document.querySelectorAll("dialog button")].some((node) => node.textContent?.trim() === "Confirm and validate"),
        described: ids.length === 2 && ids.every((id) => document.getElementById(id) !== null),
      };
    })()`);
    await page(surface.window, `[...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Cancel")?.click()`);
    await waitFor(surface.window, `document.querySelector("dialog") === null && document.querySelector('[data-focus-key="validate-anthropic"]') !== null`);
    const afterCancel = await page<Record<string, unknown>>(surface.window, `(() => ({ validateEnabled: document.querySelector('[data-focus-key="validate-anthropic"]')?.hasAttribute("disabled") === false }))()`);

    await page(surface.window, `document.querySelector('[data-focus-key="validate-anthropic"]')?.click()`);
    await waitFor(surface.window, `document.querySelector("dialog") !== null`);
    await page(surface.window, `(() => { const confirm = [...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Confirm and validate"); confirm?.click(); confirm?.click(); })()`);
    await waitFor(surface.window, `document.querySelector("dialog") === null && document.querySelector(".notice h2") !== null && document.querySelector('[data-focus-key="validate-anthropic"]') === null`);
    const normal = await page<Record<string, unknown>>(surface.window, `(() => ({
      actions: [...document.querySelectorAll(".detail-card .button-row button")].map((node) => node.textContent?.trim() ?? ""),
      validatePresent: document.querySelector('[data-focus-key="validate-anthropic"]') !== null,
      storageEnabled: [...document.querySelectorAll(".detail-card .button-row button")].every((node) => !node.hasAttribute("disabled")),
      notice: document.querySelector(".notice")?.textContent ?? "",
    }))()`);
    await chooseMode(surface, "developer");
    const developer = await page<Record<string, unknown>>(surface.window, `(() => { const text = document.querySelector(".view")?.textContent ?? ""; return { actions: [...document.querySelectorAll(".detail-card .button-row button")].map((node) => node.textContent?.trim() ?? ""), validatePresent: document.querySelector('[data-focus-key="validate-anthropic"]') !== null, fullHexVisible: /\\b[0-9a-f]{64}\\b/iu.test(text) }; })()`);
    await page(surface.window, `document.querySelector('[data-focus-key="back-providers"]')?.click()`);
    await waitFor(surface.window, `document.querySelector(".provider-grid") !== null`);
    const overviewAvailability = await page<string>(surface.window, `document.querySelector(".strip span:last-child")?.textContent ?? ""`);
    record("synthetic-one-shot-authorization-ui", Object.values(disclosure).every((value) => value === true) && afterCancel["validateEnabled"] === true && surface.validation.dispatches() === 1 && normal["validatePresent"] === false && normal["storageEnabled"] === true && String(normal["notice"]).includes("Connection works") && JSON.stringify(normal["actions"]) === JSON.stringify(developer["actions"]) && developer["validatePresent"] === false && developer["fullHexVisible"] === false && overviewAvailability.includes("authorization consumed"), { disclosure, afterCancel, dispatches: surface.validation.dispatches(), normal, developer, overviewAvailability });
  } finally { await closeSurface(surface); }

  const committed = await openSurface({ validationEnabled: true });
  try {
    await openEntryWithSyntheticValue(committed);
    await page(committed.window, `[...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Save securely")?.click()`);
    await waitFor(committed.window, `document.querySelector("dialog") === null && document.querySelector('[data-focus-key="validate-anthropic"]')?.hasAttribute("disabled") === false`);
    await page(committed.window, `document.querySelector('[data-focus-key="validate-anthropic"]')?.click()`);
    await waitFor(committed.window, `document.querySelector("dialog") !== null`);
    await page(committed.window, `[...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Confirm and validate")?.click()`);
    await waitFor(committed.window, `document.querySelector("dialog") === null && document.querySelector('[data-focus-key="validate-anthropic"]') === null && (() => { const storage = [...document.querySelectorAll(".detail-card .button-row button")]; return storage.length === 3 && storage.every((node) => node.hasAttribute("disabled") && (node.getAttribute("title") ?? "").includes("Reopen credential setup")); })()`);
    const committedTerminal = await page<Record<string, unknown>>(committed.window, `(() => ({ notice: document.querySelector(".notice")?.textContent ?? "", validatePresent: document.querySelector('[data-focus-key="validate-anthropic"]') !== null, storageLocked: [...document.querySelectorAll(".detail-card .button-row button")].every((node) => node.hasAttribute("disabled") && (node.getAttribute("title") ?? "").includes("Reopen credential setup")) }))()`);
    await page(committed.window, `document.querySelector('[data-focus-key="back-providers"]')?.click()`);
    await waitFor(committed.window, `document.querySelector(".provider-grid") !== null`);
    const committedAvailability = await page<string>(committed.window, `document.querySelector(".strip span:last-child")?.textContent ?? ""`);
    record("postcommit-one-shot-keeps-storage-truthfully-locked", committed.validation.dispatches() === 1 && String(committedTerminal["notice"]).includes("Exactly one separately disclosed check completed") && committedTerminal["validatePresent"] === false && committedTerminal["storageLocked"] === true && committedAvailability.includes("authorization consumed"), { dispatches: committed.validation.dispatches(), committedTerminal, committedAvailability });
  } finally { await closeSurface(committed); }
  await mark("validation-authorization-complete");
}

async function runMutationPresentationRegressions(): Promise<void> {
  await mark("mutation-presentation-started");
  const warningAndCommittedValidation = await openSurface({ validationEnabled: true, clipboardSucceeds: false });
  try {
    await openEntryWithSyntheticValue(warningAndCommittedValidation);
    await page(warningAndCommittedValidation.window, `[...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Save securely")?.click()`);
    await waitFor(warningAndCommittedValidation.window, `document.querySelector("dialog") === null && document.querySelector(".notice h2")?.textContent === "Saved securely" && document.querySelector('[data-focus-key="validate-anthropic"]') !== null`);
    const state = await page<Record<string, unknown>>(warningAndCommittedValidation.window, `(() => { const actions = [...document.querySelectorAll(".detail-card .button-row button")]; const validate = actions.find((node) => node.textContent?.trim() === "Validate connection"); const storage = actions.filter((node) => node !== validate); return { tone: document.querySelector(".notice")?.getAttribute("data-tone"), notice: document.querySelector(".notice")?.textContent ?? "", validateEnabled: validate !== undefined && !validate.hasAttribute("disabled"), storageCount: storage.length, storageLocked: storage.every((node) => node.hasAttribute("disabled") && (node.getAttribute("title") ?? "").includes("Reopen credential setup")) }; })()`);
    record("warning-tone-and-postcommit-validation-authority", state["tone"] === "warn" && String(state["notice"]).includes("Saved securely") && String(state["notice"]).includes("could not be cleared") && state["validateEnabled"] === true && Number(state["storageCount"]) === 3 && state["storageLocked"] === true, { clears: warningAndCommittedValidation.control.clipboard.clears, state });
    await page(warningAndCommittedValidation.window, `(() => { const rotate = document.querySelector('[data-focus-key="rotate-anthropic"]'); rotate?.removeAttribute("disabled"); rotate?.click(); })()`);
    await waitFor(warningAndCommittedValidation.window, `document.querySelector("#credential-secret") !== null`);
    await page(warningAndCommittedValidation.window, `(() => { const input = document.querySelector("#credential-secret"); if (input instanceof HTMLInputElement) { input.value = ${JSON.stringify(SYNTHETIC_REPLACEMENT)}; input.dispatchEvent(new Event("input", { bubbles: true })); } [...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Replace securely")?.click(); })()`);
    await waitFor(warningAndCommittedValidation.window, `document.querySelector(".notice h2")?.textContent === "That change was already completed"`);
    const replay = await page<string>(warningAndCommittedValidation.window, `document.querySelector(".notice")?.textContent ?? ""`);
    record("replayed-storage-refusal-does-not-claim-current-state-unchanged", replay.includes("This attempt made no storage change") && !replay.includes("remains unchanged"), replay);
  } finally { await closeSurface(warningAndCommittedValidation); }

  const committedRefreshFailure = await openSurface({ describeRefusalAfter: 2 });
  try {
    await page(committedRefreshFailure.window, `document.querySelector('[data-focus-key="add-provider"]')?.click()`);
    await waitFor(committedRefreshFailure.window, `document.querySelector(".provider-picker button") !== null`);
    await page(committedRefreshFailure.window, `document.querySelector(".provider-picker button")?.click()`);
    await waitFor(committedRefreshFailure.window, `document.querySelector("#credential-secret") !== null`);
    await page(committedRefreshFailure.window, `(() => { const input = document.querySelector("#credential-secret"); if (input instanceof HTMLInputElement) { input.value = ${JSON.stringify(SYNTHETIC_CANARY)}; input.dispatchEvent(new Event("input", { bubbles: true })); } [...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Save securely")?.click(); })()`);
    await waitFor(committedRefreshFailure.window, `document.querySelector('[data-notice-kind="refresh-warning"]') !== null`);
    await waitFor(committedRefreshFailure.window, `(document.querySelector("#status-region")?.textContent ?? "").includes("Current details could not be refreshed")`);
    const outcome = await page<Record<string, unknown>>(committedRefreshFailure.window, `(() => { const primary = document.querySelector('[data-notice-kind="outcome"]')?.textContent ?? ""; const warning = document.querySelector('[data-notice-kind="refresh-warning"]')?.textContent ?? ""; const actions = [...document.querySelectorAll(".detail-card .button-row button")]; return { primary, warning, liveStatus: document.querySelector("#status-region")?.textContent ?? "", liveAlert: document.querySelector("#alert-region")?.textContent ?? "", storageCount: actions.filter((node) => node.textContent?.trim() !== "Validate connection").length, storageLocked: actions.filter((node) => node.textContent?.trim() !== "Validate connection").every((node) => node.hasAttribute("disabled") && node.getAttribute("title") === "Reopen credential setup before another storage change") }; })()`);
    record("committed-save-survives-refresh-failure", String(outcome["primary"]).includes("Saved securely") && String(outcome["primary"]).includes("clipboard item was cleared") && String(outcome["primary"]).includes("Windows history or cloud sync") && String(outcome["warning"]).includes("Current details could not be refreshed") && String(outcome["warning"]).includes("status or outcome shown above remains the best available result") && String(outcome["liveStatus"]).includes("Saved securely") && String(outcome["liveStatus"]).includes("clipboard item was cleared") && String(outcome["liveStatus"]).includes("Current details could not be refreshed") && outcome["liveAlert"] === "" && Number(outcome["storageCount"]) === 3 && outcome["storageLocked"] === true, outcome);
  } finally { await closeSurface(committedRefreshFailure); }

  const longNickname = "W".repeat(40);
  const disabled = await openSurface({ seedCredential: true, seedDisabled: true, seedNickname: longNickname });
  try {
    disabled.window.setContentSize(900, 700);
    await delay(80);
    const layout = await page<Record<string, unknown>>(disabled.window, `(() => { const card = document.querySelector('[data-slot-id="anthropic"]'); const body = card?.querySelector(".provider-body"); return { bodyTextLength: body?.textContent?.split(" · ")[0]?.length ?? 0, bodyWraps: body !== null && body !== undefined && body.scrollWidth <= body.clientWidth + 1, cardFits: card !== null && card.scrollWidth <= card.clientWidth + 1, pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth }; })()`);
    await openAnthropicDetail(disabled);
    const normalFacts = await page<Record<string, unknown>>(disabled.window, `(() => Object.fromEntries([...document.querySelectorAll(".facts dt")].map((term) => [term.textContent?.trim(), term.nextElementSibling?.textContent?.trim()])))()`);
    await chooseMode(disabled, "developer");
    await page(disabled.window, `[...document.querySelectorAll(".detail-card button")].find((node) => node.textContent?.trim() === "Rotate credential")?.click()`);
    await waitFor(disabled.window, `document.querySelector("#credential-secret") !== null`);
    const dialog = await page<Record<string, unknown>>(disabled.window, `(() => { const node = document.querySelector("dialog"); const heading = node?.querySelector(".dialog-head h2"); const text = node?.textContent ?? ""; const describedBy = node?.getAttribute("aria-describedby") ?? ""; return { currentPreserved: text.includes("stays in place until a replacement commit is confirmed"), noContact: text.includes("does not contact Anthropic"), camera: text.includes("camera can still photograph it"), clipboard: text.includes("after confirmed replacement"), developer: text.includes("credential-rotate") && text.includes("recordToken"), described: describedBy.length > 0 && (document.getElementById(describedBy)?.textContent ?? "").includes("stays in place"), titleFits: heading !== null && heading !== undefined && heading.scrollWidth <= heading.clientWidth + 1, dialogFits: node !== null && node.scrollWidth <= node.clientWidth + 1, activeId: document.activeElement?.id ?? "" }; })()`);
    await page(disabled.window, `(() => { const input = document.querySelector("#credential-secret"); if (input instanceof HTMLInputElement) { input.value = ${JSON.stringify(SYNTHETIC_REPLACEMENT)}; input.dispatchEvent(new Event("input", { bubbles: true })); } [...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Replace securely")?.click(); })()`);
    await waitFor(disabled.window, `document.querySelector("dialog") === null && document.querySelector(".notice h2")?.textContent === "Credential rotated" && document.querySelector(".badge")?.textContent === "Disabled"`);
    const result = await page<Record<string, unknown>>(disabled.window, `(() => { const facts = Object.fromEntries([...document.querySelectorAll(".facts dt")].map((term) => [term.textContent?.trim(), term.nextElementSibling?.textContent?.trim()])); return { notice: document.querySelector(".notice")?.textContent ?? "", facts, passwordCount: document.querySelectorAll('input[type="password"]').length }; })()`);
    await page(disabled.window, `document.querySelector('.rail button[data-view="activity"]')?.click()`);
    await waitFor(disabled.window, `document.querySelector(".activity-list") !== null`);
    const activity = await page<string>(disabled.window, `document.querySelector(".activity-list")?.textContent ?? ""`);
    record("disabled-rotation-and-long-label-truth", layout["bodyTextLength"] === 40 && layout["bodyWraps"] === true && layout["cardFits"] === true && layout["pageFits"] === true && normalFacts["Presentation metadata"] === undefined && String(normalFacts["Enabled"]).startsWith("No") && Object.values(dialog).every((value) => value === true || value === "credential-secret") && String((result["facts"] as Record<string, unknown>)["Enabled"]).startsWith("No") && String(result["notice"]).includes("This rotation did not validate or contact the provider") && String(result["notice"]).includes("previous credential may still work at Anthropic") && String(result["notice"]).includes("revoke it there") && result["passwordCount"] === 0 && activity.includes("Rotated Anthropic credential locally") && !activity.includes("Re-entered or rotated"), { layout, normalFacts, dialog, result, activity });
  } finally { await closeSurface(disabled); }

  const recoveryCases = [
    { state: "revoked" as const, badge: "Removed", expectedDisclosure: "local encrypted value was removed", normalStorage: "Encrypted value removed; re-entry available", correctedNickname: "Corrected removed credential" },
    { state: "unrecoverable" as const, badge: "Re-entry required", expectedDisclosure: "saved encrypted credential cannot be read", normalStorage: "Re-entry required", correctedNickname: "Corrected recovered credential" },
  ];
  const reentries: Array<Record<string, unknown>> = [];
  for (const candidate of recoveryCases) {
    const surface = await openSurface({ seedState: candidate.state });
    try {
      await openAnthropicDetail(surface);
      const before = await page<Record<string, unknown>>(surface.window, `(() => { const facts = Object.fromEntries([...document.querySelectorAll(".facts dt")].map((term) => [term.textContent?.trim(), term.nextElementSibling?.textContent?.trim()])); return { badge: document.querySelector(".badge")?.textContent?.trim() ?? "", facts }; })()`);
      await chooseMode(surface, "developer");
      await page(surface.window, `[...document.querySelectorAll(".detail-card button")].find((node) => node.textContent?.trim() === "Re-enter credential")?.click()`);
      await waitFor(surface.window, `document.querySelector("#credential-secret") !== null`);
      const disclosure = await page<Record<string, unknown>>(surface.window, `(() => { const node = document.querySelector("dialog"); const body = node?.querySelector(".dialog-body"); const foot = node?.querySelector(".dialog-foot"); const rect = node?.getBoundingClientRect(); const footRect = foot?.getBoundingClientRect(); const text = node?.textContent ?? ""; const describedBy = node?.getAttribute("aria-describedby") ?? ""; return { text, operation: text.includes("credential-reenter"), state: text.includes(${JSON.stringify(candidate.state)}), camera: text.includes("camera can still photograph it"), clipboard: text.includes("after confirmed re-entry"), described: describedBy.length > 0 && (document.getElementById(describedBy)?.textContent ?? "").includes(${JSON.stringify(candidate.expectedDisclosure)}), nicknameVisible: document.querySelector("#credential-nickname") !== null, ownershipVisible: document.querySelector('input[name="credential-ownership"]') !== null, dialogWithinViewport: rect !== undefined && rect.top >= 0 && rect.bottom <= innerHeight, footerWithinViewport: footRect !== undefined && footRect.top >= 0 && footRect.bottom <= innerHeight, bodyOwnsOverflow: body !== null && getComputedStyle(body).overflowY === "auto" }; })()`);
      await page(surface.window, `(() => { const input = document.querySelector("#credential-secret"); const nickname = document.querySelector("#credential-nickname"); if (input instanceof HTMLInputElement) { input.value = ${JSON.stringify(SYNTHETIC_REPLACEMENT)}; input.dispatchEvent(new Event("input", { bubbles: true })); } if (nickname instanceof HTMLInputElement) { nickname.value = ${JSON.stringify(candidate.correctedNickname)}; nickname.dispatchEvent(new Event("input", { bubbles: true })); } [...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Re-enter securely")?.click(); })()`);
      await waitFor(surface.window, `document.querySelector("dialog") === null && document.querySelector(".notice h2")?.textContent === "Credential re-entered" && document.querySelector(".badge")?.textContent === "Saved · not validated"`);
      const after = await page<Record<string, unknown>>(surface.window, `(() => { const facts = Object.fromEntries([...document.querySelectorAll(".facts dt")].map((term) => [term.textContent?.trim(), term.nextElementSibling?.textContent?.trim()])); return { notice: document.querySelector(".notice")?.textContent ?? "", passwordCount: document.querySelectorAll('input[type="password"]').length, enabled: facts["Enabled"], nickname: document.querySelector(".provider-title h2")?.textContent?.trim() ?? "" }; })()`);
      await page(surface.window, `document.querySelector('.rail button[data-view="activity"]')?.click()`);
      await waitFor(surface.window, `document.querySelector(".activity-list") !== null`);
      const activity = await page<string>(surface.window, `document.querySelector(".activity-list")?.textContent ?? ""`);
      reentries.push({ ...candidate, before, disclosure, after, activity, rotateCalls: surface.rotateCalls() });
    } finally { await closeSurface(surface); }
  }
  record("revoked-and-unrecoverable-reentry-truth", reentries.every((item) => {
    const before = item["before"] as Record<string, unknown>;
    const facts = before["facts"] as Record<string, unknown>;
    const disclosure = item["disclosure"] as Record<string, unknown>;
    const after = item["after"] as Record<string, unknown>;
    return before["badge"] === item["badge"] && facts["Storage"] === item["normalStorage"] && facts["Presentation metadata"] === undefined && String(disclosure["text"]).includes(String(item["expectedDisclosure"])) && disclosure["operation"] === true && disclosure["state"] === true && disclosure["camera"] === true && disclosure["clipboard"] === true && disclosure["described"] === true && disclosure["nicknameVisible"] === true && disclosure["ownershipVisible"] === true && disclosure["dialogWithinViewport"] === true && disclosure["footerWithinViewport"] === true && disclosure["bodyOwnsOverflow"] === true && String(after["notice"]).includes("This re-entry did not validate or contact the provider") && String(after["enabled"]).startsWith("Yes") && after["nickname"] === item["correctedNickname"] && after["passwordCount"] === 0 && String(item["activity"]).includes("Re-entered Anthropic credential locally") && !String(item["activity"]).includes("Re-entered or rotated") && item["rotateCalls"] === 1;
  }), reentries);

  const conflict = await openSurface({ seedCredential: true, rotateConflictOnce: true });
  try {
    await openAnthropicDetail(conflict);
    await chooseMode(conflict, "developer");
    conflict.armGate("describe");
    await openAndSubmitReplacement(conflict, "Rotate credential");
    await conflict.waitForGate("describe");
    const pending = await page<Record<string, unknown>>(conflict.window, `(() => ({ title: document.querySelector(".notice h2")?.textContent ?? "", body: document.querySelector(".notice")?.textContent ?? "", tone: document.querySelector(".notice")?.getAttribute("data-tone"), code: document.querySelector(".notice .dev-block")?.textContent ?? "", actionsBlocked: [...document.querySelectorAll(".detail-card .button-row button")].every((node) => node.hasAttribute("disabled")), reasons: document.querySelector(".action-reasons")?.textContent ?? "" }))()`);
    conflict.releaseGate("describe");
    await waitFor(conflict.window, `document.querySelector(".notice h2")?.textContent === "Current credential state refreshed" && document.querySelector('[data-focus-key="rotate-anthropic"]')?.hasAttribute("disabled") === false`);
    const settled = await page<Record<string, unknown>>(conflict.window, `(() => ({ tone: document.querySelector(".notice")?.getAttribute("data-tone"), notice: document.querySelector(".notice")?.textContent ?? "", rotateEnabled: document.querySelector('[data-focus-key="rotate-anthropic"]')?.hasAttribute("disabled") === false, passwordCount: document.querySelectorAll('input[type="password"]').length }))()`);
    record("revision-conflict-refresh-and-retry", conflict.rotateCalls() === 1 && pending["title"] === "The credential list changed" && pending["tone"] === "warn" && String(pending["body"]).includes("This attempt made no storage change") && String(pending["body"]).includes("refreshed current saved state") && String(pending["code"]).includes("VAULT_REVISION_CONFLICT") && pending["actionsBlocked"] === true && String(pending["reasons"]).includes("A storage change is in progress") && settled["tone"] === "info" && settled["rotateEnabled"] === true && settled["passwordCount"] === 0 && String(settled["notice"]).includes("VAULT_REVISION_CONFLICT") && String(settled["notice"]).includes("Nothing was retried automatically"), { calls: conflict.rotateCalls(), pending, settled });
  } finally { await closeSurface(conflict); }

  const failedRefresh = await openSurface({ seedCredential: true, rotateConflictOnce: true, describeRefusalAfter: 2 });
  try {
    await openAnthropicDetail(failedRefresh);
    await chooseMode(failedRefresh, "developer");
    await openAndSubmitReplacement(failedRefresh, "Rotate credential");
    await waitFor(failedRefresh.window, `document.querySelector('[data-notice-kind="refresh-warning"]')?.textContent?.includes("METADATA_UNAVAILABLE") === true && [...document.querySelectorAll(".detail-card .button-row button")].every((node) => node.hasAttribute("disabled"))`);
    const state = await page<Record<string, unknown>>(failedRefresh.window, `(() => ({ outcome: document.querySelector('[data-notice-kind="outcome"]')?.textContent ?? "", warning: document.querySelector('[data-notice-kind="refresh-warning"]')?.textContent ?? "", reasons: [...document.querySelectorAll(".detail-card .button-row button")].map((node) => node.getAttribute("title")), passwordCount: document.querySelectorAll('input[type="password"]').length }))()`);
    record("revision-conflict-refresh-failure-is-terminal", failedRefresh.rotateCalls() === 1 && String(state["outcome"]).includes("The credential list changed") && String(state["outcome"]).includes("VAULT_REVISION_CONFLICT") && String(state["warning"]).includes("Credential details are unavailable") && String(state["warning"]).includes("METADATA_UNAVAILABLE") && (state["reasons"] as unknown[]).every((reason) => String(reason).toLowerCase().includes("reopen")) && state["passwordCount"] === 0, { calls: failedRefresh.rotateCalls(), state });
  } finally { await closeSurface(failedRefresh); }

  const stateBearingRefusals: Array<Record<string, unknown>> = [];
  for (const candidate of [
    { code: "DECRYPT_FAILED" as const, scenario: "slot-unrecoverable" as const, badge: "Re-entry required", title: "This credential could not be read", detail: true },
    { code: "SLOT_ABSENT" as const, scenario: "slot-absent" as const, badge: "Not saved", title: "No saved credential was found", detail: false },
  ]) {
    const surface = await openSurface({ seedCredential: true, rotateRefusalOnce: candidate.code, viewScenario: candidate.scenario, viewScenarioAfterDescribe: 2 });
    try {
      await openAnthropicDetail(surface);
      await openAndSubmitReplacement(surface, "Rotate credential");
      await waitFor(surface.window, `(document.querySelector('[data-slot-id="anthropic"] .badge')?.textContent ?? "").includes(${JSON.stringify(candidate.badge)})`);
      const state = await page<Record<string, unknown>>(surface.window, `(() => { const actions = [...document.querySelectorAll(".detail-card .button-row button, [data-slot-id=anthropic] .button-row button")]; return { outcome: document.querySelector('[data-notice-kind="outcome"]')?.textContent ?? "", warning: document.querySelector('[data-notice-kind="refresh-warning"]')?.textContent ?? "", badge: document.querySelector('[data-slot-id="anthropic"] .badge')?.textContent?.trim() ?? "", detail: document.querySelector(".detail-card") !== null, actions: actions.length, allLocked: actions.length > 0 && actions.every((node) => node.hasAttribute("disabled") && (node.getAttribute("title") ?? "").toLowerCase().includes("reopen")) }; })()`);
      stateBearingRefusals.push({ ...candidate, calls: surface.rotateCalls(), state });
    } finally { await closeSurface(surface); }
  }
  record("state-bearing-storage-refusals-refresh-and-lock", stateBearingRefusals.every((item) => { const state = item["state"] as Record<string, unknown>; return item["calls"] === 1 && state["badge"] === item["badge"] && state["detail"] === item["detail"] && Number(state["actions"]) > 0 && state["allLocked"] === true && state["warning"] === "" && String(state["outcome"]).includes(String(item["title"])) && String(state["outcome"]).includes("This attempt made no storage change") && String(state["outcome"]).includes("refreshed current saved state"); }), stateBearingRefusals);

  const nonretryableRefreshFailure = await openSurface({ seedCredential: true, rotateRefusalOnce: "DECRYPT_FAILED", describeRefusalAfter: 2 });
  try {
    await openAnthropicDetail(nonretryableRefreshFailure);
    await openAndSubmitReplacement(nonretryableRefreshFailure, "Rotate credential");
    await waitFor(nonretryableRefreshFailure.window, `document.querySelector('[data-notice-kind="refresh-warning"]') !== null`);
    const state = await page<Record<string, unknown>>(nonretryableRefreshFailure.window, `(() => ({ outcome: document.querySelector('[data-notice-kind="outcome"]')?.textContent ?? "", warning: document.querySelector('[data-notice-kind="refresh-warning"]')?.textContent ?? "", allLocked: [...document.querySelectorAll(".detail-card .button-row button")].every((node) => node.hasAttribute("disabled") && (node.getAttribute("title") ?? "").toLowerCase().includes("reopen")) }))()`);
    record("state-bearing-refusal-refresh-failure-preserves-both", nonretryableRefreshFailure.rotateCalls() === 1 && String(state["outcome"]).includes("This credential could not be read") && String(state["warning"]).includes("Current details could not be refreshed") && String(state["warning"]).includes("Credential details are unavailable") && state["allLocked"] === true, state);
  } finally { await closeSurface(nonretryableRefreshFailure); }
  await mark("mutation-presentation-complete");
}

async function runEscapeAndCloseRegression(): Promise<void> {
  await mark("escape-started");
  const escapeRuns: Array<Record<string, unknown>> = [];
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const surface = await openSurface();
    await openEntryWithSyntheticValue(surface);
    const before = await page<Record<string, unknown>>(surface.window, `(() => ({ passwordCount: document.querySelectorAll('input[type="password"]').length, duplicateIds: [...document.querySelectorAll("[id]")].length - new Set([...document.querySelectorAll("[id]")].map((node) => node.id)).size }))()`);
    await press(surface.window, "Escape", undefined, true);
    const deadline = Date.now() + 3_000;
    while (!surface.window.isDestroyed() && Date.now() < deadline) await delay(20);
    escapeRuns.push({ before, destroyed: surface.window.isDestroyed(), liveWindows: BrowserWindow.getAllWindows().filter((candidate) => !candidate.isDestroyed()).length });
    await closeSurface(surface);
  }
  record("escape-three-times-destroys-surface", escapeRuns.every((item) => item["destroyed"] === true && (item["before"] as Record<string, unknown>)["passwordCount"] === 1 && (item["before"] as Record<string, unknown>)["duplicateIds"] === 0), escapeRuns);
  await mark("escape-complete");

  const native = await openSurface();
  await openEntryWithSyntheticValue(native);
  const hostileBeforeUnload = await page<boolean>(native.window, `(() => { window.addEventListener("beforeunload", (event) => { event.preventDefault(); event.returnValue = "retain-secret-surface"; }); return true; })()`);
  native.window.close();
  const deadline = Date.now() + 3_000;
  while (!native.window.isDestroyed() && Date.now() < deadline) await delay(20);
  record("native-close-destroys-surface", hostileBeforeUnload && native.window.isDestroyed(), { hostileBeforeUnload, destroyed: native.window.isDestroyed() });
  await closeSurface(native);
  await mark("native-close-complete");

  const guarded = await openSurface();
  await openEntryWithSyntheticValue(guarded);
  const beforeUrl = guarded.window.webContents.getURL();
  await press(guarded.window, "Left", ["alt"], true);
  const guardDeadline = Date.now() + 3_000;
  while (!guarded.window.isDestroyed() && Date.now() < guardDeadline) await delay(20);
  record("navigation-shortcut-destroys-surface", guarded.window.isDestroyed(), { beforeUrl, destroyed: guarded.window.isDestroyed() });
  await closeSurface(guarded);
  await mark("navigation-guard-complete");

  const reloadRuns: Array<Record<string, unknown>> = [];
  for (const shortcut of [{ key: "F5" }, { key: "R", modifiers: ["control"] as Array<"control"> }] as const) {
    const reloading = await openSurface();
    await openEntryWithSyntheticValue(reloading);
    await press(reloading.window, shortcut.key, shortcut.modifiers === undefined ? undefined : [...shortcut.modifiers], true);
    const reloadDeadline = Date.now() + 3_000;
    while (!reloading.window.isDestroyed() && Date.now() < reloadDeadline) await delay(20);
    reloadRuns.push({ shortcut: shortcut.key, destroyed: reloading.window.isDestroyed() });
    await closeSurface(reloading);
  }
  record("reload-shortcuts-destroy-surface", reloadRuns.every((item) => item["destroyed"] === true), reloadRuns);
  await mark("reload-guards-complete");

  const crashed = await openSurface();
  await openEntryWithSyntheticValue(crashed);
  crashed.window.webContents.forcefullyCrashRenderer();
  const crashDeadline = Date.now() + 3_000;
  while (!crashed.window.isDestroyed() && Date.now() < crashDeadline) await delay(20);
  record("renderer-crash-destroys-surface", crashed.window.isDestroyed(), { destroyed: crashed.window.isDestroyed() });
  await closeSurface(crashed);
  await mark("renderer-crash-complete");
}

async function runMediaMode(): Promise<void> {
  await mark(`${smokeMode}-opening`);
  const surface = await openSurface(smokeMode === "forced" ? { seedCredential: true, viewScenario: "tones", rotateConflictOnce: true } : {});
  try {
    if (smokeMode === "reduced") {
      const state = await page<Record<string, unknown>>(surface.window, `(() => { const view = getComputedStyle(document.querySelector(".view")); const button = getComputedStyle(document.querySelector(".btn")); return { matches: matchMedia("(prefers-reduced-motion: reduce)").matches, animationDuration: view.animationDuration, transitionDuration: button.transitionDuration }; })()`);
      record("reduced-motion", state["matches"] === true && String(state["animationDuration"]).split(",").every((value) => parseFloat(value) === 0) && String(state["transitionDuration"]).split(",").every((value) => parseFloat(value) === 0), state);
    }
    if (smokeMode === "forced") {
      const debuggerPort = surface.window.webContents.debugger;
      if (!debuggerPort.isAttached()) debuggerPort.attach("1.3");
      await debuggerPort.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
      await waitFor(surface.window, `document.activeElement?.tagName === "H1"`);
      await press(surface.window, "Tab");
      const readForcedColoursOverview = async (): Promise<Record<string, unknown>> => await page<Record<string, unknown>>(surface.window, `(() => {
        const system = (name) => { const probe = document.createElement("span"); probe.style.cssText = "position:fixed;left:-9999px;color:" + name + ";forced-color-adjust:none"; document.body.append(probe); const value = getComputedStyle(probe).color; probe.remove(); return value; };
        const badgeStyles = [...document.querySelectorAll(".badge")].map((node) => ({ tone: node.getAttribute("data-tone"), color: getComputedStyle(node).color, border: getComputedStyle(node).borderColor }));
        const focused = document.activeElement;
        const focusStyle = focused instanceof Element ? getComputedStyle(focused) : null;
        const rail = getComputedStyle(document.querySelector('.rail button[aria-current="page"]'));
        const secondary = getComputedStyle(document.querySelector(".provider-body"));
        return { system: { canvasText: system("CanvasText"), grayText: system("GrayText"), highlight: system("Highlight"), highlightText: system("HighlightText") }, matches: matchMedia("(forced-colors: active)").matches, badgeStyles, rail: { color: rail.color, outline: rail.outlineStyle }, secondary: secondary.color, focusTag: focused?.tagName ?? null, focusOutline: focusStyle?.outlineStyle ?? null, horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
      })()`);
      const forcedColoursOverviewReady = (candidate: Record<string, unknown>): boolean => {
        const system = candidate["system"] !== null && typeof candidate["system"] === "object" ? candidate["system"] as Record<string, unknown> : {};
        const badgeStyles = Array.isArray(candidate["badgeStyles"]) ? candidate["badgeStyles"] as Array<Record<string, unknown>> : [];
        const rail = candidate["rail"] !== null && typeof candidate["rail"] === "object" ? candidate["rail"] as Record<string, unknown> : {};
        return candidate["matches"] === true && candidate["focusTag"] === "BUTTON" && candidate["focusOutline"] !== "none" && candidate["horizontalOverflow"] === false && badgeStyles.length === 4 && badgeStyles.every((item) => item["color"] === system["canvasText"] && item["border"] === system["canvasText"]) && rail["color"] === system["canvasText"] && rail["outline"] !== "none" && candidate["secondary"] === system["grayText"];
      };
      const forcedColoursOverviewDeadline = Date.now() + 5_000;
      let overview = await readForcedColoursOverview();
      while (!forcedColoursOverviewReady(overview) && Date.now() < forcedColoursOverviewDeadline) {
        await delay(25);
        overview = await readForcedColoursOverview();
      }
      await page(surface.window, `document.querySelector("#mode-toggle")?.click()`);
      await waitFor(surface.window, `document.querySelector('dialog input[value="normal"]') !== null`);
      const choice = await page<Record<string, unknown>>(surface.window, `(() => { const radio = document.querySelector('dialog input[value="normal"]'); const card = radio?.closest(".choice"); const cardStyle = card instanceof Element ? getComputedStyle(card) : null; const radioStyle = radio instanceof Element ? getComputedStyle(radio) : null; return { checked: radio?.checked ?? false, cardBorder: cardStyle?.borderColor ?? null, cardOutline: cardStyle?.outlineStyle ?? null, radioAdjustment: radioStyle?.forcedColorAdjust ?? null, radioAccent: radioStyle?.accentColor ?? null }; })()`);
      await page(surface.window, `[...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Apply mode")?.click()`);
      await waitFor(surface.window, `document.querySelector("dialog") === null`);
      await openAnthropicDetail(surface);
      const controlsBefore = await page<Record<string, unknown>>(surface.window, `(() => { const subtle = document.querySelector('[data-focus-key="back-providers"]'); const danger = document.querySelector('[data-focus-key="remove-anthropic"]'); const subtleStyle = getComputedStyle(subtle); const dangerStyle = getComputedStyle(danger); return { subtle: { color: subtleStyle.color, border: subtleStyle.borderColor, background: subtleStyle.backgroundColor }, danger: { color: dangerStyle.color, border: dangerStyle.borderColor, background: dangerStyle.backgroundColor } }; })()`);
      await page(surface.window, `document.querySelector('[data-focus-key="remove-anthropic"]')?.click()`);
      await waitFor(surface.window, `document.querySelector('dialog input[type="checkbox"]') !== null`);
      const removalBefore = await page<Record<string, unknown>>(surface.window, `(() => { const check = document.querySelector('dialog input[type="checkbox"]'); const remove = [...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Remove from this PC"); const checkStyle = getComputedStyle(check); const removeStyle = getComputedStyle(remove); return { checked: check?.checked ?? null, checkAdjustment: checkStyle.forcedColorAdjust, checkAccent: checkStyle.accentColor, disabled: remove?.hasAttribute("disabled") ?? false, color: removeStyle.color, border: removeStyle.borderColor }; })()`);
      await page(surface.window, `document.querySelector('dialog input[type="checkbox"]')?.click()`);
      const removalAfter = await page<Record<string, unknown>>(surface.window, `(() => { const check = document.querySelector('dialog input[type="checkbox"]'); const remove = [...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Remove from this PC"); remove?.focus(); const removeStyle = getComputedStyle(remove); return { checked: check?.checked ?? null, checkAdjustment: getComputedStyle(check).forcedColorAdjust, enabled: !(remove?.hasAttribute("disabled") ?? true), color: removeStyle.color, background: removeStyle.backgroundColor, border: removeStyle.borderColor, outline: removeStyle.outlineStyle }; })()`);
      const system = overview["system"] as Record<string, unknown>;
      record("forced-colours", forcedColoursOverviewReady(overview), overview);
      record("forced-colours-controls", choice["checked"] === true && choice["cardBorder"] === system["highlight"] && choice["cardOutline"] !== "none" && choice["radioAdjustment"] === "auto" && (controlsBefore["subtle"] as Record<string, unknown>)["color"] === system["canvasText"] && (controlsBefore["subtle"] as Record<string, unknown>)["border"] === system["canvasText"] && (controlsBefore["danger"] as Record<string, unknown>)["color"] === system["canvasText"] && removalBefore["checked"] === false && removalBefore["checkAdjustment"] === "auto" && removalBefore["disabled"] === true && removalBefore["color"] === system["grayText"] && removalAfter["checked"] === true && removalAfter["checkAdjustment"] === "auto" && removalAfter["enabled"] === true && removalAfter["color"] === system["highlightText"] && removalAfter["border"] === system["highlight"] && removalAfter["outline"] !== "none", { system, choice, controlsBefore, removalBefore, removalAfter });
      await page(surface.window, `[...document.querySelectorAll("dialog button")].find((node) => node.textContent?.trim() === "Keep credential")?.click()`);
      await waitFor(surface.window, `document.querySelector("dialog") === null`);
      await mark("forced-notice-entry");
      await openAndSubmitReplacement(surface, "Rotate credential");
      await mark("forced-notice-submitted");
      await delay(300);
      await mark("forced-notice-rendered");
      const notice = await page<Record<string, unknown>>(surface.window, `(() => { const node = document.querySelector(".notice"); const sub = node?.querySelector(".sub"); const style = getComputedStyle(node); const subStyle = getComputedStyle(sub); return { color: style.color, background: style.backgroundColor, border: style.borderColor, secondary: subStyle.color, pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth }; })()`);
      record("forced-colours-result-notice", notice["color"] === system["canvasText"] && notice["border"] === system["canvasText"] && notice["secondary"] === system["grayText"] && notice["pageFits"] === true, notice);
    }
    record("media-mode-no-canary", surface.consoleCanary() === false && surface.validation.dispatches() === 0, { consoleCanary: surface.consoleCanary(), validationDispatches: surface.validation.dispatches() });
  } finally {
    await closeSurface(surface);
  }
  await mark(`${smokeMode}-complete`);
}

async function executeSmoke(): Promise<void> {
  try {
    await mkdir(resolve(smokeRoot, "app-data"), { recursive: true });
    await mkdir(resolve(smokeRoot, "user-data"), { recursive: true });
    app.setPath("appData", resolve(smokeRoot, "app-data"));
    app.setPath("userData", resolve(smokeRoot, "user-data"));
    await mark("before-ready");
    await app.whenReady();
    await mark("ready");
    report["appDataPath"] = app.getPath("appData");
    report["userDataPath"] = app.getPath("userData");
    installMinimalEditMenu(Menu);
    if (smokeMode === "default") {
      await runHappyPath();
      await runInFlightActionRegression();
      await runRecoveryAndMetadataRegressions();
      await runValidationPresentationRegressions();
      await runValidationAuthorizationRegression();
      await runMutationPresentationRegressions();
      await runEscapeAndCloseRegression();
    } else {
      await runMediaMode();
    }
  } catch (error) {
    failures.push(safeFailure(error));
  } finally {
    const serialized = JSON.stringify(report, null, 2);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, serialized, "utf8");
    await mark(failures.length === 0 ? "reported-pass" : "reported-fail");
    app.exit(failures.length === 0 ? 0 : 1);
  }
}

void executeSmoke();
