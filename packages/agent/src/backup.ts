import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import path from "node:path";

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function backupFile(filePath: string): string {
  const backupPath = `${filePath}.loadout-backup-${stamp()}`;
  copyFileSync(filePath, backupPath);
  return backupPath;
}

// Skills are DIRECTORIES on disk for both supported tools (a folder containing SKILL.md),
// so copyFileSync cannot back one up — but the plan's Global Constraint ("the agent applies
// them to disk with a timestamped backup first") covers directory removals and move-asides
// just as much as config-file edits. Hence this recursive variant.
//
// `destDir` matters more than it looks: a skill directory's default sibling backup would
// land *inside* the very skills directory the scanners walk, and (since the copy still
// contains a SKILL.md) the next scan would report the backup itself as a newly installed
// skill. Callers that back up something inside a scanned tree must pass a destDir outside
// it — see packages/agent/src/mutators/claudeCode.ts.
export function backupDir(dirPath: string, opts: { destDir?: string } = {}): string {
  const name = `${path.basename(dirPath)}.loadout-backup-${stamp()}`;
  const backupPath = opts.destDir ? path.join(opts.destDir, name) : path.join(dirPath, "..", name);
  mkdirSync(path.dirname(backupPath), { recursive: true });
  cpSync(dirPath, backupPath, { recursive: true });
  return backupPath;
}

export function restoreFromBackup(backupPath: string, originalPath: string): void {
  copyFileSync(backupPath, originalPath);
}
