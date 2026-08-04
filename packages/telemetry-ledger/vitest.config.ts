import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/types.ts", "src/testing/**"],
      reporter: ["text", "html", "lcov"],
      thresholds: { statements: 90, branches: 80, functions: 98, lines: 90 },
    },
  },
});
