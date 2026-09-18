import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface LocalConfig {
  registeredProjectPaths: string[];
  // Opt-in per the plan's Global Constraint: "Content backups exist only for
  // source_type: manual items, are opt-in, live in Supabase Storage encrypted at rest, and
  // go through best-effort secret redaction." Defaults to false — the agent never uploads
  // file contents unless the user turns this on (`loadout-agent content-backups on`).
  contentBackupsEnabled?: boolean;
  // Minutes an approval trusts follow-up install/restore actions on this machine before
  // asking again (`loadout trust <minutes>`; 0 disables it). Read once at daemon start into
  // confirm.ts's in-memory trust window — see that module for why it isn't persisted there.
  trustWindowMinutes?: number;
}

const DEFAULT_CONFIG: LocalConfig = { registeredProjectPaths: [], contentBackupsEnabled: false, trustWindowMinutes: 0 };

function configPath(baseDir: string = path.join(os.homedir(), ".loadout")): string {
  return path.join(baseDir, "config.json");
}

export function readLocalConfig(baseDir?: string): LocalConfig {
  const file = configPath(baseDir);
  if (!existsSync(file)) return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(file, "utf8")) as LocalConfig) };
}

export function writeLocalConfig(cfg: LocalConfig, baseDir?: string): void {
  const dir = baseDir ?? path.join(os.homedir(), ".loadout");
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(baseDir), JSON.stringify(cfg, null, 2));
}

export interface Credentials {
  accessToken: string;
  refreshToken: string;
  machineId: string;
  userId: string;
}

function credentialsPath(baseDir: string = path.join(os.homedir(), ".loadout")): string {
  return path.join(baseDir, "credentials.json");
}

export function readCredentials(baseDir?: string): Credentials | null {
  const file = credentialsPath(baseDir);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as Credentials;
}

export function writeCredentials(creds: Credentials, baseDir?: string): void {
  const dir = baseDir ?? path.join(os.homedir(), ".loadout");
  mkdirSync(dir, { recursive: true });
  writeFileSync(credentialsPath(baseDir), JSON.stringify(creds, null, 2), { mode: 0o600 });
}
