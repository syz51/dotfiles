// `evolve`: how the feedback loop moved, per setup. Triage resolves feedback items within
// minutes (routed, duplicate, forwarded or declined) and closes them, so open feedback no
// longer shows the loop's health; this reads every item's `feedback` record from the
// feedback board, and each routed item's owner task, and reports per setup what came in,
// what waits for triage or for its owner, and what got fixed or came back.
// A failed `board` call is reported and makes the command exit 1; the report then holds
// what did work.
import { parseArgs } from "node:util";
import { call, FEEDBACK_BOARD } from "../board/cli.js";
import { clip } from "../lib/proposal.js";
import { loadSetups } from "../setups/cli.js";

const USAGE = `Usage: bun ~/.claude/factory/cli.js evolve [options]

Reports the feedback loop per setup: items and reports in the window, untriaged items,
routed items whose owner task is still open, items fixed, recurrences and declined items
that kept getting reports.

  --days N      window in days (default 7)
  --json        print the report as JSON
  --help`;

const CLOSED = new Set(["done", "dropped"]);
const SOURCES = ["agent", "capture", "signal"];
const LIST_LIMIT = 1000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Triage runs within minutes; an item older than this without a resolution was missed.
const UNTRIAGED_AFTER = HOUR;
// Owner tasks looked up at once.
const LOOKUPS = 8;

const string = (value) => typeof value === "string";
const time = (value) => (string(value) ? Date.parse(value) : NaN);

// The board's tasks, checked: every task needs id, title and status, and a `feedback`
// record, when present, its fields as the server writes them. Tasks filed before the
// server kept feedback records have none and are only counted.
export function checkTasks(tasks) {
  if (!Array.isArray(tasks)) throw new Error("board ls: expected a list of tasks");
  for (const task of tasks) {
    if (![task?.id, task?.title, task?.status].every(string)) throw new Error("board ls: expected tasks with id, title and status");
    const feedback = task.feedback;
    if (feedback === undefined || feedback === null) continue;
    const resolution = feedback.resolution;
    const valid = string(feedback.about) && string(feedback.source) && Number.isInteger(feedback.reports) && !Number.isNaN(time(feedback.last_reported_at))
      && (resolution === undefined || resolution === null || (string(resolution.kind) && !Number.isNaN(time(resolution.at))))
      && (feedback.recurs === undefined || feedback.recurs === null || string(feedback.recurs));
    if (!valid) throw new Error(`board ls: ${task.id} has an unreadable feedback record`);
  }
  return tasks;
}

// Each owner task's status and last update, by id; a failed lookup is an error and leaves
// its owner unknown.
async function owners(ids, errors) {
  const found = new Map();
  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        const detail = await call(["show", id, "--json"]);
        if (!string(detail?.task?.status)) throw new Error(`board show ${id}: expected a task with a status`);
        found.set(id, { status: detail.task.status, updatedAt: detail.task.updated_at });
      } catch (error) {
        errors.push(error.message);
      }
    }
  };
  await Promise.all(Array.from({ length: LOOKUPS }, worker));
  return found;
}

// The report for tasks on the feedback board, given their routed owners' states.
// Window counts (items, reports, sources, recurrences, declined items reported again, fixed)
// cover items active in the last `days`; untriaged and routed-open items count at any age,
// since they are what still waits.
export function report(tasks, ownerStates, { days, now = Date.now(), setups = [] }) {
  const since = now - days * DAY;
  const titles = new Map(setups.map((setup) => [setup.id, setup.title]));
  const rows = new Map();
  const row = (about) => {
    if (!rows.has(about))
      rows.set(about, { id: about, title: titles.get(about) ?? null, items: 0, reports: 0, sources: Object.fromEntries(SOURCES.map((source) => [source, 0])),
        untriaged: [], routedOpen: [], fixed: 0, recurrences: 0, declinedWithReports: [] });
    return rows.get(about);
  };
  let legacy = 0;
  for (const task of tasks) {
    const feedback = task.feedback;
    if (!feedback) {
      legacy += 1;
      continue;
    }
    const resolution = feedback.resolution ?? null;
    const lastReported = time(feedback.last_reported_at);
    const active = Math.max(time(task.created_at) || 0, lastReported, resolution ? time(resolution.at) : 0) >= since;
    const entry = row(feedback.about);
    if (active) {
      entry.items += 1;
      entry.reports += feedback.reports;
      entry.sources[feedback.source] = (entry.sources[feedback.source] ?? 0) + 1;
      if (feedback.recurs) entry.recurrences += 1;
      if (resolution?.kind === "declined" && lastReported > time(resolution.at) && lastReported >= since)
        entry.declinedWithReports.push({ id: task.id, reports: feedback.reports });
    }
    const created = time(task.created_at);
    if (!resolution && !CLOSED.has(task.status) && now - created > UNTRIAGED_AFTER)
      entry.untriaged.push({ id: task.id, ageHours: Math.floor((now - created) / HOUR) });
    if (resolution?.kind === "routed" && resolution.task) {
      const owner = ownerStates.get(resolution.task);
      if (!owner) continue;
      if (!CLOSED.has(owner.status)) entry.routedOpen.push({ id: task.id, task: resolution.task, status: owner.status, ageDays: Math.floor((now - time(resolution.at)) / DAY) });
      else if (owner.status === "done" && time(owner.updatedAt) >= since) entry.fixed += 1;
    }
  }
  // Registry order first, then setups the registry does not name.
  const order = (id) => {
    const index = setups.findIndex((setup) => setup.id === id);
    return index === -1 ? setups.length : index;
  };
  const list = [...rows.values()]
    .filter((entry) => entry.items || entry.untriaged.length || entry.routedOpen.length || entry.fixed)
    .sort((a, b) => order(a.id) - order(b.id) || a.id.localeCompare(b.id));
  for (const entry of list) {
    entry.untriaged.sort((a, b) => b.ageHours - a.ageHours);
    entry.routedOpen.sort((a, b) => b.ageDays - a.ageDays);
  }
  const sum = (pick) => list.reduce((total, entry) => total + pick(entry), 0);
  const totals = { items: sum((e) => e.items), reports: sum((e) => e.reports), untriaged: sum((e) => e.untriaged.length), routedOpen: sum((e) => e.routedOpen.length),
    fixed: sum((e) => e.fixed), recurrences: sum((e) => e.recurrences), declinedWithReports: sum((e) => e.declinedWithReports.length) };
  return { days, totals, setups: list, legacy };
}

export async function collect({ days }) {
  const result = { collectedAt: new Date().toISOString(), days, totals: null, setups: null, legacy: 0, errors: [] };
  let setups = [];
  // Titles only label the report; a broken registry costs them, not the report.
  try {
    setups = loadSetups(undefined, { paths: false });
  } catch (error) {
    result.errors.push(`setups: ${error.message}`);
  }
  let tasks;
  try {
    tasks = checkTasks(await call(["ls", "--board", FEEDBACK_BOARD, "--json", "--limit", String(LIST_LIMIT)]));
  } catch (error) {
    result.errors.push(error.message);
    return result;
  }
  if (tasks.length >= LIST_LIMIT) result.errors.push(`board ls: ${tasks.length} tasks on ${FEEDBACK_BOARD}, the most one call returns, so items may be missing`);
  const routed = new Set(tasks.map((task) => task.feedback?.resolution).filter((resolution) => resolution?.kind === "routed" && resolution.task).map((resolution) => resolution.task));
  const ownerStates = await owners(routed, result.errors);
  return { ...result, ...report(tasks, ownerStates, { days, setups }) };
}

const ids = (list, render) => list.slice(0, 3).map(render).join(", ") + (list.length > 3 ? `, … ${list.length - 3} more` : "");

// Summary lines of a report, for the console and the weekly summary. Titles come from the
// registry; ids from the board.
export function summaryLines(result) {
  const lines = [];
  if (result.totals) {
    const t = result.totals;
    lines.push(`Feedback in the last ${result.days} days: ${t.items} items, ${t.reports} reports; untriaged ${t.untriaged}; routed and open ${t.routedOpen}; fixed ${t.fixed}; recurrences ${t.recurrences}; declined but reported again ${t.declinedWithReports}`);
    for (const s of result.setups) {
      const parts = [`${s.items} items, ${s.reports} reports (${SOURCES.map((source) => `${source} ${s.sources[source] ?? 0}`).join(", ")})`];
      if (s.untriaged.length) parts.push(`untriaged ${s.untriaged.length}: ${ids(s.untriaged, (item) => `${item.id} ${item.ageHours} h`)}`);
      if (s.routedOpen.length) parts.push(`routed and open ${s.routedOpen.length}: ${ids(s.routedOpen, (item) => `${item.task} ${item.status} ${item.ageDays} d`)}`);
      if (s.fixed) parts.push(`fixed ${s.fixed}`);
      if (s.recurrences) parts.push(`recurrences ${s.recurrences}`);
      if (s.declinedWithReports.length) parts.push(`declined but reported again ${s.declinedWithReports.length}: ${ids(s.declinedWithReports, (item) => item.id)}`);
      lines.push(`- ${s.id}${s.title ? ` (${clip(s.title, 60)})` : " (not in setups.toml)"}: ${parts.join("; ")}`);
    }
    if (result.legacy) lines.push(`Tasks without a feedback record (filed before the server kept them): ${result.legacy}`);
  }
  for (const error of result.errors ?? []) lines.push(`Failed: ${error}`);
  return lines;
}

export async function run(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, options: {
      days: { type: "string", default: "7" },
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
  const result = await collect({ days });
  if (values.json) console.log(JSON.stringify(result));
  else console.log(summaryLines(result).join("\n"));
  for (const error of result.errors) console.error(error);
  return result.errors.length ? 1 : 0;
}
