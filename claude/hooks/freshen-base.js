// Claude Code PreToolUse hook for EnterWorktree and Agent. settings.json sets
// worktree.baseRef to "head", so a new worktree starts from the checkout's local HEAD and
// keeps its unpushed commits; but a local default branch that never pulled hands out old
// code. Before a new worktree is made (EnterWorktree creating one, or an Agent call with
// isolation "worktree"), this fetches the default branch and fast-forwards it when it is
// checked out, has no tracked changes and is strictly behind its remote: what config-sync
// does every 30 minutes, done at the moment it matters. It never merges, resets or touches
// a branch with commits of its own, and tells Claude why it left a stale branch alone.
// Parallel calls take turns on a lock, so one fetches and the others find it current. It
// never blocks the tool: notes go to Claude, and a crash is a non-blocking hook error.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const FETCH_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 10_000;
const LOCK_WAIT_MS = 30_000;
const LOCK_STALE_MS = 120_000;

// A local git call. A timeout counts as a failed call; any other spawn error (no git) throws.
function git(cwd, args, { env = process.env, timeout = READ_TIMEOUT_MS } = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env, timeout });
  if (result.error && result.error.code !== "ETIMEDOUT") throw result.error;
  return { ok: result.status === 0, timedOut: Boolean(result.error), out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
}

// The last line git printed, without progress meters, for a one-line note.
const lastLine = (text) => text.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "no output";

/** The environment for the fetch: git and ssh fail instead of prompting on the terminal. */
export function fetchEnv(cwd, env = process.env) {
  const out = { ...env, GIT_TERMINAL_PROMPT: "0" };
  if (!env.GIT_SSH) {
    const ssh = env.GIT_SSH_COMMAND || git(cwd, ["config", "--get", "core.sshCommand"], { env }).out || "ssh";
    out.GIT_SSH_COMMAND = `${ssh} -o BatchMode=yes`;
  }
  return out;
}

/** Whether this tool call creates a worktree from the session's checkout. */
export function createsWorktree(input) {
  const tool = input.tool_input ?? {};
  if (input.tool_name === "EnterWorktree") {
    if (tool.path) return false;
    if (!tool.name) return true;
    // A name that already has a worktree resumes it instead of creating one.
    const root = git(input.cwd ?? process.cwd(), ["rev-parse", "--show-toplevel"]);
    return !(root.ok && existsSync(join(root.out, ".claude", "worktrees", tool.name)));
  }
  if (input.tool_name === "Agent" || input.tool_name === "Task") return tool.isolation === "worktree";
  return false;
}

// Runs work() holding a lock in the repository's common git folder, shared by its worktrees.
function withLock(cwd, env, work) {
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { env });
  if (!common.ok) return undefined;
  const lock = join(common.out, "freshen-base.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let age;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (age > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
    else if (Date.now() > deadline) return `Another freshen-base run held ${lock} for over ${LOCK_WAIT_MS / 1000} s, so the default branch was not fetched; the new worktree starts from it as it is.`;
    else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  try {
    return work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Fast-forward the default branch at `cwd` when safe; returns a note for Claude, or undefined. */
export function freshen(cwd, { env = process.env } = {}) {
  const run = (args, options = {}) => git(cwd, args, { env, ...options });
  if (!run(["rev-parse", "--is-inside-work-tree"]).ok) return undefined;
  const branch = run(["symbolic-ref", "--quiet", "--short", "HEAD"]).out;
  // Detached, or a branch with no commits yet.
  if (!branch || !run(["rev-parse", "--verify", "--quiet", "HEAD"]).ok) return undefined;
  const remote = run(["config", "--get", `branch.${branch}.remote`]).out || "origin";
  const prefix = `refs/remotes/${remote}/`;
  const remoteHead = run(["symbolic-ref", "--quiet", `${prefix}HEAD`]).out;
  const defaultBranch = remoteHead.startsWith(prefix) ? remoteHead.slice(prefix.length) : ["main", "master"].find((name) => name === branch);
  if (branch !== defaultBranch) return undefined;
  const target = `${remote}/${branch}`;
  const targetRef = `${prefix}${branch}`;
  return withLock(cwd, env, () => {
    const fetched = run(["fetch", "--quiet", remote, branch], { env: fetchEnv(cwd, env), timeout: FETCH_TIMEOUT_MS });
    if (!fetched.ok) {
      const why = fetched.timedOut ? `timed out after ${FETCH_TIMEOUT_MS / 1000} s` : lastLine(fetched.err);
      return `Fetching ${target} failed (${why}); the new worktree starts from local ${branch} as it is, which may be behind ${target}.`;
    }
    // The fetch updates the remote-tracking branch only when a refspec covers it.
    if (!run(["rev-parse", "--verify", "--quiet", targetRef]).ok) return undefined;
    if (run(["merge-base", "--is-ancestor", targetRef, "HEAD"]).ok) return undefined;
    const behind = run(["rev-list", "--count", `HEAD..${targetRef}`]).out;
    if (!run(["merge-base", "--is-ancestor", "HEAD", targetRef]).ok) {
      return `The new worktree starts from local ${branch}, which has commits of its own and is ${behind} commit(s) behind ${target}; it was left as it is.`;
    }
    if (run(["status", "--porcelain", "--untracked-files=no"]).out) {
      return `The new worktree starts from local ${branch}, ${behind} commit(s) behind ${target}; it has tracked changes, so it was not fast-forwarded.`;
    }
    // No timeout: killing a fast-forward partway would leave the checkout half-updated.
    const merged = run(["merge", "--ff-only", "--quiet", targetRef], { timeout: undefined });
    if (!merged.ok) return `Fast-forwarding ${branch} to ${target} failed (${lastLine(merged.err || merged.out)}); the new worktree starts ${behind} commit(s) behind.`;
    const tip = run(["rev-parse", "--short=12", "HEAD"]).out;
    return `Fast-forwarded ${branch} by ${behind} commit(s) to ${target} (${tip}) before creating the worktree.`;
  });
}

if (import.meta.main) {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const note = createsWorktree(input) ? freshen(input.cwd ?? process.cwd()) : undefined;
  if (note) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: note } }));
}
