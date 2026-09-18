import type { InstalledItem } from "@loadout/shared";
import { nextConfirmationId, requestLocalConfirmation } from "./confirm.js";
import { installGeneric } from "./generic.js";
import * as log from "../log.js";

export async function restoreSnapshot(
  items: InstalledItem[]
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
      // For manual items with a content_backup_id, Task 26's dashboard should instead
      // surface a "restore from backup" action that downloads+writes the backed-up file
      // directly (bypassing installGeneric, since there's no source to fetch) — out of
      // scope for this task's installer path but must not be silently dropped in the UI.
      continue;
    }
    const sourceType = item.sourceType === "marketplace" ? "url" : (item.sourceType as "git" | "npm" | "url");
    // Per-item isolation: installGeneric throws for source types it hasn't implemented yet
    // ("npm"/"url") and for unsupported targets (kind "mcp"), and a git clone can fail for
    // any number of ordinary reasons. Without this catch, one bad item aborted every
    // remaining item in the batch AND (because subscribeCommands calls the handler with a
    // floating promise) took the whole daemon down with an unhandled rejection.
    try {
      const outcome = await installGeneric(
        { type: sourceType, ref: item.sourceRef },
        { tool: item.tool, kind: item.kind, scope: item.scope, projectPath: item.projectPath }
      );
      results.push({ item, ...outcome });
    } catch (err) {
      log.error(`restore: failed to install ${item.name} (${item.sourceType}:${item.sourceRef})`, err);
      results.push({ item, installed: false, reason: (err as Error).message });
    }
  }
  return results;
}
