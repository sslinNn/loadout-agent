import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as confirmModule from "../../src/installer/confirm";
import { installGeneric, isAllowedGitRef } from "../../src/installer/generic";

const A = "a".repeat(40);
const B = "b".repeat(40);

function fakeClone() {
  return vi.fn(async (_ref: string, destDir: string, _commit?: string | null) => {
    mkdirSync(destDir, { recursive: true });
    writeFileSync(path.join(destDir, "SKILL.md"), "---\nname: s\n---\n");
    return destDir;
  });
}

describe("pinned-commit installs", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(confirmModule, "requestLocalConfirmation").mockResolvedValue(true);
  });

  it("asks the clone for the pinned commit and records what it got", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loadout-pin-"));
    const clone = fakeClone();
    const result = await installGeneric(
      { type: "git", ref: "https://github.com/o/s", commit: A },
      { kind: "skill", scope: "global", projectPath: null, homeDir: home },
      { gitClone: clone, resolveCommit: async () => A }
    );
    expect(clone.mock.calls[0][2]).toBe(A);
    expect(result).toMatchObject({ installed: true, commit: A });
    rmSync(home, { recursive: true, force: true });
  });

  it("refuses to install anything but the pinned commit", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loadout-pin-"));
    for (const resolved of [B, null]) {
      const result = await installGeneric(
        { type: "git", ref: "https://github.com/o/s", commit: A },
        { kind: "skill", scope: "global", projectPath: null, homeDir: home },
        { gitClone: fakeClone(), resolveCommit: async () => resolved }
      );
      expect(result.installed).toBe(false);
      expect(result.reason).toMatch(/expected commit aaaaaaaaaaaa/);
    }
    expect(existsSync(path.join(home, ".agents"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  it("records the resolved HEAD for an unpinned install", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loadout-pin-"));
    const result = await installGeneric(
      { type: "git", ref: "https://github.com/o/s" },
      { kind: "skill", scope: "global", projectPath: null, homeDir: home },
      { gitClone: fakeClone(), resolveCommit: async () => B }
    );
    expect(result).toMatchObject({ installed: true, commit: B });
    rmSync(home, { recursive: true, force: true });
  });

  it("refuses a malformed commit before cloning anything", async () => {
    const clone = fakeClone();
    const result = await installGeneric(
      { type: "git", ref: "https://github.com/o/s", commit: "main" },
      { kind: "skill", scope: "global", projectPath: null },
      { gitClone: clone }
    );
    expect(result.installed).toBe(false);
    expect(clone).not.toHaveBeenCalled();
  });
});

describe("isAllowedGitRef", () => {
  it("allows remote URLs", () => {
    for (const ref of ["https://github.com/o/r", "https://github.com/o/r.git", "git@github.com:o/r.git", "ssh://git@host/o/r"]) {
      expect(isAllowedGitRef(ref), ref).toBe(true);
    }
  });
  it("refuses local paths, file URLs, plain http and option-shaped refs", () => {
    for (const ref of ["/etc", "../x", "file:///etc", "http://github.com/o/r", "--upload-pack=touch /tmp/x", "ext::sh -c id"]) {
      expect(isAllowedGitRef(ref), ref).toBe(false);
    }
  });
});

// The git commands defaultGitClone runs for a pinned commit, against a local repository so
// no network is involved (installGeneric itself refuses file:// refs, hence driving git here).
describe("fetching a specific commit with git", () => {
  it("checks out exactly the requested commit", () => {
    const root = mkdtempSync(path.join(tmpdir(), "loadout-git-"));
    const origin = path.join(root, "origin");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
    mkdirSync(origin);
    git(origin, "init", "--quiet");
    writeFileSync(path.join(origin, "SKILL.md"), "v1");
    git(origin, "add", ".");
    git(origin, "commit", "--quiet", "-m", "v1");
    const first = git(origin, "rev-parse", "HEAD");
    writeFileSync(path.join(origin, "SKILL.md"), "v2");
    git(origin, "commit", "--quiet", "-am", "v2");
    git(origin, "config", "uploadpack.allowReachableSHA1InWant", "true");

    const dest = path.join(root, "dest");
    git(root, "init", "--quiet", dest);
    git(dest, "remote", "add", "origin", "--", `file://${origin}`);
    git(dest, "fetch", "--quiet", "--depth", "1", "origin", first);
    git(dest, "checkout", "--quiet", "--detach", "FETCH_HEAD");
    expect(git(dest, "rev-parse", "HEAD")).toBe(first);
    rmSync(root, { recursive: true, force: true });
  });
});
