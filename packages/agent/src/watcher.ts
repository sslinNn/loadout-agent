import chokidar from "chokidar";
import type { Snapshot } from "@loadout/shared";
import { buildSnapshot } from "./scanners/snapshot.js";
import { readLocalConfig } from "./localConfig.js";
import { allWatchPaths } from "./harnesses/registry.js";
import { agentsSkillsDir, skillParkRoot } from "./skills/store.js";
import { disabledMcpPath } from "./mcpStore.js";
import * as log from "./log.js";

const DEFAULT_DEBOUNCE_MS = 400;

export function startWatcher(opts: {
  machineId: string;
  homeDir: string;
  onSnapshot: (s: Snapshot) => void | Promise<void>;
  periodicRescanMs?: number;
  debounceMs?: number;
}): { stop: () => void } {
  const watchedPaths = () => {
    const projectPaths = readLocalConfig().registeredProjectPaths;
    return [
      agentsSkillsDir(opts.homeDir),
      skillParkRoot(opts.homeDir),
      disabledMcpPath(opts.homeDir),
      ...allWatchPaths({ homeDir: opts.homeDir, projectPaths }),
      ...projectPaths.map((p) => agentsSkillsDir(p))
    ];
  };

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
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
