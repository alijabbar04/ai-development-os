import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const npmExecPath = process.env.npm_execpath;
if (typeof npmExecPath !== "string" || !/npm-cli\.js$/u.test(npmExecPath.replaceAll("\\", "/"))) {
  throw new Error("The packed-consumer verifier requires npm's exact CLI entry path.");
}
const packageDirectories = Object.freeze([
  "domain",
  "artifacts",
  "providers",
  "policy",
  "secrets",
  "secrets-app-vault",
  "secrets-app-vault-electron",
]);
const expectedPrefix = join(tmpdir(), "ai-dev-os-app-vault-packed-");
const taskRoot = await mkdtemp(expectedPrefix);

function run(args, cwd, label) {
  const result = spawnSync(process.execPath, [npmExecPath, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed (${String(result.status)}).\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

try {
  const packRoot = join(taskRoot, "packs");
  const consumerRoot = join(taskRoot, "consumer");
  await mkdir(packRoot);
  await mkdir(consumerRoot);
  run(["run", "build", "--no-update-notifier", "--no-fund"], join(repositoryRoot, "packages", "secrets-app-vault-electron"), "build app-vault packages");
  const dependencies = {};
  for (const directory of packageDirectories) {
    const packageRoot = join(repositoryRoot, "packages", directory);
    const output = run(["pack", "--json", "--pack-destination", packRoot], packageRoot, `pack ${directory}`);
    const result = JSON.parse(output);
    if (!Array.isArray(result) || typeof result[0]?.filename !== "string" || typeof result[0]?.name !== "string") {
      throw new Error(`pack ${directory} returned a malformed result.`);
    }
    const tarball = join(packRoot, result[0].filename);
    dependencies[result[0].name] = `file:${relative(consumerRoot, tarball).replaceAll("\\", "/")}`;
  }
  dependencies.electron = "43.4.1";
  await writeFile(join(consumerRoot, "package.json"), JSON.stringify({
    name: "ai-dev-os-app-vault-packed-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    description: "Task-owned scripts-disabled Stage 18E packed consumer.",
    dependencies,
  }, null, 2));
  await writeFile(join(consumerRoot, "probe.mjs"), `
import { join } from "node:path";
import {
  appVaultContainerBinding,
  createAppVaultManager,
} from "@ai-dev-os/secrets-app-vault";
import * as appVault from "@ai-dev-os/secrets-app-vault";
import {
  createDeterministicAppVaultCryptoPort,
  createDeterministicAppVaultRandomPort,
  createMemoryAppVaultStoragePort,
} from "@ai-dev-os/secrets-app-vault/testing";
import * as electronAdapter from "@ai-dev-os/secrets-app-vault-electron";
import { createNodeFileAppVaultStoragePort } from "@ai-dev-os/secrets-app-vault-electron/testing";

const marker = "SYNTHETIC-PACKED-APP-VAULT-4A19";
const identity = Object.freeze({ name: "Packed Consumer", appDataPath: "C:/packed/consumer" });
const clock = Object.freeze({ now: () => new Date("2026-08-19T09:00:00.000Z") });
const memory = createMemoryAppVaultStoragePort();
const manager = createAppVaultManager({
  schemaVersion: 1,
  appIdentity: identity,
  clock,
  crypto: createDeterministicAppVaultCryptoPort(),
  storage: memory.port,
  random: createDeterministicAppVaultRandomPort(),
});
const created = await manager.create({ slotId: "anthropic", secret: marker, expectRevision: null });
if (created.state !== "present" || JSON.stringify(created).includes(marker)) throw new Error("pure packed manager projection failed");
const bytes = memory.snapshot().primary;
if (!(bytes instanceof Uint8Array) || new TextDecoder().decode(bytes).includes(marker)) throw new Error("pure packed ciphertext boundary failed");
const binding = appVaultContainerBinding({ appIdentity: identity, backendKind: "deterministic-fake" });
const filesystem = await createNodeFileAppVaultStoragePort({ root: join(process.cwd(), "vault"), binding, platform: process.platform });
await filesystem.writeAtomic({ bytes, expectedRevision: null });
if ((await filesystem.read())?.bytes.byteLength !== bytes.byteLength) throw new Error("packed filesystem adapter failed");
if (electronAdapter.APP_VAULT_ELECTRON_FLOOR !== "42.4.1") throw new Error("packed Electron floor drifted");
if ("createElectronSafeStorageCryptoPort" in electronAdapter) throw new Error("raw decrypt-capable crypto authority leaked from production export");
if ("createNodeFileAppVaultStoragePort" in electronAdapter) throw new Error("raw filesystem authority leaked from production export");
for (const internal of ["parseVaultDocument", "serializeVaultDocument", "vaultCipherBytes"]) {
  if (internal in appVault) throw new Error("document internals leaked from production export");
}
console.log(JSON.stringify({ pure: "ok", filesystem: "ok", electronProductionBoundary: "manager-broker-only", secretProjected: false }));
`);
  run(["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumerRoot, "packed consumer install");
  run(["ls", "--all"], consumerRoot, "packed consumer dependency graph");
  run(["audit", "--audit-level=high"], consumerRoot, "packed consumer audit");
  const probe = spawnSync(process.execPath, [join(consumerRoot, "probe.mjs")], { cwd: consumerRoot, encoding: "utf8", windowsHide: true });
  if (probe.status !== 0) throw new Error(`packed consumer probe failed.\n${probe.stdout}\n${probe.stderr}`);
  process.stdout.write(probe.stdout);
} finally {
  if (!taskRoot.startsWith(expectedPrefix) || taskRoot.length <= expectedPrefix.length) throw new Error("Refusing to remove an unexpected packed-consumer directory.");
  await rm(taskRoot, { recursive: true, force: true });
}
