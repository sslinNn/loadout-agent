import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyToggle, removeItem } from "../../src/mutators/dispatch";
import { scanSkills } from "../../src/scanners/skills";
import { scanMcp } from "../../src/scanners/mcp";
import { readDisabledMcp } from "../../src/mcpStore";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "loadout-codex-mut-"));
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  writeFileSync(path.join(home, ".codex", "config.toml"), `[mcp_servers.m1]\ncommand = "node"\n`);
  mkdirSync(path.join(home, ".agents", "skills", "s1"), { recursive: true });
  writeFileSync(path.join(home, ".agents", "skills", "s1", "SKILL.md"), "---\nname: s1\n---\n");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("Codex skill/MCP through the unified mutators", () => {
  it("disabling a skill parks the directory instead of flipping a TOML enabled flag", () => {
    const skill = scanSkills({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "s1")!;
    applyToggle(skill, false, home);
    expect(existsSync(path.join(home, ".agents", "skills", "s1"))).toBe(false);
    expect(scanSkills({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "s1")!.enabled).toBe(false);
  });

  it("removeItem on a skill deletes its directory so a re-scan no longer reports it", () => {
    const skill = scanSkills({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "s1")!;
    removeItem(skill, home);
    expect(existsSync(path.join(home, ".agents", "skills", "s1"))).toBe(false);
    expect(scanSkills({ homeDir: home, registeredProjectPaths: [] }).map((i) => i.name)).not.toContain("s1");
  });

  it("disabling an MCP server removes it from config.toml and enabling restores it", () => {
    const item = scanMcp({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "m1")!;
    applyToggle(item, false, home);
    expect(readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).not.toContain("mcp_servers.m1");
    applyToggle(item, true, home);
    expect(readFileSync(path.join(home, ".codex", "config.toml"), "utf8")).toContain("mcp_servers.m1");
  });

  it("removing a disabled MCP server also clears its parked-store entry", () => {
    const item = scanMcp({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "m1")!;
    applyToggle(item, false, home);
    removeItem(item, home);
    expect(readDisabledMcp(home)).toEqual({});
  });
});
