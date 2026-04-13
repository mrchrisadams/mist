import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Compute coverage thresholds that ramp linearly from start to target
 * between Feb 2026 and Dec 2026. Before the start date, uses the start
 * values. After the end date, uses the target values.
 */
function coverageThresholds() {
  const start = new Date("2026-02-01");
  const end = new Date("2026-12-31");
  const now = new Date();

  const targets = {
    lines: { start: 0, end: 80 },
    branches: { start: 0, end: 75 },
    functions: { start: 0, end: 80 },
    statements: { start: 0, end: 80 },
  };

  const elapsed = now.getTime() - start.getTime();
  const total = end.getTime() - start.getTime();
  const progress = Math.max(0, Math.min(1, elapsed / total));

  return Object.fromEntries(
    Object.entries(targets).map(([key, { start: s, end: e }]) => [
      key,
      Math.floor(s + (e - s) * progress),
    ]),
  );
}

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      "~": resolve(__dirname, "app"),
      // Workaround: Deno's CJS resolver doesn't follow sub-directory
      // package.json "main" fields correctly for react-remove-scroll-bar/constants
      "react-remove-scroll-bar/constants": resolve(
        __dirname,
        "node_modules/react-remove-scroll-bar/dist/es5/constants.js",
      ),
    },
  },
  test: {
    globals: true,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["tests/evals/**"],
    coverage: {
      provider: "v8",
      include: ["app/**/*.ts", "app/**/*.tsx", "server/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts"],
      thresholds: coverageThresholds(),
    },
  },
});
