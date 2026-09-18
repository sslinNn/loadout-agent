import net from "node:net";
import type { Server, Socket } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as log from "../log.js";
import { promptWithButtons } from "./prompt.js";

export interface ConfirmAction {
  id: string;
  description: string;
}

export interface RequestLocalConfirmationOptions {
  timeoutMs?: number;
  /** Override the IPC socket/pipe path. Intended for tests. */
  socketPath?: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// Global uniqueness is not the requirement — the id only has to be unique among *currently
// pending* confirmations, and an entry is deleted the moment it resolves. A monotonic counter
// gives that for free without asking a human to read and retype a UUID off a log line.
let idCounter = 0;

export function nextConfirmationId(): string {
  idCounter += 1;
  return String(idCounter);
}

/**
 * The path the running `loadout-agent run` daemon listens on, and that a
 * separate `loadout-agent approve <id>` / `deny <id>` invocation connects to.
 * On POSIX this is a Unix domain socket file under ~/.loadout (matching the
 * convention used by localConfig.ts's config.json / credentials.json). On
 * Windows there is no filesystem-backed equivalent, so we use a named pipe.
 */
export function defaultSocketPath(): string {
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\loadout-agent-confirm";
  }
  return path.join(os.homedir(), ".loadout", "confirm.sock");
}

// Resolvers for confirmations this process is currently awaiting. Populated
// by requestLocalConfirmation, resolved when a socket message arrives (from
// this same process's approvePending/denyPending, or from a separate
// `loadout-agent approve/deny` process connecting over the socket).
const pending = new Map<string, (approved: boolean) => void>();

// Disposers returned by promptWithButtons, keyed the same as `pending`. Torn down from
// resolvePendingId so that answering in the terminal — or the timeout below expiring —
// closes a dialog/notification still sitting on screen instead of leaving it orphaned.
const promptDisposers = new Map<string, () => void>();

let server: Server | null = null;
let serverSocketPath: string | null = null;
let serverStartPromise: Promise<Server> | null = null;

// In-memory only (see the design doc's non-goals: a file granting "skip confirmation" would
// have to be trusted as much as the gate it bypasses). `trustWindowMinutes` is the configured
// length, set once at daemon start; `trustedUntil` is the timestamp an approval last extended.
let trustWindowMinutes = 0;
let trustedUntil = 0;

/** Called from the `run` command at daemon start, with the value read out of local config. */
export function configureTrustWindow(minutes: number): void {
  trustWindowMinutes = minutes;
}

/** Test-only: clears trust-window state so test cases don't leak it into one another. */
export function resetTrustWindowForTests(): void {
  trustWindowMinutes = 0;
  trustedUntil = 0;
}

function disposePrompt(id: string): void {
  const dispose = promptDisposers.get(id);
  if (dispose) {
    promptDisposers.delete(id);
    dispose();
  }
}

function resolvePendingId(id: string, approved: boolean): void {
  const resolve = pending.get(id);
  if (resolve) {
    pending.delete(id);
    // Only an approval extends the window, and only once one is configured — a denial
    // cannot be reached while a window is already open, so it never needs to clear one.
    if (approved && trustWindowMinutes > 0) {
      trustedUntil = Date.now() + trustWindowMinutes * 60_000;
    }
    resolve(approved);
  }
  disposePrompt(id);
}

function handleConnection(socket: Socket): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.setTimeout(5000, () => socket.destroy());
  socket.on("data", (chunk) => {
    buffer += chunk;
  });
  socket.on("end", () => {
    try {
      const message = JSON.parse(buffer) as { id?: unknown; approved?: unknown };
      if (typeof message.id === "string" && typeof message.approved === "boolean") {
        resolvePendingId(message.id, message.approved);
      }
    } catch {
      // Ignore malformed messages rather than crashing the daemon.
    }
    socket.end();
  });
  socket.on("error", () => {
    // A disconnecting client can produce transport errors (e.g. ECONNRESET);
    // the daemon must keep running regardless.
  });
}

/**
 * The standard Unix-domain-socket liveness check: try to connect. A successful connect means
 * a process is bound and accepting connections there right now. `ECONNREFUSED` means the
 * socket *file* survived but nothing is listening behind it (its owner died without cleaning
 * up — e.g. `kill -9`, or a crash); `ENOENT` means there's no file at all. Either of those is
 * "free to take"; a live connect is not. Windows named pipes behave the same way for this
 * purpose — a stale pipe simply refuses/vanishes rather than accepting a connection.
 *
 * This is also the fix for the September incident's second symptom: `loadout run` used to
 * unlink and rebind this path unconditionally, so a second daemon silently stole the socket
 * out from under a first one that was still alive, and `loadout approve <id>` then reached
 * only whichever daemon bound last.
 */
export function isSocketLive(socketPath: string = defaultSocketPath()): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** Whether this daemon currently has a confirmation awaiting a human decision. Exported as a
 * predicate — rather than letting a caller reach into `pending` directly — because the one
 * caller that needs this (the upgrade-restart check; see upgradeWatch.ts) must never treat a
 * half-finished install as a safe moment to exit, and this is the single fact it needs. */
export function hasPendingConfirmations(): boolean {
  return pending.size > 0;
}

async function removeStaleSocketFile(socketPath: string): Promise<void> {
  if (process.platform === "win32") return;
  if (!fs.existsSync(socketPath)) return;
  // Only unlink a socket nothing is listening on. Removing a live one would let this bind
  // steal the path from a daemon that's still running (see isSocketLive's doc comment) — the
  // single-instance guard in cli.ts's `run` command is supposed to have already refused that
  // case, but this check is what makes the guarantee hold here too, independent of callers.
  if (await isSocketLive(socketPath)) return;
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // Best effort cleanup; listen() below will surface any real problem.
  }
}

/**
 * Idempotently ensure the confirmation IPC server is listening. Safe to call
 * repeatedly (e.g. once per requestLocalConfirmation call) — it reuses the
 * existing listener when already bound to the same path.
 */
export function startConfirmationServer(socketPath: string = defaultSocketPath()): Promise<Server> {
  if (server && serverSocketPath === socketPath) {
    return Promise.resolve(server);
  }
  if (server && serverSocketPath !== socketPath) {
    server.close();
    server = null;
    serverSocketPath = null;
  }
  if (serverStartPromise) {
    return serverStartPromise;
  }

  serverStartPromise = (async () => {
    if (process.platform !== "win32") {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true });
      await removeStaleSocketFile(socketPath);
    }

    return new Promise<Server>((resolve, reject) => {
      const newServer = net.createServer(handleConnection);
      newServer.once("error", (err) => {
        serverStartPromise = null;
        reject(err);
      });
      newServer.listen(socketPath, () => {
        if (process.platform !== "win32") {
          try {
            // Unix domain socket files inherit the umask by default; restrict
            // to the owning user since this channel can approve local disk
            // writes.
            fs.chmodSync(socketPath, 0o600);
          } catch {
            // Best effort; not fatal if the filesystem doesn't support it.
          }
        }
        server = newServer;
        serverSocketPath = socketPath;
        serverStartPromise = null;
        resolve(newServer);
      });
    });
  })();

  return serverStartPromise;
}

/** Stop the confirmation IPC server and clean up its socket file. Test-only. */
export function stopConfirmationServer(): void {
  if (server) {
    server.close();
  }
  if (serverSocketPath && process.platform !== "win32") {
    // Unlike removeStaleSocketFile, no liveness check is needed here: this is our own
    // listener that we just closed above, so the file is unconditionally ours to remove.
    try {
      fs.unlinkSync(serverSocketPath);
    } catch {
      // Already gone, or never existed under this path; nothing to clean up.
    }
  }
  server = null;
  serverSocketPath = null;
  serverStartPromise = null;
}

/**
 * Request confirmation for a locally-impactful action. When an earlier approval's trust
 * window (see configureTrustWindow) still covers this moment, resolves `true` immediately
 * with no prompt at all. Otherwise it both tries to draw real buttons (promptWithButtons —
 * best-effort, degrades to nothing on a headless machine) and, in all cases, waits on the
 * local IPC socket for an `approve <id>` / `deny <id>` decision — buttons aren't available on
 * every OS/notification daemon, so the socket is the guaranteed path underneath them.
 * Resolves `false` if nothing responds within the timeout (default 10 minutes).
 */
export async function requestLocalConfirmation(
  action: ConfirmAction,
  opts: RequestLocalConfirmationOptions = {}
): Promise<boolean> {
  const socketPath = opts.socketPath ?? defaultSocketPath();
  await startConfirmationServer(socketPath);

  if (Date.now() < trustedUntil) {
    log.info(`trust window covers: ${action.description}`);
    return true;
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pending.delete(action.id);
      disposePrompt(action.id);
      resolve(false);
    }, timeoutMs);
    if (typeof timeout.unref === "function") timeout.unref();

    pending.set(action.id, (approved) => {
      clearTimeout(timeout);
      log.info(`${approved ? "approved" : "denied"}: ${action.id}`);
      resolve(approved);
    });

    // The desktop prompt is a convenience, not the channel. It is absent on a headless
    // machine and suppressed under do-not-disturb, and without this line the daemon looks
    // hung for the full ten-minute timeout.
    log.info(`waiting for approval: ${action.description}`);
    log.info(`  approve: loadout approve ${action.id}`);
    log.info(`  deny:    loadout deny ${action.id}`);

    // Routes through resolvePendingId — same as a socket message — so a button click and
    // `loadout approve/deny <id>` race fairly and whichever answers first wins.
    promptDisposers.set(
      action.id,
      promptWithButtons(action, (approved) => resolvePendingId(action.id, approved), { timeoutMs })
    );
  });
}

function sendDecision(id: string, approved: boolean, socketPath: string = defaultSocketPath()): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => {
      socket.end(JSON.stringify({ id, approved }));
    });
    socket.once("close", () => resolve());
    socket.once("error", (err) => reject(err));
  });
}

/**
 * Called from a `loadout-agent approve <id>` invocation — ordinarily a
 * separate OS process from the `loadout-agent run` daemon holding the
 * pending confirmation. Connects to the daemon's IPC socket and sends the
 * decision; does not touch any in-memory state directly.
 */
export function approvePending(id: string, socketPath?: string): Promise<void> {
  return sendDecision(id, true, socketPath);
}

export function denyPending(id: string, socketPath?: string): Promise<void> {
  return sendDecision(id, false, socketPath);
}
