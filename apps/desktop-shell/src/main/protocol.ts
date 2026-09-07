import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Protocol, Session } from "electron";
import {
  DESKTOP_PROTOCOL,
  DESKTOP_PROTOCOL_HOST,
} from "../shared/contracts.js";
import { DESKTOP_CSP, DESKTOP_RENDERER_FILES } from "./constants.js";

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  "renderer/index.html": "text/html; charset=utf-8",
  "renderer/styles.css": "text/css; charset=utf-8",
  "renderer/entry.js": "text/javascript; charset=utf-8",
  "renderer/components.js": "text/javascript; charset=utf-8",
  "presentation/adapter.js": "text/javascript; charset=utf-8",
  "examples/workspace-example.js": "text/javascript; charset=utf-8",
});

export interface DesktopProtocolResolution {
  readonly status: 200 | 403 | 404;
  readonly target: string | null;
  readonly contentType: string | null;
}

export function registerDesktopProtocolScheme(protocol: Protocol): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: DESKTOP_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: false,
      corsEnabled: false,
      stream: true,
    },
  }]);
}

export function resolveDesktopProtocolRequest(requestUrl: string, applicationRoot: string): DesktopProtocolResolution {
  let url: URL;
  try { url = new URL(requestUrl); }
  catch { return Object.freeze({ status: 404, target: null, contentType: null }); }
  if (
    url.protocol !== `${DESKTOP_PROTOCOL}:` || url.host !== DESKTOP_PROTOCOL_HOST ||
    url.username !== "" || url.password !== "" || url.port !== "" ||
    url.search !== "" || url.hash !== ""
  ) return Object.freeze({ status: 404, target: null, contentType: null });

  let decoded: string;
  try { decoded = decodeURIComponent(url.pathname).replace(/^\/+/, ""); }
  catch { return Object.freeze({ status: 404, target: null, contentType: null }); }
  if (decoded.includes("\\") || decoded.split("/").includes("..")) {
    return Object.freeze({ status: 403, target: null, contentType: null });
  }
  if (!(DESKTOP_RENDERER_FILES as readonly string[]).includes(decoded)) {
    return Object.freeze({ status: 404, target: null, contentType: null });
  }
  const root = resolve(applicationRoot, "dist");
  const target = resolve(join(root, decoded));
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) return Object.freeze({ status: 403, target: null, contentType: null });
  return Object.freeze({ status: 200, target, contentType: CONTENT_TYPES[decoded] ?? null });
}

export function installDesktopProtocol(desktopSession: Session, applicationRoot: string): void {
  desktopSession.protocol.handle(DESKTOP_PROTOCOL, async (request) => {
    const resolution = resolveDesktopProtocolRequest(request.url, applicationRoot);
    if (resolution.status !== 200 || resolution.target === null || resolution.contentType === null) {
      return new Response(null, { status: resolution.status });
    }
    const { net } = await import("electron");
    const local = await net.fetch(pathToFileURL(resolution.target).toString());
    const headers = new Headers(local.headers);
    headers.set("Content-Security-Policy", DESKTOP_CSP);
    headers.set("Content-Type", resolution.contentType);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Cache-Control", "no-store");
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
    return new Response(local.body, { status: local.status, headers });
  });
}
