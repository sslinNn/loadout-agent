import os from "node:os";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readPackageVersion } from "./version.js";

export async function requestPairingCode(client: SupabaseClient): Promise<{ code: string }> {
  const { data, error } = await client.rpc("request_pairing_code");
  if (error) throw error;
  return { code: data.code };
}

export async function pollUntilPaired(
  client: SupabaseClient,
  code: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<{ accessToken: string; refreshToken: string; userId: string } | "expired"> {
  const interval = opts.intervalMs ?? 3000;
  const deadline = Date.now() + (opts.timeoutMs ?? 6 * 60 * 1000);
  while (Date.now() < deadline) {
    const { data } = await client.rpc("poll_pairing_code", { code });
    if (data.status === "confirmed") {
      const hashedToken = (data.session as { hashedToken: string }).hashedToken;
      // NOTE: `type: "magiclink"` is the OTP type this plan assumes for a hashed magic-link
      // token; confirm against the installed supabase-js version's verifyOtp docs and adjust
      // if it differs (some versions expect `type: "email"` for this case).
      const { data: verified, error } = await client.auth.verifyOtp({ type: "magiclink", token_hash: hashedToken });
      if (error) throw error;
      return {
        accessToken: verified.session!.access_token,
        refreshToken: verified.session!.refresh_token,
        userId: verified.session!.user.id
      };
    }
    if (data.status === "expired") return "expired";
    await new Promise((r) => setTimeout(r, interval));
  }
  return "expired";
}

/**
 * Pair this machine, RE-pairing the row it already has rather than minting a second one.
 *
 * `knownMachineId` is the id in ~/.loadout/credentials.json: the only durable record that
 * this physical machine has been paired before. Without it every `loadout pair` INSERTed,
 * so pairing the same machine twice produced two dashboard entries for one computer — the
 * older one stranded with that machine's whole inventory, and (there being no way to remove
 * a machine) stranded permanently.
 *
 * Identity deliberately comes from that file and not from a hardware fingerprint. A
 * fingerprint would survive a wiped ~/.loadout, but `/etc/machine-id` is copied along with
 * a VM image, a container, or a golden image — two genuinely different machines would then
 * claim one row and, because `installed_items` is keyed on (machine_id, id), each one's
 * sync would delete the other's items as stale. A spurious extra row in a list is a
 * nuisance; a machine quietly eating another machine's inventory is not.
 */
export async function pairAndRegisterMachine(
  client: SupabaseClient,
  code: string,
  knownMachineId: string | null = null
): Promise<{ machineId: string; reconnected: boolean } | "expired"> {
  const result = await pollUntilPaired(client, code);
  if (result === "expired") return "expired";

  await client.auth.setSession({ access_token: result.accessToken, refresh_token: result.refreshToken });

  const registration = {
    hostname: os.hostname(),
    os: process.platform,
    agent_version: readPackageVersion()
  };

  if (knownMachineId) {
    // `maybeSingle`, not `single`: RLS scopes this UPDATE to rows the freshly-signed-in user
    // owns, so zero rows is an ordinary answer — the machine was removed from the dashboard,
    // or this is a different account than the one it was paired to — and both mean it really
    // is a new machine. An upsert on the known id would instead resurrect a row the user had
    // deliberately deleted.
    const { data, error } = await client.from("machines").update(registration).eq("id", knownMachineId).select().maybeSingle();
    if (error) throw error;
    if (data) return { machineId: data.id as string, reconnected: true };
  }

  const { data, error } = await client.from("machines").insert(registration).select().single();
  if (error) throw error;
  return { machineId: data.id, reconnected: false };
}
