import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  UNSAFE_BACKEND_ID,
  createExecutionLease,
  createProcessBroker,
  createTrustedToolDescriptor,
  createUnsafeDevelopmentBackend,
  parseCapabilityGrant,
  type CapabilityGrant,
  type ExecutionLease,
  type ExecutionMode,
  type ProcessBroker,
  type WorkspaceEnvironmentPaths,
} from "@ai-dev-os/process-broker";
import {
  captureSnapshot,
  createGitRuntime,
  createManagedWorkspace,
  discoverRepository,
  type GitRuntime,
  type ManagedWorkspaceRecord,
  type RepositorySnapshot,
} from "@ai-dev-os/workspace";
import { createManualScheduler, type ManualScheduler } from "@ai-dev-os/provider-testkit";
import {
  createBrokeredCodexProcessPort,
  createCodexAdapterConfiguration,
  createCodexProvider,
  createCodexWorkspaceHandle,
  type CodexAdapterConfiguration,
  type CodexApprovalEvidence,
  type CodexArtifactSink,
  type CodexArtifactWrite,
  type CodexProcessPort,
  type CodexProvider,
  type CodexScheduler,
  type CodexWorkspaceHandle,
  type CodexWorkspacePort,
} from "../../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FAKE_CODEX_PATH = resolve(HERE, "fake-codex-app-server.mjs");
export const SCRATCH = mkdtempSync(join(tmpdir(), "adox-codex-scratch-"));
export const HARNESS_EPOCH = "2026-08-03T12:00:00.000Z";
export const POLICY_FINGERPRINT = "a".repeat(64);
export const WORKSPACE_ID = "ws-codex";
export const PROJECT_ID = "proj-codex";
export const INTERNAL_DISCLOSURE = Object.freeze({ classification: "internal" as const, requiredLocality: "any" as const, redactionApplied: true, decisionRef: "decision-codex-test", retentionAllowed: true, loggingAllowed: false });
export const TEST_TRACE = Object.freeze({ traceId: "trace-codex", runId: null, taskId: null, taskRunId: null });

const bases: string[] = [];
let harnessSequence = 0;

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git fixture failed: ${result.stderr ?? ""}`);
}

async function sourceRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "adox-codex-source-")); bases.push(root);
  git(root, ["init", "--initial-branch=main"]); git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "user.email", "fixture@invalid.example"]); git(root, ["config", "commit.gpgsign", "false"]);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "tracked.txt"), "original\n", "utf8");
  await writeFile(join(root, "src", "main.ts"), "export const value = 1;\n", "utf8");
  git(root, ["add", "--all"]); git(root, ["commit", "-m", "fixture"]);
  return root;
}

export interface FakeCodexScenario {
  readonly version?: string; readonly versionExitCode?: number; readonly schemaMethods?: readonly string[]; readonly schemaExitCode?: number;
  readonly startMarker?: string; readonly doneMarker?: string; readonly childMarker?: string; readonly argvOut?: string; readonly environmentOut?: string; readonly receivedOut?: string; readonly approvalOut?: string;
  readonly environmentCanaryNames?: readonly string[]; readonly beforeFiles?: readonly Record<string, unknown>[]; readonly afterFiles?: readonly Record<string, unknown>[];
  readonly splitBytes?: number; readonly beforeInitialize?: boolean; readonly malformed?: boolean; readonly invalidUtf8?: boolean; readonly oversized?: number; readonly unknownMethod?: boolean; readonly unknownId?: boolean; readonly duplicateResponse?: boolean;
  readonly reportedModel?: string; readonly reportedEffort?: string; readonly agentText?: string | false; readonly plan?: boolean; readonly command?: boolean; readonly fileClaim?: boolean; readonly claimedPath?: string;
  readonly warnings?: readonly ("warning" | "guardianWarning" | "configWarning")[]; readonly modelRerouted?: boolean; readonly threadStartError?: unknown;
  readonly approval?: "command" | "file"; readonly usage?: Record<string, unknown> | false; readonly turnError?: unknown; readonly hang?: boolean; readonly hangAfterClose?: boolean;
  readonly stderr?: string; readonly stderrOnStart?: boolean; readonly exitCode?: number; readonly ignoreSignals?: boolean; readonly spawnChild?: boolean; readonly outOfOrder?: boolean;
  readonly account?: unknown; readonly rateLimits?: unknown; readonly accountUsage?: unknown; readonly unsupportedRate?: boolean; readonly unsupportedUsage?: boolean;
}

export interface RecordingArtifactSink extends CodexArtifactSink { readonly writes: readonly CodexArtifactWrite[] }
function artifactSink(): RecordingArtifactSink {
  const writes: CodexArtifactWrite[] = []; let sequence = 0;
  return Object.freeze({ writes, async write(input: CodexArtifactWrite) { writes.push(input); return `artifact-codex-${++sequence}`; } });
}

function schedulerAdapter(manual: ManualScheduler): CodexScheduler {
  return Object.freeze({
    delay(milliseconds: number) {
      let active = true;
      const promise = new Promise<void>((resolvePromise) => { void manual.wait(milliseconds).then(() => { if (active) resolvePromise(); }); });
      return Object.freeze({ promise, cancel(): void { active = false; } });
    },
  });
}

export interface HarnessOptions {
  readonly scenario: FakeCodexScenario;
  readonly mode?: ExecutionMode;
  readonly operations?: readonly string[];
  readonly writablePrefixes?: readonly string[];
  readonly executablePath?: string;
  readonly pinnedArguments?: readonly string[] | null;
  readonly configuration?: Partial<Parameters<typeof createCodexAdapterConfiguration>[0]>;
  readonly policyOutcome?: "allowed" | "denied" | "conditional";
  readonly persistenceAllowed?: boolean;
  readonly artifactPersistenceAllowed?: boolean;
  readonly approval?: "approved" | "denied" | "cancelled" | "forged" | "expired" | "repeated";
  readonly probeResult?: import("../../src/index.js").CodexProbeResult;
}

export interface CodexHarness {
  readonly base: string; readonly sourceRoot: string; readonly worktreeDir: string;
  readonly runtime: GitRuntime; readonly record: ManagedWorkspaceRecord; readonly snapshot: RepositorySnapshot;
  readonly grant: CapabilityGrant; readonly lease: ExecutionLease; readonly broker: ProcessBroker;
  readonly process: CodexProcessPort; readonly configuration: CodexAdapterConfiguration;
  readonly workspace: CodexWorkspaceHandle; readonly workspaces: CodexWorkspacePort;
  readonly provider: CodexProvider; readonly scheduler: ManualScheduler; readonly artifacts: RecordingArtifactSink;
  readonly scenarioPath: string;
  writeScenario(scenario: FakeCodexScenario): Promise<void>;
  close(): Promise<void>;
}

export async function createCodexHarness(options: HarnessOptions): Promise<CodexHarness> {
  harnessSequence += 1;
  const base = await mkdtemp(join(tmpdir(), "adox-codex-")); bases.push(base);
  const managedRootBase = join(base, "managed"), storageRoot = join(base, "snapshots"), sessionRoot = join(base, "sessions"), envRoot = join(base, "environment");
  for (const path of [managedRootBase, storageRoot, sessionRoot, envRoot, join(envRoot, "tmp")]) await mkdir(path, { recursive: true });
  const sourceRoot = await sourceRepository();
  const runtime = await createGitRuntime({ root: join(base, "runtime") });
  const discovery = await discoverRepository(runtime, { directory: sourceRoot });
  const snapshot = await captureSnapshot(runtime, { projectId: PROJECT_ID, snapshotId: `snap-codex-${harnessSequence}`, discovery, storageRoot, capturedAt: HARNESS_EPOCH, allowDirty: true });
  const record = await createManagedWorkspace(runtime, { projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, attemptId: `attempt-codex-${harnessSequence}`, snapshot, managedRootBase, createdAt: HARNESS_EPOCH, expiresAt: "2026-08-04T12:00:00.000Z", policyFingerprint: POLICY_FINGERPRINT });
  const scheduler = createManualScheduler(HARNESS_EPOCH), codexScheduler = schedulerAdapter(scheduler);
  const scenarioPath = join(base, "scenario.json"); await writeFile(scenarioPath, JSON.stringify(options.scenario), "utf8");
  const tool = createTrustedToolDescriptor({
    toolId: "codex", executablePath: options.executablePath ?? process.execPath,
    platform: process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
    architecture: process.arch === "arm64" ? "arm64" : "x64", trustSource: "operator-pinned",
    argumentPolicy: { maxArguments: 256, maxArgumentBytes: 32_768, pinnedLeadingArguments: options.pinnedArguments === undefined ? [FAKE_CODEX_PATH, scenarioPath] : options.pinnedArguments, denyOptionArguments: false },
  });
  const configuration = createCodexAdapterConfiguration({
    instanceId: "codex-1", executable: tool,
    compatibility: { minimum: "0.146.0-alpha.1", validatedMaximum: "0.146.0-alpha.99" },
    models: [{ modelId: "gpt-5.2-codex", efforts: ["low", "medium", "high", "xhigh"] }], defaultModel: "gpt-5.2-codex", defaultEffort: "high",
    ceilings: { maxTurns: 8, maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000, maxProcessOutputBytes: 8_388_608, maxCostMicros: 1_000_000 },
    deadlines: { operationMs: 120_000, handshakeMs: 10_000, requestMs: 30_000, shutdownMs: 2_000 },
    jsonl: { maxRecordBytes: 262_144, maxRecords: 10_000, maxStreamBytes: 8_388_608, maxPendingRequests: 64, maxRequestId: 1_000_000, maxQueuedEvents: 128, maxQueuedEventBytes: 1_048_576, maxQueuedWriteBytes: 1_048_576 },
    sessions: { persistence: "ephemeral-only", retentionMs: 0 }, sandboxMappings: ["read-only", "workspace-write"], approvalMappings: ["never", "on-request"], dataClassifications: ["public", "internal", "proprietary-source"], capacityStalenessMs: 60_000, authentication: "account-managed",
    ...options.configuration,
  });
  const grant = parseCapabilityGrant({
    schemaVersion: 2, grantId: `grant-codex-${harnessSequence}`, projectId: PROJECT_ID, runId: null, taskId: null, attemptId: record.attemptId, snapshotId: snapshot.snapshotId, workspaceId: WORKSPACE_ID,
    operations: options.operations ?? ["workspace-read", "workspace-write", "command-execution", "git-commit"], readablePrefixes: [""], writablePrefixes: options.writablePrefixes ?? [""], tools: [{ toolId: "codex", digest: null, immutableReference: null }], environmentNames: [], credentialRefFingerprints: [], controlPlaneEndpointPolicyFingerprint: null, network: { mode: "denied", egressDomains: [] },
    quotas: { wallClockMs: 120_000, cpuTimeMs: null, memoryBytes: null, processCount: null, outputBytes: 8_388_608, diskBytes: null, fileCount: null },
    issuedAt: "2026-08-03T11:59:00.000Z", expiresAt: "2026-08-04T12:00:00.000Z", nonce: "b".repeat(32), policyFingerprint: POLICY_FINGERPRINT, approvalEvidenceRefs: [],
  });
  const lease = createExecutionLease({ leaseId: `lease-codex-${harnessSequence}`, grant, clock: scheduler });
  const broker = createProcessBroker({
    backend: createUnsafeDevelopmentBackend({ sessionRoot }), mode: options.mode ?? "development", approvedBackendIds: [UNSAFE_BACKEND_ID], clock: scheduler,
    scheduler: { schedule(delayMs, callback) { const handle = codexScheduler.delay(delayMs); void handle.promise.then(callback); return { cancel: handle.cancel }; } },
    policy: { evaluateCommand: ({ request }) => ({ outcome: "allowed" as const, fingerprint: request.policyDecisionFingerprint, approvalsToConsume: [] }) },
  });
  const paths: WorkspaceEnvironmentPaths = Object.freeze({ tempDir: join(envRoot, "tmp"), homeDir: null, configDir: null, cacheDir: null });
  const processPort = createBrokeredCodexProcessPort({ broker, configuration, projectId: PROJECT_ID, attemptId: record.attemptId, grant, lease, policyDecisionFingerprint: POLICY_FINGERPRINT, workspaceRoot: record.managedRoot, workingDirectory: record.worktreeDir, workspacePaths: paths });
  const workspace = createCodexWorkspaceHandle({ runtime, record, lease, grant, paths, sourceRepositoryRoot: sourceRoot });
  const workspaces: CodexWorkspacePort = Object.freeze({ resolve: async (id) => id === WORKSPACE_ID ? workspace : null });
  const artifacts = artifactSink();
  const provider = createCodexProvider({
    configuration, process: processPort, workspace: workspaces, artifacts, clock: scheduler, scheduler: codexScheduler,
    runProbe: async () => options.probeResult ?? Object.freeze({ status: "ready", version: "0.146.0-alpha.9.2", schemaDigest: "c".repeat(64), schemaFileCount: 1, methods: Object.freeze([]), detailCode: null, compatibility: Object.freeze({ matrixVersion: 1, tier: "supported-0-146", version: "0.146.0-alpha.9.2", schemaDigest: "c".repeat(64), missingRequiredMethods: Object.freeze([]), usableForReadOnly: true, usableForStateChanging: true }) }),
    policy: { evaluateSession: () => ({ outcome: options.policyOutcome ?? "allowed", reasonCode: null, sessionPersistenceAllowed: options.persistenceAllowed ?? false, artifactPersistenceAllowed: options.artifactPersistenceAllowed ?? true, diagnosticRetentionAllowed: true }) },
    approvals: { async evidence(input): Promise<CodexApprovalEvidence | null> {
      if (options.approval === undefined) return null;
      return Object.freeze({ approvalId: options.approval === "forged" ? "approval-forged" : "approval-approval-rpc-1", decision: options.approval === "denied" ? "denied" : options.approval === "cancelled" ? "cancelled" : "approved", ...input, expiresAt: options.approval === "expired" ? "2026-08-03T11:00:00.000Z" : "2026-08-03T13:00:00.000Z", repeatedAction: options.approval === "repeated" });
    } },
  });
  return Object.freeze({
    base, sourceRoot, worktreeDir: record.worktreeDir, runtime, record, snapshot, grant, lease, broker, process: processPort, configuration, workspace, workspaces, provider, scheduler, artifacts, scenarioPath,
    writeScenario: async (scenario) => await writeFile(scenarioPath, JSON.stringify(scenario), "utf8"),
    async close() { await provider.close(); await broker.close(); lease.release(); await runtime.dispose(); },
  });
}

export function markerExists(path: string): boolean { return existsSync(path); }
export async function cleanupCodexFixtures(): Promise<void> { await Promise.allSettled([...bases.splice(0).map((path) => rm(path, { recursive: true, force: true })), rm(SCRATCH, { recursive: true, force: true })]); }
