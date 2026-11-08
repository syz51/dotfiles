// Claude Code SessionStart hook (startup). A worktree that someone else cut, such as a T3
// delegate_task worktree (branched from the parent's commit) or a `claude --worktree`
// session, can start on a local default branch that is releases behind origin; freshen-base.js
// covers only the worktrees Claude Code's own tools create. In a linked worktree, this fetches
// origin's default branch with a short timeout and, when HEAD has no commits of its own and
// is behind it, tells Claude to fast-forward before the first edit. It never changes the
// worktree, stays quiet in a main checkout, on a branch with its own commits and offline,
// and a crash is a non-blocking hook error.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fetchEnv } from "./freshen-base.js";

// Every session that starts in a worktree waits for this fetch, so keep it short.
const FETCH_TIMEOUT_MS = 4_000;
const READ_TIMEOUT_MS = 2_000;

/** A note for Claude when the worktree at `cwd` starts behind origin's default branch, or undefined. */
export function staleBase(cwd, { env = process.env, fetchTimeout = FETCH_TIMEOUT_MS } = {}) {
  const run = (args, options = {}) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env, timeout: READ_TIMEOUT_MS, ...options });
    if (result.error && result.error.code !== "ETIMEDOUT") throw result.error;
    return { ok: result.status === 0, out: (result.stdout ?? "").trim() };
  };
  const dirs = run(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
  if (!dirs.ok) return undefined;
  const [gitDir, commonDir] = dirs.out.split("\n");
  // A main checkout: config-sync and freshen-base.js keep its default branch current.
  if (gitDir === commonDir) return undefined;
  if (!run(["rev-parse", "--verify", "--quiet", "HEAD"]).ok) return undefined;
  const branch = run(["symbolic-ref", "--quiet", "--short", "HEAD"]).out;
  const remote = (branch && run(["config", "--get", `branch.${branch}.remote`]).out) || "origin";
  if (!run(["remote", "get-url", remote]).ok) return undefined;
  const prefix = `refs/remotes/${remote}/`;
  const remoteHead = run(["symbolic-ref", "--quiet", `${prefix}HEAD`]).out;
  const defaultBranch = remoteHead.startsWith(prefix)
    ? remoteHead.slice(prefix.length)
    : ["main", "master"].find((name) => run(["rev-parse", "--verify", "--quiet", `${prefix}${name}`]).ok);
  if (!defaultBranch) return undefined;
  const target = `${remote}/${defaultBranch}`;
  const targetRef = `${prefix}${defaultBranch}`;
  // A failed or timed-out fetch falls back to the last fetched ref: offline costs nothing more.
  // The timeout stops git but not its ssh, so ssh gives up connecting on its own too.
  const sshEnv = fetchEnv(cwd, env);
  if (sshEnv.GIT_SSH_COMMAND) sshEnv.GIT_SSH_COMMAND += ` -o ConnectTimeout=${Math.ceil(fetchTimeout / 1000)}`;
  const fetched = run(["fetch", "--quiet", "--no-tags", remote, defaultBranch], { env: sshEnv, timeout: fetchTimeout });
  if (!run(["rev-parse", "--verify", "--quiet", targetRef]).ok) return undefined;
  // Commits of its own mean a chosen base, such as a parent's unpushed work: leave it alone.
  if (!run(["merge-base", "--is-ancestor", "HEAD", targetRef]).ok) return undefined;
  const behind = Number(run(["rev-list", "--count", `HEAD..${targetRef}`]).out);
  if (!behind) return undefined;
  const tip = run(["rev-parse", "--short=12", targetRef]).out;
  const here = branch ? `branch ${branch}` : "detached HEAD";
  const source = fetched.ok ? "" : ` (the fetch failed, so this is the last fetched ${target})`;
  return `This worktree starts behind: its ${here} has no commits of its own and is ${behind} commit(s) behind ${target} (${tip})${source}. Before the first edit, run \`git merge --ff-only ${target}\`, unless the task asks for this older base.`;
}

if (import.meta.main) {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const note = staleBase(input.cwd ?? process.cwd());
  if (note) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: note } }));
}
