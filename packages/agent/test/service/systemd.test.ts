import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderUnit, unitPath, install, uninstall, status } from "../../src/service/systemd";

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loadout-systemd-test-"));
}

describe("renderUnit", () => {
  it("builds a unit file with the given exec/script paths, running supervised and restarting always", () => {
    const unit = renderUnit("/usr/bin/node", "/opt/loadout/bin/loadout-agent.js");
    expect(unit).toContain("ExecStart=/usr/bin/node /opt/loadout/bin/loadout-agent.js run --supervised");
    // Restart=on-failure does NOT restart a process that exits 0 — and --supervised makes
    // the daemon exit 0 on purpose after an upgrade, specifically so the service manager
    // brings it back on the new code. Restart=always is what actually does that.
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("omits any Environment= lines when no env vars are given, leaving the unit unchanged", () => {
    const unit = renderUnit("/usr/bin/node", "/opt/loadout/bin/loadout-agent.js");
    expect(unit).not.toContain("Environment=");
    expect(unit).toBe(`[Unit]
Description=loadout agent

[Service]
ExecStart=/usr/bin/node /opt/loadout/bin/loadout-agent.js run --supervised
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`);
  });

  it("emits one Environment= line per entry in the given env map", () => {
    const unit = renderUnit("/usr/bin/node", "/opt/loadout/bin/loadout-agent.js", {
      LOADOUT_SUPABASE_URL: "https://example.supabase.co",
      LOADOUT_SUPABASE_ANON_KEY: "anon-key"
    });
    expect(unit).toBe(`[Unit]
Description=loadout agent

[Service]
ExecStart=/usr/bin/node /opt/loadout/bin/loadout-agent.js run --supervised
Restart=always
RestartSec=5
Environment="LOADOUT_SUPABASE_URL=https://example.supabase.co"
Environment="LOADOUT_SUPABASE_ANON_KEY=anon-key"

[Install]
WantedBy=default.target
`);
  });
});

describe("systemd install/uninstall/status", () => {
  it("install() writes the unit file and enables it via systemctl", async () => {
    const homeDir = tmpHome();
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    await install("/usr/bin/node", "/opt/loadout/bin/loadout-agent.js", { homeDir, exec });

    const file = unitPath(homeDir);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain(
      "ExecStart=/usr/bin/node /opt/loadout/bin/loadout-agent.js run --supervised"
    );
    expect(exec).toHaveBeenCalledWith("systemctl", ["--user", "daemon-reload"]);
    expect(exec).toHaveBeenCalledWith("systemctl", ["--user", "enable", "loadout-agent"]);
  });

  it("install() restarts the unit rather than relying on enable --now, so a re-install after an npm upgrade actually replaces an already-running process", async () => {
    const homeDir = tmpHome();
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    await install("/usr/bin/node", "/opt/loadout/bin/loadout-agent.js", { homeDir, exec });

    expect(exec).toHaveBeenCalledWith("systemctl", ["--user", "restart", "loadout-agent"]);
    // enable must come before restart: restart alone starts a unit that was never enabled
    // for THIS boot but won't be brought back on the next one.
    const findCallIndex = (args: string[]) =>
      exec.mock.calls.findIndex(([, callArgs]) => JSON.stringify(callArgs) === JSON.stringify(args));
    expect(findCallIndex(["--user", "enable", "loadout-agent"])).toBeLessThan(
      findCallIndex(["--user", "restart", "loadout-agent"])
    );
  });

  it("status() returns 'not-installed' when the unit file does not exist, without shelling out", async () => {
    const homeDir = tmpHome();
    const exec = vi.fn();

    await expect(status({ homeDir, exec })).resolves.toBe("not-installed");
    expect(exec).not.toHaveBeenCalled();
  });

  it("status() returns 'active' when systemctl reports the unit active", async () => {
    const homeDir = tmpHome();
    fs.mkdirSync(path.dirname(unitPath(homeDir)), { recursive: true });
    fs.writeFileSync(unitPath(homeDir), "placeholder");
    const exec = vi.fn().mockResolvedValue({ stdout: "active\n", stderr: "" });

    await expect(status({ homeDir, exec })).resolves.toBe("active");
  });

  it("status() returns 'inactive' when systemctl exits non-zero for a stopped unit", async () => {
    const homeDir = tmpHome();
    fs.mkdirSync(path.dirname(unitPath(homeDir)), { recursive: true });
    fs.writeFileSync(unitPath(homeDir), "placeholder");
    const exec = vi.fn().mockRejectedValue(Object.assign(new Error("exit 3"), { stdout: "inactive\n" }));

    await expect(status({ homeDir, exec })).resolves.toBe("inactive");
  });

  it("install() removes the unit file it just wrote and rethrows when systemctl fails", async () => {
    const homeDir = tmpHome();
    const exec = vi.fn().mockRejectedValue(new Error("Failed to connect to bus: No such file or directory"));

    await expect(install("/usr/bin/node", "/opt/loadout/bin/loadout-agent.js", { homeDir, exec })).rejects.toThrow(
      "Failed to connect to bus"
    );

    expect(fs.existsSync(unitPath(homeDir))).toBe(false);
  });

  it("uninstall() disables the unit via systemctl and removes the file", async () => {
    const homeDir = tmpHome();
    fs.mkdirSync(path.dirname(unitPath(homeDir)), { recursive: true });
    fs.writeFileSync(unitPath(homeDir), "placeholder");
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    await uninstall({ homeDir, exec });

    expect(fs.existsSync(unitPath(homeDir))).toBe(false);
    expect(exec).toHaveBeenCalledWith("systemctl", ["--user", "disable", "--now", "loadout-agent"]);
  });
});
