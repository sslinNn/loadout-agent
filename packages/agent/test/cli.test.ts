import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as localConfig from "../src/localConfig";
import * as confirm from "../src/installer/confirm";
import * as generic from "../src/installer/generic";
import * as command from "../src/installer/command";
import { buildCli } from "../src/cli";

// buildCli()'s "trust" action reads/writes ~/.loadout/config.json via localConfig.js with no
// injectable baseDir (matching content-backups, which it's modelled on) — spying on the
// module's exports, rather than a real temp HOME, is what keeps this suite off the real
// filesystem and independent of whatever machine runs it.
describe("loadout trust <minutes>", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(localConfig, "readLocalConfig").mockReturnValue({
      registeredProjectPaths: [],
      contentBackupsEnabled: false,
      trustWindowMinutes: 0
    });
    writeSpy = vi.spyOn(localConfig, "writeLocalConfig").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  async function run(minutes: string): Promise<void> {
    const program = buildCli();
    program.exitOverride();
    // "--" so a negative value (e.g. "-5") is parsed as trust's positional argument rather
    // than an unrecognized commander option.
    await program.parseAsync(["node", "loadout", "trust", "--", minutes]);
  }

  it("writes the given number of minutes into local config", async () => {
    await run("15");
    expect(writeSpy).toHaveBeenCalledWith(expect.objectContaining({ trustWindowMinutes: 15 }));
  });

  it("0 disables the window but is still a valid, written value", async () => {
    await run("0");
    expect(writeSpy).toHaveBeenCalledWith(expect.objectContaining({ trustWindowMinutes: 0 }));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("preserves the rest of the config untouched", async () => {
    vi.mocked(localConfig.readLocalConfig).mockReturnValue({
      registeredProjectPaths: ["/home/u/proj"],
      contentBackupsEnabled: true,
      trustWindowMinutes: 0
    });
    await run("5");
    expect(writeSpy).toHaveBeenCalledWith({
      registeredProjectPaths: ["/home/u/proj"],
      contentBackupsEnabled: true,
      trustWindowMinutes: 5
    });
  });

  it("rejects non-numeric input and writes nothing", async () => {
    await run("soon");
    expect(writeSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("rejects negative input and writes nothing", async () => {
    await run("-5");
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

// Regression coverage for the incident's "two daemons on one machine" symptom: `loadout run`
// must refuse outright when another daemon already holds the confirmation socket, rather than
// becoming a second one that duplicates every prompt. Only the guard itself is exercised here
// — it's checked before credentials are even read, so nothing past it (pairing, realtime,
// scanning) needs mocking to prove the refusal happens.
describe("loadout run — single instance guard", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refuses to start when the confirmation socket is already live, without reading credentials", async () => {
    vi.spyOn(confirm, "isSocketLive").mockResolvedValue(true);
    const readCredsSpy = vi.spyOn(localConfig, "readCredentials");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = buildCli();
    program.exitOverride();
    await program.parseAsync(["node", "loadout", "run"]);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("already running"));
    expect(process.exitCode).toBe(1);
    expect(readCredsSpy).not.toHaveBeenCalled();
    process.exitCode = 0;
  });
});

describe("loadout install <git-url> [subdir]", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Install may record provenance when paired; keep this suite off the real credentials file.
    vi.spyOn(localConfig, "readCredentials").mockReturnValue(null);
  });
  afterEach(() => vi.restoreAllMocks());

  function run(args: string[]): Promise<void> {
    const program = buildCli();
    program.exitOverride();
    return program.parseAsync(["node", "loadout", "install", ...args]);
  }

  it("calls installGeneric with the given ref and subdir, and prints the path", async () => {
    const install = vi
      .spyOn(generic, "installGeneric")
      .mockResolvedValue({ installed: true, path: "/home/u/.claude/skills/my-skill" });

    await run(["https://github.com/example/my-skill"]);

    expect(install).toHaveBeenCalledWith(
      { type: "git", ref: "https://github.com/example/my-skill", subdir: null },
      { kind: "skill", scope: "global", projectPath: null },
      expect.objectContaining({ skipConfirmation: true })
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // Typing `loadout install` in a terminal IS the consent. Asking again would bind
  // ~/.loadout/confirm.sock while `loadout run` already holds it (EADDRINUSE).
  it("skips local confirmation because the user invoked install themselves", async () => {
    const install = vi
      .spyOn(generic, "installGeneric")
      .mockResolvedValue({ installed: true, path: "/home/u/.agents/skills/my-skill" });

    await run(["https://github.com/example/my-skill"]);

    expect(install).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ skipConfirmation: true })
    );
  });

  it("passes the subdir and project scope through", async () => {
    const install = vi
      .spyOn(generic, "installGeneric")
      .mockResolvedValue({ installed: true, path: "/p/.agents/skills/s" });

    await run(["https://github.com/example/repo", "skills/s", "--project", "/p"]);

    expect(install).toHaveBeenCalledWith(
      { type: "git", ref: "https://github.com/example/repo", subdir: "skills/s" },
      { kind: "skill", scope: "project", projectPath: "/p" },
      expect.objectContaining({ skipConfirmation: true })
    );
  });

  it("records git provenance when paired so a running daemon cannot stamp the item as manual", async () => {
    vi.spyOn(generic, "installGeneric").mockResolvedValue({
      installed: true,
      path: "/home/u/.agents/skills/my-skill"
    });
    vi.mocked(localConfig.readCredentials).mockReturnValue({
      accessToken: "tok",
      refreshToken: "ref",
      machineId: "m1",
      userId: "u1"
    });
    const record = vi.spyOn(command, "recordInstallProvenance").mockResolvedValue();

    await run(["https://github.com/example/my-skill", "skills/my-skill"]);

    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceType: "git",
        sourceRef: "https://github.com/example/my-skill",
        sourceSubdir: "skills/my-skill",
        machineId: "m1"
      })
    );
  });

  it("does not write provenance when this machine is not paired", async () => {
    vi.spyOn(generic, "installGeneric").mockResolvedValue({
      installed: true,
      path: "/home/u/.agents/skills/my-skill"
    });
    const record = vi.spyOn(command, "recordInstallProvenance");

    await run(["https://github.com/example/my-skill"]);

    expect(record).not.toHaveBeenCalled();
  });

  it("reports the refusal and exits non-zero", async () => {
    vi.spyOn(generic, "installGeneric").mockResolvedValue({
      installed: false,
      reason: "my-skill is already installed at /home/u/.claude/skills/my-skill"
    });

    await run(["https://github.com/example/my-skill"]);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("already installed at /home/u/.claude/skills/my-skill")
    );
    expect(process.exitCode).toBe(1);
  });
});
