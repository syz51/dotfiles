// Claude Code PreToolUse hook for EnterWorktree and Agent. settings.json sets
// worktree.baseRef to "head", so a new worktree starts from the checkout's local HEAD and
// keeps its unpushed commits; but a local default branch that never pulled hands out old
// code. Before a new worktree is made (EnterWorktree with a name, or an Agent call with
// isolation "worktree"), this fetches the default branch and fast-forwards it when it is
// checked out, has no tracked changes and is strictly behind its remote. It never
// merges, resets or touches a branch with commits of its own; it only tells Claude why it
// left a stale branch alone. It always exits 0, so a failure never blocks the tool.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FETCH_TIMEOUT_MS = 20_000;

function git(cwd, args, timeout = 10_000) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
}

/** Whether this tool call creates a worktree from the session's checkout. */
export function createsWorktree(input) {
  const tool = input.tool_input ?? {};
  if (input.tool_name === "EnterWorktree") return !tool.path;
  if (input.tool_name === "Agent" || input.tool_name === "Task") return tool.isolation === "worktree";
  return false;
}

/** Fast-forward the default branch at `cwd` when safe; returns a note for Claude, or undefined. */
export function freshen(cwd) {
  if (!git(cwd, ["rev-parse", "--is-inside-work-tree"]).ok) return undefined;
  const branch = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).out;
  if (!branch) return undefined;
  const remote = git(cwd, ["config", "--get", `branch.${branch}.remote`]).out || "origin";
  const remoteHead = git(cwd, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]).out;
  const defaultBranch = remoteHead ? remoteHead.slice(remote.length + 1) : ["main", "master"].find((name) => name === branch);
  if (branch !== defaultBranch) return undefined;
  const target = `${remote}/${branch}`;
  if (!git(cwd, ["fetch", "--quiet", remote, branch], FETCH_TIMEOUT_MS).ok) return undefined;
  const head = git(cwd, ["rev-parse", "HEAD"]).out;
  const tip = git(cwd, ["rev-parse", target]).out;
  if (!tip || head === tip || git(cwd, ["merge-base", "--is-ancestor", target, "HEAD"]).ok) return undefined;
  const behind = git(cwd, ["rev-list", "--count", `HEAD..${target}`]).out;
  if (!git(cwd, ["merge-base", "--is-ancestor", "HEAD", target]).ok) {
    return `The new worktree starts from local ${branch}, which has commits of its own and is ${behind} commit(s) behind ${target}; it was left as it is.`;
  }
  if (git(cwd, ["status", "--porcelain", "--untracked-files=no"]).out) {
    return `The new worktree starts from local ${branch}, ${behind} commit(s) behind ${target}; it has tracked changes, so it was not fast-forwarded.`;
  }
  const merged = git(cwd, ["merge", "--ff-only", "--quiet", target]);
  if (!merged.ok) return `Fast-forwarding ${branch} to ${target} failed (${merged.err.split("\n")[0]}); the new worktree starts ${behind} commit(s) behind.`;
  return `Fast-forwarded ${branch} by ${behind} commit(s) to ${target} (${tip.slice(0, 12)}) before creating the worktree.`;
}

if (import.meta.main) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const note = createsWorktree(input) ? freshen(input.cwd ?? process.cwd()) : undefined;
    if (note) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: note } }));
    }
  } catch (error) {
    process.stderr.write(`freshen-base: ${error.message}\n`);
  }
  process.exit(0);
}
