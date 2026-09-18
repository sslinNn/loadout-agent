import { describe, it, expect } from "vitest";
import { redactSecrets } from "../../src/secrets/redact";

describe("redactSecrets", () => {
  it("redacts an env-style API key assignment", () => {
    const { redacted, fields } = redactSecrets('API_KEY="sk-abc123def456ghijklmno"\nPORT=3000');
    expect(redacted).toContain("API_KEY=[REDACTED]");
    expect(redacted).toContain("PORT=3000");
    expect(fields).toContain("API_KEY");
  });

  it("redacts a JSON field named token/secret/password", () => {
    const { redacted, fields } = redactSecrets('{"token": "abcdefghijklmnop1234567890", "name": "ok"}');
    expect(redacted).toContain('"token": "[REDACTED]"');
    expect(redacted).toContain('"name": "ok"');
    expect(fields).toContain("token");
  });

  it("leaves content untouched when nothing matches", () => {
    const { redacted, fields } = redactSecrets('{"name": "ok"}');
    expect(redacted).toBe('{"name": "ok"}');
    expect(fields).toEqual([]);
  });
});
