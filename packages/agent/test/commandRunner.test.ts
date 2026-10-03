import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("../src/installer/command", () => ({ applyInstallCommand: vi.fn() }));
vi.mock("../src/installer/restore", () => ({ restoreSnapshot: vi.fn() }));
vi.mock("../src/mutators/dispatch", () => ({ applyToggle: vi.fn(), removeItem: vi.fn() }));

import { executeCommand } from "../src/commandRunner";
import { applyInstallCommand } from "../src/installer/command";
import { restoreSnapshot } from "../src/installer/restore";
import { applyToggle } from "../src/mutators/dispatch";

function clientWithRow(row: Record<string, unknown> | null) {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: () => builder,
    eq: () => builder,
    delete: () => builder,
    maybeSingle: async () => ({ data: row, error: null }),
    insert: async () => ({ error: null }),
    then: (resolve: (v: unknown) => void) => resolve({ error: null })
  });
  return { from: () => builder } as unknown as SupabaseClient;
}

const install = {
  type: "install",
  kind: "skill",
  scope: "global",
  projectPath: null,
  sourceType: "git",
  sourceRef: "https://github.com/o/r"
} as const;

describe("executeCommand", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports an install's commit, a denial, and a failure distinctly", async () => {
    const ctx = { client: clientWithRow(null), machineId: "m1" };
    vi.mocked(applyInstallCommand).mockResolvedValueOnce({ installed: true, commit: "a".repeat(40) });
    expect(await executeCommand(install, ctx)).toEqual({ status: "done", detail: "installed at aaaaaaaaaaaa" });
    vi.mocked(applyInstallCommand).mockResolvedValueOnce({ installed: false, reason: "denied" });
    expect(await executeCommand(install, ctx)).toEqual({ status: "denied" });
    vi.mocked(applyInstallCommand).mockResolvedValueOnce({ installed: false, reason: "no SKILL.md" });
    expect(await executeCommand(install, ctx)).toEqual({ status: "failed", detail: "no SKILL.md" });
  });

  it("fails a toggle for an item this machine no longer records, without touching disk", async () => {
    const outcome = await executeCommand({ type: "toggle", itemId: "gone", enabled: true }, { client: clientWithRow(null), machineId: "m1" });
    expect(outcome.status).toBe("failed");
    expect(applyToggle).not.toHaveBeenCalled();
  });

  it("turns a thrown error into a failed outcome", async () => {
    vi.mocked(applyInstallCommand).mockRejectedValueOnce(new Error("disk full"));
    expect(await executeCommand(install, { client: clientWithRow(null), machineId: "m1" })).toEqual({
      status: "failed",
      detail: "disk full"
    });
  });

  it("calls a restore denied when every item was denied", async () => {
    const item = { name: "a" } as never;
    vi.mocked(restoreSnapshot).mockResolvedValueOnce([{ item, installed: false, reason: "denied" }]);
    expect((await executeCommand({ type: "restore", items: [] }, { client: clientWithRow(null), machineId: "m1" })).status).toBe("denied");
  });
});
