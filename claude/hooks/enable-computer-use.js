// Claude Code SessionStart hook (startup only). Enables the built-in computer-use MCP
// server in every project. Claude Code has no user-wide switch for it: `/mcp` records
// the choice per project, as `projects[<key>].enabledMcpServers` in ~/.claude.json,
// keyed by the repository root (a linked worktree shares its repository's key) or,
// outside git, by the folder itself. This hook adds that entry for the session's
// project; Claude Code watches the file and connects the server. Temporary folders are
// skipped so throwaway sessions don't add project entries, and so are folders whose key
// git cannot tell. It writes under Claude Code's own config lock; on any failure it
// reports on stderr, leaves the file alone and lets the session start. Turning the
// server off in `/mcp` lasts until the next session starts there.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { runGit } from "./guard-git-push.js";

export const SERVER = "computer-use";
const LOCK_ATTEMPTS = 40;
const LOCK_DELAY_MS = 50;
// Variables that make git answer for another repository than the one around cwd.
const GIT_LOCATION_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"];

/**
 * The ~/.claude.json project key Claude Code uses for a session started in `cwd`, or
 * undefined when git cannot answer for a folder inside a repository. `git(dir, args)`
 * returns trimmed stdout, undefined when git exits non-zero, and throws when it fails.
 */
export function projectKey(cwd, git = runGit) {
  const answer = git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"]);
  if (!answer) return insideRepository(cwd) ? undefined : cwd;
  const [top, gitDir, common] = answer.split("\n");
  // A linked worktree's git dir is <common>/worktrees/<name>. Claude Code then keys it by
  // the main checkout when the common dir is a checkout's .git, otherwise by the common
  // dir itself (a bare repository), unless that folder is a checkout of its own.
  if (gitDir === common || dirname(gitDir) !== join(common, "worktrees")) return top;
  if (basename(common) === ".git") return dirname(common);
  return existsSync(join(common, ".git")) ? top : common;
}

function insideRepository(dir) {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return true;
    if (dirname(current) === current) return false;
  }
}

/** Whether `dir` is inside a system temporary folder. */
export function isTemporary(dir, roots = temporaryRoots()) {
  return roots.some((root) => dir === root || dir.startsWith(root + sep));
}

function temporaryRoots() {
  const roots = new Set(["/tmp", "/private/tmp", "/private/var/folders", "/var/folders"]);
  for (const path of [tmpdir(), process.env.TMPDIR].filter(Boolean)) {
    roots.add(resolve(path));
    if (existsSync(path)) roots.add(realpathSync(path));
  }
  return [...roots];
}

/** The config with SERVER enabled for `key`, or undefined when it already is. */
export function enable(config, key) {
  const project = config.projects?.[key] ?? {};
  const enabled = Array.isArray(project.enabledMcpServers) ? project.enabledMcpServers : [];
  if (enabled.includes(SERVER)) return undefined;
  return { ...config, projects: { ...config.projects, [key]: { ...project, enabledMcpServers: [...enabled, SERVER] } } };
}

/**
 * Runs `update` while holding the lock Claude Code takes for ~/.claude.json: the directory
 * `<configPath>.lock`. Returns false without running it when the lock stays taken.
 */
export function withConfigLock(configPath, update) {
  const lock = `${configPath}.lock`;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      mkdirSync(lock);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      Bun.sleepSync(LOCK_DELAY_MS);
      continue;
    }
    try {
      update();
      return true;
    } finally {
      rmdirSync(lock);
    }
  }
  return false;
}

/** Enables SERVER for `key` in the config file at `configPath`. Returns whether it wrote. */
export function enableInFile(configPath, key) {
  const target = realpathSync(configPath); // ~/.claude.json may be a link; keep it one
  const read = () => JSON.parse(readFileSync(target, "utf8"));
  if (!enable(read(), key)) return false; // the usual case: nothing to write, no lock
  let wrote = false;
  withConfigLock(configPath, () => {
    const next = enable(read(), key);
    if (!next) return;
    const temporary = `${target}.computer-use-${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: statSync(target).mode & 0o777 });
    renameSync(temporary, target);
    wrote = true;
  });
  return wrote;
}

/** Handles one SessionStart payload. */
export function main(payload, env = process.env) {
  const input = JSON.parse(payload);
  const cwd = realpathSync(typeof input?.cwd === "string" ? input.cwd : process.cwd());
  if (isTemporary(cwd)) return;
  for (const name of GIT_LOCATION_VARIABLES) delete env[name];
  const key = projectKey(cwd);
  if (key === undefined) throw new Error(`git could not name the repository of ${cwd}`);
  enableInFile(join(env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json"), key);
}

if (import.meta.main) {
  try {
    main(readFileSync(0, "utf8"));
  } catch (error) {
    process.stderr.write(`enable-computer-use: ${error.message}\n`);
  }
}
