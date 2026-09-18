import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileAsync, type ExecFile } from "./execFile.js";

const LABEL = "dev.loadout.agent";
const PLIST_NAME = `${LABEL}.plist`;

export function plistPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, "Library", "LaunchAgents", PLIST_NAME);
}

export function logPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".loadout", "logs", "agent.log");
}

export function renderPlist(
  execPath: string,
  scriptPath: string,
  homeDir: string = os.homedir(),
  env: Record<string, string> = {}
): string {
  const envEntries = Object.entries(env);
  const envBlock =
    envEntries.length === 0
      ? ""
      : `  <key>EnvironmentVariables</key>
  <dict>
${envEntries.map(([key, value]) => `    <key>${key}</key>\n    <string>${value}</string>`).join("\n")}
  </dict>
`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${execPath}</string>
    <string>${scriptPath}</string>
    <string>run</string>
    <string>--supervised</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
${envBlock}  <key>StandardOutPath</key>
  <string>${logPath(homeDir)}</string>
  <key>StandardErrorPath</key>
  <string>${logPath(homeDir)}</string>
</dict>
</plist>
`;
}

export interface LaunchdDeps {
  homeDir?: string;
  exec?: ExecFile;
}

export async function install(
  execPath: string,
  scriptPath: string,
  deps: LaunchdDeps = {},
  env: Record<string, string> = {}
): Promise<void> {
  const exec = deps.exec ?? execFileAsync;
  const homeDir = deps.homeDir ?? os.homedir();
  const file = plistPath(homeDir);
  mkdirSync(path.dirname(file), { recursive: true });
  mkdirSync(path.dirname(logPath(homeDir)), { recursive: true });
  writeFileSync(file, renderPlist(execPath, scriptPath, homeDir, env));
  // `launchctl load -w` on a job that's already loaded is a no-op — it neither restarts a
  // running process nor picks up the plist/binary just written above. Unload first so a
  // re-install after an npm upgrade actually ends up running the new code; the .catch mirrors
  // uninstall()'s own pattern below for "this job wasn't loaded", which is the common case on
  // a first install and must not fail it.
  await exec("launchctl", ["unload", file]).catch(() => {});
  await exec("launchctl", ["load", "-w", file]);
}

export async function uninstall(deps: LaunchdDeps = {}): Promise<void> {
  const exec = deps.exec ?? execFileAsync;
  const homeDir = deps.homeDir ?? os.homedir();
  const file = plistPath(homeDir);
  await exec("launchctl", ["unload", file]).catch(() => {});
  if (existsSync(file)) unlinkSync(file);
}

export async function status(deps: LaunchdDeps = {}): Promise<"active" | "inactive" | "not-installed"> {
  const exec = deps.exec ?? execFileAsync;
  const homeDir = deps.homeDir ?? os.homedir();
  if (!existsSync(plistPath(homeDir))) return "not-installed";
  try {
    await exec("launchctl", ["list", LABEL]);
    return "active";
  } catch {
    return "inactive";
  }
}
