import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { types as utilTypes } from "node:util";
import { toCanonicalJson } from "@ai-dev-os/domain";
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_MESSAGES_ENDPOINT,
} from "@ai-dev-os/provider-anthropic";
import {
  ANTHROPIC_LIVE_CANARY_CALLBACK_DRAIN_MS,
  ANTHROPIC_LIVE_CANARY_MAX_RESPONSE_BYTES,
  ANTHROPIC_LIVE_CANARY_MAX_TOKENS,
  ANTHROPIC_LIVE_CANARY_MODEL,
  ANTHROPIC_LIVE_CANARY_REQUEST_BYTES,
  ANTHROPIC_LIVE_CANARY_REQUEST_SHA256,
  ANTHROPIC_LIVE_CANARY_TIMEOUT_MS,
} from "@ai-dev-os/provider-anthropic/validation";
import { secretRefFingerprint } from "@ai-dev-os/secrets";
import {
  APP_VAULT_CONTAINER_ID,
  appVaultReferenceForSlot,
} from "@ai-dev-os/secrets-app-vault";

export const STAGE_18E_I_CANDIDATE_BINDING_PATH =
  "dist/main/stage-18e-i-candidate-binding.json" as const;
export const STAGE_18E_I_MANIFEST_PATH =
  "docs/release-evidence/stage-18e-i-sanitized-success-receipt-subject-manifest.json" as const;
export const ANTHROPIC_VALIDATION_OPERATION_VERSION =
  "ai-dev-os.stage-18e-i.anthropic-validation.v1" as const;
export const ANTHROPIC_VALIDATION_RETENTION_MODE =
  "standard-commercial-api" as const;
export const ANTHROPIC_VALIDATION_MARKER_NAMESPACE_PREFIX =
  "ai-dev-os.stage-18e-i.anthropic-validation." as const;
export const ANTHROPIC_VALIDATION_AUTHORIZATION_RELATIVE_PATH =
  "authorization/anthropic-validation.v1.json" as const;
export const ANTHROPIC_VALIDATION_MAX_AUTHORIZATION_BYTES = 32_768 as const;
export const ANTHROPIC_VALIDATION_MAX_AUTHORIZATION_LIFETIME_MS =
  24 * 60 * 60 * 1_000;

const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MARKER_NAMESPACE =
  /^ai-dev-os\.stage-18e-i\.anthropic-validation\.[a-f0-9]{32}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

const EXPECTED_REFERENCE = appVaultReferenceForSlot("anthropic");
const EXPECTED_REFERENCE_FINGERPRINT = secretRefFingerprint(EXPECTED_REFERENCE);

export type AnthropicValidationAuthorizationState =
  | "unavailable"
  | "invalid"
  | "expired"
  | "consumed"
  | "available";

export interface Stage18eICandidateBinding {
  readonly schemaVersion: 1;
  readonly status: "published";
  readonly head: string;
  readonly tree: string;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly manifestPath: typeof STAGE_18E_I_MANIFEST_PATH;
  readonly manifestSha256: string;
  readonly manifestAggregate: string;
}

export interface AnthropicValidationAuthorizationPacket {
  readonly schemaVersion: 1;
  readonly operationVersion: typeof ANTHROPIC_VALIDATION_OPERATION_VERSION;
  readonly candidate: Omit<Stage18eICandidateBinding, "schemaVersion" | "status">;
  readonly provider: Readonly<{
    slotId: "anthropic";
    providerInstanceId: "anthropic-default";
    secretRef: Readonly<{
      schemaVersion: 1;
      type: "encrypted-file";
      namespace: "provider";
      containerId: typeof APP_VAULT_CONTAINER_ID;
      entryName: "anthropic";
      version: null;
      expectedKind: "text";
      providerInstanceId: "anthropic-default";
      fingerprint: string;
    }>;
  }>;
  readonly request: Readonly<{
    endpoint: typeof ANTHROPIC_MESSAGES_ENDPOINT;
    apiVersion: typeof ANTHROPIC_API_VERSION;
    model: typeof ANTHROPIC_LIVE_CANARY_MODEL;
    requestSha256: typeof ANTHROPIC_LIVE_CANARY_REQUEST_SHA256;
    requestBytes: typeof ANTHROPIC_LIVE_CANARY_REQUEST_BYTES;
    maximumOutputTokens: typeof ANTHROPIC_LIVE_CANARY_MAX_TOKENS;
    maximumResponseBytes: typeof ANTHROPIC_LIVE_CANARY_MAX_RESPONSE_BYTES;
    effectTimeoutMs: typeof ANTHROPIC_LIVE_CANARY_TIMEOUT_MS;
    callbackDrainMs: typeof ANTHROPIC_LIVE_CANARY_CALLBACK_DRAIN_MS;
    transport: "direct-anthropic-https";
    retentionMode: typeof ANTHROPIC_VALIDATION_RETENTION_MODE;
  }>;
  readonly authorizationReference: string;
  readonly markerNamespace: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly attemptLimit: 1;
  readonly retryPolicy: "none";
  readonly expectedResult: Readonly<{
    schemaVersion: 1;
    successStatus: "success";
    successTransport: "direct-anthropic-https";
    maximumInputTokens: 256;
    maximumOutputTokens: 4;
    exactAssistantText: "OK";
    modelSubstitutionRejected: true;
    fixedRequestBody: true;
    repositorySourcePresent: false;
    credentialRetained: false;
    responseBodyRetained: false;
    finiteOutcomes: readonly ["valid", "invalid", "unauthorized", "ambiguous", "unreachable"];
  }>;
}

export interface AnthropicValidationAuthorizationView {
  readonly schemaVersion: 1;
  readonly state: AnthropicValidationAuthorizationState;
  readonly slotId: "anthropic" | null;
  readonly providerInstanceId: "anthropic-default" | null;
  readonly modelId: typeof ANTHROPIC_LIVE_CANARY_MODEL | null;
  readonly requestFingerprint: string | null;
  readonly packetFingerprint: string | null;
  readonly authorizationReference: string | null;
  readonly expiresAt: string | null;
  readonly maximumOutputTokens: 4 | null;
  readonly effectTimeoutMs: 15_000 | null;
  readonly callbackDrainMs: 5_000 | null;
  readonly retentionMode: typeof ANTHROPIC_VALIDATION_RETENTION_MODE | null;
}

export interface ConsumedAnthropicValidationAuthorization {
  readonly schemaVersion: 1;
  readonly packetFingerprint: string;
  readonly authorizationReference: string;
  readonly candidateManifestAggregate: string;
  readonly secretRefFingerprint: string;
}

export const ANTHROPIC_VALIDATION_AUTHORIZATION_ERROR_CODES = Object.freeze([
  "AUTHORIZATION_UNAVAILABLE",
  "AUTHORIZATION_INVALID",
  "AUTHORIZATION_EXPIRED",
  "AUTHORIZATION_CONSUMED",
  "AUTHORIZATION_AMBIGUOUS",
] as const);
export type AnthropicValidationAuthorizationErrorCode =
  (typeof ANTHROPIC_VALIDATION_AUTHORIZATION_ERROR_CODES)[number];

export class AnthropicValidationAuthorizationError extends Error {
  readonly code: AnthropicValidationAuthorizationErrorCode;

  constructor(code: AnthropicValidationAuthorizationErrorCode) {
    super("The Anthropic validation authorization is unavailable.");
    this.name = "AnthropicValidationAuthorizationError";
    this.code = code;
  }
}

function fail(code: AnthropicValidationAuthorizationErrorCode): never {
  throw new AnthropicValidationAuthorizationError(code);
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
  ) fail("AUTHORIZATION_INVALID");
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) fail("AUTHORIZATION_INVALID");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) fail("AUTHORIZATION_INVALID");
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !ISO.test(value)) fail("AUTHORIZATION_INVALID");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail("AUTHORIZATION_INVALID");
  }
  return value;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalDocument(value: unknown): string {
  return `${toCanonicalJson(value, "anthropicValidationAuthorization")}\n`;
}

async function readCanonicalDocument(path: string, maximumBytes: number): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let bytes: Buffer | null = null;
  try {
    const observed = await lstat(path);
    if (!observed.isFile() || observed.isSymbolicLink()) fail("AUTHORIZATION_INVALID");
    handle = await open(path, "r");
    const before = await handle.stat();
    if (
      !before.isFile() || before.dev !== observed.dev || before.ino !== observed.ino ||
      before.size < 2 || before.size > maximumBytes
    ) {
      fail("AUTHORIZATION_INVALID");
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== before.size || bytes.byteLength !== before.size) {
      fail("AUTHORIZATION_INVALID");
    }
    const text = UTF8.decode(bytes);
    let parsed: unknown;
    try { parsed = JSON.parse(text) as unknown; }
    catch { fail("AUTHORIZATION_INVALID"); }
    if (text !== canonicalDocument(parsed)) fail("AUTHORIZATION_INVALID");
    return parsed;
  } catch (error) {
    if (error instanceof AnthropicValidationAuthorizationError) throw error;
    throw error;
  } finally {
    bytes?.fill(0);
    try { await handle?.close(); }
    catch { /* Closing must not replace the already bounded parse outcome. */ }
  }
}

function requiredHash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) fail("AUTHORIZATION_INVALID");
  return value;
}

function requiredCommit(value: unknown): string {
  if (typeof value !== "string" || !COMMIT.test(value)) fail("AUTHORIZATION_INVALID");
  return value;
}

export function parseStage18eICandidateBinding(value: unknown): Stage18eICandidateBinding {
  const record = exactRecord(value, [
    "schemaVersion", "status", "head", "tree", "sourceCommit", "sourceTree",
    "manifestPath", "manifestSha256", "manifestAggregate",
  ]);
  if (
    record["schemaVersion"] !== 1 || record["status"] !== "published" ||
    record["manifestPath"] !== STAGE_18E_I_MANIFEST_PATH
  ) fail("AUTHORIZATION_INVALID");
  return Object.freeze({
    schemaVersion: 1,
    status: "published",
    head: requiredCommit(record["head"]),
    tree: requiredCommit(record["tree"]),
    sourceCommit: requiredCommit(record["sourceCommit"]),
    sourceTree: requiredCommit(record["sourceTree"]),
    manifestPath: STAGE_18E_I_MANIFEST_PATH,
    manifestSha256: requiredHash(record["manifestSha256"]),
    manifestAggregate: requiredHash(record["manifestAggregate"]),
  });
}

export async function loadStage18eICandidateBinding(
  applicationRoot: string,
): Promise<Stage18eICandidateBinding | null> {
  const root = resolve(applicationRoot);
  const path = resolve(root, ...STAGE_18E_I_CANDIDATE_BINDING_PATH.split("/"));
  const rel = relative(root, path);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  try {
    return parseStage18eICandidateBinding(await readCanonicalDocument(path, 8_192));
  } catch {
    return null;
  }
}

function candidateProjection(
  candidate: Stage18eICandidateBinding,
): AnthropicValidationAuthorizationPacket["candidate"] {
  return Object.freeze({
    head: candidate.head,
    tree: candidate.tree,
    sourceCommit: candidate.sourceCommit,
    sourceTree: candidate.sourceTree,
    manifestPath: candidate.manifestPath,
    manifestSha256: candidate.manifestSha256,
    manifestAggregate: candidate.manifestAggregate,
  });
}

function expectedProvider(): AnthropicValidationAuthorizationPacket["provider"] {
  return Object.freeze({
    slotId: "anthropic",
    providerInstanceId: "anthropic-default",
    secretRef: Object.freeze({
      schemaVersion: 1,
      type: "encrypted-file",
      namespace: "provider",
      containerId: APP_VAULT_CONTAINER_ID,
      entryName: "anthropic",
      version: null,
      expectedKind: "text",
      providerInstanceId: "anthropic-default",
      fingerprint: EXPECTED_REFERENCE_FINGERPRINT,
    }),
  });
}

function expectedRequest(): AnthropicValidationAuthorizationPacket["request"] {
  return Object.freeze({
    endpoint: ANTHROPIC_MESSAGES_ENDPOINT,
    apiVersion: ANTHROPIC_API_VERSION,
    model: ANTHROPIC_LIVE_CANARY_MODEL,
    requestSha256: ANTHROPIC_LIVE_CANARY_REQUEST_SHA256,
    requestBytes: ANTHROPIC_LIVE_CANARY_REQUEST_BYTES,
    maximumOutputTokens: ANTHROPIC_LIVE_CANARY_MAX_TOKENS,
    maximumResponseBytes: ANTHROPIC_LIVE_CANARY_MAX_RESPONSE_BYTES,
    effectTimeoutMs: ANTHROPIC_LIVE_CANARY_TIMEOUT_MS,
    callbackDrainMs: ANTHROPIC_LIVE_CANARY_CALLBACK_DRAIN_MS,
    transport: "direct-anthropic-https",
    retentionMode: ANTHROPIC_VALIDATION_RETENTION_MODE,
  });
}

function expectedResult(): AnthropicValidationAuthorizationPacket["expectedResult"] {
  return Object.freeze({
    schemaVersion: 1,
    successStatus: "success",
    successTransport: "direct-anthropic-https",
    maximumInputTokens: 256,
    maximumOutputTokens: 4,
    exactAssistantText: "OK",
    modelSubstitutionRejected: true,
    fixedRequestBody: true,
    repositorySourcePresent: false,
    credentialRetained: false,
    responseBodyRetained: false,
    finiteOutcomes: Object.freeze(["valid", "invalid", "unauthorized", "ambiguous", "unreachable"] as const),
  });
}

function parsePacket(
  value: unknown,
  candidate: Stage18eICandidateBinding,
  nowMs: number,
): AnthropicValidationAuthorizationPacket {
  const record = exactRecord(value, [
    "schemaVersion", "operationVersion", "candidate", "provider", "request",
    "authorizationReference", "markerNamespace", "issuedAt", "expiresAt",
    "attemptLimit", "retryPolicy", "expectedResult",
  ]);
  if (
    record["schemaVersion"] !== 1 ||
    record["operationVersion"] !== ANTHROPIC_VALIDATION_OPERATION_VERSION ||
    record["attemptLimit"] !== 1 || record["retryPolicy"] !== "none"
  ) fail("AUTHORIZATION_INVALID");

  const expectedCandidate = candidateProjection(candidate);
  if (toCanonicalJson(record["candidate"]) !== toCanonicalJson(expectedCandidate)) {
    fail("AUTHORIZATION_INVALID");
  }
  if (toCanonicalJson(record["provider"]) !== toCanonicalJson(expectedProvider())) {
    fail("AUTHORIZATION_INVALID");
  }
  if (toCanonicalJson(record["request"]) !== toCanonicalJson(expectedRequest())) {
    fail("AUTHORIZATION_INVALID");
  }
  if (toCanonicalJson(record["expectedResult"]) !== toCanonicalJson(expectedResult())) {
    fail("AUTHORIZATION_INVALID");
  }

  const authorizationReference = record["authorizationReference"];
  const markerNamespace = record["markerNamespace"];
  if (
    typeof authorizationReference !== "string" || !REFERENCE.test(authorizationReference) ||
    typeof markerNamespace !== "string" || !MARKER_NAMESPACE.test(markerNamespace)
  ) fail("AUTHORIZATION_INVALID");
  const issuedAt = timestamp(record["issuedAt"]);
  const expiresAt = timestamp(record["expiresAt"]);
  const issuedMs = Date.parse(issuedAt);
  const expiresMs = Date.parse(expiresAt);
  if (
    expiresMs <= issuedMs ||
    expiresMs - issuedMs > ANTHROPIC_VALIDATION_MAX_AUTHORIZATION_LIFETIME_MS ||
    nowMs < issuedMs
  ) fail("AUTHORIZATION_INVALID");
  if (nowMs >= expiresMs) fail("AUTHORIZATION_EXPIRED");

  return Object.freeze({
    schemaVersion: 1,
    operationVersion: ANTHROPIC_VALIDATION_OPERATION_VERSION,
    candidate: expectedCandidate,
    provider: expectedProvider(),
    request: expectedRequest(),
    authorizationReference,
    markerNamespace,
    issuedAt,
    expiresAt,
    attemptLimit: 1,
    retryPolicy: "none",
    expectedResult: expectedResult(),
  });
}

export function createAnthropicValidationAuthorizationPacket(input: Readonly<{
  candidate: Stage18eICandidateBinding;
  authorizationReference: string;
  markerNamespace: string;
  issuedAt: string;
  expiresAt: string;
}>): AnthropicValidationAuthorizationPacket {
  const candidate = parseStage18eICandidateBinding(input.candidate);
  const packet = {
    schemaVersion: 1,
    operationVersion: ANTHROPIC_VALIDATION_OPERATION_VERSION,
    candidate: candidateProjection(candidate),
    provider: expectedProvider(),
    request: expectedRequest(),
    authorizationReference: input.authorizationReference,
    markerNamespace: input.markerNamespace,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    attemptLimit: 1,
    retryPolicy: "none",
    expectedResult: expectedResult(),
  };
  return parsePacket(packet, candidate, Date.parse(input.issuedAt));
}

export function serializeAnthropicValidationAuthorizationPacket(
  packet: AnthropicValidationAuthorizationPacket,
): string {
  return canonicalDocument(packet);
}

function isMissing(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function hasErrorCode(error: unknown, expected: string): boolean {
  try {
    const code = typeof error === "object" && error !== null
      ? Object.getOwnPropertyDescriptor(error, "code")
      : undefined;
    return code !== undefined && "value" in code && code.value === expected;
  } catch { return false; }
}

function sameResolvedPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return platform() === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function sameFileIdentity(
  left: Readonly<{ dev: number | bigint; ino: number | bigint }>,
  right: Readonly<{ dev: number | bigint; ino: number | bigint }>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function completeMarkerDurabilityBarrier(input: Readonly<{
  markerPath: string;
  markerDirectory: string;
  markerDirectoryRealPath: string;
  markerDirectoryIdentity: Readonly<{ dev: number | bigint; ino: number | bigint }>;
  markerIdentity: Readonly<{ dev: number | bigint; ino: number | bigint }>;
}>): Promise<void> {
  if (!sameResolvedPath(await realpath(input.markerDirectory), input.markerDirectoryRealPath)) {
    throw new Error("MARKER_DIRECTORY_IDENTITY_CHANGED");
  }

  if (platform() === "win32") {
    // Node does not expose a reliable Windows parent-directory fsync contract. Re-open and
    // flush the exact marker identity instead; callers must not describe this as directory durability.
    const markerHandle = await open(input.markerPath, "r+");
    try {
      const marker = await markerHandle.stat();
      if (!marker.isFile() || !sameFileIdentity(marker, input.markerIdentity)) {
        throw new Error("MARKER_IDENTITY_CHANGED");
      }
      await markerHandle.sync();
    } finally {
      await markerHandle.close();
    }
    return;
  }

  const directoryHandle = await open(input.markerDirectory, "r");
  try {
    const directory = await directoryHandle.stat();
    if (
      !directory.isDirectory() ||
      !sameFileIdentity(directory, input.markerDirectoryIdentity)
    ) {
      throw new Error("MARKER_DIRECTORY_IDENTITY_CHANGED");
    }
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

function view(
  state: AnthropicValidationAuthorizationState,
  packet: AnthropicValidationAuthorizationPacket | null,
  packetFingerprint: string | null,
): AnthropicValidationAuthorizationView {
  return Object.freeze({
    schemaVersion: 1,
    state,
    slotId: packet === null ? null : "anthropic",
    providerInstanceId: packet === null ? null : "anthropic-default",
    modelId: packet?.request.model ?? null,
    requestFingerprint: packet?.request.requestSha256 ?? null,
    packetFingerprint,
    authorizationReference: packet?.authorizationReference ?? null,
    expiresAt: packet?.expiresAt ?? null,
    maximumOutputTokens: packet === null ? null : 4,
    effectTimeoutMs: packet === null ? null : 15_000,
    callbackDrainMs: packet === null ? null : 5_000,
    retentionMode: packet?.request.retentionMode ?? null,
  });
}

export interface AnthropicValidationAuthorizationGate {
  authorization(): AnthropicValidationAuthorizationView;
  consume(input: Readonly<{
    slotId: "anthropic";
    providerInstanceId: "anthropic-default";
    secretRefFingerprint: string;
  }>): Promise<ConsumedAnthropicValidationAuthorization>;
  claim(attempt: ConsumedAnthropicValidationAuthorization): AnthropicValidationAuthorizationPacket;
}

export function anthropicValidationAuthorizationRoot(
  appDataPath: string,
  appName: string,
): string {
  const root = resolve(appDataPath);
  const target = resolve(root, appName, "credential-setup", "anthropic-validation");
  if (!target.startsWith(root + sep)) fail("AUTHORIZATION_INVALID");
  return target;
}

export async function createAnthropicValidationAuthorizationGate(options: Readonly<{
  root: string;
  candidateBinding: Stage18eICandidateBinding | null;
  now: () => Date;
}>): Promise<AnthropicValidationAuthorizationGate> {
  const root = resolve(options.root);
  const packetPath = resolve(root, ...ANTHROPIC_VALIDATION_AUTHORIZATION_RELATIVE_PATH.split("/"));
  if (relative(root, packetPath).startsWith("..") || isAbsolute(relative(root, packetPath))) {
    fail("AUTHORIZATION_INVALID");
  }
  let state: AnthropicValidationAuthorizationState = "unavailable";
  let packet: AnthropicValidationAuthorizationPacket | null = null;
  let packetFingerprint: string | null = null;
  let markerPath: string | null = null;
  const markerDirectory = join(root, "markers-v1");
  const claims = new WeakSet<object>();

  const nowMs = (): number => {
    try {
      const value = options.now();
      const time = value instanceof Date ? value.valueOf() : Number.NaN;
      if (!Number.isFinite(time)) fail("AUTHORIZATION_INVALID");
      return time;
    } catch (error) {
      if (error instanceof AnthropicValidationAuthorizationError) throw error;
      fail("AUTHORIZATION_INVALID");
    }
  };

  if (options.candidateBinding !== null) {
    try {
      const parsedCandidate = parseStage18eICandidateBinding(options.candidateBinding);
      const authorizationDirectory = await lstat(dirname(packetPath));
      if (!authorizationDirectory.isDirectory() || authorizationDirectory.isSymbolicLink()) {
        fail("AUTHORIZATION_INVALID");
      }
      const rawPacket = await readCanonicalDocument(
        packetPath,
        ANTHROPIC_VALIDATION_MAX_AUTHORIZATION_BYTES,
      );
      packet = parsePacket(rawPacket, parsedCandidate, nowMs());
      packetFingerprint = sha256(canonicalDocument(packet));
      const markerName = `${sha256(packet.markerNamespace)}.attempt`;
      markerPath = join(markerDirectory, markerName);
      try {
        const markerDirectoryStat = await lstat(markerDirectory);
        if (!markerDirectoryStat.isDirectory() || markerDirectoryStat.isSymbolicLink()) {
          fail("AUTHORIZATION_INVALID");
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      try {
        await lstat(markerPath);
        state = "consumed";
      } catch (error) {
        if (!isMissing(error)) throw error;
        state = "available";
      }
    } catch (error) {
      if (isMissing(error)) state = "unavailable";
      else if (
        error instanceof AnthropicValidationAuthorizationError &&
        error.code === "AUTHORIZATION_EXPIRED"
      ) state = "expired";
      else state = "invalid";
    }
  }

  const currentView = (): AnthropicValidationAuthorizationView => {
    if (state === "available" && packet !== null && nowMs() >= Date.parse(packet.expiresAt)) {
      state = "expired";
    }
    return view(state, packet, packetFingerprint);
  };

  const gate: AnthropicValidationAuthorizationGate = Object.freeze({
    authorization: currentView,
    async consume(input: Readonly<{
      slotId: "anthropic";
      providerInstanceId: "anthropic-default";
      secretRefFingerprint: string;
    }>) {
      const observed = currentView();
      if (observed.state === "expired") fail("AUTHORIZATION_EXPIRED");
      if (observed.state === "consumed") fail("AUTHORIZATION_CONSUMED");
      if (observed.state === "invalid") fail("AUTHORIZATION_INVALID");
      if (
        observed.state !== "available" || packet === null ||
        packetFingerprint === null || markerPath === null
      ) fail("AUTHORIZATION_UNAVAILABLE");
      if (
        input.slotId !== "anthropic" ||
        input.providerInstanceId !== "anthropic-default" ||
        input.secretRefFingerprint !== EXPECTED_REFERENCE_FINGERPRINT
      ) fail("AUTHORIZATION_INVALID");

      let preparedMarkerDirectoryIdentity:
        Readonly<{ dev: number | bigint; ino: number | bigint }> | null = null;
      let preparedMarkerDirectoryRealPath: string | null = null;
      try {
        await mkdir(markerDirectory, { recursive: true, mode: 0o700 });
        const markerDirectoryStat = await lstat(markerDirectory);
        if (!markerDirectoryStat.isDirectory() || markerDirectoryStat.isSymbolicLink()) {
          state = "invalid";
          fail("AUTHORIZATION_INVALID");
        }
        const markerDirectoryRealPath = await realpath(markerDirectory);
        if (!sameResolvedPath(markerDirectoryRealPath, markerDirectory)) {
          state = "invalid";
          fail("AUTHORIZATION_INVALID");
        }
        preparedMarkerDirectoryIdentity = markerDirectoryStat;
        preparedMarkerDirectoryRealPath = markerDirectoryRealPath;
      } catch (error) {
        if (error instanceof AnthropicValidationAuthorizationError) throw error;
        state = "unavailable";
        fail("AUTHORIZATION_UNAVAILABLE");
      }
      if (
        preparedMarkerDirectoryIdentity === null ||
        preparedMarkerDirectoryRealPath === null
      ) {
        state = "unavailable";
        fail("AUTHORIZATION_UNAVAILABLE");
      }
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(markerPath, "wx", 0o600);
      } catch (error) {
        if (hasErrorCode(error, "EEXIST")) {
          state = "consumed";
          fail("AUTHORIZATION_CONSUMED");
        }
        try {
          await lstat(markerPath);
          state = "consumed";
          fail("AUTHORIZATION_CONSUMED");
        } catch (nested) {
          if (nested instanceof AnthropicValidationAuthorizationError) throw nested;
          state = "unavailable";
          fail("AUTHORIZATION_UNAVAILABLE");
        }
      }
      state = "consumed";
      const attempt = Object.freeze({
        schemaVersion: 1 as const,
        packetFingerprint,
        authorizationReference: packet.authorizationReference,
        candidateManifestAggregate: packet.candidate.manifestAggregate,
        secretRefFingerprint: packet.provider.secretRef.fingerprint,
      });
      let markerUncertain = false;
      let markerIdentity: Readonly<{ dev: number | bigint; ino: number | bigint }> | null = null;
      let markerDirectoryIdentity: Readonly<{ dev: number | bigint; ino: number | bigint }> | null = null;
      let markerDirectoryRealPath: string | null = null;
      try {
        const markerDirectoryStat = await lstat(markerDirectory);
        markerDirectoryRealPath = await realpath(markerDirectory);
        const observedMarker = await lstat(markerPath);
        const openedMarker = await handle.stat();
        if (
          !markerDirectoryStat.isDirectory() || markerDirectoryStat.isSymbolicLink() ||
          !sameResolvedPath(markerDirectoryRealPath, markerDirectory) ||
          !sameResolvedPath(markerDirectoryRealPath, preparedMarkerDirectoryRealPath) ||
          !sameFileIdentity(markerDirectoryStat, preparedMarkerDirectoryIdentity) ||
          !observedMarker.isFile() || observedMarker.isSymbolicLink() ||
          !openedMarker.isFile() || !sameFileIdentity(observedMarker, openedMarker)
        ) {
          throw new Error("MARKER_IDENTITY_UNCERTAIN");
        }
        markerDirectoryIdentity = markerDirectoryStat;
        markerIdentity = openedMarker;
        const marker = canonicalDocument(Object.freeze({
          schemaVersion: 1,
          operationVersion: ANTHROPIC_VALIDATION_OPERATION_VERSION,
          packetFingerprint,
          authorizationReference: packet.authorizationReference,
          markerNamespace: packet.markerNamespace,
          consumedAt: new Date(nowMs()).toISOString(),
          state: "consumed-before-dispatch",
        }));
        await handle.writeFile(marker, { encoding: "utf8" });
        await handle.sync();
      } catch {
        markerUncertain = true;
      }
      try { await handle.close(); }
      catch { markerUncertain = true; }
      if (
        !markerUncertain && markerIdentity !== null &&
        markerDirectoryIdentity !== null && markerDirectoryRealPath !== null
      ) {
        try {
          const observedMarker = await lstat(markerPath);
          if (
            !observedMarker.isFile() || observedMarker.isSymbolicLink() ||
            !sameFileIdentity(observedMarker, markerIdentity)
          ) {
            throw new Error("MARKER_IDENTITY_CHANGED");
          }
          await completeMarkerDurabilityBarrier({
            markerPath,
            markerDirectory,
            markerDirectoryRealPath,
            markerDirectoryIdentity,
            markerIdentity,
          });
          const durableMarker = await lstat(markerPath);
          const durableDirectory = await lstat(markerDirectory);
          if (
            !durableMarker.isFile() || durableMarker.isSymbolicLink() ||
            !sameFileIdentity(durableMarker, markerIdentity) ||
            !durableDirectory.isDirectory() || durableDirectory.isSymbolicLink() ||
            !sameFileIdentity(durableDirectory, markerDirectoryIdentity) ||
            !sameResolvedPath(await realpath(markerDirectory), markerDirectoryRealPath)
          ) {
            throw new Error("MARKER_IDENTITY_CHANGED");
          }
        } catch {
          markerUncertain = true;
        }
      } else {
        markerUncertain = true;
      }
      if (markerUncertain) {
        fail("AUTHORIZATION_AMBIGUOUS");
      }
      claims.add(attempt);
      return attempt;
    },
    claim(attempt: ConsumedAnthropicValidationAuthorization) {
      if (
        typeof attempt !== "object" || attempt === null ||
        !claims.has(attempt as object) || packet === null
      ) fail("AUTHORIZATION_CONSUMED");
      claims.delete(attempt as object);
      return packet;
    },
  });
  return gate;
}
