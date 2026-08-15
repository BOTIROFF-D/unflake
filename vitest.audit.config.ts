import { defineConfig } from "vitest/config";

/**
 * The audit suite runs unflake against seven third-party packages. It is kept
 * out of `npm test` deliberately: a red build should mean unflake is broken,
 * not that somebody else shipped a release this morning.
 */
export default defineConfig({
  // The audit imports "unflake" by name rather than by relative path, so the
  // suite reads exactly like the code a user would write against the
  // published package — which is the whole point of auditing with it.
  resolve: {
    alias: { unflake: new URL("./src/index.ts", import.meta.url).pathname },
  },
  test: {
    include: ["audits/**/*.test.js"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
