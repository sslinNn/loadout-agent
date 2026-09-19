import type { InstalledItem } from "@loadout/shared";
import { nextConfirmationId, requestLocalConfirmation } from "./confirm.js";
import { installGeneric, type InstallStrategies, type InstallTarget } from "./generic.js";
import * as log from "../log.js";

export type RestoreStrategies = InstallStrategies & Pick<InstallTarget, "homeDir">;

export async function restoreSnapshot(
  items: InstalledItem[],
  strategies: RestoreStrategies = {}
): Promise<Array<{ item: InstalledItem; installed: boolean; reason?: string }>> {
  const approved = await requestLocalConfirmation({
    id: nextConfirmationId(),
    description: `Restore ${items.length} item(s) from a snapshot to this machine`
  });
  if (!approved) {
    return items.map((item) => ({ item, installed: false, reason: "denied" }));
  }

  const results: Array<{ item: InstalledItem; installed: boolean; reason?: string }> = [];
  for (const item of items) {
    if (item.sourceType === "manual" || !item.sourceRef) {
      results.push({ item, installed: false, reason: "no_installable_source" });
      continue;
    }
    const sourceType = item.sourceType === "marketplace" ? "url" : (item.sourceType as "git" | "npm" | "url");
    try {
      const outcome = await installGeneric(
        { type: sourceType, ref: item.sourceRef, subdir: item.sourceSubdir ?? null },
        { kind: item.kind, scope: item.scope, projectPath: item.projectPath, homeDir: strategies.homeDir },
        { gitClone: strategies.gitClone, skipConfirmation: true }
      );
      results.push({ item, ...outcome });
    } catch (err) {
      log.error(`restore: failed to install ${item.name} (${item.sourceType}:${item.sourceRef})`, err);
      results.push({ item, installed: false, reason: (err as Error).message });
    }
  }
  return results;
}
