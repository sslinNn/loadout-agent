// packages/agent/src/scanners/snapshot.ts
import type { Snapshot } from "@loadout/shared";
import { scanClaudeCode } from "./claudeCode.js";
import { scanCodex } from "./codex.js";
import { readLocalConfig } from "../localConfig.js";

export function buildSnapshot(opts: { machineId: string; homeDir: string }): Snapshot {
  const { registeredProjectPaths } = readLocalConfig();
  const items = [
    ...scanClaudeCode({ homeDir: opts.homeDir, registeredProjectPaths }),
    ...scanCodex({ homeDir: opts.homeDir, registeredProjectPaths })
  ].map((item) => ({ ...item, machineId: opts.machineId }));
  return { machineId: opts.machineId, items };
}
