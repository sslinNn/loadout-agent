import { describe, it, expect, vi, afterEach } from "vitest";
import * as generic from "../../src/installer/generic";
import { applyInstallCommand } from "../../src/installer/command";

interface Call {
  table: string;
  op: string;
  payload: unknown;
}

function fakeClient() {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, op: "", payload: null };
      const builder = {
        upsert(payload: unknown) {
          call.op = "upsert";
          call.payload = payload;
          calls.push(call);
          return builder;
        },
        then(onFulfilled: (r: unknown) => unknown) {
          return Promise.resolve({ error: null }).then(onFulfilled);
        }
      };
      return builder;
    }
  };
  return { client: client as never, calls };
}

const gitInstall = {
  type: "install" as const,
  kind: "skill" as const,
  scope: "global" as const,
  projectPath: null,
  sourceType: "git" as const,
  sourceRef: "https://github.com/sslinNn/cc-limits",
  sourceSubdir: "plugin/skills/cc-limits"
};

describe("applyInstallCommand (dashboard / realtime)", () => {
  afterEach(() => vi.restoreAllMocks());

  // Cloud-originated install is new code on the machine: the running daemon must still
  // bind confirm.sock and ask. skipConfirmation is only for an interactive `loadout install`.
  it("does not skip local confirmation", async () => {
    vi.spyOn(generic, "installGeneric").mockResolvedValue({
      installed: true,
      path: "/home/u/.agents/skills/cc-limits"
    });
    const { client } = fakeClient();

    await applyInstallCommand(gitInstall, { client, machineId: "m1" });

    expect(generic.installGeneric).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generic.installGeneric).mock.calls[0][2]?.skipConfirmation).not.toBe(true);
  });

  it("upserts git provenance including source_subdir so a later scan cannot stamp the item as manual", async () => {
    vi.spyOn(generic, "installGeneric").mockResolvedValue({
      installed: true,
      path: "/home/u/.agents/skills/cc-limits"
    });
    const { client, calls } = fakeClient();

    await applyInstallCommand(gitInstall, { client, machineId: "m1" });

    const row = calls.find((c) => c.table === "installed_items" && c.op === "upsert")?.payload as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({
      machine_id: "m1",
      source_type: "git",
      source_ref: "https://github.com/sslinNn/cc-limits",
      source_subdir: "plugin/skills/cc-limits"
    });
  });
});
