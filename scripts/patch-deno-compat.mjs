/**
 * postinstall: fix Deno CJS sub-path resolution.
 *
 * Deno's CJS resolver can't follow sub-directory package.json files
 * whose "main" field uses a relative path ("../dist/..."). This is a
 * known limitation — see https://github.com/denoland/deno/issues/27702
 *
 * The affected package (react-remove-scroll-bar/constants) is a
 * transitive dependency of Radix UI. We copy the target file into the
 * sub-directory so Deno can find it with a simple "./index.js" main.
 *
 * This runs automatically via "npm install" (postinstall hook).
 */
import { existsSync, copyFileSync, writeFileSync } from "node:fs";

const dir = "node_modules/react-remove-scroll-bar/constants";
const src = "node_modules/react-remove-scroll-bar/dist/es5/constants.js";

if (existsSync(dir) && existsSync(src)) {
  copyFileSync(src, `${dir}/index.js`);
  writeFileSync(
    `${dir}/package.json`,
    JSON.stringify({ main: "./index.js" }, null, 2) + "\n",
  );
  console.log("postinstall: patched react-remove-scroll-bar/constants for Deno");
}
