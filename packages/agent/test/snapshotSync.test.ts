// packages/agent/test/snapshotSync.test.ts
//
// Covers the daemon's installed_items reconciliation (packages/agent/src/cli.ts's
// upsertSnapshot) against a recording fake Supabase client. Three behaviours are load-
// bearing and each one is a bug this review wave found:
//   C3 — every Supabase call's `error` must be surfaced, never discarded.
//   C6 — a re-scan must NOT overwrite an installed item's recorded provenance
//        (source_type/source_ref) back to the scanners' hardcoded "manual".
//   I5 — rows for items no longer on disk must be deleted... but an empty scan (which is
//        indistinguishable from a transient scan failure) must never wipe the inventory.
// Plus one regression a later re-review found: because a scanner id is path-derived and has
// no machine component, every write must be keyed on (machine_id, id), never on id alone.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { InstalledItem, Snapshot } from "@loadout/shared";
import { toInstalledItemRow } from "@loadout/shared";
import { upsertSnapshot } from "../src/cli";

interface Call { op: string; table: string; payload?: unknown; options?: unknown; filters: Array<[string, unknown]> }

function fakeClient(opts: { existingIds?: string[]; existingRows?: Record<string, unknown>[]; errors?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const errors = opts.errors ?? {};

  const client = {
    from(table: string) {
      const call: Call = { op: "", table, filters: [] };
      const builder: Record<string, unknown> = {
        select(_cols?: string) {
          call.op = "select";
          calls.push(call);
          return builder;
        },
        upsert(payload: unknown, options?: unknown) {
          call.op = "upsert";
          call.payload = payload;
          call.options = options;
          calls.push(call);
          return builder;
        },
        update(payload: unknown) {
          call.op = "update";
          call.payload = payload;
          calls.push(call);
          return builder;
        },
        delete() {
          call.op = "delete";
          calls.push(call);
          return builder;
        },
        eq(col: string, val: unknown) {
          call.filters.push([`eq:${col}`, val]);
          return builder;
        },
        in(col: string, vals: unknown) {
          call.filters.push([`in:${col}`, vals]);
          return builder;
        },
        then(onFulfilled: (r: unknown) => unknown) {
          // A select now reads the whole row, so the sync can tell a changed item from an
          // unchanged one. `existingIds` stays supported for the cases that only care that
          // a row exists: an id-only row differs from any real snapshot row, which is
          // exactly the "something changed, write it" path those tests assert.
          const data =
            call.op === "select" ? (opts.existingRows ?? (opts.existingIds ?? []).map((id) => ({ id }))) : null;
          return Promise.resolve({ data, error: errors[call.op] ?? null }).then(onFulfilled);
        }
      };
      return builder;
    }
  };

  return { client: client as never, calls };
}

const item = (over: Partial<InstalledItem> = {}): InstalledItem => ({
  id: "claude_code:skill:global:/home/u/.claude/skills/a",
  machineId: "m1",
  tool: "claude_code",
  kind: "skill",
  name: "a",
  enabled: true,
  path: "/home/u/.claude/skills/a",
  scope: "global",
  projectPath: null,
  sourceType: "manual",
  sourceRef: null,
  contentBackupId: null,
  lastSyncedAt: "2026-01-01T00:00:00.000Z",
  ...over
});

const snapshot = (items: InstalledItem[]): Snapshot => ({ machineId: "m1", items });

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  infoSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("upsertSnapshot", () => {
  it("inserts a never-before-seen item as a full snake_case row", async () => {
    const { client, calls } = fakeClient({ existingIds: [] });
    await upsertSnapshot(client, snapshot([item()]));

    const upsert = calls.find((c) => c.op === "upsert")!;
    expect((upsert.payload as unknown[])[0]).toMatchObject({
      id: "claude_code:skill:global:/home/u/.claude/skills/a",
      machine_id: "m1",
      project_path: null,
      source_type: "manual",
      last_synced_at: "2026-01-01T00:00:00.000Z"
    });
  });

  // A first sync after pairing used to be one HTTP round-trip per item, in series — 57
  // requests on the machine this was found on. PostgREST takes the whole set at once.
  it("inserts every new item in a single request", async () => {
    const { client, calls } = fakeClient({ existingIds: [] });
    const items = ["a", "b", "c"].map((n) =>
      item({ id: `claude_code:skill:global:/home/u/.claude/skills/${n}`, name: n, path: `/home/u/.claude/skills/${n}` })
    );
    await upsertSnapshot(client, snapshot(items));

    const upserts = calls.filter((c) => c.op === "upsert");
    expect(upserts).toHaveLength(1);
    expect(upserts[0].payload).toHaveLength(3);
  });

  // The storm this whole change exists to kill: `last_synced_at` is stamped fresh by every
  // scan, so re-writing it made EVERY row of the inventory a real change on EVERY rescan —
  // one Supabase write and one Postgres Changes broadcast per item, per event, forever.
  // An item whose disk state has not moved is not news; say nothing about it.
  it("writes nothing at all for an item whose disk state is unchanged", async () => {
    const existing = item();
    const onDisk = item({ lastSyncedAt: "2026-06-06T12:00:00.000Z" }); // a later scan, same disk
    const { client, calls } = fakeClient({ existingRows: [toInstalledItemRow(existing)] });
    await upsertSnapshot(client, snapshot([onDisk]));

    expect(calls.some((c) => c.op === "update")).toBe(false);
    expect(calls.some((c) => c.op === "upsert")).toBe(false);
    expect(calls.some((c) => c.op === "delete")).toBe(false);
  });

  it("still updates an item when a disk-observable field really did change", async () => {
    const existing = item({ enabled: true });
    const onDisk = item({ enabled: false, lastSyncedAt: "2026-06-06T12:00:00.000Z" });
    const { client, calls } = fakeClient({ existingRows: [toInstalledItemRow(existing)] });
    await upsertSnapshot(client, snapshot([onDisk]));

    const update = calls.find((c) => c.op === "update")!;
    expect(update.payload).toMatchObject({ enabled: false, last_synced_at: "2026-06-06T12:00:00.000Z" });
  });

  it("updates an item whose name changed even though its id and path did not", async () => {
    const existing = item({ name: "a" });
    const onDisk = item({ name: "renamed-in-frontmatter" });
    const { client, calls } = fakeClient({ existingRows: [toInstalledItemRow(existing)] });
    await upsertSnapshot(client, snapshot([onDisk]));

    expect(calls.find((c) => c.op === "update")!.payload).toMatchObject({ name: "renamed-in-frontmatter" });
  });

  // C6: the scanners can't know provenance from disk alone, so they always say "manual".
  // A re-scan that upserted the whole row would erase the source_type/source_ref the
  // install path recorded, making every freshly-installed item unrestorable again.
  it("does not overwrite source_type/source_ref when re-syncing an item it has seen before", async () => {
    const existing = item();
    const { client, calls } = fakeClient({ existingIds: [existing.id] });
    await upsertSnapshot(client, snapshot([existing]));

    expect(calls.some((c) => c.op === "upsert")).toBe(false);
    const update = calls.find((c) => c.op === "update")!;
    expect(update.payload).not.toHaveProperty("source_type");
    expect(update.payload).not.toHaveProperty("source_ref");
    expect(update.payload).not.toHaveProperty("content_backup_id");
    // disk-observable state IS still refreshed
    expect(update.payload).toMatchObject({ enabled: true, path: existing.path, name: "a" });
    expect(update.filters).toContainEqual(["eq:id", existing.id]);
  });

  // C-composite-key: the scanners derive an item's id from its PATH alone, so two of one
  // user's machines with the same home layout produce the SAME id. installed_items is
  // therefore keyed on (machine_id, id) — and every write has to say so, or machine B's
  // sync rewrites machine A's row and the item ping-pongs between inventories forever.
  it("scopes a first-time insert's conflict target to (machine_id, id)", async () => {
    const { client, calls } = fakeClient({ existingIds: [] });
    await upsertSnapshot(client, snapshot([item()]));

    const upsert = calls.find((c) => c.op === "upsert")!;
    expect(upsert.options).toEqual({ onConflict: "machine_id,id" });
  });

  it("pins a re-sync update to this machine, never to the bare id", async () => {
    const existing = item();
    const { client, calls } = fakeClient({ existingIds: [existing.id] });
    await upsertSnapshot(client, snapshot([existing]));

    const update = calls.find((c) => c.op === "update")!;
    expect(update.filters).toContainEqual(["eq:machine_id", "m1"]);
    expect(update.filters).toContainEqual(["eq:id", existing.id]);
  });

  // I5
  it("deletes rows for items that are no longer on disk", async () => {
    const kept = item();
    const { client, calls } = fakeClient({ existingIds: [kept.id, "claude_code:skill:global:/gone"] });
    await upsertSnapshot(client, snapshot([kept]));

    const del = calls.find((c) => c.op === "delete")!;
    expect(del.filters).toContainEqual(["eq:machine_id", "m1"]);
    expect(del.filters).toContainEqual(["in:id", ["claude_code:skill:global:/gone"]]);
  });

  it("never deletes anything when the scan produced zero items (a possible scan failure)", async () => {
    const { client, calls } = fakeClient({ existingIds: ["claude_code:skill:global:/a", "claude_code:skill:global:/b"] });
    await upsertSnapshot(client, snapshot([]));

    expect(calls.some((c) => c.op === "delete")).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
  });

  // The daemon logged only failures, so there was no way to tell a working sync from one
  // that never ran — which is exactly the question the toggle storm raised. A rescan that
  // wrote something says so, in one line, naming what it wrote.
  it("reports what a rescan actually wrote", async () => {
    const existing = item({ enabled: true });
    const { client } = fakeClient({ existingRows: [toInstalledItemRow(existing)] });
    await upsertSnapshot(client, snapshot([item({ enabled: false })]));

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0].join(" ")).toMatch(/1 changed \(a\)/);
  });

  it("counts a first sync's inserts and a vanished item's deletion in the same line", async () => {
    const gone = item({ id: "claude_code:skill:global:/gone", name: "gone", path: "/gone" });
    const { client } = fakeClient({ existingRows: [toInstalledItemRow(gone)] });
    await upsertSnapshot(client, snapshot([item(), item({ id: "x", name: "b", path: "/b" })]));

    const line = infoSpy.mock.calls[0].join(" ");
    expect(line).toMatch(/2 added/);
    expect(line).toMatch(/1 removed \(gone\)/);
  });

  // The whole point: a quiet rescan is the common case (every file event in a burst, every
  // periodic sweep) and must not turn the log into the noise the writes used to be.
  it("says nothing at all when a rescan found nothing to write", async () => {
    const { client } = fakeClient({ existingRows: [toInstalledItemRow(item())] });
    await upsertSnapshot(client, snapshot([item({ lastSyncedAt: "2026-06-06T12:00:00.000Z" })]));

    expect(infoSpy).not.toHaveBeenCalled();
  });

  // C3
  it("logs, rather than silently swallowing, a write error", async () => {
    const { client } = fakeClient({ existingIds: [], errors: { upsert: { message: "invalid input syntax for type uuid" } } });
    await upsertSnapshot(client, snapshot([item()]));

    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls[0].join(" ")).toMatch(/upsert installed_items .* failed/);
  });
});
