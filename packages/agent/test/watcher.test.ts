// packages/agent/test/watcher.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startWatcher } from "../src/watcher";

let handle: { stop: () => void } | undefined;
afterEach(() => handle?.stop());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A skill directory with enough files in it that moving it aside emits a burst of events. */
function writeSkill(skillsDir: string, name: string): string {
  const dir = path.join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
  for (const sub of ["a", "b", "c", "d", "e"]) {
    mkdirSync(path.join(dir, sub));
    writeFileSync(path.join(dir, sub, "ref.md"), "x");
  }
  return dir;
}

describe("startWatcher", () => {
  it("calls onSnapshot when a skill file is added under the watched home dir", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loadout-watch-"));
    const skillsDir = path.join(dir, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });

    const onSnapshot = vi.fn();
    handle = startWatcher({ machineId: "machine-1", homeDir: dir, onSnapshot, periodicRescanMs: 60 * 60 * 1000 });

    await new Promise((r) => setTimeout(r, 200)); // let chokidar finish its initial ready scan
    mkdirSync(path.join(skillsDir, "new-skill"));
    writeFileSync(path.join(skillsDir, "new-skill", "SKILL.md"), "---\nname: new-skill\n---\n");

    await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalled(), { timeout: 3000 });
    rmSync(dir, { recursive: true, force: true });
  });

  // Regression guard: the machine id used to come from a LOADOUT_MACHINE_ID env var that
  // nothing in the codebase ever set, so every watcher-driven rescan produced a snapshot
  // (and therefore installed_items rows) tagged machine_id "unknown".
  it("stamps rescan snapshots with the machineId it was given, not a placeholder", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loadout-watch-id-"));
    const skillsDir = path.join(dir, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });

    const onSnapshot = vi.fn();
    handle = startWatcher({
      machineId: "8f1c2d3e-real-machine-id",
      homeDir: dir,
      onSnapshot,
      periodicRescanMs: 60 * 60 * 1000
    });

    await new Promise((r) => setTimeout(r, 200));
    mkdirSync(path.join(skillsDir, "another-skill"));
    writeFileSync(path.join(skillsDir, "another-skill", "SKILL.md"), "---\nname: another-skill\n---\n");

    await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalled(), { timeout: 3000 });
    const snapshot = onSnapshot.mock.calls.at(-1)![0];
    expect(snapshot.machineId).toBe("8f1c2d3e-real-machine-id");
    expect(snapshot.items.every((i: { machineId: string }) => i.machineId === "8f1c2d3e-real-machine-id")).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  // Regression guard: every chokidar event used to trigger its own full rescan + sync. One
  // dashboard toggle is a directory rename (see mutators/claudeCode.ts), and chokidar reports
  // a rename of a 6-file skill as 12 separate events — so a single click produced 12 full
  // snapshot syncs, each rewriting every row of the machine's inventory.
  it("coalesces a burst of file events into one rescan", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loadout-watch-burst-"));
    const skillsDir = path.join(dir, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    const skill = writeSkill(skillsDir, "noisy");

    const onSnapshot = vi.fn();
    // chokidar spreads the 12 events of one rename over a few tens of milliseconds, so the
    // debounce window has to outlast that burst — the production default is 400ms.
    handle = startWatcher({ machineId: "m1", homeDir: dir, onSnapshot, periodicRescanMs: 60 * 60 * 1000, debounceMs: 200 });

    await sleep(300); // let chokidar finish its initial ready scan
    renameSync(skill, path.join(dir, ".claude", "moved-aside"));

    await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalled(), { timeout: 3000 });
    await sleep(500); // give any un-coalesced follow-up events time to land
    expect(onSnapshot).toHaveBeenCalledTimes(1);

    rmSync(dir, { recursive: true, force: true });
  });

  // The sync a rescan kicks off is asynchronous (a series of Supabase writes). Nothing used
  // to wait for it, so a burst started N of them concurrently and they raced: whichever
  // finished last won, regardless of which snapshot was newest.
  it("never runs two syncs concurrently, and re-runs once for events seen during one", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loadout-watch-serial-"));
    const skillsDir = path.join(dir, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });

    let inFlight = 0;
    let maxInFlight = 0;
    const onSnapshot = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(200);
      inFlight -= 1;
    });
    handle = startWatcher({ machineId: "m1", homeDir: dir, onSnapshot, periodicRescanMs: 60 * 60 * 1000, debounceMs: 20 });

    await sleep(300);
    writeSkill(skillsDir, "first");
    await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(1), { timeout: 3000 });

    // Land a second change while the first sync is still in flight.
    writeSkill(skillsDir, "second");
    await sleep(600);

    expect(maxInFlight).toBe(1);
    expect(onSnapshot).toHaveBeenCalledTimes(2);

    rmSync(dir, { recursive: true, force: true });
  });
});
