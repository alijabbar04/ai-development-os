/**
 * The Claude Code compatibility matrix.
 *
 * A flag is sent because this table says the probed CLI supports it, never
 * because a documentation page mentions it. The matrix is versioned so that a
 * future CLI can add a tier without silently changing what an older, already
 * validated installation is asked to do.
 *
 * The `2.1` tier was validated against Claude Code 2.1.201 by reading that
 * binary's own `--help` output. Every flag listed as supported there appears
 * in it verbatim.
 */

import { compareCliVersions } from "./config.js";

export const COMPATIBILITY_MATRIX_VERSION = 1 as const;

export const CLAUDE_COMPATIBILITY_TIERS = Object.freeze([
  "unsupported-too-old",
  "supported-2-1",
  "newer-than-validated",
] as const);
export type ClaudeCompatibilityTier = (typeof CLAUDE_COMPATIBILITY_TIERS)[number];

/**
 * The capabilities the adapter needs. Each one maps to a documented flag or
 * behavior; an installation missing any required capability is incompatible
 * for production rather than run with a weaker invocation.
 */
export interface ClaudeCliCapabilities {
  readonly printMode: boolean;
  readonly streamJsonOutput: boolean;
  readonly verboseEvents: boolean;
  readonly partialMessages: boolean;
  readonly modelSelection: boolean;
  readonly effortSelection: boolean;
  readonly maxTurns: boolean;
  readonly budgetCap: boolean;
  readonly sessionId: boolean;
  readonly resume: boolean;
  readonly sessionPersistenceControl: boolean;
  readonly safeMode: boolean;
  readonly toolRestriction: boolean;
  readonly allowedTools: boolean;
  readonly disallowedTools: boolean;
  readonly permissionModeDontAsk: boolean;
  readonly strictMcpConfig: boolean;
  readonly chromeDisable: boolean;
  readonly settingSources: boolean;
}

const CAPABILITY_KEYS = [
  "printMode",
  "streamJsonOutput",
  "verboseEvents",
  "partialMessages",
  "modelSelection",
  "effortSelection",
  "maxTurns",
  "budgetCap",
  "sessionId",
  "resume",
  "sessionPersistenceControl",
  "safeMode",
  "toolRestriction",
  "allowedTools",
  "disallowedTools",
  "permissionModeDontAsk",
  "strictMcpConfig",
  "chromeDisable",
  "settingSources",
] as const satisfies readonly (keyof ClaudeCliCapabilities)[];

/**
 * Capabilities without which the adapter refuses to construct an invocation.
 * `--max-turns` is deliberately absent: the installed 2.1.201 CLI exposes no
 * such flag, so the turn ceiling is enforced by the adapter from the stream's
 * own turn accounting rather than claimed as a CLI-enforced cap.
 */
export const REQUIRED_CAPABILITIES: readonly (keyof ClaudeCliCapabilities)[] = Object.freeze([
  "printMode",
  "streamJsonOutput",
  "verboseEvents",
  "safeMode",
  "toolRestriction",
  "disallowedTools",
  "permissionModeDontAsk",
  "strictMcpConfig",
  "chromeDisable",
  "sessionPersistenceControl",
]);

const TIER_2_1_CAPABILITIES: ClaudeCliCapabilities = Object.freeze({
  printMode: true,
  streamJsonOutput: true,
  verboseEvents: true,
  partialMessages: true,
  modelSelection: true,
  effortSelection: true,
  // The 2.1 CLI has no --max-turns flag. Turn limiting is the adapter's job.
  maxTurns: false,
  budgetCap: true,
  sessionId: true,
  resume: true,
  sessionPersistenceControl: true,
  safeMode: true,
  toolRestriction: true,
  allowedTools: true,
  disallowedTools: true,
  permissionModeDontAsk: true,
  strictMcpConfig: true,
  chromeDisable: true,
  settingSources: true,
});

const NO_CAPABILITIES: ClaudeCliCapabilities = Object.freeze(
  Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false])) as unknown as ClaudeCliCapabilities,
);

export interface ClaudeCompatibilityProfile {
  readonly matrixVersion: typeof COMPATIBILITY_MATRIX_VERSION;
  readonly tier: ClaudeCompatibilityTier;
  readonly capabilities: ClaudeCliCapabilities;
  /** Required capabilities the probed CLI does not provide. */
  readonly missingRequiredCapabilities: readonly (keyof ClaudeCliCapabilities)[];
  readonly usableForProduction: boolean;
}

/**
 * Resolves the compatibility profile for a reported version.
 *
 * A version newer than the validated ceiling is reported as
 * `newer-than-validated` and keeps the last validated capability set: a newer
 * CLI is assumed to still support what it supported, never to have gained
 * something this matrix has not seen.
 */
export function resolveCompatibilityProfile(input: {
  readonly version: string;
  readonly minimumCliVersion: string;
  readonly validatedCliVersion: string;
}): ClaudeCompatibilityProfile {
  const belowMinimum = compareCliVersions(input.version, input.minimumCliVersion);
  if (belowMinimum === null) {
    return profile("unsupported-too-old", NO_CAPABILITIES);
  }
  if (belowMinimum < 0) {
    return profile("unsupported-too-old", NO_CAPABILITIES);
  }
  const aboveValidated = compareCliVersions(input.version, input.validatedCliVersion);
  const tier: ClaudeCompatibilityTier =
    aboveValidated !== null && aboveValidated > 0 ? "newer-than-validated" : "supported-2-1";
  return profile(tier, TIER_2_1_CAPABILITIES);
}

function profile(
  tier: ClaudeCompatibilityTier,
  capabilities: ClaudeCliCapabilities,
): ClaudeCompatibilityProfile {
  const missing = Object.freeze(REQUIRED_CAPABILITIES.filter((key) => !capabilities[key]));
  return Object.freeze({
    matrixVersion: COMPATIBILITY_MATRIX_VERSION,
    tier,
    capabilities,
    missingRequiredCapabilities: missing,
    usableForProduction: tier !== "unsupported-too-old" && missing.length === 0,
  });
}

export const UNSUPPORTED_PROFILE: ClaudeCompatibilityProfile = profile(
  "unsupported-too-old",
  NO_CAPABILITIES,
);
