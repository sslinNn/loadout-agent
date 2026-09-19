import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyToggle, removeItem } from "../../src/mutators/dispatch";
import { scanSkills } from "../../src/scanners/skills";
import { scanMcp } from "../../src/scanners/mcp";
import { readDisabledMcp } from "../../src/mcpStore";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "loadout-cc-mut-"));
  mkdirSync(path.join(home, ".claude", "skills", "my-skill"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "skills", "my-skill", "SKILL.md"), "---\nname: my-skill\n---\n");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("skill mutator via Claude extra root", () => {
  it("disable parks a Claude-only skill and re-enable restores it to .agents then projects", () => {
    const item = scanSkills({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "my-skill")!;
    applyToggle(item, false, home);
    expect(existsSync(path.join(home, ".claude", "skills", "my-skill"))).toBe(false);
    expect(scanSkills({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "my-skill")!.enabled).toBe(false);

    applyToggle(item, true, home);
    expect(existsSync(path.join(home, ".agents", "skills", "my-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(home, ".claude", "skills", "my-skill", "SKILL.md"))).toBe(true);
  });

  it("removeItem deletes the skill and leaves a timestamped backup", () => {
    const item = scanSkills({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "my-skill")!;
    removeItem(item, home);
    expect(existsSync(path.join(home, ".claude", "skills", "my-skill"))).toBe(false);
    const backupRoot = path.join(item.path, "..", "..", ".loadout-backups");
    expect(readdirSync(backupRoot).some((name) => name.includes("loadout-backup"))).toBe(true);
  });
});

describe("MCP mutator via Claude config", () => {
  it("disabling an MCP server parks it and enabling restores it", () => {
    writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { fixture: { command: "node" } } }));
    const item = scanMcp({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "fixture")!;
    applyToggle(item, false, home);
    expect(JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8")).mcpServers.fixture).toBeUndefined();
    applyToggle(item, true, home);
    expect(JSON.parse(readFileSync(path.join(home, ".claude.json"), "utf8")).mcpServers.fixture.command).toBe("node");
  });

  it("removing a disabled MCP server clears the parked store", () => {
    writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { fixture: { command: "node" } } }));
    const item = scanMcp({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "fixture")!;
    applyToggle(item, false, home);
    removeItem(item, home);
    expect(readDisabledMcp(home)).toEqual({});
  });
});
