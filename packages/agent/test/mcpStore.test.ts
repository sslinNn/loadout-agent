import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { disabledMcpPath, readDisabledMcp, writeDisabledMcp } from "../src/mcpStore";

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

  it("treats a corrupt store as empty rather than throwing", () => {
    home = mkdtempSync(path.join(tmpdir(), "loadout-mcpstore-bad-"));
    mkdirSync(path.dirname(disabledMcpPath(home)), { recursive: true });
    writeFileSync(disabledMcpPath(home), "{ not json");
    expect(readDisabledMcp(home)).toEqual({});
  });
});
