# loadout-agent

CLI/daemon that scans and manages Claude Code and Codex skills/MCP servers on one machine.

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
