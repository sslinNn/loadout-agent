import * as log from "./log.js";
import { readPackageVersion } from "./version.js";
import { hasPendingConfirmations } from "./installer/confirm.js";

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Pure decision of whether `run` should exit right now to let the service manager restart it
 * onto newer code. Pulled out of the timer loop below so the three conditions — actually
 * changed, supervised, nothing in flight — can be tested directly without touching real
 * timers or the filesystem.
 */
export function shouldExitForUpgrade(params: {
  startVersion: string;
  currentVersion: string;
  supervised: boolean;
  pending: boolean;
}): boolean {
  return params.supervised && params.startVersion !== params.currentVersion && !params.pending;
}

export interface UpgradeWatchOptions {
  /** Only set true by the generated systemd unit / launchd plist (`--supervised`). A plain
   * `loadout run` in a terminal must never self-exit on upgrade — nothing would bring it back. */
  supervised: boolean;
  intervalMs?: number;
  /** Injectable seams for tests; default to the real package.json / confirm.ts state. */
  readVersion?: () => string;
  hasPending?: () => boolean;
  exit?: (code: number) => void;
}

/**
 * `readPackageVersion()` re-reads package.json from disk on every call, but this process's own
 * module code is already loaded into memory — `npm install -g` swapping the files on disk
 * changes nothing about what this running process executes. Comparing the version captured at
 * start against a fresh read is the only signal the daemon has that it's now stale; exiting
 * (only when supervised, and never mid-confirmation) is what lets systemd's `Restart=always` /
 * launchd's `KeepAlive` actually re-exec it onto the new bundle. This is the fix for the
 * incident where a service had been running 0.0.7 for a day after 0.1.0 was installed.
 */
export function startUpgradeWatch(opts: UpgradeWatchOptions): { stop: () => void } {
  const readVersion = opts.readVersion ?? readPackageVersion;
  const hasPending = opts.hasPending ?? hasPendingConfirmations;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const startVersion = readVersion();

  const timer = setInterval(() => {
    // `npm install -g` replaces the whole package directory, so a read timed into the middle
    // of an upgrade can hit a missing or half-written package.json. Throwing here would take
    // the daemon down from inside a timer callback — the next tick sees the settled version.
    let currentVersion: string;
    try {
      currentVersion = readVersion();
    } catch {
      return;
    }
    if (currentVersion === startVersion) return;

    if (hasPending()) {
      log.info(
        `upgrade detected (${startVersion} -> ${currentVersion}) but a confirmation is still pending; ` +
          "deferring the restart rather than abandoning a half-finished install"
      );
      return;
    }

    if (!shouldExitForUpgrade({ startVersion, currentVersion, supervised: opts.supervised, pending: false })) {
      // Not supervised: log once so an unsupervised `loadout run` at least explains why it's
      // still on old code, then stop checking — the version won't change again mid-run.
      log.info(`upgrade detected (${startVersion} -> ${currentVersion}) but not running supervised; staying up`);
      clearInterval(timer);
      return;
    }

    log.info(`upgrade detected (${startVersion} -> ${currentVersion}); exiting for the service manager to restart`);
    clearInterval(timer);
    exit(0);
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return { stop: () => clearInterval(timer) };
}
