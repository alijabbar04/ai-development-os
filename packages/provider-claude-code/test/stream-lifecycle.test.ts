/**
 * End-to-end stream and lifecycle behaviour against a real child process.
 *
 * These cover the cases that only appear when bytes actually cross a pipe and
 * a real process is on the other end: arbitrary chunk boundaries, split UTF-8,
 * CRLF, a missing final newline, stderr staying separate from stdout, a
 * signal-ignoring process, a nested child, and the races between cancellation,
 * close, and normal completion.
 */

import { afterAll, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createCodingAgentRequest, createTrace, parseDisclosureContext } from "@ai-dev-os/providers";
import {
  WORKSPACE_ID,
  assistantText,
  SCRATCH,
  cleanupHarnessFixtures,
  createClaudeHarness,
  initRecord,
  line,
  resultRecord,
} from "./helpers/harness.js";

const DISCLOSURE = parseDisclosureContext({
  classification: "internal",
  requiredLocality: "any",
  redactionApplied: true,
  decisionRef: null,
  retentionAllowed: true,
  loggingAllowed: true,
});

afterAll(async () => {
  await cleanupHarnessFixtures();
});

function request(requestId: string, overrides: Record<string, unknown> = {}) {
  return createCodingAgentRequest({
    requestId,
    workspaceId: WORKSPACE_ID,
    instructions: "do the scripted work",
    capabilities: ["read-files"],
    disclosure: DISCLOSURE,
    trace: createTrace("trace-stream"),
    ...overrides,
  });
}

/** Renders records as one string so a scenario can split it at any boundary. */
function joined(records: readonly unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

describe("streaming across real pipe boundaries", () => {
  it.each([1, 3, 7, 64])("reassembles a stream delivered in %d-byte pieces", async (byteSplit) => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [
          {
            text: joined([
              initRecord(),
              assistantText("Reading the project."),
              assistantText("Nothing to change."),
              resultRecord(),
            ]),
            byteSplit,
          },
        ],
      },
    });
    try {
      const operation = await harness.provider.start(request(`req-split-${byteSplit}`));
      const events: { kind: string }[] = [];
      for await (const event of operation.events()) {
        events.push(event);
      }
      const result = await operation.result;
      expect(result.completion).toBe("completed-no-changes");
      expect(events.filter((event) => event.kind === "output-chunk")).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  it("reassembles multi-byte characters split across pipe writes", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [
          {
            text: joined([initRecord(), assistantText("日本語のテキスト 🚀 done"), resultRecord()]),
            byteSplit: 2,
          },
        ],
      },
    });
    try {
      const operation = await harness.provider.start(request("req-utf8"));
      const events: { kind: string; payload: Record<string, unknown> }[] = [];
      for await (const event of operation.events()) {
        events.push(event as never);
      }
      await operation.result;
      const chunk = events.find((event) => event.kind === "output-chunk");
      expect(chunk?.payload["text"]).toBe("日本語のテキスト 🚀 done");
    } finally {
      await harness.close();
    }
  });

  it("accepts CRLF terminators and a final record with no trailing newline", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [
          { text: `${JSON.stringify(initRecord())}\r\n` },
          { text: `${JSON.stringify(assistantText("crlf works"))}\r\n` },
          // Deliberately no trailing newline on the terminal record.
          { text: JSON.stringify(resultRecord()) },
        ],
      },
    });
    try {
      const operation = await harness.provider.start(request("req-crlf"));
      const result = await operation.result;
      expect(result.completion).toBe("completed-no-changes");
    } finally {
      await harness.close();
    }
  });

  it("keeps stderr separate from the record stream and bounds diagnostics", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [
          line(initRecord()),
          { stderr: "warning: something happened on stderr\n" },
          { stderr: `${JSON.stringify({ type: "result", subtype: "success" })}\n` },
          line(resultRecord()),
        ],
      },
    });
    try {
      const operation = await harness.provider.start(request("req-stderr"));
      const result = await operation.result;
      // A result record written to stderr is not a terminal record; the run
      // succeeded because of the one on stdout.
      expect(result.completion).toBe("completed-no-changes");

      const diagnostics = harness.artifacts.writes.find((write) => write.category === "diagnostics");
      expect(diagnostics).toBeDefined();
      expect(diagnostics?.kind).toBe("structured-data");
      expect(diagnostics?.mediaType).toBe("application/json");
      const diagnosticsText = Buffer.from(diagnostics?.bytes ?? new Uint8Array()).toString("utf8");
      expect(diagnosticsText.includes("something happened on stderr")).toBe(false);
      expect(JSON.parse(diagnosticsText)).toEqual({
        schemaVersion: 1,
        stream: "stderr",
        capturedBytes: Buffer.byteLength(
          `warning: something happened on stderr\n${JSON.stringify({ type: "result", subtype: "success" })}\n`,
          "utf8",
        ),
        contentRetained: false,
      });
      expect(result.diagnosticsArtifactId).not.toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("stops at an oversized single record rather than buffering it", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [
          line(initRecord()),
          { text: `${JSON.stringify(assistantText("x".repeat(200_000)))}\n` },
          line(resultRecord()),
        ],
      },
      configuration: { maxRecordBytes: 4_096, maxStreamBytes: 1_048_576 },
    });
    try {
      const operation = await harness.provider.start(request("req-oversize-record"));
      await expect(operation.result).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    } finally {
      await harness.close();
    }
  });

  it("stops at an excessive record count", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [
          line(initRecord()),
          ...Array.from({ length: 40 }, (_unused, index) => line(assistantText(`chunk ${index}`))),
          line(resultRecord()),
        ],
      },
      configuration: { maxRecordCount: 10, maxTurns: 100 },
    });
    try {
      const operation = await harness.provider.start(request("req-record-count"));
      await expect(operation.result).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    } finally {
      await harness.close();
    }
  });

  it("emits exactly one terminal event and nothing after it", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [line(initRecord()), line(assistantText("done")), line(resultRecord())],
      },
    });
    try {
      const operation = await harness.provider.start(request("req-terminal-once"));
      const kinds: string[] = [];
      for await (const event of operation.events()) {
        kinds.push(event.kind);
      }
      await operation.result;
      const terminals = kinds.filter((kind) =>
        ["operation-completed", "operation-failed", "operation-cancelled"].includes(kind),
      );
      expect(terminals).toHaveLength(1);
      expect(kinds.at(-1)).toBe("operation-completed");
    } finally {
      await harness.close();
    }
  });

  it("settles the result even when the event stream is never drained", async () => {
    const harness = await createClaudeHarness({
      scenario: { fragments: [line(initRecord()), line(resultRecord())] },
    });
    try {
      const operation = await harness.provider.start(request("req-undrained"));
      const result = await operation.result;
      expect(result.completion).toBe("completed-no-changes");
    } finally {
      await harness.close();
    }
  });
});

describe("process lifecycle races", () => {
  it("terminates a signal-ignoring process and reports the outcome honestly", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [line(initRecord())],
        ignoreSignals: true,
        hangMs: 570_000,
      },
    });
    try {
      const operation = await harness.provider.start(request("req-stubborn"));
      await new Promise((done) => setTimeout(done, 700));
      await operation.cancel();
      await expect(operation.result).rejects.toMatchObject({ code: "CANCELLED" });
      await harness.provider.close();

      const terminal = harness.observations.find(
        (observation) => observation.kind === "operation-terminal",
      );
      expect(terminal).toMatchObject({ category: "cancelled" });
      // The unsafe backend's termination evidence is preserved rather than
      // being reported as a clean stop it cannot prove.
      expect(terminal).toHaveProperty("terminationConfirmed");
    } finally {
      await harness.close();
    }
  });

  it("cancels a run that spawned a nested child", async () => {
    const childMarker = join(SCRATCH, "adox-child.txt");
    await rm(childMarker, { force: true });
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [line(initRecord())],
        spawnChild: true,
        childMarker,
        childLifetimeMs: 20_000,
        hangMs: 570_000,
      },
    });
    try {
      const operation = await harness.provider.start(request("req-nested"));
      await new Promise((done) => setTimeout(done, 900));
      // Positive control: the fixture genuinely spawned a child.
      expect(existsSync(childMarker)).toBe(true);

      await operation.cancel();
      await expect(operation.result).rejects.toMatchObject({ code: "CANCELLED" });
    } finally {
      await rm(childMarker, { force: true });
      await harness.close();
    }
  });

  it("is idempotent under repeated cancellation", async () => {
    const harness = await createClaudeHarness({
      scenario: { fragments: [line(initRecord())], hangMs: 570_000 },
    });
    try {
      const operation = await harness.provider.start(request("req-idempotent-cancel"));
      await Promise.all([operation.cancel(), operation.cancel(), operation.cancel()]);
      await expect(operation.result).rejects.toMatchObject({ code: "CANCELLED" });
      await operation.cancel();
    } finally {
      await harness.close();
    }
  });

  it("lets the first terminal outcome win a close-versus-completion race", async () => {
    const harness = await createClaudeHarness({
      scenario: { fragments: [line(initRecord()), line(resultRecord())] },
    });
    try {
      const operation = await harness.provider.start(request("req-close-race"));
      const [outcome] = await Promise.allSettled([operation.result, harness.provider.close()]);
      // Either the run completed first or close cancelled it first; both are
      // legitimate, and exactly one of them settled the operation.
      if (outcome.status === "fulfilled") {
        expect(outcome.value.completion).toBe("completed-no-changes");
      } else {
        expect(outcome.reason).toMatchObject({ code: "CANCELLED" });
      }
    } finally {
      await harness.close();
    }
  });

  it("cancels cleanly before the process produces anything", async () => {
    const harness = await createClaudeHarness({
      scenario: { fragments: [{ text: "", delayMs: 50 }], hangMs: 570_000 },
    });
    try {
      const operation = await harness.provider.start(request("req-early-cancel"));
      await operation.cancel();
      await expect(operation.result).rejects.toMatchObject({ code: "CANCELLED" });

      const kinds: string[] = [];
      for await (const event of operation.events()) {
        kinds.push(event.kind);
      }
      expect(kinds.at(-1)).toBe("operation-cancelled");
    } finally {
      await harness.close();
    }
  });

  it("fails a run whose deadline passes while it streams", async () => {
    const harness = await createClaudeHarness({
      scenario: { fragments: [line(initRecord())], hangMs: 570_000 },
    });
    try {
      const operation = await harness.provider.start(request("req-deadline-stream"));
      harness.scheduler.advance(3_600_000);
      await expect(operation.result).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
      await harness.provider.close();
      const terminal = harness.observations.find(
        (observation) => observation.kind === "operation-terminal",
      );
      expect(terminal).toMatchObject({ deadlineExpired: true });
    } finally {
      await harness.close();
    }
  });

  it("leaves no adapter-owned work running after close", async () => {
    const harness = await createClaudeHarness({
      scenario: { fragments: [line(initRecord())], hangMs: 570_000 },
    });
    try {
      const operation = await harness.provider.start(request("req-close-drain"));
      await harness.provider.close();
      // close() cancelled the operation and waited for adapter-owned cleanup,
      // so the result is already settled by the time close resolves.
      await expect(operation.result).rejects.toMatchObject({ code: "CANCELLED" });
      const terminal = harness.observations.find(
        (observation) => observation.kind === "operation-terminal",
      );
      expect(terminal).toBeDefined();
      // The lease was not leaked: it is still the caller's to release.
      expect(harness.lease.isValid()).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
