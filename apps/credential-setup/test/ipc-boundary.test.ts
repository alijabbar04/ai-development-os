import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, Session } from "electron";
import { describe, expect, it, vi } from "vitest";
import { CREDENTIAL_CHANNELS, CREDENTIAL_ENTRY_URL } from "../src/main/constants.js";
import { CredentialHostError } from "../src/main/host-error.js";
import { installCredentialIpc } from "../src/main/ipc.js";
import type { CredentialHostService } from "../src/main/host-service.js";

type Handler = (event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>;

const TOKEN = "a".repeat(64);
const REQUEST_ID = "1".repeat(32);
const IDENTITY = Object.freeze({
  slotId: "anthropic",
  credentialId: `cred-${"3".repeat(32)}`,
  recordRevision: 4,
  recordToken: "4".repeat(64),
});

function harness(rateLimitAfter = Number.POSITIVE_INFINITY) {
  const handlers = new Map<string, Handler>();
  const removed: string[] = [];
  const calls: string[] = [];
  const counted: string[] = [];
  let touches = 0;
  let destroys = 0;
  const credentialSession = Object.freeze({ name: "bounded-session" }) as unknown as Session;
  const response = (kind: string) => Object.freeze({ schemaVersion: 1, requestId: REQUEST_ID, ok: true, kind });
  const service = {
    session: {
      count(channel: string) {
        counted.push(channel);
        if (counted.length > rateLimitAfter) throw new CredentialHostError("RATE_LIMITED");
      },
      writeOutcomeUnknown() { calls.push("write-outcome-unknown"); },
    },
    async describe() { calls.push("describe"); return response("slots"); },
    async save() { calls.push("save"); return response("saved"); },
    async rotate() { calls.push("rotate"); return response("rotated"); },
    async setEnabled() { calls.push("set-enabled"); return response("disabled"); },
    async remove() { calls.push("remove"); return response("removed"); },
    async validate() { calls.push("validate"); return response("validated"); },
    cancel() { calls.push("cancel"); return response("cancelled"); },
  } as unknown as CredentialHostService;
  const ipcMain = {
    handle(channel: string, handler: Handler) { handlers.set(channel, handler); },
    removeHandler(channel: string) { removed.push(channel); handlers.delete(channel); },
  } as unknown as IpcMain;
  const window = {
    isDestroyed: () => false,
    destroy: () => { destroys += 1; },
  } as unknown as BrowserWindow;
  const event = (input: Readonly<{ id?: number; session?: Session; url?: string; parent?: object | null; nullFrame?: boolean }> = {}) => ({
    senderFrame: input.nullFrame === true ? null : { parent: input.parent ?? null, url: input.url ?? CREDENTIAL_ENTRY_URL },
    sender: { id: input.id ?? 17, session: input.session ?? credentialSession },
  }) as unknown as IpcMainInvokeEvent;
  const dispose = installCredentialIpc(ipcMain, {
    token: TOKEN,
    webContentsId: 17,
    credentialSession,
    service,
    window,
    touch() { touches += 1; },
  });
  return {
    handlers,
    removed,
    calls,
    counted,
    event,
    credentialSession,
    dispose,
    touches: () => touches,
    destroys: () => destroys,
  };
}

function invoke(control: ReturnType<typeof harness>, channel: string, raw: unknown, event = control.event()): Promise<unknown> {
  const handler = control.handlers.get(channel);
  if (handler === undefined) throw new Error(`Missing handler: ${channel}`);
  return handler(event, raw);
}

function envelope(token = TOKEN) {
  return Object.freeze({ schemaVersion: 1, requestId: REQUEST_ID, sessionToken: token });
}

describe("credential IPC boundary", () => {
  it("installs and removes exactly the six reviewed channels", () => {
    const control = harness();
    expect([...control.handlers.keys()].sort()).toEqual(Object.values(CREDENTIAL_CHANNELS).sort());
    control.dispose();
    expect(control.handlers.size).toBe(0);
    expect(control.removed.sort()).toEqual(Object.values(CREDENTIAL_CHANNELS).sort());
  });

  it("removes every partial registration if IPC installation fails", () => {
    const installed: string[] = [];
    const removed: string[] = [];
    const ipcMain = {
      handle(channel: string) {
        if (installed.length === 2) throw new Error("synthetic-handle-failure");
        installed.push(channel);
      },
      removeHandler(channel: string) { removed.push(channel); },
    } as unknown as IpcMain;
    const service = { session: { writeOutcomeUnknown() { /* never invoked */ } } } as unknown as CredentialHostService;
    expect(() => installCredentialIpc(ipcMain, {
      token: TOKEN,
      webContentsId: 17,
      credentialSession: Object.freeze({}) as unknown as Session,
      service,
      window: Object.freeze({}) as unknown as BrowserWindow,
      touch() { /* never invoked */ },
    })).toThrow("synthetic-handle-failure");
    expect(removed).toEqual(installed);
  });

  it("accepts only the bound top-level frame, exact origin URL, webContents, and dedicated session", async () => {
    const controls = [
      { nullFrame: true },
      { parent: {} },
      { id: 18 },
      { url: `${CREDENTIAL_ENTRY_URL}?unexpected=1` },
      { url: "app-credential://other/index.html" },
      { session: Object.freeze({}) as unknown as Session },
    ] as const;
    for (const override of controls) {
      const control = harness();
      const result = await invoke(control, CREDENTIAL_CHANNELS.describe, envelope(), control.event(override));
      expect(result).toMatchObject({ ok: false, code: "SENDER_REJECTED", requestId: "0".repeat(32) });
      expect(control.calls).toEqual([]);
      expect(control.counted).toEqual([]);
      expect(control.touches()).toBe(0);
    }
  });

  it("checks the sender before projecting hostile input and rejects schema or token without work", async () => {
    const control = harness();
    const getter = vi.fn(() => { throw new Error("PRIVATE_GETTER_CANARY"); });
    const hostile = Object.defineProperty({}, "requestId", { enumerable: true, get: getter });
    const senderResult = await invoke(control, CREDENTIAL_CHANNELS.describe, hostile, control.event({ id: 18 }));
    expect(senderResult).toMatchObject({ ok: false, code: "SENDER_REJECTED" });
    expect(getter).not.toHaveBeenCalled();

    const schemaResult = await invoke(control, CREDENTIAL_CHANNELS.describe, hostile);
    expect(schemaResult).toMatchObject({ ok: false, code: "SCHEMA_REJECTED", requestId: "0".repeat(32) });
    expect(getter).not.toHaveBeenCalled();

    const tokenResult = await invoke(control, CREDENTIAL_CHANNELS.describe, envelope("b".repeat(64)));
    expect(tokenResult).toMatchObject({ ok: false, code: "TOKEN_REJECTED", requestId: "0".repeat(32) });
    expect(control.calls).toEqual([]);
    expect(control.counted).toEqual([CREDENTIAL_CHANNELS.describe, CREDENTIAL_CHANNELS.describe]);
    expect(control.touches()).toBe(0);
    expect(JSON.stringify([senderResult, schemaResult, tokenResult])).not.toContain("PRIVATE_GETTER_CANARY");
  });

  it("rejects every wrong token form before operation-field parsing or work", async () => {
    for (const sessionToken of ["", "b".repeat(63), "b".repeat(65), "é".repeat(64), 17, null]) {
      const control = harness();
      const raw = { schemaVersion: "hostile-schema", requestId: { nested: true }, sessionToken, slotId: { hostile: true }, secret: new Proxy({}, {}), nickname: 99, ownership: "hostile", authorizedBy: [], clearClipboard: "yes" };
      const result = await invoke(control, CREDENTIAL_CHANNELS.save, raw);
      expect(result).toMatchObject({ ok: false, code: "TOKEN_REJECTED", requestId: "0".repeat(32) });
      expect(control.calls).toEqual([]);
      expect(control.counted).toEqual([CREDENTIAL_CHANNELS.save]);
      expect(control.touches()).toBe(0);
    }
  });

  it("projects malformed input to a fixed refusal on every channel", async () => {
    const control = harness();
    for (const channel of Object.values(CREDENTIAL_CHANNELS)) {
      const result = await invoke(control, channel, Object.freeze({}));
      expect(result).toMatchObject({ ok: false, code: "SCHEMA_REJECTED", requestId: "0".repeat(32) });
    }
    expect(control.calls).toEqual([]);
    expect(control.counted).toEqual(Object.values(CREDENTIAL_CHANNELS));
  });

  it("counts authenticated malformed invocations before projection and exhausts the finite boundary", async () => {
    const control = harness(10);
    for (let index = 0; index < 10; index += 1) {
      const result = await invoke(control, CREDENTIAL_CHANNELS.describe, Object.freeze({}));
      expect(result).toMatchObject({ ok: false, code: "SCHEMA_REJECTED" });
    }
    const limited = await invoke(control, CREDENTIAL_CHANNELS.describe, Object.freeze({}));
    expect(limited).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    expect(control.counted).toHaveLength(11);
    expect(control.calls).toEqual([]);
    expect(control.touches()).toBe(0);
  });

  it("routes each closed schema to one narrow operation and destroys the window after cancel", async () => {
    const control = harness();
    await invoke(control, CREDENTIAL_CHANNELS.describe, envelope());
    await invoke(control, CREDENTIAL_CHANNELS.save, { ...envelope(), slotId: "anthropic", secret: "SYNTHETIC_IPC_VALUE", nickname: "Synthetic", ownership: "owned", authorizedBy: "", clearClipboard: true });
    await invoke(control, CREDENTIAL_CHANNELS.rotate, { ...envelope(), ...IDENTITY, secret: "SYNTHETIC_ROTATE_VALUE", clearClipboard: false });
    await invoke(control, CREDENTIAL_CHANNELS.remove, { ...envelope(), action: "set-enabled", ...IDENTITY, enabled: false });
    await invoke(control, CREDENTIAL_CHANNELS.remove, { ...envelope(), action: "remove", ...IDENTITY, acknowledgedRemoval: true });
    await invoke(control, CREDENTIAL_CHANNELS.validate, { ...envelope(), ...IDENTITY, acknowledgedDisclosure: true });
    await invoke(control, CREDENTIAL_CHANNELS.cancel, envelope());
    await Promise.resolve();

    expect(control.calls).toEqual(["describe", "save", "rotate", "set-enabled", "remove", "validate", "cancel"]);
    expect(control.counted).toEqual([
      CREDENTIAL_CHANNELS.describe,
      CREDENTIAL_CHANNELS.save,
      CREDENTIAL_CHANNELS.rotate,
      CREDENTIAL_CHANNELS.remove,
      CREDENTIAL_CHANNELS.remove,
      CREDENTIAL_CHANNELS.validate,
      CREDENTIAL_CHANNELS.cancel,
    ]);
    expect(control.touches()).toBe(7);
    expect(control.destroys()).toBe(1);
  });
});
