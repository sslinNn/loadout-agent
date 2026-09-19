# loadout-agent

CLI/daemon that scans and manages skills (canonical `.agents/skills`) and MCP servers on one machine, then projects them onto detected harnesses (Claude Code, Codex, Cursor, Gemini CLI, Copilot).

Contracts (`@loadout/shared`) live in [sslinNn/loadout-shared](https://github.com/sslinNn/loadout-shared).
The web dashboard is [sslinNn/loadout](https://github.com/sslinNn/loadout).

## Develop

```bash
npm ci
npm run build
npm test
```

## Publish

Push tag `loadout-agent-v*` (see `.github/workflows/publish-agent.yml`).

npm Trusted Publisher for this package must point at **this** repository (not the old monorepo).
