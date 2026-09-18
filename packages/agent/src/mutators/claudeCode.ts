import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InstalledItem } from "@loadout/shared";
import { backupDir, backupFile } from "../backup.js";
import { disabledMcpKey, readDisabledMcp, writeDisabledMcp } from "../mcpStore.js";

function disabledDirFor(itemPath: string): string {
  return path.join(itemPath, "..", "..", ".loadout-disabled");
}

// Sibling of the skills directory (like `.loadout-disabled`), deliberately NOT inside it:
// a backup copy left under `.claude/skills/` still contains a SKILL.md and would be
// re-reported by scanSkillsDir as an installed skill on the very next scan.
function backupsDirFor(itemPath: string): string {
  return path.join(itemPath, "..", "..", ".loadout-backups");
}

// The disabled mirror must be keyed on the skill's actual DIRECTORY name, never on
// `item.name`. `item.name` comes from SKILL.md's frontmatter `name:` (see
// packages/agent/src/scanners/claudeCode.ts's readSkillName), which routinely differs from
// the directory it lives in. Using it here moved a disabled skill to the wrong basename, and
// scanDisabledSkillsDir — which derives identity from the directory entry, as it must —
// then computed a different canonical id/path than the enabled item had, so the skill
// changed identity across a disable and could never be re-enabled from the dashboard.
function disabledPathFor(item: InstalledItem): string {
  return path.join(disabledDirFor(item.path), path.basename(item.path));
}

// ~/.claude.json is Claude Code's live state file (oauth account, per-project history,
// caches) and Claude Code rewrites it on its own schedule outside our control. A plain
// truncate-then-write can race that rewrite and lose the user's entire state file, so we
// serialise to a temp file beside the target (same directory, so the rename can't cross a
// filesystem) and rename it into place — an atomic swap with no truncate window, and no
// temp file left behind on the success path.
function writeJsonAtomic(targetPath: string, contents: string): void {
  const tmpPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.loadout-tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmpPath, contents);
  renameSync(tmpPath, targetPath);
}

/**
 * Move one MCP server between its config file and loadout's parked store.
 *
 * The read-modify-write is deliberately narrow: ~/.claude.json also holds the oauth
 * account, per-project history and caches, and Claude Code rewrites it underneath us.
 * Everything except the `mcpServers` key is passed through untouched.
 */
function toggleMcpEntry(item: InstalledItem, enabled: boolean, homeDir: string): void {
  const configPath = item.path;
  if (!existsSync(configPath)) return;
  backupFile(configPath);

  const config = JSON.parse(readFileSync(configPath, "utf8")) as { mcpServers?: Record<string, unknown> };
  const servers = config.mcpServers ?? {};
  const parked = readDisabledMcp(homeDir);
  const key = disabledMcpKey(configPath, item.name);

  if (!enabled && servers[item.name] !== undefined) {
    parked[key] = servers[item.name];
    delete servers[item.name];
  } else if (enabled && parked[key] !== undefined) {
    servers[item.name] = parked[key];
    delete parked[key];
  } else {
    return;
  }

  config.mcpServers = servers;
  writeJsonAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeDisabledMcp(homeDir, parked);
}

export function applyToggle(item: InstalledItem, enabled: boolean, homeDir: string = os.homedir()): void {
  if (item.kind === "mcp") {
    toggleMcpEntry(item, enabled, homeDir);
    return;
  }
  if (item.kind !== "skill") return;
  const disabledDir = disabledDirFor(item.path);
  mkdirSync(disabledDir, { recursive: true });
  const disabledPath = disabledPathFor(item);
  if (!enabled && existsSync(item.path)) {
    renameSync(item.path, disabledPath);
  } else if (enabled && existsSync(disabledPath)) {
    renameSync(disabledPath, item.path);
  }
}

export function removeItem(item: InstalledItem, homeDir: string = os.homedir()): void {
  if (item.kind === "mcp") {
    const key = disabledMcpKey(item.path, item.name);
    const parked = readDisabledMcp(homeDir);
    const config: { mcpServers?: Record<string, unknown> } = existsSync(item.path)
      ? (JSON.parse(readFileSync(item.path, "utf8")) as { mcpServers?: Record<string, unknown> })
      : {};
    const inConfig = config.mcpServers?.[item.name] !== undefined;
    const inStore = parked[key] !== undefined;

    // Nothing to remove: leave the live state file alone. Rewriting it unconditionally
    // took a fresh backup of a multi-megabyte file, reformatted it, and added an
    // `mcpServers: {}` key that was never there — all to delete something absent.
    // applyToggle guards the same way.
    if (!inConfig && !inStore) return;

    if (inConfig) {
      backupFile(item.path);
      const servers = config.mcpServers ?? {};
      delete servers[item.name];
      config.mcpServers = servers;
      // ~/.claude.json is Claude Code's live state file — every write goes through the same
      // atomic rename used by toggleMcpEntry above, never a bare writeFileSync.
      writeJsonAtomic(item.path, `${JSON.stringify(config, null, 2)}\n`);
    }
    // A server removed while it was disabled still has its config parked in the shared
    // store; drop that too, or the next scan reports the item straight back as a disabled row.
    if (inStore) {
      delete parked[key];
      writeDisabledMcp(homeDir, parked);
    }
    return;
  }
  // Removal is irreversible, so take a timestamped backup of the skill directory first
  // (plan Global Constraint: "the agent applies them to disk (with a timestamped backup
  // first)"). backupDir copies recursively; backupFile/copyFileSync cannot handle a
  // directory, which is why nothing was being backed up here before.
  const destDir = backupsDirFor(item.path);
  if (existsSync(item.path)) {
    backupDir(item.path, { destDir });
    rmSync(item.path, { recursive: true, force: true });
  }
  const disabledPath = disabledPathFor(item);
  if (existsSync(disabledPath)) {
    backupDir(disabledPath, { destDir });
    rmSync(disabledPath, { recursive: true, force: true });
  }
}
