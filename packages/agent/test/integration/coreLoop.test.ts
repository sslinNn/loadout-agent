// packages/agent/test/integration/coreLoop.test.ts
//
// Phase 1 milestone test: proves Tasks 1-17 form the actual "core loop" the spec
// describes — scan -> snapshot -> unified inventory -> enable/disable/remove with
// backup, watcher-confirmed, no auto-discovery outside registered project paths.
//
// This requires a live local Supabase instance (`npx supabase start`), which this
// sandbox cannot run (Docker daemon inactive/permission-denied here, and the
// `supabase` CLI binary cannot be downloaded in this environment). That is a known,
// already-accepted limitation applied elsewhere in this project (Tasks 3, 12, 19, 26).
// It is written exactly as the plan specifies so it is ready to run for real wherever
// Supabase is available, and SKIPS (rather than fails) when the keys are absent — see
// LIVE_DB below.
import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSnapshot } from "../../src/scanners/snapshot";
import { applyToggle } from "../../src/mutators/claudeCode";
// The same snake_case <-> camelCase mappers the daemon itself uses. Writing a camelCase
// InstalledItem straight into PostgREST would fail ("column machineId does not exist"):
// installed_items is snake_case (see the migration). This is exactly the producer/consumer
// mismatch this whole review wave was about, so the milestone test uses the real mappers
// rather than re-implementing a partial conversion inline.
import { toInstalledItem, toInstalledItemRow } from "@loadout/shared";

const URL = "http://127.0.0.1:54321";
const ANON = process.env.SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;


// These suites exercise real Postgres RLS policies and RPCs and therefore need a live local
// Supabase (`npx supabase start`) plus its keys in the environment. They are SKIPPED, not
// failed, when SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are absent, so that a default
// `npm test` run is meaningful: a red run means a real regression rather than "no Docker
// here". Run them for real by exporting both keys (`supabase status` prints them).
const LIVE_DB = Boolean(process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY);

describe.skipIf(!LIVE_DB)("Phase 1 core loop", () => {
  it("scans a fake home dir, upserts to Supabase, applies a disable, and re-scan reflects it", async () => {
    const admin = createClient(URL, SERVICE);
    const { data: user } = await admin.auth.admin.createUser({
      email: `core-loop-${Date.now()}@example.com`, password: "correcthorsebatterystaple", email_confirm: true
    });
    const client = createClient(URL, ANON);
    await client.auth.signInWithPassword({ email: user.user!.email!, password: "correcthorsebatterystaple" });

    const { data: machine } = await client.from("machines")
      .insert({ hostname: "loop-test", os: "linux", agent_version: "0.0.1" }).select().single();

    const home = mkdtempSync(path.join(tmpdir(), "loadout-loop-"));
    const skillDir = path.join(home, ".claude", "skills", "loop-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: loop-skill\n---\n");

    const snapshot = buildSnapshot({ machineId: machine!.id, homeDir: home });
    for (const item of snapshot.items) {
      const { error } = await client.from("installed_items").upsert(toInstalledItemRow(item), { onConflict: "machine_id,id" });
      expect(error).toBeNull();
    }

    const { data: before } = await client.from("installed_items").select("*").eq("machine_id", machine!.id);
    expect(before!.find((i) => i.name === "loop-skill")!.enabled).toBe(true);

    const item = before!.find((i) => i.name === "loop-skill")!;
    applyToggle(toInstalledItem(item), false);
    expect(existsSync(skillDir)).toBe(false);

    const rescanned = buildSnapshot({ machineId: machine!.id, homeDir: home });
    for (const i of rescanned.items) {
      const { error } = await client.from("installed_items").upsert(toInstalledItemRow(i), { onConflict: "machine_id,id" });
      expect(error).toBeNull();
    }
    const disabledItem = rescanned.items.find((i) => i.name === "loop-skill");
    // scanClaudeCode now also scans the .loadout-disabled mirror (see Task 18's fix to
    // packages/agent/src/scanners/claudeCode.ts), so the moved-aside skill still shows
    // up in the re-scan, reported as disk-confirmed disabled rather than disappearing.
    expect(disabledItem?.enabled).toBe(false);
  });
});
