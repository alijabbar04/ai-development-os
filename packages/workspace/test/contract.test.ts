import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { createGitRuntime } from "../src/index.js";
import { runWorkspaceContractSuite } from "../src/testing/contract-suite.js";
import { cleanupAllFixtures } from "../src/testing/repo-fixtures.js";

const roots: string[] = [];

afterAll(async () => {
  await Promise.allSettled(roots.map((root) => rm(root, { recursive: true, force: true })));
  await cleanupAllFixtures();
});

runWorkspaceContractSuite(async () => {
  const base = await mkdtemp(join(tmpdir(), "adox-ws-"));
  roots.push(base);
  const managedRootBase = join(base, "managed");
  const storageRoot = join(base, "snapshots");
  await mkdir(managedRootBase, { recursive: true });
  await mkdir(storageRoot, { recursive: true });
  const runtime = await createGitRuntime({ root: join(base, "runtime") });
  return {
    runtime,
    managedRootBase,
    storageRoot,
    async close(): Promise<void> {
      await runtime.dispose();
    },
  };
});
