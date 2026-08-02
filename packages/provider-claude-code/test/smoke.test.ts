import { afterAll, describe, expect, it } from "vitest";
import { createCodingAgentRequest, createTrace, parseDisclosureContext } from "@ai-dev-os/providers";
import {
  assistantText,
  cleanupHarnessFixtures,
  createClaudeHarness,
  initRecord,
  line,
  resultRecord,
  WORKSPACE_ID,
} from "./helpers/harness.js";

const DISCLOSURE = parseDisclosureContext({
  classification: "internal",
  requiredLocality: "any",
  redactionApplied: true,
  decisionRef: null,
  retentionAllowed: true,
  loggingAllowed: false,
});

afterAll(async () => {
  await cleanupHarnessFixtures();
});

describe("end-to-end read-only session over the fake CLI", () => {
  it("completes with no changes and reports Claude's reported usage", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [
          line(initRecord()),
          line(assistantText("I read the file and found nothing to change.")),
          line(resultRecord()),
        ],
      },
    });
    try {
      const operation = await harness.provider.start(
        createCodingAgentRequest({
          requestId: "req-smoke-1",
          workspaceId: WORKSPACE_ID,
          instructions: "Describe src/main.ts without changing anything.",
          capabilities: ["read-files"],
          disclosure: DISCLOSURE,
          trace: createTrace("trace-smoke"),
        }),
      );

      const kinds: string[] = [];
      for await (const event of operation.events()) {
        kinds.push(event.kind);
      }
      const result = await operation.result;

      expect(kinds[0]).toBe("operation-started");
      expect(kinds.at(-1)).toBe("operation-completed");
      expect(result.completion).toBe("completed-no-changes");
      expect(result.changedFiles).toHaveLength(0);
      expect(result.usage.tokens.inputTokens).toBe(130);
      expect(result.usage.tokens.outputTokens).toBe(45);
      expect(result.usage.tokens.cachedInputTokens).toBe(5);
    } finally {
      await harness.close();
    }
  });
});
