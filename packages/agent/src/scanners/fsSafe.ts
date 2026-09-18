import { statSync } from "node:fs";

/**
 * `statSync(p).isDirectory()`, but "no" instead of a throw for anything we cannot stat.
 *
 * `statSync` FOLLOWS symlinks, and a skills directory is very often a directory of symlinks
 * into a checkout elsewhere (`~/.claude/skills/foo -> ~/.agents/skills/foo`). One link whose
 * target has been moved or deleted made `statSync` throw ENOENT out of a `readdirSync(...)
 * .filter(...)`, out of `buildSnapshot`, and out of the `run` action — killing the daemon on
 * startup, every time, because each restart walked straight back into the same broken link.
 * The machine then sat "offline" on the dashboard with no explanation on either side.
 *
 * An entry we cannot stat is an entry we cannot read a SKILL.md out of either, so "not a
 * directory" is the honest answer for every failure here (a dangling link, but equally a
 * permission denial or a race with something deleting the entry mid-scan) — and the scan
 * keeps going and reports every healthy neighbour.
 */
export function isReadableDirectory(entryPath: string): boolean {
  try {
    return statSync(entryPath).isDirectory();
  } catch {
    return false;
  }
}
