import { existsSync } from "node:fs";
import path from "node:path";
import type { CanonicalMcp, HarnessAdapter } from "./types.js";
import { readMcpMap, writeMcpMapEntry } from "./mcpJson.js";

export function claudeJsonPath(homeDir: string): string {
  return path.join(homeDir, ".claude.json");
}

export function claudeSkillsDir(homeDir: string): string {
  return path.join(homeDir, ".claude", "skills");
}

export const claudeCodeAdapter: HarnessAdapter = {
  id: "claude_code",

  isPresent(homeDir: string): boolean {
    return existsSync(path.join(homeDir, ".claude")) || existsSync(claudeJsonPath(homeDir));
  },

  extraSkillRoots(opts: { homeDir: string; projectPath: string | null }): string[] {
    return [opts.projectPath ? path.join(opts.projectPath, ".claude", "skills") : claudeSkillsDir(opts.homeDir)];
  },

  watchPaths(opts: { homeDir: string; projectPaths: string[] }): string[] {
    return [
      claudeSkillsDir(opts.homeDir),
      claudeJsonPath(opts.homeDir),
      ...opts.projectPaths.flatMap((p) => [path.join(p, ".claude", "skills"), path.join(p, ".mcp.json")])
    ];
  },

  readMcp(homeDir: string): Record<string, CanonicalMcp> {
    return readMcpMap(claudeJsonPath(homeDir), "mcpServers");
  },

  writeMcpEntry(homeDir: string, name: string, entry: CanonicalMcp): void {
    if (!this.isPresent(homeDir)) return;
    writeMcpMapEntry(claudeJsonPath(homeDir), "mcpServers", name, entry, { typeHttp: Boolean(entry.url) });
  },

  removeMcpEntry(homeDir: string, name: string): void {
    if (!this.isPresent(homeDir)) return;
    writeMcpMapEntry(claudeJsonPath(homeDir), "mcpServers", name, null);
  },

  readProjectMcp(projectPath: string): Record<string, CanonicalMcp> {
    return readMcpMap(path.join(projectPath, ".mcp.json"), "mcpServers");
  },

  writeProjectMcpEntry(projectPath: string, name: string, entry: CanonicalMcp): void {
    writeMcpMapEntry(path.join(projectPath, ".mcp.json"), "mcpServers", name, entry, { typeHttp: Boolean(entry.url) });
  },

  removeProjectMcpEntry(projectPath: string, name: string): void {
    writeMcpMapEntry(path.join(projectPath, ".mcp.json"), "mcpServers", name, null);
  }
};
