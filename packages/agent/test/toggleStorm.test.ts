// packages/agent/test/toggleStorm.test.ts
//
// End-to-end guard over the path a dashboard toggle actually takes: disk change -> chokidar
// -> watcher -> buildSnapshot -> upsertSnapshot. The unit tests pin each piece; this pins
// what they add up to, which is where the bug lived.
//
// Before this, disabling ONE skill cost: 12 chokidar events (one per contained file and
// directory) x 1 full rescan each x 1 write per item in the whole inventory — every one of
// which was also a Postgres Changes broadcast to every open dashboard. On a machine with 57
// skills and a skill the size of `impeccable` that is roughly 11,000 requests for one click.
// The whole point of the fix is that the number below is a small constant that does NOT
// grow with either the size of the toggled skill or the size of the inventory.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startWatcher } from "../src/watcher";
import { upsertSnapshot } from "../src/cli";
import { buildSnapshot } from "../src/scanners/snapshot";

let handle: { stop: () => void } | undefined;
afterEach(() => handle?.stop());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake PostgREST that actually stores rows, so "did anything change" is a real question. */
function fakeTable() {
  const rows = new Map<string, Record<string, unknown>>();
  const writes: Array<{ op: string; ids: string[] }> = [];

  const client = {
    from() {
      let op = "";
      let payload: Record<string, unknown> | Record<string, unknown>[] | null = null;
      const filters: Record<string, unknown> = {};
      let inIds: string[] = [];

      const builder: Record<string, unknown> = {
        select() {
          op = "select";
          return builder;
        },
        upsert(p: Record<string, unknown>[]) {
          op = "upsert";
          payload = p;
          return builder;
        },
        update(p: Record<string, unknown>) {
          op = "update";
          payload = p;
          return builder;
        },
        delete() {
          op = "delete";
          return builder;
        },
        eq(col: string, val: unknown) {
          filters[col] = val;
          return builder;
        },
        in(_col: string, vals: string[]) {
          inIds = vals;
          return builder;
        },
        then(onFulfilled: (r: unknown) => unknown) {
          if (op === "select") {
            return Promise.resolve({ data: [...rows.values()], error: null }).then(onFulfilled);
          }
          if (op === "upsert") {
            const list = payload as Record<string, unknown>[];
            list.forEach((r) => rows.set(r.id as string, { ...r }));
            writes.push({ op, ids: list.map((r) => r.id as string) });
          } else if (op === "update") {
            const id = filters.id as string;
            rows.set(id, { ...rows.get(id), ...(payload as Record<string, unknown>) });
            writes.push({ op, ids: [id] });
          } else if (op === "delete") {
            inIds.forEach((id) => rows.delete(id));
            writes.push({ op, ids: inIds });
          }
          return Promise.resolve({ data: null, error: null }).then(onFulfilled);
        }
      };
      return builder;
    }
  };

  return { client: client as never, rows, writes };
}

function writeSkill(skillsDir: string, name: string, extraFiles = 0): string {
  const dir = path.join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
  for (let i = 0; i < extraFiles; i++) {
    mkdirSync(path.join(dir, `ref${i}`));
    writeFileSync(path.join(dir, `ref${i}`, "doc.md"), "x");
  }
  return dir;
}

describe("one dashboard toggle", () => {
  it("costs one rescan and one row write, however many files the skill holds", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loadout-toggle-"));
    const skillsDir = path.join(home, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    const noisy = writeSkill(skillsDir, "noisy", 5); // 12 chokidar events when moved
    writeSkill(skillsDir, "quiet-one");
    writeSkill(skillsDir, "quiet-two");

    const { client, rows, writes } = fakeTable();

    // The daemon's own startup sync (see the `run` command in ../src/cli.ts).
    await upsertSnapshot(client, buildSnapshot({ machineId: "m1", homeDir: home }));
    expect(rows.size).toBe(3);
    expect(writes).toEqual([{ op: "upsert", ids: [...rows.keys()] }]); // one request, not three

    let rescans = 0;
    handle = startWatcher({
      machineId: "m1",
      homeDir: home,
      onSnapshot: async (s) => {
        rescans += 1;
        await upsertSnapshot(client, s);
      },
      periodicRescanMs: 60 * 60 * 1000,
      debounceMs: 200
    });
    await sleep(300);
    writes.length = 0;

    // Exactly what mutators/claudeCode.ts does to disable a skill.
    const disabledDir = path.join(home, ".claude", ".loadout-disabled");
    mkdirSync(disabledDir, { recursive: true });
    renameSync(noisy, path.join(disabledDir, "noisy"));

    await sleep(900);

    expect(rescans).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0].op).toBe("update");
    // The two untouched skills are not news and are not written; the toggled one is, and its
    // stored row now says so.
    expect(writes[0].ids).toEqual([`claude_code:skill:global:${path.join(skillsDir, "noisy")}`]);
    expect(rows.get(writes[0].ids[0])!.enabled).toBe(false);
    expect(rows.size).toBe(3); // the disabled skill is still inventoried, not deleted

    rmSync(home, { recursive: true, force: true });
  });
});
