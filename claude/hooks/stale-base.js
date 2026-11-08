// Claude Code SessionStart hook (startup). A worktree that someone else cut, such as a T3
// delegate_task worktree (branched from the parent's commit) or a `claude --worktree`
// session, can start on a local default branch that is releases behind origin; freshen-base.js
// covers only the worktrees Claude Code's own tools create. In a clean linked worktree whose
// HEAD has no commits of its own, this fetches origin's default branch with a short timeout
// and, when HEAD is behind it, tells Claude to fast-forward before the first edit. It never
// changes the worktree. It stays quiet in a main checkout, with tracked changes, on a branch
// with its own commits or another upstream, and when nothing newer is known. A crash is a
// non-blocking hook error.
import { readFileSync } from "node:fs";
import { BUSY, fetchEnv, git, withLock } from "./freshen-base.js";

// Every session that starts in a worktree may wait for the lock and the fetch, within the
// 10-second hook timeout in settings.json.
const FETCH_TIMEOUT_MS = 4_000;
const LOCK_WAIT_MS = 2_000;
const READ_TIMEOUT_MS = 2_000;

/** A note for Claude when the worktree at `cwd` starts behind origin's default branch, or undefined. */
export function staleBase(cwd, { env = process.env, fetchTimeout = FETCH_TIMEOUT_MS } = {}) {
  const run = (args, options = {}) => git(cwd, args, { env, timeout: READ_TIMEOUT_MS, ...options });
  const isAncestor = (ref) => run(["merge-base", "--is-ancestor", "HEAD", ref]).ok;
  const dirs = run(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
  if (!dirs.ok) return undefined;
  const [gitDir, commonDir] = dirs.out.split("\n");
  // A main checkout: config-sync and freshen-base.js keep its default branch current.
  if (gitDir === commonDir) return undefined;
  if (!run(["rev-parse", "--verify", "--quiet", "HEAD"]).ok) return undefined;
  // Edits already made mean work started on this base: a fast-forward would mix upstream in.
  if (run(["status", "--porcelain", "--untracked-files=no"]).out) return undefined;
  const branch = run(["symbolic-ref", "--quiet", "--short", "HEAD"]).out;
  const upstreamRemote = branch ? run(["config", "--get", `branch.${branch}.remote`]).out : "";
  const upstreamMerge = branch ? run(["config", "--get", `branch.${branch}.merge`]).out : "";
  // "." is a local upstream, such as main for `git worktree add --track`; compare with origin.
  const remote = upstreamRemote && upstreamRemote !== "." ? upstreamRemote : "origin";
  if (!run(["remote", "get-url", remote]).ok) return undefined;
  const prefix = `refs/remotes/${remote}/`;
  const remoteHead = run(["symbolic-ref", "--quiet", `${prefix}HEAD`]).out;
  const defaultBranch = remoteHead.startsWith(prefix)
    ? remoteHead.slice(prefix.length)
    : ["main", "master"].find((name) => run(["rev-parse", "--verify", "--quiet", `${prefix}${name}`]).ok);
  if (!defaultBranch) return undefined;
  // A branch that tracks a release or stacked base branch is not meant to follow the default.
  if (upstreamMerge && upstreamMerge !== `refs/heads/${defaultBranch}`) return undefined;
  const target = `${remote}/${defaultBranch}`;
  const targetRef = `${prefix}${defaultBranch}`;
  // Commits of its own mean a chosen base, such as a parent's unpushed work: skip the fetch.
  if (run(["rev-parse", "--verify", "--quiet", targetRef]).ok && !isAncestor(targetRef)) return undefined;
  // Sessions that start together, and freshen-base, take turns on one lock: concurrent fetches
  // of one ref fail each other. An explicit refspec updates the ref whatever remote.*.fetch says.
  const fetched = withLock(cwd, env, () => run(
    ["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${defaultBranch}:${targetRef}`],
    { env: fetchEnv(cwd, env, { connectTimeoutMs: fetchTimeout }), timeout: fetchTimeout },
  ), LOCK_WAIT_MS);
  if (!run(["rev-parse", "--verify", "--quiet", targetRef]).ok || !isAncestor(targetRef)) return undefined;
  const behind = Number(run(["rev-list", "--count", `HEAD..${targetRef}`]).out);
  if (!behind) return undefined;
  const tip = run(["rev-parse", "--short=12", targetRef]).out;
  const here = branch ? `branch ${branch}` : "detached HEAD";
  const source = fetched !== BUSY && fetched?.ok ? "" : ` (as last fetched: this session's fetch failed or timed out)`;
  return `This worktree starts behind: its ${here} has no commits of its own and is ${behind} commit(s) behind ${target} (${tip})${source}. Before the first edit, run \`git merge --ff-only ${target}\`, unless the task asks for this older base.`;
}

if (import.meta.main) {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const note = staleBase(input.cwd ?? process.cwd());
  if (note) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: note } }));
}
