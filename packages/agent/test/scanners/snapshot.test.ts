import { describe, it, expect, vi } from "vitest";
import { buildSnapshot } from "../../src/scanners/snapshot";
import * as skills from "../../src/scanners/skills";
import * as mcp from "../../src/scanners/mcp";
import * as localConfig from "../../src/localConfig";

vi.spyOn(skills, "scanSkills").mockReturnValue([
  {
    id: "skill:global:/a",
    machineId: "",
    harnesses: ["claude_code"],
    kind: "skill",
    name: "s",
    enabled: true,
    path: "/a",
    scope: "global",
    projectPath: null,
    sourceType: "manual",
    sourceRef: null,
    sourceSubdir: null,
    contentBackupId: null,
    lastSyncedAt: "2026-01-01T00:00:00.000Z"
  }
]);
vi.spyOn(mcp, "scanMcp").mockReturnValue([]);
vi.spyOn(localConfig, "readLocalConfig").mockReturnValue({
  registeredProjectPaths: [],
  contentBackupsEnabled: false,
  trustWindowMinutes: 0
});

describe("buildSnapshot", () => {
  it("merges skill and mcp scanners and stamps machineId onto every item", () => {
    const snap = buildSnapshot({ machineId: "M1", homeDir: "/home/u" });
    expect(snap.machineId).toBe("M1");
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0].machineId).toBe("M1");
  });
});
