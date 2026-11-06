// metrics: cost, effort and quality of Claude Code and Codex sessions in a window,
// compared with the window before it, overall, per project and per pull request.
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadCodexSessions } from "../lib/codex.js";
import { litellmFetchedAt, refreshLitellm } from "../lib/litellm.js";
import { priceSource } from "../lib/pricing.js";
import { appendJsonl, readJsonl, stateDir, statePath, writeJsonAtomic } from "../lib/state.js";
import { loadSessions, mostCommon } from "../lib/transcripts.js";
import { countCorrections } from "./corrections.js";
import { findReverts, lookupPrs } from "./github.js";
import { renderHistory, renderMarkdown } from "./markdown.js";
import { sessionPrs, sessionPushes } from "./prs.js";
import { attributePrs, windowStats } from "./stats.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Claude Code deletes transcripts older than this.
const RETENTION_DAYS = 30;
const HISTORY = "metrics-history.jsonl";

const USAGE = `Usage: bun ~/.claude/factory/cli.js metrics [options]

Cost, effort and quality of Claude Code and Codex sessions, compared with the previous
window. Codex sessions come from \$CODEX_HOME/sessions (default ~/.codex/sessions).

  --days N              Window length in days, ending now (default 7)
  --since ISO           Window start (instead of --days)
  --until ISO           Window end (default now)
  --project TEXT        Only projects whose folder or working directory contains TEXT
  --include-automation  Include automation sessions (excluded by default)
  --no-gh               Skip GitHub lookups (PR state, reverts, and refreshing LiteLLM's
                        price list for models missing from the price table)
  --json                Print the JSON report instead of the Markdown path
  --out DIR             Report folder (default: the state folder's reports/)
  --history             Print the trend of earlier runs and exit
  --help                Show this help`;

class UsageError extends Error {}

function parseArgs(argv) {
  const options = { gh: true, includeAutomation: false, json: false, history: false };
  const value = (name, index) => {
    if (index + 1 >= argv.length) throw new UsageError(`${name} needs a value`);
    return argv[index + 1];
  };
  const time = (name, text) => {
    const ms = Date.parse(text);
    if (!Number.isFinite(ms)) throw new UsageError(`${name} is not a date: ${text}`);
    return ms;
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--days": {
        const days = Number(value(arg, index++));
        if (!(days > 0)) throw new UsageError("--days must be a positive number");
        options.days = days;
        break;
      }
      case "--since":
        options.since = time(arg, value(arg, index++));
        break;
      case "--until":
        options.until = time(arg, value(arg, index++));
        break;
      case "--project":
        options.project = value(arg, index++);
        break;
      case "--out":
        options.out = value(arg, index++);
        break;
      case "--include-automation":
        options.includeAutomation = true;
        break;
      case "--no-gh":
        options.gh = false;
        break;
      case "--json":
        options.json = true;
        break;
      case "--history":
        options.history = true;
        break;
      default:
        throw new UsageError(`Unknown option: ${arg}`);
    }
  }
  if (options.days !== undefined && options.since !== undefined) throw new UsageError("Use --days or --since, not both");
  const until = options.until ?? Date.now();
  const since = options.since ?? until - (options.days ?? 7) * DAY_MS;
  if (since >= until) throw new UsageError("The window must start before it ends");
  return { ...options, since, until };
}

const tilde = (path) => (path && path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);


const localDate = (ms) => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

// Report file name: the window's end date, plus its length when not the default week and
// the project filter, so a 30-day run does not replace the same day's 7-day report.
function reportName({ since, until, project }) {
  const days = Math.round(((until - since) / DAY_MS) * 10) / 10;
  const slug = project?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return ["metrics", localDate(until), ...(days === 7 ? [] : [`${days}d`]), ...(slug ? [slug] : [])].join("-");
}

export async function buildReport(options) {
  const { since, until } = options;
  const length = until - since;
  const previousSince = since - length;
  const notes = [];
  // Before sessions load, as their estimates price models missing from the table with it.
  if (options.gh) await refreshLitellm({ notes });
  const excluded = { automation: 0, project: 0, hostPrompts: 0 };
  const needle = options.project?.toLowerCase();
  const entries = { current: [], previous: [] };
  for (const session of [...loadSessions({ since: previousSince, until }), ...loadCodexSessions({ since: previousSince, until })]) {
    const ended = Date.parse(session.endedAt);
    if (!Number.isFinite(ended) || ended <= previousSince || ended > until) continue;
    if (session.automation && !options.includeAutomation) {
      excluded.automation++;
      continue;
    }
    if (needle && !session.project.toLowerCase().includes(needle) && !(session.cwd ?? "").toLowerCase().includes(needle)) {
      excluded.project++;
      continue;
    }
    const prompts = session.prompts;
    excluded.hostPrompts += session.hostPrompts;
    entries[ended > since ? "current" : "previous"].push({ session, prompts, prs: sessionPrs(session), pushes: sessionPushes(session), corrections: countCorrections(prompts) });
  }
  const all = [...entries.current, ...entries.previous];

  let prInfo = null;
  if (options.gh) {
    const linked = attributePrs(all);
    const states = await lookupPrs(linked, { notes });
    const merged = linked.filter((pr) => states.get(pr.key)?.state === "MERGED").map((pr) => ({ ...pr, ...states.get(pr.key), key: pr.key, repository: pr.repository }));
    const reverted = await findReverts(merged, { notes });
    prInfo = new Map([...states].map(([key, state]) => [key, { ...state, revertedBy: reverted.get(key) ?? null }]));
  } else notes.push("GitHub lookups were skipped (--no-gh), so PR states, merged-PR counts and reverts are unknown.");

  const projectKeys = [...new Set(all.map((entry) => entry.session.project))];
  const projects = projectKeys.map((project) => {
    const of = (list) => list.filter((entry) => entry.session.project === project);
    return {
      project,
      label: tilde(mostCommon(of(all).map((entry) => entry.session.cwd))) ?? project,
      current: windowStats(of(entries.current), prInfo),
      previous: windowStats(of(entries.previous), prInfo),
    };
  }).sort((a, b) => b.current.cost.totalUSD - a.current.cost.totalUSD || b.previous.cost.totalUSD - a.previous.cost.totalUSD);

  const prs = attributePrs(entries.current).map((pr) => {
    const info = prInfo?.get(pr.key);
    return {
      url: pr.url, repository: pr.repository, number: pr.number, title: info?.title ?? null, state: info?.state ?? null,
      createdAt: info?.createdAt ?? null, mergedAt: info?.mergedAt ?? null, closedAt: info?.closedAt ?? null,
      additions: info?.additions ?? null, deletions: info?.deletions ?? null, headRefName: info?.headRefName ?? null,
      revertedBy: info?.revertedBy ?? null, sessions: pr.sessions, costUSD: pr.costUSD, prompts: pr.prompts,
    };
  }).sort((a, b) => b.costUSD - a.costUSD);

  const topSessions = entries.current.map(({ session, prompts }) => ({
    id: session.id, title: session.title, project: tilde(session.cwd) ?? session.project, costUSD: session.costUSD,
    costSource: session.costSource, prompts: prompts.length, startedAt: session.startedAt, endedAt: session.endedAt,
  })).sort((a, b) => b.costUSD - a.costUSD).slice(0, 5);

  if (excluded.hostPrompts) notes.push(`${excluded.hostPrompts} prompts were host notices (PR updates, delegated-task results, resume nudges, slash commands) and are not counted as the person's prompts.`);
  const ids = new Set(all.map((entry) => entry.session.id));
  for (const { session } of all) {
    const parent = session.forkedFrom;
    if (parent) notes.push(`Session ${session.id.slice(0, 8)} (${session.title ?? "untitled"}) is a fork of ${parent.slice(0, 8)}${ids.has(parent) ? ", also counted here" : ""}; only its own records count, not the history it copied.`);
  }
  if (previousSince < Date.now() - RETENTION_DAYS * DAY_MS)
    notes.push(`The previous window starts more than ${RETENTION_DAYS} days ago; Claude Code deletes older transcripts, so it is likely incomplete.`);
  if (entries.current.some(({ session }) => session.harness === "codex"))
    notes.push("Codex sessions: subagent threads count with their root thread's session, tool errors are calls whose script failed or never ran (not non-zero exits inside a script), and API errors are turns that ended with an error such as a usage limit.");
  const malformed = all.reduce((total, { session }) => total + session.malformedLines, 0);
  if (malformed) notes.push(`${malformed} transcript lines did not parse (usually a session still being written).`);
  const current = windowStats(entries.current, prInfo);
  const previous = windowStats(entries.previous, prInfo);
  const fallback = [...new Set([...current.modelMix, ...previous.modelMix].map((row) => row.model))].filter((model) => priceSource(model) === "litellm").sort();
  if (fallback.length) notes.push(`Priced from LiteLLM's list (fetched ${litellmFetchedAt().slice(0, 10)}), as the price table lacks them: ${fallback.join(", ")}.`);

  return {
    generatedAt: new Date().toISOString(),
    window: { since: new Date(since).toISOString(), until: new Date(until).toISOString(), days: length / DAY_MS },
    previousWindow: { since: new Date(previousSince).toISOString(), until: new Date(since).toISOString() },
    filters: { project: options.project ?? null, includeAutomation: options.includeAutomation, gh: options.gh },
    excluded,
    current,
    previous,
    projects,
    topSessions,
    prs,
    notes,
  };
}

function historyEntry(report, path) {
  const { current } = report;
  return {
    at: report.generatedAt,
    since: report.window.since,
    until: report.window.until,
    days: report.window.days,
    project: report.filters.project,
    includeAutomation: report.filters.includeAutomation,
    sessions: current.sessions,
    codexSessions: current.harness.codex.sessions,
    codexTokens: current.harness.codex.tokens,
    costUSD: current.cost.totalUSD,
    prompts: current.prompts.total,
    promptsPerSession: current.prompts.meanPerSession,
    mergedPRs: current.prs.merged,
    costPerMergedPRUSD: current.prs.costPerMergedUSD,
    spendPerMergedPRUSD: current.prs.spendPerMergedUSD,
    correctionRate: current.corrections.rate,
    interruptsPerSession: current.interrupts.perSession,
    toolErrorRate: current.toolErrors.main.rate,
    api429: current.apiErrors["429"] ?? 0,
    subagentShare: current.subagents.share,
    report: path,
  };
}

export async function run(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.history) {
    const entries = readJsonl(statePath(HISTORY));
    console.log(options.json ? JSON.stringify(entries, null, 2) : renderHistory(entries));
    return 0;
  }
  const report = await buildReport(options);
  const base = join(options.out ?? join(stateDir(), "reports"), reportName(options));
  writeJsonAtomic(`${base}.json`, report);
  writeFileSync(`${base}.md`, renderMarkdown(report));
  appendJsonl(statePath(HISTORY), historyEntry(report, `${base}.md`));
  console.log(options.json ? JSON.stringify(report, null, 2) : `${base}.md`);
  return 0;
}
