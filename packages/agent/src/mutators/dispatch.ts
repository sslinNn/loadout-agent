import os from "node:os";
import type { InstalledItem } from "@loadout/shared";
import * as skills from "./skills.js";
import * as mcp from "./mcp.js";

export function applyToggle(item: InstalledItem, enabled: boolean, homeDir: string = os.homedir()): void {
  if (item.kind === "mcp") mcp.applyToggle(item, enabled, homeDir);
  else skills.applyToggle(item, enabled, homeDir);
}

export function removeItem(item: InstalledItem, homeDir: string = os.homedir()): void {
  if (item.kind === "mcp") mcp.removeItem(item, homeDir);
  else skills.removeItem(item, homeDir);
}
