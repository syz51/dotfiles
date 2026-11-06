// `propose`: group repeated failures in scores.jsonl by dimension, and for each one at or
// above the threshold run a proposer session in a fresh clone that may only edit the
// agent instructions, which are text, never code. The tool, not the model, checks every
// file the session wrote, checks the change for evidence quoted from private
// transcripts, runs the offline suites, and pushes a branch with a draft PR for the user
// to review. With --board-snapshot, the work board's stats and feedback are one more
// source (../board/proposal.js), under the same budgets.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { resultEvent } from "../../tests/lib/stream.js";
import { attemptBoard, BOARD_ID, BOARD_REPO, boardCandidate, newBoardRecord, readSnapshot } from "../board/proposal.js";
import { runTask } from "../lib/claude.js";
import { addedLines, changedPaths, clip, cloneRepository, gitState, leakedEvidence, originalText, proposerReply, proposerSettings, publish, readDenies, retryable, runTests, stagedPatch, stamp, today, toolRejection, TOOLS, writePatch } from "../lib/proposal.js";
import { appendJsonl, readJsonl, statePath } from "../lib/state.js";
import { REPO_ROOT, RUBRIC, section } from "./rubric.js";
import { scoresFile } from "./score.js";

export { leakedEvidence, readDenies };

const USAGE = `Usage: bun ~/.claude/factory/cli.js propose [options]

Proposes a fix to the agent configuration for each dimension that failed in enough
scored sessions, as a draft PR.

  --days N          window of scored sessions (default 30)
  --threshold N     distinct failing sessions a dimension needs (default 3)
  --dimension ID    only this dimension (repeatable)
  --model MODEL     proposer model (default claude-opus-5-5)
  --effort LEVEL    proposer effort (default high)
  --budget-usd N    budget of each proposer session (default 3)
  --max-total-usd N stop starting sessions that could take this run past N (default 10);
                    the dimensions left over qualify again next run
  --repo PATH       repository to clone (default: the one holding this file)
  --board-snapshot PATH
                    also propose changes to the work board's defaults, coordinator
                    prompt and rule from this snapshot (written by the board command)
  --board-repo URL  agent-board repository to clone (default ${BOARD_REPO})
  --board-base NAME agent-board base branch (default main)
  --list            print the qualifying dimensions and their evidence; run nothing
  --dry-run         run the proposer and the tests, but commit, push and open nothing
  --help`;

const RECENT_DAYS = 30;
const EVIDENCE_ITEMS = 25;

export const proposalsFile = () => statePath("proposals.jsonl");

// Whether a repository path may change in a proposal: the global instructions and the
// agent definitions. Tests are code the suite would run, so a person updates them.
export const allowedPath = (path) => path === "claude/CLAUDE.md" || /^claude\/agents\/[^/]+\.md$/.test(path);

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

// A recent proposal for the dimension that already used one of these sessions; dry runs
// and errors do not count, so the next run tries again.
export function alreadyProposed(proposals, dimension, sessionIds, now) {
  const since = now - RECENT_DAYS * 86_400_000;
  return proposals.find((proposal) => proposal.dimension === dimension && !retryable(proposal)
    && Date.parse(proposal.createdAt) >= since && proposal.sessions.some((id) => sessionIds.includes(id)));
}

// The failures whose evidence the proposer sees.
const shownFailures = (group) => group.failures.slice(0, EVIDENCE_ITEMS);

export function proposerPrompt({ group, instructions }) {
  const { dimension } = group;
  const text = section(instructions, dimension.section) ?? "(missing)";
  const evidence = shownFailures(group).map((failure) =>
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
2. Otherwise make the smallest change that fixes that cause. Prefer clarifying, replacing or deleting existing text over adding a new rule; keep the file's concise style and do not repeat rules.
3. Edit only claude/CLAUDE.md and claude/agents/*.md. Do not create or change any other file, tests included; any other change is rejected. You cannot run commands; the tool runs the tests after you finish, and if your change breaks a test that pins rule text, a person updates that test.
4. The repository is public. Write the change in general terms: never copy the evidence, commands, paths, URLs or project names into it. A change that repeats the evidence verbatim is rejected.

Reply with a short paragraph on the cause and the change, then a last line "TITLE: <imperative summary under 70 characters>". The paragraph stays private for the reviewer; the title becomes the public commit message and pull request title, so it must not quote the evidence either.`;
}

// The evidence, kept in the state folder: it quotes prompts and commands from private
// transcripts, so it never goes into a PR body, which may be public.
function evidenceMarkdown(group) {
  return [`# ${group.dimension.id}: ${group.failures.length} failing sessions`, "",
    ...group.failures.flatMap((failure) => [`- ${failure.sessionId} (${failure.project ?? "?"})`, ...failure.evidence.map((line) => `  - ${line}`)]), ""].join("\n");
}

// The public description: what failed and how the change was checked. The proposer's
// explanation, which may echo the evidence, stays in the local evidence file.
function prBody({ group, tests, evidenceName }) {
  const lines = [
    `Repeated \`${group.dimension.id}\` failures (${group.dimension.kind}) in ${group.failures.length} scored sessions, against the "${group.dimension.section}" section of \`claude/CLAUDE.md\`.`,
    "",
    "## Evidence",
    `The evidence and the proposer's explanation quote private transcripts, so they stay in the factory state folder as \`proposals/${evidenceName}\`. Sessions:`,
    ...group.failures.map((failure) => `- \`${failure.sessionId}\``),
    "",
    "## Provenance",
    `- Judge: ${[...group.judges].join(", ") || "deterministic detector"}; rubric v${RUBRIC.version}`,
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
      "max-total-usd": { type: "string", default: "10" },
      repo: { type: "string", default: REPO_ROOT },
      "board-snapshot": { type: "string" },
      "board-repo": { type: "string", default: BOARD_REPO },
      "board-base": { type: "string" },
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
  if (number("budget-usd") > number("max-total-usd"))
    throw new Error(`--budget-usd ${values["budget-usd"]} is more than --max-total-usd ${values["max-total-usd"]}, so no session could start`);
  return {
    help: values.help,
    days: number("days"),
    threshold: Math.max(1, number("threshold")),
    dimensions: values.dimension,
    model: values.model,
    effort: values.effort,
    budgetUsd: number("budget-usd"),
    maxTotalUsd: number("max-total-usd"),
    repo: values.repo,
    boardSnapshot: values["board-snapshot"],
    boardRepo: values["board-repo"],
    boardBase: values["board-base"],
    list: values.list,
    dryRun: values["dry-run"],
  };
}

// The record of a proposal attempt before it starts.
export function newRecord(group, options, now) {
  return {
    dimension: group.dimension.id,
    section: group.dimension.section,
    createdAt: new Date(now).toISOString(),
    sessions: group.failures.map((failure) => failure.sessionId),
    rubricVersion: RUBRIC.version,
    model: options.model,
    effort: options.effort,
    dryRun: options.dryRun,
    // Not under factory/: a branch named factory exists, and git cannot hold both.
    branch: `factory-proposal/${group.dimension.id}-${stamp(now)}`,
    pushed: false,
    costUSD: 0,
    paths: [],
    tests: null,
    prUrl: null,
    patchFile: null,
    evidenceFile: statePath("proposals", `${group.dimension.id}-${today(now)}-${now}.evidence.md`),
  };
}

// One proposal attempt in a fresh clone. It fills in record as it goes, so a caller
// that catches a failure still has what happened before it; returns the final record.
async function attempt(group, options, record) {
  const { branch } = record;
  writeFileSync(record.evidenceFile, evidenceMarkdown(group));
  const clone = mkdtempSync(join(tmpdir(), "claude-factory-proposal-"));
  try {
    await cloneRepository(options.repo, clone, branch);
    const instructions = readFileSync(join(clone, "claude", "CLAUDE.md"), "utf8");
    // acceptEdits confines edits to the clone: an edit elsewhere needs a permission
    // prompt, which a print session denies. Credentials stay unread whatever the
    // user's settings allow. Until the stream says what it cost, assume the budget.
    record.costUSD = options.budgetUsd;
    const gitBefore = gitState(clone);
    const task = await runTask({
      prompt: proposerPrompt({ group, instructions }),
      cwd: clone,
      model: options.model,
      effort: options.effort,
      tools: TOOLS,
      settings: proposerSettings(),
      permissionMode: "acceptEdits",
      budgetUsd: options.budgetUsd,
    });
    // A stream without a result event never said what it cost: keep the budget.
    if (resultEvent(task.events)) record.costUSD = task.costUSD;
    record.proposerOk = task.ok;
    const rejected = toolRejection(task, record);
    if (rejected) return rejected;
    // Before any git call, which would run what the session put in .git.
    if (gitState(clone) !== gitBefore) return { ...record, status: "rejected-paths", rejected: [".git"] };
    record.paths = await changedPaths(clone);
    // The change as a local patch for the reviewer; it never leaves the machine unless
    // every check below passes.
    const keepPatch = async () => {
      const patch = await stagedPatch(clone);
      writePatch(record, patch);
      return patch;
    };
    // A session that hit its budget, errored or stopped early left partial edits at best.
    if (!task.ok) {
      if (record.paths.length) await keepPatch();
      return { ...record, status: "proposer-failed", resultSubtype: resultEvent(task.events)?.subtype ?? null };
    }
    const { title, explanation } = proposerReply(task, `Address repeated ${group.dimension.id} failures`);
    Object.assign(record, { title, explanation: clip(explanation, 2000) });
    appendFileSync(record.evidenceFile, `\n## Proposer's explanation\n\n${explanation || "(none)"}\n`);
    if (!record.paths.length) return { ...record, status: "no-change" };
    const patch = await keepPatch();
    const outside = record.paths.filter((path) => !allowedPath(path));
    if (outside.length) return { ...record, status: "rejected-paths", rejected: outside };
    // The evidence quotes private transcripts; what gets pushed must not repeat it,
    // beyond text the repository already holds.
    const evidence = shownFailures(group).flatMap((failure) => failure.evidence);
    if (leakedEvidence([title, ...addedLines(patch)].join("\n"), evidence, { publicText: await originalText(clone, record.paths) }))
      return { ...record, status: "leak-suspected" };
    const tests = await runTests(clone);
    record.tests = { ok: tests.ok, command: tests.command, summary: tests.summary, ...(tests.ok ? {} : { tail: tests.tail }) };
    if (!tests.ok) return { ...record, status: "tests-failed" };
    if (options.dryRun) return { ...record, status: "dry-run" };
    const body = prBody({ group, tests, evidenceName: basename(record.evidenceFile) });
    const prUrl = await publish(clone, { branch, base: "main", title, body, onPushed: () => (record.pushed = true) });
    return { ...record, status: "proposed", prUrl };
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
  // Each qualifying source: its id, its group, and how to start and attempt it.
  const qualifying = [];
  for (const group of groups) {
    const count = group.failures.length;
    const sessions = group.failures.map((failure) => failure.sessionId);
    const previous = count >= options.threshold ? alreadyProposed(proposals, group.dimension.id, sessions, now) : null;
    const note = count < options.threshold ? "below threshold" : previous ? `already proposed ${previous.createdAt.slice(0, 10)} (${previous.status})` : "qualifies";
    console.log(`${group.dimension.id.padEnd(26)} ${String(count).padStart(3)} failing sessions  ${note}`);
    if (count >= options.threshold && !previous) qualifying.push({ id: group.dimension.id, group, start: newRecord, attempt });
  }
  let failed = 0;
  if (options.boardSnapshot) {
    // A missing snapshot means the board step failed, and the weekly report says so; a
    // damaged one fails this run, after the dimensions had their turn.
    let snapshot = null;
    let note = "no snapshot (the board step did not write one)";
    try {
      snapshot = readSnapshot(options.boardSnapshot);
    } catch (error) {
      note = error.message;
      failed++;
    }
    const candidate = snapshot ? boardCandidate(snapshot, proposals, now) : { group: null, note };
    console.log(`${BOARD_ID.padEnd(26)} ${candidate.note}`);
    if (candidate.group) qualifying.push({ id: BOARD_ID, group: candidate.group, start: newBoardRecord, attempt: attemptBoard });
  }
  if (options.list) {
    for (const { id, group } of qualifying) {
      if (id === BOARD_ID) {
        console.log(`\n## ${BOARD_ID}`);
        for (const signal of group.signals) console.log(`- signal: ${signal}`);
        for (const item of group.feedback) console.log(`- feedback ${item.id}: ${JSON.stringify(clip(item.title, 120))}`);
        continue;
      }
      console.log(`\n## ${id} (section "${group.dimension.section}")`);
      for (const failure of group.failures) console.log(`- ${failure.sessionId} (${failure.project ?? "?"}): ${failure.evidence[0] ?? ""}`);
    }
    return failed ? 1 : 0;
  }
  // Sources never attempted go first, then the longest-waiting, so the run's limit
  // cannot starve the ones at the end of the rubric while earlier ones keep retrying.
  const lastAttempt = (id) => proposals.filter((proposal) => proposal.dimension === id)
    .reduce((latest, proposal) => (proposal.createdAt > latest ? proposal.createdAt : latest), "");
  qualifying.sort((a, b) => lastAttempt(a.id).localeCompare(lastAttempt(b.id)));
  let spent = 0;
  for (const [index, source] of qualifying.entries()) {
    // A session may cost its whole budget, so start one only while that still fits.
    if (spent + options.budgetUsd > options.maxTotalUsd + 1e-9) {
      const left = qualifying.slice(index).map((each) => each.id);
      console.log(`\nStopped at the run's limit: spent $${spent.toFixed(2)} of $${options.maxTotalUsd.toFixed(2)}, and the next session may cost $${options.budgetUsd.toFixed(2)}. Not proposed this run: ${left.join(", ")}.`);
      break;
    }
    console.log(`\nProposing for ${source.id} with ${options.model} (${options.effort})${options.dryRun ? ", dry run" : ""}…`);
    const started = source.start(source.group, options, now);
    let record;
    try {
      record = await source.attempt(source.group, options, started);
    } catch (error) {
      // A failed git call, proposer run or `gh pr create` ends this source only; the
      // record says how far it got, and an error does not block the next run's retry.
      record = { ...started, branch: started.pushed ? started.branch : null, status: "error", error: error.message };
    }
    appendJsonl(proposalsFile(), record);
    spent += record.costUSD;
    if (!["proposed", "dry-run", "no-change"].includes(record.status)) failed++;
    const urls = record.prUrls?.length ? record.prUrls.join(" ") : record.prUrl;
    console.log(`  ${record.status}: ${record.title ?? record.resultSubtype ?? ""}${urls ? ` ${urls}` : ""}`);
    if (record.error) console.log(`  error: ${record.error}`);
    if (record.paths.length) console.log(`  changed: ${record.paths.join(", ")}${record.rejected ? ` (not allowed: ${record.rejected.join(", ")})` : ""}`);
    if (record.tests) console.log(`  tests: ${record.tests.summary}`);
    if (record.patchFile) console.log(`  patch: ${record.patchFile}`);
    console.log(`  cost: $${record.costUSD.toFixed(2)}`);
  }
  if (!qualifying.length) console.log("Nothing qualifies.");
  return failed ? 1 : 0;
}
