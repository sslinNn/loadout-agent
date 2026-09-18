import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Where a disabled MCP server's config is parked while it is off.
 *
 * Skills are disabled by moving the directory into a `.loadout-disabled` sibling; an MCP
 * server has no directory, so its config object is moved here instead. It lives under
 * ~/.loadout/ — beside config.json and credentials.json — rather than as an extra key in
 * the vendor's own config, so nothing loadout invented ever ends up in a file another
 * program owns and rewrites on its own schedule.
 *
 * Keys are `<configPath>::<serverName>`: one store serves ~/.claude.json, any project
 * .mcp.json and ~/.codex/config.toml without two same-named servers colliding.
 */
export function disabledMcpPath(homeDir: string): string {
  return path.join(homeDir, ".loadout", "disabled-mcp.json");
}

export function disabledMcpKey(configPath: string, name: string): string {
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
  mkdirSync(path.dirname(storePath), { recursive: true });
  writeFileSync(storePath, `${JSON.stringify(entries, null, 2)}\n`);
}
