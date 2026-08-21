import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "..", "..", "packages", "credential-ui", "dist", "browser");
const target = join(root, "dist", "renderer", "credential");
await mkdir(target, { recursive: true });
const allowed = new Set(["index.html", "entry.js", "entry.css"]);
for (const name of await readdir(source)) {
  if (allowed.has(name)) await cp(join(source, name), join(target, name));
}
const output = await readdir(target);
if (output.length !== allowed.size || output.some((name) => !allowed.has(name))) {
  throw new Error("credential-renderer-allowlist-mismatch");
}
