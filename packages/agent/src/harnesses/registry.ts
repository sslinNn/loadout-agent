import type { HarnessAdapter } from "./types.js";
import { claudeCodeAdapter } from "./claudeCode.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { geminiCliAdapter } from "./geminiCli.js";
import { copilotAdapter } from "./copilot.js";

export const adapters: HarnessAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  geminiCliAdapter,
  copilotAdapter
];

export function presentAdapters(homeDir: string): HarnessAdapter[] {
  return adapters.filter((adapter) => adapter.isPresent(homeDir));
}

export function extraSkillRoots(opts: { homeDir: string; projectPath: string | null }): string[] {
  return presentAdapters(opts.homeDir).flatMap((adapter) => adapter.extraSkillRoots?.(opts) ?? []);
}

export function allWatchPaths(opts: { homeDir: string; projectPaths: string[] }): string[] {
  return adapters.flatMap((adapter) => adapter.watchPaths(opts));
}
