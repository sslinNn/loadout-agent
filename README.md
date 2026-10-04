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

## Commands worth knowing

| Command | What it does |
| --- | --- |
| `loadout pair` | Prints a one-time code (and the machine's hostname/OS, which the dashboard shows before you confirm). |
| `loadout run` / `loadout service install` | The daemon: scans, watches, and carries out dashboard commands — live broadcasts and the `machine_commands` queue (commands queued while the machine was offline run when it comes back). |
| `loadout pending` | What is waiting for your approval. |
| `loadout approve [id]` / `loadout deny [id]` | Answer it; with no id, acts on the single pending action. |
| `loadout trust <minutes>` | One approval covers follow-up actions for that long. |
| `loadout confirm-installs off <minutes>` / `on` | Suspend confirmations for a bounded window (max 8 hours); `loadout service status` shows how long is left. |
| `loadout install <git-url> [subdir] [--commit <sha>]` | Install a skill by hand, optionally at an exact commit. |

## Compatibility

0.2.0 needs the dashboard migrations `20261003120000`–`20261003140000` (pairing identity,
`installed_items.source_commit`, `machine_commands`). Against an older deployment pairing
falls back to the old call, but installs fail to record their commit — apply the
migrations first.

### 0.3.0: machine-scoped credentials

Pairing (and the first `loadout run` after upgrading) registers the agent's session against
its machine (`register_machine_session`, dashboard migration `20261004120000`). Once the
project's custom access token hook is enabled, the agent's tokens carry `machine_id` and can
only act on this machine's rows; forgetting the machine in the dashboard revokes them.
Without the hook nothing changes.
