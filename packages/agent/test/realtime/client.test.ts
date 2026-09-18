// packages/agent/test/realtime/client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";

const setSession = vi.fn();
const onAuthStateChange = vi.fn();

// Only createClient is faked; the real module's error classes and type guards are kept, so
// the retryable-vs-fatal split below is tested against the discrimination supabase-js itself
// performs rather than against a stand-in for it.
vi.mock("@supabase/supabase-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@supabase/supabase-js")>()),
  createClient: () => ({ auth: { setSession, onAuthStateChange } })
}));

const { createRealtimeClient, PairingRejectedError } = await import("../../src/realtime/client");

const CREDS = { accessToken: "at", refreshToken: "rt", machineId: "M1", userId: "U1" };

describe("createRealtimeClient", () => {
  beforeEach(() => {
    vi.stubEnv("LOADOUT_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("LOADOUT_SUPABASE_ANON_KEY", "anon");
    setSession.mockReset();
    onAuthStateChange.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns a client when the stored session is restored", async () => {
    setSession.mockResolvedValue({ error: null });
    await expect(createRealtimeClient(CREDS)).resolves.toBeTruthy();
  });

  // The daemon used to log this and carry on. With no session the Realtime private channel
  // is rejected and every heartbeat write is denied by RLS — silently, because those writes
  // discard their error — so the machine sat "offline" on the dashboard with a process that
  // looked perfectly alive locally and printed nothing more about it.
  it("rejects with a re-pair instruction when the session is gone server-side", async () => {
    setSession.mockResolvedValue({
      error: new AuthApiError("Session from session_id claim in JWT does not exist", 403, "session_not_found")
    });

    const err = await createRealtimeClient(CREDS).catch((e) => e);

    expect(err).toBeInstanceOf(PairingRejectedError);
    expect(err.message).toContain("loadout pair");
  });

  // A Supabase that is merely unreachable (laptop resuming from sleep, service restarting)
  // must NOT read as a dead pairing: the user would be told to re-pair a machine that is
  // still perfectly paired. It still throws, so the supervisor restarts and retries.
  it("rejects without the re-pair instruction when Supabase is simply unreachable", async () => {
    setSession.mockResolvedValue({ error: new AuthRetryableFetchError("fetch failed", 0) });

    const err = await createRealtimeClient(CREDS).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PairingRejectedError);
    expect(err.message).not.toContain("loadout pair");
  });
});
