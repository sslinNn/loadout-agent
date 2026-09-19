import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InstalledItem } from "@loadout/shared";
import { backupDir } from "../backup.js";
import { presentAdapters } from "../harnesses/registry.js";
import { adoptNativeSkill, projectSkillToPresentHarnesses, removeSkillProjections } from "../skills/project.js";
import {
  parkSkill,
  restoreParkedSkill,
  skillCanonicalDir,
  skillCanonicalPath,
  skillParkDir
} from "../skills/store.js";

function dirName(item: InstalledItem): string {
  return path.basename(item.path);
}

function liveLocations(item: InstalledItem, homeDir: string): string[] {
  const name = dirName(item);
  const canonical = skillCanonicalPath({
    homeDir,
    scope: item.scope,
    projectPath: item.projectPath,
    name
  });
  const extras = presentAdapters(homeDir).flatMap(
    (adapter) =>
      adapter.extraSkillRoots?.({ homeDir, projectPath: item.projectPath })?.map((root) => path.join(root, name)) ?? []
  );
  return [canonical, ...extras].filter((p, i, all) => all.indexOf(p) === i && existsSync(p));
}

function backupsDir(item: InstalledItem): string {
  return path.join(item.path, "..", "..", ".loadout-backups");
}

function isRealDirectory(p: string): boolean {
  try {
    const st = lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

export function applyToggle(item: InstalledItem, enabled: boolean, homeDir: string = os.homedir()): void {
  if (item.kind !== "skill") return;
  const name = dirName(item);
  const canonical = skillCanonicalPath({
    homeDir,
    scope: item.scope,
    projectPath: item.projectPath,
    name
  });
  const parked = skillParkDir({
    homeDir,
    scope: item.scope,
    projectPath: item.projectPath,
    name
  });

  if (!enabled) {
    const live = liveLocations(item, homeDir);
    const source = live.find((p) => p === canonical) ?? live[0];
    if (source) parkSkill(source, parked);
    removeSkillProjections({ homeDir, canonicalPath: canonical, projectPath: item.projectPath });
    for (const leftover of liveLocations(item, homeDir)) {
      if (leftover === parked) continue;
      if (isRealDirectory(leftover)) {
        backupDir(leftover, { destDir: path.join(path.dirname(leftover), "..", ".loadout-backups") });
      }
      rmSync(leftover, { recursive: true, force: true });
    }
    return;
  }

  if (existsSync(parked)) {
    mkdirSync(skillCanonicalDir({ homeDir, scope: item.scope, projectPath: item.projectPath }), { recursive: true });
    restoreParkedSkill(parked, canonical);
  }
  if (!existsSync(canonical)) {
    const native = liveLocations(item, homeDir).find((p) => p !== canonical);
    if (native) adoptNativeSkill(native, canonical);
  }
  if (existsSync(canonical)) {
    projectSkillToPresentHarnesses({ homeDir, canonicalPath: canonical, projectPath: item.projectPath });
  }
}

export function removeItem(item: InstalledItem, homeDir: string = os.homedir()): void {
  if (item.kind !== "skill") return;
  const destDir = backupsDir(item);
  const name = dirName(item);
  const canonical = skillCanonicalPath({
    homeDir,
    scope: item.scope,
    projectPath: item.projectPath,
    name
  });
  const parked = skillParkDir({
    homeDir,
    scope: item.scope,
    projectPath: item.projectPath,
    name
  });

  const toRemove = [...liveLocations(item, homeDir), parked].filter((p, i, all) => all.indexOf(p) === i);
  for (const dir of toRemove) {
    if (!existsSync(dir)) continue;
    backupDir(dir, { destDir });
    rmSync(dir, { recursive: true, force: true });
  }
  removeSkillProjections({ homeDir, canonicalPath: canonical, projectPath: item.projectPath });
}
