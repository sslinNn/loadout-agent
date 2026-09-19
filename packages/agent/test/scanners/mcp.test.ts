import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanMcp } from "../../src/scanners/mcp";
import { applyToggle, removeItem } from "../../src/mutators/mcp";
import { disabledMcpKey, readDisabledMcp } from "../../src/mcpStore";

let home: string;
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("MCP union", () => {
  it("emits one row per name when Claude and Codex agree on command", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-mcp-union-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { github: { command: "npx", args: ["-y", "gh"] } } })
    );
    writeFileSync(path.join(home, ".codex", "config.toml"), '[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "gh"]\n');

    const items = scanMcp({ homeDir: home, registeredProjectPaths: [] });
    const github = items.filter((i) => i.name === "github");
    expect(github).toHaveLength(1);
    expect(github[0].id).toBe("mcp:global:github");
    expect(github[0].harnesses.sort()).toEqual(["claude_code", "codex"]);
    expect(github[0].enabled).toBe(true);
  });

  it("does not write Cursor config on first scan when the server only exists in Claude", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-mcp-no-spread-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { github: { command: "npx" } } })
    );

    const items = scanMcp({ homeDir: home, registeredProjectPaths: [] });
    expect(items.find((i) => i.name === "github")!.harnesses).toEqual(["claude_code"]);
    expect(existsSync(path.join(home, ".cursor", "mcp.json"))).toBe(false);
  });

  it("treats the same name with different commands as a conflict, not a merge", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-mcp-conflict-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { github: { command: "npx", args: ["a"] } } })
    );
    writeFileSync(
      path.join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { github: { command: "npx", args: ["b"] } } })
    );

    const items = scanMcp({ homeDir: home, registeredProjectPaths: [] }).filter((i) => i.name === "github");
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.id).sort()).toEqual(["mcp:global:github:claude_code", "mcp:global:github:cursor"]);
  });

  it("toggle off parks once under scope::name and strips every present harness", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-mcp-fanout-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { github: { command: "npx", args: ["-y", "gh"] } } })
    );
    writeFileSync(path.join(home, ".codex", "config.toml"), '[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "gh"]\n');

    const item = scanMcp({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "github")!;
    applyToggle(item, false, home);

    expect(JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8")).mcpServers.github).toBeUndefined();
    expect(readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).not.toContain("mcp_servers.github");
    expect(readDisabledMcp(home)[disabledMcpKey("global", "github")]).toMatchObject({ command: "npx" });

    applyToggle(item, true, home);
    expect(JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8")).mcpServers.github.command).toBe("npx");
    expect(readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).toContain("mcp_servers.github");
  });

  it("enable fans out a parked server to every present harness, including ones that did not have it", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-mcp-enable-fanout-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { github: { command: "npx" } } })
    );

    const item = scanMcp({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "github")!;
    applyToggle(item, false, home);
    applyToggle(item, true, home);

    expect(JSON.parse(readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.github.command).toBe("npx");
  });

  it("does not treat a project MCP whose name matches a harness id as a fingerprint conflict", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-mcp-name-cursor-"));
    const projectPath = path.join(home, "app");
    mkdirSync(path.join(projectPath, ".cursor"), { recursive: true });
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    writeFileSync(
      path.join(projectPath, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { cursor: { command: "npx", args: ["-y", "cursor-mcp"] } } })
    );

    const item = scanMcp({ homeDir: home, registeredProjectPaths: [projectPath] }).find((i) => i.name === "cursor")!;
    expect(item.id).toBe(`mcp:project:${projectPath}:cursor`);
    expect(item.harnesses).toEqual(["cursor"]);

    applyToggle(item, false, home);
    expect(JSON.parse(readFileSync(path.join(projectPath, ".cursor", "mcp.json"), "utf8")).mcpServers.cursor).toBeUndefined();
    expect(readDisabledMcp(home)[disabledMcpKey("project", "cursor", projectPath)]).toMatchObject({ command: "npx" });

    applyToggle(item, true, home);
    expect(JSON.parse(readFileSync(path.join(projectPath, ".cursor", "mcp.json"), "utf8")).mcpServers.cursor.command).toBe("npx");
  });

  it("restores a parked non-conflict row even when true fingerprint conflicts exist for a different name", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-mcp-park-restore-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["a"] },
          docs: { command: "uvx" }
        }
      })
    );
    writeFileSync(
      path.join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { github: { command: "npx", args: ["b"] } } })
    );

    const docs = scanMcp({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "docs")!;
    applyToggle(docs, false, home);
    applyToggle(docs, true, home);
    expect(JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8")).mcpServers.docs.command).toBe("uvx");
    expect(JSON.parse(readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.docs.command).toBe("uvx");
    expect(JSON.parse(readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.github.args).toEqual(["b"]);
  });

  it("remove clears the parked store so a rescan does not bring the row back", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-mcp-rm-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { github: { command: "npx" } } }));
    const item = scanMcp({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "github")!;
    applyToggle(item, false, home);
    removeItem(item, home);
    expect(readDisabledMcp(home)).toEqual({});
    expect(scanMcp({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "github")).toBeUndefined();
  });
});
