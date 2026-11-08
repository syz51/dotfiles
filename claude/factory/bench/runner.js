// One benchmark run: a fresh fixture, a Claude Code session with installs and web access
// blocked, then the case's oracle. Plus the scheduler that runs a matrix within a
// parallel limit and a total budget.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCallError, claudeBin, runTask } from "../lib/claude.js";
import { claudeTempDir, removeSessionArtifacts } from "../../tests/lib/cleanup.js";
import { childEnv, runProcess } from "../../tests/lib/process.js";
import { resultEvent } from "../../tests/lib/stream.js";
import { applyOverlay, materialize, writeAgentOverride } from "./cases.js";

const CLAUDE_ROOT = join(import.meta.dir, "..", "..");
export const AGENTS_DIR = join(CLAUDE_ROOT, "agents");
const BLOCK_HOOK = join(CLAUDE_ROOT, "tests", "lib", "hooks", "block-installs.js");
const TAIL = 2000;
const tail = (text) => text.length > TAIL ? text.slice(-TAIL) : text;

// Keeps fixture tasks offline, as in the live suites.
const OFFLINE = { UV_OFFLINE: "1", UV_PYTHON_DOWNLOADS: "never", CARGO_NET_OFFLINE: "true", PYTHONDONTWRITEBYTECODE: "1" };

// Main-session tools a spawned subagent does not get (Claude Code 2.1.319). A subagent
// role runs as the main session with --agent, so they are denied to match.
export const MAIN_ONLY_TOOLS = ["ScheduleWakeup", "Workflow"];

// Settings passed with --settings: the live suites' install and download hook, web tools
// denied outright, and for a subagent role the main-session-only tools.
export const benchSettings = ({ subagent = false } = {}) => ({
  permissions: { deny: ["WebFetch", "WebSearch", ...(subagent ? MAIN_ONLY_TOOLS : [])] },
  hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `"${process.execPath}" "${BLOCK_HOOK}"` }] }] },
});

export async function cliVersion() {
  const bin = claudeBin();
  const run = await runProcess([bin, "--version"], { env: childEnv(process.env), timeout: 30_000 });
  return run.stdout.trim().split("\n")[0] || null;
}

// Runs the oracle with sh -c in cwd after restoring the overlay, so a session that edited
// the case's tests cannot pass by it. Exit 0 passes; a timeout fails with exit null.
export async function runOracle(oracle, cwd, finalAnswerFile, fixture = {}) {
  applyOverlay(fixture, cwd);
  const env = childEnv(process.env, { ...OFFLINE, FINAL_ANSWER_FILE: finalAnswerFile });
  try {
    const run = await runProcess(["sh", "-c", oracle.command], { cwd, env, timeout: oracle.timeoutMs, maxBytes: 8 * 1024 * 1024 });
    return { exit: run.code, output: tail(`${run.stdout}${run.stderr}`), timedOut: false };
  } catch (error) {
    if (!/^Process timeout/.test(error.message ?? "")) throw error;
    return { exit: null, output: tail(`${error.stdout ?? ""}${error.stderr ?? ""}\n[oracle timed out after ${oracle.timeoutMs} ms]`), timedOut: true };
  }
}

// Models of the main thread's assistant messages, most used first.
export function observedModels(events) {
  const counts = new Map();
  for (const event of events)
    if (event.type === "assistant" && !event.parent_tool_use_id && event.message?.model)
      counts.set(event.message.model, (counts.get(event.message.model) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([model]) => model);
}

// Whether a session ran the model and effort it was asked for: { efforts, problem }, the
// efforts its transcript recorded, most used first, and why the run is not that
// configuration, or null.
export function configProblem(task, models, { model, effort }) {
  const efforts = Object.entries(task.efforts ?? {}).sort((a, b) => b[1] - a[1]).map(([name]) => name);
  let problem = null;
  if (efforts.length && (efforts.length > 1 || efforts[0] !== effort)) problem = `requested effort ${effort} but the session ran ${efforts.join(", ")}`;
  else if (!efforts.length && task.ok) problem = "the session's transcript recorded no effort, so the requested effort is unverified";
  // A dated model ID (requested-YYYYMMDD) is the requested model.
  if (models.length && (models.length > 1 || (models[0] !== model && !models[0].startsWith(`${model}-`)))) problem = `requested ${model} but the session ran ${models.join(", ")}`;
  return { efforts, problem };
}

// Runs one configuration of a case and returns its results record. Infrastructure
// failures (no stream, API errors, the wrong model or effort) are marked infra, so reports leave
// them out; fixture errors throw.
export async function runOne(benchCase, { model, effort, trial, runId, batch, cliVersion: version = null, agentsDir = AGENTS_DIR }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `claude-bench-${benchCase.id}-`)));
  const workspace = join(root, "workspace");
  const at = new Date().toISOString();
  const record = {
    runId, batch, caseId: benchCase.id, role: benchCase.role, model, modelObserved: null, effort, effortObserved: null, trial,
    pass: false, oracleExit: null, oracleOutput: "", costUSD: null, durationMs: null, turns: null,
    error: null, infra: false, at, cliVersion: version,
  };
  try {
    materialize(benchCase, workspace);
    const agent = benchCase.role === "main" ? undefined : benchCase.role;
    if (agent) writeAgentOverride(workspace, agent, { model, effort }, agentsDir);
    const settings = join(root, "settings.json");
    writeFileSync(settings, JSON.stringify(benchSettings({ subagent: !!agent })));
    const finalAnswerFile = join(root, "final-answer.txt");
    const started = Date.now();
    let task;
    try {
      // --model and --effort as well as the override: with --agent, Claude Code takes the
      // agent's model but not its effort for the main session. The effort each request
      // ran at is read from the session's transcript, which runTask then deletes.
      task = await runTask({
        prompt: benchCase.prompt, cwd: workspace, model, effort, agent, settings, readEffort: true,
        budgetUsd: benchCase.budgetUsd, timeoutMs: benchCase.timeoutMs,
        env: { ...OFFLINE, CLAUDE_CODE_TMPDIR: root, TMPDIR: root },
      });
    } catch (error) {
      if (!(error instanceof ClaudeCallError)) throw error;
      Object.assign(record, { durationMs: Date.now() - started, error: `${error.message}: ${error.stderr}`.trim(), infra: true });
      return record;
    }
    const final = resultEvent(task.events);
    const models = observedModels(task.events);
    // A killed session rarely got to write its result event; then the cost is unknown.
    Object.assign(record, { modelObserved: models.join(",") || null, costUSD: final ? task.costUSD : null, durationMs: task.durationMs, turns: task.turns });
    if (task.timedOut) record.error = `session timed out after ${benchCase.timeoutMs} ms`;
    else if (!task.ok) {
      // A "success" result flagged is_error is how Claude Code reports failures such as
      // a missing login; limits (budget, turns) end with their own subtypes.
      const detail = !final ? `exit ${task.code} and no result`
        : final.subtype === "success" ? `an error result: ${String(final.result ?? "").slice(0, 200)}` : final.subtype;
      record.error = `session ended with ${detail}${final?.api_error_status ? ` (HTTP ${final.api_error_status})` : ""}`;
      record.infra = !final || !!final.api_error_status || final.subtype === "success";
    }
    const config = configProblem(task, models, { model, effort });
    record.effortObserved = config.efforts.join(",") || null;
    if (config.problem) Object.assign(record, { error: config.problem, infra: true });
    writeFileSync(finalAnswerFile, task.finalText);
    const oracle = await runOracle(benchCase.oracle, workspace, finalAnswerFile, benchCase.fixture);
    record.oracleExit = oracle.exit;
    record.oracleOutput = oracle.output;
    record.pass = task.ok && !record.error && oracle.exit === 0;
    return record;
  } finally {
    removeSessionArtifacts({ bases: [join(homedir(), ".claude", "projects"), claudeTempDir()], roots: [root] });
    rmSync(root, { recursive: true, force: true });
  }
}

// Runs jobs (each with budgetUsd) through execute, at most parallel at a time. A job
// starts only while spent plus the budgets of running jobs plus its own budget stays
// within maxTotalUsd; otherwise it waits for running jobs, and stops when none are left.
// A run of unknown cost counts its whole budget. An execute error stops new starts and
// is rethrown once running jobs finish.
export async function runMatrix(jobs, { parallel = 1, maxTotalUsd = Infinity, execute, onRecord = () => {} }) {
  const running = new Set();
  const records = [];
  let spent = 0;
  let reserved = 0;
  let failure = null;
  let skipped = 0;
  for (const [index, job] of jobs.entries()) {
    while (!failure && (running.size >= parallel || spent + reserved + job.budgetUsd > maxTotalUsd + 1e-9) && running.size)
      await Promise.race(running);
    if (failure || spent + reserved + job.budgetUsd > maxTotalUsd + 1e-9) {
      skipped = jobs.length - index;
      break;
    }
    reserved += job.budgetUsd;
    const promise = execute(job)
      .then((record) => {
        spent += record.costUSD ?? job.budgetUsd;
        records.push(record);
        onRecord(record);
      }, (error) => {
        spent += job.budgetUsd;
        failure ??= error;
      })
      .finally(() => {
        reserved -= job.budgetUsd;
        running.delete(promise);
      });
    running.add(promise);
  }
  await Promise.all(running);
  if (failure) throw failure;
  return { records, spent, skipped };
}
