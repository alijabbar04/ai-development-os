const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const CHANNELS = Object.freeze({
  snapshot: "desktop-shell:snapshot",
  retryService: "desktop-shell:retry-service",
  openReadOnly: "desktop-shell:open-read-only",
  setPreferences: "desktop-shell:set-preferences",
  relaunch: "desktop-shell:relaunch",
  quit: "desktop-shell:quit",
  stateChanged: "desktop-shell:state-changed",
} as const);
const ARGUMENT = "--desktop-session-token=";
const SESSION_TOKEN = process.argv.find((value) => value.startsWith(ARGUMENT))?.slice(ARGUMENT.length) ?? "";

function requestId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function envelope(): Readonly<{ schemaVersion: 1; requestId: string; sessionToken: string }> {
  return Object.freeze({ schemaVersion: 1, requestId: requestId(), sessionToken: SESSION_TOKEN });
}

contextBridge.exposeInMainWorld("aiPowerhouse", Object.freeze({
  snapshot: () => ipcRenderer.invoke(CHANNELS.snapshot, envelope()),
  retryService: () => ipcRenderer.invoke(CHANNELS.retryService, envelope()),
  openReadOnly: () => ipcRenderer.invoke(CHANNELS.openReadOnly, envelope()),
  setPreferences: (preferences: unknown) => ipcRenderer.invoke(CHANNELS.setPreferences, Object.freeze({ ...envelope(), preferences })),
  relaunch: () => ipcRenderer.invoke(CHANNELS.relaunch, envelope()),
  quit: () => ipcRenderer.invoke(CHANNELS.quit, envelope()),
  onStateChanged: (listener: (snapshot: unknown) => void) => {
    const handler = (_event: unknown, snapshot: unknown): void => listener(snapshot);
    ipcRenderer.on(CHANNELS.stateChanged, handler);
    return () => ipcRenderer.removeListener(CHANNELS.stateChanged, handler);
  },
}));
