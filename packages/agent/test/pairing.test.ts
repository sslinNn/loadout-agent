import { describe, it, expect, vi } from "vitest";
import { pollUntilPaired, pairAndRegisterMachine } from "../src/pairing";
import { readPackageVersion } from "../src/version";

function fakeClientWithSequence(statuses: Array<{ status: string; session?: unknown }>) {
  let call = 0;
  return {
    rpc: vi.fn().mockImplementation(async () => ({ data: statuses[call++] })),
    auth: { verifyOtp: vi.fn().mockResolvedValue({ data: { session: { access_token: "at", refresh_token: "rt", user: { id: "u1" } } }, error: null }) },
    from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: { id: "m1" }, error: null }) }) }) })
  } as any;
}

describe("pollUntilPaired", () => {
  it("resolves with real tokens once poll_pairing_code returns confirmed", async () => {
    const client = fakeClientWithSequence([
      { status: "pending" },
      { status: "confirmed", session: { hashedToken: "h1" } }
    ]);
    const result = await pollUntilPaired(client, "CODE123456", { intervalMs: 1 });
    expect(client.auth.verifyOtp).toHaveBeenCalledWith({ type: "magiclink", token_hash: "h1" });
    expect(result).toEqual({ accessToken: "at", refreshToken: "rt", userId: "u1" });
  });

  it("returns 'expired' when poll_pairing_code reports expired", async () => {
    const client = fakeClientWithSequence([{ status: "expired" }]);
    const result = await pollUntilPaired(client, "CODE123456", { intervalMs: 1 });
    expect(result).toBe("expired");
  });
});

describe("pairAndRegisterMachine", () => {
  it("re-authenticates and inserts a machines row, returning its id", async () => {
    const client = fakeClientWithSequence([{ status: "confirmed", session: { hashedToken: "h1" } }]);
    client.auth.setSession = vi.fn().mockResolvedValue(undefined);
    const result = await pairAndRegisterMachine(client, "CODE123456");
    expect(client.auth.setSession).toHaveBeenCalledWith({ access_token: "at", refresh_token: "rt" });
    expect(result).toEqual({ machineId: "m1", reconnected: false });
  });

  it("registers the agent's real package version, not a literal that drifts", async () => {
    const insert = vi.fn().mockReturnValue({ select: () => ({ single: async () => ({ data: { id: "m1" }, error: null }) }) });
    const client = fakeClientWithSequence([{ status: "confirmed", session: { hashedToken: "h1" } }]);
    client.auth.setSession = vi.fn().mockResolvedValue(undefined);
    client.from = () => ({ insert });

    await pairAndRegisterMachine(client, "CODE123456");
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ agent_version: readPackageVersion() }));
  });
  // Every `loadout pair` used to INSERT, so re-pairing a machine that was already paired
  // minted a SECOND row for it: one physical machine, two entries in the dashboard, the
  // older one stranded with the inventory and no way to remove it. The machine's own id
  // outlives a re-pairing in ~/.loadout/credentials.json, which is what makes it
  // recognisable at all.
  describe("re-pairing a machine that is already paired", () => {
    function fakeClientWithExistingRow(updateResult: { data: unknown; error: unknown }) {
      const eq = vi.fn().mockReturnValue({ select: () => ({ maybeSingle: async () => updateResult }) });
      const update = vi.fn().mockReturnValue({ eq });
      const insert = vi.fn().mockReturnValue({ select: () => ({ single: async () => ({ data: { id: "fresh" }, error: null }) }) });
      const client = fakeClientWithSequence([{ status: "confirmed", session: { hashedToken: "h1" } }]);
      client.auth.setSession = vi.fn().mockResolvedValue(undefined);
      client.from = vi.fn().mockReturnValue({ update, insert });
      return { client, update, insert, eq };
    }

    it("updates the machine it is already registered as instead of creating a second one", async () => {
      const { client, update, insert, eq } = fakeClientWithExistingRow({ data: { id: "known" }, error: null });

      const result = await pairAndRegisterMachine(client, "CODE123456", "known");

      expect(result).toEqual({ machineId: "known", reconnected: true });
      expect(insert).not.toHaveBeenCalled();
      expect(eq).toHaveBeenCalledWith("id", "known");
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ agent_version: readPackageVersion() }));
    });

    // RLS scopes the UPDATE to rows this user owns, so "no row came back" covers both
    // "deleted from the dashboard" and "belongs to the account you just signed out of" —
    // and both mean this really is a new machine. Deliberately not an upsert on the known
    // id: that would resurrect a machine the user had chosen to remove.
    it("registers a new machine when the remembered id no longer resolves to a row", async () => {
      const { client, insert } = fakeClientWithExistingRow({ data: null, error: null });

      const result = await pairAndRegisterMachine(client, "CODE123456", "stale");

      expect(result).toEqual({ machineId: "fresh", reconnected: false });
      expect(insert).toHaveBeenCalled();
    });

    it("registers a new machine when this one has never been paired", async () => {
      const { client, update, insert } = fakeClientWithExistingRow({ data: null, error: null });

      const result = await pairAndRegisterMachine(client, "CODE123456", null);

      expect(result).toEqual({ machineId: "fresh", reconnected: false });
      expect(update).not.toHaveBeenCalled();
      expect(insert).toHaveBeenCalled();
    });
  });
});
