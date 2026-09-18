import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promptWithButtons } from "../../src/installer/prompt";
import notifier from "node-notifier";

vi.mock("node-notifier", () => ({ default: { notify: vi.fn() } }));

const action = { id: "1", description: "Install https://example.invalid/x into claude_code (global)" };

/** A resolved/rejected exec() call also carries a `.child` (see node:child_process's
 * PromiseWithChild) — Object.assign onto a real Promise reproduces that shape without
 * pulling in the real execFile/child_process machinery. */
function execResult(promise: Promise<{ stdout: string; stderr: string }>, child: { kill: ReturnType<typeof vi.fn> } = { kill: vi.fn() }) {
  return Object.assign(promise, { child });
}

function resolved(stdout = "", child?: { kill: ReturnType<typeof vi.fn> }) {
  return execResult(Promise.resolve({ stdout, stderr: "" }), child);
}

function rejected(code: string | number, child?: { kill: ReturnType<typeof vi.fn> }) {
  return execResult(Promise.reject(Object.assign(new Error(`exit ${code}`), { code })), child);
}

describe("promptWithButtons: channel selection", () => {
  it("no channel on an unrecognized platform: exec is never called and the disposer is a no-op", () => {
    const exec = vi.fn();
    const dispose = promptWithButtons(action, vi.fn(), { platform: "aix" as NodeJS.Platform, exec });
    expect(exec).not.toHaveBeenCalled();
    expect(() => dispose()).not.toThrow();
  });

  it("linux with neither WAYLAND_DISPLAY nor DISPLAY set: no channel, exec never called", () => {
    const originalDisplay = process.env.DISPLAY;
    const originalWayland = process.env.WAYLAND_DISPLAY;
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    try {
      const exec = vi.fn();
      promptWithButtons(action, vi.fn(), { platform: "linux", exec });
      expect(exec).not.toHaveBeenCalled();
    } finally {
      if (originalDisplay !== undefined) process.env.DISPLAY = originalDisplay;
      if (originalWayland !== undefined) process.env.WAYLAND_DISPLAY = originalWayland;
    }
  });

  it("linux with DISPLAY set tries zenity first", () => {
    const originalDisplay = process.env.DISPLAY;
    process.env.DISPLAY = ":0";
    try {
      const exec = vi.fn().mockReturnValue(resolved());
      promptWithButtons(action, vi.fn(), { platform: "linux", exec });
      expect(exec).toHaveBeenCalledWith("zenity", expect.arrayContaining(["--question", "--ok-label=Approve", "--cancel-label=Deny"]));
    } finally {
      if (originalDisplay === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = originalDisplay;
    }
  });
});

describe("promptWithButtons: linux decision parsing", () => {
  const withDisplay = { DISPLAY: ":0" };
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY };
    Object.assign(process.env, withDisplay);
    delete process.env.WAYLAND_DISPLAY;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("zenity exit 0: approved", async () => {
    const exec = vi.fn().mockReturnValue(resolved());
    const onDecision = vi.fn();
    promptWithButtons(action, onDecision, { platform: "linux", exec });
    await flush();
    expect(onDecision).toHaveBeenCalledWith(true);
  });

  it("zenity exit 1 (Deny, or the window was closed): denied", async () => {
    const exec = vi.fn().mockReturnValue(rejected(1));
    const onDecision = vi.fn();
    promptWithButtons(action, onDecision, { platform: "linux", exec });
    await flush();
    expect(onDecision).toHaveBeenCalledWith(false);
  });

  it("zenity exit 5 (its own --timeout elapsed): no decision", async () => {
    const exec = vi.fn().mockReturnValue(rejected(5));
    const onDecision = vi.fn();
    promptWithButtons(action, onDecision, { platform: "linux", exec });
    await flush();
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("zenity ENOENT falls back to notify-send, whose stdout picks the decision", async () => {
    const exec = vi.fn().mockReturnValueOnce(rejected("ENOENT")).mockReturnValueOnce(resolved("approve\n"));
    const onDecision = vi.fn();
    promptWithButtons(action, onDecision, { platform: "linux", exec });
    await flush();
    expect(exec).toHaveBeenNthCalledWith(2, "notify-send", expect.arrayContaining(["--action=approve=Approve", "--action=deny=Deny"]));
    expect(onDecision).toHaveBeenCalledWith(true);
  });

  it("notify-send stdout 'deny': denied", async () => {
    const exec = vi.fn().mockReturnValueOnce(rejected("ENOENT")).mockReturnValueOnce(resolved("deny\n"));
    const onDecision = vi.fn();
    promptWithButtons(action, onDecision, { platform: "linux", exec });
    await flush();
    expect(onDecision).toHaveBeenCalledWith(false);
  });

  it("notify-send empty stdout (expired with no click) is a no-op, never a denial", async () => {
    const exec = vi.fn().mockReturnValueOnce(rejected("ENOENT")).mockReturnValueOnce(resolved(""));
    const onDecision = vi.fn();
    promptWithButtons(action, onDecision, { platform: "linux", exec });
    await flush();
    expect(onDecision).not.toHaveBeenCalled();
  });

  // The description carries a marketplace listing's source ref, which anyone can publish, and
  // this prompt is the trust boundary the whole confirmation exists to defend. Markup in that
  // text must not be able to restyle or restructure what the reader is agreeing to.
  it("disables Pango markup in the zenity dialog", () => {
    const exec = vi.fn().mockReturnValue(resolved());
    promptWithButtons(action, vi.fn(), { platform: "linux", exec });
    expect(exec).toHaveBeenCalledWith("zenity", expect.arrayContaining(["--no-markup"]));
  });

  it("escapes markup in the notify-send body, whose daemon may advertise body-markup", async () => {
    const exec = vi.fn().mockReturnValueOnce(rejected("ENOENT")).mockReturnValueOnce(resolved(""));
    const hostile = {
      id: "1",
      description: 'Install <b>trusted</b> & <a href="x">safe</a> into claude_code (global)'
    };
    promptWithButtons(hostile, vi.fn(), { platform: "linux", exec });
    await flush();
    const body = (exec.mock.calls[1]![1] as string[]).at(-1)!;
    expect(body).not.toMatch(/<[a-z]/i);
    expect(body).toContain("&lt;b&gt;");
    expect(body).toContain("&amp;");
  });

  it("neither zenity nor notify-send present: no decision, nothing thrown", async () => {
    const exec = vi.fn().mockReturnValueOnce(rejected("ENOENT")).mockReturnValueOnce(rejected("ENOENT"));
    const onDecision = vi.fn();
    promptWithButtons(action, onDecision, { platform: "linux", exec });
    await flush();
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("a generic spawn error with no recognizable code is a no-op", async () => {
    const exec = vi.fn().mockReturnValue(execResult(Promise.reject(new Error("boom"))));
    const onDecision = vi.fn();
    promptWithButtons(action, onDecision, { platform: "linux", exec });
    await flush();
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("the disposer kills the child still running the dialog", () => {
    const child = { kill: vi.fn() };
    // Never resolves: this test only cares that dispose() reaches this exact child.
    const exec = vi.fn().mockReturnValue(execResult(new Promise(() => {}), child));
    const dispose = promptWithButtons(action, vi.fn(), { platform: "linux", exec });
    dispose();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("a decision that arrives after dispose() is ignored", async () => {
    const exec = vi.fn().mockReturnValue(resolved());
    const onDecision = vi.fn();
    const dispose = promptWithButtons(action, onDecision, { platform: "linux", exec });
    dispose();
    await flush();
    expect(onDecision).not.toHaveBeenCalled();
  });
});

describe("promptWithButtons: darwin/win32 via node-notifier", () => {
  beforeEach(() => vi.mocked(notifier.notify).mockClear());

  it.each(["darwin", "win32"] as const)("%s: posts actions+wait and maps the clicked label to a decision", (platform) => {
    const onDecision = vi.fn();
    promptWithButtons(action, onDecision, { platform });

    expect(notifier.notify).toHaveBeenCalledTimes(1);
    const [options, callback] = vi.mocked(notifier.notify).mock.calls[0];
    expect(options).toMatchObject({ actions: ["Approve", "Deny"], wait: true });

    callback!(null, "approve");
    expect(onDecision).toHaveBeenCalledWith(true);
  });

  it("a 'deny' response denies", () => {
    const onDecision = vi.fn();
    promptWithButtons(action, onDecision, { platform: "darwin" });
    const [, callback] = vi.mocked(notifier.notify).mock.calls[0];
    callback!(null, "deny");
    expect(onDecision).toHaveBeenCalledWith(false);
  });

  it("an unrecognized response (dismissal/timeout/click on neither action) is a no-op", () => {
    const onDecision = vi.fn();
    promptWithButtons(action, onDecision, { platform: "darwin" });
    const [, callback] = vi.mocked(notifier.notify).mock.calls[0];
    callback!(null, "activate");
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("disposing before the callback fires suppresses the decision", () => {
    const onDecision = vi.fn();
    const dispose = promptWithButtons(action, onDecision, { platform: "darwin" });
    dispose();
    const [, callback] = vi.mocked(notifier.notify).mock.calls[0];
    callback!(null, "approve");
    expect(onDecision).not.toHaveBeenCalled();
  });
});

/** Flushes the microtask queue enough times for the try/await/catch chain inside
 * runLinuxDialog (including its notify-send fallback) to settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
