import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanSkills } from "../../src/scanners/skills";
import { scanMcp } from "../../src/scanners/mcp";
import { codexConfigPath, codexGlobalSkillsDir } from "../../src/harnesses/codex";
import { writeDisabledMcp, disabledMcpKey } from "../../src/mcpStore";

const FIXTURES = path.join(__dirname, "../fixtures/codex");

describe("Codex locations", () => {
  it("reads the real Codex locations under the home dir", () => {
    expect(codexConfigPath("/home/u")).toBe("/home/u/.codex/config.toml");
    expect(codexGlobalSkillsDir("/home/u")).toBe("/home/u/.agents/skills");
  });

  it("finds global skills under ~/.agents/skills as a canonical item", () => {
    const items = scanSkills({ homeDir: FIXTURES, registeredProjectPaths: [] });
    const skill = items.find((i) => path.basename(i.path) === "example-skill");
    expect(skill).toMatchObject({ kind: "skill", scope: "global", enabled: true });
    expect(skill!.id).toBe(`skill:global:${path.join(FIXTURES, ".agents", "skills", "example-skill")}`);
  });

  it("finds mcp_servers entries from config.toml as a union mcp item", () => {
    const items = scanMcp({ homeDir: FIXTURES, registeredProjectPaths: [] });
    const mcp = items.find((i) => i.name === "fixture-server");
    expect(mcp).toMatchObject({ kind: "mcp", scope: "global", enabled: true });
    expect(mcp!.id).toBe("mcp:global:fixture-server");
    expect(mcp!.harnesses).toContain("codex");
  });

  it("returns no mcp items for a home dir that has no Codex install", () => {
    expect(scanMcp({ homeDir: path.join(FIXTURES, "does-not-exist"), registeredProjectPaths: [] })).toEqual([]);
  });

  it("reports a parked Codex MCP server as enabled: false with a stable union id", () => {
    const home = mkdtempSync(path.join(tmpdir(), "loadout-codex-scan-mcp-"));
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    writeFileSync(codexConfigPath(home), '[mcp_servers.fixture]\ncommand = "node"\n');

    const before = scanMcp({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "fixture")!;
    expect(before.enabled).toBe(true);

    writeDisabledMcp(home, { [disabledMcpKey("global", "fixture")]: { command: "node" } });
    writeFileSync(codexConfigPath(home), "");

    const after = scanMcp({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "fixture")!;
    expect(after.enabled).toBe(false);
    expect(after.id).toBe(before.id);

    rmSync(home, { recursive: true, force: true });
  });

  it("skips a skill whose symlink target is gone and still reports the healthy ones", () => {
    const home = mkdtempSync(path.join(tmpdir(), "loadout-codex-scan-dangling-"));
    const skillsDir = codexGlobalSkillsDir(home);
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
