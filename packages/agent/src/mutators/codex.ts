import os from "node:os";
import type { InstalledItem } from "@loadout/shared";
import { codexConfigPath } from "../harnesses/codex.js";

export { applyToggle, removeItem } from "./dispatch.js";

export function resolveConfigPath(item: InstalledItem, homeDir: string = os.homedir()): string {
  return item.kind === "mcp" ? item.path : codexConfigPath(homeDir);
}
