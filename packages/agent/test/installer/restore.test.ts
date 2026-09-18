import { describe, it, expect, vi } from "vitest";
import * as confirmModule from "../../src/installer/confirm";
import * as genericModule from "../../src/installer/generic";
import { restoreSnapshot } from "../../src/installer/restore";

const items = [
  { id: "1", tool: "claude_code", kind: "skill", scope: "global", projectPath: null,
    sourceType: "git", sourceRef: "https://github.com/example/a.git" },
  { id: "2", tool: "codex", kind: "skill", scope: "global", projectPath: null,
    sourceType: "git", sourceRef: "https://github.com/example/b.git" }
] as any;

describe("restoreSnapshot", () => {
  it("asks for exactly one confirmation covering the whole batch", async () => {
    const confirmSpy = vi.spyOn(confirmModule, "requestLocalConfirmation").mockResolvedValue(true);
    vi.spyOn(genericModule, "installGeneric").mockResolvedValue({ installed: true, path: "/x" });

    await restoreSnapshot(items);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
  });

  it("installs nothing and marks every item denied when the batch confirmation is declined", async () => {
    vi.spyOn(confirmModule, "requestLocalConfirmation").mockResolvedValue(false);
    const installSpy = vi.spyOn(genericModule, "installGeneric");

    const results = await restoreSnapshot(items);
    expect(installSpy).not.toHaveBeenCalled();
    expect(results.every((r) => !r.installed && r.reason === "denied")).toBe(true);
  });

  // I2: installGeneric throws for unimplemented source types ("npm"/"url") and unsupported
  // targets (kind "mcp"). Without per-item isolation one bad item aborted every remaining
  // item in the batch and, since subscribeCommands invokes the handler as a floating
  // promise, took the whole daemon down with an unhandled rejection.
  it("records a failing item's error and still installs the rest of the batch", async () => {
    vi.spyOn(confirmModule, "requestLocalConfirmation").mockResolvedValue(true);
    vi.spyOn(genericModule, "installGeneric")
      .mockRejectedValueOnce(new Error("installer strategy not yet implemented for source type: npm"))
      .mockResolvedValueOnce({ installed: true, path: "/x" });

    const results = await restoreSnapshot(items);
    expect(results).toHaveLength(2);
    expect(results[0].installed).toBe(false);
    expect(results[0].reason).toMatch(/not yet implemented/);
    expect(results[1]).toMatchObject({ installed: true });
  });

  it("skips items without a usable source instead of throwing", async () => {
    vi.spyOn(confirmModule, "requestLocalConfirmation").mockResolvedValue(true);
    const manualItem = { ...items[0], sourceType: "manual", sourceRef: null };
    const results = await restoreSnapshot([manualItem]);
    expect(results[0]).toMatchObject({ installed: false, reason: "no_installable_source" });
  });
});
