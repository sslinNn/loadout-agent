import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { nextConfirmationId, requestLocalConfirmation } from "./confirm.js";
import { fromVendor, mcpFingerprint, type CanonicalMcp } from "../harnesses/canonicalMcp.js";
import { presentAdapters } from "../harnesses/registry.js";
import { readJsonObject } from "../harnesses/jsonFile.js";
import { projectSkillToPresentHarnesses } from "../skills/project.js";
import { agentsSkillsDir } from "../skills/store.js";

const execFileAsync = promisify(execFile);

export interface InstallSource { type: "git" | "npm" | "url"; ref: string; subdir?: string | null }
export interface InstallTarget {
  kind: "skill" | "mcp";
  scope: "global" | "project";
  projectPath: string | null;
  /** Override the home directory. Intended for tests; production uses os.homedir(). */
  homeDir?: string;
}
export interface InstallStrategies {
  gitClone?: (ref: string, destDir: string) => Promise<string>;
  // For an interactive `loadout install <ref>` run by the user in their own terminal: the
  // invocation itself is the consent, and going through requestLocalConfirmation here would
  // try to bind the running daemon's confirmation socket (EADDRINUSE) and re-ask a question
  // the user answered by typing the command.
  skipConfirmation?: boolean;
}

function skillsDirFor(target: InstallTarget): string {
  const root = target.scope === "global" ? (target.homeDir ?? os.homedir()) : target.projectPath!;
  return agentsSkillsDir(root);
}

function repoNameFrom(ref: string): string {
  return path.basename(ref).replace(/\.git$/, "") || "repo";
}

async function defaultGitClone(ref: string, destDir: string): Promise<string> {
  await execFileAsync("git", ["clone", "--depth", "1", ref, destDir]);
  return destDir;
}

function asMap(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readMcpManifest(dir: string): Record<string, CanonicalMcp> | null {
  for (const file of ["mcp.json", ".mcp.json"]) {
    const filePath = path.join(dir, file);
    if (!existsSync(filePath)) continue;
    const parsed = readJsonObject(filePath);
    const wrapped = { ...asMap(parsed.mcpServers), ...asMap(parsed.servers) };
    const fromWrapped = Object.fromEntries(
      Object.entries(wrapped).map(([name, raw]) => [name, fromVendor(raw)])
    );
    const usable = Object.fromEntries(
      Object.entries(fromWrapped).filter(([, entry]) => Boolean(entry.command || entry.url))
    );
    if (Object.keys(usable).length > 0) return usable;
    const single = fromVendor(parsed);
    if (single.command || single.url) {
      return { [path.basename(dir)]: single };
    }
  }
  return null;
}

function writeMcpToPresent(opts: {
  homeDir: string;
  scope: "global" | "project";
  projectPath: string | null;
  servers: Record<string, CanonicalMcp>;
}): { name: string | null; reason?: string } {
  const adapters = presentAdapters(opts.homeDir);
  if (adapters.length === 0) {
    return { name: null, reason: "no live harness is present to receive this MCP server" };
  }
  let first: string | null = null;
  let wrote = false;
  let skippedConflict = false;
  for (const [name, entry] of Object.entries(opts.servers)) {
    first ??= name;
    for (const adapter of adapters) {
      const live =
        opts.scope === "project" && opts.projectPath
          ? (adapter.readProjectMcp?.(opts.projectPath) ?? {})[name]
          : adapter.readMcp(opts.homeDir)[name];
      if (live && mcpFingerprint(live) !== mcpFingerprint(entry)) {
        skippedConflict = true;
        continue;
      }
      if (opts.scope === "project" && opts.projectPath) {
        adapter.writeProjectMcpEntry?.(opts.projectPath, name, entry);
      } else {
        adapter.writeMcpEntry(opts.homeDir, name, entry);
      }
      wrote = true;
    }
  }
  if (!wrote) {
    return {
      name: null,
      reason: skippedConflict
        ? "every present harness already has this name with a different command or URL"
        : "no live harness is present to receive this MCP server"
    };
  }
  return { name: first };
}

export async function installGeneric(
  source: InstallSource,
  target: InstallTarget,
  strategies: InstallStrategies = {}
): Promise<{ installed: boolean; path?: string; reason?: string }> {
  if (source.type !== "git") {
    return { installed: false, reason: `source type ${source.type} is not supported yet` };
  }

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "loadout-install-"));
  try {
    const clone = strategies.gitClone ?? defaultGitClone;
    const repoDir = await clone(source.ref, path.join(tempRoot, repoNameFrom(source.ref)));

    const resolved = source.subdir ? path.resolve(repoDir, source.subdir) : repoDir;
    const relative = path.relative(repoDir, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return { installed: false, reason: `subdirectory ${source.subdir} resolves outside the repository` };
    }
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      return { installed: false, reason: `${source.subdir} is not a directory in ${source.ref}` };
    }

    const skillMd = existsSync(path.join(resolved, "SKILL.md"));
    const mcpServers = readMcpManifest(resolved);
    const asMcp = target.kind === "mcp" || (!skillMd && mcpServers);

    if (asMcp) {
      if (!mcpServers) {
        return {
          installed: false,
          reason: `${source.subdir ?? "the repository root"} has no mcp.json, so there is nothing to write into harness configs`
        };
      }
      const approved =
        strategies.skipConfirmation === true ||
        (await requestLocalConfirmation({
          id: nextConfirmationId(),
          description: `Install ${source.ref}${source.subdir ? ` (${source.subdir})` : ""} (${target.scope})`
        }));
      if (!approved) return { installed: false, reason: "denied" };

      const written = writeMcpToPresent({
        homeDir: target.homeDir ?? os.homedir(),
        scope: target.scope,
        projectPath: target.projectPath,
        servers: mcpServers
      });
      if (!written.name) {
        return { installed: false, reason: written.reason };
      }
      return { installed: true, path: written.name };
    }

    if (!skillMd) {
      return {
        installed: false,
        reason: `${source.subdir ?? "the repository root"} has no SKILL.md, so no scanner would report it`
      };
    }

    const installRoot = skillsDirFor(target);
    const destName = path.basename(resolved);
    const destDir = path.join(installRoot, destName);
    if (existsSync(destDir)) {
      return { installed: false, reason: `${destName} is already installed at ${destDir}` };
    }

    const approved =
      strategies.skipConfirmation === true ||
      (await requestLocalConfirmation({
        id: nextConfirmationId(),
        description: `Install ${source.ref}${source.subdir ? ` (${source.subdir})` : ""} (${target.scope})`
      }));
    if (!approved) return { installed: false, reason: "denied" };

    mkdirSync(installRoot, { recursive: true });
    cpSync(resolved, destDir, {
      recursive: true,
      filter: (src) => path.basename(src) !== ".git"
    });
    projectSkillToPresentHarnesses({
      homeDir: target.homeDir ?? os.homedir(),
      canonicalPath: destDir,
      projectPath: target.projectPath
    });
    return { installed: true, path: destDir };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
