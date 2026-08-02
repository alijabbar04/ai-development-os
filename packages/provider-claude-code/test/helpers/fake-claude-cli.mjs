#!/usr/bin/env node
/**
 * A process-level fake Claude Code CLI.
 *
 * This is a real executable driven through the real process broker, not an
 * in-process stub. It is reached the way a Windows-safe deployment reaches a
 * script entry point: a trusted `node` image plus a pinned argument prefix, so
 * no `.cmd` shim and no shell are involved.
 *
 * The scenario file is `process.argv[2]`, pinned by the trusted tool
 * descriptor. Everything after it is the argument vector the adapter built,
 * which the fake records verbatim so tests can assert on exactly what was sent.
 */

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const scenarioPath = process.argv[2];
const adapterArgs = process.argv.slice(3);

if (scenarioPath === undefined) {
  process.stderr.write("fake-claude-cli: missing scenario path\n");
  process.exit(64);
}

const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));

/** Every scenario writes the argv it received, so argument tests are exact. */
if (typeof scenario.argvOut === "string") {
  writeFileSync(scenario.argvOut, JSON.stringify(adapterArgs), "utf8");
}

/**
 * The armed start marker. Its presence proves a Claude process really started;
 * its absence after a production-mode attempt proves refusal happened first.
 * The positive control in the test suite runs the same scenario in development
 * mode and asserts the marker DOES appear, so the negative test is not vacuous.
 */
if (typeof scenario.startMarker === "string") {
  mkdirSync(dirname(scenario.startMarker), { recursive: true });
  writeFileSync(scenario.startMarker, "started", "utf8");
}

/** Records every environment variable name the child actually received. */
if (typeof scenario.environmentOut === "string") {
  writeFileSync(
    scenario.environmentOut,
    JSON.stringify({
      names: Object.keys(process.env).sort(),
      values: (scenario.environmentCanaryNames ?? []).map((name) => process.env[name] ?? null),
      cwd: process.cwd(),
    }),
    "utf8",
  );
}

if (scenario.versionOnly === true || adapterArgs.includes("--version")) {
  process.stdout.write(`${scenario.version ?? "2.1.201"} (Claude Code)\n`);
  process.exit(scenario.versionExitCode ?? 0);
}

function argumentValue(flag) {
  const index = adapterArgs.indexOf(flag);
  return index >= 0 && index + 1 < adapterArgs.length ? adapterArgs[index + 1] : null;
}

const sessionId = argumentValue("--session-id") ?? argumentValue("--resume") ?? "00000000-0000-4000-8000-000000000000";
const requestedModel = argumentValue("--model");

function render(text) {
  return text
    .split("{{sessionId}}")
    .join(sessionId)
    .split("{{model}}")
    .join(scenario.reportedModel ?? requestedModel ?? "claude-fable-5");
}

/** Applies the scenario's filesystem mutations inside the managed worktree. */
function applyFilesystem(list) {
  for (const entry of list ?? []) {
    const target = resolve(process.cwd(), entry.path);
    if (entry.action === "delete") {
      rmSync(target, { force: true, recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.content ?? "", "utf8");
  }
}

/**
 * The timer is deliberately NOT unref'd. An unref'd timer lets Node exit as
 * soon as the event loop is otherwise empty, which would make a "hang" scenario
 * exit immediately and quietly turn a cancellation test into a race the fixture
 * always loses.
 */
async function sleep(ms) {
  await new Promise((done) => {
    setTimeout(done, ms);
  });
}

async function main() {
  // Drain stdin so the instructions are consumed exactly as a real CLI would.
  const stdinChunks = [];
  await new Promise((done) => {
    process.stdin.on("data", (chunk) => stdinChunks.push(chunk));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
  if (typeof scenario.stdinOut === "string") {
    writeFileSync(scenario.stdinOut, Buffer.concat(stdinChunks));
  }

  applyFilesystem(scenario.beforeFiles);

  if (scenario.ignoreSignals === true) {
    process.on("SIGTERM", () => {});
    process.on("SIGINT", () => {});
  }

  if (scenario.spawnChild === true) {
    const child = spawn(
      process.execPath,
      ["-e", `const t=setInterval(()=>{},1000); setTimeout(()=>{clearInterval(t);}, ${scenario.childLifetimeMs ?? 30_000});`],
      { detached: false, stdio: "ignore" },
    );
    child.unref?.();
    if (typeof scenario.childMarker === "string") {
      writeFileSync(scenario.childMarker, String(child.pid ?? 0), "utf8");
    }
  }

  if (typeof scenario.stderr === "string") {
    process.stderr.write(render(scenario.stderr));
  }

  for (const fragment of scenario.fragments ?? []) {
    if (typeof fragment.delayMs === "number" && fragment.delayMs > 0) {
      await sleep(fragment.delayMs);
    }
    if (typeof fragment.base64 === "string") {
      process.stdout.write(Buffer.from(fragment.base64, "base64"));
      continue;
    }
    if (typeof fragment.stderr === "string") {
      process.stderr.write(render(fragment.stderr));
      continue;
    }
    const text = render(fragment.text ?? "");
    const split = typeof fragment.byteSplit === "number" && fragment.byteSplit > 0 ? fragment.byteSplit : 0;
    if (split === 0) {
      process.stdout.write(text);
      continue;
    }
    const bytes = Buffer.from(text, "utf8");
    for (let offset = 0; offset < bytes.byteLength; offset += split) {
      process.stdout.write(bytes.subarray(offset, Math.min(offset + split, bytes.byteLength)));
      await sleep(1);
    }
  }

  applyFilesystem(scenario.afterFiles);

  if (typeof scenario.doneMarker === "string") {
    appendFileSync(scenario.doneMarker, "done\n", "utf8");
  }

  if (scenario.hangMs !== undefined) {
    await sleep(scenario.hangMs);
  }

  process.exit(scenario.exitCode ?? 0);
}

void main().catch((error) => {
  process.stderr.write(`fake-claude-cli internal failure: ${String(error && error.message)}\n`);
  process.exit(70);
});
