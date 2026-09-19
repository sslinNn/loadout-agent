import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, lstatSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectSkill } from "../../src/skills/project";

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeSkill(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), "---\nname: s\n---\n");
  return dir;
}

describe("projectSkill", () => {
  it("symlinks the canonical skill into a native root", () => {
    root = mkdtempSync(path.join(tmpdir(), "loadout-proj-link-"));
    const canonical = writeSkill(path.join(root, "canonical", "s"));
    const destParent = path.join(root, "native");
    projectSkill(canonical, destParent);
    const dest = path.join(destParent, "s");
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(dest, "SKILL.md"))).toBe(true);
  });

  it("copies when symlink is refused", () => {
    root = mkdtempSync(path.join(tmpdir(), "loadout-proj-copy-"));
    const canonical = writeSkill(path.join(root, "canonical", "s"));
    const destParent = path.join(root, "native");
    projectSkill(canonical, destParent, () => {
      throw new Error("EPERM");
    });
    const dest = path.join(destParent, "s");
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(dest, "SKILL.md"), "utf8")).toContain("name: s");
  });

  it("does not replace a native skill directory with marketplace canonical content", () => {
    root = mkdtempSync(path.join(tmpdir(), "loadout-proj-keep-native-"));
    const canonical = writeSkill(path.join(root, "canonical", "s"));
    writeFileSync(path.join(canonical, "SKILL.md"), "---\nname: marketplace\n---\n");
    const destParent = path.join(root, "native");
    mkdirSync(path.join(destParent, "s"), { recursive: true });
    writeFileSync(path.join(destParent, "s", "SKILL.md"), "---\nname: user-edit\n---\n");

    projectSkill(canonical, destParent);

    expect(readFileSync(path.join(destParent, "s", "SKILL.md"), "utf8")).toContain("name: user-edit");
    expect(lstatSync(path.join(destParent, "s")).isSymbolicLink()).toBe(false);
  });
});
