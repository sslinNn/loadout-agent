import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";
import { backupFile } from "../backup.js";
import * as log from "../log.js";
import { fromVendor, toCommandShape, type CanonicalMcp } from "./canonicalMcp.js";
import type { HarnessAdapter } from "./types.js";

export function codexConfigPath(homeDir: string): string {
  return path.join(homeDir, ".codex", "config.toml");
}

export function codexGlobalSkillsDir(homeDir: string): string {
  return path.join(homeDir, ".agents", "skills");
}

function readLiveConfig(configPath: string): { status: "missing" | "ok"; value: Record<string, unknown> } | { status: "invalid" } {
  if (!existsSync(configPath)) return { status: "missing", value: {} };
  const text = readFileSync(configPath, "utf8");
  if (text.trim() === "") return { status: "ok", value: {} };
  try {
    return { status: "ok", value: TOML.parse(text) as unknown as Record<string, unknown> };
  } catch {
    return { status: "invalid" };
  }
}

function writeConfigAtomic(configPath: string, config: Record<string, unknown>): void {
  mkdirSync(path.dirname(configPath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.loadout-tmp-${process.pid}-${Date.now()}`
  );
  writeFileSync(tmpPath, TOML.stringify(config as TOML.JsonMap));
  renameSync(tmpPath, configPath);
}

function serversOf(config: Record<string, unknown>): Record<string, unknown> {
  const raw = config.mcp_servers;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function toCodexShape(entry: CanonicalMcp): Record<string, unknown> {
  if (entry.url) {
    const out: Record<string, unknown> = { url: entry.url };
    if (entry.headers) out.http_headers = entry.headers;
    return out;
  }
  return toCommandShape(entry);
}

function mutateServer(homeDir: string, name: string, entry: CanonicalMcp | null): void {
  if (!codexAdapter.isPresent(homeDir)) return;
  const configPath = codexConfigPath(homeDir);
  const live = readLiveConfig(configPath);
  if (live.status === "invalid") {
    log.error(`refusing to write ${configPath}: file exists but is not valid TOML`);
    return;
  }
  const config = live.value;
  const servers = serversOf(config);
  if (entry === null) {
    if (servers[name] === undefined) return;
    if (existsSync(configPath)) backupFile(configPath);
    delete servers[name];
  } else {
    if (existsSync(configPath)) backupFile(configPath);
    servers[name] = toCodexShape(entry);
  }
  config.mcp_servers = servers;
  writeConfigAtomic(configPath, config);
}

export const codexAdapter: HarnessAdapter = {
  id: "codex",

  isPresent(homeDir: string): boolean {
    return existsSync(path.join(homeDir, ".codex"));
  },

  watchPaths(opts: { homeDir: string; projectPaths: string[] }): string[] {
    return [codexConfigPath(opts.homeDir), codexGlobalSkillsDir(opts.homeDir)];
  },

  readMcp(homeDir: string): Record<string, CanonicalMcp> {
    const live = readLiveConfig(codexConfigPath(homeDir));
    const servers = live.status === "invalid" ? {} : serversOf(live.value);
    return Object.fromEntries(Object.entries(servers).map(([name, raw]) => [name, fromVendor(raw)]));
  },

  writeMcpEntry(homeDir: string, name: string, entry: CanonicalMcp): void {
    mutateServer(homeDir, name, entry);
  },

  removeMcpEntry(homeDir: string, name: string): void {
    mutateServer(homeDir, name, null);
  }
};
