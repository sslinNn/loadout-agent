import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { InstalledItem } from "@loadout/shared";
import { redactSecrets } from "./secrets/redact.js";
import { presentAdapters } from "./harnesses/registry.js";
import { parkedMcpEntry, readDisabledMcp } from "./mcpStore.js";

/**
 * The content worth keeping for one item.
 *
 * A skill's content is its SKILL.md. An MCP server's is its canonical entry — never the
 * whole vendor config file (Claude's ~/.claude.json also carries oauth state).
 */
export function backupContentFor(item: InstalledItem, homeDir: string = os.homedir()): string | null {
  if (item.kind === "mcp") {
    for (const adapter of presentAdapters(homeDir)) {
      const servers =
        item.scope === "project" && item.projectPath
          ? (adapter.readProjectMcp?.(item.projectPath) ?? {})
          : adapter.readMcp(homeDir);
      if (servers[item.name]) return JSON.stringify({ [item.name]: servers[item.name] }, null, 2);
    }
    const parked = parkedMcpEntry(readDisabledMcp(homeDir), item.scope, item.name, item.projectPath);
    return parked ? JSON.stringify({ [item.name]: parked }, null, 2) : null;
  }

  if (!existsSync(item.path)) return null;
  const filePath = statSync(item.path).isDirectory() ? path.join(item.path, "SKILL.md") : item.path;
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
}

export async function captureContentBackup(
  client: SupabaseClient,
  item: InstalledItem,
  fileContent: string
): Promise<{ id: string; fields: string[] }> {
  const { redacted, fields } = redactSecrets(fileContent);
  const checksum = createHash("sha256").update(redacted).digest("hex");
  const { data: userData } = await client.auth.getUser();
  const storagePath = `${userData.user!.id}/${item.id}-${checksum.slice(0, 12)}.json`;

  const { error: uploadError } = await client.storage.from("content-backups").upload(storagePath, new Blob([redacted]), { upsert: true });
  if (uploadError) throw uploadError;

  const { data, error } = await client
    .from("content_backups")
    .insert({ checksum, storage_path: storagePath, secrets_redacted: fields.length > 0 })
    .select()
    .single();
  if (error) throw error;

  return { id: data.id, fields };
}
