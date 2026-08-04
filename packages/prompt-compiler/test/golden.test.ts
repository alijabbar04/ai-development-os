import { readFile } from "node:fs/promises";
import { toCanonicalJson } from "@ai-dev-os/domain";
import { describe, expect, it } from "vitest";
import { createPromptCompiler } from "../src/compiler.js";
import {
  allowingPromptAuthorizer,
  promptCompilationRequestFixture
} from "../src/testing/fixtures.js";

interface PromptGolden {
  readonly schemaVersion: 1;
  readonly fixtureId: string;
  readonly messageCanonicalJson: readonly string[];
  readonly schemaCanonicalJson: string;
  readonly expected: {
    readonly promptFingerprint: string;
    readonly configurationFingerprint: string;
    readonly contextPackFingerprint: string;
    readonly contextEvidenceFingerprint: string;
    readonly authorizationFingerprint: string;
    readonly authorityFingerprint: string;
    readonly accounting: unknown;
  };
}

describe("reviewed prompt golden corpus", () => {
  it("replays exact message bytes, schema bytes, accounting, and fingerprints", async () => {
    const path = new URL("./goldens/prompt-v1.json", import.meta.url);
    const golden = JSON.parse(await readFile(path, "utf8")) as PromptGolden;
    const result = await createPromptCompiler({
      authorizer: allowingPromptAuthorizer()
    }).compile(promptCompilationRequestFixture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(golden.schemaVersion).toBe(1);
    expect(golden.fixtureId).toBe("synthetic-stage-15-prompt-v1");
    expect(
      result.value.inferenceRequest.messages.map((message) => toCanonicalJson(message))
    ).toEqual(golden.messageCanonicalJson);
    expect(toCanonicalJson(result.value.inferenceRequest.structuredOutput?.schema)).toBe(
      golden.schemaCanonicalJson
    );
    expect({
      promptFingerprint: result.value.fingerprint,
      configurationFingerprint: result.value.configurationFingerprint,
      contextPackFingerprint: result.value.contextPackFingerprint,
      contextEvidenceFingerprint: result.value.contextEvidenceFingerprint,
      authorizationFingerprint: result.value.authorizationFingerprint,
      authorityFingerprint: result.value.authorityFingerprint,
      accounting: result.value.accounting
    }).toEqual(golden.expected);
  });
});
