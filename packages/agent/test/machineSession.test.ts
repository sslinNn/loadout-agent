import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { machineClaim, scopeSessionToMachine } from "../src/machineSession";

function jwt(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

function client(opts: { token: string; rpc: { data?: unknown; error?: unknown }; refreshed?: string }) {
  return {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: opts.token } } })),
      refreshSession: vi.fn(async () =>
        opts.refreshed ? { data: { session: { access_token: opts.refreshed } }, error: null } : { data: { session: null }, error: new Error("x") }
      )
    },
    rpc: vi.fn(async () => ({ data: opts.rpc.data ?? null, error: opts.rpc.error ?? null }))
  } as unknown as SupabaseClient & { rpc: ReturnType<typeof vi.fn>; auth: { refreshSession: ReturnType<typeof vi.fn> } };
}

describe("machineClaim", () => {
  it("reads machine_id from a token, and null from anything else", () => {
    expect(machineClaim(jwt({ sub: "u", machine_id: "m1" }))).toBe("m1");
    expect(machineClaim(jwt({ sub: "u" }))).toBeNull();
    expect(machineClaim("garbage")).toBeNull();
  });
});

describe("scopeSessionToMachine", () => {
  it("does nothing when the token is already scoped", async () => {
    const c = client({ token: jwt({ machine_id: "m1" }), rpc: {} });
    expect(await scopeSessionToMachine(c, "m1")).toBe("scoped");
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it("registers, refreshes, and reports the scoped token", async () => {
    const c = client({ token: jwt({}), rpc: { data: "registered" }, refreshed: jwt({ machine_id: "m1" }) });
    expect(await scopeSessionToMachine(c, "m1")).toBe("scoped");
    expect(c.rpc).toHaveBeenCalledWith("register_machine_session", { p_machine_id: "m1" });
    expect(c.auth.refreshSession).toHaveBeenCalled();
  });

  it("says when the hook is not enabled yet", async () => {
    const c = client({ token: jwt({}), rpc: { data: "registered" }, refreshed: jwt({}) });
    expect(await scopeSessionToMachine(c, "m1")).toBe("pending_hook");
  });

  it("tells a forgotten machine apart from an old deployment", async () => {
    expect(await scopeSessionToMachine(client({ token: jwt({}), rpc: { data: "retired" } }), "m1")).toBe("revoked");
    expect(await scopeSessionToMachine(client({ token: jwt({}), rpc: { data: "not_found" } }), "m1")).toBe("revoked");
    expect(
      await scopeSessionToMachine(client({ token: jwt({}), rpc: { error: { code: "PGRST202", message: "no function" } } }), "m1")
    ).toBe("unsupported");
  });
});
