# loadout-agent

CLI/daemon that scans and manages Claude Code and Codex skills/MCP servers on one machine.

## Packages

- `loadout-agent` — published CLI (`npm i -g loadout-agent`)
- `@loadout/shared` — zod schemas + row mappers shared with the [loadout](https://github.com/sslinNn/loadout) dashboard

## Develop

```bash
npm ci
npm run build
npm test
```

## Publish

- Agent: push tag `loadout-agent-v*` (see `.github/workflows/publish-agent.yml`)
- Shared: push tag `shared-v*` (see `.github/workflows/publish-shared.yml`)
