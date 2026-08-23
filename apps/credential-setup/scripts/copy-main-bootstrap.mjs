import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const names = ["startup-bootstrap.cjs", "startup-bootstrap-runtime.cjs", "startup-deadline.cjs"];
for (const name of names) {
  const source = join(root, "src", "main", name);
  const target = join(root, "dist", "main", name);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  if (await readFile(source, "utf8") !== await readFile(target, "utf8")) throw new Error("credential-startup-bootstrap-copy-mismatch");
}
