import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";
import { applyToggle, removeItem, resolveConfigPath } from "../../src/mutators/codex";
import { scanCodex } from "../../src/scanners/codex";
import { disabledMcpKey, disabledMcpPath, readDisabledMcp, writeDisabledMcp } from "../../src/mcpStore";

// `home` is a fake home directory laid out exactly like a real one: ~/.codex/config.toml
// plus ~/.agents/skills/<skill>/SKILL.md. Fixtures here are built by the REAL scanner
// (scanCodex) rather than hand-written, so the mutator is always tested against the exact
// item shape production hands it — in particular a skill item's `path` is the skill's own
// DIRECTORY, not config.toml. Hand-built fixtures that set `path: config.toml` for skills
// were what hid the EISDIR crash these tests now cover.
let home: string, configPath: string, skillPath: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "loadout-codex-mut-"));
  configPath = path.join(home, ".codex", "config.toml");
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `[[skills.config]]\nname = "s1"\nenabled = true\n\n[mcp_servers.m1]\ncommand = "node"\n`);
  skillPath = path.join(home, ".agents", "skills", "s1");
  mkdirSync(skillPath, { recursive: true });
  writeFileSync(path.join(skillPath, "SKILL.md"), "---\nname: s1\n---\n");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const scanned = (name: string) => {
  const item = scanCodex({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === name);
  if (!item) throw new Error(`scanner produced no item named ${name}`);
  return item;
};

describe("codex mutator", () => {
  it("a scanned skill item's path is its own directory, and the mutator still finds config.toml", () => {
    const skill = scanned("s1");
    expect(skill.path).toBe(skillPath);
    expect(resolveConfigPath(skill, home)).toBe(configPath);
    // An mcp item's path genuinely IS the config file, so it resolves to itself.
    expect(resolveConfigPath(scanned("m1"), home)).toBe(configPath);
  });

  it("applyToggle(false) flips enabled to false in config.toml and leaves a backup", () => {
    applyToggle(scanned("s1"), false, home);
    const parsed = TOML.parse(readFileSync(configPath, "utf8")) as any;
    expect(parsed.skills.config[0].enabled).toBe(false);
    const backups = readdirSync(path.join(home, ".codex")).filter((f) => f.includes(".loadout-backup-"));
    expect(backups).toHaveLength(1);
  });

  it("applyToggle round-trips: a re-scan after disable reports the skill as disabled, and re-enable restores it", () => {
    applyToggle(scanned("s1"), false, home);
    expect(scanned("s1").enabled).toBe(false);
    applyToggle(scanned("s1"), true, home);
    expect(scanned("s1").enabled).toBe(true);
  });

  it("removeItem drops the mcp_servers entry", () => {
    removeItem(scanned("m1"), home);
    const parsed = TOML.parse(readFileSync(configPath, "utf8")) as any;
    expect(parsed.mcp_servers).toEqual({});
  });

  it("removeItem on a skill deletes its directory (behind a backup) so a re-scan no longer reports it", () => {
    removeItem(scanned("s1"), home);
    expect(existsSync(skillPath)).toBe(false);
    const backupRoot = path.join(home, ".agents", ".loadout-backups");
    const backups = readdirSync(backupRoot);
    expect(backups).toHaveLength(1);
    expect(existsSync(path.join(backupRoot, backups[0], "SKILL.md"))).toBe(true);
    // The backup must NOT sit inside ~/.agents/skills, or the scanner would report it as a skill.
    expect(scanCodex({ homeDir: home, registeredProjectPaths: [] }).map((i) => i.name)).not.toContain("s1");
  });

  // Same guard as the claude_code mutator: applyToggle returns early when there is nothing
  // to move, but removeItem rewrote config.toml (behind a fresh backup) even for a server
  // it never found.
  it("removing a server that is in neither config.toml nor the store leaves the file untouched", () => {
    const h = mkdtempSync(path.join(tmpdir(), "loadout-codex-mcp-noop-"));
    const cfg = path.join(h, ".codex", "config.toml");
    mkdirSync(path.dirname(cfg), { recursive: true });
    const original = '[mcp_servers.kept]\ncommand = "node"\n';
    writeFileSync(cfg, original);

    removeItem(
      {
        id: `codex:mcp:global:${cfg}:ghost`,
        machineId: "m",
        tool: "codex" as const,
        kind: "mcp" as const,
        name: "ghost",
        enabled: true,
        path: cfg,
        scope: "global" as const,
        projectPath: null,
        sourceType: "manual" as const,
        sourceRef: null,
        contentBackupId: null,
        lastSyncedAt: new Date().toISOString()
      },
      h
    );

    expect(readFileSync(cfg, "utf8")).toBe(original);
    expect(readdirSync(path.dirname(cfg)).filter((f) => f.includes("loadout-backup"))).toEqual([]);
    expect(existsSync(disabledMcpPath(h))).toBe(false);

    rmSync(h, { recursive: true, force: true });
  });

  it("disabling an MCP server removes it from config.toml and enabling restores it", () => {
    const home = mkdtempSync(path.join(tmpdir(), "loadout-codex-mcp-"));
    const configPath = path.join(home, ".codex", "config.toml");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, '[mcp_servers.fixture]\ncommand = "node"\n');

    const item = {
      id: `codex:mcp:global:${configPath}:fixture`,
      machineId: "m",
      tool: "codex" as const,
      kind: "mcp" as const,
      name: "fixture",
      enabled: true,
      path: configPath,
      scope: "global" as const,
      projectPath: null,
      sourceType: "manual" as const,
      sourceRef: null,
      contentBackupId: null,
      lastSyncedAt: new Date().toISOString()
    };

    applyToggle(item, false, home);
    expect(readFileSync(configPath, "utf8")).not.toContain("mcp_servers.fixture");

    applyToggle(item, true, home);
    expect(readFileSync(configPath, "utf8")).toContain("mcp_servers.fixture");

    rmSync(home, { recursive: true, force: true });
  });

  // Symmetric with the claude_code mutator's removeItem: a server removed while disabled
  // still has its config parked in the shared store, and leaving it there would make the
  // next scan report the item straight back as a disabled row. Seed the store directly
  // (rather than going through applyToggle) so this test proves removeItem's own cleanup
  // regardless of applyToggle's behaviour.
  it("removing an MCP server that is currently disabled also clears its parked-store entry", () => {
    const home = mkdtempSync(path.join(tmpdir(), "loadout-codex-mcp-rm-"));
    const configPath = path.join(home, ".codex", "config.toml");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, "");
    writeDisabledMcp(home, { [disabledMcpKey(configPath, "fixture")]: { command: "node" } });

    const item = {
      id: `codex:mcp:global:${configPath}:fixture`,
      machineId: "m",
      tool: "codex" as const,
      kind: "mcp" as const,
      name: "fixture",
      enabled: false,
      path: configPath,
      scope: "global" as const,
      projectPath: null,
      sourceType: "manual" as const,
      sourceRef: null,
      contentBackupId: null,
      lastSyncedAt: new Date().toISOString()
    };

    removeItem(item, home);

    expect(readDisabledMcp(home)).toEqual({});

    rmSync(home, { recursive: true, force: true });
  });
});
