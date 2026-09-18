import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";
import type { InstalledItem } from "@loadout/shared";
import { readDisabledMcp } from "../mcpStore.js";
import { isReadableDirectory } from "./fsSafe.js";

interface CodexConfig {
  mcp_servers?: Record<string, unknown>;
  skills?: { config?: Array<{ name: string; enabled?: boolean }> };
}

function readConfigToml(configPath: string): CodexConfig {
  if (!existsSync(configPath)) return {};
  return TOML.parse(readFileSync(configPath, "utf8")) as unknown as CodexConfig;
}

function scanSkillsDir(
  dir: string,
  scope: "global" | "project",
  projectPath: string | null,
  toggles: Map<string, boolean>
): InstalledItem[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => isReadableDirectory(path.join(dir, entry)))
    .filter((entry) => existsSync(path.join(dir, entry, "SKILL.md")))
    .map((entry) => ({
      id: `codex:skill:${scope}:${path.join(dir, entry)}`,
      machineId: "",
      tool: "codex" as const,
      kind: "skill" as const,
      name: entry,
      enabled: toggles.get(entry) ?? true,
      path: path.join(dir, entry),
      scope,
      projectPath,
      sourceType: "manual" as const,
      sourceRef: null,
      contentBackupId: null,
      lastSyncedAt: new Date().toISOString()
    }));
}

// Mirrors scanUserMcpServers in packages/agent/src/scanners/claudeCode.ts: a server that is
// currently disabled has its config moved out of config.toml and into loadout's shared
// parked-mcp store (packages/agent/src/mcpStore.ts) by applyToggle, above. Without also
// scanning that store here, a disabled server would simply vanish from the inventory
// instead of showing up as a disabled row. The id/path stay identical whether the server is
// enabled or parked, so re-enabling it from the dashboard resolves to the same item.
function scanMcpServers(
  config: CodexConfig,
  configPath: string,
  scope: "global" | "project",
  projectPath: string | null,
  homeDir: string
): InstalledItem[] {
  const parked = readDisabledMcp(homeDir);
  const parkedNames = Object.keys(parked)
    .filter((k) => k.startsWith(`${configPath}::`))
    .map((k) => k.slice(configPath.length + 2));

  const toItem = (name: string, enabled: boolean): InstalledItem => ({
    id: `codex:mcp:${scope}:${configPath}:${name}`,
    machineId: "",
    tool: "codex" as const,
    kind: "mcp" as const,
    name,
    enabled,
    path: configPath,
    scope,
    projectPath,
    sourceType: "manual" as const,
    sourceRef: null,
    contentBackupId: null,
    lastSyncedAt: new Date().toISOString()
  });

  return [
    ...Object.keys(config.mcp_servers ?? {}).map((name) => toItem(name, true)),
    ...parkedNames.map((name) => toItem(name, false))
  ];
}

// Real, spec-verified Codex layout (docs/superpowers/specs/2026-09-02-loadout-design.md):
// personal skills live in `~/.agents/skills/` (each skill its own directory containing a
// SKILL.md), and MCP servers + skill enable/disable toggles live in `~/.codex/config.toml`
// under `[mcp_servers.<name>]` / `[[skills.config]]`. These two helpers are the single
// source of truth for those locations — packages/agent/src/mutators/codex.ts and
// packages/agent/src/watcher.ts both derive their paths from here rather than
// re-hardcoding them, so the scanner and the mutator can never drift apart.
export function codexConfigPath(homeDir: string): string {
  return path.join(homeDir, ".codex", "config.toml");
}

export function codexGlobalSkillsDir(homeDir: string): string {
  return path.join(homeDir, ".agents", "skills");
}

export function scanCodex(opts: { homeDir: string; registeredProjectPaths: string[] }): InstalledItem[] {
  const globalConfigPath = codexConfigPath(opts.homeDir);
  const globalConfig = readConfigToml(globalConfigPath);
  const globalToggles = new Map((globalConfig.skills?.config ?? []).map((s) => [s.name, s.enabled ?? true]));

  const global = [
    ...scanSkillsDir(codexGlobalSkillsDir(opts.homeDir), "global", null, globalToggles),
    ...scanMcpServers(globalConfig, globalConfigPath, "global", null, opts.homeDir)
  ];

  const project = opts.registeredProjectPaths.flatMap((p) => {
    const projectSkillsToggles = new Map<string, boolean>();
    return [...scanSkillsDir(path.join(p, ".agents", "skills"), "project", p, projectSkillsToggles)];
  });

  return [...global, ...project];
}
