import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as confirmModule from "../../src/installer/confirm";
import { installGeneric } from "../../src/installer/generic";

// A gitClone stand-in that materialises a repository at destDir. Every test in this file
// passes one: installGeneric now clones BEFORE asking for confirmation, so a case that
// omitted it would shell out to the real `git clone` and hit the network.
function fakeClone(files: Record<string, string>) {
  return vi.fn(async (_ref: string, destDir: string) => {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(path.join(destDir, path.dirname(rel)), { recursive: true });
      writeFileSync(path.join(destDir, rel), body);
    }
    return destDir;
  });
}

const BARE_SKILL = { "SKILL.md": "---\nname: skill\n---\n" };

describe("installGeneric", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("does not touch disk if local confirmation is denied", async () => {
    vi.spyOn(confirmModule, "requestLocalConfirmation").mockResolvedValue(false);
    const home = mkdtempSync(path.join(tmpdir(), "loadout-install-denied-"));
    const clone = fakeClone(BARE_SKILL);

    const result = await installGeneric(
      { type: "git", ref: "https://github.com/example/skill.git" },
      { tool: "claude_code", kind: "skill", scope: "global", projectPath: null, homeDir: home },
      { gitClone: clone }
    );

    expect(result).toEqual({ installed: false, reason: "denied" });
    // The clone lands in a temp directory; nothing may reach the install destination.
    expect(existsSync(path.join(home, ".claude"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  it("runs the appropriate fetch strategy once confirmed", async () => {
    vi.spyOn(confirmModule, "requestLocalConfirmation").mockResolvedValue(true);
    const home = mkdtempSync(path.join(tmpdir(), "loadout-install-strategy-"));
    const clone = fakeClone(BARE_SKILL);

    const result = await installGeneric(
      { type: "git", ref: "https://github.com/example/skill.git" },
      { tool: "claude_code", kind: "skill", scope: "global", projectPath: null, homeDir: home },
      { gitClone: clone }
    );

    expect(clone).toHaveBeenCalledTimes(1);
    const [clonedRef, clonedDest] = clone.mock.calls[0];
    expect(clonedRef).toBe("https://github.com/example/skill.git");
    // Cloned to a scratch directory, not straight onto the destination.
    expect(clonedDest.startsWith(path.join(home, ".claude"))).toBe(false);
    expect(result).toMatchObject({ installed: true, path: path.join(home, ".claude", "skills", "skill") });
    rmSync(home, { recursive: true, force: true });
  });

  it("installs a skill into the tool's skills directory (claude_code -> .claude/skills, codex -> .agents/skills)", async () => {
    vi.spyOn(confirmModule, "requestLocalConfirmation").mockResolvedValue(true);
    const proj = mkdtempSync(path.join(tmpdir(), "loadout-install-proj-"));

    const codex = await installGeneric(
      { type: "git", ref: "https://github.com/example/skill.git" },
      { tool: "codex", kind: "skill", scope: "project", projectPath: proj },
      { gitClone: fakeClone(BARE_SKILL) }
    );
    expect(codex).toMatchObject({ installed: true, path: path.join(proj, ".agents", "skills", "skill") });

    const claudeCode = await installGeneric(
      { type: "git", ref: "https://github.com/example/skill.git" },
      { tool: "claude_code", kind: "skill", scope: "project", projectPath: proj },
      { gitClone: fakeClone(BARE_SKILL) }
    );
    expect(claudeCode).toMatchObject({ installed: true, path: path.join(proj, ".claude", "skills", "skill") });

    rmSync(proj, { recursive: true, force: true });
  });

  it("refuses an unimplemented source type without prompting", async () => {
    const confirm = vi.spyOn(confirmModule, "requestLocalConfirmation").mockResolvedValue(true);
    const result = await installGeneric(
      { type: "npm", ref: "some-package" },
      { tool: "claude_code", kind: "skill", scope: "global", projectPath: null }
    );
    expect(result).toEqual({ installed: false, reason: "source type npm is not supported yet" });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("refuses an mcp target without prompting", async () => {
    const confirm = vi.spyOn(confirmModule, "requestLocalConfirmation").mockResolvedValue(true);
    const result = await installGeneric(
      { type: "git", ref: "https://github.com/example/server.git" },
      { tool: "claude_code", kind: "mcp", scope: "global", projectPath: null }
    );
    expect(result.installed).toBe(false);
    expect(result.reason).toContain("mcp");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("skipConfirmation installs without asking, for an interactive CLI invocation", async () => {
    const confirm = vi.spyOn(confirmModule, "requestLocalConfirmation");
    const home = mkdtempSync(path.join(tmpdir(), "loadout-install-skip-"));

    const result = await installGeneric(
      { type: "git", ref: "https://github.com/example/skill.git" },
      { tool: "claude_code", kind: "skill", scope: "global", projectPath: null, homeDir: home },
      { gitClone: fakeClone(BARE_SKILL), skipConfirmation: true }
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(result).toMatchObject({ installed: true, path: path.join(home, ".claude", "skills", "skill") });
    rmSync(home, { recursive: true, force: true });
  });

  describe("installing from inside a repository", () => {
    let home: string;
    beforeEach(() => {
      home = mkdtempSync(path.join(tmpdir(), "loadout-install-"));
      vi.spyOn(confirmModule, "requestLocalConfirmation").mockResolvedValue(true);
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    // A gitClone stand-in that materialises a plugin-shaped repository at destDir.
    const fakePluginClone = fakeClone;

    it("installs only the named subdirectory, named after that subdirectory", async () => {
      const clone = fakePluginClone({
        "README.md": "# plugin",
        "skills/cc-limits/SKILL.md": "---\nname: cc-limits\n---\n",
        "skills/other/SKILL.md": "---\nname: other\n---\n"
      });

      const result = await installGeneric(
        { type: "git", ref: "https://github.com/sslinNn/cc-limits", subdir: "skills/cc-limits" },
        { tool: "claude_code", kind: "skill", scope: "global", projectPath: null, homeDir: home },
        { gitClone: clone }
      );

      const installed = path.join(home, ".claude", "skills", "cc-limits");
      expect(result).toMatchObject({ installed: true, path: installed });
      expect(readFileSync(path.join(installed, "SKILL.md"), "utf8")).toContain("name: cc-limits");
      expect(existsSync(path.join(home, ".claude", "skills", "other"))).toBe(false);
      expect(existsSync(path.join(home, ".claude", "skills", "README.md"))).toBe(false);
    });

    it("refuses when the named subdirectory is not in the repository", async () => {
      const clone = fakePluginClone({ "skills/present/SKILL.md": "---\nname: present\n---\n" });

      const result = await installGeneric(
        { type: "git", ref: "https://github.com/sslinNn/cc-limits", subdir: "skills/absent" },
        { tool: "claude_code", kind: "skill", scope: "global", projectPath: null, homeDir: home },
        { gitClone: clone }
      );

      expect(result.installed).toBe(false);
      expect(result.reason).toContain("skills/absent");
      expect(existsSync(path.join(home, ".claude", "skills"))).toBe(false);
    });

    it("refuses when the resolved directory has no SKILL.md", async () => {
      const clone = fakePluginClone({ "skills/cc-limits/README.md": "not a skill" });

      const result = await installGeneric(
        { type: "git", ref: "https://github.com/sslinNn/cc-limits", subdir: "skills/cc-limits" },
        { tool: "claude_code", kind: "skill", scope: "global", projectPath: null, homeDir: home },
        { gitClone: clone }
      );

      expect(result.installed).toBe(false);
      expect(result.reason).toContain("SKILL.md");
    });

    it("refuses a subdirectory that escapes the repository", async () => {
      const clone = fakePluginClone({ "skills/x/SKILL.md": "---\nname: x\n---\n" });

      const result = await installGeneric(
        { type: "git", ref: "https://github.com/sslinNn/cc-limits", subdir: "../../../etc" },
        { tool: "claude_code", kind: "skill", scope: "global", projectPath: null, homeDir: home },
        { gitClone: clone }
      );

      expect(result.installed).toBe(false);
      expect(result.reason).toContain("outside");
    });

    it("refuses rather than clobbering a skill that is already installed", async () => {
      const existing = path.join(home, ".claude", "skills", "cc-limits");
      mkdirSync(existing, { recursive: true });
      writeFileSync(path.join(existing, "SKILL.md"), "---\nname: mine\n---\n");

      const clone = fakePluginClone({ "skills/cc-limits/SKILL.md": "---\nname: theirs\n---\n" });

      const result = await installGeneric(
        { type: "git", ref: "https://github.com/sslinNn/cc-limits", subdir: "skills/cc-limits" },
        { tool: "claude_code", kind: "skill", scope: "global", projectPath: null, homeDir: home },
        { gitClone: clone }
      );

      expect(result.installed).toBe(false);
      expect(result.reason).toContain("already");
      expect(readFileSync(path.join(existing, "SKILL.md"), "utf8")).toContain("name: mine");
    });

    // Without a subdirectory the destination is still named after the repository, not after
    // the scratch directory the clone happens to land in.
    it("names the destination after the repository when no subdirectory is given", async () => {
      const result = await installGeneric(
        { type: "git", ref: "https://github.com/example/my-skill.git" },
        { tool: "claude_code", kind: "skill", scope: "global", projectPath: null, homeDir: home },
        { gitClone: fakeClone(BARE_SKILL) }
      );

      expect(result).toMatchObject({ installed: true, path: path.join(home, ".claude", "skills", "my-skill") });
    });

    it("keeps .git out of the installed copy", async () => {
      const clone = fakePluginClone({
        "skills/cc-limits/SKILL.md": "---\nname: cc-limits\n---\n",
        "skills/cc-limits/.git/config": "[core]\n"
      });

      const result = await installGeneric(
        { type: "git", ref: "https://github.com/sslinNn/cc-limits", subdir: "skills/cc-limits" },
        { tool: "claude_code", kind: "skill", scope: "global", projectPath: null, homeDir: home },
        { gitClone: clone }
      );

      expect(result.installed).toBe(true);
      expect(existsSync(path.join(home, ".claude", "skills", "cc-limits", ".git"))).toBe(false);
    });
  });
});
