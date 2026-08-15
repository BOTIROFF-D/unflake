import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  // Node (and Bun, and Deno) rather than neutral: the scheduler needs
  // node:async_hooks to attribute work to the task that caused it. A test
  // simulator has no reason to run in a browser, so this costs nothing.
  platform: "node",
});
