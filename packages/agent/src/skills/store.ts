import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

export function agentsSkillsDir(root: string): string {
  return path.join(root, ".agents", "skills");
}

export function skillCanonicalDir(opts: {
  homeDir: string;
  scope: "global" | "project";
  projectPath: string | null;
}): string {
  return agentsSkillsDir(opts.scope === "project" ? opts.projectPath! : opts.homeDir);
}

export function skillCanonicalPath(opts: {
  homeDir: string;
  scope: "global" | "project";
  projectPath: string | null;
  name: string;
}): string {
  return path.join(skillCanonicalDir(opts), opts.name);
}

function projectKey(projectPath: string): string {
  return Buffer.from(projectPath).toString("base64url");
}

export function skillParkDir(opts: {
  homeDir: string;
  scope: "global" | "project";
  projectPath: string | null;
  name: string;
}): string {
  const scopeDir =
    opts.scope === "project" && opts.projectPath
      ? path.join(opts.homeDir, ".loadout", "disabled-skills", "project", projectKey(opts.projectPath))
      : path.join(opts.homeDir, ".loadout", "disabled-skills", "global");
  return path.join(scopeDir, opts.name);
}

export function skillParkRoot(homeDir: string): string {
  return path.join(homeDir, ".loadout", "disabled-skills");
}

function chmodOwnerOnlyDir(dir: string): void {
  chmodSync(dir, 0o700);
}

/**
 * Parked skills must not be world-traversable. Directories need the owner execute
 * bit, so this is 0700 rather than the 0600 used for disabled-mcp.json.
 */
function lockParkTree(dest: string): void {
  let current = dest;
  while (true) {
    chmodOwnerOnlyDir(current);
    if (path.basename(current) === "disabled-skills") break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function parkSkill(src: string, dest: string): void {
  if (!existsSync(src)) return;
  mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  renameSync(src, dest);
  lockParkTree(dest);
}

export function restoreParkedSkill(src: string, dest: string): void {
  if (!existsSync(src)) return;
  mkdirSync(path.dirname(dest), { recursive: true });
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  renameSync(src, dest);
}
