// packages/agent/src/realtime/client.ts
import { createClient, isAuthRetryableFetchError, type SupabaseClient } from "@supabase/supabase-js";
import { writeCredentials, type Credentials } from "../localConfig.js";
import { supabaseConnection } from "../config.js";
import * as log from "../log.js";

/**
 * The stored session is gone as far as Supabase is concerned — revoked, or its refresh token
 * already spent — and no amount of restarting will bring it back. Distinct from an ordinary
 * failure so the daemon can say the one thing that actually fixes it: pair again.
 */
export class PairingRejectedError extends Error {
  constructor(cause: unknown) {
    super(
      "This machine's pairing is no longer valid — Supabase rejected the stored session.\n" +
        "Run 'loadout pair' to pair it again.",
      { cause }
    );
    this.name = "PairingRejectedError";
  }
}

export async function createRealtimeClient(session: Credentials): Promise<SupabaseClient> {
  const { url, anonKey } = supabaseConnection();
  const client = createClient(url, anonKey);

  // Persist rotated tokens. Supabase refresh tokens are single-use: once the client
  // refreshes, the refresh token stored in ~/.loadout/credentials.json is dead. A daemon
  // that never wrote the new pair back would work until its first refresh (~1h) and then,
  // on its next restart, fail to resume its session — the agent would effectively unpair
  // itself. Registered BEFORE setSession so the very first TOKEN_REFRESHED/SIGNED_IN event
  // is captured.
  client.auth.onAuthStateChange((event, newSession) => {
    if (!newSession) return;
    if (event !== "TOKEN_REFRESHED" && event !== "SIGNED_IN" && event !== "USER_UPDATED") return;
    try {
      writeCredentials({
        accessToken: newSession.access_token,
        refreshToken: newSession.refresh_token,
        machineId: session.machineId,
        userId: newSession.user?.id ?? session.userId
      });
    } catch (err) {
      log.error("failed to persist refreshed Supabase credentials to ~/.loadout/credentials.json", err);
    }
  });

  // Awaited: setSession performs a network round-trip and, until it resolves, the client
  // has no access token — a Realtime channel subscribed in the meantime would attempt to
  // join as anon and be rejected by the broadcast authorization policy.
  const { error } = await client.auth.setSession({
    access_token: session.accessToken,
    refresh_token: session.refreshToken
  });

  // This used to be logged and then ignored, and the daemon carried on with an anonymous
  // client: the Realtime private channel was refused, every heartbeat write was denied by
  // RLS (silently — those writes discard their error), and so the dashboard showed the
  // machine offline forever while a healthy-looking process sat in the user's terminal
  // saying nothing. There is no useful work left to do without a session, so stop —
  // loudly enough to say which of the two situations this is.
  if (error) {
    // A Supabase that is merely unreachable is not a dead pairing. Telling the user to
    // re-pair a still-paired machine because their laptop woke up before its network did
    // would trade a self-healing outage for a manual one; throwing plainly lets the
    // supervisor (`loadout service install` sets Restart=on-failure) retry instead.
    if (isAuthRetryableFetchError(error)) {
      throw new Error(`Could not reach Supabase to restore this machine's session: ${error.message}`, { cause: error });
    }
    throw new PairingRejectedError(error);
  }

  return client;
}
