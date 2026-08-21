import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Session } from "electron";
import { CREDENTIAL_CSP, CREDENTIAL_PROTOCOL, CREDENTIAL_PROTOCOL_HOST, CREDENTIAL_RENDERER_FILES } from "./constants.js";

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  "index.html": "text/html; charset=utf-8",
  "entry.js": "text/javascript; charset=utf-8",
  "entry.css": "text/css; charset=utf-8",
});

export interface CredentialProtocolResolution {
  readonly status: 200 | 403 | 404;
  readonly target: string | null;
  readonly contentType: string | null;
}

export function resolveCredentialProtocolRequest(requestUrl: string, rendererRoot: string): CredentialProtocolResolution {
  let url: URL;
  try { url = new URL(requestUrl); }
  catch { return Object.freeze({ status: 404, target: null, contentType: null }); }
  if (url.protocol !== `${CREDENTIAL_PROTOCOL}:` || url.host !== CREDENTIAL_PROTOCOL_HOST || url.username !== "" || url.password !== "" || url.port !== "" || url.search !== "" || url.hash !== "") return Object.freeze({ status: 404, target: null, contentType: null });
  let requested: string;
  try { requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname); }
  catch { return Object.freeze({ status: 404, target: null, contentType: null }); }
  const name = requested.replace(/^\/+/, "").replaceAll("\\", "/");
  if (name.includes("/") || name === "." || name === ".." || !CREDENTIAL_RENDERER_FILES.includes(name as never)) return Object.freeze({ status: name.includes("..") ? 403 : 404, target: null, contentType: null });
  const root = resolve(rendererRoot);
  const target = resolve(join(root, name));
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) return Object.freeze({ status: 403, target: null, contentType: null });
  return Object.freeze({ status: 200, target, contentType: CONTENT_TYPES[name]! });
}

export function installCredentialProtocol(credentialSession: Session, rendererRoot: string): void {
  credentialSession.protocol.handle(CREDENTIAL_PROTOCOL, async (request) => {
    const resolution = resolveCredentialProtocolRequest(request.url, rendererRoot);
    if (resolution.status !== 200 || resolution.target === null || resolution.contentType === null) return new Response(null, { status: resolution.status });
    const electron = await import("electron");
    const local = await electron.net.fetch(pathToFileURL(resolution.target).toString());
    const headers = new Headers(local.headers);
    headers.set("Content-Security-Policy", CREDENTIAL_CSP);
    headers.set("Content-Type", resolution.contentType);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Cache-Control", "no-store");
    return new Response(local.body, { status: local.status, headers });
  });
}
