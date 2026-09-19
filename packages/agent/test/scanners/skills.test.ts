import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, lstatSync, statSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanSkills } from "../../src/scanners/skills";
import { applyToggle, removeItem } from "../../src/mutators/skills";
import { skillParkDir } from "../../src/skills/store";

let home: string;
afterEach(() => rmSync(home, { recursive: true, force: true }));

function writeSkill(dir: string, name: string, frontmatter = name): void {
  mkdirSync(path.join(dir, name), { recursive: true });
  writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${frontmatter}\n---\n`);
}

describe("scanSkills", () => {
  it("emits one item for a skill that lives in both .agents and .claude, with a canonical id", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-skills-merge-"));
    writeSkill(path.join(home, ".agents", "skills"), "shared");
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeSkill(path.join(home, ".claude", "skills"), "shared");

    const items = scanSkills({ homeDir: home, registeredProjectPaths: [] });
    const shared = items.filter((i) => path.basename(i.path) === "shared");
    expect(shared).toHaveLength(1);
    expect(shared[0].id).toBe(`skill:global:${path.join(home, ".agents", "skills", "shared")}`);
    expect(shared[0].harnesses).toEqual(["claude_code"]);
    expect(shared[0].path).toBe(path.join(home, ".agents", "skills", "shared"));
  });

  it("does not duplicate a Claude-only skill; next enable parks against the canonical path", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-skills-claude-only-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeSkill(path.join(home, ".claude", "skills"), "only-cc");

    const items = scanSkills({ homeDir: home, registeredProjectPaths: [] });
    expect(items).toHaveLength(1);
    expect(items[0].harnesses).toEqual(["claude_code"]);
    expect(items[0].id).toContain(`${path.join(home, ".agents", "skills", "only-cc")}`);
  });

  it("enable of an already-enabled native-only skill adopts it into .agents and projects back", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-skills-adopt-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeSkill(path.join(home, ".claude", "skills"), "only-cc");
    const item = scanSkills({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "only-cc")!;
    expect(item.enabled).toBe(true);

    applyToggle(item, true, home);

    expect(existsSync(path.join(home, ".agents", "skills", "only-cc", "SKILL.md"))).toBe(true);
    const native = path.join(home, ".claude", "skills", "only-cc");
    expect(existsSync(path.join(native, "SKILL.md"))).toBe(true);
    expect(lstatSync(native).isSymbolicLink()).toBe(true);
  });

  it("skips a dangling symlink and still reports healthy skills", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-skills-dangling-"));
    const skillsDir = path.join(home, ".agents", "skills");
    writeSkill(skillsDir, "healthy-skill");
    symlinkSync(path.join(home, "does", "not", "exist"), path.join(skillsDir, "broken-skill"));

    const items = scanSkills({ homeDir: home, registeredProjectPaths: [] });
    expect(items.map((i) => i.name)).toContain("healthy-skill");
    expect(items.map((i) => i.name)).not.toContain("broken-skill");
  });
});

describe("skill toggle parks in the loadout store", () => {
  it("disable moves the canonical dir into ~/.loadout/disabled-skills, not a Codex TOML flag", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-skills-park-"));
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeSkill(path.join(home, ".agents", "skills"), "s1");

    const item = scanSkills({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "s1")!;
    applyToggle(item, false, home);

    expect(existsSync(path.join(home, ".agents", "skills", "s1"))).toBe(false);
    expect(existsSync(path.join(skillParkDir({ homeDir: home, scope: "global", projectPath: null, name: "s1" }), "SKILL.md"))).toBe(true);
    expect(scanSkills({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "s1")).toMatchObject({
      enabled: false,
      id: item.id
    });

    applyToggle(item, true, home);
    expect(existsSync(path.join(home, ".agents", "skills", "s1", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(home, ".claude", "skills", "s1", "SKILL.md"))).toBe(true);
  });

  it("parks disabled-skills as owner-only (0700), not world-traversable", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-skills-mode-"));
    writeSkill(path.join(home, ".agents", "skills"), "s1");
    const item = scanSkills({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "s1")!;
    applyToggle(item, false, home);
    const parked = skillParkDir({ homeDir: home, scope: "global", projectPath: null, name: "s1" });
    expect(statSync(parked).mode & 0o777).toBe(0o700);
    expect(statSync(path.dirname(parked)).mode & 0o777).toBe(0o700);
  });

  it("disable backups a distinct native skill directory instead of deleting it", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-skills-native-keep-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeSkill(path.join(home, ".agents", "skills"), "s1");
    writeSkill(path.join(home, ".claude", "skills"), "s1");
    writeFileSync(path.join(home, ".agents", "skills", "s1", "SKILL.md"), "---\nname: s1\n---\ncanonical\n");
    writeFileSync(path.join(home, ".claude", "skills", "s1", "SKILL.md"), "---\nname: s1\n---\nuser-edit\n");
    const item = scanSkills({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "s1")!;
    applyToggle(item, false, home);

    const parked = skillParkDir({ homeDir: home, scope: "global", projectPath: null, name: "s1" });
    expect(readFileSync(path.join(parked, "SKILL.md"), "utf8")).toContain("canonical");

    const native = path.join(home, ".claude", "skills", "s1");
    expect(existsSync(native)).toBe(false);

    const backupRoot = path.join(home, ".claude", ".loadout-backups");
    const backups = existsSync(backupRoot) ? readdirSync(backupRoot) : [];
    expect(backups.length).toBeGreaterThan(0);
    const preserved = backups.some((name) =>
      existsSync(path.join(backupRoot, name, "SKILL.md")) &&
      readFileSync(path.join(backupRoot, name, "SKILL.md"), "utf8").includes("user-edit")
    );
    expect(preserved).toBe(true);
  });

  it("remove deletes live copies and the park, behind a backup", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-skills-rm-"));
    writeSkill(path.join(home, ".agents", "skills"), "s1");
    const item = scanSkills({ homeDir: home, registeredProjectPaths: [] }).find((i) => i.name === "s1")!;
    removeItem(item, home);
    expect(existsSync(path.join(home, ".agents", "skills", "s1"))).toBe(false);
    expect(scanSkills({ homeDir: home, registeredProjectPaths: [] }).map((i) => i.name)).not.toContain("s1");
  });
});
