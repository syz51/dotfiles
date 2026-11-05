// `propose`: group repeated failures in scores.jsonl by dimension, and for each one at or
// above the threshold run a proposer session in a fresh clone that may only edit the
// agent configuration. The tool, not the model, checks the changed paths, runs the
// offline suites, and pushes a branch with a draft PR for the user to review.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { childEnv, runProcess } from "../../tests/lib/process.js";
import { runTask } from "../lib/claude.js";
import { appendJsonl, readJsonl, statePath } from "../lib/state.js";
import { REPO_ROOT, RUBRIC, section } from "./rubric.js";
import { scoresFile } from "./score.js";

const USAGE = `Usage: bun ~/.claude/factory/cli.js propose [options]

Proposes a fix to the agent configuration for each dimension that failed in enough
scored sessions, as a draft PR.

  --days N          window of scored sessions (default 30)
  --threshold N     distinct failing sessions a dimension needs (default 3)
  --dimension ID    only this dimension (repeatable)
  --model MODEL     proposer model (default claude-opus-5-5)
  --effort LEVEL    proposer effort (default high)
  --budget-usd N    budget of each proposer session (default 3)
  --repo PATH       repository to clone (default: the one holding this file)
  --list            print the qualifying dimensions and their evidence; run nothing
  --dry-run         run the proposer and the tests, but commit, push and open nothing
  --help`;

const TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];
const TEST_PATHS = ["claude/hooks", "claude/tests", "claude/factory"];
const RECENT_DAYS = 30;
const EVIDENCE_CHARS = 400;
const EVIDENCE_ITEMS = 25;

export const proposalsFile = () => statePath("proposals.jsonl");

// Whether a repository path may change in a proposal.
export const allowedPath = (path) => path === "claude/CLAUDE.md"
  || /^claude\/agents\/[^/]+\.md$/.test(path)
  || (path.startsWith("claude/tests/") && !path.split("/").includes(".."));

const clip = (text, max = EVIDENCE_CHARS) => {
  const flat = String(text).replace(/\s*\n\s*/g, " ");
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

// Failing sessions per dimension, from the latest record of each session: the latest
// judged record for judge dimensions, the latest record for detectors. Only records of
// the current rubric version whose session ended within the window count.
export function failureGroups(records, { since, rubric = RUBRIC }) {
  const latest = new Map();
  const latestJudged = new Map();
  for (const record of records) {
    if (record.rubricVersion !== rubric.version) continue;
    if (Date.parse(record.endedAt ?? record.scoredAt) < since) continue;
    const newer = (map) => !map.has(record.sessionId) || map.get(record.sessionId).scoredAt <= record.scoredAt;
    if (newer(latest)) latest.set(record.sessionId, record);
    if (record.dimensions && !record.error && newer(latestJudged)) latestJudged.set(record.sessionId, record);
  }
  const groups = new Map(rubric.dimensions.map((dimension) => [dimension.id, { dimension, failures: [], judges: new Set() }]));
  for (const record of latest.values())
    for (const [id, result] of Object.entries(record.detectors ?? {}))
      if (result.verdict === "fail" && groups.has(id))
        groups.get(id).failures.push({ sessionId: record.sessionId, project: record.project, evidence: result.hits.slice(0, 3).map((hit) => clip(hit.evidence, 200)) });
  for (const record of latestJudged.values())
    for (const [id, result] of Object.entries(record.dimensions)) {
      const group = groups.get(id);
      if (result.verdict !== "fail" || !group || group.dimension.kind !== "judge") continue;
      const evidence = [clip(result.evidence)];
      if (id === "user-corrections")
        for (const correction of record.corrections ?? [])
          if (correction.cause !== "changed-requirements") evidence.push(clip(`${correction.prompt} (${correction.cause}): "${correction.quote}" ${correction.explanation}`));
      group.failures.push({ sessionId: record.sessionId, project: record.project, evidence });
      group.judges.add(`${record.model} (${record.effort})`);
    }
  for (const group of groups.values()) group.failures.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return [...groups.values()];
}

// A recent real proposal for the dimension that already used one of these sessions.
export function alreadyProposed(proposals, dimension, sessionIds, now) {
  const since = now - RECENT_DAYS * 86_400_000;
  return proposals.find((proposal) => proposal.dimension === dimension && proposal.status !== "dry-run"
    && Date.parse(proposal.createdAt) >= since && proposal.sessions.some((id) => sessionIds.includes(id)));
}

export function proposerPrompt({ group, instructions }) {
  const { dimension } = group;
  const text = section(instructions, dimension.section) ?? "(missing)";
  const evidence = group.failures.slice(0, EVIDENCE_ITEMS).map((failure) =>
    `- session ${failure.sessionId} (${failure.project ?? "?"}):\n${failure.evidence.map((line) => `  - ${line}`).join("\n")}`);
  return `You maintain the Claude Code agent configuration in this repository: the global instructions claude/CLAUDE.md (installed as ~/.claude/CLAUDE.md), the subagent definitions claude/agents/*.md, and the offline tests in claude/tests that pin them.

A scoring tool found the same failure in ${group.failures.length} distinct real sessions:

Dimension: ${dimension.id} (${dimension.kind === "detector" ? "deterministic detector" : "LLM judge"})
What it checks: ${dimension.question ?? dimension.description}

The section of claude/CLAUDE.md it tests, "## ${dimension.section}":
<section>
${text}
</section>

Evidence (the judge's or detector's words, not raw transcripts; it may be wrong):
${evidence.join("\n")}${group.failures.length > EVIDENCE_ITEMS ? `\n- … and ${group.failures.length - EVIDENCE_ITEMS} more sessions` : ""}

Your task:
1. Read claude/CLAUDE.md, the agent files and claude/tests/config.test.js. Decide what in the instructions causes or fails to prevent these failures: a rule that is missing, unclear, contradicted elsewhere, buried, or worded so the agent reads it differently. If the evidence does not support a change in the instructions (the judge misread the sessions, or the agent broke a clear rule that wording cannot fix), change nothing and say why.
2. Otherwise make the smallest change that fixes that cause. Prefer clarifying, replacing or deleting existing text over adding a new rule; keep the file's concise style and do not repeat rules. Keep claude/tests in step: update or add assertions in claude/tests/config.test.js for rules you change, and rewrite tests for replaced behaviour rather than deleting them.
3. Edit only claude/CLAUDE.md, claude/agents/*.md and files under claude/tests/. Do not touch settings, hooks or anything else; such a change is rejected. You cannot run commands; the tool runs the tests after you finish.

End your reply with a line "TITLE: <imperative summary under 70 characters>" for the commit, then a short paragraph on the cause and the change.`;
}

const git = async (cwd, args, { allowFailure = false } = {}) => {
  const result = await runProcess(["git", ...args], { cwd, env: process.env, timeout: 300_000 });
  if (result.code !== 0 && !allowFailure) throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  return result;
};

// Paths the working tree changed, untracked files included.
async function changedPaths(cwd) {
  const { stdout } = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const paths = [];
  const entries = stdout.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i].slice(0, 2);
    paths.push(entries[i].slice(3));
    if (/[RC]/.test(status)) paths.push(entries[++i]);
  }
  return paths;
}

async function runTests(cwd) {
  const paths = TEST_PATHS.filter((path) => existsSync(join(cwd, path)));
  const result = await runProcess(["bun", "test", ...paths], { cwd, env: childEnv(process.env), timeout: 600_000 });
  const output = `${result.stdout}\n${result.stderr}`;
  const summary = output.split("\n").map((line) => line.trim()).filter((line) => /^\d+ (?:pass|fail|skip)\b|^Ran \d+ tests/.test(line)).join(", ");
  return { ok: result.code === 0, command: `bun test ${paths.join(" ")}`, summary: summary || `exit ${result.code}`, tail: output.slice(-3000) };
}

const today = (now) => new Date(now).toISOString().slice(0, 10).replace(/-/g, "");

function prBody({ group, tests, model, effort, costUSD, explanation }) {
  const lines = [
    `Repeated \`${group.dimension.id}\` failures (${group.dimension.kind}) in ${group.failures.length} scored sessions, against the "${group.dimension.section}" section of \`claude/CLAUDE.md\`.`,
    "",
    explanation.trim(),
    "",
    "## Evidence",
    ...group.failures.slice(0, EVIDENCE_ITEMS).flatMap((failure) => [`- \`${failure.sessionId}\` (${failure.project ?? "?"})`, ...failure.evidence.map((line) => `  - ${line}`)]),
    "",
    "## Provenance",
    `- Judge: ${[...group.judges].join(", ") || "deterministic detector"}; rubric v${RUBRIC.version}`,
    `- Proposer: ${model} (${effort}), $${costUSD.toFixed(2)}`,
    `- Tests: \`${tests.command}\`: ${tests.summary}`,
  ];
  return lines.join("\n");
}

function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      days: { type: "string", default: "30" },
      threshold: { type: "string", default: "3" },
      dimension: { type: "string", multiple: true, default: [] },
      model: { type: "string", default: "claude-opus-5-5" },
      effort: { type: "string", default: "high" },
      "budget-usd": { type: "string", default: "3" },
      repo: { type: "string", default: REPO_ROOT },
      list: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const number = (name) => {
    const value = Number(values[name]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a number, got ${values[name]}`);
    return value;
  };
  const known = new Set(RUBRIC.dimensions.map((dimension) => dimension.id));
  for (const id of values.dimension) if (!known.has(id)) throw new Error(`Unknown dimension ${id}`);
  return {
    help: values.help,
    days: number("days"),
    threshold: Math.max(1, number("threshold")),
    dimensions: values.dimension,
    model: values.model,
    effort: values.effort,
    budgetUsd: number("budget-usd"),
    repo: values.repo,
    list: values.list,
    dryRun: values["dry-run"],
  };
}

// One proposal attempt in a fresh clone; returns its record.
async function attempt(group, options, now) {
  const sessions = group.failures.map((failure) => failure.sessionId);
  const branch = `factory/proposal-${group.dimension.id}-${today(now)}`;
  const record = {
    dimension: group.dimension.id,
    section: group.dimension.section,
    createdAt: new Date(now).toISOString(),
    sessions,
    rubricVersion: RUBRIC.version,
    model: options.model,
    effort: options.effort,
    dryRun: options.dryRun,
    branch,
    costUSD: 0,
    paths: [],
    tests: null,
    prUrl: null,
    patchFile: null,
  };
  const { stdout: originUrl } = await git(options.repo, ["remote", "get-url", "origin"]);
  const clone = mkdtempSync(join(tmpdir(), "claude-factory-proposal-"));
  try {
    await git(tmpdir(), ["clone", "--quiet", "--no-local", options.repo, clone]);
    await git(clone, ["remote", "set-url", "origin", originUrl.trim()]);
    await git(clone, ["fetch", "--quiet", "origin", "main"]);
    await git(clone, ["checkout", "--quiet", "-B", branch, "origin/main"]);
    const instructions = readFileSync(join(clone, "claude", "CLAUDE.md"), "utf8");
    // acceptEdits confines edits to the clone: an edit elsewhere needs a permission
    // prompt, which a print session denies.
    const task = await runTask({
      prompt: proposerPrompt({ group, instructions }),
      cwd: clone,
      model: options.model,
      effort: options.effort,
      tools: TOOLS,
      permissionMode: "acceptEdits",
      budgetUsd: options.budgetUsd,
    });
    record.costUSD = task.costUSD;
    record.proposerOk = task.ok;
    const title = /^TITLE:\s*(.+)$/m.exec(task.finalText)?.[1].trim().slice(0, 72) || `Address repeated ${group.dimension.id} failures`;
    const explanation = task.finalText.replace(/^TITLE:.*$/m, "").trim();
    Object.assign(record, { title, explanation: clip(explanation, 2000) });
    record.paths = await changedPaths(clone);
    if (!record.paths.length) return { ...record, status: "no-change" };
    await git(clone, ["add", "-A"]);
    const { stdout: patch } = await git(clone, ["diff", "--cached"]);
    record.patchFile = statePath("proposals", `${group.dimension.id}-${today(now)}-${now}.patch`);
    writeFileSync(record.patchFile, patch);
    const outside = record.paths.filter((path) => !allowedPath(path));
    if (outside.length) return { ...record, status: "rejected-paths", rejected: outside };
    const tests = await runTests(clone);
    record.tests = { ok: tests.ok, command: tests.command, summary: tests.summary, ...(tests.ok ? {} : { tail: tests.tail }) };
    if (!tests.ok) return { ...record, status: "tests-failed" };
    if (options.dryRun) return { ...record, status: "dry-run" };
    await git(clone, ["commit", "--quiet", "-m", title]);
    await git(clone, ["push", "--quiet", "-u", "origin", `HEAD:refs/heads/${branch}`]);
    const gh = process.env.CLAUDE_FACTORY_GH || "gh";
    const body = prBody({ group, tests, model: options.model, effort: options.effort, costUSD: task.costUSD, explanation });
    const pr = await runProcess([gh, "pr", "create", "--draft", "--base", "main", "--head", branch, "--title", title, "--body", body], { cwd: clone, env: process.env, timeout: 120_000 });
    if (pr.code !== 0) throw new Error(`${gh} pr create failed (${pr.code}) after pushing ${branch}: ${pr.stderr.trim()}`);
    return { ...record, status: "proposed", prUrl: pr.stdout.trim().split("\n").at(-1) };
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}

export async function run(argv, { now = Date.now() } = {}) {
  let options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const groups = failureGroups(readJsonl(scoresFile()), { since: now - options.days * 86_400_000 })
    .filter((group) => !options.dimensions.length || options.dimensions.includes(group.dimension.id));
  const proposals = readJsonl(proposalsFile());
  const qualifying = [];
  for (const group of groups) {
    const count = group.failures.length;
    const sessions = group.failures.map((failure) => failure.sessionId);
    const previous = count >= options.threshold ? alreadyProposed(proposals, group.dimension.id, sessions, now) : null;
    const note = count < options.threshold ? "below threshold" : previous ? `already proposed ${previous.createdAt.slice(0, 10)} (${previous.status})` : "qualifies";
    console.log(`${group.dimension.id.padEnd(26)} ${String(count).padStart(3)} failing sessions  ${note}`);
    if (count >= options.threshold && !previous) qualifying.push(group);
  }
  if (options.list) {
    for (const group of qualifying) {
      console.log(`\n## ${group.dimension.id} (section "${group.dimension.section}")`);
      for (const failure of group.failures) console.log(`- ${failure.sessionId} (${failure.project ?? "?"}): ${failure.evidence[0] ?? ""}`);
    }
    return 0;
  }
  let failed = 0;
  for (const group of qualifying) {
    console.log(`\nProposing for ${group.dimension.id} with ${options.model} (${options.effort})${options.dryRun ? ", dry run" : ""}…`);
    const record = await attempt(group, options, now);
    appendJsonl(proposalsFile(), record);
    if (["rejected-paths", "tests-failed"].includes(record.status)) failed++;
    console.log(`  ${record.status}: ${record.title ?? ""}${record.prUrl ? ` ${record.prUrl}` : ""}`);
    if (record.paths.length) console.log(`  changed: ${record.paths.join(", ")}${record.rejected ? ` (outside the allowlist: ${record.rejected.join(", ")})` : ""}`);
    if (record.tests) console.log(`  tests: ${record.tests.summary}`);
    if (record.patchFile) console.log(`  patch: ${record.patchFile}`);
    console.log(`  cost: $${record.costUSD.toFixed(2)}`);
  }
  if (!qualifying.length) console.log("Nothing qualifies.");
  return failed ? 1 : 0;
}
