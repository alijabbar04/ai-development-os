import { open, readFile, unlink } from "node:fs/promises";

const lockPath = process.argv[2];
const checkout = process.argv[3];
const owner = "desktop-shell-first-light";
if (typeof lockPath !== "string" || typeof checkout !== "string") throw new Error("VALIDATION_LEASE_ARGUMENT_MISSING");

const acquiredAt = new Date().toISOString();
const record = Object.freeze({
  owner,
  processId: process.pid,
  processStartTime: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
  checkout,
  startedAt: acquiredAt,
  label: "desktop-shell-focused-validation",
});

let handle;
let acquired = false;
let refusal = "";
try {
  handle = await open(lockPath, "wx", 0o600);
  await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
  await handle.sync();
  acquired = true;
} catch {
  if (handle !== undefined) {
    await handle.close().catch(() => undefined);
    handle = undefined;
    await unlink(lockPath).catch(() => undefined);
    refusal = "exclusive-create-did-not-complete";
  } else {
    refusal = (await readFile(lockPath, "utf8").catch(() => "unreadable")).slice(0, 4_096);
  }
} finally {
  await handle?.close().catch(() => undefined);
}

if (!acquired) {
  process.stderr.write(`${JSON.stringify({ acquired: false, existing: refusal })}\n`);
  process.exitCode = 2;
} else {
  process.stdout.write(`${JSON.stringify({ acquired: true, ...record })}\n`);

  let releasing = false;
  async function release() {
    if (releasing) return;
    releasing = true;
    try {
      const current = JSON.parse(await readFile(lockPath, "utf8"));
      if (current["processId"] === process.pid && current["owner"] === owner && current["checkout"] === checkout) {
        await unlink(lockPath);
        process.stdout.write(`${JSON.stringify({ released: true, processId: process.pid })}\n`);
      } else {
        process.stderr.write(`${JSON.stringify({ released: false, reason: "ownership-changed" })}\n`);
      }
    } catch {
      process.stderr.write(`${JSON.stringify({ released: false, reason: "release-failed" })}\n`);
    } finally {
      process.exit(0);
    }
  }

  process.once("SIGINT", () => { void release(); });
  process.once("SIGTERM", () => { void release(); });
  setInterval(() => undefined, 60_000);
}
