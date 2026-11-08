// review: the weekly review of each board repository's main. One /code-review session
// reviews the last days of main in a fresh clone; a verify session checks each finding
// against the current code. Confirmed findings are filed as proposals on the
// repository's board; the result, rejected findings with their reasons included, is
// printed and kept in the state folder. Settings live in config.json beside this file.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { claudeTempDir, removeSessionArtifacts } from "../../tests/lib/cleanup.js";
import { childEnv, runProcess } from "../../tests/lib/process.js";
import { resultEvent } from "../../tests/lib/stream.js";
import { ClaudeCallError, runTask } from "../lib/claude.js";
import { clip } from "../lib/proposal.js";
import { statePath, writeJsonAtomic } from "../lib/state.js";
import { benchSettings } from "../bench/runner.js";
import { LEVELS, recipeOf, reviewPrompt, reviewSession } from "../bench/review/review.js";
import { call } from "../board/cli.js";

export const CONFIG_FILE = join(import.meta.dir, "config.json");
// The board identity the filed proposals carry.
export const AGENT = "claude:factory-weekly-review";
const REVIEW_TIMEOUT_MS = 40 * 60_000;
const VERIFY_TIMEOUT_MS = 20 * 60_000;
const VERIFY_TOOLS = ["Read", "Grep", "Glob", "Bash"];
const OUTPUT_CHARS = 60_000;
const TITLES = 200;
const CLOSED = new Set(["done", "dropped"]);

const USAGE = `Usage: bun ~/.claude/factory/cli.js review [options]

Reviews the last days of main for each configured board's repositories with /code-review,
checks each finding against current main, and files the confirmed ones as proposals on
that board. Settings: ${CONFIG_FILE}.

  --board SLUG   review only this board's repositories (repeatable)
  --dry-run      review and verify, but file nothing
  --config PATH  another config file
  --json         print the result as JSON
  --help`;

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// The config, checked: { boards, days, branch, model, level, verifyModel, verifyEffort,
// reviewBudgetUsd, verifyBudgetUsd }.
export function loadConfig(file = CONFIG_FILE) {
  const config = JSON.parse(readFileSync(file, "utf8"));
  const problems = [];
  if (!Array.isArray(config.boards) || !config.boards.length || !config.boards.every((slug) => typeof slug === "string" && /^[a-z0-9][a-z0-9-]*$/.test(slug))) problems.push("boards must be a non-empty list of board slugs");
  if (!Number.isInteger(config.days) || config.days < 1) problems.push("days must be a positive integer");
  if (typeof config.branch !== "string" || !/^[\w./-]+$/.test(config.branch)) problems.push("branch must be a branch name");
  for (const key of ["model", "verifyModel"]) if (!/^claude-[a-z0-9-]+$/.test(config[key] ?? "")) problems.push(`${key} must be a full model ID`);
  if (!LEVELS.includes(config.level)) problems.push(`level must be one of ${LEVELS.join(", ")}`);
  if (!EFFORTS.includes(config.verifyEffort)) problems.push(`verifyEffort must be one of ${EFFORTS.join(", ")}`);
  for (const key of ["reviewBudgetUsd", "verifyBudgetUsd"]) if (!(typeof config[key] === "number" && config[key] > 0)) problems.push(`${key} must be a positive number`);
  if (problems.length) throw new Error(`${file}: ${problems.join("; ")}`);
  return config;
}

// Where to clone a board's repository from, such as github.com/o/n. CLAUDE_FACTORY_REVIEW_REMOTE
// replaces GitHub with a folder holding one repository per name (tests use local ones).
export function remoteUrl(repo, env = process.env) {
  const match = /^github\.com\/([\w.-]+)\/([\w.-]+)$/.exec(repo);
  if (!match) throw new Error(`${repo}: only github.com/<owner>/<name> repositories are supported`);
  return env.CLAUDE_FACTORY_REVIEW_REMOTE ? join(env.CLAUDE_FACTORY_REVIEW_REMOTE, match[2]) : `git@github.com:${match[1]}/${match[2]}.git`;
}

// The configured boards' repositories: [{ board, repo }]. A missing board or one with no
// repository is an error, as the config names it.
export async function boardRepos(slugs) {
  const boards = await call(["boards", "--json"]);
  if (!Array.isArray(boards)) throw new Error("board boards: expected a list of boards");
  return slugs.flatMap((slug) => {
    const board = boards.find((entry) => entry?.slug === slug);
    if (!board) throw new Error(`board ${slug} does not exist`);
    if (!Array.isArray(board.repos) || !board.repos.length) throw new Error(`board ${slug} has no repository`);
    return board.repos.map((repo) => ({ board: slug, repo }));
  });
}

async function git(args, cwd) {
  const run = await runProcess(["git", ...args], { cwd, env: childEnv(process.env), timeout: 300_000, maxBytes: 64 * 1024 * 1024 });
  if (run.code !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.trim()}`);
  return run.stdout.trim();
}

// A clone of url at the branch's head with no remote, so nothing a session runs there can
// reach the real repository. base is the branch's last first-parent commit from before
// the window; commits counts the first-parent commits after it. base is null when the
// branch has no commit that old.
export async function prepare(url, dir, { branch, days, now = Date.now() }) {
  await git(["clone", "--quiet", "--no-checkout", url, dir], tmpdir());
  const ref = `origin/${branch}`;
  const head = await git(["rev-parse", "--verify", `${ref}^{commit}`], dir);
  const before = new Date(now - days * 86_400_000).toISOString();
  const base = (await git(["rev-list", "-1", "--first-parent", `--before=${before}`, ref], dir)) || null;
  const commits = base ? Number(await git(["rev-list", "--count", "--first-parent", `${base}..${head}`], dir)) : null;
  await git(["checkout", "--quiet", "--detach", head], dir);
  await git(["remote", "remove", "origin"], dir);
  return { base, head, commits };
}

export const verifySchema = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "location", "verdict", "reason", "title", "change", "size", "priority"],
        properties: {
          summary: { type: "string" },
          location: { type: "string" },
          verdict: { enum: ["confirmed", "rejected"] },
          reason: { type: "string" },
          title: { type: "string" },
          change: { type: "string" },
          size: { enum: ["S", "M", "L"] },
          priority: { enum: ["p1", "p2", "p3"] },
        },
      },
    },
  },
};

// The verify session's prompt: the review's output, the range, and the open tasks' titles
// on the board, so a finding already filed is rejected rather than filed twice.
export function verifyPrompt({ base, head, output, titles }) {
  const review = output.length > OUTPUT_CHARS ? `${output.slice(0, OUTPUT_CHARS)}\n[review output cut at ${OUTPUT_CHARS} characters]` : output;
  return [
    `A code review of the changes ${base}..${head} in this repository reported the findings below. This checkout is at ${head}, the current main.`,
    "Check each distinct finding against the code here. Open the cited code, follow how it is called, and use git log or git show when the history matters. Do not edit any file.",
    "- confirmed: the defect is in the current code and causes wrong behavior, a crash, data loss or a security gap you can describe concretely.",
    "- rejected: the code does not have the problem, a later commit already fixed it, the behavior is intended (a comment, test or doc says so), it is only style or taste, or an open task below already covers it.",
    "For each finding give: summary, one sentence on the problem; location, path:line in the current code; verdict; reason, the evidence for the verdict in one or two sentences; title, an imperative title for the fix under 72 characters; change, the fix in one or two sentences; size, S, M or L; priority, p1 when it does harm now, p2 when each hit wastes a paid run or more than 10 minutes, else p3. List the findings in the review's order; when the review reported none, return an empty list.",
    `Open tasks on this repository's board:\n${titles.length ? titles.map((title) => `- ${title}`).join("\n") : "(none)"}`,
    `The review's output:\n<review>\n${review || "(no output)"}\n</review>`,
  ].join("\n\n");
}

// Titles of the board's tasks that are not done or dropped, newest first.
export async function openTitles(board) {
  const tasks = await call(["ls", "--board", board, "--json", "--limit", "1000"]);
  if (!Array.isArray(tasks)) throw new Error(`board ls --board ${board}: expected a list of tasks`);
  return tasks.filter((task) => !CLOSED.has(task?.status) && typeof task?.title === "string").map((task) => task.title).slice(0, TITLES);
}

// The proposal body for one confirmed finding.
export function proposalBody(finding, { repo, base, head, level, date }) {
  return [
    `Proposal: ${finding.summary}`,
    `Evidence: the weekly review (/code-review ${level}) of ${repo} main ${base.slice(0, 8)}..${head.slice(0, 8)} reported it at ${finding.location}. A verify pass on ${head.slice(0, 8)} confirmed it: ${finding.reason}`,
    `Change: ${finding.change}`,
    `Size: ${finding.size}`,
    `Found by the factory's weekly review of main on ${date}.`,
  ].join("\n\n");
}

const sessionError = (task) => {
  const final = resultEvent(task.events);
  const text = clip(String(final?.result ?? ""), 200);
  return task.timedOut ? "timed out" : final ? `${final.subtype}${final.is_error ? ", is_error" : ""}${text ? `: ${text}` : ""}` : "no result event";
};

// One repository's review: { board, repo, base, head, commits, recipe, reviewCostUSD,
// verifyCostUSD, confirmed: [finding + task], rejected: [finding], skipped, error }. A failed
// session or board call ends the repository with error set; what it spent is kept.
export async function reviewRepo({ board, repo }, config, { file = true, now = Date.now(), env = process.env } = {}) {
  const date = new Date(now).toISOString().slice(0, 10);
  const record = { board, repo, base: null, head: null, commits: null, recipe: null, reviewCostUSD: 0, verifyCostUSD: 0, confirmed: [], rejected: [], skipped: null, error: null };
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-factory-review-")));
  const sessionEnv = { CLAUDE_CODE_TMPDIR: root, TMPDIR: root };
  try {
    const dir = join(root, "repo");
    Object.assign(record, await prepare(remoteUrl(repo, env), dir, { branch: config.branch, days: config.days, now }));
    // A repository younger than the window would need a review of its whole history, a
    // different and costlier job; it is skipped until it is old enough.
    if (!record.base) return { ...record, skipped: `${config.branch} has no commit older than ${config.days} days` };
    if (record.commits === 0) return record;
    const settings = join(root, "settings.json");
    writeFileSync(settings, JSON.stringify(benchSettings()));
    let task;
    try {
      task = await runTask({
        prompt: reviewPrompt({ base: record.base, head: record.head }, config.level), cwd: dir, model: config.model, effort: config.level,
        settings, budgetUsd: config.reviewBudgetUsd, timeoutMs: REVIEW_TIMEOUT_MS, env: sessionEnv,
      });
    } catch (error) {
      if (!(error instanceof ClaudeCallError)) throw error;
      return { ...record, reviewCostUSD: error.costUSD ?? config.reviewBudgetUsd, error: `review session: ${error.message}` };
    }
    record.reviewCostUSD = task.costUSD;
    record.recipe = recipeOf(task.events);
    if (!task.ok) return { ...record, error: `review session ended without a result (${sessionError(task)})` };
    const session = reviewSession(task.events);
    if (!session) return { ...record, error: "the review session did not call the code-review skill" };
    const titles = await openTitles(board);
    let verify;
    try {
      verify = await runTask({
        prompt: verifyPrompt({ base: record.base, head: record.head, output: session.output, titles }), cwd: dir, model: config.verifyModel,
        effort: config.verifyEffort, settings, tools: VERIFY_TOOLS, schema: verifySchema, budgetUsd: config.verifyBudgetUsd, timeoutMs: VERIFY_TIMEOUT_MS, env: sessionEnv,
      });
    } catch (error) {
      if (!(error instanceof ClaudeCallError)) throw error;
      return { ...record, verifyCostUSD: error.costUSD ?? config.verifyBudgetUsd, error: `verify session: ${error.message}` };
    }
    record.verifyCostUSD = verify.costUSD;
    const findings = verify.output?.findings;
    if (!verify.ok || !Array.isArray(findings)) return { ...record, error: `verify session ended without findings (${verify.ok ? "no structured output" : sessionError(verify)})` };
    record.rejected = findings.filter((finding) => finding.verdict === "rejected");
    for (const finding of findings.filter((one) => one.verdict === "confirmed")) {
      if (!file) {
        record.confirmed.push({ ...finding, task: null });
        continue;
      }
      const title = clip(finding.title, 72);
      const body = proposalBody(finding, { repo, base: record.base, head: record.head, level: config.level, date });
      const added = await call(["add", title, "--board", board, "--body", body.length > 4000 ? `${body.slice(0, 3999)}…` : body, "--priority", finding.priority, "--auto", "false", "--agent", AGENT, "--json"], { what: `board add on ${board}` });
      record.confirmed.push({ ...finding, task: added?.id ?? null });
    }
    return record;
  } catch (error) {
    return { ...record, error: error.message };
  } finally {
    removeSessionArtifacts({ bases: [join(homedir(), ".claude", "projects"), claudeTempDir()], roots: [root] });
    rmSync(root, { recursive: true, force: true });
  }
}

const usd = (value) => `$${value.toFixed(2)}`;

// Headline lines for the weekly report: per repository the range, cost, the filed
// proposals and the rejected findings with their reasons.
export function summaryLines(result) {
  const lines = [];
  for (const repo of result.repos) {
    const cost = usd(repo.reviewCostUSD + repo.verifyCostUSD);
    const range = repo.base && repo.head ? `${repo.base.slice(0, 8)}..${repo.head.slice(0, 8)}, ${repo.commits} commits` : "no range";
    if (repo.error) lines.push(`${repo.repo}: FAILED (${range}, ${cost}): ${repo.error}`);
    else if (repo.skipped) lines.push(`${repo.repo}: skipped: ${repo.skipped}`);
    else if (repo.commits === 0) lines.push(`${repo.repo}: no commits on main in ${result.days} days`);
    else lines.push(`${repo.repo} (${range}, ${cost}${repo.recipe ? `, ${repo.recipe.split(" → ")[0]}` : ""}): ${repo.confirmed.length} confirmed, ${repo.rejected.length} rejected`);
    for (const finding of repo.confirmed) lines.push(`- Filed ${finding.task ?? "(dry run, not filed)"}: ${finding.title} (${finding.location})`);
    for (const finding of repo.rejected) lines.push(`- Rejected: ${clip(finding.summary, 200)} (${finding.location}). ${clip(finding.reason, 300)}`);
  }
  lines.push(`Total cost ${usd(result.costUSD)}`);
  return lines;
}

export async function run(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        board: { type: "string", multiple: true },
        "dry-run": { type: "boolean", default: false },
        config: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    }));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const config = loadConfig(values.config ?? CONFIG_FILE);
  const unknown = (values.board ?? []).filter((slug) => !config.boards.includes(slug));
  if (unknown.length) {
    console.error(`Not in the config's boards: ${unknown.join(", ")}`);
    return 2;
  }
  const startedAt = new Date();
  const result = { startedAt: startedAt.toISOString(), days: config.days, level: config.level, model: config.model, dryRun: values["dry-run"], repos: [], costUSD: 0 };
  for (const target of await boardRepos(values.board ?? config.boards))
    result.repos.push(await reviewRepo(target, config, { file: !values["dry-run"], now: startedAt.getTime() }));
  result.costUSD = result.repos.reduce((sum, repo) => sum + repo.reviewCostUSD + repo.verifyCostUSD, 0);
  result.finishedAt = new Date().toISOString();
  writeJsonAtomic(statePath("review", `main-${result.startedAt.slice(0, 10)}.json`), result);
  console.log(values.json ? JSON.stringify(result, null, 2) : summaryLines(result).join("\n"));
  return result.repos.some((repo) => repo.error) ? 1 : 0;
}
