import { existsSync } from "node:fs";
import path from "node:path";
import type { CanonicalMcp, HarnessAdapter } from "./types.js";
import { readMcpMap, readMcpMapUnion, writeMcpMapEntry } from "./mcpJson.js";

export function vscodeUserMcpPath(homeDir: string): string {
  if (process.platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "Code", "User", "mcp.json");
  }
  if (process.platform === "win32") {
    return path.join(homeDir, "AppData", "Roaming", "Code", "User", "mcp.json");
  }
  return path.join(homeDir, ".config", "Code", "User", "mcp.json");
}

export function copilotMcpPath(homeDir: string): string {
  return path.join(homeDir, ".copilot", "mcp-config.json");
}

function vscodeUserDir(homeDir: string): string {
  return path.dirname(vscodeUserMcpPath(homeDir));
}

function readCopilotFile(filePath: string): Record<string, CanonicalMcp> {
  // `servers` overlays leftover `mcpServers` so a write that only updates `servers`
  // cannot hide servers that still live under the older key.
  return readMcpMapUnion(filePath, ["mcpServers", "servers"]);
}

export const copilotAdapter: HarnessAdapter = {
  id: "copilot",

  isPresent(homeDir: string): boolean {
    return existsSync(path.join(homeDir, ".copilot")) || existsSync(vscodeUserDir(homeDir));
  },

  extraSkillRoots(opts: { homeDir: string; projectPath: string | null }): string[] {
    if (opts.projectPath) return [path.join(opts.projectPath, ".github", "skills")];
    // isPresent is true for VS Code User/ alone. Do not invent ~/.copilot/skills for
    // those users — Copilot only reads that root when ~/.copilot already exists.
    if (!existsSync(path.join(opts.homeDir, ".copilot"))) return [];
    return [path.join(opts.homeDir, ".copilot", "skills")];
  },

  watchPaths(opts: { homeDir: string; projectPaths: string[] }): string[] {
    return [
      path.join(opts.homeDir, ".copilot", "skills"),
      copilotMcpPath(opts.homeDir),
      vscodeUserMcpPath(opts.homeDir),
      ...opts.projectPaths.flatMap((p) => [
        path.join(p, ".github", "skills"),
        path.join(p, ".vscode", "mcp.json")
      ])
    ];
  },

  readMcp(homeDir: string): Record<string, CanonicalMcp> {
    return {
      ...readCopilotFile(copilotMcpPath(homeDir)),
      ...readMcpMapUnion(vscodeUserMcpPath(homeDir), ["mcpServers", "servers"])
    };
  },

  writeMcpEntry(homeDir: string, name: string, entry: CanonicalMcp): void {
    if (!this.isPresent(homeDir)) return;
    if (existsSync(vscodeUserDir(homeDir))) {
      writeMcpMapEntry(vscodeUserMcpPath(homeDir), "servers", name, entry, { typeHttp: Boolean(entry.url) });
    }
    if (existsSync(path.join(homeDir, ".copilot"))) {
      writeMcpMapEntry(copilotMcpPath(homeDir), "servers", name, entry, { typeHttp: Boolean(entry.url) });
    }
  },

  removeMcpEntry(homeDir: string, name: string): void {
    if (!this.isPresent(homeDir)) return;
    writeMcpMapEntry(vscodeUserMcpPath(homeDir), "servers", name, null);
    writeMcpMapEntry(vscodeUserMcpPath(homeDir), "mcpServers", name, null);
    writeMcpMapEntry(copilotMcpPath(homeDir), "servers", name, null);
    writeMcpMapEntry(copilotMcpPath(homeDir), "mcpServers", name, null);
  },

  readProjectMcp(projectPath: string): Record<string, CanonicalMcp> {
    return readMcpMap(path.join(projectPath, ".vscode", "mcp.json"), "servers");
  },

  writeProjectMcpEntry(projectPath: string, name: string, entry: CanonicalMcp): void {
    writeMcpMapEntry(path.join(projectPath, ".vscode", "mcp.json"), "servers", name, entry, {
      typeHttp: Boolean(entry.url)
    });
  },

  removeProjectMcpEntry(projectPath: string, name: string): void {
    writeMcpMapEntry(path.join(projectPath, ".vscode", "mcp.json"), "servers", name, null);
  }
};
