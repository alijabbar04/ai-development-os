import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  createWindowsCredentialSecretBroker,
} from "../dist/index.js";

if (process.platform !== "win32") {
  throw new Error("native-smoke-requires-windows");
}

const require = createRequire(import.meta.url);
const native = require("../build/Release/ai_dev_os_windows_credential.node");
for (const malformed of [
  `Other:v1:test:${"a".repeat(64)}`,
  `AI-Dev-OS:v1:Test:${"a".repeat(64)}`,
  `AI-Dev-OS:v1:test:${"A".repeat(64)}`,
  `AI-Dev-OS:v1:test:${"a".repeat(63)}`,
  `AI-Dev-OS:v1:test:${"a".repeat(65)}`,
  `AI-Dev-OS:v1::${"a".repeat(64)}`,
  `AI-Dev-OS:v1:test:${"a".repeat(64)}:suffix`,
  `AI-Dev-OS:v1:test/extra:${"a".repeat(64)}`,
  `AI-Dev-OS:v1:${"a".repeat(33)}:${"a".repeat(64)}`,
]) {
  for (const operation of ["availability", "read"]) {
    let refused = false;
    try { await native[operation](malformed); }
    catch { refused = true; }
    if (!refused) throw new Error(`native-smoke-malformed-target-was-not-refused:${operation}`);
  }
}

const reference = Object.freeze({
  schemaVersion: 1,
  type: "keychain",
  namespace: "ai-dev-os-test",
  service: "native-smoke-never-create",
  account: `synthetic-${randomUUID()}`,
  version: null,
  expectedKind: "text",
  providerInstanceId: "test:native-smoke",
});
const broker = createWindowsCredentialSecretBroker({
  schemaVersion: 1,
  reference,
  clock: Object.freeze({ now: () => new Date() }),
});

try {
  const result = await broker.availability(reference, Object.freeze({
    operationId: "native-smoke-20260814",
    providerInstanceId: "test:native-smoke",
    purpose: "provider-authentication",
    requestedLifetimeMs: 5_000,
    accessForm: "text",
    classification: "internal",
    projectId: "ai-dev-os-test",
    taskId: "native-smoke",
    approvalEvidenceRefs: [],
    disclosureDecisionFingerprint: null,
    locality: "local",
    trace: Object.freeze({ traceId: "native-smoke-trace", runId: "native-smoke-run", taskId: "native-smoke", taskRunId: "native-smoke-attempt" }),
    deadline: new Date(Date.now() + 5_000).toISOString(),
    signal: undefined,
  }));
  if (result.available || result.reason !== "not-found") {
    throw new Error("native-smoke-target-was-not-exactly-absent");
  }
  let callbackCount = 0;
  let readWasNotFound = false;
  try {
    await broker.withSecret(reference, Object.freeze({
      operationId: "native-smoke-read-20260814",
      providerInstanceId: "test:native-smoke",
      purpose: "provider-authentication",
      requestedLifetimeMs: 5_000,
      accessForm: "text",
      classification: "internal",
      projectId: "ai-dev-os-test",
      taskId: "native-smoke",
      approvalEvidenceRefs: [],
      disclosureDecisionFingerprint: null,
      locality: "local",
      trace: Object.freeze({ traceId: "native-smoke-read-trace", runId: "native-smoke-run", taskId: "native-smoke", taskRunId: "native-smoke-attempt" }),
      deadline: new Date(Date.now() + 5_000).toISOString(),
      signal: undefined,
    }), () => { callbackCount += 1; });
  } catch (error) {
    readWasNotFound = error?.code === "NOT_FOUND";
  }
  if (!readWasNotFound || callbackCount !== 0) {
    throw new Error("native-smoke-read-was-not-exactly-not-found");
  }
} finally {
  await broker.close();
}
