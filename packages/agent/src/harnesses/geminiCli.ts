import { existsSync } from "node:fs";
import path from "node:path";
import type { CanonicalMcp, HarnessAdapter } from "./types.js";
import { readMcpMap, writeMcpMapEntry } from "./mcpJson.js";

export function geminiSettingsPath(homeDir: string): string {
  return path.join(homeDir, ".gemini", "settings.json");
}

export const geminiCliAdapter: HarnessAdapter = {
  id: "gemini_cli",

  isPresent(homeDir: string): boolean {
    return existsSync(path.join(homeDir, ".gemini"));
  },

  watchPaths(opts: { homeDir: string; projectPaths: string[] }): string[] {
    return [
      geminiSettingsPath(opts.homeDir),
      ...opts.projectPaths.map((p) => path.join(p, ".gemini", "settings.json"))
    ];
  },

  readMcp(homeDir: string): Record<string, CanonicalMcp> {
    return readMcpMap(geminiSettingsPath(homeDir), "mcpServers");
  },

  writeMcpEntry(homeDir: string, name: string, entry: CanonicalMcp): void {
    if (!this.isPresent(homeDir)) return;
    writeMcpMapEntry(geminiSettingsPath(homeDir), "mcpServers", name, entry, { urlKey: "httpUrl" });
  },

  removeMcpEntry(homeDir: string, name: string): void {
    if (!this.isPresent(homeDir)) return;
    writeMcpMapEntry(geminiSettingsPath(homeDir), "mcpServers", name, null);
  },

  readProjectMcp(projectPath: string): Record<string, CanonicalMcp> {
    return readMcpMap(path.join(projectPath, ".gemini", "settings.json"), "mcpServers");
  },

  writeProjectMcpEntry(projectPath: string, name: string, entry: CanonicalMcp): void {
    writeMcpMapEntry(path.join(projectPath, ".gemini", "settings.json"), "mcpServers", name, entry, {
      urlKey: "httpUrl"
    });
  },

  removeProjectMcpEntry(projectPath: string, name: string): void {
    writeMcpMapEntry(path.join(projectPath, ".gemini", "settings.json"), "mcpServers", name, null);
  }
};
