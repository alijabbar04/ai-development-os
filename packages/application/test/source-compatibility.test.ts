import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("application public source compatibility", () => {
  it("keeps the Stage 18C application interface implementable without admission", () => {
    const compiler = resolve(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "node_modules",
      "typescript",
      "bin",
      "tsc",
    );
    expect(() => execFileSync(process.execPath, [
      compiler,
      "-p",
      resolve(import.meta.dirname, "type-fixtures", "tsconfig.json"),
      "--noEmit",
    ], { stdio: "pipe" })).not.toThrow();
  });
});
