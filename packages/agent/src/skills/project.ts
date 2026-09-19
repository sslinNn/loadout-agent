import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { backupDir } from "../backup.js";
import { extraSkillRoots, presentAdapters } from "../harnesses/registry.js";

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function isRealDirectory(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

function alreadyProjected(dest: string, canonicalPath: string): boolean {
  try {
    return lstatSync(dest).isSymbolicLink() && realpathSync(dest) === realpathSync(canonicalPath);
  } catch {
    return false;
  }
}

/**
 * Project a canonical skill directory into one native root.
 * Prefer a symlink; copy when the platform refuses (Windows without privilege, etc.).
 *
 * A real native directory is user content, not a previous projection. Never delete it
 * to make room for marketplace canonical files — backup is not a license to clobber.
 */
export function projectSkill(
  canonicalPath: string,
  destParent: string,
  link: (target: string, path: string) => void = symlinkSync
): void {
  const dest = path.join(destParent, path.basename(canonicalPath));
  if (!existsSync(canonicalPath)) return;
  if (path.resolve(dest) === path.resolve(canonicalPath)) return;

  mkdirSync(destParent, { recursive: true });

  if (existsSync(dest) || isSymlink(dest)) {
    if (alreadyProjected(dest, canonicalPath)) return;
    if (isRealDirectory(dest)) return;
    rmSync(dest, { recursive: true, force: true });
  }

  try {
    link(canonicalPath, dest);
  } catch {
    cpSync(canonicalPath, dest, { recursive: true });
  }
}

/**
 * Native-only skill: the directory under a vendor root is the only copy. Move it to
 * the canonical Agent Skills path, then project a link back. Backup first so a failed
 * rename cannot vanish the user's files.
 */
export function adoptNativeSkill(nativePath: string, canonicalPath: string): void {
  if (!existsSync(nativePath)) return;
  if (path.resolve(nativePath) === path.resolve(canonicalPath)) return;
  if (existsSync(canonicalPath)) return;

  backupDir(nativePath, { destDir: path.join(path.dirname(nativePath), "..", ".loadout-backups") });
  mkdirSync(path.dirname(canonicalPath), { recursive: true });
  renameSync(nativePath, canonicalPath);
  projectSkill(canonicalPath, path.dirname(nativePath));
}

export function removeProjection(canonicalPath: string, destParent: string): void {
  const dest = path.join(destParent, path.basename(canonicalPath));
  if (path.resolve(dest) === path.resolve(canonicalPath)) return;
  if (!existsSync(dest) && !isSymlink(dest)) return;
  // A real native directory is user content. Unlink projections (symlinks) only;
  // callers that must hide a native copy backup it first.
  if (isRealDirectory(dest)) return;
  rmSync(dest, { recursive: true, force: true });
}

export function projectSkillToPresentHarnesses(opts: {
  homeDir: string;
  canonicalPath: string;
  projectPath?: string | null;
}): void {
  const roots = extraSkillRoots({
    homeDir: opts.homeDir,
    projectPath: opts.projectPath ?? null
  });
  for (const root of roots) projectSkill(opts.canonicalPath, root);
}

export function removeSkillProjections(opts: {
  homeDir: string;
  canonicalPath: string;
  projectPath?: string | null;
}): void {
  const roots = extraSkillRoots({
    homeDir: opts.homeDir,
    projectPath: opts.projectPath ?? null
  });
  for (const root of roots) removeProjection(opts.canonicalPath, root);
}

export function presentHarnessIds(homeDir: string): string[] {
  return presentAdapters(homeDir).map((adapter) => adapter.id);
}
