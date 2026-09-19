import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";

export type LiveJson =
  | { status: "missing"; value: Record<string, unknown> }
  | { status: "ok"; value: Record<string, unknown> }
  | { status: "invalid" };

function asObject(parsed: unknown): Record<string, unknown> | null {
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/**
 * Distinguish a missing file (start from {}) from a live file that is not an object.
 * Callers that write must refuse `invalid` — returning {} and then stringify would wipe
 * oauthAccount / other sibling keys sitting in a corrupt ~/.claude.json.
 */
export function readLiveJson(filePath: string): LiveJson {
  if (!existsSync(filePath)) return { status: "missing", value: {} };
  const text = readFileSync(filePath, "utf8");
  try {
    const obj = asObject(JSON.parse(text) as unknown);
    if (obj) return { status: "ok", value: obj };
    return { status: "invalid" };
  } catch {
    // JSONC (comments, trailing commas) is valid for Cursor/VS Code mcp.json.
  }
  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true, allowEmptyContent: true });
  if (errors.length > 0) return { status: "invalid" };
  if (parsed === undefined || parsed === null) return { status: "ok", value: {} };
  const obj = asObject(parsed);
  return obj ? { status: "ok", value: obj } : { status: "invalid" };
}

export function readJsonObject(filePath: string): Record<string, unknown> {
  const live = readLiveJson(filePath);
  return live.status === "invalid" ? {} : live.value;
}

/**
 * Atomic replace: write beside the target and rename into place so a crash cannot leave a
 * truncated live config. Same-directory rename stays on one filesystem.
 */
export function writeJsonAtomic(targetPath: string, value: unknown): void {
  const tmpPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.loadout-tmp-${process.pid}-${Date.now()}`
  );
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmpPath, targetPath);
}
