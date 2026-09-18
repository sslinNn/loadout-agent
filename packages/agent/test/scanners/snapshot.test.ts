// packages/agent/test/scanners/snapshot.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildSnapshot } from "../../src/scanners/snapshot";
import * as claudeCode from "../../src/scanners/claudeCode";
import * as codex from "../../src/scanners/codex";
import * as localConfig from "../../src/localConfig";

vi.spyOn(claudeCode, "scanClaudeCode").mockReturnValue([
  { id: "a", machineId: "", tool: "claude_code", kind: "skill", name: "s", enabled: true,
    path: "/a", scope: "global", projectPath: null, sourceType: "manual", sourceRef: null,
    contentBackupId: null, lastSyncedAt: "2026-01-01T00:00:00.000Z" }
]);
vi.spyOn(codex, "scanCodex").mockReturnValue([]);
vi.spyOn(localConfig, "readLocalConfig").mockReturnValue({ registeredProjectPaths: [] });

describe("buildSnapshot", () => {
  it("merges both scanners and stamps machineId onto every item", () => {
    const snap = buildSnapshot({ machineId: "M1", homeDir: "/home/u" });
    expect(snap.machineId).toBe("M1");
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0].machineId).toBe("M1");
  });
});
