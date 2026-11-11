// Claude Code PostToolUse hook for the Bash tool. After a Bash call that ran `gh pr create`
// succeeds, it turns on auto-merge for each pull request whose URL gh printed as a line of its
// output, so the pull request merges once GitHub's requirements pass (dotfiles-350). It acts
// only when all of these hold:
// - the repository is on github.com and its owner is in OWNERS, never an upstream or another
//   owner's repository;
// - the pull request is open, not a draft, and has no auto-merge request yet;
// - the base branch requires status checks or approving reviews, through branch protection or
//   a ruleset; without one, --auto has nothing to wait for;
// - the repository allows auto-merge (allow_auto_merge).
// It passes the first merge method the repository allows, in METHODS order. It never merges at
// once: when the pull request is already CLEAN, HAS_HOOKS or UNSTABLE, gh would merge it
// directly, so the hook leaves that to an agent, through guard-pr-merge. The hook runs gh itself,
// with the user's login, so the merge pushes as the user and starts push workflows. A gh call
// that a hook starts is not a tool call, so guard-pr-merge, a PreToolUse hook on Bash, never
// sees it. The hook never blocks: it reports what it did, skipped or failed to the session as
// additional context and exits 0.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { ghSubcommands, visitCommands } from "./shell.js";
import { runGh } from "./guard-pr-merge.js";

// The policy, kept here so it stays easy to change.
/** Repository owners whose pull requests get auto-merge, compared without case. */
export const OWNERS = ["syz51"];
/** The merge methods in order of preference: the repository setting that allows each, and its gh flag. */
export const METHODS = [["allow_merge_commit", "--merge"], ["allow_squash_merge", "--squash"], ["allow_rebase_merge", "--rebase"]];
const HOST = "github.com";

// Each gh call gets at most this long, and the hook stops once the budget is spent, before
// settings.json's 60-second timeout.
export const CALL_TIMEOUT_MS = 10000;
export const BUDGET_MS = 45000;
// gh merges at once, without enabling auto-merge, when the pull request is in one of these states.
const MERGEABLE_NOW = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);
const PR_URL = /^https:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)$/;

/** Whether `command` runs `gh pr create` (or its alias `gh pr new`) anywhere shell.js can see. */
export function createsPullRequest(command, cwd) {
  return visitCommands(command, cwd, (words) => {
    if (basename(words[0]).toLowerCase() !== "gh") return undefined;
    const [group, subcommand] = ghSubcommands(words, 2).path;
    return group === "pr" && (subcommand === "create" || subcommand === "new") ? true : undefined;
  }) === true;
}

/** The distinct pull request URLs that stand alone on a line of `text`, as gh pr create prints them. */
export function pullRequestUrls(text) {
  const urls = new Set();
  for (const line of (text ?? "").split("\n")) {
    if (PR_URL.test(line.trim())) urls.add(line.trim());
  }
  return [...urls];
}

const firstLine = (text) => (text ?? "").trim().split("\n")[0] || "no output";

class GhFailure extends Error {}

/**
 * Runs gh through `run(args, timeoutMs)`; returns the parsed JSON, or `missing` on HTTP 404.
 * With `missing` null, it returns gh's output as text and treats HTTP 404 as a failure.
 */
function makeQuery(run, deadline) {
  return (args, what, missing) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new GhFailure(`gh ran out of time to ${what}`);
    let result;
    try {
      result = run(args, Math.min(CALL_TIMEOUT_MS, left));
    } catch (error) {
      throw new GhFailure(`gh could not ${what} (${error.message})`);
    }
    if (result.code !== 0) {
      if (missing !== undefined && /HTTP 404/.test(result.stderr ?? "")) return missing;
      throw new GhFailure(`gh could not ${what} (${firstLine(result.stderr)})`);
    }
    if (missing === null) return result.stdout;
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new GhFailure(`gh returned output that is not JSON when asked to ${what}`);
    }
  };
}

/** Whether branch `base` of `repo` (`repos/OWNER/NAME`) requires status checks or approving reviews. */
function requiresChecksOrReviews(query, repo, base) {
  const branch = encodeURIComponent(base);
  const protection = query(["api", "--hostname", HOST, `${repo}/branches/${branch}/protection`], "read the base branch's protection", {});
  const checks = protection.required_status_checks;
  if (checks && checks.enforcement_level !== "off" && ((checks.contexts ?? []).length > 0 || (checks.checks ?? []).length > 0)) return true;
  if ((protection.required_pull_request_reviews?.required_approving_review_count ?? 0) > 0) return true;
  const rules = query(["api", "--hostname", HOST, `${repo}/rules/branches/${branch}`], "read the base branch's rulesets", []);
  return Array.isArray(rules) && rules.some((rule) => rule.type === "required_status_checks"
    || (rule.type === "pull_request" && (rule.parameters?.required_approving_review_count ?? 0) > 0));
}

/** What the hook did for pull request `url`, as one line. `query` runs gh; see makeQuery. */
function autoMerge(url, query) {
  const [, host, owner, name] = PR_URL.exec(url);
  if (host !== HOST || !OWNERS.some((allowed) => allowed.toLowerCase() === owner.toLowerCase())) {
    return `${url}: skipped, the repository's owner ${owner} is not one auto-merge acts for.`;
  }
  const view = query(["pr", "view", url, "--json", "state,isDraft,baseRefName,mergeStateStatus,autoMergeRequest"], "read the pull request");
  if (view.state !== "OPEN") return `${url}: skipped, it is ${view.state.toLowerCase()}.`;
  if (view.isDraft) return `${url}: skipped, it is a draft. Turn on auto-merge after \`gh pr ready\` if its base requires checks.`;
  if (view.autoMergeRequest) return `${url}: auto-merge is already on.`;
  const repo = `repos/${owner}/${name}`;
  const settings = query(["api", "--hostname", HOST, repo], "read the repository's settings");
  if (!settings.allow_auto_merge) return `${url}: skipped, the repository does not allow auto-merge.`;
  if (!requiresChecksOrReviews(query, repo, view.baseRefName)) {
    return `${url}: skipped, ${view.baseRefName} requires no checks or reviews, so auto-merge has nothing to wait for.`;
  }
  const method = METHODS.find(([setting]) => settings[setting] === true);
  if (method === undefined) return `${url}: skipped, the repository allows no merge method.`;
  if (MERGEABLE_NOW.has(view.mergeStateStatus)) {
    return `${url}: skipped, it is ${view.mergeStateStatus} and gh would merge it at once. Merge it yourself once every check passes.`;
  }
  query(["pr", "merge", url, "--auto", method[1]], "turn on auto-merge", null);
  return `${url}: auto-merge is on (${method[1]}); GitHub merges it once ${view.baseRefName}'s requirements pass. If it falls BEHIND, run \`gh pr update-branch ${url}\`.`;
}

/**
 * The report for a Bash call that ran `command` from `cwd` and printed `stdout`, or undefined
 * when it created no pull request. `run(args, timeoutMs)` runs gh and returns { code, stdout,
 * stderr }; it throws when gh cannot run or times out.
 */
export function report(command, cwd, stdout, run, { budgetMs = BUDGET_MS } = {}) {
  if (!createsPullRequest(command, cwd)) return undefined;
  const urls = pullRequestUrls(stdout);
  if (urls.length === 0) return undefined;
  const query = makeQuery(run, Date.now() + budgetMs);
  const lines = urls.map((url) => {
    try {
      return autoMerge(url, query);
    } catch (error) {
      if (error instanceof GhFailure) return `${url}: auto-merge failed: ${error.message}. Turn it on yourself as ~/.claude/reference/merge.md says, and report the failure.`;
      throw error;
    }
  });
  return `auto-merge hook:\n${lines.join("\n")}`;
}

if (import.meta.main) {
  let text;
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const command = input?.tool_input?.command;
    const stdout = input?.tool_response?.stdout;
    // A cheap prefilter: the command names gh and the output holds a pull request URL.
    if (typeof command === "string" && typeof stdout === "string" && /gh/i.test(command) && stdout.includes("/pull/")) {
      const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
      text = report(command, cwd, stdout, (args, timeout) => runGh(cwd, args, timeout));
    }
  } catch (error) {
    text = `auto-merge hook failed (${error.message}), so auto-merge may be off. Turn it on yourself as ~/.claude/reference/merge.md says, and report the failure.`;
  }
  if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } }));
}
