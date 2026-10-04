import type { SupabaseClient } from "@supabase/supabase-js";
import * as log from "./log.js";

/** The `machine_id` claim of an access token, or null for an account-wide one. */
export function machineClaim(accessToken: string): string | null {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { machine_id?: unknown };
    return typeof claims.machine_id === "string" && claims.machine_id ? claims.machine_id : null;
  } catch {
    return null;
  }
}

export type ScopeOutcome = "scoped" | "unsupported" | "pending_hook" | "revoked" | "failed";

/**
 * Narrow this agent's session to its own machine.
 *
 * Pairing hands the agent a session for the whole account. `register_machine_session` records
 * that this session belongs to `machineId`; the project's access token hook then stamps every
 * token of the session with `machine_id`, and row-level security confines such a token to this
 * machine's rows (docs/superpowers/specs/2026-10-04-machine-scoped-credentials-design.md in
 * the dashboard repo). Refreshing right away swaps the account-wide token for a scoped one.
 *
 * Idempotent and cheap once done: a token that already carries the claim is left alone.
 *
 * - "unsupported": the deployment predates the RPC; nothing changes.
 * - "pending_hook": registered, but the hook is not enabled yet, so tokens stay account-wide.
 * - "revoked": the machine was forgotten (or this session retired); the agent must re-pair.
 */
export async function scopeSessionToMachine(client: SupabaseClient, machineId: string): Promise<ScopeOutcome> {
  const { data: current } = await client.auth.getSession();
  const token = current.session?.access_token;
  if (token && machineClaim(token) === machineId) return "scoped";

  const { data, error } = await client.rpc("register_machine_session", { p_machine_id: machineId });
  if (error) {
    if (error.code === "PGRST202") return "unsupported";
    log.error("could not register this machine's session:", error);
    return "failed";
  }
  if (data === "retired" || data === "not_found") return "revoked";
  if (data !== "registered") {
    log.error(`unexpected answer registering this machine's session: ${String(data)}`);
    return "failed";
  }

  const { data: refreshed, error: refreshError } = await client.auth.refreshSession();
  if (refreshError || !refreshed.session) {
    log.error("registered this machine's session but could not refresh it:", refreshError);
    return "failed";
  }
  return machineClaim(refreshed.session.access_token) === machineId ? "scoped" : "pending_hook";
}
