import { toCanonicalJson } from "@ai-dev-os/domain";
import { describe, expect, it } from "vitest";
import {
  THINKER_CONTEXT_PREAMBLE,
  createPromptCompiler
} from "../src/compiler.js";
import {
  PROMPT_INJECTION_CANARY,
  allowingPromptAuthorizer,
  jsonClone,
  promptCompilationRequestFixture
} from "../src/testing/fixtures.js";

export const PROMPT_PROPERTY_SEED = 0x15c0ffee;

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

function shuffle<T>(items: readonly T[], next: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const selected = next() % (index + 1);
    [result[index], result[selected]] = [result[selected]!, result[index]!];
  }
  return result;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("test fixture is not a record");
  }
  return value as Record<string, unknown>;
}

describe("seeded prompt compiler properties", () => {
  it("normalizes repeated authority and extension permutations", async () => {
    const next = generator(PROMPT_PROPERTY_SEED);
    const base = promptCompilationRequestFixture({
      extensions: [
        { namespace: "aa", key: "mode", value: { level: 1 } },
        { namespace: "bb", key: "effort", value: [1, 2] },
        { namespace: "cc", key: "style", value: "brief" }
      ]
    });
    const reference = await createPromptCompiler({
      authorizer: allowingPromptAuthorizer()
    }).compile(base);
    expect(reference.ok).toBe(true);
    for (let iteration = 0; iteration < 32; iteration += 1) {
      const raw = jsonClone(base) as unknown as Record<string, unknown>;
      const authority = record(raw["authority"]);
      authority["permittedTaskKinds"] = shuffle(
        authority["permittedTaskKinds"] as string[],
        next
      );
      authority["capabilityCeiling"] = shuffle(
        authority["capabilityCeiling"] as string[],
        next
      );
      raw["extensions"] = shuffle(raw["extensions"] as unknown[], next);
      const result = await createPromptCompiler({
        authorizer: allowingPromptAuthorizer()
      }).compile(raw);
      expect(result).toEqual(reference);
    }
  });

  it("accounts for seeded Unicode, CRLF, controls, zero-width, and bidi input exactly", async () => {
    const next = generator(PROMPT_PROPERTY_SEED ^ 0xa5a5a5a5);
    const alphabet = ["a", "é", "😀", "\r\n", "\n", "\u0000", "\u200b", "\u202e"];
    for (let iteration = 0; iteration < 24; iteration += 1) {
      let body = "";
      for (let index = 0; index < 300; index += 1) {
        body += alphabet[next() % alphabet.length];
      }
      const request = promptCompilationRequestFixture({ body });
      const first = await createPromptCompiler({
        authorizer: allowingPromptAuthorizer()
      }).compile(request);
      const second = await createPromptCompiler({
        authorizer: allowingPromptAuthorizer()
      }).compile(request);
      expect(first).toEqual(second);
      expect(first.ok).toBe(true);
      if (!first.ok) continue;
      const part = first.value.inferenceRequest.messages[2]?.parts[0];
      expect(part?.type).toBe("text");
      if (part?.type !== "text") continue;
      const rendered = part.text.slice(THINKER_CONTEXT_PREAMBLE.length);
      expect(first.value.accounting.contextBytes).toBe(Buffer.byteLength(rendered, "utf8"));
      expect(first.value.accounting.promptBytes).toBe(
        Buffer.byteLength(
          toCanonicalJson({
            messages: first.value.inferenceRequest.messages,
            schema: first.value.inferenceRequest.structuredOutput?.schema
          }),
          "utf8"
        )
      );
    }
  });

  it("never copies a hostile body into a failure or audit record", async () => {
    const observations: unknown[] = [];
    const body = `${PROMPT_INJECTION_CANARY}-${"private".repeat(100)}`;
    const request = jsonClone(promptCompilationRequestFixture({ body })) as unknown as Record<
      string,
      unknown
    >;
    const context = record(request["context"]);
    record(context["pack"])["fingerprint"] = "0".repeat(64);
    const result = await createPromptCompiler({
      authorizer: allowingPromptAuthorizer(),
      observer: (entry) => observations.push(entry)
    }).compile(request);
    expect(result).toMatchObject({ ok: false, failure: { code: "INVALID_CONTEXT_PACK" } });
    expect(JSON.stringify({ result, observations })).not.toContain(PROMPT_INJECTION_CANARY);
  });
});
