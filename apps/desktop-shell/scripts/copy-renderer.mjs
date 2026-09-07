import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const names = ["index.html", "styles.css"];
for (const name of names) {
  const source = join(root, "src", "renderer", name);
  const target = join(root, "dist", "renderer", name);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  if (await readFile(source, "utf8") !== await readFile(target, "utf8")) throw new Error("desktop-renderer-copy-mismatch");
}
