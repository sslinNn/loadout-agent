// Bundles the CLI entrypoint into a single dist/cli.js with @loadout/shared inlined.
// @loadout/shared is a GitHub-pinned build-time package, not an npm runtime dep —
// listing it under dependencies would make `npm i -g loadout-agen` clone git. Keep
// it in devDependencies; esbuild inlines it and every genuine npm package stays external.
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
