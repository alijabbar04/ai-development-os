import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toCanonicalJson } from "@ai-dev-os/domain";
import { createPromptCompiler } from "../dist/compiler.js";
import {
  allowingPromptAuthorizer,
  promptCompilationRequestFixture
} from "../dist/testing/fixtures.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(packageRoot, "test", "goldens", "prompt-v1.json");
const result = await createPromptCompiler({
  authorizer: allowingPromptAuthorizer()
}).compile(promptCompilationRequestFixture());

if (!result.ok) {
  throw new Error(`Golden compilation failed with ${result.failure.code}.`);
}

const compiled = result.value;
const golden = {
  schemaVersion: 1,
  fixtureId: "synthetic-stage-15-prompt-v1",
  reviewNote: "Synthetic fixture only. Update deliberately after reviewing semantic prompt changes.",
  messageCanonicalJson: compiled.inferenceRequest.messages.map((message) =>
    toCanonicalJson(message)
  ),
  schemaCanonicalJson: toCanonicalJson(compiled.inferenceRequest.structuredOutput.schema),
  expected: {
    promptFingerprint: compiled.fingerprint,
    configurationFingerprint: compiled.configurationFingerprint,
    contextPackFingerprint: compiled.contextPackFingerprint,
    contextEvidenceFingerprint: compiled.contextEvidenceFingerprint,
    authorizationFingerprint: compiled.authorizationFingerprint,
    authorityFingerprint: compiled.authorityFingerprint,
    accounting: compiled.accounting
  }
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(golden, null, 2)}\n`, "utf8");
