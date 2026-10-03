import { describe, it, expect, vi, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  approvePending,
  listPending,
  requestLocalConfirmation,
  setConfirmationListener,
  startConfirmationServer,
  stopConfirmationServer
} from "../../src/installer/confirm";

vi.mock("../../src/installer/prompt", () => ({ promptWithButtons: vi.fn(() => vi.fn()) }));

const socketPath = path.join(os.tmpdir(), `loadout-pending-test-${process.pid}.sock`);

describe("pending confirmations over the socket", () => {
  afterEach(() => {
    setConfirmationListener(null);
    stopConfirmationServer();
  });

  it("lists what is waiting, and forgets it once answered", async () => {
    await startConfirmationServer(socketPath);
    expect(await listPending(socketPath)).toEqual([]);

    const decision = requestLocalConfirmation({ id: "p-1", description: "Install foo (global)" }, { socketPath });
    await new Promise((r) => setTimeout(r, 10));
    const waiting = await listPending(socketPath);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ id: "p-1", description: "Install foo (global)" });

    await approvePending("p-1", socketPath);
    await expect(decision).resolves.toBe(true);
    expect(await listPending(socketPath)).toEqual([]);
  });

  it("tells a listener when a confirmation starts and ends", async () => {
    await startConfirmationServer(socketPath);
    const events: string[] = [];
    setConfirmationListener(({ phase, approved }) => events.push(phase + (approved === undefined ? "" : `:${approved}`)));
    const decision = requestLocalConfirmation({ id: "p-2", description: "Install bar" }, { socketPath, timeoutMs: 30 });
    await expect(decision).resolves.toBe(false);
    expect(events).toEqual(["waiting", "resolved:false"]);
  });
});
