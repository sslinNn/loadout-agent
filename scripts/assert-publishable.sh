#!/usr/bin/env bash
# The tarball a user gets from `npm i -g loadout-agent` must resolve without
# a sibling checkout or a git clone of loadout-shared.
set -euo pipefail
cd "$(dirname "$0")/.."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

tgz=$(npm pack -w loadout-agent --pack-destination "$tmp" --silent | tail -n1)
tar -xOf "$tmp/$tgz" package/package.json > "$tmp/pkg.json"
tar -xOf "$tmp/$tgz" package/dist/cli.js > "$tmp/cli.js"

PKG_JSON="$tmp/pkg.json" node --input-type=module <<'JS'
import { readFileSync } from "node:fs";
const p = JSON.parse(readFileSync(process.env.PKG_JSON, "utf8"));
if (p.name !== "loadout-agent") {
  console.error(`expected package name loadout-agent, got: ${p.name}`);
  process.exit(1);
}
for (const [name, spec] of Object.entries(p.dependencies ?? {})) {
  if (/^(file:|github:|git\+)/.test(String(spec))) {
    console.error(`runtime dependency ${name} is ${spec}; npm i -g would need git`);
    process.exit(1);
  }
}
const pin = p.devDependencies?.["@loadout/shared"] ?? "";
if (!/^github:sslinNn\/loadout-shared#[0-9a-f]{40}$/.test(pin)) {
  console.error("@loadout/shared must be a github: SHA pin under devDependencies, got:", pin);
  process.exit(1);
}
JS

for needle in claude_code cursor gemini_cli copilot presentHarnesses; do
  grep -q "$needle" "$tmp/cli.js" || { echo "dist/cli.js missing $needle"; exit 1; }
done

echo "publishable: $tgz"
