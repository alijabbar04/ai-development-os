/**
 * Workspace reconciliation.
 *
 * The managed workspace is authoritative. These tests prove that what Claude
 * says about files, commits, and tests changes nothing, that partial edits
 * survive a failure so the scheduler can dispose of them, and that a change
 * outside the authorized prefixes fails the operation even when the session
 * reported success.
 */

import { afterAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createCodingAgentRequest, createTrace, parseDisclosureContext } from "@ai-dev-os/providers";
import {
  WORKSPACE_ID,
  assistantText,
  cleanupHarnessFixtures,
  createClaudeHarness,
  initRecord,
  line,
  resultRecord,
  toolUse,
} from "./helpers/harness.js";

const DISCLOSURE = parseDisclosureContext({
  classification: "proprietary-source",
  requiredLocality: "any",
  redactionApplied: false,
  decisionRef: null,
  retentionAllowed: true,
  loggingAllowed: true,
});

afterAll(async () => {
  await cleanupHarnessFixtures();
});

function editRequest(requestId: string, overrides: Record<string, unknown> = {}) {
  return createCodingAgentRequest({
    requestId,
    workspaceId: WORKSPACE_ID,
    instructions: "make the change",
    capabilities: ["read-files", "edit-files"],
    disclosure: DISCLOSURE,
    trace: createTrace("trace-reconcile"),
    ...overrides,
  });
}

describe("changed files come from Git, not from the transcript", () => {
  it("reports the files that actually changed and ignores fabricated claims", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [
          line(initRecord()),
          // The session claims two files it never touched, and silently
          // touches a third it never mentions.
          line(toolUse("t1", "Edit", { file_path: "src/imaginary.ts" })),
          line(toolUse("t2", "Write", { file_path: "docs/also-imaginary.md" })),
          line(assistantText("I updated src/imaginary.ts and docs/also-imaginary.md.")),
          line(resultRecord({ num_turns: 3 })),
        ],
        afterFiles: [{ path: "tracked.txt", action: "write", content: "modified by the agent\n" }],
      },
    });
    try {
      const operation = await harness.provider.start(editRequest("req-claims"));
      const result = await operation.result;

      expect(result.changedFiles).toEqual([{ path: "tracked.txt", changeKind: "modified" }]);
      expect(result.changedFiles.map((entry) => entry.path)).not.toContain("src/imaginary.ts");
      expect(result.completion).toBe("completed");

      // The mismatch is surfaced as a warning rather than silently absorbed.
      expect(result.warnings.join(" ")).toContain("were not changed in the managed workspace");
      expect(result.warnings.join(" ")).toContain("were not named by the session");
    } finally {
      await harness.close();
    }
  });

  it("classifies additions, modifications, deletions, and renames from the diff", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [line(initRecord()), line(resultRecord())],
        afterFiles: [
          { path: "added.txt", action: "write", content: "new file\n" },
          { path: "tracked.txt", action: "write", content: "changed\n" },
          { path: "src/main.ts", action: "delete" },
        ],
      },
    });
    try {
      const operation = await harness.provider.start(editRequest("req-kinds"));
      const result = await operation.result;
      const byPath = new Map(result.changedFiles.map((entry) => [entry.path, entry.changeKind]));
      expect(byPath.get("added.txt")).toBe("added");
      expect(byPath.get("tracked.txt")).toBe("modified");
      expect(byPath.get("src/main.ts")).toBe("deleted");
    } finally {
      await harness.close();
    }
  });

  it("produces a patch artifact derived from the workspace, not from a message", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [
          line(initRecord()),
          line(assistantText("```diff\n--- a/fake\n+++ b/fake\n+this diff is a lie\n```")),
          line(resultRecord()),
        ],
        afterFiles: [{ path: "tracked.txt", action: "write", content: "genuinely changed\n" }],
      },
    });
    try {
      const operation = await harness.provider.start(editRequest("req-patch"));
      const events: { kind: string }[] = [];
      for await (const event of operation.events()) {
        events.push(event);
      }
      const result = await operation.result;

      expect(events.filter((event) => event.kind === "patch-produced")).toHaveLength(1);
      expect(result.patchArtifactId).not.toBeNull();

      const patch = harness.artifacts.writes.find((write) => write.category === "patch");
      expect(patch).toBeDefined();
      const text = Buffer.from(patch?.bytes ?? new Uint8Array()).toString("utf8");
      expect(text).toContain("tracked.txt");
      expect(text).toContain("genuinely changed");
      expect(text).not.toContain("this diff is a lie");
    } finally {
      await harness.close();
    }
  });
});

describe("violations fail the operation even when the session reported success", () => {
  it("fails when a file changes outside the authorized path prefixes", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [line(initRecord()), line(resultRecord())],
        afterFiles: [{ path: "outside/secret.txt", action: "write", content: "not allowed\n" }],
      },
    });
    try {
      const operation = await harness.provider.start(
        editRequest("req-prefix", { fileAccess: { allowedPathPrefixes: ["src"] } }),
      );
      await expect(operation.result).rejects.toMatchObject({ code: "POLICY_DENIED" });
    } finally {
      await harness.close();
    }
  });

  it("fails when a change lands outside the grant's writable prefixes", async () => {
    const harness = await createClaudeHarness({
      writablePrefixes: ["src"],
      scenario: {
        fragments: [line(initRecord()), line(resultRecord())],
        afterFiles: [{ path: "tracked.txt", action: "write", content: "outside the grant\n" }],
      },
    });
    try {
      const operation = await harness.provider.start(editRequest("req-grant-prefix"));
      await expect(operation.result).rejects.toMatchObject({ code: "POLICY_DENIED" });
    } finally {
      await harness.close();
    }
  });

  it("fails when files change without the edit-files capability", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [line(initRecord()), line(resultRecord())],
        afterFiles: [{ path: "tracked.txt", action: "write", content: "sneaky\n" }],
      },
    });
    try {
      const operation = await harness.provider.start(
        createCodingAgentRequest({
          requestId: "req-readonly-violation",
          workspaceId: WORKSPACE_ID,
          instructions: "just read",
          capabilities: ["read-files"],
          disclosure: DISCLOSURE,
          trace: createTrace("trace-readonly-violation"),
        }),
      );
      await expect(operation.result).rejects.toMatchObject({ code: "POLICY_DENIED" });
    } finally {
      await harness.close();
    }
  });

  it("fails when the change count exceeds the request's ceiling", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [line(initRecord()), line(resultRecord())],
        afterFiles: [
          { path: "a.txt", action: "write", content: "1\n" },
          { path: "b.txt", action: "write", content: "2\n" },
          { path: "c.txt", action: "write", content: "3\n" },
        ],
      },
    });
    try {
      const operation = await harness.provider.start(editRequest("req-count", { maxChangedFiles: 2 }));
      await expect(operation.result).rejects.toMatchObject({ code: "POLICY_DENIED" });
    } finally {
      await harness.close();
    }
  });
});

describe("partial work after a failure is detected and preserved", () => {
  it("detects a partial edit when the session fails mid-stream", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [
          line(initRecord()),
          line(toolUse("t1", "Edit", { file_path: "tracked.txt" })),
          line({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "{{sessionId}}" }),
        ],
        afterFiles: [{ path: "tracked.txt", action: "write", content: "half-finished work\n" }],
        exitCode: 1,
      },
    });
    try {
      const operation = await harness.provider.start(editRequest("req-partial"));
      await expect(operation.result).rejects.toThrow();

      // The forensic evidence is not deleted: the edit is still in the managed
      // worktree for the scheduler to inspect, retry from, or dispose of.
      const content = await readFile(join(harness.worktreeDir, "tracked.txt"), "utf8");
      expect(content).toBe("half-finished work\n");

      const terminal = harness.observations.find(
        (observation) => observation.kind === "operation-terminal",
      );
      expect(terminal).toMatchObject({ category: "failed", changedFileCount: 1 });
    } finally {
      await harness.close();
    }
  });

  it("detects a partial edit after cancellation", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [
          line(initRecord()),
          { text: "", delayMs: 5 },
        ],
        beforeFiles: [{ path: "tracked.txt", action: "write", content: "written before the pause\n" }],
        hangMs: 570_000,
      },
    });
    try {
      const operation = await harness.provider.start(editRequest("req-cancel-partial"));
      // Give the fake time to apply its edit before cancelling.
      await new Promise((done) => setTimeout(done, 900));
      await operation.cancel();
      await expect(operation.result).rejects.toMatchObject({ code: "CANCELLED" });

      // The result settles as soon as cancellation wins; adapter-owned
      // cleanup (reconciliation and the terminal observation) finishes in the
      // background, and close() is what waits for it.
      await harness.provider.close();

      const content = await readFile(join(harness.worktreeDir, "tracked.txt"), "utf8");
      expect(content).toBe("written before the pause\n");
      const terminal = harness.observations.find(
        (observation) => observation.kind === "operation-terminal",
      );
      expect(terminal).toMatchObject({ category: "cancelled" });
    } finally {
      await harness.close();
    }
  });
});

describe("commits are created from verified workspace state", () => {
  it("derives the result revision from a private-workspace commit, not a printed hash", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [
          line(initRecord()),
          line(assistantText("Committed as deadbeefdeadbeefdeadbeefdeadbeefdeadbeef.")),
          line(resultRecord()),
        ],
        afterFiles: [{ path: "tracked.txt", action: "write", content: "committed content\n" }],
      },
    });
    try {
      const operation = await harness.provider.start(
        editRequest("req-commit", { capabilities: ["read-files", "edit-files", "git-commit"] }),
      );
      const result = await operation.result;

      expect(result.resultRevision).toMatch(/^[0-9a-f]{40}$/);
      expect(result.resultRevision).not.toBe("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
      expect(result.baseRevision).toBe(harness.record.snapshotCommit);
      expect(result.resultRevision).not.toBe(result.baseRevision);

      // The user's branch is untouched: the commit lives in the managed
      // private repository only.
      expect(existsSync(join(harness.sourceRoot, ".git", "worktrees"))).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("does not commit when the capability was not granted", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [line(initRecord()), line(resultRecord())],
        afterFiles: [{ path: "tracked.txt", action: "write", content: "no commit please\n" }],
      },
    });
    try {
      const operation = await harness.provider.start(editRequest("req-no-commit"));
      const result = await operation.result;
      expect(result.resultRevision).toBeNull();
      expect(result.changedFiles).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("reports the base revision unchanged when nothing was modified", async () => {
    const harness = await createClaudeHarness({
      scenario: { fragments: [line(initRecord()), line(resultRecord())] },
    });
    try {
      const operation = await harness.provider.start(editRequest("req-no-change-revision"));
      const result = await operation.result;
      expect(result.completion).toBe("completed-no-changes");
      expect(result.resultRevision).toBe(result.baseRevision);
    } finally {
      await harness.close();
    }
  });
});

describe("test results require machine-verifiable evidence", () => {
  it("leaves structured test results null when the session merely claims success", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [
          line(initRecord()),
          line(assistantText("All 42 tests passed.")),
          line(resultRecord()),
        ],
      },
    });
    try {
      const operation = await harness.provider.start(
        createCodingAgentRequest({
          requestId: "req-fake-tests",
          workspaceId: WORKSPACE_ID,
          instructions: "run the tests",
          capabilities: ["read-files", "edit-files", "run-commands", "run-tests"],
          commandPolicy: { mode: "sandboxed", allowedCommands: [] },
          disclosure: DISCLOSURE,
          trace: createTrace("trace-fake-tests"),
        }),
      );
      const result = await operation.result;
      expect(result.testResults).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("records test results when a machine-readable report exists in the workspace", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [line(initRecord()), line(resultRecord())],
        afterFiles: [
          {
            path: "reports/tests.json",
            action: "write",
            content: JSON.stringify({ suite: "unit", passed: 12, failed: 1, skipped: 2 }),
          },
        ],
      },
    });
    try {
      const operation = await harness.provider.start(
        createCodingAgentRequest({
          requestId: "req-real-tests",
          workspaceId: WORKSPACE_ID,
          instructions: "run the tests",
          capabilities: ["read-files", "edit-files", "run-commands", "run-tests"],
          commandPolicy: { mode: "sandboxed", allowedCommands: [] },
          disclosure: DISCLOSURE,
          trace: createTrace("trace-real-tests"),
        }),
      );
      const events: { kind: string }[] = [];
      for await (const event of operation.events()) {
        events.push(event);
      }
      const result = await operation.result;
      expect(result.testResults).toMatchObject({ passed: 12, failed: 1, skipped: 2 });
      expect(events.some((event) => event.kind === "test-started")).toBe(true);
      expect(events.some((event) => event.kind === "test-completed")).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("ignores a malformed test report rather than guessing", async () => {
    const harness = await createClaudeHarness({
      scenario: {
        fragments: [line(initRecord()), line(resultRecord())],
        afterFiles: [
          { path: "reports/tests.json", action: "write", content: '{"passed":"lots","failed":-3}' },
        ],
      },
    });
    try {
      const operation = await harness.provider.start(
        createCodingAgentRequest({
          requestId: "req-bad-report",
          workspaceId: WORKSPACE_ID,
          instructions: "run the tests",
          capabilities: ["read-files", "edit-files", "run-commands", "run-tests"],
          commandPolicy: { mode: "sandboxed", allowedCommands: [] },
          disclosure: DISCLOSURE,
          trace: createTrace("trace-bad-report"),
        }),
      );
      const result = await operation.result;
      expect(result.testResults).toBeNull();
    } finally {
      await harness.close();
    }
  });
});
