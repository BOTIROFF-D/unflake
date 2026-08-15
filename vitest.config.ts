import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The audit suite has its own config and its own CI job — see
    // vitest.audit.config.ts for why it does not run here.
    exclude: ["node_modules/**", "dist/**", "audits/**"],
    // These tests search hundreds of schedules each, and a shared CI runner is
    // several times slower than a laptop. The default 5s timeout turns that
    // difference into a red build that says nothing about correctness.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
