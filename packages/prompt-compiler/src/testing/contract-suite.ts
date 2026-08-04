import { describe, expect, it } from "vitest";
import {
  HOSTILE_PROMPT_CONTEXT,
  PROMPT_INJECTION_CANARY,
  allowingPromptAuthorizer,
  promptCompilationRequestFixture
} from "./fixtures.js";
import { createPromptCompiler, summarizeCompiledPrompt } from "../compiler.js";
import type { PromptAuthorizer } from "../authorization.js";
import type { PromptCompilationRequest } from "../model.js";

export interface PromptCompilerContractHarness {
  readonly authorizer?: PromptAuthorizer;
  request?(): PromptCompilationRequest;
}

export function runPromptCompilerContractSuite(
  name: string,
  createHarness: () => PromptCompilerContractHarness = () => ({})
): void {
  describe(`prompt compiler contract: ${name}`, () => {
    it("compiles deterministically with a strict no-tool request", async () => {
      const harness = createHarness();
      const compiler = createPromptCompiler({
        authorizer: harness.authorizer ?? allowingPromptAuthorizer()
      });
      const request = harness.request?.() ?? promptCompilationRequestFixture();
      const first = await compiler.compile(request);
      const second = await compiler.compile(request);
      expect(first.ok).toBe(true);
      expect(second).toEqual(first);
      if (!first.ok) return;
      expect(first.value.inferenceRequest.tools).toEqual([]);
      expect(first.value.inferenceRequest.toolChoice).toEqual({ mode: "none" });
      expect(first.value.inferenceRequest.structuredOutput?.strict).toBe(true);
      expect(summarizeCompiledPrompt(first.value).authority).toBe("none");
    });

    it("keeps hostile context in the user message only", async () => {
      const compiler = createPromptCompiler({ authorizer: allowingPromptAuthorizer() });
      const result = await compiler.compile(
        promptCompilationRequestFixture({ body: HOSTILE_PROMPT_CONTEXT })
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const serializedSystem = JSON.stringify(result.value.inferenceRequest.messages.slice(0, 2));
      const serializedUser = JSON.stringify(result.value.inferenceRequest.messages[2]);
      expect(serializedSystem).not.toContain(PROMPT_INJECTION_CANARY);
      expect(serializedUser).toContain(PROMPT_INJECTION_CANARY);
    });

    it("fails closed without an explicit allowing authorizer", async () => {
      const result = await createPromptCompiler().compile(promptCompilationRequestFixture());
      expect(result).toMatchObject({
        ok: false,
        failure: { code: "AUTHORIZATION_DENIED" }
      });
    });
  });
}
