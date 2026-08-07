/**
 * Test composition for the Claude Code adapter.
 *
 * Everything here is real: a real temporary Git repository, a real managed
 * private worktree, the real Stage 8 process broker over the explicitly unsafe
 * development backend, and a real child process reached through a trusted
 * `node` image plus a pinned script argument. Only the CLI's behaviour is
 * faked, and it is faked by a genuine executable rather than an in-process stub.
 */

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  UNSAFE_BACKEND_ID,
  createExecutionLease,
  createProcessBroker,
  createUnsafeDevelopmentBackend,
  parseCapabilityGrant,
  type CapabilityGrant,
  type EnvironmentBinding,
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
  claudeSchedulerFromManual,
  createBrokerExecutionPort,
  createClaudeCodeProvider,
  createClaudeAdapterConfiguration,
  createClaudeWorkspaceHandle,
  type ClaudeAdapterConfiguration,
  type ClaudeArtifactSink,
  type ClaudeArtifactWrite,
  type ClaudeCodeProvider,
  type ClaudeExecutionPort,
  type ClaudeObservation,
  type ClaudeWorkspaceHandle,
  type ClaudeWorkspacePort,
} from "../../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FAKE_CLI_PATH = resolve(HERE, "fake-claude-cli.mjs");

/**
 * Scratch directory for fixture output (captured argv, stdin, environment, and
 * armed markers). It lives in the OS temporary directory so a test run never
 * writes anything inside the repository worktree.
 */
export const SCRATCH = mkdtempSync(join(tmpdir(), "adox-cc-scratch-"));

export const HARNESS_EPOCH = "2026-08-02T12:00:00.000Z";
export const POLICY_FINGERPRINT = "a".repeat(64);
export const GRANT_NONCE = "b".repeat(32);
export const WORKSPACE_ID = "ws-claude";
export const PROJECT_ID = "proj-claude";
export const ATTEMPT_ID = "att-claude";

const bases: string[] = [];

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? ""}`);
  }
}

/** A disposable source repository. Never the AI Development OS worktree. */
export async function createTemporaryRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "adox-cc-src-"));
  bases.push(root);
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "user.email", "fixture@ai-dev-os.invalid"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(root, "tracked.txt"), "original\n", "utf8");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "main.ts"), "export const value = 1;\n", "utf8");
  git(root, ["add", "--all"]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

export interface FakeScenario {
  readonly version?: string;
  readonly versionOnly?: boolean;
  readonly reportedModel?: string;
  readonly fragments?: readonly Record<string, unknown>[];
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly hangMs?: number;
  readonly ignoreSignals?: boolean;
  readonly spawnChild?: boolean;
  readonly childMarker?: string;
  readonly childLifetimeMs?: number;
  readonly beforeFiles?: readonly Record<string, unknown>[];
  readonly afterFiles?: readonly Record<string, unknown>[];
  readonly argvOut?: string;
  readonly stdinOut?: string;
  readonly environmentOut?: string;
  readonly environmentCanaryNames?: readonly string[];
  readonly startMarker?: string;
  readonly doneMarker?: string;
}

/** Emits an NDJSON line fragment. */
export function line(record: unknown): Record<string, unknown> {
  return { text: `${JSON.stringify(record)}\n` };
}

export function initRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "system",
    subtype: "init",
    session_id: "{{sessionId}}",
    model: "{{model}}",
    permissionMode: "dontAsk",
    tools: ["Read", "Glob", "Grep"],
    mcp_servers: [],
    plugins: [],
    apiKeySource: "none",
    ...overrides,
  };
}

export function assistantText(text: string): Record<string, unknown> {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

export function toolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  return { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } };
}

export function resultRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1_200,
    duration_api_ms: 900,
    num_turns: 1,
    result: "done",
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 120,
      output_tokens: 45,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 5,
    },
    modelUsage: {},
    permission_denials: [],
    session_id: "{{sessionId}}",
    ...overrides,
  };
}

export interface RecordingArtifactSink extends ClaudeArtifactSink {
  readonly writes: readonly ClaudeArtifactWrite[];
  readonly denyAll: { value: boolean };
}

export function createRecordingArtifactSink(): RecordingArtifactSink {
  const writes: ClaudeArtifactWrite[] = [];
  const denyAll = { value: false };
  let counter = 0;
  return Object.freeze({
    writes,
    denyAll,
    async write(input: ClaudeArtifactWrite): Promise<string | null> {
      if (denyAll.value) {
        return null;
      }
      writes.push(input);
      counter += 1;
      return `artifact-${input.category}-${counter}`;
    },
  });
}

export interface ClaudeHarness {
  readonly base: string;
  /** Trusted root under which the unsafe backend creates and removes one session home. */
  readonly sessionRoot: string;
  readonly sourceRoot: string;
  readonly runtime: GitRuntime;
  readonly snapshot: RepositorySnapshot;
  readonly record: ManagedWorkspaceRecord;
  readonly grant: CapabilityGrant;
  readonly lease: ExecutionLease;
  readonly broker: ProcessBroker;
  readonly execution: ClaudeExecutionPort;
  readonly workspaces: ClaudeWorkspacePort;
  readonly workspace: ClaudeWorkspaceHandle;
  readonly configuration: ClaudeAdapterConfiguration;
  readonly provider: ClaudeCodeProvider;
  readonly scheduler: ManualScheduler;
  readonly artifacts: RecordingArtifactSink;
  readonly observations: readonly ClaudeObservation[];
  readonly scenarioPath: string;
  readonly worktreeDir: string;
  writeScenario(scenario: FakeScenario): Promise<void>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  readonly scenario: FakeScenario;
  readonly mode?: ExecutionMode;
  readonly configuration?: Partial<Parameters<typeof createClaudeAdapterConfiguration>[0]>;
  readonly grantOperations?: readonly string[];
  readonly writablePrefixes?: readonly string[];
  readonly commandExecutionAllowed?: boolean;
  readonly policyOutcome?: "allowed" | "denied" | "conditional";
  readonly personalDevelopmentCanaryOptIn?: boolean;
  readonly approvedToolNames?: readonly string[];
  readonly sessionPersistenceAllowed?: boolean;
  readonly artifactPersistenceAllowed?: boolean;
  readonly toolIdOverride?: string;
  readonly executablePathOverride?: string;
  /** Replaces the fake-CLI pinned prefix; pass [] to invoke the image directly. */
  readonly pinnedLeadingArgumentsOverride?: readonly string[] | null;
  /** Secret bindings the adapter attaches to every session invocation. */
  readonly secretEnvironment?: readonly EnvironmentBinding[];
  /** Values the broker's secret resolver returns, keyed by binding name. */
  readonly secretValues?: ReadonlyMap<string, string>;
}

let harnessCounter = 0;

export async function createClaudeHarness(options: HarnessOptions): Promise<ClaudeHarness> {
  harnessCounter += 1;
  const base = await mkdtemp(join(tmpdir(), "adox-cc-"));
  bases.push(base);
  const managedRootBase = join(base, "managed");
  const storageRoot = join(base, "snapshots");
  const sessionRoot = join(base, "sessions");
  const envRoot = join(base, "env");
  for (const dir of [managedRootBase, storageRoot, sessionRoot, envRoot, join(envRoot, "tmp")]) {
    await mkdir(dir, { recursive: true });
  }

  const sourceRoot = await createTemporaryRepository();
  const runtime = await createGitRuntime({ root: join(base, "runtime") });
  const discovery = await discoverRepository(runtime, { directory: sourceRoot });
  const snapshot = await captureSnapshot(runtime, {
    projectId: PROJECT_ID,
    snapshotId: "snap-claude",
    discovery,
    storageRoot,
    capturedAt: HARNESS_EPOCH,
    allowDirty: true,
  });
  const record = await createManagedWorkspace(runtime, {
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    attemptId: `${ATTEMPT_ID}-${harnessCounter}`,
    snapshot,
    managedRootBase,
    createdAt: HARNESS_EPOCH,
    expiresAt: new Date(new Date(HARNESS_EPOCH).valueOf() + 86_400_000).toISOString(),
    policyFingerprint: POLICY_FINGERPRINT,
  });

  const scheduler = createManualScheduler(HARNESS_EPOCH);
  const claudeScheduler = claudeSchedulerFromManual(scheduler);
  const toolId = options.toolIdOverride ?? "claude-code";

  const grant = parseCapabilityGrant({
    schemaVersion: 1,
    grantId: "grant-claude",
    projectId: PROJECT_ID,
    runId: null,
    taskId: null,
    attemptId: record.attemptId,
    snapshotId: snapshot.snapshotId,
    workspaceId: WORKSPACE_ID,
    operations: options.grantOperations ?? [
      "workspace-read",
      "workspace-write",
      "command-execution",
      "git-commit",
    ],
    readablePrefixes: [""],
    writablePrefixes: options.writablePrefixes ?? [""],
    tools: [{ toolId, digest: null }],
    network: { mode: "denied", egressDomains: [] },
    quotas: {
      wallClockMs: 120_000,
      cpuTimeMs: null,
      memoryBytes: null,
      processCount: null,
      outputBytes: 8_388_608,
      diskBytes: null,
      fileCount: null,
    },
    issuedAt: new Date(new Date(HARNESS_EPOCH).valueOf() - 60_000).toISOString(),
    expiresAt: new Date(new Date(HARNESS_EPOCH).valueOf() + 86_400_000).toISOString(),
    nonce: GRANT_NONCE,
    policyFingerprint: POLICY_FINGERPRINT,
    approvalEvidenceRefs: [],
  });

  const lease = createExecutionLease({ leaseId: "lease-claude", grant, clock: scheduler });

  const scenarioPath = join(base, "scenario.json");
  await writeFile(scenarioPath, JSON.stringify(options.scenario), "utf8");

  const configuration = createClaudeAdapterConfiguration({
    instanceId: "claude-code-1",
    executable: {
      toolId,
      executablePath: options.executablePathOverride ?? process.execPath,
      platform: process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
      architecture: process.arch === "arm64" ? "arm64" : "x64",
      expectedDigestHex: null,
      immutableReference: null,
      containmentRoot: null,
      pinnedLeadingArguments:
        options.pinnedLeadingArgumentsOverride === undefined
          ? [FAKE_CLI_PATH, scenarioPath]
          : options.pinnedLeadingArgumentsOverride,
    },
    permittedModels: ["fable", "opus", "claude-fable-5"],
    defaultModel: null,
    permittedEffortLevels: ["low", "medium", "high"],
    defaultEffort: null,
    maxTurns: 8,
    supportedClassifications: ["public", "internal", "proprietary-source"],
    testReportPath: "reports/tests.json",
    ...options.configuration,
  });

  const backend = createUnsafeDevelopmentBackend({ sessionRoot });
  const broker = createProcessBroker({
    backend,
    mode: options.mode ?? "development",
    approvedBackendIds: [UNSAFE_BACKEND_ID],
    clock: scheduler,
    scheduler: {
      schedule: (delayMs, callback) => {
        const handle = claudeScheduler.delay(delayMs);
        void handle.promise.then(callback);
        return { cancel: () => handle.cancel() };
      },
    },
    policy: {
      evaluateCommand: ({ request }) => ({
        outcome: "allowed" as const,
        fingerprint: request.policyDecisionFingerprint,
        approvalsToConsume: [],
      }),
    },
    // Secrets resolve here, after policy approval and immediately before the
    // process is created, exactly as the production flow requires.
    ...(options.secretValues === undefined
      ? {}
      : {
          secrets: {
            resolve: async (): Promise<ReadonlyMap<string, string>> =>
              options.secretValues as ReadonlyMap<string, string>,
          },
        }),
  });

  const workspacePaths: WorkspaceEnvironmentPaths = Object.freeze({
    tempDir: join(envRoot, "tmp"),
    homeDir: null,
    configDir: null,
    cacheDir: null,
  });

  const execution = createBrokerExecutionPort({
    broker,
    configuration,
    grant,
    lease,
    projectId: PROJECT_ID,
    attemptId: record.attemptId,
    policyDecisionFingerprint: POLICY_FINGERPRINT,
    workspaceRoot: record.managedRoot,
    workingDirectory: record.worktreeDir,
    workspacePaths,
  });

  const workspace = createClaudeWorkspaceHandle({
    runtime,
    record,
    lease,
    grant,
    paths: workspacePaths,
    sourceRepositoryRoot: sourceRoot,
  });

  const workspaces: ClaudeWorkspacePort = Object.freeze({
    resolve: async (workspaceId: string): Promise<ClaudeWorkspaceHandle | null> =>
      workspaceId === WORKSPACE_ID ? workspace : null,
  });

  const artifacts = createRecordingArtifactSink();
  if (options.artifactPersistenceAllowed === false) {
    artifacts.denyAll.value = true;
  }
  const observations: ClaudeObservation[] = [];

  const provider = createClaudeCodeProvider({
    configuration,
    execution,
    workspaces,
    artifacts,
    scheduler: claudeScheduler,
    uuid: sequentialUuid(),
    claudeObserver: (observation) => observations.push(observation),
    projectId: PROJECT_ID,
    ...(options.secretEnvironment === undefined ? {} : { secretEnvironment: options.secretEnvironment }),
    backend: {
      backendId: UNSAFE_BACKEND_ID,
      securityClass: "unsafe-development",
      commandExecutionAllowed: options.commandExecutionAllowed ?? true,
    },
    ...(options.personalDevelopmentCanaryOptIn === undefined
      ? {}
      : { personalDevelopmentCanaryOptIn: options.personalDevelopmentCanaryOptIn }),
    policy: {
      evaluateSession: () => ({
        outcome: options.policyOutcome ?? ("allowed" as const),
        reasonCode: null,
        sessionPersistenceAllowed: options.sessionPersistenceAllowed ?? false,
        artifactPersistenceAllowed: options.artifactPersistenceAllowed ?? true,
        diagnosticRetentionAllowed: true,
        approvalEvidenceRefs: [],
        approvedToolNames: options.approvedToolNames ?? [],
      }),
    },
  });

  return Object.freeze({
    base,
    sessionRoot,
    sourceRoot,
    runtime,
    snapshot,
    record,
    grant,
    lease,
    broker,
    execution,
    workspaces,
    workspace,
    configuration,
    provider,
    scheduler,
    artifacts,
    observations,
    scenarioPath,
    worktreeDir: record.worktreeDir,
    async writeScenario(scenario: FakeScenario): Promise<void> {
      await writeFile(scenarioPath, JSON.stringify(scenario), "utf8");
    },
    async close(): Promise<void> {
      await provider.close();
      await broker.close();
      lease.release();
      await runtime.dispose();
    },
  });
}

/** Deterministic UUIDs so session identity replays identically. */
export function sequentialUuid(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    const tail = counter.toString(16).padStart(12, "0");
    return `00000000-0000-4000-8000-${tail}`;
  };
}

export function markerExists(path: string): boolean {
  return existsSync(path);
}

export async function cleanupHarnessFixtures(): Promise<void> {
  await Promise.allSettled([
    ...bases.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    rm(SCRATCH, { recursive: true, force: true }),
  ]);
}
