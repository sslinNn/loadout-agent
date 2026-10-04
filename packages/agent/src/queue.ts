import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { MachineCommand, MachineCommandStatus, RealtimeCommand } from "@loadout/shared";
import { toMachineCommand } from "@loadout/shared";
import { setConfirmationListener } from "./installer/confirm.js";
import type { CommandOutcome } from "./commandRunner.js";
import * as log from "./log.js";

/** How often to look for queued work even when no change event arrives. */
const SAFETY_NET_MS = 60_000;
/** How many pending commands one drain picks up. The rest wait for the next pass. */
const BATCH = 25;

export interface CommandQueueOptions {
  client: SupabaseClient;
  machineId: string;
  /** Carries out one command. Must not throw. */
  execute: (command: RealtimeCommand) => Promise<CommandOutcome>;
  /** Runs `task` after every task already running or queued (shared with the broadcast path). */
  serialize: <T>(task: () => Promise<T>) => Promise<T>;
  intervalMs?: number;
}

/**
 * Drain `machine_commands` for this machine: everything queued while the daemon was offline
 * on start and on every (re)subscribe, new rows as they arrive, and on a slow timer as a
 * safety net for a missed event.
 *
 * Each command is claimed (pending -> running, conditional on still being pending, so two
 * daemons — or a retry — never run it twice), carried out through the same serial runner as
 * broadcast commands, and closed with done / failed / denied plus a short detail. While a
 * local confirmation is waiting the row reads awaiting_approval, which is what lets the
 * dashboard say "waiting for approval on <host>" instead of looking finished.
 */
export function startCommandQueue(opts: CommandQueueOptions): { drain: () => Promise<void>; stop: () => Promise<void> } {
  const { client, machineId } = opts;
  let draining: Promise<void> | null = null;
  let again = false;
  let stopped = false;

  async function setStatus(id: string, status: MachineCommandStatus, detail?: string | null): Promise<boolean> {
    const patch: Record<string, unknown> = { status };
    if (detail !== undefined) patch.detail = detail ? detail.slice(0, 2000) : null;
    const { error } = await client.from("machine_commands").update(patch).eq("id", id);
    if (error) log.error(`could not mark command ${id} ${status}:`, error);
    return !error;
  }

  async function claim(id: string): Promise<boolean> {
    const { data, error } = await client
      .from("machine_commands")
      .update({ status: "running" })
      .eq("id", id)
      .eq("status", "pending")
      .select("id");
    if (error) {
      log.error(`could not claim command ${id}:`, error);
      return false;
    }
    return (data?.length ?? 0) > 0;
  }

  async function runOne(entry: MachineCommand): Promise<void> {
    if (Date.parse(entry.expiresAt) < Date.now()) {
      await setStatus(entry.id, "expired", "not picked up before it expired");
      return;
    }
    if (!(await claim(entry.id))) return;
    log.info(`queued command ${entry.id}: ${entry.command.type}`);

    const outcome = await opts.serialize(async () => {
      setConfirmationListener(({ phase }) => {
        void setStatus(entry.id, phase === "waiting" ? "awaiting_approval" : "running");
      });
      try {
        return await opts.execute(entry.command);
      } finally {
        setConfirmationListener(null);
      }
    });
    await setStatus(entry.id, outcome.status, outcome.detail ?? null);
  }

  async function drainOnce(): Promise<void> {
    const { data, error } = await client
      .from("machine_commands")
      .select("*")
      .eq("machine_id", machineId)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(BATCH);
    if (error) {
      log.error("could not read the command queue:", error);
      return;
    }
    for (const row of data ?? []) {
      if (stopped) return;
      const entry = toMachineCommand(row as Record<string, unknown>);
      if (!entry) {
        // A payload the schema refuses is never acted on — and never left pending to be
        // retried forever either.
        await setStatus((row as { id: string }).id, "failed", "the command did not match the agent's schema");
        continue;
      }
      await runOne(entry);
    }
    if ((data?.length ?? 0) === BATCH) again = true;
  }

  // A daemon killed mid-command (crash, reboot, upgrade restart) left its row running or
  // awaiting approval, and only pending rows are ever picked up again. Close those as
  // interrupted before the first drain rather than leave the dashboard waiting forever.
  const recovered = (async () => {
    const { data, error } = await client
      .from("machine_commands")
      .select("id")
      .eq("machine_id", machineId)
      .in("status", ["running", "awaiting_approval"]);
    if (error) {
      log.error("could not read interrupted commands:", error);
      return;
    }
    for (const row of data ?? []) {
      await setStatus((row as { id: string }).id, "failed", "interrupted: the agent stopped before it finished");
    }
  })();

  function drain(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (draining) {
      again = true;
      return draining;
    }
    draining = (async () => {
      await recovered;
      do {
        again = false;
        await drainOnce();
      } while (again && !stopped);
    })()
      .catch((err) => log.error("command queue drain failed:", err))
      .finally(() => {
        draining = null;
      });
    return draining;
  }

  const channel: RealtimeChannel = client
    .channel(`machine-commands:${machineId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "machine_commands", filter: `machine_id=eq.${machineId}` },
      () => void drain()
    )
    .subscribe((status: string) => {
      // Subscribed (again): anything queued while the socket was down produced no event.
      if (status === "SUBSCRIBED") void drain();
    });

  const timer = setInterval(() => void drain(), opts.intervalMs ?? SAFETY_NET_MS);
  if (typeof timer.unref === "function") timer.unref();

  return {
    drain,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await client.removeChannel(channel);
      await draining;
    }
  };
}
