const SECRET_KEY_PATTERN = /\b(API_KEY|SECRET|TOKEN|PASSWORD|ACCESS_KEY|PRIVATE_KEY)\b/i;

export function redactSecrets(content: string): { redacted: string; fields: string[] } {
  const fields = new Set<string>();

  // env-style: KEY="value" or KEY=value
  let redacted = content.replace(
    /([A-Z0-9_]+)\s*=\s*"?([^"\n]{8,})"?/g,
    (match, key: string, value: string) => {
      if (!SECRET_KEY_PATTERN.test(key)) return match;
      fields.add(key);
      return `${key}=[REDACTED]`;
    }
  );

  // JSON-style: "key": "value"
  redacted = redacted.replace(
    /"([A-Za-z0-9_]+)"\s*:\s*"([^"]{8,})"/g,
    (match, key: string, value: string) => {
      if (!SECRET_KEY_PATTERN.test(key)) return match;
      fields.add(key);
      return `"${key}": "[REDACTED]"`;
    }
  );

  return { redacted, fields: [...fields] };
}
