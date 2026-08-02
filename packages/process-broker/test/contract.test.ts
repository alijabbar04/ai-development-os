import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import {
  createProcessBroker,
  createTrustedToolDescriptor,
  createUnsafeDevelopmentBackend,
  createLinuxSandboxBackend,
  createMacosSandboxBackend,
  createWindowsSandboxBackend,
  systemClock,
  type ExecuteInput,
  type ExecutionLease,
  type PolicyGateway,
  type ProcessRequest,
  type TrustedToolDescriptor,
} from "../src/index.js";
import {
  runProcessBrokerContractSuite,
  runDuplexProcessSessionContractSuite,
  runSandboxBackendContractSuite,
  type ProcessBrokerContractHarness,
} from "../src/testing/contract-suite.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE = join(HERE, "fixtures", "process-fixture.mjs");

const roots: string[] = [];

async function scratchRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "adox-broker-"));
  roots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.allSettled(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** node.exe plus the verified fixture entry point: never a shell shim. */
export function fixtureTool(overrides: Partial<TrustedToolDescriptor> = {}): TrustedToolDescriptor {
  return createTrustedToolDescriptor({
    toolId: "echo",
    executablePath: process.execPath,
    platform: process.platform as "win32" | "darwin" | "linux",
    architecture: process.arch as "x64" | "arm64",
    trustSource: "operator-pinned",
    argumentPolicy: {
      maxArguments: 64,
      maxArgumentBytes: 8_192,
      pinnedLeadingArguments: [FIXTURE],
      denyOptionArguments: false,
    },
    ...overrides,
  });
}

/** A gateway that allows everything, so the suite exercises the broker. */
export const allowAllPolicy: PolicyGateway = {
  evaluateCommand: ({ request }) => ({
    outcome: "allowed" as const,
    fingerprint: request.policyDecisionFingerprint,
    approvalsToConsume: [],
  }),
};

runProcessBrokerContractSuite(async (): Promise<ProcessBrokerContractHarness> => {
  const root = await scratchRoot();
  const backend = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "sessions") });
  const broker = createProcessBroker({
    backend,
    mode: "development",
    policy: allowAllPolicy,
    clock: systemClock,
    terminationGraceMs: 200,
  });
  return {
    broker,
    echoTool: fixtureTool(),
    clock: systemClock,
    context: (request: ProcessRequest, lease: ExecutionLease): ExecuteInput => ({
      request,
      grant: lease.grant,
      lease,
      workspaceRoot: root,
      workingDirectory: root,
      workspacePaths: {
        tempDir: join(root, "tmp"),
        homeDir: join(root, "home"),
        configDir: null,
        cacheDir: null,
      },
    }),
    close: async (): Promise<void> => {
      await broker.close();
    },
  };
});

runDuplexProcessSessionContractSuite(async (): Promise<ProcessBrokerContractHarness> => {
  const root = await scratchRoot();
  const backend = createUnsafeDevelopmentBackend({ sessionRoot: join(root, "sessions") });
  const broker = createProcessBroker({
    backend,
    mode: "development",
    policy: allowAllPolicy,
    clock: systemClock,
    terminationGraceMs: 200,
  });
  return {
    broker,
    echoTool: fixtureTool(),
    clock: systemClock,
    context: (request: ProcessRequest, lease: ExecutionLease): ExecuteInput => ({
      request,
      grant: lease.grant,
      lease,
      workspaceRoot: root,
      workingDirectory: root,
      workspacePaths: {
        tempDir: join(root, "tmp"),
        homeDir: join(root, "home"),
        configDir: null,
        cacheDir: null,
      },
    }),
    close: async (): Promise<void> => {
      await broker.close();
    },
  };
});

runSandboxBackendContractSuite(async () => {
  const root = await scratchRoot();
  return {
    backend: createUnsafeDevelopmentBackend({ sessionRoot: join(root, "sessions") }),
    canSpawn: true,
  };
});

runSandboxBackendContractSuite(async () => ({
  backend:
    process.platform === "win32"
      ? createWindowsSandboxBackend()
      : process.platform === "linux"
        ? createLinuxSandboxBackend()
        : createMacosSandboxBackend(),
  canSpawn: false,
}));
