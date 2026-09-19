import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanSkills } from "../../src/scanners/skills";
import { scanMcp } from "../../src/scanners/mcp";

const FIXTURES = path.join(__dirname, "../fixtures/claude-code");

describe("Claude Code extra roots and MCP", () => {
  it("finds global skills under <home>/.claude/skills as one canonical item", () => {
    const homeDir = path.join(FIXTURES, "skills/global/..");
    const items = scanSkills({ homeDir, registeredProjectPaths: [] });
    const skill = items.find((i) => i.name === "data-visualization");
    expect(skill).toMatchObject({ kind: "skill", scope: "global", enabled: true });
    expect(skill!.harnesses).toContain("claude_code");
    expect(skill!.id.startsWith("skill:global:")).toBe(true);
  });

  it("finds project skills only for registered paths", () => {
    const projectPath = path.join(FIXTURES, "skills/project");
    const items = scanSkills({ homeDir: "/nonexistent", registeredProjectPaths: [projectPath] });
    const skill = items.find((i) => i.name === "example");
    expect(skill).toMatchObject({ scope: "project", projectPath });
  });

  it("finds project .mcp.json MCP servers", () => {
    const projectPath = path.join(FIXTURES, "project");
    const home = mkdtempSync(path.join(tmpdir(), "loadout-cc-project-mcp-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    const items = scanMcp({ homeDir: home, registeredProjectPaths: [projectPath] });
    const mcp = items.find((i) => i.name === "fixture-mcp");
    expect(mcp).toMatchObject({ kind: "mcp", scope: "project", projectPath, enabled: true });
    expect(mcp!.id).toBe(`mcp:project:${projectPath}:fixture-mcp`);
    rmSync(home, { recursive: true, force: true });
  });

  it("reports each ~/.claude.json mcpServers entry as a global mcp item", () => {
    const home = mkdtempSync(path.join(tmpdir(), "loadout-cc-usermcp-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "someone@example.com" },
        mcpServers: {
          supabird: { type: "http", url: "https://example.invalid/mcp" },
          localtool: { command: "node", args: ["server.js"] }
        }
      })
    );

    const items = scanMcp({ homeDir: home, registeredProjectPaths: [] });
    const supabird = items.find((i) => i.name === "supabird");
    expect(supabird).toMatchObject({ kind: "mcp", scope: "global", enabled: true, projectPath: null });
    expect(supabird!.id).toBe("mcp:global:supabird");
    expect(items.filter((i) => i.kind === "mcp")).toHaveLength(2);
    rmSync(home, { recursive: true, force: true });
  });

  it("survives a malformed ~/.claude.json instead of killing the skill scan", () => {
    const home = mkdtempSync(path.join(tmpdir(), "loadout-cc-usermcp-bad-"));
    writeFileSync(path.join(home, ".claude.json"), "{ not json");
    mkdirSync(path.join(home, ".claude", "skills", "kept"), { recursive: true });
    writeFileSync(path.join(home, ".claude", "skills", "kept", "SKILL.md"), "---\nname: kept\n---\n");

    const items = scanSkills({ homeDir: home, registeredProjectPaths: [] });
    expect(items.map((i) => i.name)).toEqual(["kept"]);
    rmSync(home, { recursive: true, force: true });
  });

  it("skips a skill whose symlink target is gone and still reports the healthy ones", () => {
    const home = mkdtempSync(path.join(tmpdir(), "loadout-cc-scan-dangling-"));
    const skillsDir = path.join(home, ".claude", "skills");
    const healthy = path.join(skillsDir, "healthy-skill");
    mkdirSync(healthy, { recursive: true });
    writeFileSync(path.join(healthy, "SKILL.md"), "---\nname: healthy-skill\n---\n");
    symlinkSync(path.join(home, "does", "not", "exist"), path.join(skillsDir, "broken-skill"));

    const items = scanSkills({ homeDir: home, registeredProjectPaths: [] });
    expect(items.map((i) => i.name)).toContain("healthy-skill");
    expect(items.map((i) => i.name)).not.toContain("broken-skill");
    rmSync(home, { recursive: true, force: true });
  });
});
