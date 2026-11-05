// Bundles the main process, preload, engine and org server into out/.
import { build } from "esbuild";
import { chmodSync, existsSync } from "node:fs";

// node-pty's helper arrives without its execute bit, and every terminal fails without it.
for (const arch of ["darwin-arm64", "darwin-x64"]) {
  const helper = `node_modules/node-pty/prebuilds/${arch}/spawn-helper`;
  if (existsSync(helper)) chmodSync(helper, 0o755);
}

const shim = "const __import_meta_url = require('url').pathToFileURL(__filename).href;";
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: "linked",
  logLevel: "warning",
  nodePaths: ["node_modules"],
  define: { "import.meta.url": "__import_meta_url" },
  banner: { js: shim },
};

await Promise.all([
  build({ ...common, entryPoints: ["src/main/index.ts"], outfile: "out/main.cjs", external: ["electron"] }),
  // The preload runs sandboxed, with no node modules, so it takes no import.meta shim.
  build({ ...common, banner: {}, define: {}, entryPoints: ["src/main/preload.ts"], outfile: "out/preload.cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["src/engine/index.ts"], outfile: "out/engine.cjs", external: ["electron", "node-pty"] }),
  build({ ...common, entryPoints: ["../src/mcp/collab-index.ts"], outfile: "out/collab.cjs" }),
]);
