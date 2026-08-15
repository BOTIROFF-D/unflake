import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These tests search hundreds of schedules each, and a shared CI runner is
    // several times slower than a laptop. The default 5s timeout turns that
    // difference into a red build that says nothing about correctness.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
