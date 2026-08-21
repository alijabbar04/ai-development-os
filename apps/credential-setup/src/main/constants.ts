export const CREDENTIAL_ENTRY_URL = "app-credential://entry/index.html" as const;
export const CREDENTIAL_PROTOCOL = "app-credential" as const;
export const CREDENTIAL_PROTOCOL_HOST = "entry" as const;
export const CREDENTIAL_SESSION_PARTITION = "credential-entry" as const;
export const CREDENTIAL_SESSION_ARGUMENT = "--credential-session-token=" as const;
export const CREDENTIAL_RENDERER_FILES = Object.freeze(["index.html", "entry.js", "entry.css"] as const);
export const CREDENTIAL_ELECTRON_VERSION = "43.4.1" as const;

export function assertCredentialElectronVersion(value: unknown): asserts value is typeof CREDENTIAL_ELECTRON_VERSION {
  if (value !== CREDENTIAL_ELECTRON_VERSION) throw new Error("CREDENTIAL_ELECTRON_VERSION_UNREVIEWED");
}

export const CREDENTIAL_CSP = [
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

export const CREDENTIAL_CHANNELS = Object.freeze({
  describe: "credential-vault:describe",
  save: "credential-vault:save",
  rotate: "credential-vault:rotate",
  remove: "credential-vault:remove",
  validate: "credential-vault:validate",
  cancel: "credential-vault:cancel",
} as const);

export type CredentialChannel = (typeof CREDENTIAL_CHANNELS)[keyof typeof CREDENTIAL_CHANNELS];
