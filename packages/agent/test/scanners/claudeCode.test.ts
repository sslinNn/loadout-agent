import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanClaudeCode } from "../../src/scanners/claudeCode";

const FIXTURES = path.join(__dirname, "../fixtures/claude-code");

describe("scanClaudeCode", () => {
  it("finds global skills under <home>/.claude/skills", () => {
    const items = scanClaudeCode({
      homeDir: path.join(FIXTURES, "skills/global/.."),
      registeredProjectPaths: []
    });
    const skill = items.find((i) => i.name === "data-visualization");
    expect(skill).toMatchObject({ tool: "claude_code", kind: "skill", scope: "global", enabled: true });
  });

  it("finds project skills and project .mcp.json only for registered paths", () => {
    const projectPath = path.join(FIXTURES, "skills/project");
    const items = scanClaudeCode({ homeDir: "/nonexistent", registeredProjectPaths: [projectPath] });
    const skill = items.find((i) => i.name === "example");
    expect(skill).toMatchObject({ scope: "project", projectPath });

    const mcpItems = scanClaudeCode({
      homeDir: "/nonexistent",
      registeredProjectPaths: [path.join(FIXTURES, "project")]
    });
    const mcp = mcpItems.find((i) => i.name === "fixture-mcp");
    expect(mcp).toMatchObject({ tool: "claude_code", kind: "mcp", scope: "project" });
  });

  describe("disabled (move-aside) skills", () => {
    let home: string;
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    it("reports a global skill moved into .loadout-disabled as enabled: false", () => {
      home = mkdtempSync(path.join(tmpdir(), "loadout-cc-scan-disabled-"));
      const disabledSkillDir = path.join(home, ".claude", ".loadout-disabled", "shelved-skill");
      mkdirSync(disabledSkillDir, { recursive: true });
      writeFileSync(path.join(disabledSkillDir, "SKILL.md"), "---\nname: shelved-skill\n---\n");

      const items = scanClaudeCode({ homeDir: home, registeredProjectPaths: [] });
      const shelved = items.find((i) => i.name === "shelved-skill");

      expect(shelved).toBeDefined();
      expect(shelved).toMatchObject({
        tool: "claude_code",
        kind: "skill",
        scope: "global",
        enabled: false,
        path: path.join(home, ".claude", "skills", "shelved-skill")
      });
    });

    it("reports a project-scoped disabled skill as enabled: false, scoped to that project", () => {
      home = mkdtempSync(path.join(tmpdir(), "loadout-cc-scan-disabled-proj-"));
      const projectPath = path.join(home, "my-project");
      const disabledSkillDir = path.join(projectPath, ".claude", ".loadout-disabled", "shelved-proj-skill");
      mkdirSync(disabledSkillDir, { recursive: true });
      writeFileSync(path.join(disabledSkillDir, "SKILL.md"), "---\nname: shelved-proj-skill\n---\n");

      const items = scanClaudeCode({ homeDir: "/nonexistent", registeredProjectPaths: [projectPath] });
      const shelved = items.find((i) => i.path.includes("shelved-proj-skill"));

      expect(shelved).toBeDefined();
      expect(shelved).toMatchObject({ scope: "project", projectPath, enabled: false });
    });
  });

  describe("user-scoped MCP servers", () => {
    let home: string;
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    it("reports each ~/.claude.json mcpServers entry as a global mcp item", () => {
      home = mkdtempSync(path.join(tmpdir(), "loadout-cc-usermcp-"));
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

      const items = scanClaudeCode({ homeDir: home, registeredProjectPaths: [] });
      const supabird = items.find((i) => i.name === "supabird");

      expect(supabird).toMatchObject({
        tool: "claude_code",
        kind: "mcp",
        scope: "global",
        enabled: true,
        projectPath: null,
        path: path.join(home, ".claude.json")
      });
      expect(supabird!.id).toBe(`claude_code:mcp:global:${path.join(home, ".claude.json")}:supabird`);
      expect(items.filter((i) => i.kind === "mcp")).toHaveLength(2);
    });

    it("returns no mcp items when the file is missing or has no mcpServers", () => {
      home = mkdtempSync(path.join(tmpdir(), "loadout-cc-usermcp-none-"));
      expect(scanClaudeCode({ homeDir: home, registeredProjectPaths: [] })).toEqual([]);

      writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ projects: {} }));
      expect(scanClaudeCode({ homeDir: home, registeredProjectPaths: [] })).toEqual([]);
    });

    it("survives a malformed ~/.claude.json instead of killing the scan", () => {
      home = mkdtempSync(path.join(tmpdir(), "loadout-cc-usermcp-bad-"));
      writeFileSync(path.join(home, ".claude.json"), "{ not json");
      mkdirSync(path.join(home, ".claude", "skills", "kept"), { recursive: true });
      writeFileSync(path.join(home, ".claude", "skills", "kept", "SKILL.md"), "---\nname: kept\n---\n");

      const items = scanClaudeCode({ homeDir: home, registeredProjectPaths: [] });
      expect(items.map((i) => i.name)).toEqual(["kept"]);
    });

    it("reports a parked server as enabled: false with the same id it had when enabled", () => {
      home = mkdtempSync(path.join(tmpdir(), "loadout-cc-usermcp-off-"));
      const configPath = path.join(home, ".claude.json");
      writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
      mkdirSync(path.join(home, ".loadout"), { recursive: true });
      writeFileSync(
        path.join(home, ".loadout", "disabled-mcp.json"),
        JSON.stringify({ [`${configPath}::supabird`]: { type: "http", url: "https://example.invalid/mcp" } })
      );

      const items = scanClaudeCode({ homeDir: home, registeredProjectPaths: [] });
      const supabird = items.find((i) => i.name === "supabird");

      expect(supabird).toMatchObject({ kind: "mcp", scope: "global", enabled: false });
      expect(supabird!.id).toBe(`claude_code:mcp:global:${configPath}:supabird`);
    });
  });
  // A dangling symlink used to kill the whole daemon, not just this scan: `~/.claude/skills`
  // is commonly a directory of symlinks into a checkout elsewhere, statSync FOLLOWS them, and
  // the resulting ENOENT escaped the readdir filter, buildSnapshot, and the `run` action — so
  // the agent died on startup and every restart hit the same broken link.
  describe("unreadable entries", () => {
    let home: string;
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    it("skips a skill whose symlink target is gone and still reports the healthy ones", () => {
      home = mkdtempSync(path.join(tmpdir(), "loadout-cc-scan-dangling-"));
      const skillsDir = path.join(home, ".claude", "skills");
      const healthy = path.join(skillsDir, "healthy-skill");
      mkdirSync(healthy, { recursive: true });
      writeFileSync(path.join(healthy, "SKILL.md"), "---\nname: healthy-skill\n---\n");
      symlinkSync(path.join(home, "does", "not", "exist"), path.join(skillsDir, "broken-skill"));

      const items = scanClaudeCode({ homeDir: home, registeredProjectPaths: [] });

      expect(items.map((i) => i.name)).toContain("healthy-skill");
      expect(items.map((i) => i.name)).not.toContain("broken-skill");
    });

    it("skips a dangling symlink in the .loadout-disabled mirror too", () => {
      home = mkdtempSync(path.join(tmpdir(), "loadout-cc-scan-dangling-disabled-"));
      const disabledDir = path.join(home, ".claude", ".loadout-disabled");
      mkdirSync(disabledDir, { recursive: true });
      symlinkSync(path.join(home, "does", "not", "exist"), path.join(disabledDir, "broken-skill"));

      expect(() => scanClaudeCode({ homeDir: home, registeredProjectPaths: [] })).not.toThrow();
    });
  });
});
