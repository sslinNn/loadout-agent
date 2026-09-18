import { describe, it, expect, vi, afterEach } from "vitest";
import { info, warn, error } from "../src/log";

describe("log", () => {
  afterEach(() => vi.restoreAllMocks());

  it("info() prefixes console.log with [loadout]", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    info("hello", 42);
    expect(spy).toHaveBeenCalledWith("[loadout]", "hello", 42);
  });

  it("warn() prefixes console.warn with [loadout]", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    warn("careful");
    expect(spy).toHaveBeenCalledWith("[loadout]", "careful");
  });

  it("error() prefixes console.error with [loadout]", () => {
    const err = new Error("x");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    error("boom", err);
    expect(spy).toHaveBeenCalledWith("[loadout]", "boom", err);
  });
});
