// Claude Code PreToolUse hook for the Bash tool. Enforces the merge rule in ~/.claude/CLAUDE.md's
// Autonomy section: agents merge their pull requests only once the checks pass. Before a
// `gh pr merge` runs, it reads the pull request with `gh pr view` and refuses --admin, a draft,
// a branch that is BEHIND its base or DIRTY with conflicts, and a head commit with a pending or
// failed check, or with no check yet from CI that runs on every pull request: an Actions workflow
// whose pull_request trigger, at the head commit, or pull_request_target trigger, on the base
// branch, has no branch, path or type filter, and CircleCI where .circleci/config.yml exists at
// the head commit unless every workflow is statically gated off under its default parameters;
// one GraphQL call reads those files. A workflow with a filtered trigger is not
// expected, so its check can still arrive after the merge. A workflow that Actions lists as
// disabled is not expected either. --auto
// passes when the base branch requires status checks and gh will enable auto-merge rather than
// merge at once, because GitHub then waits for the required checks; otherwise it is checked like
// a direct merge. It also refuses `gh api` calls to the pulls/<n>/merge endpoint and the
// mergePullRequest and enablePullRequestAutoMerge mutations, which skip these checks. shell.js
// follows the shell syntax around the command, so `cd`, `sh -c`, wrappers, substitutions and
// `ssh` are seen; any merge argument the shell fills in, arguments xargs adds, options before
// `merge` other than -R, a command that sets GH_HOST, and one that sets GH_REPO without a literal
// -R are refused, as are GIT_DIR, GIT_WORK_TREE and a glob in the command name, selector or
// subcommand. The hook runs once before the whole command, so it refuses a second merge in the
// same command and piped or backgrounded forms with a non-read-only git or gh command. A
// non-read-only git or gh command strictly after a single top-level merge in a sequential list
// (`&&`, `;`, `||`, or newline) passes, because it cannot change what was checked; a merge inside
// a loop, function body, group, subshell, or nested script still refuses movers. Before a merge
// that names its pull request by number or URL and pins --match-head-commit, only an allowlist of
// commands whose effect the head pin catches passes (`git add`, `git commit`, `git push`,
// `gh pr update-branch`, and `gh pr edit` without `--base`/`-B`); any other non-read-only git or
// gh command (such as `gh pr edit --base`, `gh api` writes, `gh repo edit`, `gh pr create`,
// `gh pr checkout`, `git switch`, `git remote`, `git config`, or `gh repo set-default`), and any
// mover before an unpinned or selector-less merge, stays refused. Within one Actions workflow run only the latest
// attempt of each job counts, so a passing re-run replaces a failed attempt. A failed Actions job
// that GitHub never started for billing, with no steps, the billing annotation and at most
// GitHub's notices besides, counts as passed when a passing non-Actions check is named
// "<context>: <job name>", such as "ci/circleci: build"; one GraphQL call reads those jobs'
// steps and annotations, and only when every failed check is a failed Actions job. A merge it
// checks like a direct merge must pin the head commit it judged with --match-head-commit, so
// GitHub refuses the merge if the head moves after the check; the refusal names the SHA and the
// command to rerun. A pin that is not the head is refused for every merge. It fails closed:
// a gh query that fails or times out, a workflow file that does not parse, an unknown merge
// option and a crash all block the merge (exit 2, with the reason on stderr). It cannot see gh aliases,
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
// steps and one failure-level annotation, on path .github, whose message starts with this text.
// GitHub may add notice-level annotations on .github, such as a runner label's migration notice.
const BILLING = "The job was not started because recent account payments have failed or your spending limit";
// The failed check runs in the head commit's Actions suites, with their steps and annotations.
// 15368 is the github-actions app on github.com; on another host the call finds no suites, so
// failed jobs stay failed. The page sizes keep the call at about 12 GraphQL rate-limit points.
const FAILED_RUNS_QUERY = `query($owner: String!, $name: String!, $oid: GitObjectID!) {
  repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit {
    checkSuites(first: 20, filterBy: {appId: 15368}) { nodes { app { slug }
      checkRuns(first: 30, filterBy: {checkType: ALL, conclusions: [FAILURE]}) { nodes {
        databaseId steps(first: 1) { totalCount } annotations(first: 10) { totalCount nodes { path message annotationLevel } } } } } } } } } }`;
// The CI configuration: each file in .github/workflows, with its text, at the head commit and on
// the base branch, which pull_request_target runs its workflows from, and .circleci/config.yml
// at the head commit with its text. `head` confirms the commit was found.
const WORKFLOW_DIR = ".github/workflows";
const CIRCLECI_CONFIG = ".circleci/config.yml";
const WORKFLOW_FILES = "... on Tree { entries { name type object { ... on Blob { text isTruncated } } } }";
const CI_FILES_QUERY = `query($owner: String!, $name: String!, $oid: GitObjectID!, $workflows: String!, $baseWorkflows: String!, $circleci: String!) {
  repository(owner: $owner, name: $name) { head: object(oid: $oid) { oid }
    workflows: object(expression: $workflows) { ${WORKFLOW_FILES} }
    baseWorkflows: object(expression: $baseWorkflows) { ${WORKFLOW_FILES} }
    circleci: object(expression: $circleci) { ... on Blob { text isTruncated } } } }`;
const PR_EVENTS = ["pull_request", "pull_request_target"];
// CircleCI reports a commit status named ci/circleci: <job>, or, through its GitHub App, check
// runs that link to its site.
const CIRCLECI_RUN = /^https:\/\/(?:[\w-]+\.)*circleci\.com\//;
const CIRCLECI_PARAM = /^<<\s*pipeline\.parameters\.([A-Za-z0-9_-]+)\s*>>$/;
const MAX_CIRCLECI_WHEN_DEPTH = 20;
// A workflow with one of these under its pull request trigger may not run on a given pull
// request; the guard does not evaluate them, so it does not expect a check from it.
const PR_FILTERS = ["paths", "paths-ignore", "branches", "branches-ignore", "types"];
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
  const merge = { admin: false, auto: false, disableAuto: false, help: false, repo, matchHead: undefined, selector: undefined, selectorIndex: undefined, unresolved: undefined, unknown: undefined };
  const set = (name, value) => {
    if (name === "--repo") merge.repo = value;
    else if (name === "--match-head-commit") merge.matchHead = value;
    else if (name === "--admin") merge.admin = value;
    else if (name === "--auto") merge.auto = value;
    else if (name === "--disable-auto") merge.disableAuto = value;
    else if (name === "--help") merge.help = value;
  };
  // The index in `args` of each positional word.
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      for (let k = i + 1; k < args.length; k += 1) positionals.push(k);
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
    } else positionals.push(i);
  }
  merge.selectorIndex = positionals[0];
  merge.selector = args[merge.selectorIndex];
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
 * check run of the github-actions app with no steps and all its annotations on path .github: exactly
 * one failure-level billing annotation, and only notices besides. A job with steps ran, so its
 * annotations may be its own output. A job with more annotations than the call read fails.
 * It reads them all in one GraphQL call on commit `oid` of `owner/name`.
 */
function billingSkippedJobs(query, dir, api, owner, name, oid) {
  const answer = query(dir, [...api, "graphql", "-f", `query=${FAILED_RUNS_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `oid=${oid}`],
    "read the failed Actions jobs' steps and annotations");
  const skipped = new Set();
  for (const suite of answer?.data?.repository?.object?.checkSuites?.nodes ?? []) {
    if (suite?.app?.slug !== "github-actions") continue;
    for (const run of suite.checkRuns?.nodes ?? []) {
      const annotations = run?.annotations?.nodes ?? [];
      if (run?.steps?.totalCount !== 0 || annotations.length !== run.annotations.totalCount
        || !annotations.every((annotation) => annotation?.path === ".github")) continue;
      const billing = annotations.filter((annotation) => annotation.annotationLevel === "FAILURE" && annotation.message?.startsWith(BILLING));
      if (billing.length === 1 && annotations.every((annotation) => annotation === billing[0] || annotation.annotationLevel === "NOTICE")) {
        skipped.add(String(run.databaseId));
      }
    }
  }
  return skipped;
}

/**
 * Whether a workflow's `on:` value runs it on every pull request through one of `events`:
 * pull_request or pull_request_target with no branch, path or type filter, in string, list or
 * map form.
 */
export function runsOnEveryPullRequest(on, events = PR_EVENTS) {
  if (typeof on === "string") return events.includes(on);
  if (Array.isArray(on)) return on.some((event) => events.includes(event));
  if (on === null || typeof on !== "object") return false;
  return events.some((event) => {
    if (!Object.hasOwn(on, event)) return false;
    const filters = on[event];
    return filters === null || (typeof filters === "object" && !Array.isArray(filters) && !PR_FILTERS.some((filter) => Object.hasOwn(filters, filter)));
  });
}

/**
 * The workflows of `tree`, a .github/workflows tree read by CI_FILES_QUERY at `where`, as
 * { path, workflow }. GitHub runs only the YAML files directly in it. A file whose text gh
 * could not read, or that does not parse as a YAML mapping, refuses the merge.
 */
function readWorkflows(tree, where) {
  const workflows = [];
  for (const entry of tree?.entries ?? []) {
    if (entry?.type !== "blob" || !/\.ya?ml$/.test(entry.name)) continue;
    const path = `${WORKFLOW_DIR}/${entry.name}`;
    const text = entry.object?.text;
    if (typeof text !== "string" || entry.object.isTruncated) throw new Refusal(`gh could not read the text of ${path} ${where}.`);
    let workflow;
    try {
      workflow = Bun.YAML.parse(text);
    } catch (error) {
      throw new Refusal(`${path} ${where} does not parse as YAML (${firstLine(error.message)}), so the guard cannot tell whether it runs on pull requests.`);
    }
    if (workflow === null || typeof workflow !== "object" || Array.isArray(workflow)) {
      throw new Refusal(`${path} ${where} is not a YAML mapping, so the guard cannot tell whether it runs on pull requests.`);
    }
    workflows.push({ path, workflow });
  }
  return workflows;
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Maps each declared CircleCI pipeline parameter with a typed default value to that default.
 * Returns null if `parameters` is present but not a YAML mapping.
 */
function circleCiParameterDefaults(parameters) {
  const defaults = new Map();
  if (parameters === undefined || parameters === null) return defaults;
  if (!isPlainObject(parameters)) return null;
  for (const [name, spec] of Object.entries(parameters)) {
    if (!isPlainObject(spec) || !Object.hasOwn(spec, "default")) continue;
    const { type, default: value } = spec;
    if (type === "boolean" && typeof value === "boolean") defaults.set(name, value);
    else if (type === "string" && typeof value === "string") defaults.set(name, value);
    else if (type === "integer" && typeof value === "number" && Number.isInteger(value)) defaults.set(name, value);
    else if (type === "enum" && typeof value === "string" && Array.isArray(spec.enum) && spec.enum.includes(value)) defaults.set(name, value);
  }
  return defaults;
}

/** Resolves a static scalar or declared `<< pipeline.parameters.<name> >>` reference, else undefined. */
function resolveCircleCiValue(value, defaults) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const match = CIRCLECI_PARAM.exec(value);
    if (match) return defaults.has(match[1]) ? defaults.get(match[1]) : undefined;
    if (value.includes("<<") || value.includes(">>")) return undefined;
    return value;
  }
  return undefined;
}

/**
 * Evaluates a CircleCI 2.1 workflow `when`/`unless` logic statement under default pipeline
 * parameters using three-valued logic: returns true, false, or undefined when indeterminate.
 */
function evalCircleCiCondition(expr, defaults, depth = 0) {
  if (depth > MAX_CIRCLECI_WHEN_DEPTH) return undefined;
  if (typeof expr === "boolean") return expr;
  if (typeof expr === "string") {
    const match = CIRCLECI_PARAM.exec(expr);
    if (!match) return undefined;
    const value = defaults.get(match[1]);
    return typeof value === "boolean" ? value : undefined;
  }
  if (!isPlainObject(expr)) return undefined;
  const keys = Object.keys(expr);
  if (keys.length !== 1) return undefined;
  const [key] = keys;
  const operand = expr[key];
  if (key === "not") {
    const value = evalCircleCiCondition(operand, defaults, depth + 1);
    return value === undefined ? undefined : !value;
  }
  if (key === "and") {
    if (!Array.isArray(operand) || operand.length === 0) return undefined;
    let hasUnknown = false;
    for (const item of operand) {
      const value = evalCircleCiCondition(item, defaults, depth + 1);
      if (value === false) return false;
      if (value === undefined) hasUnknown = true;
    }
    return hasUnknown ? undefined : true;
  }
  if (key === "or") {
    if (!Array.isArray(operand) || operand.length === 0) return undefined;
    let hasUnknown = false;
    for (const item of operand) {
      const value = evalCircleCiCondition(item, defaults, depth + 1);
      if (value === true) return true;
      if (value === undefined) hasUnknown = true;
    }
    return hasUnknown ? undefined : false;
  }
  if (key === "equal") {
    if (!Array.isArray(operand) || operand.length < 2) return undefined;
    let first;
    let hasUnknown = false;
    for (const item of operand) {
      const resolved = resolveCircleCiValue(item, defaults);
      if (resolved === undefined) hasUnknown = true;
      else if (first === undefined) first = resolved;
      else if (resolved !== first) return false;
    }
    return hasUnknown ? undefined : true;
  }
  return undefined;
}

/**
 * Whether a .circleci/config.yml blob (`{ text, isTruncated }`) can run a workflow on ordinary
 * pull requests under its declared default pipeline parameters. Returns false only when the file
 * is absent, or when it parses as a YAML mapping with at least one workflow and every workflow is
 * statically gated off (`when` evaluates to false or `unless` evaluates to true). Fails closed
 * (returns true) when truncated, unreadable, invalid YAML, legacy v2.0 without `workflows`, or
 * when any workflow is ungated or indeterminate.
 */
export function circleciRunsOnPullRequests(blob) {
  if (!blob) return false;
  if (typeof blob.text !== "string" || blob.isTruncated) return true;
  let config;
  try {
    config = Bun.YAML.parse(blob.text);
  } catch {
    return true;
  }
  if (!isPlainObject(config) || !isPlainObject(config.workflows)) return true;
  const defaults = circleCiParameterDefaults(config.parameters);
  if (defaults === null) return true;
  const workflows = Object.entries(config.workflows).filter(([name, value]) => !(name === "version" && !isPlainObject(value)));
  if (workflows.length === 0) return true;
  for (const [, workflow] of workflows) {
    if (!isPlainObject(workflow)) return true;
    const hasWhen = Object.hasOwn(workflow, "when");
    const hasUnless = Object.hasOwn(workflow, "unless");
    if (hasWhen === hasUnless) return true;
    if (hasWhen && evalCircleCiCondition(workflow.when, defaults) !== false) return true;
    if (hasUnless && evalCircleCiCondition(workflow.unless, defaults) !== true) return true;
  }
  return false;
}

/**
 * The CI the head commit `oid` should have a check from, but has none in `rollup`: each Actions
 * workflow that runs on every pull request, from the head commit for pull_request and from base
 * branch `base` for pull_request_target, and CircleCI, when .circleci/config.yml exists at the
 * head commit and can run a workflow under its default parameters. A workflow is named by its
 * `name:`, else its path; where several expected workflows share a name, each needs its own
 * workflow run. One GraphQL call reads the files. Only when a workflow is missing, a REST call
 * reads the workflows' states, so one that is disabled in Actions is not expected.
 */
function missingCi(query, dir, api, repo, owner, name, oid, base, rollup) {
  const answer = query(dir, [...api, "graphql", "-f", `query=${CI_FILES_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`,
    "-f", `oid=${oid}`, "-f", `workflows=${oid}:${WORKFLOW_DIR}`, "-f", `baseWorkflows=${base}:${WORKFLOW_DIR}`,
    "-f", `circleci=${oid}:${CIRCLECI_CONFIG}`], "read the CI configuration");
  const repository = answer?.data?.repository;
  // Without the commit, the files read as absent, and nothing would be expected.
  if (repository?.head?.oid !== oid) throw new Refusal(`gh could not find the head commit ${oid} to read its CI configuration.`);
  const expect = (workflows, event) => workflows.filter(({ workflow }) => runsOnEveryPullRequest(workflow.on, [event]))
    .map(({ path, workflow }) => ({ path, name: typeof workflow.name === "string" && workflow.name !== "" ? workflow.name : path }));
  const expected = [...expect(readWorkflows(repository.workflows, "at the head commit"), "pull_request"),
    ...expect(readWorkflows(repository.baseWorkflows, `on ${base}`), "pull_request_target")];
  // The workflow runs that reported a check run, by workflow name.
  const runs = new Map();
  for (const check of rollup.filter((check) => check.__typename === "CheckRun" && check.workflowName)) {
    const run = ACTIONS_JOB.exec(check.detailsUrl ?? "")?.[1] ?? check.detailsUrl ?? Symbol("run");
    runs.set(check.workflowName, (runs.get(check.workflowName) ?? new Set()).add(run));
  }
  const missingNames = (workflows) => {
    const wanted = Map.groupBy(workflows, (workflow) => workflow.name);
    return [...wanted].filter(([workflowName, list]) => (runs.get(workflowName)?.size ?? 0) < list.length).map(([workflowName]) => workflowName);
  };
  let missing = missingNames(expected);
  if (missing.length > 0) {
    const listed = query(dir, [...api, `${repo}/actions/workflows?per_page=100`], "list the repository's workflows", { workflows: [] });
    const disabled = new Set((listed.workflows ?? []).filter((workflow) => workflow.state !== "active").map((workflow) => workflow.path));
    missing = missingNames(expected.filter((workflow) => !disabled.has(workflow.path)));
  }
  const names = missing.map((workflowName) => `workflow "${workflowName}"`);
  const circleci = (check) => (check.__typename === "StatusContext" && check.context?.startsWith("ci/circleci"))
    || (check.__typename === "CheckRun" && CIRCLECI_RUN.test(check.detailsUrl ?? ""));
  if (repository.circleci && !rollup.some(circleci) && circleciRunsOnPullRequests(repository.circleci)) names.push("CircleCI");
  return names;
}

/**
 * Core GitHub verification shared by `gh pr merge` (Bash) and T3's `pull_request_merge` (MCP).
 * Returns why the merge must not run, or undefined.
 */
function judgePullRequest({ selector, repo: repoFlag, auto, matchHead, formatStalePin, formatMissingPin, formatBehind }, where, query) {
  const view = query(where, ["pr", "view", ...(selector === undefined ? [] : [selector]),
    ...(repoFlag === undefined ? [] : ["--repo", repoFlag]), "--json", VIEW_FIELDS], "read the pull request");
  if (view.state !== "OPEN") return undefined; // gh refuses to merge a closed or merged pull request itself
  const url = new URL(view.url);
  const [owner, name] = url.pathname.split("/").filter(Boolean);
  const api = ["api", "--hostname", url.host];
  const repo = `repos/${owner}/${name}`;
  const pr = `pull request #${view.number}`;
  // The rollup is the checks of this commit, read in the same query.
  const head = view.headRefOid;
  if (matchHead !== undefined && matchHead !== head) {
    return formatStalePin(pr, head, view.url);
  }
  if (view.isDraft) return `${pr} is a draft. Mark it ready with \`gh pr ready\` only when the work is done and its checks pass.`;
  if (auto && !MERGEABLE_NOW.has(view.mergeStateStatus) && requiresChecks(query, where, api, repo, view.baseRefName)) return undefined;
  if (view.mergeStateStatus === "BEHIND") {
    // A required check makes GitHub wait, so auto-merge saves re-waiting each time the branch falls behind.
    return formatBehind(pr, view.baseRefName, view.url, !auto && requiresChecks(query, where, api, repo, view.baseRefName));
  }
  if (view.mergeStateStatus === "DIRTY") return `${pr} conflicts with ${view.baseRefName}. Resolve the conflicts first, then wait for its checks to pass.`;
  const rollup = view.statusCheckRollup ?? [];
  let checks = classifyChecks(rollup);
  // The GraphQL call costs time and rate-limit points, so it runs only when billing can decide
  // the merge: every failed check is a failed Actions job.
  if (checks.failed.length > 0 && checks.failed.length === checks.actionsFailed) {
    checks = classifyChecks(rollup, billingSkippedJobs(query, where, api, owner, name, head));
  }
  const { pending, failed } = checks;
  if (failed.length > 0) return `checks failed on ${pr}'s head commit: ${list(failed)}. Fix them; merge only once every check passes.`;
  if (pending.length > 0) return `checks are still running on ${pr}'s head commit: ${list(pending)}. Wait until they finish and pass, then merge.`;
  const missing = missingCi(query, where, api, repo, owner, name, head, view.baseRefName, rollup);
  if (missing.length > 0) {
    return `${pr}'s head commit has no check yet from ${list(missing)}, which run on every pull request, so CI may not have started. Wait for their checks to appear and pass, then merge.`;
  }
  // GitHub refuses a merge whose --match-head-commit / expectedHeadSha is not the head, so a
  // commit pushed after this check cannot merge on the checks of the one before.
  if (matchHead === undefined) {
    return formatMissingPin(pr, head, view.url);
  }
  return undefined;
}

/** Why `gh pr merge` with `merge` run in `dir` must not run, or undefined. */
function judgeMerge(merge, words, next, dir, query, { setsHost, setsRepo, setsGitDir, remote }) {
  if (merge.unresolved !== undefined) {
    return `the shell fills in \`${merge.unresolved}\`, so the guard cannot see which pull request it merges or how. Write the pull request, repository and options out literally. `
      + "The guard cannot see quotes, so for a body with `$`, backticks or braces, write it to a file and pass --body-file.";
  }
  if (merge.unknown !== undefined) return `the guard does not know the option \`${merge.unknown}\`, so it cannot tell what this merge does. Use the options \`gh pr merge --help\` lists.`;
  if (merge.help) return undefined;
  if (merge.admin) return "--admin bypasses the repository's merge requirements. Never use it: merge only once the checks pass.";
  if (merge.disableAuto && !merge.auto) return undefined; // it only turns auto-merge off
  if (setsHost) return "the command sets GH_HOST, which the guard does not follow. Name the repository with -R HOST/OWNER/REPO instead.";
  if (setsRepo && merge.repo === undefined) return "the command sets GH_REPO, which the guard does not follow. Name the repository with -R OWNER/REPO instead.";
  if (setsGitDir) return "the command sets GIT_DIR or GIT_WORK_TREE, which change the repository and branch gh reads, and the guard does not follow them. Run the merge without them.";
  if (dir === undefined && merge.repo === undefined && !/^https?:\/\//.test(merge.selector ?? "")) {
    if (remote) {
      return "it runs on another host over ssh, whose directory, and so repository, the guard cannot read. "
        + "Pass -R OWNER/REPO and the pull request number, or the pull request's URL.";
    }
    return "the guard cannot tell which directory, and so which repository, it runs in. Run it after a literal `cd`, or pass -R OWNER/REPO and the pull request number.";
  }
  const where = dir ?? process.cwd();
  return judgePullRequest(
    {
      selector: merge.selector,
      repo: merge.repo,
      auto: merge.auto,
      matchHead: merge.matchHead,
      formatStalePin: (pr, head, url) =>
        `--match-head-commit ${merge.matchHead} is not ${pr}'s head commit ${head}. Wait for that commit's checks to pass, then rerun with it: ${rerun(words, next, merge, url, head)}.`,
      formatMissingPin: (pr, head, url) =>
        `the checks passed on ${pr}'s head commit ${head}. Pin the merge to that commit, so GitHub refuses it if the head moves: ${rerun(words, next, merge, url, head)}.`,
      formatBehind: (pr, base, url, suggestAuto) => {
        // The URL names the pull request from any directory, whatever -R or selector the merge used.
        const update = `${pr} is behind ${base}. Update it first (\`gh pr update-branch ${url}\`)`;
        return suggestAuto
          ? `${update}, then, in a separate command, rerun this merge with --auto and watch the pull request; GitHub merges it once ${base}'s required checks pass.`
          : `${update}, then wait for its checks to pass.`;
      },
    },
    where,
    query,
  );
}

/**
 * `gh pr merge` command `words`, whose arguments start at `next`, quoted to rerun from any directory:
 * pull request `url` and `--match-head-commit sha` right after `merge`, in place of `merge`'s
 * selector and any pin. A `cd`, `ssh` or the current branch may have chosen the pull request; the URL names it alone.
 */
function rerun(words, next, merge, url, sha) {
  const shell = (word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);
  const kept = [...words.slice(0, next).map(shell), url, "--match-head-commit", sha];
  for (let i = next; i < words.length; i += 1) {
    if (words[i] === "--match-head-commit") i += 1;
    else if (i !== next + merge.selectorIndex && !words[i].startsWith("--match-head-commit=")) kept.push(shell(words[i]));
  }
  return `\`${kept.join(" ")}\``;
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
// Pull request selectors that name a specific pull request rather than the current or a named branch.
const PR_NUMBER = /^[1-9]\d*$/;
const PR_URL = /^https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/[1-9]\d*(?:[/?#]|$)/;
// Pre-merge allowlist: git and gh commands whose effect on the pull request is caught by
// `--match-head-commit` (or harmless PR metadata edits) and that cannot change the PR base branch
// or which repository `gh` resolves.
const PRE_MERGE_GIT = new Set(["add", "commit", "push"]);
const GH_PR_UPDATE_BRANCH_FLAGS = new Set(["--rebase", "--help"]);
const GH_PR_UPDATE_BRANCH_VALUE_FLAGS = new Set(["--repo"]);
const GH_PR_UPDATE_BRANCH_SHORT_VALUE_FLAGS = new Set(["R"]);
// `gh pr edit --help` flags excluding `-B`/`--base`, which changes the base branch and is not caught by the head pin.
const GH_PR_EDIT_FLAGS = new Set(["--remove-milestone", "--help"]);
const GH_PR_EDIT_VALUE_FLAGS = new Set(["--add-assignee", "--add-label", "--add-project", "--add-reviewer", "--attach",
  "--body", "--body-file", "--milestone", "--remove-assignee", "--remove-label", "--remove-project", "--remove-reviewer",
  "--title", "--repo"]);
const GH_PR_EDIT_SHORT_VALUE_FLAGS = new Set(["b", "F", "m", "t", "R"]);

/**
 * Whether `words`, a command other than `gh pr merge`, may push a new head or change which pull
 * request or repository a merge without a selector picks: anything but a read-only git or gh
 * command, and any command whose name the shell fills in.
 */
function mayMoveHead(words, appended) {
  if (expands(words[0])) return true;
  if (runs(words[0], "git")) {
    let i = 1;
    while (i < words.length && words[i].startsWith("-")) i += GIT_VALUE_OPTIONS.has(words[i]) ? 2 : 1;
    // xargs may add the subcommand itself.
    return words[i] === undefined ? appended : !GIT_READ_ONLY.has(words[i]);
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

/** Whether `args` for a `gh pr` subcommand use only allowed literal flags and have no shell expansions. */
function hasOnlyAllowedGhFlags(args, boolFlags, valueFlags, shortValueFlags) {
  if (args.some(expands)) return false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      if (valueFlags.has(name)) {
        if (equals === -1) i += 1;
      } else if (!boolFlags.has(name)) return false;
    } else if (arg.startsWith("-") && arg.length > 1) {
      for (let k = 1; k < arg.length; k += 1) {
        if (shortValueFlags.has(arg[k])) {
          // pflag attaches any remaining characters (including `=`) as this flag's value,
          // so only a bare short flag at the end of the word consumes the next argument.
          if (k + 1 === arg.length) i += 1;
          break;
        }
        return false;
      }
    }
  }
  return true;
}

/**
 * Whether `words` is in the strict pre-merge allowlist: a command whose effect on the pull request
 * is caught by `--match-head-commit` (or harmless PR metadata edits) and that cannot change the
 * base branch or which repository `gh` resolves. Any xargs-appended, globbed, or shell-filled
 * command stays refused.
 */
function isPreMergeAllowed(words, appended) {
  if (appended || words.length === 0 || unsure(words[0])) return false;
  const name = basename(words[0]).toLowerCase();
  if (name === "git") {
    let i = 1;
    while (i < words.length && words[i].startsWith("-")) {
      if (words[i] === "--" || expands(words[i])) return false;
      if (GIT_VALUE_OPTIONS.has(words[i])) {
        if (words[i + 1] === undefined || expands(words[i + 1])) return false;
        i += 2;
      } else i += 1;
    }
    return words[i] !== undefined && PRE_MERGE_GIT.has(words[i]);
  }
  if (name !== "gh") return false;
  const { path: [group, subcommand], next, repo, other } = ghSubcommands(words, 2);
  if (other !== undefined || group !== "pr" || (repo !== undefined && expands(repo))) return false;
  const args = words.slice(next);
  if (subcommand === "update-branch") {
    return hasOnlyAllowedGhFlags(args, GH_PR_UPDATE_BRANCH_FLAGS, GH_PR_UPDATE_BRANCH_VALUE_FLAGS, GH_PR_UPDATE_BRANCH_SHORT_VALUE_FLAGS);
  }
  if (subcommand === "edit") {
    return hasOnlyAllowedGhFlags(args, GH_PR_EDIT_FLAGS, GH_PR_EDIT_VALUE_FLAGS, GH_PR_EDIT_SHORT_VALUE_FLAGS);
  }
  return false;
}

/** Whether parsed `merge` names its pull request by number or URL and literally pins --match-head-commit. */
function isPinnedExplicitMerge(merge) {
  return merge.unresolved === undefined
    && merge.unknown === undefined
    && typeof merge.matchHead === "string" && merge.matchHead !== ""
    && typeof merge.selector === "string" && (PR_NUMBER.test(merge.selector) || PR_URL.test(merge.selector));
}

/**
 * Checks gh command `words`. Returns why it must not run, or undefined. A `gh pr merge` that
 * passes the checks on its words is added to `merges` with a `check()` that queries GitHub,
 * so the caller can first see the rest of the command.
 */
function ghCommand(words, dir, query, state, merges, context) {
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
  const merge = parseMerge(words.slice(next), repo);
  merges.push({
    words,
    merge,
    ...context,
    check: () => {
      try {
        const reason = judgeMerge(merge, words, next, dir, query, state);
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
  const movers = [];
  const violation = visitCommands(command, cwd, (words, dir, { appended, opaque, remote, topLevel, piped, background }) => {
    if (opaque) {
      return `${quoted(words)}: xargs runs the words it reads as a command or script the guard cannot see, so it may merge a pull request. `
        + "Write the command out literally.";
    }
    const before = merges.length;
    // macOS volumes ignore case, so GH and Gh run gh too, and a glob such as [g]h can name it.
    const name = basename(words[0]).toLowerCase();
    const isGh = name === "gh" || (GLOB.test(name) && globMatches(name, "gh"));
    // The words xargs adds can be the subcommand, the pull request or any option, such as --admin;
    // after a read-only subcommand they only change what it reads.
    if (isGh && appended) {
      const { path: [group, subcommand], other } = ghSubcommands(words, 2);
      if (other !== undefined || !(GH_READ_ONLY[group] ?? []).includes(subcommand)) {
        return `${quoted(words)}: xargs adds arguments the guard cannot see, so it cannot tell whether this gh command merges a pull request. `
          + "Write the gh command out literally, such as `gh pr merge <number>`.";
      }
    }
    let reason;
    if (isGh) reason = ghCommand(words, dir, query, { ...env, remote }, merges, { topLevel, piped, background });
    else if (expands(words[0]) && ((words.includes("pr") && words.includes("merge")) || words.some((word) => MERGE_ENDPOINT.test(word) || MERGE_MUTATIONS.test(word)))) {
      reason = `${quoted(words)}: the shell fills in the command name \`${words[0]}\`, so the guard cannot see whether it merges a pull request. Run \`gh\` by name.`;
    }
    if (reason === undefined && merges.length === before && mayMoveHead(words, appended)) {
      movers.push({ words, appended, piped, background, afterMerge: merges.length > 0 });
    }
    return reason;
  }, TOO_DEEP);
  if (violation || merges.length === 0) return violation;
  // The hook runs once, before the whole command, so it checks every merge before any of it runs.
  if (merges.length > 1) {
    return `${quoted(merges[1].words)}: the same command runs another \`gh pr merge\`, and the first merge can change what the second one merges. `
      + "Merge each pull request in its own Bash call.";
  }
  const [entry] = merges;
  const pinnedExplicit = isPinnedExplicitMerge(entry.merge);
  for (const mover of movers) {
    if (entry.piped || entry.background || mover.piped || mover.background) {
      return `${quoted(entry.words)}: the same command also runs ${quoted(mover.words)} in a pipeline or background job, which may push a new head or change which pull request gh merges. `
        + "Run that command in its own Bash call, or chain it sequentially in an `&&` or `;` list.";
    }
    if (mover.afterMerge) {
      if (entry.topLevel) continue;
      return `${quoted(entry.words)}: the same command also runs ${quoted(mover.words)} while the merge is inside a loop, function or group whose run order the guard cannot verify, so it may push a new head or change which pull request gh merges. `
        + "Run that command in its own Bash call, or chain it after a top-level merge in an `&&` or `;` list.";
    }
    if (pinnedExplicit && isPreMergeAllowed(mover.words, mover.appended)) continue;
    return `${quoted(entry.words)}: the same command also runs ${quoted(mover.words)}, which may push a new head or change which pull request gh merges. `
      + "The guard checks the pull request once, before the whole command runs, so it would read one head's checks and merge another. "
      + "Run that command in its own Bash call, wait for the head's checks to pass, then merge in a separate call.";
  }
  return entry.check();
}

const MCP_MERGE_TOOLS = new Set(["mcp__t3-code__pull_request_merge", "mcp_t3-code_pull_request_merge"]);
const MCP_REPO = /^(?:[^/\s]+\/)?[^/\s]+\/[^/\s]+$/;

/**
 * Returns why a T3 MCP `pull_request_merge` call with `toolInput` from `cwd` must not run, or
 * undefined when it may. Reuses the exact same GitHub check, billing-skipped CircleCI fallback,
 * missing-CI, draft, behind/dirty, and head-pin verification as `findMergeViolation`.
 */
export function findMcpMergeViolation(toolInput, cwd, run, { budgetMs = BUDGET_MS } = {}) {
  const fail = (reason) => `pull_request_merge: ${reason}`;
  if (toolInput === null || typeof toolInput !== "object" || Array.isArray(toolInput)) {
    return fail("arguments are not an object, so the guard cannot check this merge.");
  }
  if (toolInput.stack !== undefined && toolInput.stack !== false) {
    return fail("stack=true merges multiple pull requests at once, including lower stack layers the guard cannot check. Merge each pull request individually with stack omitted or false.");
  }
  if (toolInput.auto !== undefined && typeof toolInput.auto !== "boolean") {
    return fail(`invalid auto value \`${String(toolInput.auto)}\`, so the guard cannot check this merge.`);
  }
  const auto = toolInput.auto === true;
  let selector;
  if (toolInput.number !== undefined && toolInput.number !== null && toolInput.number !== "") {
    if (typeof toolInput.number === "number" && Number.isInteger(toolInput.number) && toolInput.number > 0) {
      selector = String(toolInput.number);
    } else if (typeof toolInput.number === "string" && /^[1-9]\d*$/.test(toolInput.number.trim())) {
      selector = toolInput.number.trim();
    } else {
      return fail(`invalid pull request number \`${String(toolInput.number)}\`, so the guard cannot check this merge.`);
    }
  }
  let repo;
  if (toolInput.repository !== undefined && toolInput.repository !== null && toolInput.repository !== "") {
    if (typeof toolInput.repository !== "string" || toolInput.repository.startsWith("-") || !MCP_REPO.test(toolInput.repository)) {
      return fail(`invalid repository \`${String(toolInput.repository)}\`, so the guard cannot check this merge.`);
    }
    repo = toolInput.repository;
  }
  let matchHead;
  if (toolInput.expectedHeadSha !== undefined && toolInput.expectedHeadSha !== null && toolInput.expectedHeadSha !== "") {
    if (typeof toolInput.expectedHeadSha !== "string") {
      return fail("invalid expectedHeadSha, so the guard cannot check this merge.");
    }
    matchHead = toolInput.expectedHeadSha;
  }
  if (toolInput.environmentId !== undefined && toolInput.environmentId !== null && toolInput.environmentId !== "") {
    if (typeof toolInput.environmentId !== "string") {
      return fail("invalid environmentId, so the guard cannot check this merge.");
    }
    if (toolInput.environmentId.trim() !== "" && (repo === undefined || selector === undefined)) {
      return fail("environmentId targets another environment whose repository and branch the guard cannot read locally. Pass both repository and number explicitly.");
    }
  }
  const where = typeof cwd === "string" && cwd ? cwd : process.cwd();
  const query = makeQuery(run, Date.now() + budgetMs);
  try {
    const reason = judgePullRequest(
      {
        selector,
        repo,
        auto,
        matchHead,
        formatStalePin: (pr, head) =>
          `expectedHeadSha ${matchHead} is not ${pr}'s head commit ${head}. Wait for that commit's checks to pass, then rerun with expectedHeadSha "${head}".`,
        formatMissingPin: (pr, head) =>
          `the checks passed on ${pr}'s head commit ${head}. Pin the merge to that commit by passing expectedHeadSha "${head}", so GitHub refuses it if the head moves.`,
        formatBehind: (pr, base, url, suggestAuto) => {
          const update = `${pr} is behind ${base}. Update it first (\`gh pr update-branch ${url}\`)`;
          return suggestAuto
            ? `${update}, then rerun this merge with auto=true and watch the pull request; GitHub merges it once ${base}'s required checks pass.`
            : `${update}, then wait for its checks to pass.`;
        },
      },
      where,
      query,
    );
    return reason && fail(reason);
  } catch (error) {
    if (error instanceof Refusal) return fail(`${error.message} The guard refuses a merge it cannot check; try again, and if gh keeps failing, report it.`);
    throw error;
  }
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
    const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
    if (MCP_MERGE_TOOLS.has(input?.tool_name)) {
      violation = findMcpMergeViolation(input?.tool_input, cwd, runGh);
    } else {
      const command = input?.tool_input?.command;
      // A cheap prefilter. Without quotes and backslashes, m"erge" and m\erge read as merge; a
      // command the shell fills in has $ or `, and one that a glob names, as in [g]h, has * ? or [;
      // the parser refuses them when it reaches gh.
      if (typeof command === "string" && /merge|gh|[$`*?[]/i.test(command.replace(/["'\\]/g, ""))) {
        violation = findMergeViolation(command, cwd, runGh);
      }
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
