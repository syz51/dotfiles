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
// It asks for the first merge method the repository allows, in METHODS order. It never merges
// at once. It calls the enablePullRequestAutoMerge mutation, which GitHub refuses for a pull
// request it can merge now, rather than `gh pr merge --auto`, which merges such a pull request
// directly, also when its state was still UNKNOWN when the hook read it. A pull request that can
// merge now is left to an agent, through guard-pr-merge. The hook runs gh itself,
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
/** The merge methods in order of preference: the repository setting that allows each, its GraphQL name and its name in the report. */
export const METHODS = [["allow_merge_commit", "MERGE", "merge commit"], ["allow_squash_merge", "SQUASH", "squash"], ["allow_rebase_merge", "REBASE", "rebase"]];
const HOST = "github.com";

// Each gh call gets at most this long, and the hook stops once the budget is spent, before
// settings.json's 60-second timeout.
export const CALL_TIMEOUT_MS = 10000;
export const BUDGET_MS = 45000;
// GitHub refuses auto-merge for a pull request in one of these states, which can merge now.
const MERGEABLE_NOW = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);
const ENABLE_AUTO_MERGE = `mutation($id: ID!, $method: PullRequestMergeMethod!) {
  enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: $method}) { pullRequest { autoMergeRequest { enabledAt } } } }`;
const PR_URL = /^https:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)$/;
const INLINE_PR_URL = /https:\/\/[^/\s"'<>]+\/[^/\s"'<>]+\/[^/\s"'<>]+\/pull\/\d+(?![/\w-])/g;
const MCP_CREATE_TOOLS = new Set(["mcp__t3-code__pull_request_create", "mcp_t3-code_pull_request_create"]);
const STRUCTURED_URL_KEYS = ["url", "html_url", "prUrl", "pullRequestUrl", "pull_request_url"];
const STRUCTURED_CONTAINER_KEYS = ["structuredContent", "pullRequest", "pull_request", "pr", "data", "result"];

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

/** Runs gh through `run(args, timeoutMs)`; returns the parsed JSON, or `missing` on HTTP 404. */
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
  const view = query(["pr", "view", url, "--json", "id,state,isDraft,baseRefName,mergeStateStatus,autoMergeRequest"], "read the pull request");
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
  const now = `${url}: skipped, it can merge now, so auto-merge has nothing to wait for. Merge it yourself once every check passes.`;
  if (MERGEABLE_NOW.has(view.mergeStateStatus)) return now;
  try {
    query(["api", "--hostname", HOST, "graphql", "-f", `query=${ENABLE_AUTO_MERGE}`, "-f", `id=${view.id}`, "-f", `method=${method[1]}`], "turn on auto-merge");
  } catch (error) {
    // The state changed after the read, as it does while GitHub still computes it.
    if (error instanceof GhFailure && /\b(?:clean|unstable|has_hooks) status\b/i.test(error.message)) return now;
    throw error;
  }
  return `${url}: auto-merge is on (${method[2]}); GitHub merges it once ${view.baseRefName}'s requirements pass. If it falls BEHIND, run \`gh pr update-branch ${url}\`.`;
}

/** Extracts distinct pull request URLs from an MCP `pull_request_create` response or plain text. */
export function extractMcpPullRequestUrls(toolResponse) {
  const urls = new Set();
  const seen = new Set();
  const addIfPrUrl = (value) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (PR_URL.test(trimmed)) urls.add(trimmed);
  };
  const visitText = (text) => {
    if (typeof text !== "string" || !text.includes("/pull/")) return;
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        visit(JSON.parse(trimmed));
        return;
      } catch {
        // Fall through to plain-text URL extraction when not valid JSON.
      }
    }
    const lineUrls = pullRequestUrls(text);
    if (lineUrls.length > 0) {
      for (const u of lineUrls) urls.add(u);
      return;
    }
    for (const match of text.matchAll(INLINE_PR_URL)) {
      if (PR_URL.test(match[0])) urls.add(match[0]);
    }
  };
  const visit = (value) => {
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      visitText(value);
      return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value.isError === true) return;
    for (const key of STRUCTURED_URL_KEYS) addIfPrUrl(value[key]);
    for (const key of STRUCTURED_CONTAINER_KEYS) {
      if (value[key] !== undefined) visit(value[key]);
    }
    if (Array.isArray(value.content)) visit(value.content);
    if (typeof value.stdout === "string") visitText(value.stdout);
    if (typeof value.text === "string") visitText(value.text);
  };
  visit(toolResponse);
  return [...urls];
}

/** Runs auto-merge for each PR URL in `urls` and returns the formatted hook report, or undefined. */
export function reportUrls(urls, run, { budgetMs = BUDGET_MS } = {}) {
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

/**
 * The report for a Bash call that ran `command` from `cwd` and printed `stdout`, or undefined
 * when it created no pull request. `run(args, timeoutMs)` runs gh and returns { code, stdout,
 * stderr }; it throws when gh cannot run or times out.
 */
export function report(command, cwd, stdout, run, { budgetMs = BUDGET_MS } = {}) {
  if (!createsPullRequest(command, cwd)) return undefined;
  return reportUrls(pullRequestUrls(stdout), run, { budgetMs });
}

/**
 * The report for a T3 MCP `pull_request_create` call with `toolInput` and `toolResponse` from
 * `cwd`, or undefined when skipped (draft, private, tool error, or no PR URL). Falls back to
 * `gh pr view --json url -q .url` in `cwd` when the tool output omits the URL.
 */
export function reportMcpCreate(toolInput, toolResponse, cwd, run, { budgetMs = BUDGET_MS } = {}) {
  if (toolInput?.draft === true || toolInput?.private === true) return undefined;
  if (toolResponse && typeof toolResponse === "object" && toolResponse.isError === true) return undefined;
  const deadline = Date.now() + budgetMs;
  let urls = extractMcpPullRequestUrls(toolResponse);
  if (urls.length === 0) {
    if (typeof toolInput?.environmentId === "string" && toolInput.environmentId.trim() !== "") {
      return undefined;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      return "auto-merge hook:\nauto-merge failed: gh ran out of time to read the created pull request URL. Turn it on yourself as ~/.claude/reference/merge.md says, and report the failure.";
    }
    let result;
    try {
      result = run(["pr", "view", "--json", "url", "-q", ".url"], Math.min(CALL_TIMEOUT_MS, left));
    } catch (error) {
      return `auto-merge hook:\nauto-merge failed: gh could not read the created pull request URL (${error.message}). Turn it on yourself as ~/.claude/reference/merge.md says, and report the failure.`;
    }
    if (result.code !== 0) {
      return `auto-merge hook:\nauto-merge failed: gh could not read the created pull request URL (${firstLine(result.stderr)}). Turn it on yourself as ~/.claude/reference/merge.md says, and report the failure.`;
    }
    urls = extractMcpPullRequestUrls(result.stdout);
  }
  if (urls.length === 0) return undefined;
  return reportUrls(urls, run, { budgetMs: Math.max(0, deadline - Date.now()) });
}

if (import.meta.main) {
  let text;
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
    if (MCP_CREATE_TOOLS.has(input?.tool_name)) {
      text = reportMcpCreate(
        input?.tool_input ?? {},
        input?.tool_response,
        cwd,
        (args, timeout) => runGh(cwd, args, timeout),
      );
    } else {
      const command = input?.tool_input?.command;
      const stdout = input?.tool_response?.stdout;
      // A cheap prefilter: the command names gh and the output holds a pull request URL.
      if (typeof command === "string" && typeof stdout === "string" && /gh/i.test(command) && stdout.includes("/pull/")) {
        text = report(command, cwd, stdout, (args, timeout) => runGh(cwd, args, timeout));
      }
    }
  } catch (error) {
    text = `auto-merge hook failed (${error.message}), so auto-merge may be off. Turn it on yourself as ~/.claude/reference/merge.md says, and report the failure.`;
  }
  if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } }));
}
