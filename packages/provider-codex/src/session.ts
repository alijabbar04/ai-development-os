import { createHash, timingSafeEqual } from "node:crypto";

export const CODEX_RESUME_TOKEN_VERSION = 1 as const;

export interface CodexSessionBinding {
  readonly threadId: string;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly snapshotId: string;
  readonly model: string;
  readonly effort: string;
  readonly configurationFingerprint: string;
  readonly expiresAt: string;
}

export type CodexResumeVerification =
  | { readonly ok: true; readonly binding: CodexSessionBinding }
  | { readonly ok: false; readonly detailCode: "resume-token-invalid" | "resume-token-expired" | "resume-binding-mismatch" | "session-persistence-denied" };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const tag = (values: readonly string[]): string => createHash("sha256").update(values.join("\0"), "utf8").digest("hex");
const same = (left: string, right: string): boolean => {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
};

function bindingTag(binding: CodexSessionBinding): string {
  return tag([
    binding.configurationFingerprint, binding.instanceId, binding.threadId, binding.sessionId,
    binding.projectId, binding.workspaceId, binding.snapshotId, binding.model, binding.effort,
    String(Math.floor(Date.parse(binding.expiresAt) / 1_000)),
  ]);
}

/** Opaque, non-secret context binding. The workspace grant remains the enforcing boundary. */
export function mintCodexResumeToken(binding: CodexSessionBinding): string {
  const expires = String(Math.floor(Date.parse(binding.expiresAt) / 1_000));
  const payload = [
    String(CODEX_RESUME_TOKEN_VERSION), binding.threadId, binding.sessionId, expires,
    tag([binding.configurationFingerprint, "project", binding.projectId]).slice(0, 12),
    tag([binding.configurationFingerprint, "workspace", binding.workspaceId, binding.snapshotId]).slice(0, 12),
    tag([binding.configurationFingerprint, "model", binding.model, binding.effort]).slice(0, 12),
    bindingTag(binding),
  ];
  return Buffer.from(payload.join("."), "utf8").toString("base64url");
}

export function verifyCodexResumeToken(input: {
  readonly token: string;
  readonly instanceId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly snapshotId: string;
  readonly model: string;
  readonly effort: string;
  readonly configurationFingerprint: string;
  readonly now: Date;
  readonly sessionPersistenceAllowed: boolean;
}): CodexResumeVerification {
  if (!input.sessionPersistenceAllowed) return Object.freeze({ ok: false, detailCode: "session-persistence-denied" });
  if (input.token.length === 0 || input.token.length > 4_096 || !/^[A-Za-z0-9_-]+$/.test(input.token)) return Object.freeze({ ok: false, detailCode: "resume-token-invalid" });
  let decoded: string;
  try {
    const bytes = Buffer.from(input.token, "base64url");
    if (bytes.toString("base64url") !== input.token) return Object.freeze({ ok: false, detailCode: "resume-token-invalid" });
    decoded = bytes.toString("utf8");
  } catch { return Object.freeze({ ok: false, detailCode: "resume-token-invalid" }); }
  const parts = decoded.split(".");
  if (parts.length !== 8) return Object.freeze({ ok: false, detailCode: "resume-token-invalid" });
  const [version, threadId, sessionId, expiry, projectTag, workspaceTag, modelTag, suppliedTag] = parts as [string, string, string, string, string, string, string, string];
  if (version !== String(CODEX_RESUME_TOKEN_VERSION) || !ID.test(threadId) || !ID.test(sessionId) || !/^\d{1,15}$/.test(expiry)) return Object.freeze({ ok: false, detailCode: "resume-token-invalid" });
  const expiresAtMs = Number(expiry) * 1_000;
  if (!Number.isSafeInteger(expiresAtMs)) return Object.freeze({ ok: false, detailCode: "resume-token-invalid" });
  const expectedProject = tag([input.configurationFingerprint, "project", input.projectId]).slice(0, 12);
  const expectedWorkspace = tag([input.configurationFingerprint, "workspace", input.workspaceId, input.snapshotId]).slice(0, 12);
  const expectedModel = tag([input.configurationFingerprint, "model", input.model, input.effort]).slice(0, 12);
  if (!same(projectTag, expectedProject) || !same(workspaceTag, expectedWorkspace) || !same(modelTag, expectedModel)) return Object.freeze({ ok: false, detailCode: "resume-binding-mismatch" });
  const binding = Object.freeze({
    threadId, sessionId, instanceId: input.instanceId, projectId: input.projectId,
    workspaceId: input.workspaceId, snapshotId: input.snapshotId, model: input.model,
    effort: input.effort, configurationFingerprint: input.configurationFingerprint,
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
  if (!same(suppliedTag, bindingTag(binding))) return Object.freeze({ ok: false, detailCode: "resume-token-invalid" });
  if (input.now.valueOf() >= expiresAtMs) return Object.freeze({ ok: false, detailCode: "resume-token-expired" });
  return Object.freeze({ ok: true, binding });
}
