// `board`: the work board's week for the factory's review. It asks the `board` CLI for the
// server's stats and for the open tasks agents filed with `board feedback`, writes them as
// a snapshot that `propose --board-snapshot` reads, and prints a summary. A failed `board`
// call is reported and makes the command exit 1; the snapshot then holds what did work.
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { childEnv, runProcess } from "../../tests/lib/process.js";
import { clip } from "../lib/proposal.js";
import { statePath, writeJsonAtomic } from "../lib/state.js";

const USAGE = `Usage: bun ~/.claude/factory/cli.js board [options]

Collects the work board's stats and open feedback tasks for the weekly review.

  --days N      stats window in days (default 7)
  --out PATH    snapshot file (default: board-snapshot.json in the state folder)
  --json        print the snapshot as JSON
  --help`;

// CLAUDE_FACTORY_BOARD replaces the board CLI (tests use a fake).
export const boardBin = () => process.env.CLAUDE_FACTORY_BOARD || join(homedir(), ".cargo", "bin", "board");
// The board `board feedback` files on unless a device configures another.
export const FEEDBACK_BOARD = "board-feedback";
const CLOSED = new Set(["done", "dropped"]);
// The most tasks the server returns at once.
const LIST_LIMIT = 1000;
const STAT_FIELDS = ["days", "tasks_created", "tasks_done", "claims_refused", "tasks_taken_stale", "lease_conflicts", "asks_created", "asks_answered", "done_without_check_evidence"];

// One board call's JSON, or an error naming the call.
// what names the call in errors; the default, the whole command line, suits short calls.
export async function call(args, { what = `board ${args.join(" ")}` } = {}) {
  const argv = [boardBin(), ...args];
  let result;
  try {
    result = await runProcess(argv, { env: childEnv(process.env), timeout: 60_000 });
  } catch (error) {
    throw new Error(`${what}: ${error.message}`);
  }
  if (result.code !== 0) throw new Error(`${what} exited ${result.code}: ${clip(result.stderr.trim() || result.stdout.trim(), 300) || "no output"}`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${what}: unreadable output: ${error.message}`);
  }
}

function checkStats(stats) {
  const bad = STAT_FIELDS.filter((field) => typeof stats?.[field] !== "number");
  if (bad.length) throw new Error(`board stats: missing or non-numeric ${bad.join(", ")}`);
  return stats;
}

function checkFeedback(tasks) {
  if (!Array.isArray(tasks) || tasks.some((task) => typeof task?.id !== "string" || typeof task.title !== "string" || typeof task.status !== "string"))
    throw new Error("board ls: expected a list of tasks with id, title and status");
  // The server lists closed tasks too, in no promised order: a full page may hide open ones.
  if (tasks.length >= LIST_LIMIT) throw new Error(`board ls: ${tasks.length} tasks on ${FEEDBACK_BOARD}, the most one call returns, so open feedback may be missing; close or drop old feedback`);
  return tasks.filter((task) => !CLOSED.has(task.status))
    .map(({ id, title, body, status, created_at, updated_at }) => ({ id, title, body: typeof body === "string" ? body : "", status, created_at, updated_at }));
}

export async function collect({ days }) {
  const snapshot = { collectedAt: new Date().toISOString(), days, stats: null, feedback: null, errors: [] };
  const [stats, feedback] = await Promise.allSettled([
    call(["stats", "--days", String(days), "--json"]).then(checkStats),
    call(["ls", "--board", FEEDBACK_BOARD, "--json", "--limit", String(LIST_LIMIT)]).then(checkFeedback),
  ]);
  if (stats.status === "fulfilled") snapshot.stats = stats.value;
  else snapshot.errors.push(stats.reason.message);
  if (feedback.status === "fulfilled") snapshot.feedback = feedback.value;
  else snapshot.errors.push(feedback.reason.message);
  return snapshot;
}

const minutes = (value) => (typeof value === "number" ? `${Math.round(value)} min` : "n/a");

// The stats as lines, for the weekly report and the public PR body.
export const statsLines = (s) => [
  `Tasks: ${s.tasks_created} created, ${s.tasks_done} done (${s.done_without_check_evidence} without check evidence); median ${minutes(s.doing_minutes_median)} in doing`,
  `Claims refused ${s.claims_refused}; tasks taken from stale owners ${s.tasks_taken_stale}; lease conflicts ${s.lease_conflicts}`,
  `Asks: ${s.asks_answered} of ${s.asks_created} answered; median answer ${minutes(s.ask_answer_minutes_median)}`,
];

// Summary lines of a snapshot; feedback titles are agent-written, so they appear quoted.
export function summaryLines(snapshot) {
  const lines = snapshot.stats ? statsLines(snapshot.stats) : [];
  if (snapshot.feedback) {
    lines.push(`Open feedback tasks: ${snapshot.feedback.length}`);
    for (const task of snapshot.feedback.slice(0, 10)) lines.push(`- ${task.id}: ${JSON.stringify(clip(task.title, 100))}`);
    if (snapshot.feedback.length > 10) lines.push(`- … and ${snapshot.feedback.length - 10} more`);
  }
  for (const error of snapshot.errors ?? []) lines.push(`Failed: ${error}`);
  return lines;
}

export async function run(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, options: {
      days: { type: "string", default: "7" },
      out: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    } }));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    console.error("--days must be a whole number from 1 to 365");
    return 2;
  }
  const out = values.out ?? statePath("board-snapshot.json");
  // A snapshot from an earlier run must not stand in for this one.
  if (existsSync(out)) rmSync(out);
  const snapshot = await collect({ days });
  writeJsonAtomic(out, snapshot);
  if (values.json) console.log(JSON.stringify(snapshot));
  else console.log([...summaryLines(snapshot), `Snapshot: ${out}`].join("\n"));
  for (const error of snapshot.errors) console.error(error);
  return snapshot.errors.length ? 1 : 0;
}
