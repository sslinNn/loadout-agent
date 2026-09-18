import type { SupabaseClient } from "@supabase/supabase-js";
import { readPackageVersion } from "./version.js";

export function startHeartbeat(
  client: SupabaseClient,
  machineId: string,
  opts: { intervalMs?: number } = {}
): { stop: () => Promise<void> } {
  // `agent_version` rides along on every beat: pairing writes it once, but the machine keeps
  // running across upgrades, so a row written at pair time would show that stale version forever.
  // Read once — the running process can't change its own version.
  const agentVersion = readPackageVersion();

  async function beat(status: "online" | "offline") {
    await client
      .from("machines")
      .update({ status, last_seen_at: new Date().toISOString(), agent_version: agentVersion })
      .eq("id", machineId);
  }

  void beat("online");
  const interval = setInterval(() => void beat("online"), opts.intervalMs ?? 60_000);

  return {
    stop: async () => {
      clearInterval(interval);
      await beat("offline");
    }
  };
}
