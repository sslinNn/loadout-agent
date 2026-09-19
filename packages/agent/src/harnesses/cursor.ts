import { existsSync } from "node:fs";
import path from "node:path";
import type { CanonicalMcp, HarnessAdapter } from "./types.js";
import { readMcpMap, writeMcpMapEntry } from "./mcpJson.js";

export function cursorMcpPath(homeDir: string): string {
  return path.join(homeDir, ".cursor", "mcp.json");
}

export const cursorAdapter: HarnessAdapter = {
  id: "cursor",

  isPresent(homeDir: string): boolean {
    return existsSync(path.join(homeDir, ".cursor"));
  },

  extraSkillRoots(opts: { homeDir: string; projectPath: string | null }): string[] {
    return [opts.projectPath ? path.join(opts.projectPath, ".cursor", "skills") : path.join(opts.homeDir, ".cursor", "skills")];
  },

  watchPaths(opts: { homeDir: string; projectPaths: string[] }): string[] {
    return [
      path.join(opts.homeDir, ".cursor", "skills"),
      cursorMcpPath(opts.homeDir),
      ...opts.projectPaths.flatMap((p) => [
        path.join(p, ".cursor", "skills"),
        path.join(p, ".cursor", "mcp.json")
      ])
    ];
  },

  readMcp(homeDir: string): Record<string, CanonicalMcp> {
    return readMcpMap(cursorMcpPath(homeDir), "mcpServers");
  },

  writeMcpEntry(homeDir: string, name: string, entry: CanonicalMcp): void {
    if (!this.isPresent(homeDir)) return;
    writeMcpMapEntry(cursorMcpPath(homeDir), "mcpServers", name, entry);
  },

  removeMcpEntry(homeDir: string, name: string): void {
    if (!this.isPresent(homeDir)) return;
    writeMcpMapEntry(cursorMcpPath(homeDir), "mcpServers", name, null);
  },

  readProjectMcp(projectPath: string): Record<string, CanonicalMcp> {
    return readMcpMap(path.join(projectPath, ".cursor", "mcp.json"), "mcpServers");
  },

  writeProjectMcpEntry(projectPath: string, name: string, entry: CanonicalMcp): void {
    writeMcpMapEntry(path.join(projectPath, ".cursor", "mcp.json"), "mcpServers", name, entry);
  },

  removeProjectMcpEntry(projectPath: string, name: string): void {
    writeMcpMapEntry(path.join(projectPath, ".cursor", "mcp.json"), "mcpServers", name, null);
  }
};
