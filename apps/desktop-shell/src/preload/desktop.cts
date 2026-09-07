const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const CHANNELS = Object.freeze({
  snapshot: "desktop-shell:snapshot",
  retryService: "desktop-shell:retry-service",
  openReadOnly: "desktop-shell:open-read-only",
  setPreferences: "desktop-shell:set-preferences",
  relaunch: "desktop-shell:relaunch",
  quit: "desktop-shell:quit",
  planningSnapshot: "desktop-shell:planning-snapshot",
  planningCommand: "desktop-shell:planning-command",
  planningObserve: "desktop-shell:planning-observe",
  planningHandover: "desktop-shell:planning-handover",
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

async function planningReply(pending: Promise<unknown>): Promise<unknown> {
  const reply = await pending as { ok?: boolean; value?: unknown };
  if (reply?.ok !== true) throw new Error("PLANNING_UNAVAILABLE");
  return reply.value;
}

contextBridge.exposeInMainWorld("aiPowerhouse", Object.freeze({
  snapshot: () => ipcRenderer.invoke(CHANNELS.snapshot, envelope()),
  retryService: () => ipcRenderer.invoke(CHANNELS.retryService, envelope()),
  openReadOnly: () => ipcRenderer.invoke(CHANNELS.openReadOnly, envelope()),
  setPreferences: (preferences: unknown) => ipcRenderer.invoke(CHANNELS.setPreferences, Object.freeze({ ...envelope(), preferences })),
  relaunch: () => ipcRenderer.invoke(CHANNELS.relaunch, envelope()),
  quit: () => ipcRenderer.invoke(CHANNELS.quit, envelope()),
  planningSnapshot: (projectId: unknown) => planningReply(ipcRenderer.invoke(CHANNELS.planningSnapshot, { ...envelope(), planning: { kind: "snapshot", projectId } })),
  planningCommand: (command: unknown) => planningReply(ipcRenderer.invoke(CHANNELS.planningCommand, { ...envelope(), planning: { kind: "command", command } })),
  planningObserve: (commandId: unknown) => planningReply(ipcRenderer.invoke(CHANNELS.planningObserve, { ...envelope(), planning: { kind: "observe", commandId } })),
  planningHandover: (projectId: unknown, handoverId: unknown) => planningReply(ipcRenderer.invoke(CHANNELS.planningHandover, { ...envelope(), planning: { kind: "handover", projectId, handoverId } })),
  onStateChanged: (listener: (snapshot: unknown) => void) => {
    const handler = (_event: unknown, snapshot: unknown): void => listener(snapshot);
    ipcRenderer.on(CHANNELS.stateChanged, handler);
    return () => ipcRenderer.removeListener(CHANNELS.stateChanged, handler);
  },
}));
