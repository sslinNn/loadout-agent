// packages/agent/src/watcher.ts
import chokidar from "chokidar";
import path from "node:path";
import type { Snapshot } from "@loadout/shared";
import { buildSnapshot } from "./scanners/snapshot.js";
import { readLocalConfig } from "./localConfig.js";
import { codexConfigPath, codexGlobalSkillsDir } from "./scanners/codex.js";
import * as log from "./log.js";

/**
 * How long to wait for a burst of filesystem events to go quiet before rescanning.
 *
 * A single user-visible action is never a single event. Disabling a skill from the dashboard
 * moves its whole directory aside (see ../mutators/claudeCode.ts), and chokidar reports that
 * rename as one event PER contained file and subdirectory — 12 for a six-file skill, ~190 for
 * a skill the size of `impeccable`. Every one of those used to run its own full scan and its
 * own full Supabase sync.
 */
const DEFAULT_DEBOUNCE_MS = 400;

export function startWatcher(opts: {
  // The paired machine's real id (see ~/.loadout/credentials.json, written by
  // `loadout-agent pair`). Required and explicit: this used to read an env var that nothing
  // ever set, so every watcher-triggered rescan wrote rows with machine_id "unknown".
  machineId: string;
  homeDir: string;
  // Returning a promise is what lets the watcher serialise syncs: it awaits this before
  // starting the next one, so two snapshots of the same machine can never be written
  // concurrently (and therefore can never land out of order).
  onSnapshot: (s: Snapshot) => void | Promise<void>;
  periodicRescanMs?: number;
  debounceMs?: number;
}): { stop: () => void } {
  const watchedPaths = () => [
    path.join(opts.homeDir, ".claude", "skills"),
    // Codex's real locations, derived from the scanner so the two can't drift apart.
    codexGlobalSkillsDir(opts.homeDir),
    codexConfigPath(opts.homeDir),
    ...readLocalConfig().registeredProjectPaths.flatMap((p) => [
      path.join(p, ".claude", "skills"),
      path.join(p, ".mcp.json"),
      path.join(p, ".agents", "skills")
    ])
  ];

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  // Set when an event arrives while a sync is in flight. That sync is already reading stale
  // disk state, so it cannot be the last word — exactly one more rescan runs after it, no
  // matter how many events arrived in the meantime.
  let rescanAgain = false;
  let stopped = false;

  async function runRescan(): Promise<void> {
    if (running) {
      rescanAgain = true;
      return;
    }
    running = true;
    try {
      do {
        rescanAgain = false;
        try {
          await opts.onSnapshot(buildSnapshot({ machineId: opts.machineId, homeDir: opts.homeDir }));
        } catch (err) {
          // A failed sync must not strand the loop: `running` has to be cleared and a
          // queued rescan still has to happen, or the watcher goes deaf for good.
          log.error("rescan failed:", err);
        }
      } while (rescanAgain && !stopped);
    } finally {
      running = false;
    }
  }

  const schedule = () => {
    if (stopped) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void runRescan(), opts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  };

  const watcher = chokidar.watch(watchedPaths(), { ignoreInitial: true, persistent: true });
  watcher.on("add", schedule).on("unlink", schedule).on("change", schedule).on("addDir", schedule).on("unlinkDir", schedule);

  // The periodic sweep catches anything the watcher missed (a path that did not exist when
  // chokidar started, an event dropped by the OS). It needs no debounce, but it goes through
  // the same guard so it can never overlap a watcher-driven sync.
  const interval = setInterval(() => void runRescan(), opts.periodicRescanMs ?? 10 * 60 * 1000);

  return {
    stop: () => {
      stopped = true;
      clearTimeout(debounceTimer);
      clearInterval(interval);
      void watcher.close();
    }
  };
}
