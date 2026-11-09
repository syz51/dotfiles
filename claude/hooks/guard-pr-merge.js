// Claude Code PreToolUse hook for the Bash tool. Enforces the merge rule in ~/.claude/CLAUDE.md's
// Autonomy section: agents merge their pull requests only once the checks pass. Before a
// `gh pr merge` runs, it reads the pull request with `gh pr view` and refuses --admin, a draft,
// a branch that is BEHIND its base or DIRTY with conflicts, and a head commit with a pending or
// failed check, or with no checks while the repository has active Actions workflows. --auto
// passes when the base branch requires status checks and gh will enable auto-merge rather than
// merge at once, because GitHub then waits for the required checks; otherwise it is checked like
// a direct merge. It also refuses `gh api` calls to the pulls/<n>/merge endpoint and the
// mergePullRequest and enablePullRequestAutoMerge mutations, which skip these checks. shell.js
// follows the shell syntax around the command, so `cd`, `sh -c`, wrappers, substitutions and
// `ssh` are seen; any merge argument the shell fills in, arguments xargs adds, options before
// `merge` other than -R, a command that sets GH_HOST, and one that sets GH_REPO without a literal
// -R are refused, as are GIT_DIR, GIT_WORK_TREE and a glob in the command name, selector or
// subcommand. The hook runs once before the whole command, so it refuses a merge in a command
// that also runs, in any order, another merge or a git or gh command that is not read-only,
// such as `git push`, `git switch` or `gh pr checkout`: it could move the head or change which
// pull request gh merges after the check. Within one Actions workflow run only the latest
// attempt of each job counts, so a passing re-run replaces a failed attempt. A failed Actions job
// that GitHub never started for billing, with no steps and only the billing annotation, counts
// as passed when a passing non-Actions check is named "<context>: <job name>", such as
// "ci/circleci: build"; one GraphQL call reads those jobs' steps and annotations, and only
// when every failed check is a failed Actions job. It fails closed: a gh query that fails or times out, an unknown merge option and a crash all
// block the merge (exit 2, with the reason on stderr). It cannot see gh aliases,
// scripts, a merge endpoint held wholly in a variable, a mutation read from a file, or other
// HTTP clients such as curl.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { expands, ghSubcommands, GIT_VALUE_OPTIONS, visitCommands } from "./shell.js";

const TOO_DEEP = "it nests shell commands too deeply to check.";
// `gh pr merge --help`: options without a value, and options that take one, by long name.
const MERGE_FLAGS = new Set(["--admin", "--auto", "--disable-auto", "--delete-branch", "--merge", "--rebase", "--squash", "--help"]);
const MERGE_VALUE_FLAGS = new Set(["--author-email", "--body", "--body-file", "--match-head-commit", "--subject", "--repo"]);
const SHORT_FLAGS = { A: "--author-email", b: "--body", F: "--body-file", t: "--subject", R: "--repo", d: "--delete-branch",
  m: "--merge", r: "--rebase", s: "--squash", h: "--help" };
// pflag's false spellings for a boolean option given as --flag=value.
const FALSE = new Set(["0", "f", "F", "false", "FALSE", "False"]);
const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
// gh merges at once, without enabling auto-merge, when the pull request is in one of these states.
const MERGEABLE_NOW = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);
const VIEW_FIELDS = "number,url,state,isDraft,mergeStateStatus,baseRefName,headRefOid,statusCheckRollup";
// An Actions job's check run links to its job page; the last number is the check run's id.
const ACTIONS_JOB = /\/actions\/runs\/(\d+)\/job\/(\d+)/;
// GitHub records each Actions job it never started for billing as a failed check run with no
// steps and one annotation, on path .github, whose message starts with this text.
const BILLING = "The job was not started because recent account payments have failed or your spending limit";
// The failed check runs in the head commit's Actions suites, with their steps and annotations.
// 15368 is the github-actions app on github.com; on another host the call finds no suites, so
// failed jobs stay failed. The page sizes keep the call at about 12 GraphQL rate-limit points.
const FAILED_RUNS_QUERY = `query($owner: String!, $name: String!, $oid: GitObjectID!) {
  repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit {
    checkSuites(first: 20, filterBy: {appId: 15368}) { nodes { app { slug }
      checkRuns(first: 30, filterBy: {checkType: ALL, conclusions: [FAILURE]}) { nodes {
        databaseId steps(first: 1) { totalCount } annotations(first: 2) { totalCount nodes { path message } } } } } } } } } }`;
const MERGE_ENDPOINT = /(?:^|\/)pulls\/[^/\s]+\/merge(?:$|[/?#\s])/;
const MERGE_MUTATIONS = /\b(?:mergePullRequest|enablePullRequestAutoMerge)\b/;
// Each gh call gets at most this long, and the hook stops querying once the budget is spent,
// so it refuses before settings.json's 45-second timeout, which would let the command through.
export const CALL_TIMEOUT_MS = 8000;
export const BUDGET_MS = 35000;

// zsh expands these glob characters in any word, the command name too.
const GLOB = /[*?[]/;

class Refusal extends Error {}

/** The options and selector of `gh pr merge args`; `repo` is the -R value given before `merge`, if any. */
export function parseMerge(args, repo) {
  const merge = { admin: false, auto: false, disableAuto: false, help: false, repo, selector: undefined, unresolved: undefined, unknown: undefined };
  const set = (name, value) => {
    if (name === "--repo") merge.repo = value;
    else if (name === "--admin") merge.admin = value;
    else if (name === "--auto") merge.auto = value;
    else if (name === "--disable-auto") merge.disableAuto = value;
    else if (name === "--help") merge.help = value;
  };
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      if (MERGE_VALUE_FLAGS.has(name)) {
        set(name, equals === -1 ? args[++i] : arg.slice(equals + 1));
      } else if (MERGE_FLAGS.has(name)) {
        set(name, equals === -1 || !FALSE.has(arg.slice(equals + 1)));
      } else merge.unknown ??= arg;
    } else if (arg.startsWith("-") && arg.length > 1) {
      for (let k = 1; k < arg.length; k += 1) {
        const name = SHORT_FLAGS[arg[k]];
        if (name === undefined) {
          merge.unknown ??= arg;
          break;
        }
        if (MERGE_VALUE_FLAGS.has(name)) {
          // The value is the rest of the word, after an optional `=`, or else the next word.
          const rest = arg.slice(k + 1).replace(/^=/, "");
          set(name, rest === "" ? args[++i] : rest);
          break;
        }
        set(name, true);
      }
    } else positionals.push(arg);
  }
  merge.selector = positionals[0];
  // Unquoted, a word the shell fills in can become no word or several and shift the others, and
  // the parser has dropped the quotes, so any such word hides what the merge does.
  // A glob in the selector or repository can match a file name and become another value.
  merge.unresolved = args.find(expands) ?? [merge.selector, merge.repo].find((word) => word !== undefined && GLOB.test(word));
  return merge;
}

/** The id of the Actions job that check `check` reports, or undefined for any other check. */
const actionsJob = (check) => (check.__typename === "CheckRun" ? ACTIONS_JOB.exec(check.detailsUrl ?? "")?.[2] : undefined);

/**
 * The checks on the head commit that count. Runs of different workflow runs all count: a later
 * run with the same name, say from pull_request, does not hide a failed one from push. Within one
 * Actions workflow run, which a re-run reuses, only the latest attempt of each job counts.
 */
function latestChecks(rollup) {
  // A re-run attempt that has not started yet has no start time, or GitHub's zero time.
  const started = (check) => (!check.startedAt || check.startedAt.startsWith("0001-") ? "9999" : check.startedAt);
  const latest = new Map();
  for (const check of rollup) {
    const run = check.__typename === "CheckRun" ? ACTIONS_JOB.exec(check.detailsUrl ?? "")?.[1] : undefined;
    const key = run === undefined ? Symbol("check") : `${run}\0${check.workflowName}\0${check.name}`;
    if (!latest.has(key) || started(check) >= started(latest.get(key))) latest.set(key, check);
  }
  return [...latest.values()];
}

/**
 * The checks on the head commit that are still running and those that failed, as display names,
 * and how many of the failed ones are failed Actions jobs. `billingSkipped` holds the ids of
 * failed Actions jobs that GitHub never started for billing. Such a job passes when a non-Actions
 * check named "<context>: <job name>" succeeded, and waits while one is pending; without one it
 * fails. It also fails when a skipped job of another workflow has the same name, because then
 * the guard cannot tell which job the check stands for.
 */
export function classifyChecks(rollup, billingSkipped = new Set()) {
  const pending = [];
  const failed = [];
  let actionsFailed = 0;
  const checks = latestChecks(rollup);
  const isSkipped = (check) => check.status === "COMPLETED" && check.conclusion === "FAILURE" && billingSkipped.has(actionsJob(check));
  const workflowsOf = new Map();
  for (const check of checks.filter(isSkipped)) workflowsOf.set(check.name, (workflowsOf.get(check.name) ?? new Set()).add(check.workflowName));
  for (const check of checks) {
    if (check.__typename === "CheckRun") {
      const name = check.workflowName ? `${check.workflowName} / ${check.name}` : check.name;
      // An in-progress run has conclusion "", so the status decides whether it finished.
      if (check.status !== "COMPLETED") pending.push(name);
      else if (isSkipped(check) && workflowsOf.get(check.name).size > 1) {
        failed.push(`${name} (not started for billing, and a skipped job of another workflow has the same name, so no "<context>: ${check.name}" check can stand for it)`);
      } else if (isSkipped(check)) {
        const fallbacks = checks.filter((other) => actionsJob(other) === undefined && (other.context ?? other.name ?? "").endsWith(`: ${check.name}`));
        const passed = fallbacks.some((other) => other.state === "SUCCESS" || (other.status === "COMPLETED" && other.conclusion === "SUCCESS"));
        // A pending fallback is listed as pending itself.
        const running = fallbacks.some((other) => other.state === "PENDING" || other.state === "EXPECTED" || (other.__typename === "CheckRun" && other.status !== "COMPLETED"));
        if (!passed && !running) failed.push(`${name} (not started for billing, and no passing non-Actions check is named "<context>: ${check.name}")`);
      } else if (!PASSED.has(check.conclusion)) {
        failed.push(`${name} (${check.conclusion || "no conclusion"})`);
        if (check.conclusion === "FAILURE" && actionsJob(check) !== undefined) actionsFailed += 1;
      }
    } else if (check.__typename === "StatusContext") {
      if (check.state === "PENDING" || check.state === "EXPECTED") pending.push(check.context);
      else if (check.state !== "SUCCESS") failed.push(`${check.context} (${check.state})`);
    } else failed.push(`${check.name ?? check.context ?? "a check"} of unknown type ${check.__typename}`);
  }
  return { pending, failed, actionsFailed };
}

const list = (names) => (names.length > 5 ? `${names.slice(0, 5).join(", ")} and ${names.length - 5} more` : names.join(", "));
const firstLine = (text) => (text ?? "").trim().split("\n")[0] || "no output";

/**
 * Runs gh through `run(dir, args, timeoutMs)`, which returns { code, stdout, stderr } and throws
 * when gh could not run or timed out. Returns the parsed JSON, or `missing` on HTTP 404.
 */
function makeQuery(run, deadline) {
  return (dir, args, what, missing) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Refusal(`gh ran out of time to ${what}.`);
    let result;
    try {
      result = run(dir, args, Math.min(CALL_TIMEOUT_MS, left));
    } catch (error) {
      throw new Refusal(`gh could not ${what} (${error.message}).`);
    }
    if (result.code !== 0) {
      if (missing !== undefined && /HTTP 404/.test(result.stderr ?? "")) return missing;
      throw new Refusal(`gh could not ${what} (${firstLine(result.stderr)}).`);
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Refusal(`gh returned output that is not JSON when asked to ${what}.`);
    }
  };
}

/** Whether branch `base` of `repo` (`repos/OWNER/NAME`) requires status checks, through branch protection or a ruleset. */
function requiresChecks(query, dir, api, repo, base) {
  const branch = encodeURIComponent(base);
  const required = query(dir, [...api, `${repo}/branches/${branch}`], "read the base branch's protection", {}).protection?.required_status_checks;
  if (required && required.enforcement_level !== "off" && ((required.contexts ?? []).length > 0 || (required.checks ?? []).length > 0)) return true;
  const rules = query(dir, [...api, `${repo}/rules/branches/${branch}`], "read the base branch's rulesets", []);
  return Array.isArray(rules) && rules.some((rule) => rule.type === "required_status_checks");
}

/**
 * The ids of the failed Actions jobs on the head commit that GitHub never started for billing: a FAILURE
 * check run of the github-actions app with no steps, whose annotations are all the billing one on
 * path .github. A job with steps ran, so its annotation may be its own output. It reads them all
 * in one GraphQL call on commit `oid` of `owner/name`.
 */
function billingSkippedJobs(query, dir, api, owner, name, oid) {
  const answer = query(dir, [...api, "graphql", "-f", `query=${FAILED_RUNS_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `oid=${oid}`],
    "read the failed Actions jobs' steps and annotations");
  const skipped = new Set();
  for (const suite of answer?.data?.repository?.object?.checkSuites?.nodes ?? []) {
    if (suite?.app?.slug !== "github-actions") continue;
    for (const run of suite.checkRuns?.nodes ?? []) {
      const annotations = run?.annotations?.nodes ?? [];
      if (run?.steps?.totalCount === 0 && annotations.length > 0 && annotations.length === run.annotations.totalCount
        && annotations.every((annotation) => annotation?.path === ".github" && annotation.message?.startsWith(BILLING))) skipped.add(String(run.databaseId));
    }
  }
  return skipped;
}

/** Why `gh pr merge` with `merge` run in `dir` must not run, or undefined. */
function judgeMerge(merge, dir, query, { setsHost, setsRepo, setsGitDir, appended }) {
  if (merge.unresolved !== undefined) {
    return `the shell fills in \`${merge.unresolved}\`, so the guard cannot see which pull request it merges or how. Write the pull request, repository and options out literally. `
      + "The guard cannot see quotes, so for a body with `$`, backticks or braces, write it to a file and pass --body-file.";
  }
  if (merge.unknown !== undefined) return `the guard does not know the option \`${merge.unknown}\`, so it cannot tell what this merge does. Use the options \`gh pr merge --help\` lists.`;
  if (merge.help) return undefined;
  if (merge.admin) return "--admin bypasses the repository's merge requirements. Never use it: merge only once the checks pass.";
  if (merge.disableAuto && !merge.auto) return undefined; // it only turns auto-merge off
  if (appended) return "xargs adds arguments the guard cannot see. Write the pull request out literally: `gh pr merge <number>`.";
  if (setsHost) return "the command sets GH_HOST, which the guard does not follow. Name the repository with -R HOST/OWNER/REPO instead.";
  if (setsRepo && merge.repo === undefined) return "the command sets GH_REPO, which the guard does not follow. Name the repository with -R OWNER/REPO instead.";
  if (setsGitDir) return "the command sets GIT_DIR or GIT_WORK_TREE, which change the repository and branch gh reads, and the guard does not follow them. Run the merge without them.";
  if (dir === undefined && merge.repo === undefined && !/^https?:\/\//.test(merge.selector ?? "")) {
    return "the guard cannot tell which directory, and so which repository, it runs in. Run it after a literal `cd`, or pass -R OWNER/REPO and the pull request number.";
  }
  const where = dir ?? process.cwd();
  const view = query(where, ["pr", "view", ...(merge.selector === undefined ? [] : [merge.selector]),
    ...(merge.repo === undefined ? [] : ["--repo", merge.repo]), "--json", VIEW_FIELDS], "read the pull request");
  if (view.state !== "OPEN") return undefined; // gh refuses to merge a closed or merged pull request itself
  const url = new URL(view.url);
  const [owner, name] = url.pathname.split("/").filter(Boolean);
  const api = ["api", "--hostname", url.host];
  const repo = `repos/${owner}/${name}`;
  const pr = `pull request #${view.number}`;
  if (view.isDraft) return `${pr} is a draft. Mark it ready with \`gh pr ready\` only when the work is done and its checks pass.`;
  if (merge.auto && !MERGEABLE_NOW.has(view.mergeStateStatus) && requiresChecks(query, where, api, repo, view.baseRefName)) return undefined;
  if (view.mergeStateStatus === "BEHIND") {
    // The URL names the pull request from any directory, whatever -R or selector the merge used.
    const update = `${pr} is behind ${view.baseRefName}. Update it first (\`gh pr update-branch ${view.url}\`)`;
    // A required check makes GitHub wait, so auto-merge saves re-waiting each time the branch falls behind.
    return !merge.auto && requiresChecks(query, where, api, repo, view.baseRefName)
      ? `${update}, then, in a separate command, rerun this merge with --auto and watch the pull request; GitHub merges it once ${view.baseRefName}'s required checks pass.`
      : `${update}, then wait for its checks to pass.`;
  }
  if (view.mergeStateStatus === "DIRTY") return `${pr} conflicts with ${view.baseRefName}. Resolve the conflicts first, then wait for its checks to pass.`;
  const rollup = view.statusCheckRollup ?? [];
  let checks = classifyChecks(rollup);
  // The GraphQL call costs time and rate-limit points, so it runs only when billing can decide
  // the merge: every failed check is a failed Actions job.
  if (checks.failed.length > 0 && checks.failed.length === checks.actionsFailed) {
    checks = classifyChecks(rollup, billingSkippedJobs(query, where, api, owner, name, view.headRefOid));
  }
  const { pending, failed } = checks;
  if (failed.length > 0) return `checks failed on ${pr}'s head commit: ${list(failed)}. Fix them; merge only once every check passes.`;
  if (pending.length > 0) return `checks are still running on ${pr}'s head commit: ${list(pending)}. Wait until they finish and pass, then merge.`;
  if (rollup.length === 0) {
    const workflows = query(where, [...api, `${repo}/actions/workflows?per_page=100`], "list the repository's workflows", { workflows: [] });
    const active = (workflows.workflows ?? []).filter((workflow) => workflow.state === "active" && workflow.path?.startsWith(".github/workflows/"));
    if (active.length > 0) {
      return `${pr}'s head commit has no checks yet, but the repository has Actions workflows, so CI may not have started. Wait for its checks to appear and pass, then merge.`;
    }
  }
  return undefined;
}

const quoted = (words) => `\`${words.join(" ")}\``;
const unsure = (word) => expands(word) || GLOB.test(word);

/** Whether zsh glob `pattern` (`*`, `?` and `[…]`) can match `name`, ignoring case. A pattern it cannot read counts as a match. */
export function globMatches(pattern, name) {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    const close = c === "[" ? pattern.indexOf("]", i + 2) : -1;
    if (c === "*") source += ".*";
    else if (c === "?") source += ".";
    else if (close !== -1) {
      const set = pattern.slice(i + 1, close).replace(/^[!^]/, "^").replace(/[\\\]]/g, "\\$&");
      source += `[${set}]`;
      i = close;
    } else source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${source}$`, "i").test(name);
  } catch {
    return true;
  }
}

/** Whether the command name `word` runs `program`, or may: the shell fills it in, or a glob can match it. */
const runs = (word, program) => {
  const name = basename(word).toLowerCase();
  return name === program || expands(word) || (GLOB.test(name) && globMatches(name, program));
};

// git subcommands that neither push nor change the branch or remote that gh resolves a pull
// request from. Aliases cannot take these names, so any other subcommand may push.
const GIT_READ_ONLY = new Set(["blame", "cat-file", "describe", "diff", "fetch", "for-each-ref", "grep", "help", "log", "ls-files",
  "ls-remote", "merge-base", "pull", "rev-list", "rev-parse", "shortlog", "show", "show-ref", "status", "version"]);
// gh subcommands that change nothing a merge depends on; `gh api` is checked by its method.
const GH_READ_ONLY = { pr: ["checks", "diff", "list", "status", "view"], run: ["list", "view", "watch"], repo: ["list", "view"],
  issue: ["list", "view"], auth: ["status"] };
const API_FIELDS = /^(?:-[fF]|--field|--raw-field|--input)(?:=|$)|^-[fF]./;

/**
 * Whether `words`, a command other than `gh pr merge`, may push a new head or change which pull
 * request or repository a merge without a selector picks: anything but a read-only git or gh
 * command, and any command whose name the shell fills in.
 */
function mayMoveHead(words) {
  if (expands(words[0])) return true;
  if (runs(words[0], "git")) {
    let i = 1;
    while (i < words.length && words[i].startsWith("-")) i += GIT_VALUE_OPTIONS.has(words[i]) ? 2 : 1;
    return words[i] !== undefined && !GIT_READ_ONLY.has(words[i]);
  }
  if (!runs(words[0], "gh")) return false;
  const { path: [group, subcommand], other } = ghSubcommands(words, 2);
  if (group === undefined) return false;
  if (group === "api") {
    // gh api sends GET unless -X/--method says otherwise or fields make it a POST.
    const index = words.findIndex((word) => /^(?:-X|--method)(?:=|$)|^-X./.test(word));
    const method = index === -1 ? undefined : words[index].replace(/^(?:-X=?|--method=?)/, "") || words[index + 1];
    return method === undefined ? words.some((word) => API_FIELDS.test(word)) : method.toUpperCase() !== "GET";
  }
  return other !== undefined || !(GH_READ_ONLY[group] ?? []).includes(subcommand);
}

/**
 * Checks gh command `words`. Returns why it must not run, or undefined. A `gh pr merge` that
 * passes the checks on its words is added to `merges` with a `check()` that queries GitHub,
 * so the caller can first see the rest of the command.
 */
function ghCommand(words, dir, query, state, merges) {
  const fail = (reason) => `${quoted(words)}: ${reason}`;
  // gh reads options anywhere, so the API check looks at every word, not only after `api`.
  if (words.some((word) => MERGE_ENDPOINT.test(word) || MERGE_MUTATIONS.test(word)) || (words.includes("api") && MERGE_MUTATIONS.test(state.source))) {
    return fail("it merges a pull request through the API, which skips the guard's checks. Use `gh pr merge <number>` instead.");
  }
  const { path: [group, subcommand], next, repo, other } = ghSubcommands(words, 2);
  if (group !== undefined && unsure(group)) return fail(`the shell fills in the gh subcommand \`${group}\`, so the guard cannot see whether it merges.`);
  if (other !== undefined && words.includes("pr") && words.includes("merge")) {
    return fail(`the guard cannot tell how gh reads \`${other}\` before the subcommand. Write options after it: \`gh pr merge <number> --squash -R OWNER/REPO\`.`);
  }
  if (group !== "pr") return undefined;
  if (subcommand !== undefined && unsure(subcommand)) return fail(`the shell fills in the gh pr subcommand \`${subcommand}\`, so the guard cannot see whether it merges.`);
  if (subcommand !== "merge") return undefined;
  if (repo !== undefined && expands(repo)) return fail(`the shell fills in the repository \`${repo}\`. Write it out literally.`);
  merges.push({
    words,
    check: () => {
      try {
        const reason = judgeMerge(parseMerge(words.slice(next), repo), dir, query, state);
        return reason && fail(reason);
      } catch (error) {
        if (error instanceof Refusal) return fail(`${error.message} The guard refuses a merge it cannot check; try again, and if gh keeps failing, report it.`);
        throw error;
      }
    },
  });
  return undefined;
}

/**
 * Returns why `command` run from `cwd` must not run, or undefined when it may. `run(dir, args,
 * timeoutMs)` runs gh in `dir` and returns { code, stdout, stderr }; it throws when gh cannot run
 * or times out. A script nested too deeply to check is refused.
 */
export function findMergeViolation(command, cwd, run, { budgetMs = BUDGET_MS } = {}) {
  const query = makeQuery(run, Date.now() + budgetMs);
  // gh reads GH_REPO and GH_HOST from the environment; the guard does not track their values.
  // GIT_DIR and GIT_WORK_TREE change the repository and branch gh resolves a pull request from.
  const env = { source: command, setsHost: /\bGH_HOST\b/.test(command), setsRepo: /\bGH_REPO\b/.test(command),
    setsGitDir: /\bGIT_(?:DIR|WORK_TREE)\b/.test(command) };
  const merges = [];
  let mover;
  const violation = visitCommands(command, cwd, (words, dir, { appended }) => {
    const before = merges.length;
    // macOS volumes ignore case, so GH and Gh run gh too, and a glob such as [g]h can name it.
    const name = basename(words[0]).toLowerCase();
    let reason;
    if (name === "gh" || (GLOB.test(name) && globMatches(name, "gh"))) reason = ghCommand(words, dir, query, { ...env, appended }, merges);
    else if (expands(words[0]) && ((words.includes("pr") && words.includes("merge")) || words.some((word) => MERGE_ENDPOINT.test(word) || MERGE_MUTATIONS.test(word)))) {
      reason = `${quoted(words)}: the shell fills in the command name \`${words[0]}\`, so the guard cannot see whether it merges a pull request. Run \`gh\` by name.`;
    }
    if (reason === undefined && merges.length === before && mayMoveHead(words)) mover ??= words;
    return reason;
  }, TOO_DEEP);
  if (violation || merges.length === 0) return violation;
  // The hook runs once, before the whole command, so it checks every merge before any of it runs.
  if (merges.length > 1) {
    return `${quoted(merges[1].words)}: the same command runs another \`gh pr merge\`, and the first merge can change what the second one merges. `
      + "Merge each pull request in its own Bash call.";
  }
  if (mover !== undefined) {
    return `${quoted(merges[0].words)}: the same command also runs ${quoted(mover)}, which may push a new head or change which pull request gh merges. `
      + "The guard checks the pull request once, before the whole command runs, so it would read one head's checks and merge another. "
      + "Run that command in its own Bash call, wait for the head's checks to pass, then merge in a separate call.";
  }
  return merges[0].check();
}

export function runGh(dir, args, timeout) {
  const result = spawnSync("gh", args, {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`gh was stopped by ${result.signal}, after the ${timeout} ms limit`);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

if (import.meta.main) {
  let violation;
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const command = input?.tool_input?.command;
    // A cheap prefilter. Without quotes and backslashes, m"erge" and m\erge read as merge; a
    // command the shell fills in has $ or `, and one that a glob names, as in [g]h, has * ? or [;
    // the parser refuses them when it reaches gh.
    if (typeof command === "string" && /merge|gh|[$`*?[]/i.test(command.replace(/["'\\]/g, ""))) {
      violation = findMergeViolation(command, typeof input.cwd === "string" ? input.cwd : process.cwd(), runGh);
    }
  } catch (error) {
    // A crash would be a non-blocking hook error and let the merge through, so it blocks instead.
    violation = `the guard failed (${error.message}), so it cannot check this command.`;
  }
  if (violation) {
    process.stderr.write(`Blocked by the guard-pr-merge hook: ${violation}\n`);
    process.exit(2);
  }
}
