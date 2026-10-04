import type { SupabaseClient } from "@supabase/supabase-js";
import type { InstalledItem, RealtimeCommand } from "@loadout/shared";
import { toInstalledItem } from "@loadout/shared";
import { applyInstallCommand } from "./installer/command.js";
import { restoreSnapshot } from "./installer/restore.js";
import { applyToggle, removeItem } from "./mutators/dispatch.js";
import { captureContentBackup, backupContentFor } from "./contentBackup.js";
import { readLocalConfig } from "./localConfig.js";
import * as log from "./log.js";

/** What happened to one command — what the queue writes back as its final status. */
export interface CommandOutcome {
  status: "done" | "failed" | "denied";
  detail?: string;
}

export interface CommandContext {
  client: SupabaseClient;
  machineId: string;
}

function logError(operation: string, error: unknown): void {
  if (error) log.error(`${operation} failed:`, error);
}

// Best-effort content backup of a manual item, taken immediately before an irreversible
// removal. Opt-in (`loadout content-backups on`), and only for source_type "manual" items,
// which are precisely the ones that have no source to re-install from.
async function maybeCaptureContentBackup(client: SupabaseClient, item: InstalledItem): Promise<void> {
  if (!readLocalConfig().contentBackupsEnabled) return;
  if (item.sourceType !== "manual") return;

  const content = backupContentFor(item);
  if (content === null) {
    log.warn(`content backup skipped for ${item.name}: nothing to capture`);
    return;
  }

  try {
    const { fields } = await captureContentBackup(client, item, content);
    log.info(
      `content backup captured for ${item.name}` +
        (fields.length ? ` (redacted ${fields.length} possible secret field(s); redaction is best-effort)` : "")
    );
  } catch (err) {
    logError(`content backup for ${item.name}`, err);
  }
}

async function loadItem(ctx: CommandContext, itemId: string): Promise<InstalledItem | null> {
  // `installed_items` is keyed on (machine_id, id): the scanner-derived id is path-based and
  // so is NOT unique across a user's machines. Every lookup pins machine_id to THIS machine —
  // without it, a command naming an id that also exists on a sibling machine could read,
  // mutate or delete that other machine's row.
  const { data: row, error } = await ctx.client
    .from("installed_items")
    .select("*")
    .eq("machine_id", ctx.machineId)
    .eq("id", itemId)
    .maybeSingle();
  logError(`select installed_items ${itemId}`, error);
  return row ? toInstalledItem(row) : null;
}

/**
 * Carry out one dashboard command on this machine and say how it ended. Never throws: a
 * failure is an outcome, so the queue can report it and the daemon keeps running.
 */
export async function executeCommand(command: RealtimeCommand, ctx: CommandContext): Promise<CommandOutcome> {
  try {
    if (command.type === "toggle") {
      const item = await loadItem(ctx, command.itemId);
      if (!item) return { status: "failed", detail: "that item is no longer recorded for this machine" };
      applyToggle(item, command.enabled);
      return { status: "done", detail: `${item.name} ${command.enabled ? "enabled" : "disabled"}` };
    }

    if (command.type === "remove") {
      const item = await loadItem(ctx, command.itemId);
      if (!item) return { status: "failed", detail: "that item is no longer recorded for this machine" };
      await maybeCaptureContentBackup(ctx.client, item);
      removeItem(item);
      const { error } = await ctx.client
        .from("installed_items")
        .delete()
        .eq("machine_id", ctx.machineId)
        .eq("id", command.itemId);
      logError(`delete installed_items ${command.itemId}`, error);
      return { status: "done", detail: `${item.name} removed` };
    }

    if (command.type === "restore") {
      const results = await restoreSnapshot(command.items);
      const { error } = await ctx.client.from("restore_results").insert(
        results.map((r) => ({
          machine_id: ctx.machineId,
          item_name: r.item.name,
          installed: r.installed,
          reason: r.reason ?? null
        }))
      );
      logError("insert restore_results", error);
      if (results.length > 0 && results.every((r) => r.reason === "denied")) return { status: "denied" };
      const installed = results.filter((r) => r.installed).length;
      return { status: "done", detail: `${installed} installed, ${results.length - installed} skipped` };
    }

    const outcome = await applyInstallCommand(command, ctx);
    if (outcome.installed) {
      return { status: "done", detail: outcome.commit ? `installed at ${outcome.commit.slice(0, 12)}` : "installed" };
    }
    return outcome.reason === "denied" ? { status: "denied" } : { status: "failed", detail: outcome.reason };
  } catch (err) {
    logError(`command ${command.type}`, err);
    return { status: "failed", detail: (err as Error).message ?? String(err) };
  }
}

/**
 * Run tasks one at a time, in arrival order. Commands from the queue and from broadcasts
 * both go through one of these: two installs racing each other would each ask for
 * confirmation at once, and a status written for one could describe the other.
 */
export function createSerialRunner(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>) => {
    const next = tail.then(task, task);
    tail = next.catch(() => undefined);
    return next;
  };
}
