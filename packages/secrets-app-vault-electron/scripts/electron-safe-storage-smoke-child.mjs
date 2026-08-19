import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { app } from "electron";
import { defaultDataHandlingPolicy } from "@ai-dev-os/domain";
import {
  appVaultReferenceForSlot,
} from "@ai-dev-os/secrets-app-vault";
import {
  createPolicyAwareSecretResolver,
  parseSecretAccessContext,
  secretRefFingerprint,
} from "@ai-dev-os/secrets";
import {
  createAppVaultManager,
  createAppVaultSecretBroker,
} from "../dist/index.js";

const SYNTHETIC_VALUE = "stage18e-synthetic-safe-storage-canary";
const rootArgument = process.argv.at(-1);

function validatedRoot(value) {
  if (typeof value !== "string") throw new Error("invalid-smoke-root");
  const root = resolve(value);
  const systemTemp = resolve(tmpdir());
  if (!root.startsWith(systemTemp + sep) || !basename(root).startsWith("ai-dev-os-stage18e-electron-")) {
    throw new Error("invalid-smoke-root");
  }
  return root;
}

async function executeSmoke() {
  let manager = null;
  let broker = null;
  let smokeExitCode = 0;
  let smokeRoot = null;
  const mark = async (stage) => {
    if (smokeRoot !== null) await writeFile(join(smokeRoot, "stage.txt"), stage, { encoding: "utf8", flag: "w" });
  };
  try {
  if (process.platform !== "win32") throw new Error("unsupported-platform");
  smokeRoot = validatedRoot(rootArgument);
  await mark("root-validated");
  const userData = join(smokeRoot, "user-data");
  const appData = join(smokeRoot, "app-data");
  await mkdir(userData, { recursive: true });
  await mkdir(appData, { recursive: true });
  app.setName("AI Development OS Vault Smoke");
  app.setPath("userData", userData);
  app.setPath("appData", appData);
  await mark("before-ready");
  await app.whenReady();
  await mark("ready");
  const clock = Object.freeze({ now: () => new Date("2026-08-19T09:00:00.000Z") });
  manager = await createAppVaultManager({ schemaVersion: 1, clock });
  const absent = await manager.describeSnapshot();
  if (absent.vaultState !== "absent" || absent.revision !== null) throw new Error("production-manager-not-absent");
  const created = await manager.create({ slotId: "anthropic", secret: SYNTHETIC_VALUE, expectRevision: null });
  if (created.revision !== 1 || created.state !== "present") throw new Error("production-manager-create-failed");
  const reference = appVaultReferenceForSlot("anthropic");
  broker = await createAppVaultSecretBroker({ schemaVersion: 1, reference, clock });
  const context = parseSecretAccessContext({
    operationId: "electron-smoke-resolution",
    providerInstanceId: "anthropic-default",
    purpose: "provider-authentication",
    requestedLifetimeMs: 10_000,
    accessForm: "text",
    classification: "internal",
    projectId: null,
    taskId: null,
    approvalEvidenceRefs: [],
    disclosureDecisionFingerprint: null,
    locality: "local",
    trace: { traceId: "electron-smoke-resolution.trace", runId: null, taskId: null, taskRunId: null },
    deadline: null,
    signal: undefined,
  });
  const resolver = createPolicyAwareSecretResolver({
    policy: { evaluate: () => Object.freeze({ outcome: "allowed", code: "POLICY_ALLOWED", fingerprint: "f".repeat(64), requiredApprovals: Object.freeze([]) }) },
    broker,
  });
  const policyRequest = {
    schemaVersion: 1,
    action: "secret-access",
    classification: "internal",
    handlingPolicy: defaultDataHandlingPolicy("internal"),
    risk: "low",
    locality: "local",
    provider: null,
    model: null,
    scope: { projectId: null, taskId: null, providerInstanceId: "anthropic-default", workspaceId: null, operationId: context.operationId, traceId: context.trace.traceId },
    subjectDigest: secretRefFingerprint(reference),
    requestedCapabilities: [],
    transformationsApplied: [],
    approvalEvidence: [],
    retentionDays: null,
    trace: context.trace,
    requesterKind: "user",
  };
  const resolved = await resolver.withSecret({ ref: reference, context, policyRequest }, (material) => material.useText((text) => text === SYNTHETIC_VALUE));
  if (resolved.value !== true) throw new Error("production-broker-round-trip-mismatch");
  await manager.remove({ slotId: "anthropic", expectRevision: 1 });
  await mark("verified");
  await new Promise((resolvePromise, rejectPromise) => {
    process.stdout.write('{"electronAsyncSafeStorage":"ok","productionBroker":"ok","syntheticOnly":true}\n', (error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
  } catch {
    smokeExitCode = 1;
    await mark("failed");
    await new Promise((resolvePromise) => { process.stderr.write("STAGE18E_ELECTRON_SAFE_STORAGE_SMOKE_FAILED\n", resolvePromise); });
  } finally {
    try { await broker?.close(); } catch { /* best effort */ }
    try { await manager?.close(); } catch { /* best effort */ }
    if (app.isReady()) app.exit(smokeExitCode);
    else process.exitCode = smokeExitCode;
  }
}

void executeSmoke();
