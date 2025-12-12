import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
      reporter: ["text", "html", "clover", "json"],
      thresholds: {
        statements: 85,
        branches: 80,
        functions: 85,
        lines: 85,
        perFile: true,
      },
    },
  },
});
