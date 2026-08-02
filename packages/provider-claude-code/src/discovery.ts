/**
 * Claude Code executable discovery and capability probing.
 *
 * There is no `PATH` lookup at spawn time. The composition layer names an
 * absolute image; this module checks that the image is a real file rather than
 * a shell shim or a link, and then learns the CLI's version by running it
 * through the same execution seam every other invocation uses.
 *
 * On Windows the npm-installed `claude.cmd` shim is refused rather than
 * reached through `cmd.exe`. When only a shim is present the result is a
 * structured `unsupported` outcome carrying installation guidance, not an
 * attempt to make it work.
 */

import { lstat } from "node:fs/promises";
import { basename } from "node:path";
import {
  WINDOWS_SHELL_SHIM_PATTERN,
  parseCliVersion,
  type ClaudeAdapterConfiguration,
} from "./config.js";
import {
  UNSUPPORTED_PROFILE,
  resolveCompatibilityProfile,
  type ClaudeCompatibilityProfile,
} from "./compatibility.js";
import type { ClaudeExecutionPort } from "./ports.js";
import type { ExecutionTrace } from "@ai-dev-os/process-broker";
import { decodeSafeText } from "@ai-dev-os/process-broker";
import type { ClaudeDetailCode } from "./errors.js";

export const CLAUDE_PROBE_STATUSES = Object.freeze([
  "compatible",
  "unsupported-version",
  "executable-unavailable",
  "executable-unsafe",
  "authentication-unavailable",
  "probe-failed",
] as const);
export type ClaudeProbeStatus = (typeof CLAUDE_PROBE_STATUSES)[number];

export interface ClaudeProbeResult {
  readonly status: ClaudeProbeStatus;
  readonly detailCode: ClaudeDetailCode | null;
  /** Reported `major.minor.patch`, when the probe read one. */
  readonly version: string | null;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly profile: ClaudeCompatibilityProfile;
  /** Whether the resolved image is a regular file the adapter may execute. */
  readonly executableResolved: boolean;
  /** Digest evidence bound into the Stage 8 trusted-tool flow, when pinned. */
  readonly expectedDigestHex: string | null;
  readonly probedAt: string;
  /**
   * Non-secret installation guidance for a human. Never contains a filesystem
   * path, a credential, or CLI output.
   */
  readonly guidance: string | null;
}

/** The version banner the CLI prints, e.g. `2.1.201 (Claude Code)`. */
const VERSION_BANNER = /^(\d{1,6}\.\d{1,6}\.\d{1,6})\b/;

export function parseVersionBanner(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 256) {
    return null;
  }
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
  const match = VERSION_BANNER.exec(firstLine.trim());
  const version = match?.[1];
  if (version === undefined || parseCliVersion(version) === null) {
    return null;
  }
  return version;
}

/**
 * Filesystem-level checks that must pass before the image is executed. These
 * are lexical and stat-based; the process broker re-verifies type, link state,
 * containment, and digest immediately before the process is created.
 */
export async function inspectExecutable(
  configuration: ClaudeAdapterConfiguration,
  options: { readonly platform?: NodeJS.Platform } = {},
): Promise<{
  readonly ok: boolean;
  readonly detailCode: ClaudeDetailCode | null;
  readonly guidance: string | null;
}> {
  const platform = options.platform ?? process.platform;
  const descriptor = configuration.executable;

  if (descriptor.platform !== platform) {
    return frozen(false, "executable-unsafe", "The trusted executable descriptor targets another platform.");
  }

  const imagePath =
    descriptor.pinnedLeadingArguments === null || descriptor.pinnedLeadingArguments.length === 0
      ? descriptor.executablePath
      : descriptor.executablePath;

  if (platform === "win32" && WINDOWS_SHELL_SHIM_PATTERN.test(imagePath)) {
    return frozen(
      false,
      "executable-shell-shim",
      "Windows command-script shims require a shell and are refused. Install the native Claude Code executable, or reference a trusted interpreter plus the verified entry point.",
    );
  }

  let info;
  try {
    info = await lstat(imagePath);
  } catch {
    return frozen(
      false,
      "executable-missing",
      "The configured Claude Code executable could not be inspected. Install Claude Code and point the adapter at the native executable.",
    );
  }
  if (info.isSymbolicLink()) {
    return frozen(
      false,
      "executable-unsafe",
      "The configured Claude Code path is a link or reparse point, so the bytes verified may not be the bytes executed.",
    );
  }
  if (!info.isFile()) {
    return frozen(false, "executable-unsafe", "The configured Claude Code path is not a regular file.");
  }
  // A pinned prefix means the trusted image is an interpreter and the entry
  // point is an argument; the shim rule still applies to the entry point.
  const pinned = descriptor.pinnedLeadingArguments ?? [];
  for (const entry of pinned) {
    if (platform === "win32" && WINDOWS_SHELL_SHIM_PATTERN.test(basename(entry))) {
      return frozen(
        false,
        "executable-shell-shim",
        "A pinned entry point is a Windows command-script shim and is refused.",
      );
    }
  }
  return frozen(true, null, null);
}

function frozen(
  ok: boolean,
  detailCode: ClaudeDetailCode | null,
  guidance: string | null,
): { readonly ok: boolean; readonly detailCode: ClaudeDetailCode | null; readonly guidance: string | null } {
  return Object.freeze({ ok, detailCode, guidance });
}

/**
 * Reads the installed CLI's version through the execution seam and resolves
 * the compatibility profile. The probe runs `--version` only: it starts no
 * session, sends no prompt, and cannot consume model usage.
 */
export async function probeClaudeCli(input: {
  readonly configuration: ClaudeAdapterConfiguration;
  readonly execution: ClaudeExecutionPort;
  readonly trace: ExecutionTrace;
  readonly workspaceId: string;
  readonly probedAt: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly timeoutMs?: number;
}): Promise<ClaudeProbeResult> {
  const platform = input.platform ?? process.platform;
  const architecture = input.architecture ?? process.arch;
  const base = {
    platform,
    architecture,
    expectedDigestHex: input.configuration.executable.expectedDigestHex,
    probedAt: input.probedAt,
  } as const;

  const inspection = await inspectExecutable(input.configuration, { platform });
  if (!inspection.ok) {
    return Object.freeze({
      ...base,
      status: inspection.detailCode === "executable-shell-shim" ? "executable-unsafe" : "executable-unavailable",
      detailCode: inspection.detailCode,
      version: null,
      profile: UNSUPPORTED_PROFILE,
      executableResolved: false,
      guidance: inspection.guidance,
    });
  }

  let result;
  try {
    result = await input.execution.execute({
      kind: "probe",
      args: ["--version"],
      stdin: null,
      deadline: null,
      wallClockMs: input.timeoutMs ?? 30_000,
      outputBytes: 65_536,
      environment: [],
      workspaceId: input.workspaceId,
      trace: input.trace,
    });
  } catch {
    return Object.freeze({
      ...base,
      status: "probe-failed",
      detailCode: "probe-failed",
      version: null,
      profile: UNSUPPORTED_PROFILE,
      executableResolved: true,
      guidance: "The Claude Code executable could not be started through the process broker.",
    });
  }

  if (!result.succeeded) {
    return Object.freeze({
      ...base,
      status: "probe-failed",
      detailCode: "probe-failed",
      version: null,
      profile: UNSUPPORTED_PROFILE,
      executableResolved: true,
      guidance: "The Claude Code version probe exited unsuccessfully.",
    });
  }

  const version = parseVersionBanner(decodeSafeText(result.output.stdout, 4_096));
  if (version === null) {
    return Object.freeze({
      ...base,
      status: "probe-failed",
      detailCode: "probe-unparseable",
      version: null,
      profile: UNSUPPORTED_PROFILE,
      executableResolved: true,
      guidance: "The Claude Code version banner was not in the documented form.",
    });
  }

  const profile = resolveCompatibilityProfile({
    version,
    minimumCliVersion: input.configuration.minimumCliVersion,
    validatedCliVersion: input.configuration.validatedCliVersion,
  });

  if (profile.tier === "unsupported-too-old") {
    return Object.freeze({
      ...base,
      status: "unsupported-version",
      detailCode: "version-unsupported",
      version,
      profile,
      executableResolved: true,
      guidance: `Claude Code ${input.configuration.minimumCliVersion} or newer is required. Run "claude update" to upgrade the installation.`,
    });
  }
  if (!profile.usableForProduction) {
    return Object.freeze({
      ...base,
      status: "unsupported-version",
      detailCode: "capability-missing",
      version,
      profile,
      executableResolved: true,
      guidance:
        "The installed Claude Code cannot disable every ambient customization source with the confidence this adapter requires.",
    });
  }

  return Object.freeze({
    ...base,
    status: "compatible",
    detailCode: null,
    version,
    profile,
    executableResolved: true,
    guidance: null,
  });
}

/**
 * Authentication is probed separately and only as an observation. The adapter
 * never reads a credential file, an OAuth token, a keychain entry, or the
 * output of a credential helper: the only honest signal available without
 * crossing that boundary is how a real session failed, so an authentication
 * verdict is recorded when a session reports one and is otherwise unknown.
 */
export const CLAUDE_AUTHENTICATION_OBSERVATIONS = Object.freeze([
  "unknown",
  "session-succeeded",
  "session-rejected",
] as const);
export type ClaudeAuthenticationObservation = (typeof CLAUDE_AUTHENTICATION_OBSERVATIONS)[number];
