import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RealtimeCommand } from "@loadout/shared";
import { startCommandQueue } from "../src/queue";
import { createSerialRunner, type CommandOutcome } from "../src/commandRunner";
import * as confirm from "../src/installer/confirm";

type Row = Record<string, unknown> & { id: string; status: string };

/** Just enough of supabase-js's query builder over an in-memory machine_commands table. */
function fakeClient(rows: Row[]) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  let onInsert: (() => void) | null = null;
  let onStatus: ((s: string) => void) | null = null;

  function query() {
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Record<string, unknown> | null = null;
    let wantRows = false;
    let limit = Infinity;
    const run = () => {
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      if (patch) {
        for (const r of matched) {
          Object.assign(r, patch);
          updates.push({ id: r.id, patch });
        }
        return { data: wantRows ? matched.map((r) => ({ id: r.id })) : null, error: null };
      }
      return { data: matched.slice(0, limit), error: null };
    };
    const builder: Record<string, unknown> = {
      select: () => ((wantRows = true), builder),
      update: (p: Record<string, unknown>) => ((patch = p), builder),
      eq: (col: string, value: unknown) => (filters.push((r) => r[col] === value), builder),
      in: (col: string, values: unknown[]) => (filters.push((r) => values.includes(r[col])), builder),
      order: () => builder,
      limit: (n: number) => ((limit = n), builder),
      then: (resolve: (v: unknown) => void) => resolve(run())
    };
    return builder;
  }

  const client = {
    from: () => query(),
    channel: () => {
      const ch = {
        on: (_t: string, _f: unknown, cb: () => void) => ((onInsert = cb), ch),
        subscribe: (cb: (s: string) => void) => ((onStatus = cb), ch)
      };
      return ch;
    },
    removeChannel: vi.fn(async () => "ok")
  } as unknown as SupabaseClient;
  return { client, updates, insert: () => onInsert?.(), subscribed: () => onStatus?.("SUBSCRIBED") };
}

const toggle: RealtimeCommand = { type: "toggle", itemId: "x", enabled: false };

function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    machine_id: "m1",
    command: toggle,
    status: "pending",
    detail: null,
    created_at: "2026-10-03T00:00:00Z",
    updated_at: "2026-10-03T00:00:00Z",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides
  };
}

describe("command queue", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("runs what was queued while offline, and reports how it ended", async () => {
    const rows = [row("c1"), row("c2")];
    const fake = fakeClient(rows);
    const execute = vi
      .fn<(c: RealtimeCommand) => Promise<CommandOutcome>>()
      .mockResolvedValueOnce({ status: "done", detail: "x disabled" })
      .mockResolvedValueOnce({ status: "failed", detail: "gone" });
    const queue = startCommandQueue({ client: fake.client, machineId: "m1", execute, serialize: createSerialRunner(), intervalMs: 1e9 });
    await queue.drain();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(rows.map((r) => [r.status, r.detail])).toEqual([
      ["done", "x disabled"],
      ["failed", "gone"]
    ]);
    await queue.stop();
  });

  it("never runs a command another daemon already claimed", async () => {
    const rows = [row("c1")];
    const fake = fakeClient(rows);
    const execute = vi.fn(async () => ({ status: "done" as const }));
    // Another daemon claims it after this one read the queue and before its claim lands:
    // the claim is conditional on status = pending, so it must match nothing.
    const original = fake.client.from;
    (fake.client as unknown as { from: () => unknown }).from = () => {
      const q = original.call(fake.client, "machine_commands") as Record<string, unknown>;
      const update = q.update as (p: Record<string, unknown>) => unknown;
      q.update = (patch: Record<string, unknown>) => {
        if (patch.status === "running") rows[0].status = "running";
        return update(patch);
      };
      return q;
    };
    const queue = startCommandQueue({ client: fake.client, machineId: "m1", execute, serialize: createSerialRunner(), intervalMs: 1e9 });
    await queue.drain();
    expect(execute).not.toHaveBeenCalled();
    await queue.stop();
  });

  it("expires what waited too long, and fails what does not parse, without running either", async () => {
    const rows = [row("old", { expires_at: "2020-01-01T00:00:00Z" }), row("bad", { command: { type: "format c:" } })];
    const fake = fakeClient(rows);
    const execute = vi.fn();
    const queue = startCommandQueue({ client: fake.client, machineId: "m1", execute, serialize: createSerialRunner(), intervalMs: 1e9 });
    await queue.drain();
    expect(execute).not.toHaveBeenCalled();
    expect(rows.map((r) => r.status)).toEqual(["expired", "failed"]);
    await queue.stop();
  });

  it("closes commands an earlier daemon left half-done", async () => {
    const rows = [row("stuck", { status: "awaiting_approval" })];
    const fake = fakeClient(rows);
    const queue = startCommandQueue({ client: fake.client, machineId: "m1", execute: vi.fn(), serialize: createSerialRunner(), intervalMs: 1e9 });
    await queue.drain();
    expect(rows[0]).toMatchObject({ status: "failed", detail: expect.stringMatching(/interrupted/) });
    await queue.stop();
  });

  it("reports awaiting_approval while a confirmation waits", async () => {
    const rows = [row("c1")];
    const fake = fakeClient(rows);
    let listener: Parameters<typeof confirm.setConfirmationListener>[0] = null;
    vi.spyOn(confirm, "setConfirmationListener").mockImplementation((l) => {
      listener = l;
    });
    const seen: string[] = [];
    const execute = vi.fn(async () => {
      listener?.({ phase: "waiting", action: { id: "1", description: "Install x" } });
      await new Promise((r) => setTimeout(r, 0));
      seen.push(rows[0].status);
      listener?.({ phase: "resolved", action: { id: "1", description: "Install x" }, approved: true });
      return { status: "done" as const };
    });
    const queue = startCommandQueue({ client: fake.client, machineId: "m1", execute, serialize: createSerialRunner(), intervalMs: 1e9 });
    await queue.drain();
    expect(seen).toEqual(["awaiting_approval"]);
    expect(rows[0].status).toBe("done");
    await queue.stop();
  });

  it("drains again when a new row arrives", async () => {
    const rows: Row[] = [];
    const fake = fakeClient(rows);
    const execute = vi.fn(async () => ({ status: "done" as const }));
    const queue = startCommandQueue({ client: fake.client, machineId: "m1", execute, serialize: createSerialRunner(), intervalMs: 1e9 });
    await queue.drain();
    rows.push(row("late"));
    fake.insert();
    await queue.drain();
    expect(execute).toHaveBeenCalledTimes(1);
    await queue.stop();
  });
});

describe("createSerialRunner", () => {
  it("runs tasks one at a time, in order, even when one fails", async () => {
    const run = createSerialRunner();
    const log: string[] = [];
    const a = run(async () => {
      await new Promise((r) => setTimeout(r, 10));
      log.push("a");
      throw new Error("a failed");
    });
    const b = run(async () => {
      log.push("b");
      return 2;
    });
    await expect(a).rejects.toThrow("a failed");
    await expect(b).resolves.toBe(2);
    expect(log).toEqual(["a", "b"]);
  });
});
