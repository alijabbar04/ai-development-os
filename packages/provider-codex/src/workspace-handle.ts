import { join } from "node:path";
import {
  captureWorktreeDiff,
  createWorkspaceAccess,
  createWorkspaceCommit,
  decodeTrimmed,
  runGitChecked,
  type ChangedFileManifest,
  type GitRuntime,
  type ManagedWorkspaceRecord,
} from "@ai-dev-os/workspace";
import type { CapabilityGrant, ExecutionLease, WorkspaceEnvironmentPaths } from "@ai-dev-os/process-broker";
import type { CodexTestReport, CodexWorkspaceHandle } from "./ports.js";

export function createCodexWorkspaceHandle(options: {
  readonly runtime: GitRuntime;
  readonly record: ManagedWorkspaceRecord;
  readonly lease: ExecutionLease;
  readonly grant: CapabilityGrant;
  readonly paths: WorkspaceEnvironmentPaths;
  readonly sourceRepositoryRoot?: string | null;
  readonly gitTimeoutMs?: number;
}): CodexWorkspaceHandle {
  const { runtime, record, lease, grant, paths } = options;
  const timeoutMs = options.gitTimeoutMs ?? 120_000;
  const sourceRoot = options.sourceRepositoryRoot ?? null;
  const normalize = (path: string) => join(path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const access = createWorkspaceAccess({ worktreeDir: record.worktreeDir, grant, lease });
  return Object.freeze({
    workspaceId: record.workspaceId, projectId: record.projectId, attemptId: record.attemptId,
    snapshotId: record.snapshotId, baseRevision: record.snapshotCommit, worktreeDir: record.worktreeDir,
    managedRoot: record.managedRoot, lease, grant, paths,
    isManagedPrivateWorktree: sourceRoot === null || normalize(record.worktreeDir) !== normalize(sourceRoot),
    captureChanges: async (): Promise<ChangedFileManifest> => await captureWorktreeDiff(runtime, { workspace: record, timeoutMs }),
    async capturePatch(maxBytes: number): Promise<Uint8Array> {
      const result = await runGitChecked(runtime.runner, [...runtime.configArguments(), "diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "-C", record.snapshotCommit, "--"], {
        cwd: record.worktreeDir, env: runtime.environment({ gitDir: record.repositoryDir, workTree: record.worktreeDir }), timeoutMs,
        maxOutputBytes: Math.max(1_024, maxBytes), operation: "capture-codex-patch",
      });
      return new Uint8Array(result.stdout.subarray(0, maxBytes));
    },
    commit: async (input: { readonly message: string; readonly committedAt: string; readonly policyFingerprint: string }) => await createWorkspaceCommit(runtime, { workspace: record, message: input.message, committedAt: input.committedAt, authorCategory: "agent", policyFingerprint: input.policyFingerprint, timeoutMs }),
    async readTestReport(relativePath: string, maxBytes: number): Promise<CodexTestReport | null> {
      try { const raw = await access.read(relativePath); if (raw.byteLength === 0 || raw.byteLength > maxBytes) return null; return parseCodexTestReport(decodeTrimmed(Buffer.from(raw))); }
      catch { return null; }
    },
    async linkMetadata(relativePath: string) { const value = await access.linkMetadata(relativePath); return Object.freeze({ isLink: value.isLink }); },
  });
}

export function parseCodexTestReport(text: string): CodexTestReport | null {
  let value: unknown; try { value = JSON.parse(text) as unknown; } catch { return null; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>; if (Object.keys(record).some((key) => ["__proto__", "constructor", "prototype"].includes(key))) return null;
  const count = (entry: unknown) => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0 && entry <= 1_000_000 ? entry : null;
  const passed = count(record["passed"]), failed = count(record["failed"]), skipped = count(record["skipped"]);
  if (passed === null || failed === null || skipped === null) return null;
  const suite = typeof record["suite"] === "string" && record["suite"].length > 0 && record["suite"].length <= 256 && !/[\u0000-\u001f\u007f]/.test(record["suite"]) ? record["suite"] : "workspace-test-report";
  return Object.freeze({ suite, passed, failed, skipped });
}
