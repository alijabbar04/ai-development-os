import { mkdtempSync, rmSync } from "node:fs";
import { readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createManualClock,
  createSequentialIdSource,
  runArtifactStoreContractSuite,
  type ArtifactStoreContractHarness,
} from "@ai-dev-os/artifact-store/testing";
import type { ContentKey } from "@ai-dev-os/artifact-store";
import { createLocalArtifactStore } from "../src/index.js";

function objectPathIn(root: string, key: ContentKey): string {
  return join(root, "v1", key.algorithm, key.hex.slice(0, 2), key.hex);
}

runArtifactStoreContractSuite("artifact-store-local", async (): Promise<ArtifactStoreContractHarness> => {
  const root = mkdtempSync(join(tmpdir(), "aidevos-cas-"));
  const clock = createManualClock();
  const idSource = createSequentialIdSource();
  const tempDir = join(root, "tmp");
  let tempCounter = 0;

  const openStore = () => createLocalArtifactStore({ root, clock, idSource });

  return {
    store: await openStore(),
    clock,
    reopen: openStore,
    corruptObject: async (key) => {
      const path = objectPathIn(root, key);
      const bytes = await readFile(path);
      if (bytes.byteLength === 0) {
        await writeFile(path, Buffer.from([1]));
        return;
      }
      const flipped = Buffer.from(bytes);
      flipped[0] = (flipped[0]! + 1) % 256;
      await writeFile(path, flipped);
    },
    tempFiles: {
      createMatching: async (ageMs) => {
        tempCounter += 1;
        const name = `w-${tempCounter.toString(16).padStart(31, "e")}f.tmp`;
        const path = join(tempDir, name);
        await writeFile(path, "stale temp content");
        const when = new Date(clock.now().valueOf() - ageMs);
        await utimes(path, when, when);
      },
      createForeign: async (ageMs) => {
        const path = join(tempDir, "user-file.keep");
        await writeFile(path, "not the store's file");
        const when = new Date(clock.now().valueOf() - ageMs);
        await utimes(path, when, when);
      },
      count: async () => (await readdir(tempDir)).length,
    },
    dispose: async () => {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    },
  };
});

// A second contract run in "fast" durability mode: behavior must be
// functionally identical, only the fsync policy differs.
runArtifactStoreContractSuite("artifact-store-local (fast durability)", async (): Promise<ArtifactStoreContractHarness> => {
  const root = mkdtempSync(join(tmpdir(), "aidevos-cas-fast-"));
  const clock = createManualClock();

  return {
    store: await createLocalArtifactStore({ root, clock, durability: "fast" }),
    clock,
    reopen: () => createLocalArtifactStore({ root, clock, durability: "fast" }),
    corruptObject: async (key) => {
      const path = objectPathIn(root, key);
      const bytes = await readFile(path);
      const flipped = Buffer.from(bytes.byteLength === 0 ? [1] : bytes);
      if (bytes.byteLength > 0) {
        flipped[0] = (flipped[0]! + 1) % 256;
      }
      await writeFile(path, flipped);
    },
    dispose: async () => {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    },
  };
});
