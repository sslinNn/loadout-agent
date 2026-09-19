/**
 * Where this agent talks to.
 *
 * The env vars are an override for anyone pointing an agent at a local or self-hosted
 * Supabase project — which is what the local dev loop uses. Otherwise it falls back to
 * `@loadout/shared`'s bundled production values, so `npm i -g loadout-agen && loadout pair`
 * works with no environment setup.
 */
import { BUNDLED_SUPABASE_URL, BUNDLED_SUPABASE_ANON_KEY } from "@loadout/shared";

export interface SupabaseConnection {
  url: string;
  anonKey: string;
}

export function supabaseConnection(): SupabaseConnection {
  const url = process.env.LOADOUT_SUPABASE_URL || BUNDLED_SUPABASE_URL;
  const anonKey = process.env.LOADOUT_SUPABASE_ANON_KEY || BUNDLED_SUPABASE_ANON_KEY;

  // Both call sites used `process.env.LOADOUT_SUPABASE_URL!`, so an unset variable reached
  // supabase-js as undefined and surfaced as "supabaseUrl is required" — a message that
  // names neither the variable to set, nor where to find its value, to someone who is one
  // command into their first install.
  if (!url || !anonKey) {
    const missing = [!url && "LOADOUT_SUPABASE_URL", !anonKey && "LOADOUT_SUPABASE_ANON_KEY"].filter(Boolean).join(" and ");
    throw new Error(
      `loadout is not configured: ${missing} is not set.\n` +
        `Open the dashboard's "Get started" page — it prints the two export lines for your deployment, ready to paste.`
    );
  }

  return { url, anonKey };
}
