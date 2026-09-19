import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { InstalledItem, RealtimeCommand, Snapshot } from "@loadout/shared";
import { toInstalledItem, toInstalledItemRow } from "@loadout/shared";
import { readLocalConfig, writeLocalConfig, writeCredentials, readCredentials } from "./localConfig.js";
import { requestPairingCode, pairAndRegisterMachine } from "./pairing.js";
import { supabaseConnection } from "./config.js";
import { approvePending, configureTrustWindow, denyPending, isSocketLive } from "./installer/confirm.js";
import { restoreSnapshot } from "./installer/restore.js";
import { installGeneric } from "./installer/generic.js";
import {
  applyInstallCommand,
  clientFromStoredAccessToken,
  installedItemFromInstall,
  recordInstallProvenance
} from "./installer/command.js";
import { createRealtimeClient } from "./realtime/client.js";
import { subscribeCommands } from "./realtime/commands.js";
import { startHeartbeat } from "./heartbeat.js";
import { startWatcher } from "./watcher.js";
import { buildSnapshot } from "./scanners/snapshot.js";
import { captureContentBackup, backupContentFor } from "./contentBackup.js";
import { readPackageVersion } from "./version.js";
import { startUpgradeWatch } from "./upgradeWatch.js";
import { installService, uninstallService, serviceStatus } from "./service/index.js";
import * as log from "./log.js";
import { applyToggle, removeItem } from "./mutators/dispatch.js";

// Row mappers (snake_case PostgREST ↔ camelCase InstalledItem) live in @loadout/shared.

// Every Supabase call in this daemon used to discard `{ error }`. Combined with a schema
// mismatch or an RLS denial that meant the agent ran, wrote nothing, logged nothing, and
// the dashboard silently never updated. Log loudly, but never throw: one item's failed
// write must not abort a whole snapshot sync or kill the daemon.
function logError(operation: string, error: unknown): void {
  if (error) log.error(`${operation} failed:`, error);
}

// The columns a scan can actually observe on disk, and therefore the only ones worth
// comparing to decide whether a rescan has anything to say about an item.
//
// `last_synced_at` is deliberately NOT in this list even though a rescan does write it: the
// scanners stamp it with `new Date()`, so including it would make every item differ from its
// stored row on every single scan — which is precisely the bug this guards against.
const DISK_OBSERVABLE_COLUMNS = ["harnesses", "kind", "name", "enabled", "path", "scope", "project_path"] as const;

function sameDiskValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, i) => value === b[i]);
  }
  return a === b;
}

function diskStateMatches(existing: Record<string, unknown>, row: ReturnType<typeof toInstalledItemRow>): boolean {
  return DISK_OBSERVABLE_COLUMNS.every((col) =>
    sameDiskValue(existing[col], (row as Record<string, unknown>)[col])
  );
}

/**
 * One line per rescan that changed something, silent for one that did not.
 *
 * The daemon used to log only failures, which left "the sync is working" and "the sync never
 * ran" looking identical from outside — the exact ambiguity that made the write storm hard
 * to see. Names are included while there are few enough to be worth reading; past that the
 * count is the useful part.
 */
function reportSync(groups: { added: string[]; changed: string[]; removed: string[] }): void {
  const parts = (Object.entries(groups) as Array<[keyof typeof groups, string[]]>)
    .filter(([, names]) => names.length > 0)
    .map(([label, names]) => {
      const listed = names.length <= 3 ? ` (${names.join(", ")})` : "";
      return `${names.length} ${label}${listed}`;
    });
  if (parts.length > 0) log.info(`snapshot sync: ${parts.join(", ")}`);
}

/**
 * Reconcile the `installed_items` rows for one machine against a freshly-scanned snapshot.
 *
 * Three behaviours here are deliberate and load-bearing:
 *
 * 0. An unchanged item is not written. A rescan is triggered by any event anywhere in the
 *    watched trees, and re-stamping `last_synced_at` on every item of every scan turned each
 *    one into a real row change — a Supabase write AND a Postgres Changes broadcast to every
 *    open dashboard, times the whole inventory, times every event in a burst. So
 *    `last_synced_at` now moves only when something about the item on disk actually moved;
 *    "is this machine's agent still alive and scanning" is what `machines.last_seen_at`
 *    (written by the heartbeat) answers, and it answers it in one row rather than N.
 *
 * 1. Provenance is write-once. The scanners cannot know where an item on disk came from, so
 *    they hardcode `sourceType: "manual"`. If a re-scan upserted the whole row it would
 *    overwrite the correct `source_type`/`source_ref`/`source_subdir` that the install path
 *    recorded (see the "install" branch below), turning every restorable item back into an
 *    unrestorable "manual" one on the next file-watcher tick. So: INSERT the full row the
 *    first time an id is seen, and on later scans UPDATE only the disk-observable columns.
 * 2. Stale rows are deleted. An item removed from disk by hand (outside a dashboard
 *    "remove" command) would otherwise linger in the table forever.
 *
 * Every write below is keyed on (machine_id, id), never on id alone. The scanners derive an
 * item's id from its PATH, with no machine component, so two of one user's machines with the
 * same home layout mint identical ids — `.eq("id", ...)` alone would let machine B's sync
 * silently rewrite machine A's row (and vice versa on A's next scan, forever). The table's
 * primary key is the matching composite (see the migration), which is also what makes
 * `onConflict: "machine_id,id"` resolve to an upsert instead of a unique violation.
 */
export async function upsertSnapshot(client: SupabaseClient, snapshot: Snapshot): Promise<void> {
  // The whole row, not just its id: without the stored values there is nothing to compare a
  // freshly-scanned item against, and every scan has to assume everything changed.
  const { data: existingRows, error: selectError } = await client
    .from("installed_items")
    .select("*")
    .eq("machine_id", snapshot.machineId);
  logError("select installed_items", selectError);

  const existingById = new Map(
    ((existingRows ?? []) as Record<string, unknown>[]).map((r) => [r.id as string, r])
  );
  const snapshotIds = new Set(snapshot.items.map((i) => i.id));

  const newRows: ReturnType<typeof toInstalledItemRow>[] = [];
  const changed: string[] = [];
  for (const item of snapshot.items) {
    const row = toInstalledItemRow(item);
    const existing = existingById.get(item.id);
    if (!existing) {
      newRows.push(row);
      continue;
    }
    if (diskStateMatches(existing, row)) continue;
    const { source_type, source_ref, source_subdir, content_backup_id, ...diskObservable } = row;
    const { error } = await client
      .from("installed_items")
      .update(diskObservable)
      .eq("machine_id", snapshot.machineId)
      .eq("id", item.id);
    logError(`update installed_items ${item.id}`, error);
    if (!error) changed.push(item.name);
  }

  // One request for the whole set rather than one per item: a first sync after pairing is
  // otherwise a serial round-trip per installed item (57 of them on a real machine).
  const added: string[] = [];
  if (newRows.length > 0) {
    const { error } = await client.from("installed_items").upsert(newRows, { onConflict: "machine_id,id" });
    logError(`upsert installed_items (${newRows.length} new row(s))`, error);
    if (!error) added.push(...newRows.map((r) => r.name));
  }

  const removed: string[] = [];
  const staleIds = [...existingById.keys()].filter((id) => !snapshotIds.has(id));
  if (staleIds.length > 0) {
    // Guard against a transient scan failure wiping a machine's whole inventory. A scan that
    // finds nothing at all is indistinguishable, from here, between "the user really deleted
    // everything" and "the home dir was momentarily unreadable / a config failed to parse" —
    // and the destructive reading of that ambiguity is unrecoverable, while the conservative
    // one self-corrects on the next non-empty scan. So an empty snapshot never deletes.
    if (snapshot.items.length === 0) {
      log.warn(
        `scan produced 0 items for machine ${snapshot.machineId} while ${existingById.size} row(s) exist; ` +
          "skipping stale-row cleanup rather than wiping the inventory on a possibly-failed scan"
      );
    } else {
      const { error } = await client.from("installed_items").delete().eq("machine_id", snapshot.machineId).in("id", staleIds);
      logError(`delete stale installed_items (${staleIds.length})`, error);
      if (!error) removed.push(...staleIds.map((id) => (existingById.get(id)!.name as string) ?? id));
    }
  }

  reportSync({ added, changed, removed });
}

// Best-effort content backup of a manual item, taken immediately before an irreversible
// removal. Opt-in per the plan's Global Constraint ("Content backups ... are opt-in") —
// gated on ~/.loadout/config.json's `contentBackupsEnabled`, toggled by
// `loadout-agent content-backups on|off`. Only ever runs for source_type "manual" items,
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

export function buildCli(): Command {
  const program = new Command();
  program.name("loadout").version(readPackageVersion());

  program
    .command("watch <path>")
    .description("register a project directory for project-scoped scanning")
    .action((projectPath: string) => {
      const cfg = readLocalConfig();
      if (!cfg.registeredProjectPaths.includes(projectPath)) {
        cfg.registeredProjectPaths.push(projectPath);
        writeLocalConfig(cfg);
      }
      console.log(`Watching ${projectPath}`);
    });

  program
    .command("content-backups <on|off>")
    .description("opt in to (or out of) uploading a redacted copy of a manually-installed item's content before removing it")
    .action((value: string) => {
      const enabled = value === "on";
      if (value !== "on" && value !== "off") {
        console.error("Expected 'on' or 'off'.");
        process.exitCode = 1;
        return;
      }
      writeLocalConfig({ ...readLocalConfig(), contentBackupsEnabled: enabled });
      console.log(
        enabled
          ? "Content backups enabled. Secret redaction is best-effort — secrets may have been missed."
          : "Content backups disabled."
      );
    });

  program
    .command("trust <minutes>")
    .description(
      "trust an approval for this many minutes, so the follow-up installs/restores in a burst don't each need a fresh confirmation (0 disables it — every action is confirmed)"
    )
    .action((value: string) => {
      const minutes = Number(value);
      if (value.trim() === "" || !Number.isFinite(minutes) || minutes < 0) {
        console.error("Expected a non-negative number of minutes.");
        process.exitCode = 1;
        return;
      }
      writeLocalConfig({ ...readLocalConfig(), trustWindowMinutes: minutes });
      console.log(
        minutes > 0
          ? `Trust window set to ${minutes} minute(s). One approval will cover follow-up actions on this machine for that long.`
          : "Trust window disabled. Every action will be confirmed."
      );
    });

  program
    .command("pair")
    .description("pair this machine with your Loadout account")
    .action(async () => {
      let connection;
      try {
        connection = supabaseConnection();
      } catch (err) {
        // A first-run configuration problem is the most likely way this command fails, and
        // the stack trace of a supabase-js assertion helps nobody. Print the instruction.
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }
      const client = createClient(connection.url, connection.anonKey);
      const { code } = await requestPairingCode(client);
      // Overridable so an agent pointed at a local stack prints a localhost pairing URL.
      const dashboard = process.env.LOADOUT_DASHBOARD_URL ?? "https://loadoutsync.com";
      console.log(`Enter this code in the dashboard: ${code}`);
      console.log(`  ${dashboard}/pair?code=${code}`);
      console.log("Waiting for you to confirm it…");
      // The id this machine already carries, so re-pairing re-attaches its existing dashboard
      // entry (and its whole inventory) instead of minting a second machine for one computer.
      const result = await pairAndRegisterMachine(client, code, readCredentials()?.machineId ?? null);
      if (result === "expired") {
        console.error("Pairing code expired. Run 'loadout pair' again.");
        process.exitCode = 1;
        return;
      }
      const session = await client.auth.getSession();
      writeCredentials({
        accessToken: session.data.session!.access_token,
        refreshToken: session.data.session!.refresh_token,
        machineId: result.machineId,
        userId: session.data.session!.user.id
      });
      // Which of the two happened is worth saying: "reconnected" is the difference between
      // the inventory you already had and a machine starting from nothing.
      console.log(
        result.reconnected
          ? `Reconnected as machine ${result.machineId}, keeping its existing inventory. Run 'loadout run' to start the daemon.`
          : `Paired successfully as machine ${result.machineId}. Run 'loadout run' to start the daemon.`
      );
    });

  program
    .command("approve <id>")
    .description("approve a pending locally-confirmed action (e.g. an install requested by the running daemon)")
    .action(async (id: string) => {
      try {
        await approvePending(id);
        console.log(`Approved ${id}`);
      } catch (err) {
        console.error(`Could not reach the running loadout daemon: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  program
    .command("deny <id>")
    .description("deny a pending locally-confirmed action")
    .action(async (id: string) => {
      try {
        await denyPending(id);
        console.log(`Denied ${id}`);
      } catch (err) {
        console.error(`Could not reach the running loadout daemon: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  program
    .command("install <git-url> [subdir]")
    .description(
      "install a skill from a git repository onto this machine without the dashboard (the path holding SKILL.md, when it is not the repository root)"
    )
    .option("--project <path>", "install project-scoped into this project instead of globally into your home directory")
    .action(async (gitUrl: string, subdir: string | undefined, opts: { project?: string }) => {
      const scope = opts.project ? "project" : "global";
      if (scope === "project" && !path.isAbsolute(opts.project!)) {
        console.error("--project expects an absolute path.");
        process.exitCode = 1;
        return;
      }
      // skipConfirmation: the user typed this command themselves — that IS consent.
      // requestLocalConfirmation would bind the running daemon's ~/.loadout/confirm.sock
      // (EADDRINUSE) and re-ask a question they already answered.
      const outcome = await installGeneric(
        { type: "git", ref: gitUrl, subdir: subdir ?? null },
        { kind: "skill", scope, projectPath: opts.project ?? null },
        { skipConfirmation: true }
      );
      if (!outcome.installed || !outcome.path) {
        console.error(`Install failed: ${outcome.reason ?? "unknown reason"}`);
        process.exitCode = 1;
        return;
      }
      // Pairing is optional for the files to land. When this machine IS paired, write
      // provenance immediately so a running daemon's next scan cannot INSERT the item as
      // unrestorable source_type "manual". Uses the stored access token only — setSession
      // would rotate the refresh token out from under `loadout run`.
      const creds = readCredentials();
      if (creds) {
        try {
          await recordInstallProvenance(
            clientFromStoredAccessToken(creds),
            installedItemFromInstall({
              outcomePath: outcome.path,
              machineId: creds.machineId,
              kind: "skill",
              scope,
              projectPath: opts.project ?? null,
              sourceType: "git",
              sourceRef: gitUrl,
              sourceSubdir: subdir ?? null
            })
          );
        } catch (err) {
          logError("record install provenance", err);
        }
      }
      console.log(`Installed to ${outcome.path}`);
    });

  program
    .command("run")
    .description("start the agent daemon: scan, watch, and apply dashboard commands")
    .option(
      "--supervised",
      "exit when an npm upgrade is detected on disk and nothing is mid-confirmation, so the service " +
        "manager (systemd/launchd) restarts into the new code — only set by the generated unit/plist"
    )
    .action(async (opts: { supervised?: boolean }) => {
      // A second `loadout run` on the same machine becomes a second daemon subscribed to the
      // same realtime channel: both receive every dashboard command and each posts its own
      // confirmation prompt (the "two notifications" half of the incident this fixes), and
      // whichever binds the IPC socket last silently steals it from the other (see
      // isSocketLive's doc comment in installer/confirm.ts). Checked before anything else —
      // credentials, network, disk scanning — so the refusal is instant.
      if (await isSocketLive()) {
        console.error(
          "A loadout daemon is already running on this machine (its confirmation socket is live).\n" +
            "Check it with 'loadout service status', or stop the existing process before starting another."
        );
        process.exitCode = 1;
        return;
      }

      const creds = readCredentials();
      if (!creds) {
        console.error("Not paired. Run 'loadout pair' first.");
        process.exitCode = 1;
        return;
      }

      // In-memory in confirm.ts and read once here: a restart is the one moment
      // re-confirming costs nothing, so the window is deliberately not persisted itself,
      // only its configured length (see `loadout trust <minutes>`).
      configureTrustWindow(readLocalConfig().trustWindowMinutes ?? 0);

      // createRealtimeClient throws rather than handing back a session-less client: without a
      // session the Realtime channel is refused and every write is denied by RLS, so a daemon
      // that carried on would be a process that looks alive locally while the dashboard shows
      // the machine offline and nothing anywhere says why. Print the message (the re-pair
      // instruction, or the connection failure) and let the exit code carry the rest — a
      // stack trace from inside auth-js tells the user nothing they can act on.
      let client: SupabaseClient;
      try {
        client = await createRealtimeClient(creds);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }

      const heartbeat = startHeartbeat(client, creds.machineId);
      // Only ever exits when --supervised was passed (see the flag's own comment above);
      // without it this is a silent no-op loop, matching "a plain `loadout run` in a
      // terminal never disappears out from under you."
      const upgradeWatch = startUpgradeWatch({ supervised: Boolean(opts.supervised) });
      process.on("SIGINT", async () => {
        upgradeWatch.stop();
        await heartbeat.stop();
        process.exit(0);
      });
      process.on("SIGTERM", async () => {
        upgradeWatch.stop();
        await heartbeat.stop();
        process.exit(0);
      });

      // Returned, not fired and forgotten: the watcher awaits this to keep two syncs of the
      // same machine from running concurrently (and landing out of order). The .catch stays
      // so a rejection is logged rather than escaping as an unhandled rejection (fatal on
      // Node >= 15) if this is ever called by something that does not await it.
      const syncSnapshot = (snapshot: Snapshot) =>
        upsertSnapshot(client, snapshot).catch((err) => logError("snapshot sync", err));

      // The paired machine's real id — not an env var nothing sets. Without this every
      // watcher-driven rescan wrote rows with machine_id "unknown", which no dashboard
      // query would ever match (and which no longer even satisfies the machines FK).
      startWatcher({ machineId: creds.machineId, homeDir: os.homedir(), onSnapshot: syncSnapshot });
      await upsertSnapshot(client, buildSnapshot({ machineId: creds.machineId, homeDir: os.homedir() }));

      async function handleCommand(command: RealtimeCommand): Promise<void> {
        // `installed_items` is keyed on (machine_id, id): the scanner-derived id is
        // path-based and so is NOT unique across a user's machines. Every lookup and write
        // below therefore pins machine_id to THIS machine — without it, a command naming an
        // id that also exists on a sibling machine could read, mutate or delete that other
        // machine's row.
        if (command.type === "toggle") {
          const { data: row, error } = await client
            .from("installed_items")
            .select("*")
            .eq("machine_id", creds!.machineId)
            .eq("id", command.itemId)
            .single();
          logError(`select installed_items ${command.itemId}`, error);
          if (!row) return;
          const item = toInstalledItem(row);
          applyToggle(item, command.enabled);
        } else if (command.type === "remove") {
          const { data: row, error } = await client
            .from("installed_items")
            .select("*")
            .eq("machine_id", creds!.machineId)
            .eq("id", command.itemId)
            .single();
          logError(`select installed_items ${command.itemId}`, error);
          if (!row) return;
          const item = toInstalledItem(row);
          await maybeCaptureContentBackup(client, item);
          removeItem(item);
          const { error: deleteError } = await client
            .from("installed_items")
            .delete()
            .eq("machine_id", creds!.machineId)
            .eq("id", command.itemId);
          logError(`delete installed_items ${command.itemId}`, deleteError);
        } else if (command.type === "restore") {
          const results = await restoreSnapshot(command.items);
          const { error } = await client.from("restore_results").insert(
            results.map((r) => ({
              machine_id: creds!.machineId,
              item_name: r.item.name,
              installed: r.installed,
              reason: r.reason ?? null
            }))
          );
          logError("insert restore_results", error);
        } else if (command.type === "install") {
          await applyInstallCommand(command, { client, machineId: creds!.machineId });
        }
      }

      subscribeCommands(client, creds.machineId, {
        onCommand: async (command) => {
          // One bad command must never take the daemon down. subscribeCommands invokes this
          // handler as a floating promise, and an unhandled rejection terminates the Node
          // process by default (>= 15) — so everything below is caught and logged here.
          try {
            await handleCommand(command);
          } catch (err) {
            logError(`command ${command.type}`, err);
          }
        }
      });
    });

  const service = program.command("service").description("manage loadout as a background service (systemd on Linux, launchd on macOS)");

  service
    .command("install")
    .description("install and start loadout as a background service that starts on login and restarts on crash")
    .action(async () => {
      if (!readCredentials()) {
        console.error("Not paired. Run 'loadout pair' first.");
        process.exitCode = 1;
        return;
      }
      const result = await installService();
      if (!result.ok) {
        console.error(result.message);
        process.exitCode = 1;
        return;
      }
      console.log("Service installed and started. Check status with 'loadout service status'.");
    });

  service
    .command("uninstall")
    .description("stop and remove the background service")
    .action(async () => {
      const result = await uninstallService();
      if (!result.ok) {
        console.error(result.message);
        process.exitCode = 1;
        return;
      }
      console.log("Service removed.");
    });

  service
    .command("status")
    .description("show whether the background service is installed and running")
    .action(async () => {
      console.log(await serviceStatus());
    });

  return program;
}
