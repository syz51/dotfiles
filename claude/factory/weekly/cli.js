// weekly: the factory loop in one run (metrics, audit, scoring, the work board, the feedback
// loop, the review of main, proposals) with a summary report, and the LaunchAgent that runs it every week on this Mac.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { childEnv, runProcess } from "../../tests/lib/process.js";
import { agentStatus, installAgent, plistPath, plistText, toolPath, uninstallAgent } from "../lib/launchd.js";
import { acquireLock, readJsonl, stateDir, statePath, writeJsonAtomic } from "../lib/state.js";
import { stateDir as apiStateDir } from "../../bin/api-first.js";
import { summaryLines as boardLines } from "../board/cli.js";
import { summaryLines as evolveLines } from "../evolve/cli.js";
import { summaryLines as reviewLines } from "../review/cli.js";
import { detectorDimensions } from "../scoring/rubric.js";

// CLAUDE_FACTORY_WEEKLY_CLI replaces the factory CLI the steps run (tests use a fake).
const cli = () => process.env.CLAUDE_FACTORY_WEEKLY_CLI || join(import.meta.dir, "..", "cli.js");
export const LABEL = "com.syz51.claude-factory.weekly";
const STEP_TIMEOUT = 45 * 60 * 1000;
// Proposals run up to three sessions of 15 minutes, each followed by its tests (a cold
// agent-board build among them), so they get longer.
const PROPOSE_TIMEOUT = 150 * 60 * 1000;
// The review of main runs a review and a verify session of up to 40 and 20 minutes per
// repository, one repository after another.
const REVIEW_TIMEOUT = 150 * 60 * 1000;
const TIMEOUTS = { propose: PROPOSE_TIMEOUT, review: REVIEW_TIMEOUT };

const USAGE = `Usage: bun ~/.claude/factory/cli.js weekly <run|install|uninstall|status> [options]

  run        Run metrics, audit, scoring, the board review, the feedback loop report,
             the review of main and proposals once and write a summary
    --no-pr            Dry-run proposals (no push, no PR) and file no review findings
    --score-usd N      Total judge budget for scoring (default 4)
    --sample N         Sessions to judge (default 8)
    --notify           Post a macOS notification when done
  install    Write and load the LaunchAgent (Mondays 13:30 local time)
    --print            Print the plist instead of installing it
  uninstall  Unload and remove the LaunchAgent
  status     Show whether the LaunchAgent is loaded and the latest summary`;

// The steps of one run: [name, argv for cli.js, how to read its result]. The board step
// writes the snapshot the proposals read.
export function steps({ pr = true, scoreUsd = "4", sample = "8", boardSnapshot = join(stateDir(), "board-snapshot.json") } = {}) {
  const detectors = detectorDimensions().flatMap((dimension) => ["--dimension", dimension.id]);
  return [
    ["metrics", ["metrics", "--days", "7", "--json"], "json"],
    ["audit", ["audit", "--json", "--fail-on", "medium"], "json"],
    ["score", ["score", "--sample", sample, "--max-total-usd", scoreUsd], "text"],
    ["board", ["board", "--days", "7", "--json", "--out", boardSnapshot], "json"],
    ["evolve", ["evolve", "--days", "7", "--json"], "json"],
    // The last week of main per board repository; confirmed findings become board proposals.
    ["review", ["review", "--json", ...(pr ? [] : ["--dry-run"])], "json"],
    // Judge verdicts are not yet calibrated, so only detector dimensions and the board can
    // open PRs.
    ["propose", ["propose", ...detectors, "--board-snapshot", boardSnapshot, ...(pr ? [] : ["--dry-run"])], "text"],
  ];
}

const tail = (text, lines = 15) => text.trim().split("\n").slice(-lines).join("\n");
const usd = (value) => (typeof value === "number" ? `$${value.toFixed(2)}` : "n/a");
const pct = (value) => (typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "n/a");

// Headline lines for a step's parsed output.
function highlights(name, output) {
  if (name === "metrics") {
    const c = output.current;
    return [
      `Sessions: ${c.sessions} (${c.origin?.agent?.sessions ?? 0} launched by an agent); cost ${usd(c.cost.totalUSD)}`,
      `Merged PRs: ${c.prs.merged ?? "n/a"}; cost per merged PR ${usd(c.prs.costPerMergedUSD)} (its sessions), ${usd(c.prs.spendPerMergedUSD)} (all spend)`,
      `Correction rate (heuristic): ${pct(c.corrections.rate)}; tool error rate ${pct(c.toolErrors.main.rate)}; 429s ${c.apiErrors["429"] ?? 0}`,
    ];
  }
  if (name === "audit") {
    const open = output.findings.filter((finding) => !finding.accepted && finding.severity !== "info");
    const counts = ["high", "medium", "low"].map((severity) => `${open.filter((finding) => finding.severity === severity).length} ${severity}`);
    return [`Unaccepted findings: ${counts.join(", ")}`, ...open.filter((finding) => finding.severity === "high").map((finding) => `- ${finding.title}`)];
  }
  if (name === "board") return boardLines(output);
  if (name === "evolve") return evolveLines(output);
  if (name === "review") return reviewLines(output);
  return [];
}

// One step as a child process, so a crash in one does not stop the others.
async function runStep([name, argv, kind], env) {
  const started = Date.now();
  try {
    const result = await runProcess([process.execPath, cli(), ...argv], { env, timeout: TIMEOUTS[name] ?? STEP_TIMEOUT });
    const step = { name, code: result.code, durationMs: Date.now() - started, stderr: tail(result.stderr, 8) };
    if (kind === "json") {
      try {
        step.highlights = highlights(name, JSON.parse(result.stdout));
      } catch (error) {
        step.error = `unreadable output: ${error.message}`;
      }
    } else step.output = tail(result.stdout);
    return step;
  } catch (error) {
    return { name, code: null, durationMs: Date.now() - started, error: error.message, stderr: tail(error.stderr ?? "", 8) };
  }
}

// A step failed when it crashed or exited nonzero, except audit, whose exit 1 means it
// ran and found unaccepted findings at or above medium: that needs attention instead.
export const needsAttention = (step) => step.name === "audit" && step.code === 1 && step.error === undefined;
export const failed = (step) => step.error !== undefined || step.code === null || (step.code !== 0 && !needsAttention(step));
const stepStatus = (step) => (failed(step) ? "FAILED" : needsAttention(step) ? "ATTENTION" : "ok");

// Which billing the API-first wrapper chose for the week's print-mode calls (its
// decisions.jsonl), and the API runs the API refused, so a fallback to the subscription is
// seen.
export function billingSummary(path, since) {
  if (!existsSync(path)) return null;
  const recent = readJsonl(path).filter((entry) => Date.parse(entry.at) >= since);
  const of = (mode) => recent.filter((entry) => entry.mode === mode);
  const [fallbacks, refusals] = [of("subscription"), of("refused")];
  return { api: of("api").length, subscription: fallbacks.length, refused: refusals.length, lastFallback: fallbacks.at(-1) ?? null, lastRefusal: refusals.at(-1) ?? null };
}

function renderSummary(run) {
  const lines = [`# Factory weekly run, ${run.startedAt.slice(0, 10)}`, "", `Started ${run.startedAt}, finished ${run.finishedAt}.`, ""];
  if (run.billingError) lines.push("## Billing (last 7 days)", "", `- Unavailable: ${run.billingError}`, "");
  else if (run.billing) {
    const { api, subscription, refused, lastFallback, lastRefusal } = run.billing;
    lines.push("## Billing (last 7 days)", "", `- Print-mode calls through claude-api: ${api} started on the API, ${subscription} on the subscription.`);
    // Runs the API refused together are recorded once.
    if (lastRefusal) lines.push(`- Refusals of API runs recorded: ${refused}; the latest ${lastRefusal.at}: ${String(lastRefusal.reason ?? "no reason").replace(/\.$/, "")}.`);
    if (lastFallback) {
      const reason = String(lastFallback.reason ?? "no reason").replace(/\.$/, "");
      const advice = { exhausted: " Top up API credit that Claude Code can spend to move back.", invalid: " Replace the API key to move back." }[reason.split(/[ :]/)[0]] ?? "";
      lines.push(`- Latest fallback ${lastFallback.at}: ${reason}.${advice}`);
    }
    lines.push("");
  }
  for (const step of run.steps) {
    lines.push(`## ${step.name}: ${stepStatus(step)} (exit ${step.code ?? "none"}, ${Math.round(step.durationMs / 1000)} s)`, "");
    for (const line of step.highlights ?? []) lines.push(line.startsWith("- ") ? line : `- ${line}`);
    if (step.output) lines.push("```", step.output, "```");
    if (step.error) lines.push(`Error: ${step.error}`);
    if (failed(step) && step.stderr) lines.push("```", step.stderr, "```");
    lines.push("");
  }
  return lines.join("\n");
}


// The steps' environment: no variables of a parent Claude Code session, but the factory's
// own settings and CLAUDE_CONFIG_DIR, so the steps read the same setup as this run.
export function stepEnv(base = process.env) {
  const kept = Object.entries(base).filter(([name]) => /^(?:CLAUDE_FACTORY_\w+|CLAUDE_CONFIG_DIR)$/.test(name));
  return { ...childEnv(base), ...Object.fromEntries(kept) };
}

async function notify(title, message) {
  const quote = (text) => `"${text.replace(/["\\]/g, "\\$&")}"`;
  // The report is already written, so a failed notification is logged, not fatal.
  try {
    const shown = await runProcess(["osascript", "-e", `display notification ${quote(message)} with title ${quote(title)}`], { timeout: 10_000 });
    if (shown.code !== 0) console.error(`Notification failed (exit ${shown.code}): ${shown.stderr.trim()}`);
  } catch (error) {
    console.error(`Notification failed: ${error.message}`);
  }
}

export async function runWeekly({ pr = true, scoreUsd, sample, notifyDone = false, env = stepEnv() } = {}) {
  const lock = statePath("weekly.lock");
  if (!acquireLock(lock)) {
    console.error("Another weekly run is in progress.");
    return 3;
  }
  try {
    const run = { startedAt: new Date().toISOString(), steps: [] };
    for (const step of steps({ pr, scoreUsd, sample })) run.steps.push(await runStep(step, { ...env, CLAUDE_FACTORY_STATE: stateDir() }));
    run.finishedAt = new Date().toISOString();
    // Optional: a damaged billing log must not cost the report.
    try {
      run.billing = billingSummary(join(apiStateDir(env), "decisions.jsonl"), Date.parse(run.startedAt) - 7 * 86_400_000);
    } catch (error) {
      run.billingError = error.message;
    }
    const path = statePath("reports", `weekly-${run.startedAt.slice(0, 10)}.md`);
    writeFileSync(path, renderSummary(run));
    writeJsonAtomic(statePath("weekly-last.json"), { ...run, summary: path });
    const failures = run.steps.filter(failed).map((step) => step.name);
    const attention = run.steps.filter(needsAttention).map((step) => step.name);
    console.log(path);
    const message = [failures.length && `Failed: ${failures.join(", ")}`, attention.length && `Needs attention: ${attention.join(", ")}`].filter(Boolean).join("; ");
    if (notifyDone) await notify("Factory weekly run", message || "Report ready");
    return failures.length || attention.length ? 1 : 0;
  } finally {
    rmSync(lock, { force: true });
  }
}

// The LaunchAgent: Mondays at 13:30, after the agent-skills weekly review's Monday 09:00 slot.
// launchd runs a missed calendar job once when the Mac wakes.
export function plist({ bun = process.execPath, cli = join(homedir(), ".claude", "factory", "cli.js"), path = process.env.PATH, home = homedir(), logs = stateDir() } = {}) {
  return plistText({ label: LABEL, args: [bun, cli, "weekly", "run", "--notify"], schedule: { weekday: 1, hour: 13, minute: 30 }, path, home, logs, logName: "weekly" });
}

async function install({ print }) {
  // cargo only tests agent-board proposals; without it they fail their tests, the rest runs.
  const text = plist({ path: await toolPath({ required: ["claude", "git", "gh", "uv"], optional: ["cargo"], purpose: "the weekly run" }) });
  if (print) {
    console.log(text);
    return 0;
  }
  const code = await installAgent(LABEL, text, { logs: stateDir() });
  if (!code) console.log(`Installed ${plistPath(LABEL)}; runs Mondays at 13:30. Remove with: weekly uninstall`);
  return code;
}

async function uninstall() {
  await uninstallAgent(LABEL);
  console.log(`Removed ${plistPath(LABEL)}`);
  return 0;
}

async function status() {
  console.log(await agentStatus(LABEL));
  const last = statePath("weekly-last.json");
  if (existsSync(last)) {
    const run = JSON.parse(readFileSync(last, "utf8"));
    console.log(`Last run: ${run.startedAt}; summary ${run.summary}; failed steps: ${run.steps.filter(failed).map((step) => step.name).join(", ") || "none"}; needs attention: ${run.steps.filter(needsAttention).map((step) => step.name).join(", ") || "none"}`);
  } else console.log("Last run: none");
  return 0;
}

export async function run(argv) {
  const [command, ...rest] = argv;
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      strict: true,
      options: {
        "no-pr": { type: "boolean", default: false },
        "score-usd": { type: "string", default: "4" },
        sample: { type: "string", default: "8" },
        notify: { type: "boolean", default: false },
        print: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    }));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  for (const name of ["score-usd", "sample"])
    if (!(Number(values[name]) > 0)) {
      console.error(`--${name} must be a positive number`);
      return 2;
    }
  switch (command) {
    case "run":
      return runWeekly({ pr: !values["no-pr"], scoreUsd: values["score-usd"], sample: values.sample, notifyDone: values.notify });
    case "install":
      return install({ print: values.print });
    case "uninstall":
      return uninstall();
    case "status":
      return status();
    default:
      console.error(`Unknown weekly command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

// Exposed for tests.
export const internal = { renderSummary, highlights, acquireLock };
