import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderPlist, plistPath, logPath, install, uninstall, status } from "../../src/service/launchd";

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loadout-launchd-test-"));
}

describe("renderPlist", () => {
  it("builds a plist with the given exec/script paths, RunAtLoad and KeepAlive", () => {
    const homeDir = tmpHome();
    const plist = renderPlist("/usr/bin/node", "/opt/loadout/bin/loadout-agent.js", homeDir);
    expect(plist).toContain("<string>/usr/bin/node</string>");
    expect(plist).toContain("<string>/opt/loadout/bin/loadout-agent.js</string>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<string>--supervised</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain(logPath(homeDir));
  });

  it("omits EnvironmentVariables entirely when no env vars are given, leaving the plist unchanged", () => {
    const homeDir = tmpHome();
    const plist = renderPlist("/usr/bin/node", "/opt/loadout/bin/loadout-agent.js", homeDir);
    expect(plist).not.toContain("EnvironmentVariables");
    expect(plist).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.loadout.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/node</string>
    <string>/opt/loadout/bin/loadout-agent.js</string>
    <string>run</string>
    <string>--supervised</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath(homeDir)}</string>
  <key>StandardErrorPath</key>
  <string>${logPath(homeDir)}</string>
</dict>
</plist>
`);
  });

  it("emits an EnvironmentVariables dict with one key/string pair per entry in the given env map", () => {
    const homeDir = tmpHome();
    const plist = renderPlist("/usr/bin/node", "/opt/loadout/bin/loadout-agent.js", homeDir, {
      LOADOUT_SUPABASE_URL: "https://example.supabase.co",
      LOADOUT_SUPABASE_ANON_KEY: "anon-key"
    });
    expect(plist).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.loadout.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/node</string>
    <string>/opt/loadout/bin/loadout-agent.js</string>
    <string>run</string>
    <string>--supervised</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LOADOUT_SUPABASE_URL</key>
    <string>https://example.supabase.co</string>
    <key>LOADOUT_SUPABASE_ANON_KEY</key>
    <string>anon-key</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${logPath(homeDir)}</string>
  <key>StandardErrorPath</key>
  <string>${logPath(homeDir)}</string>
</dict>
</plist>
`);
  });
});

describe("launchd install/uninstall/status", () => {
  it("install() writes the plist, the log directory, and loads it via launchctl", async () => {
    const homeDir = tmpHome();
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    await install("/usr/bin/node", "/opt/loadout/bin/loadout-agent.js", { homeDir, exec });

    const file = plistPath(homeDir);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.dirname(logPath(homeDir)))).toBe(true);
    expect(exec).toHaveBeenCalledWith("launchctl", ["load", "-w", file]);
  });

  it("install() unloads any existing job before loading, so re-installing after an upgrade actually restarts a running job", async () => {
    const homeDir = tmpHome();
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const file = plistPath(homeDir);

    await install("/usr/bin/node", "/opt/loadout/bin/loadout-agent.js", { homeDir, exec });

    expect(exec).toHaveBeenCalledWith("launchctl", ["unload", file]);
    const findCallIndex = (args: string[]) =>
      exec.mock.calls.findIndex(([, callArgs]) => JSON.stringify(callArgs) === JSON.stringify(args));
    expect(findCallIndex(["unload", file])).toBeLessThan(findCallIndex(["load", "-w", file]));
  });

  it("install() tolerates unload failing when no job was loaded yet (the common first-install case)", async () => {
    const homeDir = tmpHome();
    const exec = vi.fn().mockImplementation((_bin: string, args: string[]) =>
      args[0] === "unload" ? Promise.reject(new Error("Could not find service")) : Promise.resolve({ stdout: "", stderr: "" })
    );

    await expect(install("/usr/bin/node", "/opt/loadout/bin/loadout-agent.js", { homeDir, exec })).resolves.toBeUndefined();
    expect(exec).toHaveBeenCalledWith("launchctl", ["load", "-w", plistPath(homeDir)]);
  });

  it("status() returns 'not-installed' when the plist does not exist, without shelling out", async () => {
    const homeDir = tmpHome();
    const exec = vi.fn();

    await expect(status({ homeDir, exec })).resolves.toBe("not-installed");
    expect(exec).not.toHaveBeenCalled();
  });

  it("status() returns 'active' when launchctl list succeeds", async () => {
    const homeDir = tmpHome();
    fs.mkdirSync(path.dirname(plistPath(homeDir)), { recursive: true });
    fs.writeFileSync(plistPath(homeDir), "placeholder");
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    await expect(status({ homeDir, exec })).resolves.toBe("active");
  });

  it("status() returns 'inactive' when launchctl list fails (not loaded)", async () => {
    const homeDir = tmpHome();
    fs.mkdirSync(path.dirname(plistPath(homeDir)), { recursive: true });
    fs.writeFileSync(plistPath(homeDir), "placeholder");
    const exec = vi.fn().mockRejectedValue(new Error("Could not find service"));

    await expect(status({ homeDir, exec })).resolves.toBe("inactive");
  });

  it("uninstall() unloads via launchctl and removes the plist", async () => {
    const homeDir = tmpHome();
    fs.mkdirSync(path.dirname(plistPath(homeDir)), { recursive: true });
    fs.writeFileSync(plistPath(homeDir), "placeholder");
    const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    await uninstall({ homeDir, exec });

    expect(fs.existsSync(plistPath(homeDir))).toBe(false);
    expect(exec).toHaveBeenCalledWith("launchctl", ["unload", plistPath(homeDir)]);
  });
});
