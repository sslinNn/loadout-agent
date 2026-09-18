// Bundles the CLI entrypoint into a single dist/cli.js with @loadout/shared inlined.
// @loadout/shared is a workspace-only package (never published to npm) — a plain
// "dependencies" entry would leave a real `npm i -g loadout-agent` unable to resolve it, so
// its source is bundled in directly and every genuinely-external npm package stays external.
import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: [
    "commander",
    "chokidar",
    "jsonc-parser",
    "@iarna/toml",
    "node-notifier",
    "@supabase/supabase-js",
    "zod"
  ]
});
