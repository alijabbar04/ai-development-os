import { basename, join, resolve } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryPersistenceAdapter } from "@ai-dev-os/persistence-memory";
import { materializePlanningHandovers, parsePlanningHandover, planningHandoverFileName, readPlanningHandovers } from "../src/planning-handover.js";

const control = vi.hoisted(() => ({ mode: "stable-existing", target: "", staging: "", bytes: Buffer.alloc(0), present: true, written: false, removed: false, published: false, unlinks: [] as string[], links: [] as string[], unboundedReads: 0, readRequests: [] as number[], closes: 0 }));
const root = resolve("handover-identity-control"), idA = 9_007_199_254_740_992n, idB = 9_007_199_254_740_993n;
const record = (() => {
  const binding = { schemaVersion: 1, kind: "planning-handover", authority: "none", handoverId: "planning-handover:owned-control", projectId: "prj:owned", projectDigest: "a".repeat(64), briefId: "brief:owned", briefVersion: 1, briefDigest: "b".repeat(64), planId: "plan:owned", planRevision: 1, planVersion: 1, planDigest: "c".repeat(64), createdAt: "2026-09-08T00:00:00.000Z" };
  return parsePlanningHandover({ ...binding, result: null, document: { ...binding, projectName: "Owned I/O control", objective: "Inspect an authority-none artifact", outcomes: [], nonGoals: [], planState: "drafting", stages: [], tasks: [], repositoryObservation: null,
    instructions: "Manually inspect this planning context in your chosen tool. It grants no execution, spending, repository write, or approval authority. Returned text is an untrusted operator-supplied report.",
    returnTemplate: { schemaVersion: 1, kind: "planning-manual-result", authority: "none", handoverId: binding.handoverId, projectId: binding.projectId, briefDigest: binding.briefDigest, planDigest: binding.planDigest, text: "Owned control" } } });
})();
function stat(file: boolean, id: bigint, options?: { bigint?: boolean }, empty = false) {
  const integer = (n: bigint) => options?.bigint === true ? n : Number(n);
  const linked = !control.removed && (control.mode.includes("staging") || control.published);
  return { dev: integer(11n), ino: integer(id), size: integer(!file || empty ? 0n : BigInt(control.bytes.length)), nlink: integer(file && linked ? 2n : 1n), mtimeMs: integer(1_700_000_000_000n), mtimeNs: 1_700_000_000_000_000_000n,
    isFile: () => file, isDirectory: () => !file, isSymbolicLink: () => false };
}
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual,
    async realpath(value: string) { return resolve(value) === root ? root : await actual.realpath(value); },
    async lstat(value: string, options?: { bigint?: boolean }) {
      if (resolve(value) === root) return stat(false, 71n, options);
      if (value === control.target) { if (!control.present) throw Object.assign(new Error("missing owned target"), { code: "ENOENT" }); return stat(true, control.mode === "replaced-publication" && control.published ? idB : idA, options); }
      if (value === control.staging) return stat(true, control.mode === "unknown-staging" || control.mode === "replaced-publication" ? idB : idA, options);
      return await actual.lstat(value, options);
    },
    async open(value: string, flags: string) {
      if (value !== control.target && !(value.startsWith(control.target + ".") && value.endsWith(".pending"))) return await actual.open(value, flags);
      const writing = flags === "wx"; if (writing) control.staging = value;
      return {
        async stat(options?: { bigint?: boolean }) { if (writing && control.mode === "identity-failure") throw new Error("OWNED_STAT_FAILURE"); return stat(true, !writing && control.mode === "replaced-publication" && control.published ? idB : idA, options, writing && !control.written); },
        async writeFile(bytes: string) { expect(Buffer.from(bytes)).toEqual(control.bytes); control.written = true; }, async sync() {}, async close() { control.closes++; },
        async readFile() { control.unboundedReads++; return control.bytes.toString() + (control.mode === "growing-file" ? "x" : ""); },
        async read(buffer: Buffer, offset: number, length: number, position: number) { control.readRequests.push(length); const bytes = control.mode === "growing-file" ? Buffer.concat([control.bytes, Buffer.from("x")]) : control.bytes; return { bytesRead: bytes.copy(buffer, offset, position, position + length), buffer }; },
      };
    },
    async opendir(value: string) { if (value !== root) throw new Error("UNEXPECTED_DIRECTORY"); return (async function* () { yield { name: basename(control.staging) }; })(); },
    async link(from: string, to: string) { control.links.push(from); expect(to).toBe(control.target); control.present = true; control.published = true; },
    async unlink(value: string) { control.unlinks.push(value); if (control.mode !== "unknown-staging") control.removed = true; },
  };
});
beforeEach(() => {
  control.mode = "stable-existing"; control.target = join(root, planningHandoverFileName(record)); control.staging = control.target + ".00000000-0000-4000-8000-000000000000.pending";
  control.bytes = Buffer.from(JSON.stringify(record.document, null, 2) + "\n"); control.present = true; control.written = false; control.removed = false; control.published = false; control.unlinks = []; control.links = []; control.unboundedReads = 0; control.readRequests = []; control.closes = 0;
});
async function materialize() {
  const persistence = createMemoryPersistenceAdapter();
  await persistence.transact((tx) => tx.aggregates.create({ aggregateType: "planning-handover", aggregateId: record.handoverId, schemaVersion: 1, payload: record }));
  const stored = await persistence.transact((tx) => tx.aggregates.get("planning-handover", record.handoverId));
  // Materialization uses the canonicalized persisted document, including its
  // property order, rather than the caller's original object insertion order.
  control.bytes = Buffer.from(JSON.stringify((stored!.payload as { document: unknown }).document, null, 2) + "\n");
  const records = await persistence.transact(readPlanningHandovers);
  return (await materializePlanningHandovers(records, root)).get(record.handoverId);
}
it("reconciles an exact owned staging link and preserves the complete document", async () => {
  control.mode = "owned-staging"; expect(await materialize()).toBe("published"); expect(control.unlinks).toEqual([control.staging]);
});
it("preserves an unknown staging file whose distinct ID rounds equal to the target", async () => {
  control.mode = "unknown-staging"; expect(Number(idA)).toBe(Number(idB));
  expect(await materialize()).toBe("differs-on-disk");
  expect(control.unlinks).toEqual([]);
});
it("bounds artifact reads even when the file grows after its initial metadata check", async () => {
  control.mode = "growing-file"; expect(await materialize()).toBe("differs-on-disk");
  expect(control.unboundedReads).toBe(0); expect(control.readRequests.length).toBeGreaterThan(0); expect(Math.max(...control.readRequests)).toBeLessThanOrEqual(control.bytes.length + 1);
});
it("publishes and cleans only the exact newly written staging file", async () => {
  control.present = false; expect(await materialize()).toBe("published"); expect(control.links).toEqual([control.staging]); expect(control.unlinks).toEqual([control.staging]);
});
it("preserves a replaced staging file before publication or cleanup", async () => {
  control.mode = "replaced-publication"; control.present = false;
  expect(await materialize()).toBe("differs-on-disk");
  expect(control.links).toEqual([]); expect(control.unlinks).toEqual([]);
});
it("closes a newly opened staging handle if its initial identity cannot be observed", async () => {
  control.mode = "identity-failure"; control.present = false;
  expect(await materialize()).toBe("unavailable");
  expect(control.closes).toBe(1); expect(control.links).toEqual([]); expect(control.unlinks).toEqual([]);
});
