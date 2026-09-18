import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { nextConfirmationId, requestLocalConfirmation } from "./confirm.js";

const execFileAsync = promisify(execFile);

export interface InstallSource { type: "git" | "npm" | "url"; ref: string; subdir?: string | null }
export interface InstallTarget {
  tool: "claude_code" | "codex";
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
  const dirName = target.tool === "claude_code" ? ".claude" : ".agents";
  return path.join(root, dirName, "skills");
}

// The repository's own name, used both as the scratch clone directory and — when no
// subdirectory is named — as the installed skill's identity on disk. Deriving it from the
// ref rather than from the scratch path keeps a root-is-the-skill repository landing at
// <skills>/<repo> exactly as it did before the temp-clone rework.
function repoNameFrom(ref: string): string {
  return path.basename(ref).replace(/\.git$/, "") || "repo";
}

/**
 * Where an installed artifact of a given kind belongs, or null when this installer has
 * no honest destination for it.
 *
 * "mcp" has none: an MCP server is an entry inside a config file, not a directory of
 * files. This used to throw — which meant the caller learned about it as an unhandled
 * command error rather than a reason it could log and show.
 */
function installDirFor(target: InstallTarget): string | null {
  if (target.kind === "mcp") return null;
  return skillsDirFor(target);
}

async function defaultGitClone(ref: string, destDir: string): Promise<string> {
  await execFileAsync("git", ["clone", "--depth", "1", ref, destDir]);
  return destDir;
}

export async function installGeneric(
  source: InstallSource,
  target: InstallTarget,
  strategies: InstallStrategies = {}
): Promise<{ installed: boolean; path?: string; reason?: string }> {
  // Resolve the destination BEFORE asking for local confirmation: an unsupported target
  // (see installDirFor) must fail loudly and immediately rather than prompting the user to
  // approve an install that could only ever land in the wrong place.
  const installRoot = installDirFor(target);
  if (installRoot === null) {
    return {
      installed: false,
      reason:
        "kind 'mcp' is not installable: an MCP server is a config-file entry " +
        "(codex config.toml [mcp_servers.*] / claude_code mcpServers), not a directory of files"
    };
  }
  if (source.type !== "git") {
    return { installed: false, reason: `source type ${source.type} is not supported yet` };
  }

  // Clone into a temp directory rather than onto the destination. Two reasons: the
  // interesting content is usually a subdirectory of the repo, and a destination that
  // already exists must be a reported refusal, not `git clone`'s non-zero exit surfacing
  // as an unhandled command error.
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "loadout-install-"));
  try {
    // "npm" and "url" are refused above, so source.type is "git" here.
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
    if (!existsSync(path.join(resolved, "SKILL.md"))) {
      return {
        installed: false,
        reason: `${source.subdir ?? "the repository root"} has no SKILL.md, so no scanner would report it`
      };
    }

    // The installed directory's basename becomes the skill's identity on disk, and the
    // subdirectory is the better name: cloning github.com/x/cc-limits with subdir
    // skills/cc-limits should land at skills/cc-limits, not skills/cc-limits/skills/...
    // With no subdirectory `resolved` is the clone root, which repoNameFrom already named
    // after the repository, so the same rule serves both shapes.
    const destName = path.basename(resolved);
    const destDir = path.join(installRoot, destName);
    if (existsSync(destDir)) {
      return { installed: false, reason: `${destName} is already installed at ${destDir}` };
    }

    const approved =
      strategies.skipConfirmation === true ||
      (await requestLocalConfirmation({
        id: nextConfirmationId(),
        description: `Install ${source.ref}${source.subdir ? ` (${source.subdir})` : ""} into ${target.tool} (${target.scope})`
      }));
    if (!approved) return { installed: false, reason: "denied" };

    mkdirSync(installRoot, { recursive: true });
    cpSync(resolved, destDir, {
      recursive: true,
      filter: (src) => path.basename(src) !== ".git"
    });
    return { installed: true, path: destDir };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
