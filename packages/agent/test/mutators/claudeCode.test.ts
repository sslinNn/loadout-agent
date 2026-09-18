import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyToggle, removeItem } from "../../src/mutators/claudeCode";
import { scanClaudeCode } from "../../src/scanners/claudeCode";
import { disabledMcpPath, readDisabledMcp } from "../../src/mcpStore";

let dir: string, skillsDir: string, skillPath: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "loadout-cc-mut-"));
  skillsDir = path.join(dir, ".claude", "skills");
  skillPath = path.join(skillsDir, "my-skill");
  mkdirSync(skillPath, { recursive: true });
  writeFileSync(path.join(skillPath, "SKILL.md"), "---\nname: my-skill\n---\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const skillItem = () => ({
  id: "1", machineId: "M", tool: "claude_code" as const, kind: "skill" as const, name: "my-skill",
  enabled: true, path: skillPath, scope: "global" as const, projectPath: null,
  sourceType: "manual" as const, sourceRef: null, contentBackupId: null,
  lastSyncedAt: "2026-01-01T00:00:00.000Z"
});

describe("claudeCode mutator — skill move-aside disable", () => {
  it("applyToggle(false) moves the skill dir out of the skills path", () => {
    applyToggle(skillItem(), false);
    expect(existsSync(skillPath)).toBe(false);
    expect(existsSync(path.join(skillsDir, "..", ".loadout-disabled", "my-skill"))).toBe(true);
  });

  it("applyToggle(true) moves it back", () => {
    applyToggle(skillItem(), false);
    applyToggle({ ...skillItem(), enabled: false }, true);
    expect(existsSync(skillPath)).toBe(true);
  });

  it("removeItem deletes the skill directory entirely", () => {
    removeItem(skillItem());
    expect(existsSync(skillPath)).toBe(false);
    expect(existsSync(path.join(skillsDir, "..", ".loadout-disabled", "my-skill"))).toBe(false);
  });

  // I3: removal is irreversible, so the plan's Global Constraint requires a timestamped
  // backup first. backupFile/copyFileSync cannot copy a directory, so nothing was backed up.
  it("removeItem leaves a timestamped backup of the skill directory behind", () => {
    removeItem(skillItem());
    const backupRoot = path.join(dir, ".claude", ".loadout-backups");
    const backups = readdirSync(backupRoot);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^my-skill\.loadout-backup-/);
    expect(existsSync(path.join(backupRoot, backups[0], "SKILL.md"))).toBe(true);
    // The backup must live OUTSIDE .claude/skills, or the next scan would report it as a skill.
    expect(scanClaudeCode({ homeDir: dir, registeredProjectPaths: [] })).toEqual([]);
  });
});

// I4: a skill's SKILL.md frontmatter `name:` is not required to match its directory name,
// and in practice often doesn't. The mutator used to build the disabled-mirror path from
// `item.name`, so the skill was filed under a basename the scanner never looks for, and
// scanDisabledSkillsDir (which derives identity from directory entries, as it must)
// computed a different canonical id/path than the enabled item had.
describe("claudeCode mutator — frontmatter name differs from directory name", () => {
  let dirNamed: string, mismatchedPath: string;
  beforeEach(() => {
    dirNamed = path.join(skillsDir, "pdf-tools");
    mkdirSync(dirNamed, { recursive: true });
    writeFileSync(path.join(dirNamed, "SKILL.md"), "---\nname: Working with PDFs\n---\n");
    mismatchedPath = dirNamed;
  });

  const scan = () => scanClaudeCode({ homeDir: dir, registeredProjectPaths: [] });

  it("disable/re-enable round-trips with a stable id, and the scan reports it disabled in between", () => {
    const before = scan().find((i) => i.path === mismatchedPath)!;
    expect(before.name).toBe("Working with PDFs"); // frontmatter name != directory name
    expect(before.enabled).toBe(true);

    applyToggle(before, false);
    expect(existsSync(mismatchedPath)).toBe(false);
    expect(existsSync(path.join(skillsDir, "..", ".loadout-disabled", "pdf-tools"))).toBe(true);

    const disabled = scan().find((i) => i.path === mismatchedPath);
    expect(disabled).toBeDefined();
    expect(disabled!.enabled).toBe(false);
    expect(disabled!.id).toBe(before.id); // identity survives the disable

    applyToggle(disabled!, true);
    expect(existsSync(mismatchedPath)).toBe(true);
    const reEnabled = scan().find((i) => i.path === mismatchedPath)!;
    expect(reEnabled.enabled).toBe(true);
    expect(reEnabled.id).toBe(before.id);
  });

  it("removeItem cleans up the disabled mirror keyed by directory name", () => {
    const item = scan().find((i) => i.path === mismatchedPath)!;
    applyToggle(item, false);
    removeItem(scan().find((i) => i.path === mismatchedPath)!);
    expect(existsSync(path.join(skillsDir, "..", ".loadout-disabled", "pdf-tools"))).toBe(false);
  });
});

describe("MCP toggle", () => {
  let home: string;
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function writeClaudeJson(h: string, servers: Record<string, unknown>) {
    writeFileSync(
      path.join(h, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "someone@example.com" }, mcpServers: servers })
    );
  }

  function readClaudeJson(h: string) {
    return JSON.parse(readFileSync(path.join(h, ".claude.json"), "utf8"));
  }

  function mcpItem(h: string, name: string) {
    const configPath = path.join(h, ".claude.json");
    return {
      id: `claude_code:mcp:global:${configPath}:${name}`,
      machineId: "m",
      tool: "claude_code" as const,
      kind: "mcp" as const,
      name,
      enabled: true,
      path: configPath,
      scope: "global" as const,
      projectPath: null,
      sourceType: "manual" as const,
      sourceRef: null,
      contentBackupId: null,
      lastSyncedAt: new Date().toISOString()
    };
  }

  it("disabling moves the server out of ~/.claude.json and into the store", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-cc-mcp-off-"));
    writeClaudeJson(home, { supabird: { type: "http", url: "https://example.invalid/mcp" } });

    applyToggle(mcpItem(home, "supabird"), false, home);

    const after = readClaudeJson(home);
    expect(after.mcpServers).toEqual({});
    expect(after.oauthAccount).toEqual({ emailAddress: "someone@example.com" });
    expect(readDisabledMcp(home)).toEqual({
      [`${path.join(home, ".claude.json")}::supabird`]: { type: "http", url: "https://example.invalid/mcp" }
    });
  });

  it("enabling moves it back and empties the store entry", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-cc-mcp-on-"));
    writeClaudeJson(home, { supabird: { type: "http", url: "https://example.invalid/mcp" } });

    applyToggle(mcpItem(home, "supabird"), false, home);
    applyToggle(mcpItem(home, "supabird"), true, home);

    expect(readClaudeJson(home).mcpServers).toEqual({
      supabird: { type: "http", url: "https://example.invalid/mcp" }
    });
    expect(readDisabledMcp(home)).toEqual({});
  });

  it("leaves every other key in ~/.claude.json untouched", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-cc-mcp-keys-"));
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "someone@example.com" },
        projects: { "/tmp/x": { allowedTools: ["Bash"] } },
        tipsHistory: { a: 1 },
        mcpServers: { supabird: { type: "http", url: "https://example.invalid/mcp" } }
      })
    );

    applyToggle(mcpItem(home, "supabird"), false, home);

    const after = readClaudeJson(home);
    expect(after.projects).toEqual({ "/tmp/x": { allowedTools: ["Bash"] } });
    expect(after.tipsHistory).toEqual({ a: 1 });
    expect(Object.keys(after).sort()).toEqual(["mcpServers", "oauthAccount", "projects", "tipsHistory"]);
  });

  it("removing an MCP server deletes it from the config and from the parked store", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-cc-mcp-rm-"));
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "someone@example.com" }, mcpServers: { supabird: { type: "http" } } })
    );

    removeItem(mcpItem(home, "supabird"), home);

    const after = JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8"));
    expect(after.mcpServers).toEqual({});
    expect(after.oauthAccount).toEqual({ emailAddress: "someone@example.com" });
    expect(readDisabledMcp(home)).toEqual({});
  });

  // applyToggle returns early when there is nothing to move; removeItem did not, so
  // removing an already-absent server still took a backup and rewrote the live state
  // file — reformatting it and inventing an `mcpServers: {}` key that was never there.
  it("removing a server that is in neither the config nor the store leaves ~/.claude.json untouched", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-cc-mcp-noop-"));
    const configPath = path.join(home, ".claude.json");
    const original = JSON.stringify({
      oauthAccount: { emailAddress: "someone@example.com" },
      projects: { "/tmp/x": { allowedTools: ["Bash"] } }
    });
    writeFileSync(configPath, original);

    removeItem(mcpItem(home, "ghost"), home);

    // Byte-for-byte: no rewrite at all, so no reformatting and no invented mcpServers key.
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(readdirSync(home).filter((f) => f.includes("loadout-backup"))).toEqual([]);
    expect(existsSync(disabledMcpPath(home))).toBe(false);
  });
});
