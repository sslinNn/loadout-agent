import * as systemd from "./systemd.js";
import * as launchd from "./launchd.js";

export type ServiceStatus = "active" | "inactive" | "not-installed";
export type ServiceResult = { ok: true } | { ok: false; message: string };

/**
 * The service backends need the *real* executable/script paths, not something resolved off
 * PATH — a service unit runs with no shell and no PATH guarantees. `process.execPath` is
 * node's own absolute path; `process.argv[1]` is whichever bin script the user actually ran
 * (`loadout` or `loadout-agent` — both resolve to the same file), which is exactly what a
 * unit/plist's ExecStart/ProgramArguments should re-invoke.
 */
function resolveTargetPaths(): { execPath: string; scriptPath: string } {
  return { execPath: process.execPath, scriptPath: process.argv[1] };
}

/**
 * Neither systemd `--user` units nor launchd LaunchAgents inherit the installing shell's
 * exported environment. Without forwarding these explicitly, a self-hosted/local-dev user
 * who exports LOADOUT_SUPABASE_URL/LOADOUT_SUPABASE_ANON_KEY, pairs, then installs the
 * service gets a background daemon that silently falls back to the bundled production
 * values instead of their own. Only these two vars are agent-specific overrides worth
 * carrying into the unit/plist — grep `process.env.` under src/ before adding more.
 */
function resolveServiceEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.LOADOUT_SUPABASE_URL) env.LOADOUT_SUPABASE_URL = process.env.LOADOUT_SUPABASE_URL;
  if (process.env.LOADOUT_SUPABASE_ANON_KEY) env.LOADOUT_SUPABASE_ANON_KEY = process.env.LOADOUT_SUPABASE_ANON_KEY;
  return env;
}

export async function installService(): Promise<ServiceResult> {
  const { execPath, scriptPath } = resolveTargetPaths();
  const env = resolveServiceEnv();
  try {
    if (process.platform === "linux") {
      await systemd.install(execPath, scriptPath, {}, env);
      return { ok: true };
    }
    if (process.platform === "darwin") {
      await launchd.install(execPath, scriptPath, {}, env);
      return { ok: true };
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `Failed to install the loadout service: ${reason}\nYou can still run the agent in the foreground with 'loadout run'.`
    };
  }
  return {
    ok: false,
    message: `'loadout service install' isn't supported on ${process.platform} yet — run 'loadout run' directly instead.`
  };
}

export async function uninstallService(): Promise<ServiceResult> {
  try {
    if (process.platform === "linux") {
      await systemd.uninstall();
      return { ok: true };
    }
    if (process.platform === "darwin") {
      await launchd.uninstall();
      return { ok: true };
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `Failed to remove the loadout service: ${reason}\nYou can stop a foreground run with Ctrl+C, or remove it manually.`
    };
  }
  return { ok: false, message: `No loadout-agent service to remove on ${process.platform}.` };
}

export async function serviceStatus(): Promise<ServiceStatus | "unsupported"> {
  if (process.platform === "linux") return systemd.status();
  if (process.platform === "darwin") return launchd.status();
  return "unsupported";
}
