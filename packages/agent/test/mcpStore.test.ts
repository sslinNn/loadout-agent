import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { disabledMcpPath, parkedMcpEntry, readDisabledMcp, writeDisabledMcp } from "../src/mcpStore";

describe("disabled MCP store", () => {
  let home: string;
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("reads an empty object when the store does not exist yet", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-mcpstore-"));
    expect(readDisabledMcp(home)).toEqual({});
    expect(existsSync(disabledMcpPath(home))).toBe(false);
  });

  it("round-trips entries through the store", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-mcpstore-rt-"));
    const key = `${path.join(home, ".claude.json")}::supabird`;
    writeDisabledMcp(home, { [key]: { type: "http", url: "https://example.invalid/mcp" } });

    expect(readDisabledMcp(home)).toEqual({ [key]: { type: "http", url: "https://example.invalid/mcp" } });
    expect(disabledMcpPath(home)).toBe(path.join(home, ".loadout", "disabled-mcp.json"));
    expect(JSON.parse(readFileSync(disabledMcpPath(home), "utf8"))).toHaveProperty(key);
  });

  it("round-trips entries through the store under global::name", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-mcpstore-global-"));
    writeDisabledMcp(home, { "global::github": { command: "npx", args: ["-y", "gh"] } });
    expect(readDisabledMcp(home)["global::github"]).toEqual({ command: "npx", args: ["-y", "gh"] });
    expect(parkedMcpEntry(readDisabledMcp(home), "global", "github")).toMatchObject({ command: "npx" });
  });

  it("treats a corrupt store as empty rather than throwing", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-mcpstore-bad-"));
    mkdirSync(path.dirname(disabledMcpPath(home)), { recursive: true });
    writeFileSync(disabledMcpPath(home), "{ not json");
    expect(readDisabledMcp(home)).toEqual({});
  });

  it("writes the park file as mode 0600 so MCP env/headers are not world-readable", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-mcpstore-mode-"));
    writeDisabledMcp(home, {
      "global::github": { command: "npx", env: { GITHUB_TOKEN: "ghp_secretvalue" } }
    });
    const parked = disabledMcpPath(home);
    expect(statSync(parked).mode & 0o777).toBe(0o600);
    // Rewrite must keep 0600: writeFileSync's mode option is ignored on an existing file.
    writeDisabledMcp(home, {
      "global::github": { command: "npx", env: { GITHUB_TOKEN: "ghp_secretvalue" } }
    });
    expect(statSync(parked).mode & 0o777).toBe(0o600);
    // Park is local enable-state, not a cloud backup: tokens stay so re-enable still works.
    expect(readFileSync(parked, "utf8")).toContain("ghp_secretvalue");
  });
});
