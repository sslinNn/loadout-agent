import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startHeartbeat } from "../src/heartbeat";
import { readPackageVersion } from "../src/version";

describe("startHeartbeat", () => {
  it("immediately marks the machine online and updates last_seen_at", async () => {
    const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    const client = { from: () => ({ update }) } as any;

    const handle = startHeartbeat(client, "M1", { intervalMs: 10_000 });
    await Promise.resolve();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "online" }));
    handle.stop();
  });

  it("stop() marks the machine offline (best-effort, on graceful shutdown)", async () => {
    const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    const client = { from: () => ({ update }) } as any;

    const handle = startHeartbeat(client, "M1", { intervalMs: 10_000 });
    await Promise.resolve();
    update.mockClear();
    await handle.stop();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "offline" }));
  });

  it("re-reports agent_version on every beat, so an upgraded agent stops showing its pairing-time version", async () => {
    const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    const client = { from: () => ({ update }) } as any;

    const handle = startHeartbeat(client, "M1", { intervalMs: 10_000 });
    await Promise.resolve();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ agent_version: readPackageVersion() }));
    handle.stop();
  });

  it("reports the harnesses present on the machine so the dashboard can compute honest partial", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loadout-hb-harness-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    mkdirSync(path.join(home, ".cursor"), { recursive: true });
    const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    const client = { from: () => ({ update }) } as any;

    const handle = startHeartbeat(client, "M1", { intervalMs: 10_000, homeDir: home });
    await Promise.resolve();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ present_harnesses: expect.arrayContaining(["claude_code", "cursor"]) })
    );
    handle.stop();
    rmSync(home, { recursive: true, force: true });
  });
});
