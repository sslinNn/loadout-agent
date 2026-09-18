import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { backupFile, restoreFromBackup } from "../src/backup";

let dir: string;
let target: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "loadout-backup-"));
  target = path.join(dir, "config.json");
  writeFileSync(target, '{"a":1}');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("backup/restore", () => {
  it("copies the file to a timestamped sibling and leaves the original untouched", () => {
    const backupPath = backupFile(target);
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, "utf8")).toBe('{"a":1}');
    expect(readFileSync(target, "utf8")).toBe('{"a":1}');
  });

  it("restoreFromBackup overwrites the original with the backup's contents", () => {
    const backupPath = backupFile(target);
    writeFileSync(target, '{"a":2}');
    restoreFromBackup(backupPath, target);
    expect(readFileSync(target, "utf8")).toBe('{"a":1}');
  });
});
