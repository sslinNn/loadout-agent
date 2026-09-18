import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  requestLocalConfirmation,
  approvePending,
  denyPending,
  startConfirmationServer,
  stopConfirmationServer,
  configureTrustWindow,
  resetTrustWindowForTests,
  nextConfirmationId,
  isSocketLive,
  hasPendingConfirmations
} from "../../src/installer/confirm";
import * as promptModule from "../../src/installer/prompt";
import * as log from "../../src/log";

// requestLocalConfirmation always tries promptWithButtons alongside the socket — left
// unmocked, this suite would spawn a real zenity/notify-send on any machine that has one on
// PATH and a display, which is exactly the "don't pop dialogs" a test run must never do.
// Individual tests below override this mock to capture the onDecision callback or disposer.
vi.mock("../../src/installer/prompt", () => ({ promptWithButtons: vi.fn(() => vi.fn()) }));

// A dedicated socket path for this test file so it never touches the real
// ~/.loadout/confirm.sock a running daemon on this machine might be using.
const socketPath = path.join(os.tmpdir(), `loadout-confirm-test-${process.pid}.sock`);

/**
 * Sends a raw `{ id, approved }` message over the confirmation socket using
 * a brand new `net` connection, deliberately *not* going through
 * approvePending/denyPending. This simulates what a genuinely separate
 * `loadout-agent approve <id>` OS process does on the wire, independent of
 * this module's own client helper.
 */
function sendRaw(payload: { id: string; approved: boolean }, targetSocketPath: string = socketPath): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(targetSocketPath);
    socket.once("connect", () => socket.end(JSON.stringify(payload)));
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
}

describe("requestLocalConfirmation (Unix domain socket IPC)", () => {
  // The daemon now narrates each pending confirmation. Silence it by default so the suite's
  // output stays pristine; the case that asserts on it installs its own capturing spy.
  beforeEach(() => {
    vi.spyOn(log, "info").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  beforeAll(async () => {
    // Simulates the `loadout-agent run` daemon starting its listener.
    await startConfirmationServer(socketPath);
  });

  afterAll(() => {
    stopConfirmationServer();
  });

  it("resolves true when a separate process connects to the socket and approves", async () => {
    const promise = requestLocalConfirmation({ id: "req-1", description: "install foo" }, { socketPath });
    await sendRaw({ id: "req-1", approved: true });
    await expect(promise).resolves.toBe(true);
  });

  it("resolves false when a separate process connects to the socket and denies", async () => {
    const promise = requestLocalConfirmation({ id: "req-2", description: "install bar" }, { socketPath });
    await sendRaw({ id: "req-2", approved: false });
    await expect(promise).resolves.toBe(false);
  });

  it("resolves false after the timeout elapses with no response", async () => {
    const promise = requestLocalConfirmation({ id: "req-3", description: "install baz" }, { timeoutMs: 50, socketPath });
    await expect(promise).resolves.toBe(false);
  });

  it("ignores messages for ids nobody is waiting on", async () => {
    const promise = requestLocalConfirmation({ id: "req-4", description: "install qux" }, { timeoutMs: 200, socketPath });
    await sendRaw({ id: "not-req-4", approved: true });
    await expect(promise).resolves.toBe(false);
  });

  // A desktop notification is absent on a headless machine and suppressed under
  // do-not-disturb, so without this the daemon is indistinguishable from a hang for the
  // full timeout — and the id the user must type lives only inside the notification.
  it("prints the approve command while it waits", async () => {
    const lines: string[] = [];
    vi.spyOn(log, "info").mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")));

    await requestLocalConfirmation(
      { id: "abc-123", description: "Install https://example.invalid/x (git) into claude_code (global)" },
      { timeoutMs: 50, socketPath }
    );

    expect(lines.join("\n")).toContain("loadout approve abc-123");
    expect(lines.join("\n")).toContain("loadout deny abc-123");
    expect(lines.join("\n")).toContain("Install https://example.invalid/x");
  });

  it("prints the outcome when a decision arrives", async () => {
    const lines: string[] = [];
    vi.spyOn(log, "info").mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")));

    const promise = requestLocalConfirmation({ id: "req-7", description: "install logged" }, { socketPath });
    await sendRaw({ id: "req-7", approved: true });
    await promise;

    expect(lines.join("\n")).toContain("approved: req-7");
  });

  describe("approvePending / denyPending (the functions the CLI's approve/deny commands call)", () => {
    it("approvePending delivers approval over the socket", async () => {
      const promise = requestLocalConfirmation({ id: "req-5", description: "install cli-approved" }, { socketPath });
      await approvePending("req-5", socketPath);
      await expect(promise).resolves.toBe(true);
    });

    it("denyPending delivers denial over the socket", async () => {
      const promise = requestLocalConfirmation({ id: "req-6", description: "install cli-denied" }, { socketPath });
      await denyPending("req-6", socketPath);
      await expect(promise).resolves.toBe(false);
    });
  });

  describe("promptWithButtons integration", () => {
    it("a button decision resolves the same promise the socket resolves", async () => {
      let decide: ((approved: boolean) => void) | undefined;
      vi.mocked(promptModule.promptWithButtons).mockImplementationOnce((_action, onDecision) => {
        decide = onDecision;
        return vi.fn();
      });

      const promise = requestLocalConfirmation({ id: "btn-1", description: "install via button" }, { socketPath });
      // requestLocalConfirmation awaits startConfirmationServer before it reaches the point of
      // calling promptWithButtons, so `decide` isn't assigned until that microtask settles.
      await new Promise((r) => setTimeout(r, 0));
      decide!(true);
      await expect(promise).resolves.toBe(true);
    });

    it("resolving via the socket disposes the still-open prompt", async () => {
      const dispose = vi.fn();
      vi.mocked(promptModule.promptWithButtons).mockImplementationOnce(() => dispose);

      const promise = requestLocalConfirmation({ id: "disp-1", description: "install" }, { socketPath });
      await sendRaw({ id: "disp-1", approved: true });
      await promise;

      expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("the timeout disposes the prompt too", async () => {
      const dispose = vi.fn();
      vi.mocked(promptModule.promptWithButtons).mockImplementationOnce(() => dispose);

      await requestLocalConfirmation({ id: "disp-2", description: "install" }, { timeoutMs: 30, socketPath });

      expect(dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe("trust window", () => {
    afterEach(() => resetTrustWindowForTests());

    it("an approval opens the window, and a later confirmation short-circuits without prompting", async () => {
      configureTrustWindow(5);

      const first = requestLocalConfirmation({ id: "trust-1", description: "first install" }, { socketPath });
      await sendRaw({ id: "trust-1", approved: true });
      await expect(first).resolves.toBe(true);

      vi.mocked(promptModule.promptWithButtons).mockClear();
      const second = await requestLocalConfirmation({ id: "trust-2", description: "second install" }, { socketPath });
      expect(second).toBe(true);
      expect(promptModule.promptWithButtons).not.toHaveBeenCalled();
    });

    it("a denial does not open the window", async () => {
      configureTrustWindow(5);

      const first = requestLocalConfirmation({ id: "trust-3", description: "first install" }, { socketPath });
      await sendRaw({ id: "trust-3", approved: false });
      await expect(first).resolves.toBe(false);

      // If the window had (incorrectly) opened, this would resolve true immediately instead
      // of waiting out its own short timeout.
      const second = requestLocalConfirmation({ id: "trust-4", description: "second install" }, { timeoutMs: 50, socketPath });
      await expect(second).resolves.toBe(false);
    });

    it("trustWindowMinutes = 0 preserves today's always-confirm behaviour", async () => {
      configureTrustWindow(0);

      const first = requestLocalConfirmation({ id: "trust-5", description: "first install" }, { socketPath });
      await sendRaw({ id: "trust-5", approved: true });
      await expect(first).resolves.toBe(true);

      const second = requestLocalConfirmation({ id: "trust-6", description: "second install" }, { timeoutMs: 50, socketPath });
      await expect(second).resolves.toBe(false);
    });
  });
});

describe("nextConfirmationId", () => {
  it("increments for the life of the process, without needing global uniqueness", () => {
    const a = Number(nextConfirmationId());
    const b = Number(nextConfirmationId());
    const c = Number(nextConfirmationId());
    expect(b).toBe(a + 1);
    expect(c).toBe(a + 2);
  });
});

// A dedicated socket path per test here too, kept separate from the shared `socketPath`
// above so starting/stopping a real listener in this block can't race the long-lived server
// the first describe block keeps open for its whole run.
describe("isSocketLive (the single-instance liveness probe)", () => {
  const livenessSocketPath = path.join(os.tmpdir(), `loadout-liveness-test-${process.pid}.sock`);

  afterEach(() => {
    stopConfirmationServer();
    if (fs.existsSync(livenessSocketPath)) fs.unlinkSync(livenessSocketPath);
  });

  it("resolves true when a daemon is actually listening on the socket", async () => {
    await startConfirmationServer(livenessSocketPath);
    await expect(isSocketLive(livenessSocketPath)).resolves.toBe(true);
  });

  it("resolves false when nothing is listening and no file exists (ENOENT)", async () => {
    await expect(isSocketLive(livenessSocketPath)).resolves.toBe(false);
  });

  it("resolves false for a stale socket file left behind by a crashed process (ECONNREFUSED)", async () => {
    // A dead process's socket file is not cleaned up by the OS — writing a plain file at the
    // path is enough to reproduce the shape of the failure: something on disk, nobody home.
    fs.writeFileSync(livenessSocketPath, "");
    await expect(isSocketLive(livenessSocketPath)).resolves.toBe(false);
  });

  it("startConfirmationServer proceeds to bind over a genuinely stale socket file", async () => {
    fs.writeFileSync(livenessSocketPath, "");
    await expect(startConfirmationServer(livenessSocketPath)).resolves.toBeTruthy();
    await expect(isSocketLive(livenessSocketPath)).resolves.toBe(true);
  });
});

describe("hasPendingConfirmations", () => {
  const socketPath = path.join(os.tmpdir(), `loadout-pending-test-${process.pid}.sock`);

  beforeAll(async () => {
    await startConfirmationServer(socketPath);
  });
  afterAll(() => stopConfirmationServer());
  beforeEach(() => vi.spyOn(log, "info").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("is false with nothing awaiting a decision, and true while one is pending", async () => {
    expect(hasPendingConfirmations()).toBe(false);

    const promise = requestLocalConfirmation({ id: "pending-1", description: "install" }, { socketPath });
    // requestLocalConfirmation awaits startConfirmationServer before registering the pending
    // entry, so (as with the promptWithButtons integration tests above) the registration lands
    // on a later microtask than this call itself.
    await new Promise((r) => setTimeout(r, 0));
    expect(hasPendingConfirmations()).toBe(true);

    await sendRaw({ id: "pending-1", approved: true }, socketPath);
    await promise;

    expect(hasPendingConfirmations()).toBe(false);
  });
});
