/**
 * Composition ports.
 *
 * The adapter owns argument construction, stream interpretation, and
 * reconciliation. It does not own policy, secrets, artifact storage, workspace
 * ownership, time, or process creation, and it must not depend on the packages
 * that do, or the dependency graph would cycle. Each of those arrives here as
 * a narrow port the trusted composition layer implements.
 *
 * There is exactly one execution seam. Every Claude process — including the
 * version and capability probe — goes through `ClaudeExecutionPort`, which the
 * shipped implementation backs with `@ai-dev-os/process-broker`. A test may
 * substitute a narrow fake for parser-level work, but no second production
 * path to `child_process` exists in this package.
 */

import type { ChangedFileManifest, CommitManifest } from "@ai-dev-os/workspace";
import type {
  CapabilityGrant,
  EnvironmentBinding,
  ExecutionLease,
  ExecutionTrace,
  ProcessResult,
  WorkspaceEnvironmentPaths,
} from "@ai-dev-os/process-broker";
import type { ArtifactKind } from "@ai-dev-os/artifacts";
import type { DataClassification } from "@ai-dev-os/domain";

/** Injected time source. Library code never reads the wall clock directly. */
export interface ClaudeClock {
  now(): Date;
}

export const systemClaudeClock: ClaudeClock = Object.freeze({ now: (): Date => new Date() });

export interface ClaudeDelayHandle {
  readonly promise: Promise<void>;
  /** Cancels the delay; the promise then never resolves. Idempotent. */
  cancel(): void;
}

export interface ClaudeScheduler {
  now(): Date;
  delay(milliseconds: number): ClaudeDelayHandle;
}

export const systemClaudeScheduler: ClaudeScheduler = Object.freeze({
  now: (): Date => new Date(),
  delay(milliseconds: number): ClaudeDelayHandle {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const promise = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timer = null;
        if (!cancelled) {
          resolve();
        }
      }, Math.max(0, milliseconds));
      timer.unref?.();
    });
    return {
      promise,
      cancel(): void {
        cancelled = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      },
    };
  },
});

/**
 * Adapts a manual clock/waiter (for example the provider-testkit
 * ManualScheduler) without importing the test package into runtime code.
 */
export function claudeSchedulerFromManual(manual: {
  now(): Date;
  wait(milliseconds: number): Promise<void>;
}): ClaudeScheduler {
  return Object.freeze({
    now: () => manual.now(),
    delay(milliseconds: number): ClaudeDelayHandle {
      let cancelled = false;
      const promise = new Promise<void>((resolve) => {
        void manual.wait(Math.max(0, milliseconds)).then(() => {
          if (!cancelled) {
            resolve();
          }
        });
      });
      return {
        promise,
        cancel(): void {
          cancelled = true;
        },
      };
    },
  });
}

/**
 * Source of session identifiers. Must produce RFC-4122 UUIDs that are not
 * derived from prompts, source content, secrets, or user identifiers.
 */
export type ClaudeUuidGenerator = () => string;

export const CLAUDE_EXECUTION_KINDS = Object.freeze(["probe", "session"] as const);
export type ClaudeExecutionKind = (typeof CLAUDE_EXECUTION_KINDS)[number];

export interface ClaudeExecutionRequest {
  readonly kind: ClaudeExecutionKind;
  /** The complete finite argument vector the adapter constructed. */
  readonly args: readonly string[];
  /** Task instructions, passed on stdin rather than in the argument list. */
  readonly stdin: Uint8Array | null;
  readonly deadline: string | null;
  readonly wallClockMs: number;
  readonly outputBytes: number;
  /**
   * Environment bindings for this invocation. Secret bindings carry only a
   * reference fingerprint; values are resolved by the process broker's secret
   * resolver after policy approval, immediately before process creation.
   */
  readonly environment: readonly EnvironmentBinding[];
  readonly workspaceId: string;
  readonly trace: ExecutionTrace;
  readonly signal?: AbortSignal;
  readonly onOutput?: (event: { stream: "stdout" | "stderr"; chunk: Uint8Array }) => void;
}

export interface ClaudeExecutionPort {
  execute(request: ClaudeExecutionRequest): Promise<ProcessResult>;
}

/** Machine-readable test evidence read from the managed workspace itself. */
export interface ClaudeTestReport {
  readonly suite: string;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface ClaudeCommitInput {
  readonly message: string;
  readonly committedAt: string;
  readonly policyFingerprint: string;
}

/**
 * A resolved managed workspace. Everything the adapter learns about what
 * changed comes from this handle, never from Claude's narrative.
 */
export interface ClaudeWorkspaceHandle {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly snapshotId: string;
  /** The private workspace revision the attempt started from. */
  readonly baseRevision: string;
  readonly worktreeDir: string;
  readonly managedRoot: string;
  readonly lease: ExecutionLease;
  readonly grant: CapabilityGrant;
  readonly paths: WorkspaceEnvironmentPaths;
  /** True when the handle proved this root is not the user's source tree. */
  readonly isManagedPrivateWorktree: boolean;
  /** Actual added/modified/deleted/renamed files, computed by Git. */
  captureChanges(): Promise<ChangedFileManifest>;
  /** Canonical unified diff bytes for the reconciled change set. */
  capturePatch(maxBytes: number): Promise<Uint8Array>;
  /** Creates a private-workspace commit through the safe commit facility. */
  commit(input: ClaudeCommitInput): Promise<CommitManifest>;
  /** Reads a bounded machine-readable test report, when one is present. */
  readTestReport(relativePath: string, maxBytes: number): Promise<ClaudeTestReport | null>;
  /** Reports whether a workspace-relative path is a link or reparse point. */
  linkMetadata(relativePath: string): Promise<{ readonly isLink: boolean }>;
}

export interface ClaudeWorkspacePort {
  /** Returns null when the workspace id names nothing this host manages. */
  resolve(workspaceId: string): Promise<ClaudeWorkspaceHandle | null>;
}

export const CLAUDE_ARTIFACT_CATEGORIES = Object.freeze([
  "patch",
  "command-log",
  "diagnostics",
  "test-report",
  "session-metadata",
] as const);
export type ClaudeArtifactCategory = (typeof CLAUDE_ARTIFACT_CATEGORIES)[number];

export interface ClaudeArtifactWrite {
  readonly category: ClaudeArtifactCategory;
  readonly kind: ArtifactKind;
  readonly bytes: Uint8Array;
  readonly classification: DataClassification;
  readonly mediaType: string;
}

/**
 * Persists a produced artifact. Returning null means policy or retention
 * refused the write; the adapter then reports the operation without that
 * artifact and never writes the content anywhere else.
 */
export interface ClaudeArtifactSink {
  write(input: ClaudeArtifactWrite): Promise<string | null>;
}

/** A sink that persists nothing, for read-only or retention-denied contexts. */
export const denyingArtifactSink: ClaudeArtifactSink = Object.freeze({
  write: async (): Promise<string | null> => null,
});

export interface ClaudeSessionPolicyInput {
  readonly instanceId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly requestId: string;
  readonly classification: DataClassification;
  readonly capabilities: readonly string[];
  readonly commandPolicyMode: string;
  readonly networkPolicy: string;
  readonly approvalMode: string;
  readonly continuationRequested: boolean;
  readonly configurationFingerprint: string;
}

export interface ClaudeSessionPolicyDecision {
  readonly outcome: "allowed" | "denied" | "conditional";
  /** Stable reason code. Never free-form text or repository content. */
  readonly reasonCode: string | null;
  readonly sessionPersistenceAllowed: boolean;
  readonly artifactPersistenceAllowed: boolean;
  readonly diagnosticRetentionAllowed: boolean;
  /** Structured approval evidence references that already cover this action. */
  readonly approvalEvidenceRefs: readonly string[];
  /** Tools an approval decision explicitly authorized beyond the defaults. */
  readonly approvedToolNames: readonly string[];
}

/**
 * The Stage 6 policy bridge for the session as a whole. The process broker
 * separately evaluates the exact command; this port answers the questions that
 * precede argument construction.
 */
export interface ClaudeSessionPolicyPort {
  evaluateSession(
    input: ClaudeSessionPolicyInput,
  ): Promise<ClaudeSessionPolicyDecision> | ClaudeSessionPolicyDecision;
}

/** A policy port that allows read-only, non-persisting development sessions. */
export const permissiveDevelopmentPolicy: ClaudeSessionPolicyPort = Object.freeze({
  evaluateSession: (): ClaudeSessionPolicyDecision =>
    Object.freeze({
      outcome: "allowed" as const,
      reasonCode: null,
      sessionPersistenceAllowed: false,
      artifactPersistenceAllowed: true,
      diagnosticRetentionAllowed: true,
      approvalEvidenceRefs: Object.freeze([]),
      approvedToolNames: Object.freeze([]),
    }),
});
