import { describe, it, expect, vi, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { confirmationsSuspendedUntil, MAX_SUSPEND_MINUTES } from "../src/localConfig";
import { requestLocalConfirmation, setSuspensionSourceForTests, stopConfirmationServer } from "../src/installer/confirm";

vi.mock("../src/installer/prompt", () => ({ promptWithButtons: vi.fn(() => vi.fn()) }));

const now = Date.parse("2026-10-03T12:00:00Z");
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const base = { registeredProjectPaths: [] };

describe("confirmationsSuspendedUntil", () => {
  it("is on by default and after the window ends", () => {
    expect(confirmationsSuspendedUntil(base, now)).toBeNull();
    expect(confirmationsSuspendedUntil({ ...base, confirmationsSuspendedUntil: at(-1) }, now)).toBeNull();
  });
  it("reports a live window", () => {
    expect(confirmationsSuspendedUntil({ ...base, confirmationsSuspendedUntil: at(30) }, now)?.toISOString()).toBe(at(30));
  });
  it("ignores a window longer than the cap — there is no permanent off", () => {
    expect(confirmationsSuspendedUntil({ ...base, confirmationsSuspendedUntil: at(MAX_SUSPEND_MINUTES + 120) }, now)).toBeNull();
    expect(confirmationsSuspendedUntil({ ...base, confirmationsSuspendedUntil: "garbage" }, now)).toBeNull();
  });
});

describe("requestLocalConfirmation while suspended", () => {
  afterEach(() => {
    setSuspensionSourceForTests(() => null);
    stopConfirmationServer();
  });

  it("approves without asking", async () => {
    setSuspensionSourceForTests(() => new Date(Date.now() + 60_000));
    const socketPath = path.join(os.tmpdir(), `loadout-suspend-${process.pid}.sock`);
    await expect(requestLocalConfirmation({ id: "s1", description: "Install x" }, { socketPath, timeoutMs: 20 })).resolves.toBe(true);
  });

  it("asks again once the window is over", async () => {
    setSuspensionSourceForTests(() => null);
    const socketPath = path.join(os.tmpdir(), `loadout-suspend2-${process.pid}.sock`);
    await expect(requestLocalConfirmation({ id: "s2", description: "Install x" }, { socketPath, timeoutMs: 20 })).resolves.toBe(false);
  });
});
