import type { ArtifactKind } from "@ai-dev-os/artifacts";
import type { DataClassification } from "@ai-dev-os/domain";
import type {
  CapabilityGrant,
  DuplexProcessSession,
  EnvironmentBinding,
  ExecutionLease,
  ExecutionTrace,
  ProcessResult,
  WorkspaceEnvironmentPaths,
} from "@ai-dev-os/process-broker";
import type { ChangedFileManifest, CommitManifest } from "@ai-dev-os/workspace";

export interface CodexClock { now(): Date }
export const systemCodexClock: CodexClock = Object.freeze({ now: () => new Date() });

export interface CodexDelayHandle { readonly promise: Promise<void>; cancel(): void }
export interface CodexScheduler { delay(milliseconds: number): CodexDelayHandle }
export const systemCodexScheduler: CodexScheduler = Object.freeze({
  delay(milliseconds: number): CodexDelayHandle {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const promise = new Promise<void>((resolve) => {
      timer = setTimeout(() => { timer = null; if (!cancelled) resolve(); }, Math.max(0, milliseconds));
      timer.unref?.();
    });
    return Object.freeze({
      promise,
      cancel(): void { cancelled = true; if (timer !== null) clearTimeout(timer); timer = null; },
    });
  },
});

export type CodexIdGenerator = () => string;
export const CODEX_PROCESS_KINDS = Object.freeze(["probe", "schema", "app-server"] as const);
export type CodexProcessKind = (typeof CODEX_PROCESS_KINDS)[number];

export interface CodexProcessRequest {
  readonly kind: CodexProcessKind;
  readonly args: readonly string[];
  readonly deadline: string | null;
  readonly wallClockMs: number;
  readonly outputBytes: number;
  readonly environment: readonly EnvironmentBinding[];
  readonly workspaceId: string;
  readonly trace: ExecutionTrace;
  readonly signal?: AbortSignal;
}

export interface CodexProcessPort {
  execute(request: CodexProcessRequest): Promise<ProcessResult>;
  open(request: CodexProcessRequest): Promise<DuplexProcessSession>;
}

export interface CodexTestReport {
  readonly suite: string;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface CodexWorkspaceHandle {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly snapshotId: string;
  readonly baseRevision: string;
  readonly worktreeDir: string;
  readonly managedRoot: string;
  readonly lease: ExecutionLease;
  readonly grant: CapabilityGrant;
  readonly paths: WorkspaceEnvironmentPaths;
  readonly isManagedPrivateWorktree: boolean;
  captureChanges(): Promise<ChangedFileManifest>;
  capturePatch(maxBytes: number): Promise<Uint8Array>;
  commit(input: { readonly message: string; readonly committedAt: string; readonly policyFingerprint: string }): Promise<CommitManifest>;
  readTestReport(relativePath: string, maxBytes: number): Promise<CodexTestReport | null>;
  linkMetadata(relativePath: string): Promise<{ readonly isLink: boolean }>;
}

export interface CodexWorkspacePort { resolve(workspaceId: string): Promise<CodexWorkspaceHandle | null> }

export const CODEX_ARTIFACT_CATEGORIES = Object.freeze(["patch", "diagnostics", "test-report", "session-metadata"] as const);
export type CodexArtifactCategory = (typeof CODEX_ARTIFACT_CATEGORIES)[number];
export interface CodexArtifactWrite {
  readonly category: CodexArtifactCategory;
  readonly kind: ArtifactKind;
  readonly bytes: Uint8Array;
  readonly classification: DataClassification;
  readonly mediaType: string;
}
export interface CodexArtifactSink { write(input: CodexArtifactWrite): Promise<string | null> }
export const denyingCodexArtifactSink: CodexArtifactSink = Object.freeze({ write: async () => null });

export interface CodexSessionPolicyDecision {
  readonly outcome: "allowed" | "denied" | "conditional";
  readonly reasonCode: string | null;
  readonly sessionPersistenceAllowed: boolean;
  readonly artifactPersistenceAllowed: boolean;
  readonly diagnosticRetentionAllowed: boolean;
}
export interface CodexSessionPolicyPort {
  evaluateSession(input: {
    readonly instanceId: string;
    readonly projectId: string;
    readonly workspaceId: string;
    readonly requestId: string;
    readonly classification: DataClassification;
    readonly capabilities: readonly string[];
    readonly continuationRequested: boolean;
    readonly configurationFingerprint: string;
  }): Promise<CodexSessionPolicyDecision> | CodexSessionPolicyDecision;
}
export const permissiveCodexDevelopmentPolicy: CodexSessionPolicyPort = Object.freeze({
  evaluateSession: () => Object.freeze({ outcome: "allowed" as const, reasonCode: null, sessionPersistenceAllowed: false, artifactPersistenceAllowed: true, diagnosticRetentionAllowed: true }),
});

export type CodexApprovalAction = "command-execution" | "file-change";
export type CodexApprovalRisk = "read-only" | "mutating" | "destructive";
export interface CodexApprovalEvidence {
  readonly approvalId: string;
  readonly decision: "approved" | "denied" | "cancelled";
  readonly threadId: string;
  readonly turnId: string;
  readonly action: CodexApprovalAction;
  readonly risk: CodexApprovalRisk;
  readonly subjectDigest: string;
  readonly expiresAt: string;
  readonly repeatedAction: boolean;
}
export interface CodexApprovalPort {
  evidence(input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly action: CodexApprovalAction;
    readonly risk: CodexApprovalRisk;
    readonly subjectDigest: string;
  }): Promise<CodexApprovalEvidence | null>;
}
export const decliningCodexApprovalPort: CodexApprovalPort = Object.freeze({ evidence: async () => null });
