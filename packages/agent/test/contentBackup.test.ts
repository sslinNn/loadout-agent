import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import type { InstalledItem } from "@loadout/shared";
import { captureContentBackup, backupContentFor } from "../src/contentBackup";

describe("captureContentBackup", () => {
  it("redacts, uploads to storage, and inserts a content_backups row", async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const single = vi.fn().mockResolvedValue({ data: { id: "cb1" }, error: null });
    const client = {
      storage: { from: () => ({ upload }) },
      from: () => ({ insert: () => ({ select: () => ({ single }) }) }),
      auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) }
    } as any;

    const item = { id: "i1", name: "my-skill", sourceType: "manual" } as any;
    const result = await captureContentBackup(client, item, 'API_KEY="sk-longsecretvalue123"');

    expect(upload).toHaveBeenCalled();
    expect(result).toEqual({ id: "cb1", fields: ["API_KEY"] });
  });
});

describe("backupContentFor", () => {
  it("backs up only the named MCP server, never the whole config file", () => {
    const home = mkdtempSync(path.join(tmpdir(), "loadout-mcp-backup-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    const configPath = path.join(home, ".claude.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        oauthAccount: { emailAddress: "someone@example.com", accountUuid: "must-not-leak" },
        mcpServers: { supabird: { type: "http", url: "https://example.invalid/mcp" } }
      })
    );

    const captured = backupContentFor(
      {
        id: "mcp:global:supabird",
        machineId: "m",
        harnesses: ["claude_code"],
        kind: "mcp",
        name: "supabird",
        enabled: true,
        path: "global::supabird",
        scope: "global",
        projectPath: null,
        sourceType: "manual",
        sourceRef: null,
        sourceSubdir: null,
        contentBackupId: null,
        lastSyncedAt: new Date().toISOString()
      } as InstalledItem,
      home
    );

    expect(captured).toContain("example.invalid");
    expect(captured).not.toContain("must-not-leak");
    expect(captured).not.toContain("oauthAccount");

    rmSync(home, { recursive: true, force: true });
  });
});
