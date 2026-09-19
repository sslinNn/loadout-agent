import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { backupFile } from "../backup.js";
import * as log from "../log.js";
import { fromVendor, toNativeJson, type CanonicalMcp } from "./canonicalMcp.js";
import { readLiveJson, writeJsonAtomic } from "./jsonFile.js";

function asMap(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function readMcpMap(filePath: string, key: "mcpServers" | "servers"): Record<string, CanonicalMcp> {
  return readMcpMapUnion(filePath, [key]);
}

/** Union of several vendor keys in one file (Copilot `servers` + leftover `mcpServers`). */
export function readMcpMapUnion(
  filePath: string,
  keys: Array<"mcpServers" | "servers">
): Record<string, CanonicalMcp> {
  const live = readLiveJson(filePath);
  if (live.status === "invalid") return {};
  const out: Record<string, CanonicalMcp> = {};
  for (const key of keys) {
    const raw = asMap(live.value[key]);
    for (const [name, entry] of Object.entries(raw)) {
      out[name] = fromVendor(entry);
    }
  }
  return out;
}

/**
 * Mutate one named server in a JSON MCP file, leaving every other key untouched.
 * No-ops when the file's parent directory does not exist — that harness is not present.
 * Refuses to write when the live file exists and is not valid JSON: a backup of the
 * corrupt bytes does not justify replacing them with `{}`.
 */
export function writeMcpMapEntry(
  filePath: string,
  key: "mcpServers" | "servers",
  name: string,
  entry: CanonicalMcp | null,
  opts: { typeHttp?: boolean; urlKey?: "url" | "httpUrl" } = {}
): void {
  const parent = path.dirname(filePath);
  if (!existsSync(parent)) return;

  const live = readLiveJson(filePath);
  if (live.status === "invalid") {
    log.error(`refusing to write ${filePath}: file exists but is not valid JSON`);
    return;
  }

  const parsed = live.value;
  const servers = asMap(parsed[key]);
  if (entry === null) {
    if (servers[name] === undefined) return;
    if (existsSync(filePath)) backupFile(filePath);
    delete servers[name];
  } else {
    if (existsSync(filePath)) backupFile(filePath);
    servers[name] = toNativeJson(entry, opts);
  }
  parsed[key] = servers;
  mkdirSync(parent, { recursive: true });
  writeJsonAtomic(filePath, parsed);
}
