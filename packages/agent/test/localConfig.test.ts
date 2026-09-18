import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readLocalConfig, writeLocalConfig, readCredentials, writeCredentials } from "../src/localConfig";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "loadout-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("localConfig", () => {
  it("returns an empty config when no file exists yet", () => {
    expect(readLocalConfig(dir)).toEqual({ registeredProjectPaths: [], contentBackupsEnabled: false, trustWindowMinutes: 0 });
  });

  it("round-trips a written config", () => {
    writeLocalConfig({ registeredProjectPaths: ["/home/u/proj"] }, dir);
    expect(readLocalConfig(dir)).toEqual({
      registeredProjectPaths: ["/home/u/proj"],
      contentBackupsEnabled: false,
      trustWindowMinutes: 0
    });
  });

  // Content backups upload file contents off the machine, so they must be OFF unless the
  // user opted in — including for a config file written before the option existed.
  it("defaults contentBackupsEnabled to false and preserves an explicit opt-in", () => {
    writeLocalConfig({ registeredProjectPaths: [] }, dir);
    expect(readLocalConfig(dir).contentBackupsEnabled).toBe(false);

    writeLocalConfig({ registeredProjectPaths: [], contentBackupsEnabled: true }, dir);
    expect(readLocalConfig(dir).contentBackupsEnabled).toBe(true);
  });

  // 0 must mean "always confirm" for anyone who never ran `loadout trust <minutes>`, not
  // just for a freshly created config file.
  it("defaults trustWindowMinutes to 0 and preserves an explicit value", () => {
    writeLocalConfig({ registeredProjectPaths: [] }, dir);
    expect(readLocalConfig(dir).trustWindowMinutes).toBe(0);

    writeLocalConfig({ registeredProjectPaths: [], trustWindowMinutes: 15 }, dir);
    expect(readLocalConfig(dir).trustWindowMinutes).toBe(15);
  });
});

describe("credentials", () => {
  it("returns null when no credentials file exists yet", () => {
    expect(readCredentials(dir)).toBeNull();
  });

  it("round-trips written credentials", () => {
    const creds = { accessToken: "at", refreshToken: "rt", machineId: "m1", userId: "u1" };
    writeCredentials(creds, dir);
    expect(readCredentials(dir)).toEqual(creds);
  });
});
