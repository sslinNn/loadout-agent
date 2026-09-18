import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Thin, mockable wrapper around child_process.execFile — the seam service backends use so
 * tests can assert on the exact command built without touching the host's real
 * systemctl/launchctl. */
export const execFileAsync = promisify(execFile);
export type ExecFile = typeof execFileAsync;
