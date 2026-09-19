# loadout-agent

CLI/daemon that scans and manages skills (canonical `.agents/skills`) and MCP servers on one machine, then projects them onto detected harnesses (Claude Code, Codex, Cursor, Gemini CLI, Copilot).

Published on npm as **`loadout-agen`** (`npm i -g loadout-agen`). The CLI binaries remain `loadout` / `loadout-agent`.

Contracts (`@loadout/shared`) live in [sslinNn/loadout-shared](https://github.com/sslinNn/loadout-shared).
The web dashboard is [sslinNn/loadout](https://github.com/sslinNn/loadout).

## Develop

```bash
npm ci
npm run build
npm test
```

## Publish

Push tag `loadout-agen-v*` (see `.github/workflows/publish-agent.yml`).

npm Trusted Publisher for package **`loadout-agen`** must point at **this** repository (`sslinNn/loadout-agent`), workflow filename `publish-agent.yml`, Environment empty, and **Allowed actions** must include **`npm publish`** (not only stage — required for publishers created after 2026-09-03).
