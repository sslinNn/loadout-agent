import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { InstalledItem } from "@loadout/shared";
import { redactSecrets } from "./secrets/redact.js";

/**
 * The content worth keeping for one item.
 *
 * A skill's content is its SKILL.md. An MCP server's is its own entry — NOT the file it
 * happens to live in: ~/.claude.json also carries the oauth account, per-project history
 * and caches, and a whole-file backup would ship all of it to the server behind a
 * best-effort redactor.
 */
export function backupContentFor(item: InstalledItem): string | null {
  if (!existsSync(item.path)) return null;

  if (item.kind === "mcp") {
    try {
      const raw = readFileSync(item.path, "utf8");
      const servers = item.path.endsWith(".toml")
        ? ((TOML.parse(raw) as { mcp_servers?: Record<string, unknown> }).mcp_servers ?? {})
        : ((JSON.parse(raw) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {});
      const entry = servers[item.name];
      return entry === undefined ? null : JSON.stringify({ [item.name]: entry }, null, 2);
    } catch {
      return null;
    }
  }

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
