import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";
import type { InstalledItem } from "@loadout/shared";
import { backupFile, backupDir } from "../backup.js";
import { codexConfigPath } from "../scanners/codex.js";
import { disabledMcpKey, readDisabledMcp, writeDisabledMcp } from "../mcpStore.js";

interface CodexConfig {
  mcp_servers?: Record<string, unknown>;
  skills?: { config?: Array<{ name: string; enabled?: boolean }> };
}

function readConfig(configPath: string): CodexConfig {
  if (!existsSync(configPath)) return {};
  return TOML.parse(readFileSync(configPath, "utf8")) as unknown as CodexConfig;
}

function writeConfig(configPath: string, config: CodexConfig): void {
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, TOML.stringify(config as any));
}

// `item.path` means different things for the two kinds Codex reports (see
// packages/agent/src/scanners/codex.ts):
//   - kind "mcp":   `path` IS the config.toml the server is declared in.
//   - kind "skill": `path` is the skill's own DIRECTORY under ~/.agents/skills/, because
//                   that's where the skill's content actually lives.
// Skill toggles, however, are recorded in ~/.codex/config.toml — so for a skill we must
// resolve the config location independently of `item.path` (reading `item.path` as if it
// were config.toml threw EISDIR on every real scanner-produced skill item). `homeDir` is
// injectable purely so tests can point at a fake home; production always uses os.homedir().
export function resolveConfigPath(item: InstalledItem, homeDir: string = os.homedir()): string {
  return item.kind === "mcp" ? item.path : codexConfigPath(homeDir);
}

export function applyToggle(item: InstalledItem, enabled: boolean, homeDir?: string): void {
  const configPath = resolveConfigPath(item, homeDir);
  if (existsSync(configPath)) backupFile(configPath);
  const config = readConfig(configPath);

  if (item.kind === "mcp") {
    const parked = readDisabledMcp(homeDir ?? os.homedir());
    const key = disabledMcpKey(configPath, item.name);
    const servers = (config.mcp_servers ?? {}) as Record<string, unknown>;

    if (!enabled && servers[item.name] !== undefined) {
      parked[key] = servers[item.name];
      delete servers[item.name];
    } else if (enabled && parked[key] !== undefined) {
      servers[item.name] = parked[key];
      delete parked[key];
    } else {
      return;
    }

    config.mcp_servers = servers;
    writeConfig(configPath, config);
    writeDisabledMcp(homeDir ?? os.homedir(), parked);
    return;
  }

  if (item.kind === "skill") {
    config.skills = config.skills ?? { config: [] };
    config.skills.config = config.skills.config ?? [];
    const entry = config.skills.config.find((s) => s.name === item.name);
    if (entry) entry.enabled = enabled;
    else config.skills.config.push({ name: item.name, enabled });
  }
  writeConfig(configPath, config);
}

export function removeItem(item: InstalledItem, homeDir?: string): void {
  const configPath = resolveConfigPath(item, homeDir);
  const config = readConfig(configPath);

  if (item.kind === "mcp") {
    const resolvedHome = homeDir ?? os.homedir();
    const key = disabledMcpKey(configPath, item.name);
    const parked = readDisabledMcp(resolvedHome);
    const inConfig = (config.mcp_servers ?? {})[item.name] !== undefined;
    const inStore = parked[key] !== undefined;

    // Same guard as applyToggle: with nothing to remove there is nothing to back up or
    // rewrite either. Unconditional writes left a backup per no-op removal and re-emitted
    // config.toml through the TOML serialiser for no change at all.
    if (!inConfig && !inStore) return;

    if (inConfig) {
      if (existsSync(configPath)) backupFile(configPath);
      const servers = config.mcp_servers ?? {};
      delete servers[item.name];
      config.mcp_servers = servers;
      writeConfig(configPath, config);
    }
    // A server removed while it was disabled still has its config parked in the shared
    // store (see the identical reasoning in packages/agent/src/mutators/claudeCode.ts);
    // drop that too, or the next scan reports the item straight back as a disabled row.
    if (inStore) {
      delete parked[key];
      writeDisabledMcp(resolvedHome, parked);
    }
    return;
  }

  if (existsSync(configPath)) backupFile(configPath);
  config.skills = config.skills ?? { config: [] };
  config.skills.config = (config.skills.config ?? []).filter((s) => s.name !== item.name);
  writeConfig(configPath, config);

  // A Codex skill's content is a directory on disk; dropping only its config.toml toggle
  // entry would leave the files in place and the very next scan would report it back as
  // installed (and enabled, since a missing entry defaults to enabled). Remove the
  // directory too — behind a timestamped backup, per the plan's Global Constraint that
  // any on-disk mutation takes a backup first.
  // The backup goes to a sibling of the skills dir, not inside it — a copy left under
  // ~/.agents/skills/ still has a SKILL.md and the next scan would report it as a skill.
  if (item.kind === "skill" && existsSync(item.path)) {
    backupDir(item.path, { destDir: path.join(item.path, "..", "..", ".loadout-backups") });
    rmSync(item.path, { recursive: true, force: true });
  }
}
