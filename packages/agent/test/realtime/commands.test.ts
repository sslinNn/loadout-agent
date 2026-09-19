// packages/agent/test/realtime/commands.test.ts
import { describe, it, expect, vi } from "vitest";
import { subscribeCommands } from "../../src/realtime/commands";
import { RealtimeCommandSchema } from "@loadout/shared";

function fakeChannel() {
  const handlers: Record<string, Function> = {};
  return {
    on: vi.fn((_type, _opts, cb) => { handlers.command = cb; return fakeChannel(); }),
    subscribe: vi.fn(),
    _emit: (payload: unknown) => handlers.command({ payload })
  };
}

describe("subscribeCommands", () => {
  it("dispatches a well-formed toggle command to onCommand", async () => {
    const channel = fakeChannel();
    const client = { channel: vi.fn().mockReturnValue(channel) } as any;
    const onCommand = vi.fn();
    subscribeCommands(client, "M1", { onCommand });
    await (channel as any)._emit({ type: "toggle", itemId: "i1", enabled: false });
    expect(onCommand).toHaveBeenCalledWith({ type: "toggle", itemId: "i1", enabled: false });
  });

  it("ignores a malformed payload instead of throwing", async () => {
    const channel = fakeChannel();
    const client = { channel: vi.fn().mockReturnValue(channel) } as any;
    const onCommand = vi.fn();
    subscribeCommands(client, "M1", { onCommand });
    await (channel as any)._emit({ type: "not-a-real-type" });
    expect(onCommand).not.toHaveBeenCalled();
  });

  // I2: `on` is a sync callback, so the handler's promise runs detached — an unhandled
  // rejection here terminates the Node process (>= 15), i.e. one bad dashboard command
  // would kill the whole daemon.
  it("swallows and logs a rejecting handler rather than letting it become an unhandled rejection", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const channel = fakeChannel();
    const client = { channel: vi.fn().mockReturnValue(channel) } as any;
    const onCommand = vi.fn().mockRejectedValue(new Error("boom"));

    subscribeCommands(client, "M1", { onCommand });
    await (channel as any)._emit({ type: "toggle", itemId: "i1", enabled: false });
    await new Promise((r) => setTimeout(r, 0)); // let the detached promise settle

    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls[0].join(" ")).toMatch(/unhandled error in command handler/);
    errorSpy.mockRestore();
  });

  it("accepts an install command carrying a repository subdirectory", () => {
    const parsed = RealtimeCommandSchema.safeParse({
      type: "install",
      kind: "skill",
      scope: "global",
      projectPath: null,
      sourceType: "git",
      sourceRef: "https://github.com/sslinNn/cc-limits",
      sourceSubdir: "plugin/skills/cc-limits"
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.type === "install" && parsed.data.sourceSubdir).toBe(
      "plugin/skills/cc-limits"
    );
  });

  it("still accepts an install command with no subdirectory", () => {
    const parsed = RealtimeCommandSchema.safeParse({
      type: "install",
      kind: "skill",
      scope: "global",
      projectPath: null,
      sourceType: "git",
      sourceRef: "https://github.com/example/skill.git"
    });
    expect(parsed.success).toBe(true);
  });
});
