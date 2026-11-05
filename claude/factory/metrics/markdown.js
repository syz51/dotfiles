// The metrics report as Markdown: a headline table comparing the window with the previous
// one, then cost, effort and quality, models, projects, pull requests and notes.
const sum = (values) => values.reduce((total, value) => total + value, 0);

const usd = (value) => (value === null || value === undefined ? "n/a" : value.toLocaleString("en-US", { style: "currency", currency: "USD" }));
const pct = (value) => (value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`);
const num = (value, digits = 1) => (value === null || value === undefined ? "n/a" : Number.isInteger(value) ? String(value) : value.toFixed(digits));
const FORMAT = { count: (value) => num(value), number: num, usd, rate: pct };
const day = (iso) => iso.slice(0, 10);
const cell = (text) => String(text ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();

// Numbers, money, rates and changes; columns of only these align right.
const NUMERIC = /^(?:n\/a|[-+]?\$?[\d,.]+%?(?: pp)?(?: \((?:[-+]?[\d,.]+%|new)\))?)$/;

function table(header, rows) {
  const cells = rows.map((row) => row.map(cell));
  const right = header.map((title, index) => index > 0 && cells.some((row) => row[index])
    && cells.every((row) => !row[index] || NUMERIC.test(row[index])));
  return [`| ${header.join(" | ")} |`, `| ${right.map((flag) => (flag ? "---:" : "---")).join(" | ")} |`,
    ...cells.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

function change(current, previous, kind) {
  if (current === null || current === undefined || previous === null || previous === undefined) return "n/a";
  const delta = current - previous;
  if (kind === "rate") return `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)} pp`;
  const signed = kind === "usd" ? `${delta < 0 ? "-" : "+"}${usd(Math.abs(delta))}` : `${delta >= 0 ? "+" : ""}${num(delta)}`;
  if (!delta) return "0";
  return previous ? `${signed} (${delta > 0 ? "+" : ""}${((delta / previous) * 100).toFixed(0)}%)` : `${signed} (new)`;
}

export const HEADLINE = [
  ["Sessions", (s) => s.sessions, "count"],
  ["Prompts per session, mean", (s) => s.prompts.meanPerSession, "number"],
  ["Prompts per session, median", (s) => s.prompts.medianPerSession, "number"],
  ["Cost, total", (s) => s.cost.totalUSD, "usd"],
  ["Cost per session, median", (s) => s.cost.medianUSD, "usd"],
  ["Cost per session, p90", (s) => s.cost.p90USD, "usd"],
  ["Merged PRs", (s) => s.prs.merged, "count"],
  ["Cost per merged PR (its sessions)", (s) => s.prs.costPerMergedUSD, "usd"],
  ["Spend per merged PR (all sessions)", (s) => s.prs.spendPerMergedUSD, "usd"],
  ["Prompts per merged PR (its sessions)", (s) => s.prs.promptsPerMerged, "number"],
  ["Correction rate (heuristic)", (s) => s.corrections.rate, "rate"],
  ["Interrupts per session", (s) => s.interrupts.perSession, "number"],
  ["Tool error rate, main sessions", (s) => s.toolErrors.main.rate, "rate"],
  ["Tool error rate, subagents", (s) => s.toolErrors.subagents.rate, "rate"],
  ["API errors, 429", (s) => s.apiErrors["429"] ?? 0, "count"],
  ["API errors, all", (s) => sum(Object.values(s.apiErrors)), "count"],
  ["Compactions", (s) => s.compactions.total, "count"],
  ["Subagent share of cost", (s) => s.subagents.share, "rate"],
];

const sessionName = (session) => session.title ?? `untitled ${session.id.slice(0, 8)}`;

export function renderMarkdown(report) {
  const { window, previousWindow: before, current, previous: prior } = report;
  const lines = [];
  lines.push(`# Claude Code metrics: ${day(window.since)} to ${day(window.until)}`, "");
  lines.push(`Window of ${num(window.days)} days, ending ${window.until}, compared with the previous ${num(window.days)} days (${day(before.since)} to ${day(before.until)}). `
    + `Sessions count in the window of their last activity. Generated ${report.generatedAt}.`, "");
  const filters = [`project: ${report.filters.project ?? "all"}`, `automation sessions: ${report.filters.includeAutomation ? "included" : `excluded (${report.excluded.automation})`}`, `GitHub lookups: ${report.filters.gh ? "on" : "off"}`];
  lines.push(`Filters: ${filters.join("; ")}.`, "");

  lines.push("## Headline", "");
  lines.push(table(["Metric", "This window", "Previous window", "Change"],
    HEADLINE.map(([label, pick, kind]) => [label, FORMAT[kind](pick(current)), FORMAT[kind](pick(prior)), change(pick(current), pick(prior), kind)])), "");

  lines.push("## Cost", "");
  lines.push(`Total ${usd(current.cost.totalUSD)} API-equivalent over ${current.sessions} sessions: ${current.cost.sources["cost-state"]} from Claude Code's cost-state record, ${current.cost.sources.estimated} estimated from token usage`
    + `${current.cost.unpricedSessions ? ` (${current.cost.unpricedSessions} used a model without a known price, counted as $0)` : ""}.`, "");
  lines.push("### Costliest sessions", "");
  lines.push(report.topSessions.length
    ? table(["Session", "Project", "Cost", "Prompts", "Cost source"], report.topSessions.map((session) => [sessionName(session), session.project, usd(session.costUSD), session.prompts, session.costSource]))
    : "No sessions in the window.", "");

  lines.push("## Effort and quality", "");
  lines.push(`- Prompts: ${current.prompts.total} from the person (host notices such as PR updates, delegated-task results, resume nudges and slash commands excluded).`);
  lines.push(`- Correction rate (heuristic): ${current.corrections.corrections} of ${current.corrections.followUps} follow-up prompts (${pct(current.corrections.rate)}) match correction phrases such as "no, ...", "I meant", "still failing" or "why did you". First prompts are never counted. Treat it as a trend signal, not a measurement.`);
  lines.push(`- Interrupts: ${current.interrupts.total} (${num(current.interrupts.perSession, 2)} per session). Compactions: ${current.compactions.total}.`);
  lines.push(`- Tool errors: ${current.toolErrors.main.errors} of ${current.toolErrors.main.known} main-session calls with a result (${pct(current.toolErrors.main.rate)}); ${current.toolErrors.subagents.errors} of ${current.toolErrors.subagents.calls} subagent calls (${pct(current.toolErrors.subagents.rate)}). Rejected tool uses count as errors.`, "");
  const statuses = [...new Set([...Object.keys(current.apiErrors), ...Object.keys(prior.apiErrors)])].sort();
  lines.push("### API errors by status", "");
  lines.push(statuses.length
    ? table(["Status", "This window", "Previous window"], statuses.map((status) => [status === "429" ? "429 (rate limit)" : status, current.apiErrors[status] ?? 0, prior.apiErrors[status] ?? 0]))
    : "None in either window.", "");

  lines.push("## Subagents and models", "");
  lines.push(`Subagents: ${current.subagents.runs} runs, ${usd(current.subagents.costUSD)} estimated, ${pct(current.subagents.share)} of the estimated cost (previous window ${pct(prior.subagents.share)}).`, "");
  lines.push(current.modelMix.length
    ? table(["Role", "Model", "Runs", "Messages", "Estimated cost", "Share"], current.modelMix.map((row) => [row.role, row.model, row.runs, row.messages ?? "n/a", usd(row.costUSD), pct(row.share)]))
    : "No model use in the window.", "");
  lines.push("Runs are sessions for the main role and subagent runs otherwise. Costs here are usage estimates, which can differ from the cost-state totals above.", "");

  lines.push("## Projects", "");
  lines.push(report.projects.length
    ? table(["Project", "Sessions", "Previous", "Cost", "Previous cost", "Prompts per session", "Merged PRs", "Cost per merged PR", "Corrections", "Tool errors"],
      report.projects.map(({ label, current: c, previous: p }) => [label, c.sessions, p.sessions, usd(c.cost.totalUSD), usd(p.cost.totalUSD), num(c.prompts.meanPerSession),
        num(c.prs.merged), usd(c.prs.costPerMergedUSD), pct(c.corrections.rate), pct(c.toolErrors.main.rate)]))
    : "No projects in either window.", "");

  lines.push("## Pull requests", "");
  lines.push(`Linked from sessions in the window: ${current.prs.linked}; merged ${num(current.prs.merged)}, open ${num(current.prs.open)}, closed ${num(current.prs.closed)}, reverted ${num(current.prs.reverted)}. `
    + "A session counts toward every PR it created or linked, and its cost and prompts split evenly across them.", "");
  if (report.prs.length)
    lines.push(table(["PR", "Title", "State", "Merged", "Size", "Sessions", "Cost", "Prompts", "Reverted by"],
      report.prs.map((pr) => [`[${pr.repository}#${pr.number}](${pr.url})`, pr.title ?? "", pr.state ?? "unknown", pr.mergedAt ? day(pr.mergedAt) : "",
        pr.additions === null ? "" : `+${pr.additions} -${pr.deletions}`, pr.sessions.length, usd(pr.costUSD), num(pr.prompts), pr.revertedBy ? `#${pr.revertedBy.number}` : ""])), "");

  lines.push("## Notes", "");
  lines.push(...(report.notes.length ? report.notes.map((note) => `- ${note}`) : ["- None."]), "");
  return lines.join("\n");
}

// The history file as a Markdown table, oldest first.
export function renderHistory(entries) {
  if (!entries.length) return "No metrics runs recorded yet.";
  return table(["Run", "Window", "Project", "Sessions", "Cost", "Merged PRs", "Cost per merged PR", "Prompts per session", "Correction rate", "Tool error rate", "429s"],
    entries.map((entry) => [entry.at.slice(0, 16).replace("T", " "), `${day(entry.since)} to ${day(entry.until)}`, entry.project ?? "all", entry.sessions, usd(entry.costUSD),
      num(entry.mergedPRs), usd(entry.costPerMergedPRUSD), num(entry.promptsPerSession), pct(entry.correctionRate), pct(entry.toolErrorRate), entry.api429]));
}
