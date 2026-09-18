import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { InstalledItem } from "@loadout/shared";
import { readDisabledMcp } from "../mcpStore.js";
import { isReadableDirectory } from "./fsSafe.js";

function readSkillName(skillMdPath: string, fallback: string): string {
  const content = readFileSync(skillMdPath, "utf8");
  const match = content.match(/^name:\s*(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function scanSkillsDir(dir: string, scope: "global" | "project", projectPath: string | null): InstalledItem[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => isReadableDirectory(path.join(dir, entry)))
    .flatMap((entry) => {
      const skillMd = path.join(dir, entry, "SKILL.md");
      if (!existsSync(skillMd)) return [];
      const item: InstalledItem = {
        id: `claude_code:skill:${scope}:${path.join(dir, entry)}`,
        machineId: "",
        tool: "claude_code",
        kind: "skill",
        name: readSkillName(skillMd, entry),
        enabled: true,
        path: path.join(dir, entry),
        scope,
        projectPath,
        sourceType: "manual",
        sourceRef: null,
        contentBackupId: null,
        lastSyncedAt: new Date().toISOString()
      };
      return [item];
    });
}

// Task 10's move-aside mutator (packages/agent/src/mutators/claudeCode.ts) disables a
// skill by renaming its directory out of `skillsDir` into a `.loadout-disabled` mirror
// that sits as a sibling of `skillsDir` itself (i.e. <skillsDir>/../.loadout-disabled/<name>).
// Without this, a disabled skill simply vanishes from the next scan instead of showing up
// as disabled — the dashboard must reflect disk-confirmed state, so we scan that mirror
// too and report its entries with `enabled: false`. The reported `path`/`id` still point at
// the canonical (enabled) location under `skillsDir`, not the `.loadout-disabled` location,
// so that `applyToggle`'s re-enable path (and the item's identity across enable/disable
// cycles) keeps working unchanged.
function scanDisabledSkillsDir(skillsDir: string, scope: "global" | "project", projectPath: string | null): InstalledItem[] {
  const disabledDir = path.join(skillsDir, "..", ".loadout-disabled");
  if (!existsSync(disabledDir)) return [];
  return readdirSync(disabledDir)
    .filter((entry) => isReadableDirectory(path.join(disabledDir, entry)))
    .flatMap((entry) => {
      const skillMd = path.join(disabledDir, entry, "SKILL.md");
      if (!existsSync(skillMd)) return [];
      const canonicalPath = path.join(skillsDir, entry);
      const item: InstalledItem = {
        id: `claude_code:skill:${scope}:${canonicalPath}`,
        machineId: "",
        tool: "claude_code",
        kind: "skill",
        name: readSkillName(skillMd, entry),
        enabled: false,
        path: canonicalPath,
        scope,
        projectPath,
        sourceType: "manual",
        sourceRef: null,
        contentBackupId: null,
        lastSyncedAt: new Date().toISOString()
      };
      return [item];
    });
}

/**
 * User-scoped Claude Code MCP servers live in ~/.claude.json's top-level `mcpServers`
 * map — not under ~/.claude/. That file is Claude Code's live state (oauth account,
 * per-project history, caches), so this only ever READS it; see mutators/claudeCode.ts
 * for the write path, which touches nothing but the `mcpServers` key.
 *
 * A parse failure here must not take the whole scan down: a corrupt or half-written
 * ~/.claude.json would otherwise hide every skill on the machine too.
 */
function scanUserMcpServers(homeDir: string): InstalledItem[] {
  const configPath = path.join(homeDir, ".claude.json");

  const parkedOnly = !existsSync(configPath);
  let parsed: { mcpServers?: Record<string, unknown> } = {};
  if (!parkedOnly) {
    try {
      parsed = JSON.parse(readFileSync(configPath, "utf8")) as { mcpServers?: Record<string, unknown> };
    } catch {
      parsed = {};
    }
  }

  const parked = readDisabledMcp(homeDir);
  const parkedNames = Object.keys(parked)
    .filter((k) => k.startsWith(`${configPath}::`))
    .map((k) => k.slice(configPath.length + 2));

  const toItem = (name: string, enabled: boolean): InstalledItem => ({
    id: `claude_code:mcp:global:${configPath}:${name}`,
    machineId: "",
    tool: "claude_code",
    kind: "mcp",
    name,
    enabled,
    path: configPath,
    scope: "global",
    projectPath: null,
    sourceType: "manual",
    sourceRef: null,
    contentBackupId: null,
    lastSyncedAt: new Date().toISOString()
  });

  return [
    ...Object.keys(parsed.mcpServers ?? {}).map((name) => toItem(name, true)),
    ...parkedNames.map((name) => toItem(name, false))
  ];
}

function scanMcpJson(mcpJsonPath: string, scope: "global" | "project", projectPath: string | null): InstalledItem[] {
  if (!existsSync(mcpJsonPath)) return [];
  const parsed = JSON.parse(readFileSync(mcpJsonPath, "utf8")) as { mcpServers?: Record<string, unknown> };
  return Object.keys(parsed.mcpServers ?? {}).map((name) => {
    const item: InstalledItem = {
      id: `claude_code:mcp:${scope}:${mcpJsonPath}:${name}`,
      machineId: "",
      tool: "claude_code",
      kind: "mcp",
      name,
      enabled: true,
      path: mcpJsonPath,
      scope,
      projectPath,
      sourceType: "manual",
      sourceRef: null,
      contentBackupId: null,
      lastSyncedAt: new Date().toISOString()
    };
    return item;
  });
}

export function scanClaudeCode(opts: {
  homeDir: string;
  registeredProjectPaths: string[];
}): InstalledItem[] {
  const globalSkillsDir = path.join(opts.homeDir, ".claude", "skills");
  const global = [
    ...scanSkillsDir(globalSkillsDir, "global", null),
    ...scanDisabledSkillsDir(globalSkillsDir, "global", null),
    ...scanUserMcpServers(opts.homeDir)
  ];
  const project = opts.registeredProjectPaths.flatMap((p) => {
    const projectSkillsDir = path.join(p, ".claude", "skills");
    return [
      ...scanSkillsDir(projectSkillsDir, "project", p),
      ...scanDisabledSkillsDir(projectSkillsDir, "project", p),
      ...scanMcpJson(path.join(p, ".mcp.json"), "project", p)
    ];
  });
  return [...global, ...project];
}
