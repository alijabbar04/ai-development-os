import {
  DESKTOP_PROTOCOL,
  DESKTOP_PROTOCOL_HOST,
} from "../shared/contracts.js";

export const DESKTOP_ELECTRON_VERSION = "43.4.1" as const;
export const VISIBLE_WINDOW_DEADLINE_MS = 30_000 as const;
export const SERVICE_READY_DEADLINE_MS = 20_000 as const;
export const SERVICE_SHUTDOWN_DEADLINE_MS = 5_000 as const;
export const DESKTOP_MIN_WIDTH = 1_024 as const;
export const DESKTOP_MIN_HEIGHT = 720 as const;
export const DESKTOP_PROTOCOL_SCHEME = DESKTOP_PROTOCOL;
export const DESKTOP_PROTOCOL_ORIGIN = `${DESKTOP_PROTOCOL}://${DESKTOP_PROTOCOL_HOST}` as const;

export const DESKTOP_RENDERER_FILES = Object.freeze([
  "renderer/index.html",
  "renderer/styles.css",
  "renderer/entry.js",
  "renderer/components.js",
  "renderer/ai-planning.js",
  "renderer/planning-edit-buffer.js",
  "presentation/adapter.js",
  "examples/workspace-example.js",
] as const);

export const DESKTOP_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "media-src 'none'",
  "worker-src 'none'",
].join("; ");

export function assertDesktopElectronVersion(value: unknown): asserts value is typeof DESKTOP_ELECTRON_VERSION {
  if (value !== DESKTOP_ELECTRON_VERSION) throw new Error("DESKTOP_ELECTRON_VERSION_UNREVIEWED");
}
