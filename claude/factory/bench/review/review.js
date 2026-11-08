// The /code-review level benchmark: each configuration (model and review level) reviews
// real commits of this repository. Bug cases introduced a defect a later commit fixed,
// so a review should name it; clean cases needed no fix, so a finding that would change
// them for the worse is harmful. A judge maps each review's findings to those verdicts.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCallError, judge, runTask } from "../../lib/claude.js";
import { claudeTempDir, removeSessionArtifacts } from "../../../tests/lib/cleanup.js";
import { childEnv, runProcess } from "../../../tests/lib/process.js";
import { benchSettings, configProblem } from "../runner.js";

export const CASES_FILE = join(import.meta.dir, "cases.json");
// The repository the cases come from: the checkout this file is in.
export const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
export const LEVELS = ["low", "medium", "high", "xhigh", "max"];
export const DEFAULT_CONFIGS = "claude-opus-5-5:high,claude-opus-5-5:xhigh,claude-opus-5-5:max,claude-haiku-5-5:xhigh";
// Worst-case spend of one review by level; max starts many reviewer agents.
export const REVIEW_BUDGETS = { low: 2, medium: 3, high: 4, xhigh: 6, max: 15 };
export const JUDGE_BUDGET = 0.5;
const REVIEW_TIMEOUT_MS = 40 * 60_000;
const DIFF_CHARS = 60_000;

const SHA = /^[0-9a-f]{40}$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;

// The cases, checked: [{ id, kind: "bug" | "clean", base, head, ... }]. A bug case also
// has answers ([{ file, line }]) and bug, one sentence on what is wrong.
export function loadCases(file = CASES_FILE) {
  const cases = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(cases) || !cases.length) throw new Error(`${file}: expected a non-empty list of cases`);
  const seen = new Set();
  for (const benchCase of cases) {
    const where = `${file}: case ${JSON.stringify(benchCase?.id)}`;
    if (typeof benchCase?.id !== "string" || !ID.test(benchCase.id) || seen.has(benchCase.id)) throw new Error(`${where}: id must be unique kebab-case`);
    seen.add(benchCase.id);
    if (!["bug", "clean"].includes(benchCase.kind)) throw new Error(`${where}: kind must be bug or clean`);
    if (!SHA.test(benchCase.base ?? "") || !SHA.test(benchCase.head ?? "")) throw new Error(`${where}: base and head must be full commit SHAs`);
    if (benchCase.kind === "bug") {
      const answers = benchCase.answers;
      if (!Array.isArray(answers) || !answers.length || !answers.every((answer) => typeof answer?.file === "string" && Number.isInteger(answer.line)))
        throw new Error(`${where}: a bug case needs answers [{ file, line }]`);
      if (typeof benchCase.bug !== "string" || !benchCase.bug.trim()) throw new Error(`${where}: a bug case needs bug, a sentence on the defect`);
    }
  }
  return cases;
}

// "model:level,…" as [{ model, level }].
export function parseConfigs(text) {
  return text.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
    const [model, level] = item.split(":");
    if (!/^claude-[a-z0-9-]+$/.test(model ?? "") || !LEVELS.includes(level)) throw new Error(`Configuration ${item}: expected a full model ID and a level from ${LEVELS.join(", ")}, such as claude-opus-5-5:xhigh`);
    return { model, level };
  });
}

// The session calls the Skill tool, as the Review rule's background agent does. The skill
// runs in a forked context and returns its result as the tool result. A bare /code-review
// prompt in --print mode forks too, but leaves only a <synthetic> relay at the top level.
export const reviewPrompt = (benchCase, level) =>
  `Use the Skill tool to run the code-review skill with args "${level} ${benchCase.base}...${benchCase.head}". Then reply only with the word done.`;

async function git(args, cwd) {
  const run = await runProcess(["git", ...args], { cwd, env: childEnv(process.env), timeout: 120_000, maxBytes: 64 * 1024 * 1024 });
  if (run.code !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.trim()}`);
  return run.stdout;
}

// A checkout of the case's head that shares the repository's objects and has no remote,
// so nothing a session runs there can reach the real repository's refs.
export async function checkout(benchCase, dir, repo = REPO_ROOT) {
  await git(["clone", "-q", "--shared", "--no-checkout", repo, dir]);
  await git(["remote", "remove", "origin"], dir);
  await git(["checkout", "-q", "--detach", benchCase.head], dir);
}

const blocks = (event) => (Array.isArray(event.message?.content) ? event.message.content : []);

// The review's skill call: { id, models, output }, or null when the session made none. models
// are the main thread's and the fork's, most used first, without Claude Code's <synthetic>
// messages. output is the skill's result text and any ReportFindings calls in the fork.
export function reviewSession(events) {
  const call = events.flatMap((event) => (event.type === "assistant" && !event.parent_tool_use_id ? blocks(event) : []))
    .find((block) => block?.type === "tool_use" && block.name === "Skill" && /(^|:)code-review$/.test(block.input?.skill ?? ""));
  if (!call) return null;
  const counts = new Map();
  const reported = [];
  let result = "";
  for (const event of events) {
    const parent = event.parent_tool_use_id ?? null;
    if (parent !== null && parent !== call.id) continue;
    const model = event.message?.model;
    if (event.type === "assistant" && model && model !== "<synthetic>") counts.set(model, (counts.get(model) ?? 0) + 1);
    for (const block of blocks(event)) {
      if (event.type === "assistant" && parent === call.id && block?.type === "tool_use" && block.name === "ReportFindings") reported.push(block.input);
      if (event.type === "user" && parent === null && block?.type === "tool_result" && block.tool_use_id === call.id)
        result = typeof block.content === "string" ? block.content : (block.content ?? []).map((part) => part?.text ?? "").join("\n");
    }
  }
  const text = (/\nResult:\n([\s\S]*)$/.exec(result)?.[1] ?? result).trim();
  return {
    id: call.id,
    models: [...counts].sort((a, b) => b[1] - a[1]).map(([model]) => model),
    output: [text, ...reported.map((input) => `ReportFindings: ${JSON.stringify(input)}`)].filter(Boolean).join("\n\n"),
  };
}

// The recipe the review skill named, such as "xhigh effort → 10 inline angles → …".
export function recipeOf(events) {
  return /`(\w+ effort → [^`]+)`/.exec(JSON.stringify(events).replace(/\\u2192/g, "→"))?.[1] ?? null;
}

export const JUDGE_SYSTEM = [
  "You grade one code review of one commit. List every distinct finding the review reports, once each, in its order. Ignore praise, summaries and notes that report no problem.",
  "For a bug case you get the known defect: give a finding the verdict matches when it names that defect (same cause, at or near one of the given places), else other.",
  "For a clean case the commit needed no fix. Read the diff and give each finding one verdict: harmful when applying its suggested change would break intended behavior, remove a deliberate choice or add risk; unfounded when the problem it claims is not there but acting on it changes nothing important; valid when it names a real problem.",
].join("\n\n");

export const judgeSchema = (kind) => ({
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "location", "verdict", "reason"],
        properties: {
          summary: { type: "string" },
          location: { type: "string" },
          verdict: { enum: kind === "bug" ? ["matches", "other"] : ["harmful", "unfounded", "valid"] },
          reason: { type: "string" },
        },
      },
    },
  },
});

export function judgePrompt(benchCase, output, diff) {
  const parts = [`Case kind: ${benchCase.kind}`];
  if (benchCase.kind === "bug")
    parts.push(`Known defect: ${benchCase.bug}`, `At: ${benchCase.answers.map((answer) => `${answer.file}:${answer.line}`).join(", ")}`);
  else parts.push(`The commit's diff:\n\`\`\`diff\n${diff.length > DIFF_CHARS ? `${diff.slice(0, DIFF_CHARS)}\n[diff cut at ${DIFF_CHARS} characters]` : diff}\n\`\`\``);
  parts.push(`The review's output:\n<review>\n${output || "(no output)"}\n</review>`);
  return parts.join("\n\n");
}

// Counts from a judge answer: { findings, matched, harmful, unfounded, valid }.
export function verdicts(answer, kind) {
  const findings = answer?.findings;
  if (!Array.isArray(findings) || !findings.every((finding) => typeof finding?.verdict === "string")) throw new Error("Judge answer has no findings list");
  const count = (verdict) => findings.filter((finding) => finding.verdict === verdict).length;
  return kind === "bug"
    ? { findings: findings.length, matched: count("matches") > 0, harmful: null, unfounded: null, valid: null }
    : { findings: findings.length, matched: null, harmful: count("harmful"), unfounded: count("unfounded"), valid: count("valid") };
}

// One review of one case and its judgement. Infrastructure failures (a failed session or
// judge call, the wrong model or effort) are marked infra and left out of reports.
export async function runOne(benchCase, { model, level, trial, batch, judgeModel, budgetUsd = REVIEW_BUDGETS[level], judgeBudgetUsd = JUDGE_BUDGET, repo = REPO_ROOT }) {
  const record = {
    batch, caseId: benchCase.id, kind: benchCase.kind, model, level, trial, judgeModel, at: new Date().toISOString(),
    findings: null, matched: null, harmful: null, unfounded: null, valid: null, judged: [], recipe: null,
    modelObserved: null, effortObserved: null, reviewCostUSD: 0, judgeCostUSD: 0, costUSD: 0, durationMs: null, error: null, infra: false,
  };
  const done = (fields = {}) => {
    const value = { ...record, ...fields };
    return { ...value, costUSD: value.reviewCostUSD + value.judgeCostUSD };
  };
  const root = realpathSync(mkdtempSync(join(tmpdir(), `claude-bench-review-${benchCase.id}-`)));
  try {
    const dir = join(root, "repo");
    await checkout(benchCase, dir, repo);
    const settings = join(root, "settings.json");
    writeFileSync(settings, JSON.stringify(benchSettings()));
    let task;
    try {
      task = await runTask({
        prompt: reviewPrompt(benchCase, level), cwd: dir, model, effort: level, settings, readEffort: true,
        budgetUsd, timeoutMs: REVIEW_TIMEOUT_MS, env: { CLAUDE_CODE_TMPDIR: root, TMPDIR: root },
      });
    } catch (error) {
      if (!(error instanceof ClaudeCallError)) throw error;
      return done({ reviewCostUSD: error.costUSD ?? budgetUsd, error: `review session: ${error.message}`, infra: true });
    }
    const session = reviewSession(task.events);
    const models = session?.models ?? [];
    const config = configProblem(task, models, { model, effort: level });
    const recipe = recipeOf(task.events);
    Object.assign(record, {
      reviewCostUSD: task.costUSD, durationMs: task.durationMs, recipe,
      modelObserved: models.join(",") || null, effortObserved: config.efforts.join(",") || null,
    });
    if (!task.ok) return done({ error: `review session ended without a result${task.timedOut ? " (timed out)" : ""}`, infra: true });
    if (!session) return done({ error: "the session did not call the code-review skill", infra: true });
    if (config.problem) return done({ error: config.problem, infra: true });
    if (!recipe?.startsWith(`${level} effort`)) return done({ error: `requested level ${level} but the skill ran ${recipe ?? "no named recipe"}`, infra: true });
    const { output } = session;
    const diff = benchCase.kind === "clean" ? await git(["diff", `${benchCase.base}...${benchCase.head}`], dir) : "";
    try {
      const answer = await judge({ prompt: judgePrompt(benchCase, output, diff), system: JUDGE_SYSTEM, schema: judgeSchema(benchCase.kind), model: judgeModel, effort: "medium", budgetUsd: judgeBudgetUsd });
      record.judgeCostUSD = answer.costUSD;
      Object.assign(record, verdicts(answer.output, benchCase.kind), { judged: answer.output.findings });
    } catch (error) {
      if (!(error instanceof ClaudeCallError) && !/^Judge answer/.test(error.message)) throw error;
      return done({ judgeCostUSD: record.judgeCostUSD || (error.costUSD ?? judgeBudgetUsd), error: `judge: ${error.message}`, infra: true });
    }
    return done();
  } finally {
    removeSessionArtifacts({ bases: [join(homedir(), ".claude", "projects"), claudeTempDir()], roots: [root] });
    rmSync(root, { recursive: true, force: true });
  }
}

const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

// Per configuration over usable runs: recall on bug cases, findings per review, harmful
// and unfounded findings per clean review, the share of clean reviews with a harmful
// finding, and mean review cost and minutes. minTrials is the fewest runs of any case.
export function aggregate(records) {
  const usable = records.filter((record) => !record.infra && record.findings !== null);
  const configs = {};
  for (const record of usable) (configs[`${record.model} ${record.level}`] ??= []).push(record);
  const summary = {};
  for (const [key, runs] of Object.entries(configs).sort()) {
    const bugs = runs.filter((record) => record.kind === "bug");
    const cleans = runs.filter((record) => record.kind === "clean");
    const perCase = {};
    for (const record of runs) (perCase[record.caseId] ??= []).push(record);
    summary[key] = {
      model: runs[0].model, level: runs[0].level, runs: runs.length, bugRuns: bugs.length, cleanRuns: cleans.length,
      minTrials: Math.min(...Object.values(perCase).map((list) => list.length)),
      recall: bugs.length ? bugs.filter((record) => record.matched).length / bugs.length : null,
      findingsPerReview: mean(runs.map((record) => record.findings)),
      harmfulPerClean: mean(cleans.map((record) => record.harmful)),
      unfoundedPerClean: mean(cleans.map((record) => record.unfounded)),
      cleanWithHarmful: cleans.length ? cleans.filter((record) => record.harmful > 0).length / cleans.length : null,
      meanCostUSD: mean(runs.map((record) => record.reviewCostUSD)),
      meanMinutes: mean(runs.map((record) => record.durationMs / 60_000)),
      recipes: [...new Set(runs.map((record) => record.recipe).filter(Boolean))],
      perCase: Object.fromEntries(Object.entries(perCase).map(([id, list]) => [id, {
        kind: list[0].kind, runs: list.length,
        matched: list[0].kind === "bug" ? list.filter((record) => record.matched).length : null,
        harmful: list[0].kind === "clean" ? list.reduce((sum, record) => sum + record.harmful, 0) : null,
      }])),
    };
  }
  return { configs: summary, infra: records.length - usable.length };
}

const percent = (value) => (value === null ? "-" : `${(value * 100).toFixed(0)}%`);
const fixed = (value, digits = 2) => (value === null ? "-" : value.toFixed(digits));

export function markdown(summary) {
  const entries = Object.entries(summary.configs);
  if (!entries.length) return "Not measured: no usable runs.";
  const lines = [
    "| Configuration | Runs | Min trials | Recall | Findings per review | Harmful per clean review | Clean reviews with a harmful finding | Unfounded per clean review | Mean cost | Mean minutes |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const [key, c] of entries)
    lines.push(`| ${key} | ${c.runs} | ${c.minTrials} | ${percent(c.recall)} | ${fixed(c.findingsPerReview, 1)} | ${fixed(c.harmfulPerClean)} | ${percent(c.cleanWithHarmful)} | ${fixed(c.unfoundedPerClean)} | $${fixed(c.meanCostUSD)} | ${fixed(c.meanMinutes, 1)} |`);
  const ids = [...new Set(entries.flatMap(([, c]) => Object.keys(c.perCase)))].sort();
  lines.push("", `| Case | ${entries.map(([key]) => key).join(" | ")} |`, `|---|${entries.map(() => "---|").join("")}`);
  for (const id of ids) {
    const cells = entries.map(([, c]) => {
      const one = c.perCase[id];
      if (!one) return "-";
      return one.kind === "bug" ? `found ${one.matched}/${one.runs}` : `harmful ${one.harmful} in ${one.runs}`;
    });
    lines.push(`| ${id} | ${cells.join(" | ")} |`);
  }
  const recipes = entries.filter(([, c]) => c.recipes.length).map(([key, c]) => `- ${key}: ${c.recipes.join("; ")}`);
  if (recipes.length) lines.push("", "Recipes the reviews named:", ...recipes);
  if (summary.infra) lines.push("", `${summary.infra} infrastructure failures left out.`);
  return lines.join("\n");
}
