import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist", "browser");
await mkdir(output, { recursive: true });
await Promise.all([
  cp(join(root, "src", "browser", "index.html"), join(output, "index.html")),
  cp(join(root, "src", "browser", "entry.css"), join(output, "entry.css")),
]);
