import type { Snapshot } from "@loadout/shared";
import { scanSkills } from "./skills.js";
import { scanMcp } from "./mcp.js";
import { readLocalConfig } from "../localConfig.js";

export function buildSnapshot(opts: { machineId: string; homeDir: string }): Snapshot {
  const { registeredProjectPaths } = readLocalConfig();
  const items = [
    ...scanSkills({ homeDir: opts.homeDir, registeredProjectPaths }),
    ...scanMcp({ homeDir: opts.homeDir, registeredProjectPaths })
  ].map((item) => ({ ...item, machineId: opts.machineId }));
  return { machineId: opts.machineId, items };
}
