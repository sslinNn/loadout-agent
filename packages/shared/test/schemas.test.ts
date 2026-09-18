import { describe, it, expect } from "vitest";
import { InstalledItemSchema, SnapshotSchema } from "../src/schemas";

describe("InstalledItemSchema", () => {
  it("accepts a valid global skill item", () => {
    const item = {
      id: "11111111-1111-1111-1111-111111111111",
      machineId: "22222222-2222-2222-2222-222222222222",
      tool: "claude_code",
      kind: "skill",
      name: "data-visualization",
      enabled: true,
      path: "/home/user/.claude/skills/data-visualization",
      scope: "global",
      projectPath: null,
      sourceType: "manual",
      sourceRef: null,
      contentBackupId: null,
      lastSyncedAt: "2026-09-02T00:00:00.000Z"
    };
    expect(InstalledItemSchema.parse(item)).toEqual(item);
  });

  it("rejects scope: project without a projectPath", () => {
    const item = {
      id: "1", machineId: "2", tool: "codex", kind: "mcp", name: "x",
      enabled: true, path: "/x", scope: "project", projectPath: null,
      sourceType: "manual", sourceRef: null, contentBackupId: null,
      lastSyncedAt: "2026-09-02T00:00:00.000Z"
    };
    expect(() => InstalledItemSchema.parse(item)).toThrow();
  });
});

describe("SnapshotSchema", () => {
  it("accepts a machine id plus a list of items", () => {
    const snap = { machineId: "22222222-2222-2222-2222-222222222222", items: [] };
    expect(SnapshotSchema.parse(snap)).toEqual(snap);
  });
});
