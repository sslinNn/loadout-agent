import type { CanonicalMcp } from "./types.js";

export type { CanonicalMcp };

/**
 * Identity for union/conflict: same name + same transport (command/args or url).
 * Env/headers are not part of identity — they are payload, not routing.
 */
export function mcpFingerprint(entry: CanonicalMcp): string {
  if (entry.url) return `url:${entry.url}`;
  return `cmd:${entry.command ?? ""}:${(entry.args ?? []).join("\0")}`;
}

export function fromVendor(raw: unknown): CanonicalMcp {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: CanonicalMcp = {};
  if (typeof o.command === "string") out.command = o.command;
  if (Array.isArray(o.args)) out.args = o.args.map(String);
  if (o.env && typeof o.env === "object" && !Array.isArray(o.env)) {
    out.env = Object.fromEntries(Object.entries(o.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  }
  const url =
    (typeof o.url === "string" && o.url) ||
    (typeof o.httpUrl === "string" && o.httpUrl) ||
    (typeof o.http_url === "string" && o.http_url) ||
    undefined;
  if (url) out.url = url;
  const headers = o.headers ?? o.http_headers;
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    out.headers = Object.fromEntries(
      Object.entries(headers as Record<string, unknown>).map(([k, v]) => [k, String(v)])
    );
  }
  return out;
}

export function toCommandShape(entry: CanonicalMcp): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (entry.command) out.command = entry.command;
  if (entry.args) out.args = entry.args;
  if (entry.env) out.env = entry.env;
  return out;
}

export function toUrlShape(
  entry: CanonicalMcp,
  opts: { typeHttp?: boolean; urlKey?: "url" | "httpUrl" } = {}
): Record<string, unknown> {
  const key = opts.urlKey ?? "url";
  const out: Record<string, unknown> = { [key]: entry.url };
  if (opts.typeHttp) out.type = "http";
  if (entry.headers) out.headers = entry.headers;
  return out;
}

export function toNativeJson(
  entry: CanonicalMcp,
  opts: { typeHttp?: boolean; urlKey?: "url" | "httpUrl" } = {}
): Record<string, unknown> {
  return entry.url ? toUrlShape(entry, opts) : toCommandShape(entry);
}
