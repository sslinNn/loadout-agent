import os from "node:os";
import type { InstalledItem } from "@loadout/shared";
import { fromVendor, mcpFingerprint, type CanonicalMcp } from "../harnesses/canonicalMcp.js";
import { presentAdapters } from "../harnesses/registry.js";
import {
  disabledMcpKey,
  findParkedMcpKey,
  parkedMcpEntry,
  readDisabledMcp,
  writeDisabledMcp
} from "../mcpStore.js";

function serversFor(item: InstalledItem, homeDir: string, adapter: ReturnType<typeof presentAdapters>[number]) {
  return item.scope === "project" && item.projectPath
    ? (adapter.readProjectMcp?.(item.projectPath) ?? {})
    : adapter.readMcp(homeDir);
}

function collectLive(item: InstalledItem, homeDir: string): CanonicalMcp | null {
  const present = presentAdapters(homeDir);
  const preferred = item.harnesses[0];
  const ordered = preferred
    ? [...present.filter((a) => a.id === preferred), ...present.filter((a) => a.id !== preferred)]
    : present;
  for (const adapter of ordered) {
    const entry = serversFor(item, homeDir, adapter)[item.name];
    if (entry) return entry;
  }
  return null;
}

function writeCompatible(item: InstalledItem, homeDir: string, entry: CanonicalMcp): void {
  const fp = mcpFingerprint(entry);
  for (const adapter of presentAdapters(homeDir)) {
    const live = serversFor(item, homeDir, adapter)[item.name];
    if (live && mcpFingerprint(live) !== fp) continue;
    if (item.scope === "project" && item.projectPath) {
      adapter.writeProjectMcpEntry?.(item.projectPath, item.name, entry);
    } else {
      adapter.writeMcpEntry(homeDir, item.name, entry);
    }
  }
}

function removeCompatible(item: InstalledItem, homeDir: string, entry: CanonicalMcp): void {
  const fp = mcpFingerprint(entry);
  for (const adapter of presentAdapters(homeDir)) {
    const live = serversFor(item, homeDir, adapter)[item.name];
    if (!live || mcpFingerprint(live) !== fp) continue;
    if (item.scope === "project" && item.projectPath) {
      adapter.removeProjectMcpEntry?.(item.projectPath, item.name);
    } else {
      adapter.removeMcpEntry(homeDir, item.name);
    }
  }
}

function removeAll(item: InstalledItem, homeDir: string): void {
  for (const adapter of presentAdapters(homeDir)) {
    if (item.scope === "project" && item.projectPath) {
      adapter.removeProjectMcpEntry?.(item.projectPath, item.name);
    } else {
      adapter.removeMcpEntry(homeDir, item.name);
    }
  }
}

export function applyToggle(item: InstalledItem, enabled: boolean, homeDir: string = os.homedir()): void {
  if (item.kind !== "mcp") return;

  const parked = readDisabledMcp(homeDir);
  const key = disabledMcpKey(item.scope, item.name, item.projectPath);

  if (!enabled) {
    const live = collectLive(item, homeDir) ?? parkedMcpEntry(parked, item.scope, item.name, item.projectPath);
    if (!live) return;
    const next = { ...parked };
    const legacy = findParkedMcpKey(parked, item.scope, item.name, item.projectPath);
    if (legacy && legacy !== key) delete next[legacy];
    next[key] = live;
    writeDisabledMcp(homeDir, next);
    removeCompatible(item, homeDir, live);
    return;
  }

  const entry = parkedMcpEntry(parked, item.scope, item.name, item.projectPath) ?? collectLive(item, homeDir);
  if (!entry) return;
  writeCompatible(item, homeDir, entry);
  const next = { ...parked };
  const found = findParkedMcpKey(next, item.scope, item.name, item.projectPath);
  if (found) delete next[found];
  writeDisabledMcp(homeDir, next);
}

export function removeItem(item: InstalledItem, homeDir: string = os.homedir()): void {
  if (item.kind !== "mcp") return;
  removeAll(item, homeDir);
  const parked = readDisabledMcp(homeDir);
  const found = findParkedMcpKey(parked, item.scope, item.name, item.projectPath);
  if (!found) return;
  const next = { ...parked };
  delete next[found];
  writeDisabledMcp(homeDir, next);
}

export function restoreMcpEntry(item: InstalledItem, entry: CanonicalMcp, homeDir: string = os.homedir()): void {
  writeCompatible(item, homeDir, fromVendor(entry));
}
