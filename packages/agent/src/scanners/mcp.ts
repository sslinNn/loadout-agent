import type { InstalledItem } from "@loadout/shared";
import { mcpFingerprint, type CanonicalMcp } from "../harnesses/canonicalMcp.js";
import { adapters, presentAdapters } from "../harnesses/registry.js";
import { findParkedMcpKey, parkedMcpEntry, readDisabledMcp } from "../mcpStore.js";

function mcpId(scope: "global" | "project", name: string, projectPath: string | null, harness?: string): string {
  const base = scope === "project" && projectPath ? `mcp:project:${projectPath}:${name}` : `mcp:${scope}:${name}`;
  return harness ? `${base}:${harness}` : base;
}

function toItem(opts: {
  name: string;
  scope: "global" | "project";
  projectPath: string | null;
  harnesses: string[];
  enabled: boolean;
  path: string;
  harnessSuffix?: string;
}): InstalledItem {
  return {
    id: mcpId(opts.scope, opts.name, opts.projectPath, opts.harnessSuffix),
    machineId: "",
    harnesses: opts.harnesses,
    kind: "mcp",
    name: opts.name,
    enabled: opts.enabled,
    path: opts.path,
    scope: opts.scope,
    projectPath: opts.projectPath,
    sourceType: "manual",
    sourceRef: null,
    sourceSubdir: null,
    contentBackupId: null,
    lastSyncedAt: new Date().toISOString()
  };
}

function unionScope(opts: {
  homeDir: string;
  scope: "global" | "project";
  projectPath: string | null;
}): InstalledItem[] {
  const present = presentAdapters(opts.homeDir);
  const observed = new Map<string, Array<{ harness: string; entry: CanonicalMcp }>>();

  const readers = opts.scope === "project" ? adapters : present;
  for (const adapter of readers) {
    const servers =
      opts.scope === "project"
        ? (adapter.readProjectMcp?.(opts.projectPath!) ?? {})
        : adapter.readMcp(opts.homeDir);
    for (const [name, entry] of Object.entries(servers)) {
      const list = observed.get(name) ?? [];
      list.push({ harness: adapter.id, entry });
      observed.set(name, list);
    }
  }

  const parked = readDisabledMcp(opts.homeDir);
  const items: InstalledItem[] = [];
  const seenParked = new Set<string>();
  const disabledNames = new Set<string>();

  for (const [name, hits] of observed) {
    const fingerprints = new Set(hits.map((h) => mcpFingerprint(h.entry)));
    const pathHint = disabledPathHint(opts.homeDir, opts.scope, name, opts.projectPath);
    if (fingerprints.size <= 1) {
      items.push(
        toItem({
          name,
          scope: opts.scope,
          projectPath: opts.projectPath,
          harnesses: hits.map((h) => h.harness).sort(),
          enabled: true,
          path: pathHint
        })
      );
    } else {
      // Same name, different command/url: do not merge. One row per harness.
      for (const hit of hits) {
        items.push(
          toItem({
            name,
            scope: opts.scope,
            projectPath: opts.projectPath,
            harnesses: [hit.harness],
            enabled: true,
            path: pathHint,
            harnessSuffix: hit.harness
          })
        );
      }
    }
    const parkKey = findParkedMcpKey(parked, opts.scope, name, opts.projectPath);
    if (parkKey) seenParked.add(parkKey);
  }

  for (const key of Object.keys(parked)) {
    const parsed = parseParkKey(key);
    if (!parsed) continue;
    if (parsed.scope !== opts.scope) continue;
    if (opts.scope === "project" && parsed.projectPath !== opts.projectPath) continue;
    if (seenParked.has(key)) continue;
    if (observed.has(parsed.name) || disabledNames.has(parsed.name)) continue;
    const entry = parkedMcpEntry(parked, parsed.scope, parsed.name, parsed.projectPath);
    if (!entry) continue;
    disabledNames.add(parsed.name);
    items.push(
      toItem({
        name: parsed.name,
        scope: parsed.scope,
        projectPath: parsed.projectPath,
        harnesses: [],
        enabled: false,
        path: disabledPathHint(opts.homeDir, parsed.scope, parsed.name, parsed.projectPath)
      })
    );
  }

  return items;
}

function parseParkKey(key: string): { scope: "global" | "project"; name: string; projectPath: string | null } | null {
  if (key.startsWith("global::")) {
    return { scope: "global", name: key.slice("global::".length), projectPath: null };
  }
  if (key.startsWith("project::")) {
    const rest = key.slice("project::".length);
    const sep = rest.lastIndexOf("::");
    if (sep <= 0) return null;
    return { scope: "project", name: rest.slice(sep + 2), projectPath: rest.slice(0, sep) };
  }
  // Legacy `<configPath>::<name>`
  const sep = key.lastIndexOf("::");
  if (sep <= 0) return null;
  return { scope: "global", name: key.slice(sep + 2), projectPath: null };
}

function disabledPathHint(
  homeDir: string,
  scope: "global" | "project",
  name: string,
  projectPath: string | null
): string {
  return scope === "project" && projectPath ? `project::${projectPath}::${name}` : `global::${name}`;
}

export function scanMcp(opts: { homeDir: string; registeredProjectPaths: string[] }): InstalledItem[] {
  return [
    ...unionScope({ homeDir: opts.homeDir, scope: "global", projectPath: null }),
    ...opts.registeredProjectPaths.flatMap((projectPath) =>
      unionScope({ homeDir: opts.homeDir, scope: "project", projectPath })
    )
  ];
}
