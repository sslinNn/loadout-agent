import { readFileSync } from "node:fs";

/**
 * Reads `version` out of `package.json` so the CLI's `--version` can never drift from what
 * actually got published — the previous `.version("0.0.1")` literal in cli.ts had already
 * fallen behind the real package.json version once.
 *
 * Defaults to this package's own package.json, resolved relative to *this* module's own
 * location. That relative path (`../package.json`) is correct whether this file is running
 * as plain TS from `src/` or bundled into `dist/cli.js` by esbuild — both sit exactly one
 * directory below `packages/agent`, and esbuild's single-file bundle means every module's
 * `import.meta.url` resolves to that one output file's location either way.
 */
export function readPackageVersion(url: URL = new URL("../package.json", import.meta.url)): string {
  const pkg = JSON.parse(readFileSync(url, "utf8")) as { version: string };
  return pkg.version;
}
