import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cursorAdapter, cursorMcpPath } from "../../src/harnesses/cursor";
import { geminiCliAdapter, geminiSettingsPath } from "../../src/harnesses/geminiCli";
import { copilotAdapter, vscodeUserMcpPath } from "../../src/harnesses/copilot";
import { claudeCodeAdapter } from "../../src/harnesses/claudeCode";
import { codexAdapter, codexConfigPath } from "../../src/harnesses/codex";

let home: string;
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

function tmpHome(label: string): string {
  home = mkdtempSync(path.join(tmpdir(), `loadout-harness-${label}-`));
  return home;
}

describe("Cursor adapter", () => {
  it("reads mcpServers from ~/.cursor/mcp.json", () => {
    const dir = tmpHome("cursor-read");
    mkdirSync(path.join(dir, ".cursor"), { recursive: true });
    writeFileSync(
      cursorMcpPath(dir),
      JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] }
        }
      })
    );
    expect(cursorAdapter.isPresent(dir)).toBe(true);
    expect(cursorAdapter.readMcp(dir).github).toMatchObject({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"]
    });
  });

  it("writes mcpServers and does not invent a Cursor config when Cursor is absent", () => {
    const dir = tmpHome("cursor-absent");
    cursorAdapter.writeMcpEntry(dir, "github", { command: "npx" });
    expect(existsSync(cursorMcpPath(dir))).toBe(false);

    mkdirSync(path.join(dir, ".cursor"), { recursive: true });
    cursorAdapter.writeMcpEntry(dir, "github", { command: "npx", args: ["-y", "x"] });
    const parsed = JSON.parse(readFileSync(cursorMcpPath(dir), "utf8"));
    expect(parsed.mcpServers.github).toEqual({ command: "npx", args: ["-y", "x"] });
  });
});

describe("Gemini CLI adapter", () => {
  it("reads mcpServers from ~/.gemini/settings.json without dropping sibling keys", () => {
    const dir = tmpHome("gemini-read");
    mkdirSync(path.join(dir, ".gemini"), { recursive: true });
    writeFileSync(
      geminiSettingsPath(dir),
      JSON.stringify({
        theme: "Default",
        mcpServers: { docs: { command: "uvx", args: ["mcp-server-fetch"] } }
      })
    );
    expect(geminiCliAdapter.readMcp(dir).docs.command).toBe("uvx");

    geminiCliAdapter.writeMcpEntry(dir, "docs", { command: "uvx", args: ["mcp-server-fetch"], env: { K: "v" } });
    const parsed = JSON.parse(readFileSync(geminiSettingsPath(dir), "utf8"));
    expect(parsed.theme).toBe("Default");
    expect(parsed.mcpServers.docs.env).toEqual({ K: "v" });
  });

  it("round-trips httpUrl remote servers as httpUrl, not url", () => {
    const dir = tmpHome("gemini-httpurl");
    mkdirSync(path.join(dir, ".gemini"), { recursive: true });
    writeFileSync(
      geminiSettingsPath(dir),
      JSON.stringify({
        mcpServers: { remote: { httpUrl: "https://example.invalid/mcp", headers: { Authorization: "Bearer x" } } }
      })
    );
    expect(geminiCliAdapter.readMcp(dir).remote.url).toBe("https://example.invalid/mcp");

    geminiCliAdapter.writeMcpEntry(dir, "remote", geminiCliAdapter.readMcp(dir).remote);
    const parsed = JSON.parse(readFileSync(geminiSettingsPath(dir), "utf8"));
    expect(parsed.mcpServers.remote.httpUrl).toBe("https://example.invalid/mcp");
    expect(parsed.mcpServers.remote.url).toBeUndefined();
    expect(parsed.mcpServers.remote.headers).toEqual({ Authorization: "Bearer x" });
  });
});

describe("Copilot / VS Code adapter", () => {
  it("reads the servers key from the VS Code user mcp.json", () => {
    const dir = tmpHome("copilot-read");
    const mcpPath = vscodeUserMcpPath(dir);
    mkdirSync(path.dirname(mcpPath), { recursive: true });
    writeFileSync(
      mcpPath,
      JSON.stringify({
        servers: {
          github: { type: "http", url: "https://api.githubcopilot.com/mcp" },
          playwright: { command: "npx", args: ["-y", "@microsoft/mcp-server-playwright"] }
        }
      })
    );
    const servers = copilotAdapter.readMcp(dir);
    expect(servers.github.url).toBe("https://api.githubcopilot.com/mcp");
    expect(servers.playwright.command).toBe("npx");
  });

  it("writes servers, not mcpServers, into VS Code mcp.json", () => {
    const dir = tmpHome("copilot-write");
    mkdirSync(path.dirname(vscodeUserMcpPath(dir)), { recursive: true });
    copilotAdapter.writeMcpEntry(dir, "playwright", { command: "npx", args: ["-y", "pw"] });
    const parsed = JSON.parse(readFileSync(vscodeUserMcpPath(dir), "utf8"));
    expect(parsed.servers.playwright).toMatchObject({ command: "npx", args: ["-y", "pw"] });
    expect(parsed.mcpServers).toBeUndefined();
  });

  it("merges leftover mcpServers when servers is also present, and writing does not hide them", () => {
    const dir = tmpHome("copilot-dual-key");
    mkdirSync(path.join(dir, ".copilot"), { recursive: true });
    writeFileSync(
      path.join(dir, ".copilot", "mcp-config.json"),
      JSON.stringify({
        servers: { playwright: { command: "npx", args: ["-y", "pw"] } },
        mcpServers: { github: { command: "npx", args: ["-y", "gh"] } }
      })
    );
    expect(Object.keys(copilotAdapter.readMcp(dir)).sort()).toEqual(["github", "playwright"]);

    copilotAdapter.writeMcpEntry(dir, "docs", { command: "uvx" });
    const after = copilotAdapter.readMcp(dir);
    expect(after.github.command).toBe("npx");
    expect(after.playwright.command).toBe("npx");
    expect(after.docs.command).toBe("uvx");
  });

  it("does not hide leftover mcpServers in VS Code User/mcp.json when writing servers", () => {
    const dir = tmpHome("copilot-vscode-dual-key");
    const mcpPath = vscodeUserMcpPath(dir);
    mkdirSync(path.dirname(mcpPath), { recursive: true });
    writeFileSync(
      mcpPath,
      JSON.stringify({
        servers: { playwright: { command: "npx", args: ["-y", "pw"] } },
        mcpServers: { github: { command: "npx", args: ["-y", "gh"] } }
      })
    );
    expect(Object.keys(copilotAdapter.readMcp(dir)).sort()).toEqual(["github", "playwright"]);

    copilotAdapter.writeMcpEntry(dir, "docs", { command: "uvx" });
    const parsed = JSON.parse(readFileSync(mcpPath, "utf8"));
    expect(parsed.mcpServers.github.command).toBe("npx");
    expect(parsed.servers.playwright.command).toBe("npx");
    expect(parsed.servers.docs.command).toBe("uvx");
    expect(copilotAdapter.readMcp(dir).github.command).toBe("npx");
  });

  it("removes a leftover mcpServers entry from VS Code User/mcp.json without deleting servers", () => {
    const dir = tmpHome("copilot-vscode-dual-remove");
    const mcpPath = vscodeUserMcpPath(dir);
    mkdirSync(path.dirname(mcpPath), { recursive: true });
    writeFileSync(
      mcpPath,
      JSON.stringify({
        servers: { playwright: { command: "npx", args: ["-y", "pw"] } },
        mcpServers: { github: { command: "npx", args: ["-y", "gh"] } }
      })
    );

    copilotAdapter.removeMcpEntry(dir, "github");
    const parsed = JSON.parse(readFileSync(mcpPath, "utf8"));
    expect(parsed.mcpServers.github).toBeUndefined();
    expect(parsed.servers.playwright.command).toBe("npx");
    expect(copilotAdapter.readMcp(dir).github).toBeUndefined();
    expect(copilotAdapter.readMcp(dir).playwright.command).toBe("npx");
  });

  it("does not invent ~/.copilot/skills when only the VS Code user dir is present", () => {
    const dir = tmpHome("copilot-vscode-only");
    mkdirSync(path.dirname(vscodeUserMcpPath(dir)), { recursive: true });
    expect(copilotAdapter.isPresent(dir)).toBe(true);
    expect(copilotAdapter.extraSkillRoots?.({ homeDir: dir, projectPath: null }) ?? []).toEqual([]);
  });
});

describe("present-harness writes", () => {
  it("Claude Code does not create ~/.claude.json when Claude is not present", () => {
    const dir = tmpHome("cc-absent");
    claudeCodeAdapter.writeMcpEntry(dir, "x", { command: "node" });
    expect(existsSync(path.join(dir, ".claude.json"))).toBe(false);
  });

  it("Codex does not create config.toml when ~/.codex is missing", () => {
    const dir = tmpHome("codex-absent");
    codexAdapter.writeMcpEntry(dir, "x", { command: "node" });
    expect(existsSync(codexConfigPath(dir))).toBe(false);
  });

  it("Codex MCP write keeps unrelated TOML keys and refuses a corrupt config", () => {
    const dir = tmpHome("codex-keys");
    mkdirSync(path.join(dir, ".codex"), { recursive: true });
    writeFileSync(
      path.join(dir, ".codex", "config.toml"),
      `model = "gpt-5"\n[mcp_servers.m1]\ncommand = "node"\n`
    );
    codexAdapter.writeMcpEntry(dir, "m1", { command: "uvx" });
    expect(readFileSync(codexConfigPath(dir), "utf8")).toContain("model = \"gpt-5\"");
    expect(codexAdapter.readMcp(dir).m1.command).toBe("uvx");

    writeFileSync(codexConfigPath(dir), "not = [ toml");
    codexAdapter.writeMcpEntry(dir, "m1", { command: "node" });
    expect(readFileSync(codexConfigPath(dir), "utf8")).toBe("not = [ toml");
  });

  it("Claude MCP write keeps sibling keys such as oauthAccount", () => {
    const dir = tmpHome("cc-oauth");
    mkdirSync(path.join(dir, ".claude"), { recursive: true });
    writeFileSync(
      path.join(dir, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "someone@example.com" },
        mcpServers: { fixture: { command: "node" } }
      })
    );
    claudeCodeAdapter.writeMcpEntry(dir, "fixture", { command: "node", args: ["server.js"] });
    const parsed = JSON.parse(readFileSync(path.join(dir, ".claude.json"), "utf8"));
    expect(parsed.oauthAccount).toEqual({ emailAddress: "someone@example.com" });
    expect(parsed.mcpServers.fixture.args).toEqual(["server.js"]);
  });

  it("refuses to overwrite a corrupt ~/.claude.json instead of wiping oauthAccount", () => {
    const dir = tmpHome("cc-corrupt");
    mkdirSync(path.join(dir, ".claude"), { recursive: true });
    const live = path.join(dir, ".claude.json");
    writeFileSync(live, "{ not json\noauthAccount");
    claudeCodeAdapter.writeMcpEntry(dir, "fixture", { command: "node" });
    expect(readFileSync(live, "utf8")).toBe("{ not json\noauthAccount");
  });
});
