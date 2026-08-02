/**
 * Session identity and resumption.
 *
 * Sessions are ephemeral by default. `--no-session-persistence` is sent unless
 * every one of the continuation preconditions holds, so the ordinary case
 * leaves nothing on disk to resume, leak, or reuse across projects.
 *
 * "Continue the most recent session" is never used: it resolves against the
 * current directory rather than against a verified lineage, so it can silently
 * attach an attempt to the wrong conversation. Resumption accepts only this
 * adapter's own opaque token, and the token is checked against the project,
 * provider instance, workspace lineage, model, and configuration it was minted
 * for before a single flag is constructed.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { validation } from "@ai-dev-os/domain";
import { invalidRequestError, policyDeniedError, type ClaudeDetailCode } from "./errors.js";

const { ensureExactKeys, ensureRecord, ensureSafeInteger, ensureString } = validation;

export const RESUME_TOKEN_VERSION = 1 as const;

/**
 * Claude requires a UUID for `--session-id`. The pattern is strict, so a
 * session value can never begin with `-` or carry a control character, and
 * therefore can never be read by the CLI as a flag.
 */
export const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isValidSessionId(value: string): boolean {
  return value.length === 36 && SESSION_ID_PATTERN.test(value);
}

export interface ClaudeSessionBinding {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  /** The managed workspace snapshot the session was bound to. */
  readonly snapshotId: string;
  readonly requestId: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly configurationFingerprint: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/**
 * The opaque resume token.
 *
 * The token carries only what a verifier cannot already derive: the Claude
 * session id and the expiry. Everything else — provider instance, project,
 * workspace, snapshot lineage, model, and the configuration fingerprint — is
 * bound into digests the verifier recomputes from the context it is resuming
 * into. A token therefore cannot be edited to point a resumed session at
 * another project, workspace, or model, and it discloses none of them.
 *
 * The digests are unkeyed SHA-256 truncations over local, non-secret context.
 * They bind a token to the situation it was minted for; they are not an
 * authentication secret and are not treated as one. The enforcing boundary is
 * the workspace grant and the policy decision, not this tag.
 */
export function mintResumeToken(binding: ClaudeSessionBinding): string {
  const parts = [
    String(RESUME_TOKEN_VERSION),
    binding.sessionId,
    String(Math.floor(Date.parse(binding.expiresAt) / 1_000)),
    dimensionTag(binding.configurationFingerprint, "project", binding.projectId),
    dimensionTag(
      binding.configurationFingerprint,
      "workspace",
      `${binding.workspaceId}/${binding.snapshotId}`,
    ),
    dimensionTag(binding.configurationFingerprint, "model", `${binding.model ?? ""}`),
    bindingTag(binding),
  ];
  return Buffer.from(parts.join("."), "utf8").toString("base64url");
}

const DIMENSION_TAG_LENGTH = 8;
const BINDING_TAG_LENGTH = 32;

function dimensionTag(fingerprint: string, dimension: string, value: string): string {
  return createHash("sha256")
    .update(`${fingerprint}|${dimension}|${value}`, "utf8")
    .digest("hex")
    .slice(0, DIMENSION_TAG_LENGTH);
}

function bindingTag(binding: {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly snapshotId: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly configurationFingerprint: string;
  readonly expiresAt: string;
}): string {
  return createHash("sha256")
    .update(
      [
        binding.configurationFingerprint,
        binding.instanceId,
        binding.sessionId,
        binding.projectId,
        binding.workspaceId,
        binding.snapshotId,
        binding.model ?? "",
        binding.effort ?? "",
        String(Math.floor(Date.parse(binding.expiresAt) / 1_000)),
      ].join("|"),
      "utf8",
    )
    .digest("hex")
    .slice(0, BINDING_TAG_LENGTH);
}

export interface ResumeVerificationInput {
  readonly token: string;
  readonly instanceId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly snapshotId: string;
  readonly model: string | null;
  /** A resumed session may not silently change effort, so it is bound too. */
  readonly effort: string | null;
  readonly configurationFingerprint: string;
  readonly now: Date;
  readonly sessionPersistenceAllowed: boolean;
}

export type ResumeVerification =
  | { readonly ok: true; readonly binding: ClaudeSessionBinding }
  | { readonly ok: false; readonly detailCode: ClaudeDetailCode };

/**
 * Verifies a caller-supplied resume token. Every failure returns a stable
 * detail code and never echoes the token.
 */
export function verifyResumeToken(input: ResumeVerificationInput): ResumeVerification {
  // Policy is checked before the token is parsed at all. When persistence is
  // not permitted the answer does not depend on the token, and the caller
  // learns nothing about whether the token it supplied was well formed.
  if (!input.sessionPersistenceAllowed) {
    return fail("session-persistence-denied");
  }
  if (typeof input.token !== "string" || input.token.length === 0 || input.token.length > 4_096) {
    return fail("resume-token-invalid");
  }
  let decoded: string;
  try {
    decoded = Buffer.from(input.token, "base64url").toString("utf8");
  } catch {
    return fail("resume-token-invalid");
  }
  const parts = decoded.split(".");
  if (parts.length !== 7) {
    return fail("resume-token-invalid");
  }
  const [version, sessionId, expirySeconds, projectTag, workspaceTag, modelTag, tag] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== String(RESUME_TOKEN_VERSION) || !isValidSessionId(sessionId)) {
    return fail("resume-token-invalid");
  }
  if (!/^\d{1,15}$/.test(expirySeconds)) {
    return fail("resume-token-invalid");
  }
  const expiresAtMs = Number(expirySeconds) * 1_000;
  if (!Number.isSafeInteger(expiresAtMs)) {
    return fail("resume-token-invalid");
  }
  const expiresAt = new Date(expiresAtMs).toISOString();

  // Which dimension differs is reported specifically, because "this token
  // belongs to another project" and "this token is corrupt" call for very
  // different operator responses.
  const fingerprintValue = input.configurationFingerprint;
  if (!constantTimeEquals(projectTag, dimensionTag(fingerprintValue, "project", input.projectId))) {
    return fail("resume-project-mismatch");
  }
  if (
    !constantTimeEquals(
      workspaceTag,
      dimensionTag(fingerprintValue, "workspace", `${input.workspaceId}/${input.snapshotId}`),
    )
  ) {
    return fail("resume-workspace-mismatch");
  }
  if (!constantTimeEquals(modelTag, dimensionTag(fingerprintValue, "model", input.model ?? ""))) {
    return fail("resume-model-mismatch");
  }

  const expected = bindingTag({
    sessionId,
    instanceId: input.instanceId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    snapshotId: input.snapshotId,
    model: input.model,
    effort: input.effort,
    configurationFingerprint: fingerprintValue,
    expiresAt,
  });
  if (!constantTimeEquals(tag, expected)) {
    return fail("resume-token-invalid");
  }

  if (input.now.valueOf() >= expiresAtMs) {
    return fail("resume-token-expired");
  }

  return Object.freeze({
    ok: true as const,
    binding: Object.freeze({
      sessionId,
      instanceId: input.instanceId,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      snapshotId: input.snapshotId,
      // The originating request is not carried in the token; a resumed
      // operation is identified by the request that is resuming it.
      requestId: "",
      model: input.model,
      effort: input.effort,
      configurationFingerprint: fingerprintValue,
      issuedAt: "",
      expiresAt,
    }),
  });
}

function fail(detailCode: ClaudeDetailCode): ResumeVerification {
  return Object.freeze({ ok: false, detailCode });
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Throws the provider error a resume failure implies. */
export function resumeFailureError(detailCode: ClaudeDetailCode): Error {
  if (detailCode === "session-persistence-denied") {
    return policyDeniedError(detailCode);
  }
  return invalidRequestError(detailCode);
}

/**
 * Decides whether this operation may persist a resumable session. Every
 * condition must hold; the default answer is no.
 */
export function sessionPersistenceAllowed(input: {
  readonly continuationRequested: boolean;
  readonly configuredPolicy: "never" | "explicit-continuation-only";
  readonly policyAllows: boolean;
  readonly authenticationSupportsPersistence: boolean;
  readonly retentionAllowed: boolean;
}): boolean {
  return (
    input.continuationRequested &&
    input.configuredPolicy === "explicit-continuation-only" &&
    input.policyAllows &&
    input.authenticationSupportsPersistence &&
    input.retentionAllowed
  );
}

/**
 * A bounded, redacted session-metadata document. It records identity and
 * accounting, never transcripts, prompts, or credentials.
 */
export interface ClaudeSessionMetadata {
  readonly schemaVersion: typeof RESUME_TOKEN_VERSION;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly requestedModel: string | null;
  readonly observedModel: string | null;
  readonly requestedEffort: string | null;
  readonly turns: number | null;
  readonly persisted: boolean;
  readonly startedAt: string;
  readonly endedAt: string;
}

export function parseSessionMetadata(value: unknown, path = "sessionMetadata"): ClaudeSessionMetadata {
  const record = ensureRecord(value, path);
  ensureExactKeys(
    record,
    [
      "schemaVersion",
      "sessionId",
      "instanceId",
      "projectId",
      "workspaceId",
      "requestedModel",
      "observedModel",
      "requestedEffort",
      "turns",
      "persisted",
      "startedAt",
      "endedAt",
    ],
    path,
  );
  const turns = record["turns"];
  const optionalText = (raw: unknown, field: string): string | null =>
    raw === undefined || raw === null ? null : ensureString(raw, `${path}.${field}`, { maxLength: 128 });
  return Object.freeze({
    schemaVersion: RESUME_TOKEN_VERSION,
    sessionId: ensureString(record["sessionId"], `${path}.sessionId`, { maxLength: 64 }),
    instanceId: ensureString(record["instanceId"], `${path}.instanceId`, { maxLength: 128 }),
    projectId: ensureString(record["projectId"], `${path}.projectId`, { maxLength: 128 }),
    workspaceId: ensureString(record["workspaceId"], `${path}.workspaceId`, { maxLength: 128 }),
    requestedModel: optionalText(record["requestedModel"], "requestedModel"),
    observedModel: optionalText(record["observedModel"], "observedModel"),
    requestedEffort: optionalText(record["requestedEffort"], "requestedEffort"),
    turns: turns === undefined || turns === null ? null : ensureSafeInteger(turns, `${path}.turns`, 0, 100_000),
    persisted: record["persisted"] === true,
    startedAt: ensureString(record["startedAt"], `${path}.startedAt`, { maxLength: 32 }),
    endedAt: ensureString(record["endedAt"], `${path}.endedAt`, { maxLength: 32 }),
  });
}
