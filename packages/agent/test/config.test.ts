import { describe, it, expect, afterEach } from "vitest";
import { BUNDLED_SUPABASE_URL, BUNDLED_SUPABASE_ANON_KEY } from "@loadout/shared";
import { supabaseConnection } from "../src/config";

const ENV_KEYS = ["LOADOUT_SUPABASE_URL", "LOADOUT_SUPABASE_ANON_KEY"] as const;
const saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("supabaseConnection", () => {
  it("falls back to the shared bundled values when no env override is set", () => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    expect(supabaseConnection()).toEqual({ url: BUNDLED_SUPABASE_URL, anonKey: BUNDLED_SUPABASE_ANON_KEY });
  });

  it("prefers an env override over the bundled default", () => {
    saved.LOADOUT_SUPABASE_URL = process.env.LOADOUT_SUPABASE_URL;
    saved.LOADOUT_SUPABASE_ANON_KEY = process.env.LOADOUT_SUPABASE_ANON_KEY;
    process.env.LOADOUT_SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.LOADOUT_SUPABASE_ANON_KEY = "local-anon-key";
    expect(supabaseConnection()).toEqual({ url: "http://127.0.0.1:54321", anonKey: "local-anon-key" });
  });
});
