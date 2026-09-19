import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { InstalledItem, RealtimeCommand } from "@loadout/shared";
import { toInstalledItemRow } from "@loadout/shared";
import { installGeneric } from "./generic.js";
import { supabaseConnection } from "../config.js";
import type { Credentials } from "../localConfig.js";
import * as log from "../log.js";

export type InstallCommand = Extract<RealtimeCommand, { type: "install" }>;

function logError(operation: string, error: unknown): void {
  if (error) log.error(`${operation} failed:`, error);
}

/**
 * The row the install path writes immediately after files land. Scanners cannot observe
 * provenance on disk (they hardcode sourceType "manual"), so this is what makes the item
 * restorable. The id matches the scanners' deterministic shape so the next snapshot lands
 * on THIS row; upsertSnapshot then refuses to overwrite source_type/source_ref/source_subdir.
 */
export function installedItemFromInstall(opts: {
  outcomePath: string;
  machineId: string;
  kind: InstalledItem["kind"];
  scope: InstalledItem["scope"];
  projectPath: string | null;
  sourceType: InstalledItem["sourceType"];
  sourceRef: string;
  sourceSubdir: string | null;
}): InstalledItem {
  const name = path.basename(opts.outcomePath);
  return {
    id:
      opts.kind === "mcp"
        ? opts.scope === "project" && opts.projectPath
          ? `mcp:project:${opts.projectPath}:${name}`
          : `mcp:global:${name}`
        : `${opts.kind}:${opts.scope}:${opts.outcomePath}`,
    machineId: opts.machineId,
    harnesses: [],
    kind: opts.kind,
    name,
    enabled: true,
    path:
      opts.kind === "mcp"
        ? opts.scope === "project" && opts.projectPath
          ? `project::${opts.projectPath}::${name}`
          : `global::${name}`
        : opts.outcomePath,
    scope: opts.scope,
    projectPath: opts.projectPath,
    sourceType: opts.sourceType,
    sourceRef: opts.sourceRef,
    sourceSubdir: opts.sourceSubdir,
    contentBackupId: null,
    lastSyncedAt: new Date().toISOString()
  };
}

/**
 * One-shot PostgREST client that uses the stored access token and does NOT call setSession.
 * `loadout install` can run while `loadout run` already holds the same credentials file;
 * rotating the refresh token here would silently unpair the daemon.
 */
export function clientFromStoredAccessToken(creds: Credentials): SupabaseClient {
  const { url, anonKey } = supabaseConnection();
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${creds.accessToken}` } }
  });
}

export async function recordInstallProvenance(client: SupabaseClient, item: InstalledItem): Promise<void> {
  const { error } = await client
    .from("installed_items")
    .upsert(toInstalledItemRow(item), { onConflict: "machine_id,id" });
  logError(`insert installed_items for installed ${item.sourceRef}`, error);
}

/**
 * Apply a dashboard/realtime install command. Confirmation is REQUIRED: a cloud command is
 * new code arriving on the machine, unlike an interactive `loadout install` the user typed.
 */
export async function applyInstallCommand(
  command: InstallCommand,
  ctx: { client: SupabaseClient; machineId: string }
): Promise<void> {
  // installGeneric's InstallSource.type is "git" | "npm" | "url" (see ./generic.ts), narrower
  // than the command's sourceType ("manual" | "git" | "npm" | "marketplace"). "git"/"npm"
  // pass through; anything else is fetched as a plain URL.
  const sourceType: "git" | "npm" | "url" =
    command.sourceType === "git" || command.sourceType === "npm" ? command.sourceType : "url";
  const outcome = await installGeneric(
    { type: sourceType, ref: command.sourceRef, subdir: command.sourceSubdir ?? null },
    { kind: command.kind, scope: command.scope, projectPath: command.projectPath }
  );
  if (!outcome.installed || !outcome.path) {
    log.info(`install of ${command.sourceRef} did not complete: ${outcome.reason ?? "unknown"}`);
    return;
  }

  await recordInstallProvenance(
    ctx.client,
    installedItemFromInstall({
      outcomePath: outcome.path,
      machineId: ctx.machineId,
      kind: command.kind,
      scope: command.scope,
      projectPath: command.projectPath,
      sourceType: command.sourceType,
      sourceRef: command.sourceRef,
      sourceSubdir: command.sourceSubdir ?? null
    })
  );

  if (command.listingId) {
    const { error: installsError } = await ctx.client.from("installs").upsert(
      { listing_id: command.listingId, machine_id: ctx.machineId },
      { onConflict: "listing_id,machine_id" }
    );
    logError(`insert installs row for listing ${command.listingId}`, installsError);
  }
}
