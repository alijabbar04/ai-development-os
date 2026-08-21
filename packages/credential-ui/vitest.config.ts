import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/contracts.ts", "src/errors.ts", "src/projections.ts"],
      reporter: ["text", "html", "lcov"],
      thresholds: { statements: 98, branches: 95, functions: 100, lines: 98 },
    },
  },
});
