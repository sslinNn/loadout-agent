import { z } from "zod";

export const ToolSchema = z.enum(["claude_code", "codex"]);
export const KindSchema = z.enum(["skill", "mcp"]);
export const ScopeSchema = z.enum(["global", "project"]);
export const SourceTypeSchema = z.enum(["manual", "git", "npm", "marketplace"]);

export const InstalledItemSchema = z
  .object({
    id: z.string(),
    machineId: z.string(),
    tool: ToolSchema,
    kind: KindSchema,
    name: z.string().min(1),
    enabled: z.boolean(),
    path: z.string().min(1),
    scope: ScopeSchema,
    projectPath: z.string().nullable(),
    sourceType: SourceTypeSchema,
    sourceRef: z.string().nullable(),
    contentBackupId: z.string().nullable(),
    lastSyncedAt: z.string()
  })
  .refine((v) => (v.scope === "project" ? v.projectPath !== null : true), {
    message: "projectPath is required when scope is 'project'",
    path: ["projectPath"]
  });

export type InstalledItem = z.infer<typeof InstalledItemSchema>;

export const MachineSchema = z.object({
  id: z.string(),
  userId: z.string(),
  hostname: z.string(),
  os: z.string(),
  agentVersion: z.string(),
  pairedAt: z.string(),
  lastSeenAt: z.string(),
  status: z.enum(["online", "offline"])
});
export type Machine = z.infer<typeof MachineSchema>;

export const SnapshotSchema = z.object({
  machineId: z.string(),
  items: z.array(InstalledItemSchema)
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const RealtimeCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("toggle"), itemId: z.string(), enabled: z.boolean() }),
  z.object({ type: z.literal("remove"), itemId: z.string() }),
  z.object({
    type: z.literal("install"),
    tool: ToolSchema,
    kind: KindSchema,
    scope: ScopeSchema,
    projectPath: z.string().nullable(),
    sourceType: SourceTypeSchema,
    sourceRef: z.string(),
    // Where the skill lives INSIDE the repository, when the repository is not itself a
    // bare skill directory. Skills in the wild ship inside plugins (`skills/<name>/`),
    // and the scanners only report a directory that has its own SKILL.md — so without
    // this, only a repo whose root is a skill could ever be installed. Relative to the
    // repository root; null/omitted means "the root is the skill".
    sourceSubdir: z.string().nullish(),
    // Set when the install was triggered from a marketplace listing (see
    // apps/dashboard/lib/domain/listing.ts). The agent records it as an `installs`
    // row so the listing's install is attributable; omitted for a plain git/npm install
    // that didn't come from a listing.
    listingId: z.string().nullish()
  }),
  z.object({ type: z.literal("restore"), items: z.array(InstalledItemSchema) })
]);
export type RealtimeCommand = z.infer<typeof RealtimeCommandSchema>;
