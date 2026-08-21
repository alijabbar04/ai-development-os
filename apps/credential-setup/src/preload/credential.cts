const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const CHANNELS = Object.freeze({
  describe: "credential-vault:describe",
  save: "credential-vault:save",
  rotate: "credential-vault:rotate",
  remove: "credential-vault:remove",
  validate: "credential-vault:validate",
  cancel: "credential-vault:cancel",
} as const);

const ARGUMENT = "--credential-session-token=";
const SESSION_TOKEN = process.argv.find((value) => value.startsWith(ARGUMENT))?.slice(ARGUMENT.length) ?? "";

function requestId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function envelope(): Readonly<{ schemaVersion: 1; requestId: string; sessionToken: string }> {
  return Object.freeze({ schemaVersion: 1, requestId: requestId(), sessionToken: SESSION_TOKEN });
}

contextBridge.exposeInMainWorld("credentialVault", Object.freeze({
  describe: () => ipcRenderer.invoke(CHANNELS.describe, Object.freeze({ ...envelope() })),
  save: (slotId: string, secret: string, nickname: string, ownership: string, authorizedBy: string, clearClipboard: boolean) => ipcRenderer.invoke(CHANNELS.save, Object.freeze({ ...envelope(), slotId, secret, nickname, ownership, authorizedBy, clearClipboard })),
  rotate: (slotId: string, secret: string, credentialId: string, recordRevision: number, recordToken: string, clearClipboard: boolean) => ipcRenderer.invoke(CHANNELS.rotate, Object.freeze({ ...envelope(), slotId, secret, credentialId, recordRevision, recordToken, clearClipboard })),
  setEnabled: (slotId: string, credentialId: string, recordRevision: number, recordToken: string, enabled: boolean) => ipcRenderer.invoke(CHANNELS.remove, Object.freeze({ ...envelope(), action: "set-enabled", slotId, credentialId, recordRevision, recordToken, enabled })),
  remove: (slotId: string, credentialId: string, recordRevision: number, recordToken: string, acknowledgedRemoval: true) => ipcRenderer.invoke(CHANNELS.remove, Object.freeze({ ...envelope(), action: "remove", slotId, credentialId, recordRevision, recordToken, acknowledgedRemoval })),
  validate: (slotId: string, credentialId: string, recordRevision: number, recordToken: string, acknowledgedDisclosure: true) => ipcRenderer.invoke(CHANNELS.validate, Object.freeze({ ...envelope(), slotId, credentialId, recordRevision, recordToken, acknowledgedDisclosure })),
  cancel: () => ipcRenderer.invoke(CHANNELS.cancel, Object.freeze({ ...envelope() })),
}));
