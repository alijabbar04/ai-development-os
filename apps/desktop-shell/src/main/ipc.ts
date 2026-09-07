import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, Session } from "electron";
import {
  DESKTOP_CHANNELS,
  DESKTOP_ENTRY_URL,
  type DesktopPreferenceUpdate,
  type DesktopPreferences,
  type DesktopRefusalCode,
  type DesktopRequestChannel,
  type DesktopResult,
  type DesktopSnapshot,
} from "../shared/contracts.js";
import { assertDesktopIpcEvent, parseDesktopRequest } from "./ipc-schema.js";

export interface DesktopIpcActions {
  snapshot(): DesktopSnapshot;
  retryService(): Promise<DesktopSnapshot>;
  openReadOnly(): DesktopSnapshot;
  setPreferences(preferences: DesktopPreferences): Promise<DesktopSnapshot>;
  relaunch(): Promise<void>;
  quit(): Promise<void>;
}

export interface DesktopIpcBoundary {
  readonly token: string;
  readonly webContentsId: number;
  readonly desktopSession: Session;
  readonly window: BrowserWindow;
  readonly actions: DesktopIpcActions;
}

function refusalCode(error: unknown): DesktopRefusalCode {
  const message = error instanceof Error ? error.message : "";
  if (message === "SENDER_REJECTED") return "SENDER_REJECTED";
  if (message === "TOKEN_REJECTED") return "TOKEN_REJECTED";
  if (message === "ACTION_UNAVAILABLE") return "ACTION_UNAVAILABLE";
  if (message.startsWith("SERVICE_")) return "SERVICE_UNAVAILABLE";
  return "INVALID_REQUEST";
}

function requestIdOf(raw: unknown): string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "0".repeat(32);
  const value = (raw as Record<string, unknown>)["requestId"];
  return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value) ? value : "0".repeat(32);
}

function guard(event: IpcMainInvokeEvent, raw: unknown, channel: DesktopRequestChannel, boundary: DesktopIpcBoundary) {
  const frame = event.senderFrame;
  assertDesktopIpcEvent({
    senderId: event.sender.id,
    expectedSenderId: boundary.webContentsId,
    frameUrl: frame?.url ?? null,
    expectedFrameUrl: DESKTOP_ENTRY_URL,
    topLevelFrame: frame !== null && frame.parent === null,
    sameSession: event.sender.session === boundary.desktopSession,
  });
  return parseDesktopRequest(raw, channel, boundary.token);
}

function success<T>(requestId: string, value: T): DesktopResult<T> {
  return Object.freeze({ schemaVersion: 1, requestId, ok: true, value });
}

function refused<T>(requestId: string, error: unknown): DesktopResult<T> {
  return Object.freeze({ schemaVersion: 1, requestId, ok: false, code: refusalCode(error) });
}

export function installDesktopIpc(ipcMain: IpcMain, boundary: DesktopIpcBoundary): () => void {
  const installed: DesktopRequestChannel[] = [];
  const handle = (channel: DesktopRequestChannel, callback: Parameters<IpcMain["handle"]>[1]): void => {
    ipcMain.handle(channel, callback);
    installed.push(channel);
  };
  const dispose = (): void => {
    for (const channel of installed.splice(0)) {
      try { ipcMain.removeHandler(channel); } catch { /* bounded cleanup */ }
    }
  };
  const invoke = <T>(channel: DesktopRequestChannel, operation: (request: ReturnType<typeof guard>) => T | Promise<T>) => {
    handle(channel, async (event, raw) => {
      const requestId = requestIdOf(raw);
      try {
        const request = guard(event, raw, channel, boundary);
        return success(request.requestId, await operation(request));
      } catch (error) {
        return refused<T>(requestId, error);
      }
    });
  };
  try {
    invoke(DESKTOP_CHANNELS.snapshot, () => boundary.actions.snapshot());
    invoke(DESKTOP_CHANNELS.retryService, async () => await boundary.actions.retryService());
    invoke(DESKTOP_CHANNELS.openReadOnly, () => boundary.actions.openReadOnly());
    invoke(DESKTOP_CHANNELS.setPreferences, async (request) => {
      if (!("preferences" in request)) throw new Error("INVALID_REQUEST");
      return await boundary.actions.setPreferences((request as DesktopPreferenceUpdate).preferences);
    });
    invoke(DESKTOP_CHANNELS.relaunch, async () => { await boundary.actions.relaunch(); return Object.freeze({ completed: true as const }); });
    invoke(DESKTOP_CHANNELS.quit, async () => { await boundary.actions.quit(); return Object.freeze({ completed: true as const }); });
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}

export function publishDesktopSnapshot(window: BrowserWindow, snapshot: DesktopSnapshot): void {
  if (!window.isDestroyed()) window.webContents.send(DESKTOP_CHANNELS.stateChanged, snapshot);
}
