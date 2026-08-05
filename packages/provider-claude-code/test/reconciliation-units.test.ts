/**
 * Reconciliation and wire-validation unit coverage.
 *
 * Reconciliation is exercised against a stub workspace handle so every
 * violation branch can be reached deterministically, including the ones a
 * real Git repository will not produce on demand (a hostile path recorded in
 * the manifest, a truncated manifest, a link check that itself fails).
 */

import { describe, expect, it } from "vitest";
import type { ChangedFileEntry, ChangedFileManifest } from "@ai-dev-os/workspace";
import { parseCapabilityGrant, type CapabilityGrant } from "@ai-dev-os/process-broker";
import { parseWireLine, reconcileWorkspace, type ClaudeWorkspaceHandle } from "../src/index.js";

const NOW = "2026-08-02T12:00:00.000Z";

function grantWith(writablePrefixes: readonly string[]): CapabilityGrant {
  return parseCapabilityGrant({
    schemaVersion: 2,
    grantId: "grant-unit",
    projectId: "proj",
    runId: null,
    taskId: null,
    attemptId: "att",
    snapshotId: "snap",
    workspaceId: "ws",
    operations: ["workspace-read", "workspace-write"],
    readablePrefixes: [""],
    writablePrefixes,
    tools: [],
    environmentNames: [],
    credentialRefFingerprints: [],
    controlPlaneEndpointPolicyFingerprint: null,
    network: { mode: "denied", egressDomains: [] },
    quotas: {
      wallClockMs: 30_000,
      cpuTimeMs: null,
      memoryBytes: null,
      processCount: null,
      outputBytes: 1_048_576,
      diskBytes: null,
      fileCount: null,
    },
    issuedAt: new Date(new Date(NOW).valueOf() - 60_000).toISOString(),
    expiresAt: new Date(new Date(NOW).valueOf() + 3_600_000).toISOString(),
    nonce: "c".repeat(32),
    policyFingerprint: "d".repeat(64),
    approvalEvidenceRefs: [],
  });
}

function entry(overrides: Partial<ChangedFileEntry>): ChangedFileEntry {
  return {
    path: "a.txt",
    previousPath: null,
    changeKind: "modified",
    oldObjectId: null,
    newObjectId: null,
    oldMode: null,
    newMode: null,
    similarityPercent: null,
    isSubmodule: false,
    isSymlink: false,
    sizeBytes: null,
    binary: false,
    diffArtifactDigest: null,
    ...overrides,
  };
}

function manifest(entries: readonly ChangedFileEntry[], truncated = false): ChangedFileManifest {
  return { schemaVersion: 1, entries, truncated, fingerprint: "e".repeat(64) };
}

interface StubOptions {
  readonly entries?: readonly ChangedFileEntry[];
  readonly truncated?: boolean;
  readonly captureThrows?: boolean;
  readonly linkPaths?: readonly string[];
  readonly linkThrows?: boolean;
}

function stubWorkspace(options: StubOptions): ClaudeWorkspaceHandle {
  const links = new Set(options.linkPaths ?? []);
  return {
    workspaceId: "ws",
    projectId: "proj",
    attemptId: "att",
    snapshotId: "snap",
    baseRevision: "0".repeat(40),
    worktreeDir: "/managed/worktree",
    managedRoot: "/managed",
    lease: { isValid: () => true } as unknown as ClaudeWorkspaceHandle["lease"],
    grant: grantWith([""]),
    paths: { tempDir: "/tmp", homeDir: null, configDir: null, cacheDir: null },
    isManagedPrivateWorktree: true,
    captureChanges: async () => {
      if (options.captureThrows === true) {
        throw new Error("git unavailable");
      }
      return manifest(options.entries ?? [], options.truncated ?? false);
    },
    capturePatch: async () => new Uint8Array(),
    commit: async () => {
      throw new Error("not used");
    },
    readTestReport: async () => null,
    linkMetadata: async (relativePath: string) => {
      if (options.linkThrows === true) {
        throw new Error("stat failed");
      }
      return { isLink: links.has(relativePath) };
    },
  };
}

const BASE_INPUT = {
  grant: grantWith([""]),
  allowedPathPrefixes: [] as readonly string[],
  maxChangedFiles: 100,
  maxProducedBytes: 1_000_000,
  editingGranted: true,
};

describe("reconciliation violations", () => {
  it("reports the workspace unavailable when the diff cannot be taken", async () => {
    const result = await reconcileWorkspace({
      ...BASE_INPUT,
      workspace: stubWorkspace({ captureThrows: true }),
    });
    expect(result.unavailable).toBe(true);
    expect(result.clean).toBe(false);
    expect(result.violations[0]?.detailCode).toBe("workspace-missing");
    expect(result.changedFiles).toHaveLength(0);
  });

  it("accepts an ordinary change set and sorts it deterministically", async () => {
    const result = await reconcileWorkspace({
      ...BASE_INPUT,
      workspace: stubWorkspace({
        entries: [
          entry({ path: "z.txt", changeKind: "added", sizeBytes: 10 }),
          entry({ path: "a.txt", changeKind: "deleted" }),
          entry({ path: "m.txt", changeKind: "renamed", previousPath: "old.txt" }),
        ],
      }),
    });
    expect(result.clean).toBe(true);
    expect(result.changedFiles.map((change) => change.path)).toEqual(["a.txt", "m.txt", "z.txt"]);
    expect(result.totalProducedBytes).toBe(10);
  });

  it.each([
    ["an absolute path", "/etc/passwd"],
    ["a drive-qualified path", "C:/Windows/system32"],
    ["a backslash path", "dir\\file.txt"],
    ["a traversing path", "../escape.txt"],
    ["an empty segment", "dir//file.txt"],
    ["an overlong path", `${"x".repeat(1_100)}.txt`],
  ])("counts %s as a hostile path", async (_label, path) => {
    const result = await reconcileWorkspace({
      ...BASE_INPUT,
      workspace: stubWorkspace({ entries: [entry({ path })] }),
    });
    expect(result.clean).toBe(false);
    expect(result.violations.map((violation) => violation.detailCode)).toContain("hostile-path");
    expect(result.changedFiles).toHaveLength(0);
  });

  it("counts a hostile previous path on a rename", async () => {
    const result = await reconcileWorkspace({
      ...BASE_INPUT,
      workspace: stubWorkspace({
        entries: [entry({ path: "ok.txt", changeKind: "renamed", previousPath: "../outside.txt" })],
      }),
    });
    expect(result.violations.map((violation) => violation.detailCode)).toContain("hostile-path");
  });

  it("counts a change to administrative state, including a renamed source", async () => {
    const direct = await reconcileWorkspace({
      ...BASE_INPUT,
      workspace: stubWorkspace({ entries: [entry({ path: ".git/config" })] }),
    });
    expect(direct.violations.map((violation) => violation.detailCode)).toContain(
      "reconciliation-administrative-path",
    );

    const renamed = await reconcileWorkspace({
      ...BASE_INPUT,
      workspace: stubWorkspace({
        entries: [entry({ path: "ok.txt", changeKind: "renamed", previousPath: ".GIT/HEAD" })],
      }),
    });
    expect(renamed.violations.map((violation) => violation.detailCode)).toContain(
      "reconciliation-administrative-path",
    );
  });

  it("counts any change at all when editing was never granted", async () => {
    const result = await reconcileWorkspace({
      ...BASE_INPUT,
      editingGranted: false,
      workspace: stubWorkspace({ entries: [entry({ path: "a.txt" })] }),
    });
    expect(result.violations.map((violation) => violation.detailCode)).toContain(
      "reconciliation-path-violation",
    );
  });

  it("counts a change outside the request prefixes and outside the grant prefixes", async () => {
    const requestScoped = await reconcileWorkspace({
      ...BASE_INPUT,
      allowedPathPrefixes: ["src"],
      workspace: stubWorkspace({ entries: [entry({ path: "docs/readme.md" })] }),
    });
    expect(requestScoped.violations.map((violation) => violation.detailCode)).toContain(
      "reconciliation-path-violation",
    );

    const grantScoped = await reconcileWorkspace({
      ...BASE_INPUT,
      grant: grantWith(["src"]),
      workspace: stubWorkspace({ entries: [entry({ path: "docs/readme.md" })] }),
    });
    expect(grantScoped.violations.map((violation) => violation.detailCode)).toContain(
      "reconciliation-path-violation",
    );
  });

  it("counts a symlink recorded in the diff as a link escape", async () => {
    const result = await reconcileWorkspace({
      ...BASE_INPUT,
      workspace: stubWorkspace({ entries: [entry({ path: "link.txt", isSymlink: true })] }),
    });
    expect(result.violations.map((violation) => violation.detailCode)).toContain(
      "reconciliation-link-escape",
    );
  });

  it("counts a link discovered on the live filesystem after staging", async () => {
    const result = await reconcileWorkspace({
      ...BASE_INPUT,
      workspace: stubWorkspace({ entries: [entry({ path: "junction.txt" })], linkPaths: ["junction.txt"] }),
    });
    expect(result.violations.map((violation) => violation.detailCode)).toContain(
      "reconciliation-link-escape",
    );
  });

  it("counts a link check that itself fails as an escape rather than ignoring it", async () => {
    const result = await reconcileWorkspace({
      ...BASE_INPUT,
      workspace: stubWorkspace({ entries: [entry({ path: "a.txt" })], linkThrows: true }),
    });
    expect(result.violations.map((violation) => violation.detailCode)).toContain(
      "reconciliation-link-escape",
    );
  });

  it("does not link-check a deleted path", async () => {
    const result = await reconcileWorkspace({
      ...BASE_INPUT,
      workspace: stubWorkspace({
        entries: [entry({ path: "gone.txt", changeKind: "deleted" })],
        linkThrows: true,
      }),
    });
    expect(result.clean).toBe(true);
  });

  it("counts the changed-file and produced-byte ceilings", async () => {
    const tooMany = await reconcileWorkspace({
      ...BASE_INPUT,
      maxChangedFiles: 1,
      workspace: stubWorkspace({
        entries: [entry({ path: "a.txt" }), entry({ path: "b.txt" })],
      }),
    });
    expect(tooMany.violations.map((violation) => violation.detailCode)).toContain(
      "reconciliation-file-limit",
    );

    const tooLarge = await reconcileWorkspace({
      ...BASE_INPUT,
      maxProducedBytes: 5,
      workspace: stubWorkspace({ entries: [entry({ path: "a.txt", sizeBytes: 100 })] }),
    });
    expect(tooLarge.violations.map((violation) => violation.detailCode)).toContain(
      "reconciliation-byte-limit",
    );
  });

  it("counts a truncated manifest as a file-limit violation", async () => {
    const result = await reconcileWorkspace({
      ...BASE_INPUT,
      workspace: stubWorkspace({ entries: [entry({ path: "a.txt" })], truncated: true }),
    });
    expect(result.violations.map((violation) => violation.detailCode)).toContain(
      "reconciliation-file-limit",
    );
  });

  it("aggregates repeated violations by count without listing any path", async () => {
    const result = await reconcileWorkspace({
      ...BASE_INPUT,
      workspace: stubWorkspace({
        entries: [entry({ path: "/one" }), entry({ path: "/two" }), entry({ path: "/three" })],
      }),
    });
    const hostile = result.violations.find((violation) => violation.detailCode === "hostile-path");
    expect(hostile?.count).toBe(3);
    expect(JSON.stringify(result.violations)).not.toContain("/one");
  });
});

describe("wire helper edge cases", () => {
  const ok = (line: string): readonly unknown[] => {
    const outcome = parseWireLine(line);
    if (!outcome.ok) {
      throw new Error(`expected success, got ${outcome.detailCode}`);
    }
    return outcome.records;
  };
  const detail = (line: string): string | null => {
    const outcome = parseWireLine(line);
    return outcome.ok ? null : outcome.detailCode;
  };

  it("accepts init metadata nested under the documented system envelope", () => {
    const records = ok(
      JSON.stringify({
        type: "system",
        subtype: "init",
        system: { session_id: "sess-1", model: "claude-fable-5", tools: ["Read"] },
      }),
    );
    expect(records[0]).toMatchObject({ type: "init", sessionId: "sess-1", model: "claude-fable-5" });
  });

  it("reads named MCP server and plugin entries as well as plain strings", () => {
    const records = ok(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
        mcp_servers: [{ name: "alpha", status: "connected" }, "beta", { nope: 1 }],
        plugins: [{ name: "gamma", path: "/x" }],
      }),
    );
    expect(records[0]).toMatchObject({ mcpServerNames: ["alpha", "beta"], pluginNames: ["gamma"] });
  });

  it("accepts a string assistant message body", () => {
    expect(ok('{"type":"assistant","content":"plain text"}')).toEqual([
      { type: "assistant-text", text: "plain text" },
    ]);
    expect(ok('{"type":"assistant","message":{"content":"nested text"}}')).toEqual([
      { type: "assistant-text", text: "nested text" },
    ]);
  });

  it("drops an empty assistant text block rather than emitting a blank chunk", () => {
    expect(ok('{"type":"assistant","message":{"content":[{"type":"text","text":""}]}}')).toEqual([]);
  });

  it("ignores non-tool-result blocks in the user envelope", () => {
    expect(
      ok(JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hi" }] } })),
    ).toEqual([]);
    expect(ok('{"type":"user"}')).toEqual([]);
  });

  it("rejects an assistant envelope with no readable content", () => {
    expect(detail('{"type":"assistant"}')).toBe("unknown-state-changing-record");
    expect(detail('{"type":"assistant","message":{"content":[42]}}')).toBe(
      "unknown-state-changing-record",
    );
  });

  it("rejects a tool_use block missing an id or a name", () => {
    expect(
      detail(
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }),
      ),
    ).toBe("unknown-state-changing-record");
    expect(
      detail(
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1" }] } }),
      ),
    ).toBe("unknown-state-changing-record");
  });

  it("rejects a tool_result without a usable tool-use id", () => {
    expect(
      detail(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result" }] } })),
    ).toBe("unknown-state-changing-record");
  });

  it("rejects an api_retry event with unusable counters", () => {
    expect(
      detail('{"type":"system","subtype":"api_retry","attempt":-1,"max_retries":3,"retry_delay_ms":10}'),
    ).toBe("unsafe-number");
    expect(detail('{"type":"system","subtype":"api_retry","max_retries":3,"retry_delay_ms":10}')).toBe(
      "unsafe-number",
    );
  });

  it("clamps an absurd retry delay and defaults an unnamed error category", () => {
    const records = ok(
      '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":3,"retry_delay_ms":999999999999}',
    );
    expect(records[0]).toMatchObject({ retryDelayMs: 86_400_000, errorCategory: "unknown" });
  });

  it("rejects malformed per-model usage and denial lists", () => {
    expect(detail('{"type":"result","subtype":"success","modelUsage":[]}')).toBe("unsafe-number");
    expect(detail('{"type":"result","subtype":"success","modelUsage":{"m":1}}')).toBe("unsafe-number");
    expect(
      detail('{"type":"result","subtype":"success","modelUsage":{"m":{"inputTokens":-1}}}'),
    ).toBe("unsafe-number");
    expect(detail('{"type":"result","subtype":"success","permission_denials":{}}')).toBe("unsafe-number");
    expect(detail('{"type":"result","subtype":"success","permission_denials":[{}]}')).toBe("unsafe-number");
  });

  it("sorts per-model usage deterministically", () => {
    const records = ok(
      JSON.stringify({
        type: "result",
        subtype: "success",
        modelUsage: {
          zeta: { inputTokens: 1 },
          alpha: { inputTokens: 2 },
        },
      }),
    );
    const usage = (records[0] as { modelUsage: { model: string }[] }).modelUsage;
    expect(usage.map((entryValue) => entryValue.model)).toEqual(["alpha", "zeta"]);
  });

  it("accepts a denial with no tool-use id and filters unusable argument keys", () => {
    const records = ok(
      JSON.stringify({
        type: "result",
        subtype: "success",
        permission_denials: [
          { tool_name: "Bash", tool_input: { "ok_key": 1, "bad key!": 2, [`${"x".repeat(80)}`]: 3 } },
        ],
      }),
    );
    const denials = (records[0] as { permissionDenials: { toolUseId: string | null; argumentKeys: string[] }[] })
      .permissionDenials;
    expect(denials[0]?.toolUseId).toBeNull();
    expect(denials[0]?.argumentKeys).toEqual(["ok_key"]);
  });

  it("treats an absent usage block as unreported rather than zero-filled", () => {
    const records = ok('{"type":"result","subtype":"success"}');
    expect(records[0]).toMatchObject({ usage: null, totalCostMicros: null, numTurns: null });
  });

  it("ignores documented informational system subtypes", () => {
    for (const subtype of ["status", "info", "notice", "compact", "warning", "commands_changed"]) {
      expect(ok(JSON.stringify({ type: "system", subtype }))).toEqual([
        { type: "ignorable", subtype },
      ]);
    }
  });

  it("names an unnamed unknown system subtype rather than emitting an empty label", () => {
    expect(ok('{"type":"system"}')).toEqual([{ type: "unknown-compatible", subtype: "unnamed" }]);
  });

  it("rejects a record type that is absent, empty, or absurdly long", () => {
    expect(detail('{"subtype":"init"}')).toBe("non-object-record");
    expect(detail('{"type":""}')).toBe("non-object-record");
    expect(detail(JSON.stringify({ type: "x".repeat(200) }))).toBe("non-object-record");
  });

  it("rejects a value nested beyond the depth bound", () => {
    let nested: Record<string, unknown> = { deep: true };
    for (let index = 0; index < 20; index += 1) {
      nested = { nested };
    }
    expect(detail(JSON.stringify({ type: "result", subtype: "success", usage: nested }))).toBe(
      "prototype-pollution",
    );
  });
});
