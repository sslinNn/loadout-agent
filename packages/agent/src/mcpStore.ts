import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fromVendor, type CanonicalMcp } from "./harnesses/canonicalMcp.js";

/**
 * Where a disabled MCP server's config is parked while it is off.
 *
 * Skills are disabled by moving the directory into a loadout-owned park; an MCP server has
 * no directory, so its canonical config object is moved here instead. It lives under
 * ~/.loadout/ — beside config.json and credentials.json — rather than as an extra key in
 * the vendor's own config.
 *
 * Keys are `global::<name>` or `project::<projectPath>::<name>`. Older stores used
 * `<configPath>::<name>`; readers still honour those so a parked server is not lost
 * across the key change.
 */
export function disabledMcpPath(homeDir: string): string {
  return path.join(homeDir, ".loadout", "disabled-mcp.json");
}

export function disabledMcpKey(scope: "global" | "project", name: string, projectPath?: string | null): string {
  if (scope === "project" && projectPath) return `project::${projectPath}::${name}`;
  return `global::${name}`;
}

/** @deprecated path-based key used before union parking. */
export function legacyDisabledMcpKey(configPath: string, name: string): string {
  return `${configPath}::${name}`;
}

export function readDisabledMcp(homeDir: string): Record<string, unknown> {
  const storePath = disabledMcpPath(homeDir);
  if (!existsSync(storePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function writeDisabledMcp(homeDir: string, entries: Record<string, unknown>): void {
  const storePath = disabledMcpPath(homeDir);
  mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
  writeFileSync(storePath, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  // mode on writeFileSync applies only when the file is created. A later park must
  // still be owner-only — MCP env/headers live in this file.
  chmodSync(storePath, 0o600);
}

export function findParkedMcpKey(
  parked: Record<string, unknown>,
  scope: "global" | "project",
  name: string,
  projectPath?: string | null
): string | null {
  const modern = disabledMcpKey(scope, name, projectPath);
  if (Object.prototype.hasOwnProperty.call(parked, modern)) return modern;
  const suffix = `::${name}`;
  return Object.keys(parked).find((key) => key.endsWith(suffix)) ?? null;
}

export function parkedMcpEntry(
  parked: Record<string, unknown>,
  scope: "global" | "project",
  name: string,
  projectPath?: string | null
): CanonicalMcp | null {
  const key = findParkedMcpKey(parked, scope, name, projectPath);
  if (!key) return null;
  const canonical = fromVendor(parked[key]);
  return canonical.command || canonical.url ? canonical : (parked[key] as CanonicalMcp);
}
