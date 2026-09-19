import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { InstalledItem } from "@loadout/shared";
import { adapters, presentAdapters } from "../harnesses/registry.js";
import { isReadableDirectory } from "./fsSafe.js";
import { skillCanonicalDir, skillCanonicalPath, skillParkDir } from "../skills/store.js";

function readSkillName(skillMdPath: string, fallback: string): string {
  try {
    const content = readFileSync(skillMdPath, "utf8");
    const match = content.match(/^name:\s*(.+)$/m);
    return match ? match[1].trim() : fallback;
  } catch {
    return fallback;
  }
}

function hasSkillMd(dir: string): boolean {
  return isReadableDirectory(dir) && existsSync(path.join(dir, "SKILL.md"));
}

function entriesWithSkillMd(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((entry) => hasSkillMd(path.join(dir, entry)));
  } catch {
    return [];
  }
}

function harnessesFor(opts: {
  homeDir: string;
  projectPath: string | null;
  inCanonical: boolean;
  extraHits: string[];
}): string[] {
  const ids = new Set<string>(opts.extraHits);
  if (opts.inCanonical) {
    for (const adapter of presentAdapters(opts.homeDir)) {
      // Claude Code does not read ~/.agents; it only counts when a native extra root has it.
      if (adapter.id === "claude_code") continue;
      ids.add(adapter.id);
    }
  }
  return [...ids].sort();
}

function scanScope(opts: {
  homeDir: string;
  scope: "global" | "project";
  projectPath: string | null;
}): InstalledItem[] {
  const canonicalDir = skillCanonicalDir(opts);
  const names = new Set<string>();
  const extraByName = new Map<string, string[]>();

  for (const entry of entriesWithSkillMd(canonicalDir)) names.add(entry);

  for (const adapter of adapters) {
    for (const root of adapter.extraSkillRoots?.({ homeDir: opts.homeDir, projectPath: opts.projectPath }) ?? []) {
      for (const entry of entriesWithSkillMd(root)) {
        names.add(entry);
        const list = extraByName.get(entry) ?? [];
        if (!list.includes(adapter.id)) list.push(adapter.id);
        extraByName.set(entry, list);
      }
    }
  }

  const parkParent = path.dirname(skillParkDir({ ...opts, name: "_" }));
  for (const entry of entriesWithSkillMd(parkParent)) names.add(entry);

  const items: InstalledItem[] = [];
  for (const name of names) {
    const canonicalPath = skillCanonicalPath({ ...opts, name });
    const parkedPath = skillParkDir({ ...opts, name });
    const inCanonical = hasSkillMd(canonicalPath);
    const inPark = hasSkillMd(parkedPath);
    const extraHits = extraByName.get(name) ?? [];
    if (!inCanonical && !inPark && extraHits.length === 0) continue;

    const sourceDir = inCanonical ? canonicalPath : inPark ? parkedPath : path.join(
      // first extra root that actually has it
      adapters
        .flatMap((adapter) =>
          (adapter.extraSkillRoots?.({ homeDir: opts.homeDir, projectPath: opts.projectPath }) ?? []).map((root) => ({
            id: adapter.id,
            root
          }))
        )
        .find((r) => extraHits.includes(r.id) && hasSkillMd(path.join(r.root, name)))?.root ?? canonicalDir,
      name
    );

    items.push({
      id: `skill:${opts.scope}:${canonicalPath}`,
      machineId: "",
      harnesses: harnessesFor({
        homeDir: opts.homeDir,
        projectPath: opts.projectPath,
        inCanonical,
        extraHits
      }),
      kind: "skill",
      name: readSkillName(path.join(sourceDir, "SKILL.md"), name),
      enabled: !inPark,
      path: canonicalPath,
      scope: opts.scope,
      projectPath: opts.projectPath,
      sourceType: "manual",
      sourceRef: null,
      sourceSubdir: null,
      contentBackupId: null,
      lastSyncedAt: new Date().toISOString()
    });
  }

  return items;
}

export function scanSkills(opts: { homeDir: string; registeredProjectPaths: string[] }): InstalledItem[] {
  return [
    ...scanScope({ homeDir: opts.homeDir, scope: "global", projectPath: null }),
    ...opts.registeredProjectPaths.flatMap((projectPath) =>
      scanScope({ homeDir: opts.homeDir, scope: "project", projectPath })
    )
  ];
}
