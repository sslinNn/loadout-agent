import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanCodex, codexConfigPath, codexGlobalSkillsDir } from "../../src/scanners/codex";
import { disabledMcpKey, writeDisabledMcp } from "../../src/mcpStore";

// FIXTURES is a *fake home directory*: its contents are laid out at exactly the relative
// paths a real `~` has for Codex (`.codex/config.toml`, `.agents/skills/<skill>/SKILL.md`),
// so these tests exercise scanCodex's real path-joining rather than a test-only layout.
// See docs/superpowers/specs/2026-09-02-loadout-design.md for the verified locations.
const FIXTURES = path.join(__dirname, "../fixtures/codex");

describe("scanCodex", () => {
  it("finds global skills and reflects config.toml enabled flags", () => {
    const items = scanCodex({ homeDir: FIXTURES, registeredProjectPaths: [] });
    const skill = items.find((i) => i.name === "example-skill");
    expect(skill).toMatchObject({ tool: "codex", kind: "skill", scope: "global", enabled: true });
  });

  it("finds mcp_servers entries from config.toml", () => {
    const items = scanCodex({ homeDir: FIXTURES, registeredProjectPaths: [] });
    const mcp = items.find((i) => i.name === "fixture-server");
    expect(mcp).toMatchObject({ tool: "codex", kind: "mcp", scope: "global" });
  });

  it("reads the real Codex locations under the home dir (~/.codex/config.toml, ~/.agents/skills)", () => {
    expect(codexConfigPath("/home/u")).toBe("/home/u/.codex/config.toml");
    expect(codexGlobalSkillsDir("/home/u")).toBe("/home/u/.agents/skills");

    const items = scanCodex({ homeDir: FIXTURES, registeredProjectPaths: [] });
    const skill = items.find((i) => i.name === "example-skill")!;
    // A skill item's `path` is the skill's own directory (this is the contract
    // packages/agent/src/mutators/codex.ts must honour — it may NOT treat it as config.toml).
    expect(skill.path).toBe(path.join(FIXTURES, ".agents", "skills", "example-skill"));

    const mcp = items.find((i) => i.name === "fixture-server")!;
    expect(mcp.path).toBe(path.join(FIXTURES, ".codex", "config.toml"));
  });

  it("returns nothing for a home dir that has no Codex install", () => {
    expect(scanCodex({ homeDir: path.join(FIXTURES, "does-not-exist"), registeredProjectPaths: [] })).toEqual([]);
  });

  // Mirrors scanUserMcpServers in packages/agent/src/scanners/claudeCode.ts: a server
  // parked in the shared disabled-mcp store must still show up in the inventory (as
  // enabled: false) rather than vanishing, and must keep the same id it had while enabled
  // so re-enabling it from the dashboard resolves to the same row.
  it("reports a parked codex MCP server as enabled: false with the same id it had when enabled", () => {
    const home = mkdtempSync(path.join(tmpdir(), "loadout-codex-scan-mcp-"));
    const configPath = codexConfigPath(home);
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, '[mcp_servers.fixture]\ncommand = "node"\n');

    const before = scanCodex({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "fixture")!;
    expect(before.enabled).toBe(true);

    // Simulate the parked state applyToggle(false) produces: the entry moves out of
    // config.toml and into the shared store.
    writeDisabledMcp(home, { [disabledMcpKey(configPath, "fixture")]: { command: "node" } });
    writeFileSync(configPath, "");

    const after = scanCodex({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "fixture")!;
    expect(after.enabled).toBe(false);
    expect(after.id).toBe(before.id);

    rmSync(home, { recursive: true, force: true });
  });
  // Same failure mode as the Claude Code scanner's: statSync follows symlinks, so one skill
  // whose target has been moved away threw ENOENT out of the readdir filter and took the
  // whole daemon down on startup.
  it("skips a skill whose symlink target is gone and still reports the healthy ones", () => {
    const home = mkdtempSync(path.join(tmpdir(), "loadout-codex-scan-dangling-"));
    const skillsDir = codexGlobalSkillsDir(home);
    const healthy = path.join(skillsDir, "healthy-skill");
    mkdirSync(healthy, { recursive: true });
    writeFileSync(path.join(healthy, "SKILL.md"), "---\nname: healthy-skill\n---\n");
    symlinkSync(path.join(home, "does", "not", "exist"), path.join(skillsDir, "broken-skill"));

    const items = scanCodex({ homeDir: home, registeredProjectPaths: [] });

    expect(items.map((i) => i.name)).toContain("healthy-skill");
    expect(items.map((i) => i.name)).not.toContain("broken-skill");

    rmSync(home, { recursive: true, force: true });
  });
});
