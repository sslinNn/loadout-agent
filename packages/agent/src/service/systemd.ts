import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileAsync, type ExecFile } from "./execFile.js";

const UNIT_NAME = "loadout-agent.service";

export function unitPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".config", "systemd", "user", UNIT_NAME);
}

export function renderUnit(execPath: string, scriptPath: string, env: Record<string, string> = {}): string {
  const envLines = Object.entries(env)
    .map(([key, value]) => `Environment="${key}=${value}"\n`)
    .join("");
  return `[Unit]
Description=loadout agent

[Service]
ExecStart=${execPath} ${scriptPath} run --supervised
Restart=always
RestartSec=5
${envLines}
[Install]
WantedBy=default.target
`;
}

export interface SystemdDeps {
  homeDir?: string;
  exec?: ExecFile;
}

export async function install(
  execPath: string,
  scriptPath: string,
  deps: SystemdDeps = {},
  env: Record<string, string> = {}
): Promise<void> {
  const exec = deps.exec ?? execFileAsync;
  const file = unitPath(deps.homeDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, renderUnit(execPath, scriptPath, env));
  try {
    await exec("systemctl", ["--user", "daemon-reload"]);
    await exec("systemctl", ["--user", "enable", "loadout-agent"]);
    // `enable --now` only STARTS a stopped unit — it does nothing to one that's already
    // running, which is exactly the case after `npm install -g` bumps the code while the old
    // process is still up (the incident this fixes: a service ran 0.0.7 for a day after 0.1.0
    // was installed, because re-running `service install` never restarted it). `restart`
    // covers both: starts it if stopped, replaces it if running.
    await exec("systemctl", ["--user", "restart", "loadout-agent"]);
  } catch (err) {
    // The unit file above is written before either systemctl call — if daemon-reload or
    // enable fails (no user D-Bus session, bad unit syntax, etc.) we must not leave that
    // file on disk: status()'s existsSync-based short-circuit would otherwise report a
    // stale "active"/"inactive" for a service that was never actually daemon-reload'd.
    if (existsSync(file)) unlinkSync(file);
    throw err;
  }
}

export async function uninstall(deps: SystemdDeps = {}): Promise<void> {
  const exec = deps.exec ?? execFileAsync;
  await exec("systemctl", ["--user", "disable", "--now", "loadout-agent"]).catch(() => {});
  const file = unitPath(deps.homeDir);
  if (existsSync(file)) unlinkSync(file);
  await exec("systemctl", ["--user", "daemon-reload"]).catch(() => {});
}

export async function status(deps: SystemdDeps = {}): Promise<"active" | "inactive" | "not-installed"> {
  const exec = deps.exec ?? execFileAsync;
  const file = unitPath(deps.homeDir);
  if (!existsSync(file)) return "not-installed";
  try {
    const { stdout } = await exec("systemctl", ["--user", "is-active", "loadout-agent"]);
    return stdout.trim() === "active" ? "active" : "inactive";
  } catch (err) {
    // `systemctl is-active` exits non-zero for a stopped/failed unit, but still prints the
    // state to stdout — that is a normal status, not a failed call.
    const stdout = (err as { stdout?: string }).stdout;
    return stdout?.trim() === "active" ? "active" : "inactive";
  }
}
