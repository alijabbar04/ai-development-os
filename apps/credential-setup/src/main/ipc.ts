import { timingSafeEqual } from "node:crypto";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, Session } from "electron";
import type { CredentialResponse } from "@ai-dev-os/credential-ui";
import { CREDENTIAL_CHANNELS, CREDENTIAL_ENTRY_URL, type CredentialChannel } from "./constants.js";
import { CredentialHostError, finiteCredentialError } from "./host-error.js";
import { parseCancelPayload, parseDescribePayload, parseRemoveChannelPayload, parseRotatePayload, parseSavePayload, parseValidatePayload, projectCredentialRecord, type CredentialPayload } from "./ipc-schema.js";
import type { CredentialHostService } from "./host-service.js";

interface IpcBoundary {
  readonly token: string;
  readonly webContentsId: number;
  readonly credentialSession: Session;
  readonly service: CredentialHostService;
  readonly window: BrowserWindow;
  touch(): void;
}

function fixedRefusal(error: unknown): CredentialResponse {
  const finite = finiteCredentialError(error);
  if (finite.code === "UNKNOWN_OUTCOME") return Object.freeze({ schemaVersion: 1, requestId: "0".repeat(32), ok: false, kind: "unknown", code: "UNKNOWN_OUTCOME", retryable: false });
  return Object.freeze({ schemaVersion: 1, requestId: "0".repeat(32), ok: false, kind: "refused", code: finite.code, retryable: finite.retryable });
}

export async function withCredentialWriteWatchdog(requestId: string, operation: Promise<CredentialResponse>, timeoutMs = 30_000, onTimeout: () => void = () => undefined): Promise<CredentialResponse> {
  let timer: NodeJS.Timeout | undefined;
  const unknown = new Promise<CredentialResponse>((resolve) => {
    timer = setTimeout(() => {
      try { onTimeout(); } catch { /* fixed finite response */ }
      resolve(Object.freeze({ schemaVersion: 1, requestId, ok: false, kind: "unknown", code: "UNKNOWN_OUTCOME", retryable: false }));
    }, timeoutMs);
  });
  try { return await Promise.race([operation, unknown]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

function tokenMatches(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false;
  if (left.length !== right.length) return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  try {
    if (leftBytes.byteLength !== rightBytes.byteLength) return false;
    return timingSafeEqual(leftBytes, rightBytes);
  }
  finally { leftBytes.fill(0); rightBytes.fill(0); }
}

function guard<T extends CredentialPayload>(event: IpcMainInvokeEvent, raw: unknown, channel: CredentialChannel, parse: (value: unknown) => T, boundary: IpcBoundary): T {
  const frame = event.senderFrame;
  if (frame === null || frame.parent !== null || event.sender.id !== boundary.webContentsId || frame.url !== CREDENTIAL_ENTRY_URL || event.sender.session !== boundary.credentialSession) throw new CredentialHostError("SENDER_REJECTED");
  boundary.service.session.count(channel);
  const record = projectCredentialRecord(raw, channel);
  if (!tokenMatches(record["sessionToken"], boundary.token)) throw new CredentialHostError("TOKEN_REJECTED");
  const payload = parse(record);
  boundary.touch();
  return payload;
}

export function installCredentialIpc(ipcMain: IpcMain, boundary: IpcBoundary): () => void {
  const markWriteOutcomeUnknown = boundary.service.session.writeOutcomeUnknown.bind(boundary.service.session);
  const installed: CredentialChannel[] = [];
  const handle = (channel: CredentialChannel, handler: Parameters<IpcMain["handle"]>[1]): void => {
    ipcMain.handle(channel, handler);
    installed.push(channel);
  };
  const dispose = (): void => {
    for (const channel of installed.splice(0)) {
      try { ipcMain.removeHandler(channel); } catch { /* continue bounded cleanup */ }
    }
  };
  try {
  handle(CREDENTIAL_CHANNELS.describe, async (event, raw) => {
    try { const payload = guard(event, raw, CREDENTIAL_CHANNELS.describe, parseDescribePayload, boundary); return await boundary.service.describe(payload); }
    catch (error) { return fixedRefusal(error); }
  });
  handle(CREDENTIAL_CHANNELS.save, async (event, raw) => {
    try { const payload = guard(event, raw, CREDENTIAL_CHANNELS.save, parseSavePayload, boundary); return await withCredentialWriteWatchdog(payload.requestId, boundary.service.save(payload), 30_000, markWriteOutcomeUnknown); }
    catch (error) { return fixedRefusal(error); }
  });
  handle(CREDENTIAL_CHANNELS.rotate, async (event, raw) => {
    try { const payload = guard(event, raw, CREDENTIAL_CHANNELS.rotate, parseRotatePayload, boundary); return await withCredentialWriteWatchdog(payload.requestId, boundary.service.rotate(payload), 30_000, markWriteOutcomeUnknown); }
    catch (error) { return fixedRefusal(error); }
  });
  handle(CREDENTIAL_CHANNELS.remove, async (event, raw) => {
    try {
      const payload = guard(event, raw, CREDENTIAL_CHANNELS.remove, parseRemoveChannelPayload, boundary);
      return await withCredentialWriteWatchdog(payload.requestId, payload.operation === "set-enabled" ? boundary.service.setEnabled(payload) : boundary.service.remove(payload), 30_000, markWriteOutcomeUnknown);
    } catch (error) { return fixedRefusal(error); }
  });
  handle(CREDENTIAL_CHANNELS.validate, async (event, raw) => {
    try { const payload = guard(event, raw, CREDENTIAL_CHANNELS.validate, parseValidatePayload, boundary); return await boundary.service.validate(payload); }
    catch (error) { return fixedRefusal(error); }
  });
  handle(CREDENTIAL_CHANNELS.cancel, async (event, raw) => {
    try {
      const payload = guard(event, raw, CREDENTIAL_CHANNELS.cancel, parseCancelPayload, boundary);
      const result = boundary.service.cancel(payload);
      queueMicrotask(() => { if (!boundary.window.isDestroyed()) boundary.window.destroy(); });
      return result;
    } catch (error) { return fixedRefusal(error); }
  });
  return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
