/**
 * Diagnostic logging for background daemon events, prefixed consistently so `loadout run`
 * output (and whatever systemd/launchd captures it into) can be grepped for `[loadout]`
 * regardless of which module logged it. Before this, some call sites said `[loadout-agent]`,
 * others had no prefix at all.
 *
 * Not for direct responses to a command the user just typed — those stay plain
 * console.log/console.error, since printing them is the point of the command.
 */
const PREFIX = "[loadout]";

export function info(...args: unknown[]): void {
  console.log(PREFIX, ...args);
}

export function warn(...args: unknown[]): void {
  console.warn(PREFIX, ...args);
}

export function error(...args: unknown[]): void {
  console.error(PREFIX, ...args);
}
