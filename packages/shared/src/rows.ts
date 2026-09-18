import type { InstalledItem, Machine } from "./schemas.js";

/**
 * PostgREST returns snake_case columns; shared types are camelCase. Every read/write that
 * crosses that boundary must go through these mappers — casting a row `as InstalledItem`
 * type-checks but leaves camelCase fields undefined at runtime.
 *
 * Two callers (dashboard + agent) already needed the same mapping; this module is the seam.
 */

export type InstalledItemRow = {
  id: string;
  machine_id: string;
  tool: InstalledItem["tool"];
  kind: InstalledItem["kind"];
  name: string;
  enabled: boolean;
  path: string;
  scope: InstalledItem["scope"];
  project_path: string | null;
  source_type: InstalledItem["sourceType"];
  source_ref: string | null;
  content_backup_id: string | null;
  last_synced_at: string;
};

export function toInstalledItemRow(item: InstalledItem): InstalledItemRow {
  return {
    id: item.id,
    machine_id: item.machineId,
    tool: item.tool,
    kind: item.kind,
    name: item.name,
    enabled: item.enabled,
    path: item.path,
    scope: item.scope,
    project_path: item.projectPath,
    source_type: item.sourceType,
    source_ref: item.sourceRef,
    content_backup_id: item.contentBackupId,
    last_synced_at: item.lastSyncedAt
  };
}

export function toInstalledItem(row: Record<string, unknown>): InstalledItem {
  return {
    id: row.id as string,
    machineId: row.machine_id as string,
    tool: row.tool as InstalledItem["tool"],
    kind: row.kind as InstalledItem["kind"],
    name: row.name as string,
    enabled: row.enabled as boolean,
    path: row.path as string,
    scope: row.scope as InstalledItem["scope"],
    projectPath: (row.project_path as string | null) ?? null,
    sourceType: row.source_type as InstalledItem["sourceType"],
    sourceRef: (row.source_ref as string | null) ?? null,
    contentBackupId: (row.content_backup_id as string | null) ?? null,
    lastSyncedAt: row.last_synced_at as string
  };
}

export function toMachine(row: Record<string, unknown>): Machine {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    hostname: row.hostname as string,
    os: row.os as string,
    agentVersion: row.agent_version as string,
    pairedAt: row.paired_at as string,
    lastSeenAt: row.last_seen_at as string,
    status: row.status as Machine["status"]
  };
}
