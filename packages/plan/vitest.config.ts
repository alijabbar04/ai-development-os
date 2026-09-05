import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The private C8/C7 adapters are themselves test composition; coverage
      // gates the production package graph while their behaviour is exercised
      // separately against both memory and real SQLite.
      exclude: ["src/index.ts", "src/testing/**"],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 95,
        lines: 90
      }
    }
  }
});
