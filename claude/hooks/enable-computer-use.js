// Claude Code SessionStart hook. Enables the built-in computer-use MCP server in every
// project. Claude Code has no user-wide switch for it: `/mcp` records the choice per
// project, as `projects[<key>].enabledMcpServers` in ~/.claude.json, keyed by the main
// repository root (a linked worktree shares its repository's key) or, outside git, by
// the folder itself. This hook adds that entry for the session's project; Claude Code
// watches the file and connects the server. Temporary folders are skipped so throwaway
// sessions don't add project entries. It writes under Claude Code's own config lock,
// and on any failure it leaves the file alone and exits quietly; the next session
// retries. Turning the server off in `/mcp` lasts only until the next session there.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export const SERVER = "computer-use";
const LOCK_ATTEMPTS = 40;
const LOCK_DELAY_MS = 50;

function git(dir, args) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

/** The ~/.claude.json project key Claude Code uses for a session started in `cwd`. */
export function projectKey(cwd, run = git) {
  const top = run(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) return cwd;
  const gitDir = run(cwd, ["rev-parse", "--path-format=absolute", "--absolute-git-dir"]);
  const common = run(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  // A linked worktree's git dir is <common>/worktrees/<name>; its key is the main checkout.
  if (gitDir && common && gitDir !== common && dirname(gitDir) === join(common, "worktrees")) return dirname(common);
  return top;
}

/** Whether `dir` is inside a system temporary folder. */
export function isTemporary(dir, roots = temporaryRoots()) {
  return roots.some((root) => dir === root || dir.startsWith(root + sep));
}

function temporaryRoots() {
  const roots = new Set(["/tmp", "/private/tmp", "/private/var/folders", "/var/folders"]);
  for (const path of [tmpdir(), process.env.TMPDIR].filter(Boolean)) {
    roots.add(resolve(path));
    try { roots.add(realpathSync(path)); } catch {}
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
  let wrote = false;
  withConfigLock(configPath, () => {
    const target = realpathSync(configPath); // ~/.claude.json may be a link; keep it one
    const next = enable(JSON.parse(readFileSync(target, "utf8")), key);
    if (!next) return;
    const temporary = `${target}.computer-use-${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}`, { mode: statSync(target).mode & 0o777 });
    renameSync(temporary, target);
    wrote = true;
  });
  return wrote;
}

if (import.meta.main) {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const cwd = realpathSync(typeof input?.cwd === "string" ? input.cwd : process.cwd());
  if (!isTemporary(cwd)) {
    const configPath = join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");
    try {
      enableInFile(configPath, projectKey(cwd));
    } catch (error) {
      process.stderr.write(`enable-computer-use: ${error.message}\n`);
    }
  }
}
