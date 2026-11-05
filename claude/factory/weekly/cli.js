// weekly: the factory loop in one run (metrics, audit, scoring, proposals) with a summary
// report, and the LaunchAgent that runs it every week on this Mac.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { childEnv, runProcess } from "../../tests/lib/process.js";
import { stateDir, statePath, writeJsonAtomic } from "../lib/state.js";
import { detectorDimensions } from "../scoring/rubric.js";

// CLAUDE_FACTORY_WEEKLY_CLI replaces the factory CLI the steps run (tests use a fake).
const cli = () => process.env.CLAUDE_FACTORY_WEEKLY_CLI || join(import.meta.dir, "..", "cli.js");
export const LABEL = "com.syz51.claude-factory.weekly";
const STEP_TIMEOUT = 45 * 60 * 1000;

const USAGE = `Usage: bun ~/.claude/factory/cli.js weekly <run|install|uninstall|status> [options]

  run        Run metrics, audit, scoring and proposals once and write a summary
    --no-pr            Dry-run proposals (no push, no PR)
    --score-usd N      Total judge budget for scoring (default 3)
    --sample N         Sessions to judge (default 8)
    --notify           Post a macOS notification when done
  install    Write and load the LaunchAgent (Mondays 13:30 local time)
    --print            Print the plist instead of installing it
  uninstall  Unload and remove the LaunchAgent
  status     Show whether the LaunchAgent is loaded and the latest summary`;

// The steps of one run: [name, argv for cli.js, how to read its result].
export function steps({ pr = true, scoreUsd = "3", sample = "8" } = {}) {
  const detectors = detectorDimensions().flatMap((dimension) => ["--dimension", dimension.id]);
  return [
    ["metrics", ["metrics", "--days", "7", "--json"], "json"],
    ["audit", ["audit", "--json", "--fail-on", "medium"], "json"],
    ["score", ["score", "--sample", sample, "--max-total-usd", scoreUsd], "text"],
    // Judge verdicts are not yet calibrated, so only detector dimensions can open PRs.
    ["propose", ["propose", ...detectors, ...(pr ? [] : ["--dry-run"])], "text"],
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
  return [];
}

// One step as a child process, so a crash in one does not stop the others.
async function runStep([name, argv, kind], env) {
  const started = Date.now();
  try {
    const result = await runProcess([process.execPath, cli(), ...argv], { env, timeout: STEP_TIMEOUT });
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

// A step failed when it crashed or exited nonzero, except audit, whose exit 1 only means
// it found unaccepted findings (reported in the summary).
export const failed = (step) => step.error !== undefined || step.code === null || (step.code !== 0 && !(step.name === "audit" && step.code === 1));

function renderSummary(run) {
  const lines = [`# Factory weekly run, ${run.startedAt.slice(0, 10)}`, "", `Started ${run.startedAt}, finished ${run.finishedAt}.`, ""];
  for (const step of run.steps) {
    lines.push(`## ${step.name}: ${failed(step) ? "FAILED" : "ok"} (exit ${step.code ?? "none"}, ${Math.round(step.durationMs / 1000)} s)`, "");
    for (const line of step.highlights ?? []) lines.push(line.startsWith("- ") ? line : `- ${line}`);
    if (step.output) lines.push("```", step.output, "```");
    if (step.error) lines.push(`Error: ${step.error}`);
    if (failed(step) && step.stderr) lines.push("```", step.stderr, "```");
    lines.push("");
  }
  return lines.join("\n");
}

// A lock file holding the running process id; a stale one (dead process) is taken over.
function acquireLock(path) {
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, "utf8"));
    try {
      if (pid) {
        process.kill(pid, 0);
        return false;
      }
    } catch {
      // The holder is gone.
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(process.pid));
  return true;
}

async function notify(title, message) {
  const quote = (text) => `"${text.replace(/["\\]/g, "\\$&")}"`;
  await runProcess(["osascript", "-e", `display notification ${quote(message)} with title ${quote(title)}`], { timeout: 10_000 }).catch(() => {});
}

export async function runWeekly({ pr = true, scoreUsd, sample, notifyDone = false, env = childEnv(process.env) } = {}) {
  const lock = statePath("weekly.lock");
  if (!acquireLock(lock)) {
    console.error("Another weekly run is in progress.");
    return 3;
  }
  try {
    const run = { startedAt: new Date().toISOString(), steps: [] };
    for (const step of steps({ pr, scoreUsd, sample })) run.steps.push(await runStep(step, { ...env, CLAUDE_FACTORY_STATE: stateDir() }));
    run.finishedAt = new Date().toISOString();
    const path = statePath("reports", `weekly-${run.startedAt.slice(0, 10)}.md`);
    writeFileSync(path, renderSummary(run));
    writeJsonAtomic(statePath("weekly-last.json"), { ...run, summary: path });
    const failures = run.steps.filter(failed).map((step) => step.name);
    console.log(path);
    if (notifyDone) await notify("Factory weekly run", failures.length ? `Failed: ${failures.join(", ")}` : "Report ready");
    return failures.length ? 1 : 0;
  } finally {
    rmSync(lock, { force: true });
  }
}

const xml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The LaunchAgent: Mondays at 13:30, after the codex-skills daily review's 09:00 slot.
// launchd runs a missed calendar job once when the Mac wakes.
export function plist({ bun = process.execPath, cli = join(homedir(), ".claude", "factory", "cli.js"), path = process.env.PATH, home = homedir(), logs = stateDir() } = {}) {
  const strings = (items) => items.map((item) => `\t\t<string>${xml(item)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${strings([bun, cli, "weekly", "run", "--notify"])}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>HOME</key>
\t\t<string>${xml(home)}</string>
\t\t<key>PATH</key>
\t\t<string>${xml(path)}</string>
\t</dict>
\t<key>StartCalendarInterval</key>
\t<dict>
\t\t<key>Weekday</key>
\t\t<integer>1</integer>
\t\t<key>Hour</key>
\t\t<integer>13</integer>
\t\t<key>Minute</key>
\t\t<integer>30</integer>
\t</dict>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>StandardOutPath</key>
\t<string>${xml(join(logs, "weekly-launchd.log"))}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(join(logs, "weekly-launchd-error.log"))}</string>
</dict>
</plist>
`;
}

const agentsDir = () => process.env.CLAUDE_FACTORY_LAUNCH_AGENTS || join(homedir(), "Library", "LaunchAgents");
const plistPath = () => join(agentsDir(), `${LABEL}.plist`);
const launchctl = (args) => runProcess([process.env.CLAUDE_FACTORY_LAUNCHCTL || "launchctl", ...args], { timeout: 30_000 });
const domain = () => `gui/${userInfo().uid}`;

// The tools a run needs, found on this PATH, so launchd's minimal PATH can reach them.
async function toolPath() {
  const dirs = new Set();
  for (const tool of ["claude", "git", "gh", "uv"]) {
    const found = await runProcess(["/usr/bin/which", tool], { timeout: 10_000 });
    if (found.code !== 0) throw new Error(`${tool} is not on PATH; install it before scheduling the weekly run`);
    dirs.add(dirname(found.stdout.trim()));
  }
  return [...dirs, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
}

async function install({ print }) {
  const text = plist({ path: await toolPath() });
  if (print) {
    console.log(text);
    return 0;
  }
  mkdirSync(stateDir(), { recursive: true });
  mkdirSync(agentsDir(), { recursive: true });
  // Replace a loaded copy; bootout fails harmlessly when none is loaded.
  await launchctl(["bootout", `${domain()}/${LABEL}`]);
  writeFileSync(plistPath(), text);
  const loaded = await launchctl(["bootstrap", domain(), plistPath()]);
  if (loaded.code !== 0) {
    console.error(`launchctl bootstrap failed (exit ${loaded.code}): ${loaded.stderr.trim()}`);
    return 1;
  }
  console.log(`Installed ${plistPath()}; runs Mondays at 13:30. Remove with: weekly uninstall`);
  return 0;
}

async function uninstall() {
  await launchctl(["bootout", `${domain()}/${LABEL}`]);
  rmSync(plistPath(), { force: true });
  console.log(`Removed ${plistPath()}`);
  return 0;
}

async function status() {
  const loaded = await launchctl(["print", `${domain()}/${LABEL}`]);
  console.log(`LaunchAgent: ${existsSync(plistPath()) ? plistPath() : "not installed"}; ${loaded.code === 0 ? "loaded" : "not loaded"}`);
  const last = statePath("weekly-last.json");
  if (existsSync(last)) {
    const run = JSON.parse(readFileSync(last, "utf8"));
    console.log(`Last run: ${run.startedAt}; summary ${run.summary}; failed steps: ${run.steps.filter(failed).map((step) => step.name).join(", ") || "none"}`);
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
        "score-usd": { type: "string", default: "3" },
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
