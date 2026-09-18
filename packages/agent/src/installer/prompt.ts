import notifier from "node-notifier";
import type { ChildProcess } from "node:child_process";
import { execFileAsync, type ExecFile } from "../service/execFile.js";
import type { ConfirmAction } from "./confirm.js";

export interface PromptDeps {
  /** Defaulted to process.platform so channel selection is unit-testable. */
  platform?: NodeJS.Platform;
  /** Defaulted to a promisified node:child_process.execFile so the zenity/notify-send path
   * is unit-testable without spawning anything real. */
  exec?: ExecFile;
  /** How long the drawn dialog/notification should itself wait before giving up — kept in
   * sync with the caller's confirmation timeout so the button doesn't vanish first. */
  timeoutMs?: number;
}

// Matches confirm.ts's DEFAULT_TIMEOUT_MS. Duplicated rather than imported: confirm.ts
// imports this module, so importing back would make the two files a cycle over a single
// constant that almost never needs to move independently.
const FALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

type Decision = "approved" | "denied" | "no-decision";

const noop = (): void => {};

/**
 * Ask a human on this machine to approve or deny `action`, with real buttons where the OS
 * can draw them. Picks exactly one channel — the first that can work here — rather than
 * racing several, which would stack a dialog on top of a notification for the same question.
 * Only "approve"/"deny" (or their platform spellings) call `onDecision`; dismissal, expiry,
 * an empty response, a spawn failure and a missing binary all mean *no decision* and are
 * silently ignored — the caller's own IPC socket is the guaranteed path underneath this.
 *
 * Returns a disposer that tears down whatever is still on screen (e.g. because the terminal
 * `loadout approve/deny <id>` path answered first).
 */
export function promptWithButtons(
  action: ConfirmAction,
  onDecision: (approved: boolean) => void,
  deps: PromptDeps = {}
): () => void {
  const platform = deps.platform ?? process.platform;
  const timeoutMs = deps.timeoutMs ?? FALLBACK_TIMEOUT_MS;

  if (platform === "darwin" || platform === "win32") {
    return promptViaNodeNotifier(action, onDecision, timeoutMs);
  }

  if (platform !== "linux") {
    // Headless daemon, no display, or an OS this module doesn't have a dialog for.
    return noop;
  }
  if (!process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) {
    return noop;
  }

  const exec = deps.exec ?? execFileAsync;
  let disposed = false;
  let activeChild: ChildProcess | undefined;

  runLinuxDialog(exec, action, timeoutMs, (child) => {
    activeChild = child;
  }).then((decision) => {
    if (!disposed && decision !== "no-decision") onDecision(decision === "approved");
  });

  return () => {
    disposed = true;
    activeChild?.kill();
  };
}

/**
 * zenity first (real buttons, verified on the author's machine: exit 0 Approve, 1 Deny/closed,
 * 5 zenity's own --timeout). If it isn't on PATH the exec rejects with ENOENT rather than
 * running at all, which is what triggers the notify-send fallback — no separate "is zenity
 * installed" probe needed. Where neither exists, or notify-send's daemon draws no buttons,
 * this reports no-decision rather than guessing.
 */
async function runLinuxDialog(
  exec: ExecFile,
  action: ConfirmAction,
  timeoutMs: number,
  setChild: (child: ChildProcess | undefined) => void
): Promise<Decision> {
  const zenity = exec("zenity", zenityArgs(action, timeoutMs));
  setChild(zenity.child);
  try {
    await zenity;
    return "approved";
  } catch (err) {
    // Node overloads this one property for two different failure shapes: a string ("ENOENT")
    // when the binary itself couldn't be spawned, a number (the exit code) when it ran and
    // exited non-zero.
    const code = (err as { code?: string | number }).code;
    if (code === "ENOENT") {
      const notifySend = exec("notify-send", notifySendArgs(action));
      setChild(notifySend.child);
      try {
        const { stdout } = await notifySend;
        return parseNotifySendAction(stdout);
      } catch {
        // notify-send missing too, or failed to spawn for some other reason.
        return "no-decision";
      }
    }
    // 1 = Deny or the window was closed (the safe reading of a close); 5 = zenity's own
    // --timeout elapsed with no decision; anything else (e.g. this module's own disposer
    // having just killed the process) is likewise no decision.
    return code === 1 ? "denied" : "no-decision";
  } finally {
    setChild(undefined);
  }
}

// The description embeds the source ref and subdir of the thing being installed, which for a
// marketplace install come from a listing anyone can publish (see installer/generic.ts). This
// dialog IS the trust boundary, so that text must not be able to style or restructure it:
// zenity renders --text as Pango markup unless told otherwise, which is enough to hide the
// real repository behind an innocuous-looking line. Nothing here is a shell injection risk —
// execFile passes argv straight to execve, with no shell to interpret it.
function zenityArgs(action: ConfirmAction, timeoutMs: number): string[] {
  const timeoutSeconds = Math.max(1, Math.round(timeoutMs / 1000));
  return [
    "--question",
    "--no-markup",
    "--title=Loadout",
    `--text=${action.description}`,
    "--ok-label=Approve",
    "--cancel-label=Deny",
    `--timeout=${timeoutSeconds}`
  ];
}

/** notify-send has no --no-markup, and a daemon advertising `body-markup` will interpret the
 * body, so the same untrusted description is neutralised by hand instead. `&` has to go first
 * or it would re-escape the entities the other replacements introduce; the set matches
 * glib's own g_markup_escape_text, which is what the daemons parse the body with. */
function escapeMarkup(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function notifySendArgs(action: ConfirmAction): string[] {
  // --action implies --wait, and the chosen action's NAME (not its label) is what arrives on
  // stdout. Works on dunst, mako, GNOME and KDE; a daemon that draws no buttons still shows
  // the notification and leaves stdout empty on expiry, which parseNotifySendAction reads as
  // no-decision rather than a denial.
  return [
    "--action=approve=Approve",
    "--action=deny=Deny",
    "Loadout: confirm this action on your machine",
    escapeMarkup(action.description)
  ];
}

function parseNotifySendAction(stdout: string): Decision {
  const chosen = stdout.trim();
  if (chosen === "approve") return "approved";
  if (chosen === "deny") return "denied";
  return "no-decision";
}

/**
 * node-notifier's Linux reporter drops action arguments on the floor (its notifysend.js
 * whitelists which CLI flags survive), which is why Linux gets its own path above. macOS and
 * Windows are the reporters where `actions` + `wait: true` actually work: the clicked label
 * arrives lowercased as the callback's `response` (see node-notifier's actionJackerDecorator).
 */
function promptViaNodeNotifier(
  action: ConfirmAction,
  onDecision: (approved: boolean) => void,
  timeoutMs: number
): () => void {
  let disposed = false;

  notifier.notify(
    {
      title: "Loadout: confirm this action on your machine",
      message: action.description,
      actions: ["Approve", "Deny"],
      wait: true,
      timeout: Math.max(1, Math.round(timeoutMs / 1000))
    },
    (_err, response) => {
      if (disposed) return;
      const decision = typeof response === "string" ? response.toLowerCase() : "";
      if (decision === "approve") onDecision(true);
      else if (decision === "deny") onDecision(false);
      // Anything else — a click that isn't one of the two actions, a timeout, an error — is
      // no decision and leaves the action pending for the socket path.
    }
  );

  // node-notifier exposes no reliable cross-platform way to dismiss a notification it has
  // already posted (terminal-notifier's `remove` only ever targets macOS, and SnoreToast has
  // no equivalent), so this can only stop a late callback from producing a decision once this
  // prompt has been superseded — not actually close the notification on screen.
  return () => {
    disposed = true;
  };
}
