import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..");
const workflowText = readFileSync(
  resolve(repositoryRoot, ".github", "workflows", "ci.yml"),
  "utf8",
).replaceAll("\r\n", "\n");
const rootManifest = JSON.parse(
  readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
) as { scripts?: Record<string, string> };
const scriptsDirectory = resolve(
  import.meta.dirname,
  "..",
  "scripts",
  "packed-consumer",
);
// Read every reviewed text CRLF-normalized: the repository's sole attribute
// rule pins only the canonical ANT-02 receipt evidence to LF. These verifier
// paths remain subject to Windows checkout conversion, so multi-line literal
// assertions must not depend on their checkout ending style.
const verifierText = readFileSync(
  resolve(scriptsDirectory, "verify-packed-consumer.mjs"),
  "utf8",
).replaceAll("\r\n", "\n");
const probeText = readFileSync(resolve(scriptsDirectory, "probe.mjs"), "utf8").replaceAll(
  "\r\n",
  "\n",
);
const libText = readFileSync(resolve(scriptsDirectory, "lib.mjs"), "utf8").replaceAll(
  "\r\n",
  "\n",
);

const CHECKOUT_SHA = "11d5960a326750d5838078e36cf38b85af677262";
const SETUP_NODE_SHA = "49933ea5288caeca8642d1e84afbd3f7d6820020";

function packedConsumerSection(): string {
  const start = workflowText.indexOf("\n  packed-consumer:");
  const end = workflowText.indexOf("\n# What this workflow deliberately does NOT do");
  expect(start, "the packed-consumer job must exist").toBeGreaterThan(-1);
  expect(end, "the workflow's deliberate-non-actions tail must exist").toBeGreaterThan(start);
  return workflowText.slice(start, end);
}

describe("AM-02 packed-consumer workflow and script policy", () => {
  it("keeps the workflow read-only, secret-free, and non-hiding", () => {
    expect(workflowText).toMatch(/permissions:\n {2}contents: read/);
    expect(workflowText).not.toContain("pull_request_target");
    // The prose comment legitimately names `continue-on-error` while rejecting
    // it; only the active YAML key form is forbidden.
    expect(workflowText).not.toMatch(/^\s*continue-on-error:/m);
    expect(workflowText).not.toContain("secrets.");
    expect(workflowText).not.toContain("GITHUB_TOKEN");
  });

  it("defines the packed-consumer job with the reviewed shape", () => {
    const section = packedConsumerSection();
    expect(section).toContain("name: packed consumer (windows)");
    expect(section).toContain("runs-on: windows-latest");
    expect(section).toContain("timeout-minutes: 35");
    expect(section).toContain(`actions/checkout@${CHECKOUT_SHA}`);
    expect(section).toContain(`actions/setup-node@${SETUP_NODE_SHA}`);
    expect(section).toContain("persist-credentials: false");
    expect(section).toContain("node-version: 24");
    expect(section).toContain("- run: npm ci --ignore-scripts");
    expect(section).toContain("- run: npm run build");
    expect(section).toContain("- run: npm run verify:packed-consumer");
    expect(section).not.toContain("upload-artifact");
    expect(section).not.toContain("env:");
  });

  it("wires the gate through the root manifest script", () => {
    expect(rootManifest.scripts?.["verify:packed-consumer"]).toBe(
      "node packages/application/scripts/packed-consumer/verify-packed-consumer.mjs",
    );
  });

  it("keeps the verifier's process use pinned and shell-free", () => {
    expect(verifierText).toContain("npm_execpath");
    expect(verifierText).toContain("shell: false");
    expect(verifierText).not.toContain("shell: true");
    expect(verifierText).not.toContain("exec(");
    expect(verifierText).not.toContain("cmd.exe");
    expect(verifierText).not.toContain("powershell");
    expect(verifierText).not.toContain("https://");
    expect(verifierText).not.toContain("fetch(");
  });

  it("keeps the probe free of process, network, and environment authority", () => {
    for (const forbidden of [
      "child_process",
      "node:http",
      "node:https",
      "node:net",
      "node:tls",
      "fetch(",
      "process.env[",
      "XMLHttpRequest",
    ]) {
      expect(probeText, `probe must not contain ${forbidden}`).not.toContain(forbidden);
    }
    expect(probeText).toContain("synthetic");
  });

  it("keeps the shared helper library free of I/O beyond hashing", () => {
    expect(libText).toContain('import { createHash } from "node:crypto";');
    for (const forbidden of ["node:fs", "node:child_process", "node:http", "fetch(", "process.env"]) {
      expect(libText, `lib must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("binds the lifecycle-script exception to exactly one named dependency", () => {
    expect(verifierText).toContain("NPM_REBUILD_BETTER_SQLITE3_ARGS");
    const rebuildMentions = verifierText.match(/npm rebuild better-sqlite3/g) ?? [];
    expect(rebuildMentions.length).toBeGreaterThan(0);
    expect(libText).toContain(
      'NPM_REBUILD_BETTER_SQLITE3_ARGS = Object.freeze([\n  "rebuild",\n  "better-sqlite3",\n]);',
    );
  });
});
