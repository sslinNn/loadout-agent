import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readPackageVersion } from "../src/version";

describe("readPackageVersion", () => {
  it("reads the version field from the given package.json", () => {
    const url = new URL("./fixtures/version/package.json", import.meta.url);
    expect(readPackageVersion(url)).toBe("9.9.9");
  });

  it("defaults to this package's own package.json", () => {
    // Compare against the real package.json's own version field rather than a hardcoded
    // literal — that literal breaks for no real reason the moment this package's version
    // bumps (which the project's own spec says is the next step for this branch).
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(readPackageVersion()).toBe(pkg.version);
  });
});
