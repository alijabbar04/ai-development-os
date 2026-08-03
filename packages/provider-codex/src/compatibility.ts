export const CODEX_COMPATIBILITY_MATRIX_VERSION = 1 as const;
export const CODEX_REQUIRED_METHODS = Object.freeze([
  "initialize", "initialized", "thread/start", "thread/resume", "turn/start", "turn/interrupt",
  "turn/started", "item/started", "item/completed", "turn/completed", "account/read",
  "account/rateLimits/read", "account/rateLimits/updated", "account/usage/read",
] as const);

export const CODEX_COMPATIBILITY_TIERS = Object.freeze([
  "unsupported-too-old", "supported-0-146", "newer-than-validated", "schema-incompatible",
] as const);
export type CodexCompatibilityTier = (typeof CODEX_COMPATIBILITY_TIERS)[number];

export interface CodexCompatibilityProfile {
  readonly matrixVersion: typeof CODEX_COMPATIBILITY_MATRIX_VERSION;
  readonly tier: CodexCompatibilityTier;
  readonly version: string;
  readonly schemaDigest: string | null;
  readonly missingRequiredMethods: readonly string[];
  readonly usableForReadOnly: boolean;
  readonly usableForStateChanging: boolean;
}
function components(version: string): readonly number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (match === null) return null;
  const values = match.slice(1, 4).map(Number);
  return values.every(Number.isSafeInteger) ? values : null;
}

export function compareCodexVersions(left: string, right: string): -1 | 0 | 1 | null {
  const a = components(left); const b = components(right);
  if (a === null || b === null) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! < b[index]!) return -1;
    if (a[index]! > b[index]!) return 1;
  }
  return 0;
}

export function resolveCodexCompatibility(input: {
  readonly version: string;
  readonly minimum: string;
  readonly validatedMaximum: string;
  readonly schemaDigest: string | null;
  readonly methods: readonly string[];
}): CodexCompatibilityProfile {
  const below = compareCodexVersions(input.version, input.minimum);
  const above = compareCodexVersions(input.version, input.validatedMaximum);
  const known = new Set(input.methods);
  const missing = Object.freeze(CODEX_REQUIRED_METHODS.filter((method) => !known.has(method)));
  let tier: CodexCompatibilityTier;
  if (below === null || below < 0) tier = "unsupported-too-old";
  else if (missing.length > 0 || input.schemaDigest === null) tier = "schema-incompatible";
  else if (above !== null && above > 0) tier = "newer-than-validated";
  else tier = "supported-0-146";
  return Object.freeze({
    matrixVersion: CODEX_COMPATIBILITY_MATRIX_VERSION,
    tier,
    version: input.version,
    schemaDigest: input.schemaDigest,
    missingRequiredMethods: missing,
    usableForReadOnly: tier === "supported-0-146" || tier === "newer-than-validated",
    usableForStateChanging: tier === "supported-0-146",
  });
}
