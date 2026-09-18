import { describe, it, expect, vi, afterEach } from "vitest";

const originalPlatform = process.platform;
function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value });
}
afterEach(() => setPlatform(originalPlatform));

vi.mock("../../src/service/systemd.js", () => ({
  install: vi.fn().mockResolvedValue(undefined),
  uninstall: vi.fn().mockResolvedValue(undefined),
  status: vi.fn().mockResolvedValue("active")
}));
vi.mock("../../src/service/launchd.js", () => ({
  install: vi.fn().mockResolvedValue(undefined),
  uninstall: vi.fn().mockResolvedValue(undefined),
  status: vi.fn().mockResolvedValue("active")
}));

import * as systemd from "../../src/service/systemd.js";
import * as launchd from "../../src/service/launchd.js";
import { installService, uninstallService, serviceStatus } from "../../src/service/index";

describe("service dispatcher", () => {
  it("installs via systemd on linux", async () => {
    setPlatform("linux");
    await expect(installService()).resolves.toEqual({ ok: true });
    expect(systemd.install).toHaveBeenCalled();
    expect(launchd.install).not.toHaveBeenCalled();
  });

  it("installs via launchd on darwin", async () => {
    setPlatform("darwin");
    await expect(installService()).resolves.toEqual({ ok: true });
    expect(launchd.install).toHaveBeenCalled();
  });

  it("returns a friendly failure instead of installing on an unsupported platform", async () => {
    setPlatform("win32");
    const result = await installService();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("loadout run");
  });

  it("status() reports 'unsupported' on an unsupported platform without calling either backend", async () => {
    setPlatform("win32");
    await expect(serviceStatus()).resolves.toBe("unsupported");
  });

  it("uninstallService() dispatches to systemd on linux", async () => {
    setPlatform("linux");
    await expect(uninstallService()).resolves.toEqual({ ok: true });
    expect(systemd.uninstall).toHaveBeenCalled();
  });

  it("installService() reports a friendly failure instead of throwing when systemd.install rejects", async () => {
    setPlatform("linux");
    vi.mocked(systemd.install).mockRejectedValueOnce(new Error("Failed to connect to bus"));
    const result = await installService();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Failed to connect to bus");
      expect(result.message).toContain("loadout run");
    }
  });

  it("installService() reports a friendly failure instead of throwing when launchd.install rejects", async () => {
    setPlatform("darwin");
    vi.mocked(launchd.install).mockRejectedValueOnce(new Error("service already loaded"));
    const result = await installService();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("service already loaded");
      expect(result.message).toContain("loadout run");
    }
  });

  it("uninstallService() reports a friendly failure instead of throwing when systemd.uninstall rejects", async () => {
    setPlatform("linux");
    vi.mocked(systemd.uninstall).mockRejectedValueOnce(new Error("no such unit"));
    const result = await uninstallService();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("no such unit");
  });

  it("uninstallService() reports a friendly failure instead of throwing when launchd.uninstall rejects", async () => {
    setPlatform("darwin");
    vi.mocked(launchd.uninstall).mockRejectedValueOnce(new Error("no such label"));
    const result = await uninstallService();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("no such label");
  });
});
