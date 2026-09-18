import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shouldExitForUpgrade, startUpgradeWatch } from "../src/upgradeWatch";
import * as log from "../src/log";

describe("shouldExitForUpgrade", () => {
  it("exits when supervised, the version changed, and nothing is pending", () => {
    expect(
      shouldExitForUpgrade({ startVersion: "0.0.7", currentVersion: "0.1.0", supervised: true, pending: false })
    ).toBe(true);
  });

  it("does not exit when the version has not changed", () => {
    expect(
      shouldExitForUpgrade({ startVersion: "0.1.0", currentVersion: "0.1.0", supervised: true, pending: false })
    ).toBe(false);
  });

  it("does not exit when not supervised, even if the version changed", () => {
    expect(
      shouldExitForUpgrade({ startVersion: "0.0.7", currentVersion: "0.1.0", supervised: false, pending: false })
    ).toBe(false);
  });

  it("does not exit while a confirmation is pending, even when supervised and the version changed", () => {
    expect(
      shouldExitForUpgrade({ startVersion: "0.0.7", currentVersion: "0.1.0", supervised: true, pending: true })
    ).toBe(false);
  });
});

describe("startUpgradeWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(log, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("exits once supervised, the on-disk version changes, and nothing is pending", () => {
    let current = "0.0.7";
    const exit = vi.fn();
    const watch = startUpgradeWatch({
      supervised: true,
      intervalMs: 1000,
      readVersion: () => current,
      hasPending: () => false,
      exit
    });

    vi.advanceTimersByTime(999);
    expect(exit).not.toHaveBeenCalled();

    current = "0.1.0";
    vi.advanceTimersByTime(1000);
    expect(exit).toHaveBeenCalledWith(0);

    watch.stop();
  });

  // `npm install -g` swaps the package directory out from under the running daemon, so a tick
  // can land on a missing or half-written package.json. That read throws from inside a timer
  // callback, which would take the whole daemon down rather than merely delaying a restart.
  it("survives a read that throws mid-upgrade and acts on the next settled tick", () => {
    let read: () => string = () => "0.0.7";
    const exit = vi.fn();
    const watch = startUpgradeWatch({
      supervised: true,
      intervalMs: 1000,
      readVersion: () => read(),
      hasPending: () => false,
      exit
    });

    read = () => {
      throw new Error("ENOENT: package.json vanished mid-upgrade");
    };
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(exit).not.toHaveBeenCalled();

    read = () => "0.1.0";
    vi.advanceTimersByTime(1000);
    expect(exit).toHaveBeenCalledWith(0);

    watch.stop();
  });

  it("never exits when not supervised, no matter how many ticks see a changed version", () => {
    let current = "0.0.7";
    const exit = vi.fn();
    const watch = startUpgradeWatch({
      supervised: false,
      intervalMs: 1000,
      readVersion: () => current,
      hasPending: () => false,
      exit
    });

    current = "0.1.0";
    vi.advanceTimersByTime(5000);
    expect(exit).not.toHaveBeenCalled();

    watch.stop();
  });

  it("defers the restart while a confirmation is pending, and exits once it clears", () => {
    let current = "0.0.7";
    let pending = true;
    const exit = vi.fn();
    const watch = startUpgradeWatch({
      supervised: true,
      intervalMs: 1000,
      readVersion: () => current,
      hasPending: () => pending,
      exit
    });

    current = "0.1.0";
    vi.advanceTimersByTime(1000);
    expect(exit).not.toHaveBeenCalled();

    pending = false;
    vi.advanceTimersByTime(1000);
    expect(exit).toHaveBeenCalledWith(0);

    watch.stop();
  });

  it("stop() clears the timer so no further checks run", () => {
    let current = "0.0.7";
    const exit = vi.fn();
    const watch = startUpgradeWatch({
      supervised: true,
      intervalMs: 1000,
      readVersion: () => current,
      hasPending: () => false,
      exit
    });

    watch.stop();
    current = "0.1.0";
    vi.advanceTimersByTime(10_000);
    expect(exit).not.toHaveBeenCalled();
  });
});
