// The metrics report as Markdown: a headline table comparing the window with the previous
// one, then cost, effort and quality, models, projects, pull requests and notes.
import { HARNESSES } from "./stats.js";

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
  ["Codex sessions", (s) => s.harness.codex.sessions, "count"],
  ["Codex tokens, millions (subagents included)", (s) => s.harness.codex.tokens / 1e6, "number"],
  ["OpenCode sessions", (s) => s.harness.opencode.observed === false ? null : s.harness.opencode.sessions, "count"],
  ["OpenCode tokens, millions (descendants included)", (s) => s.harness.opencode.observed === false ? null : s.harness.opencode.tokens / 1e6, "number"],
  ["Sessions launched by an agent", (s) => s.origin.agent.sessions, "count"],
  ["Cost of agent-launched sessions", (s) => s.origin.agent.costUSD, "usd"],
  ["Prompts per session, mean", (s) => s.prompts.meanPerSession, "number"],
  ["Prompts per session, median", (s) => s.prompts.medianPerSession, "number"],
  ["Cost, total", (s) => s.cost.totalUSD, "usd"],
  ["Cost per session, median (known cost)", (s) => s.cost.medianUSD, "usd"],
  ["Cost per session, p90 (known cost)", (s) => s.cost.p90USD, "usd"],
  ["Branches pushed", (s) => s.pushes.branches, "count"],
  ["Merged PRs", (s) => s.prs.merged, "count"],
  ["Cost per merged PR (its sessions)", (s) => s.prs.costPerMergedUSD, "usd"],
  ["Spend per merged PR (all sessions)", (s) => s.prs.spendPerMergedUSD, "usd"],
  ["Prompts per merged PR (its sessions)", (s) => s.prs.promptsPerMerged, "number"],
  ["Correction rate (heuristic, sessions a person ran)", (s) => s.corrections.rate, "rate"],
  ["Interrupts per session", (s) => s.interrupts.perSession, "number"],
  ["Tool error rate, main sessions", (s) => s.toolErrors.main.rate, "rate"],
  ["Tool error rate, subagents", (s) => s.toolErrors.subagents.rate, "rate"],
  ["API errors, 429", (s) => s.apiErrors["429"] ?? 0, "count"],
  ["API errors, all", (s) => sum(Object.values(s.apiErrors)), "count"],
  ["Compactions", (s) => s.compactions.total, "count"],
  ["Subagent share of cost", (s) => s.subagents.share, "rate"],
  ["Code reviews", (s) => s.reviews.reviews, "count"],
  ["Review share of cost", (s) => s.reviews.cost.share, "rate"],
  ["Findings per recorded review, median", (s) => s.reviews.recorded.medianPerTriage, "number"],
  ["Findings fixed (recorded outcomes)", (s) => s.reviews.recorded.fixedRate, "rate"],
  ["Revert rate, reviewed merged PRs", (s) => s.reviews.reverts.reviewed?.rate, "rate"],
  ["Revert rate, unreviewed merged PRs", (s) => s.reviews.reverts.unreviewed?.rate, "rate"],
];

const sessionName = (session) => session.title ?? `untitled ${session.id.slice(0, 8)}`;

const OUTCOME_NAMES = { fixed: "fixed", no_change_needed: "no change needed", skipped: "skipped" };

function renderReviews(reviews) {
  const lines = ["## Code reviews", ""];
  const levels = Object.entries(reviews.byLevel).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([level, count]) => `${level} ${count}`).join(", ");
  lines.push(`- Reviews: ${reviews.reviews} (/code-review runs, not counting refused or interrupted ones) in ${reviews.sessions} sessions${levels ? `; levels: ${levels}` : ""}.`);
  lines.push(`- Cost: ${usd(reviews.cost.totalUSD)}, median ${usd(reviews.cost.medianUSD)} per review, ${pct(reviews.cost.share)} of the window's cost. It counts the agent that ran each review and every agent below it`
    + `${reviews.cost.mainThread ? `. ${reviews.cost.mainThread} reviews ran in a session's main thread: their forked review agents count, the thread's own turns do not` : ""}`
    + `${reviews.cost.unpriced ? `, and ${reviews.cost.unpriced} of them had no forked agent, so their cost stays in the session's` : ""}.`);
  const { recorded } = reviews;
  lines.push(`- Recorded outcomes: ${recorded.triages} reviews recorded through ReportFindings, with ${recorded.findings} findings, median ${num(recorded.medianPerTriage)} per review. `
    + `${Object.entries(OUTCOME_NAMES).map(([key, name]) => `${name} ${recorded.outcomes[key]} (${pct(recorded.outcomeShares[key])})`).join(", ")}. `
    + `Correctness, security or reliability findings: ${pct(recorded.defectShare)}; the rest are cleanups or other categories.`);
  lines.push(`- Reviews per change: ${num(reviews.perChange.mean)}, over the ${reviews.perChange.sessions} sessions that ran a review and linked exactly one PR.`);
  lines.push("- A PR counts as reviewed when a session that linked it ran a review.");
  const revert = (entry) => (entry ? `${entry.reverted} of ${entry.merged} merged (${pct(entry.rate)})` : "unknown without GitHub lookups");
  lines.push(`- Reverts: reviewed PRs ${revert(reviews.reverts.reviewed)}; unreviewed PRs ${revert(reviews.reverts.unreviewed)}.`, "");
  if (recorded.categories.length)
    lines.push(table(["Category", "Findings", "Fixed", "No change needed", "Skipped"],
      recorded.categories.slice(0, 10).map((row) => [row.category, row.findings, row.fixed, row.no_change_needed, row.skipped])), "");
  return lines;
}

export function renderMarkdown(report) {
  const { window, previousWindow: before, current, previous: prior } = report;
  const lines = [];
  lines.push(`# Claude Code, Codex and OpenCode metrics: ${day(window.since)} to ${day(window.until)}`, "");
  lines.push(`Window of ${num(window.days)} days, ending ${window.until}, compared with the previous ${num(window.days)} days (${day(before.since)} to ${day(before.until)}). `
    + `Sessions count in the window of their last activity. Generated ${report.generatedAt}.`, "");
  const filters = [`project: ${report.filters.project ?? "all"}`, `automation sessions: ${report.filters.includeAutomation ? "included" : `excluded (${report.excluded.automation})`}`, `GitHub lookups: ${report.filters.gh ? "on" : "off"}`];
  lines.push(`Filters: ${filters.join("; ")}.`, "");

  lines.push("## Headline", "");
  lines.push(table(["Metric", "This window", "Previous window", "Change"],
    HEADLINE.map(([label, pick, kind]) => [label, FORMAT[kind](pick(current)), FORMAT[kind](pick(prior)), change(pick(current), pick(prior), kind)])), "");

  lines.push("## Cost", "");
  lines.push(`Total ${usd(current.cost.totalUSD)} API-equivalent over ${current.sessions} sessions: ${current.cost.sources["cost-state"]} from Claude Code's cost-state record, ${current.cost.sources.estimated} estimated from token usage`
    + `${current.cost.sources.api ? `, ${current.cost.sources.api} from OpenCode's message costs` : ""}`
    + `${current.cost.sources.partial ? `, ${current.cost.sources.partial} with partial known costs` : ""}`
    + `${current.cost.unpricedSessions ? ` (${current.cost.unpricedSessions} sessions have unknown costs; totals are known subtotals, not free usage)` : ""}.`, "");
  lines.push(`By harness: ${Object.entries(HARNESSES).map(([harness, name]) => {
    const entry = current.harness[harness];
    if (entry.observed === false) return `${name} coverage unavailable`;
    return `${name} ${entry.sessions} sessions, ${usd(entry.costUSD)}, ${num(entry.tokens / 1e6)}M tokens, ${entry.subagentRuns} subagent runs${entry.unpricedSessions ? ` (${entry.unpricedSessions} sessions unpriced)` : ""}`;
  }).join("; ")}. Codex costs use token estimates. OpenCode costs use own message costs or available prices; roots include descendants once. Unknown costs do not enter cost quantiles or cost-per-merged-PR averages.`, "");
  lines.push("### Costliest sessions", "");
  lines.push(report.topSessions.length
    ? table(["Session", "Harness", "Project", "Cost", "Prompts", "Cost source"], report.topSessions.map((session) => [sessionName(session), HARNESSES[session.harness], session.project, `${usd(session.costUSD)}${session.unpriced ? " (partial)" : ""}`, session.prompts, session.costSource]))
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

  lines.push(...renderReviews(current.reviews));

  lines.push("## Subagents and models", "");
  lines.push(`Subagents: ${current.subagents.runs} runs, ${usd(current.subagents.costUSD)} known or estimated, ${pct(current.subagents.share)} of the known or estimated cost (previous window ${pct(prior.subagents.share)}).`, "");
  lines.push(current.modelMix.length
    ? table(["Harness", "Role", "Model", "Runs", "Messages", "Tokens (M)", "Known / estimated cost", "Share"], current.modelMix.map((row) => [HARNESSES[row.harness], row.role, row.model, row.runs, row.messages ?? "n/a", num((row.tokens ?? 0) / 1e6), `${usd(row.costUSD)}${row.partialCost ? " (partial)" : ""}`, pct(row.share)]))
    : "No model use in the window.", "");
  lines.push("Runs are sessions for the main role and subagent runs otherwise; messages are API responses. Costs use usage estimates or OpenCode's message costs, and can differ from cost-state totals. Partial rows show known subtotals only. OpenCode review-specific statistics are not measured; correction and tool-error rates still apply.", "");

  lines.push("## Projects", "");
  lines.push(report.projects.length
    ? table(["Project", "Sessions", "Previous", "Cost", "Previous cost", "Prompts per session", "Merged PRs", "Cost per merged PR", "Corrections", "Tool errors"],
      report.projects.map(({ label, current: c, previous: p }) => [label, c.sessions, p.sessions, usd(c.cost.totalUSD), usd(p.cost.totalUSD), num(c.prompts.meanPerSession),
        num(c.prs.merged), usd(c.prs.costPerMergedUSD), pct(c.corrections.rate), pct(c.toolErrors.main.rate)]))
    : "No projects in either window.", "");

  lines.push("## Pull requests", "");
  lines.push(`Linked from sessions in the window: ${current.prs.linked}; merged ${num(current.prs.merged)}, open ${num(current.prs.open)}, closed ${num(current.prs.closed)}, reverted ${num(current.prs.reverted)}. `
    + "A session counts toward every PR it created or linked, and its cost and prompts split evenly across them. "
    + `Branches pushed: ${current.pushes.branches} (${current.pushes.created} new) from ${current.pushes.sessions} sessions, read from git push output, so quiet pushes are missed.`, "");
  if (report.prs.length)
    lines.push(table(["PR", "Title", "State", "Merged", "Size", "Sessions", "Cost", "Prompts", "Reverted by"],
      report.prs.map((pr) => [`[${pr.repository}#${pr.number}](${pr.url})`, pr.title ?? "", pr.state ?? "unknown", pr.mergedAt ? day(pr.mergedAt) : "",
        pr.additions === null ? "" : `+${pr.additions} -${pr.deletions}`, pr.sessions.length, `${usd(pr.costUSD)}${pr.partialCost ? " (partial)" : ""}`, num(pr.prompts), pr.revertedBy ? `#${pr.revertedBy.number}` : ""])), "");

  lines.push("## Notes", "");
  lines.push(...(report.notes.length ? report.notes.map((note) => `- ${note}`) : ["- None."]), "");
  return lines.join("\n");
}

// The history file as a Markdown table, oldest first.
export function renderHistory(entries) {
  if (!entries.length) return "No metrics runs recorded yet.";
  return table(["Run (UTC)", "Window", "Project", "Sessions", "Codex sessions", "OpenCode sessions", "Cost", "Merged PRs", "Cost per merged PR", "Prompts per session", "Correction rate", "Tool error rate", "429s", "Reviews", "Review cost"],
    entries.map((entry) => [entry.at.slice(0, 16).replace("T", " "), `${day(entry.since)} to ${day(entry.until)}`, entry.project ?? "all", entry.sessions,
      // Runs before Codex was included have no count: their sessions are Claude Code only.
      entry.codexSessions ?? "not read", entry.openCodeSessions ?? "not read", usd(entry.costUSD),
      num(entry.mergedPRs), usd(entry.costPerMergedPRUSD), num(entry.promptsPerSession), pct(entry.correctionRate), pct(entry.toolErrorRate), entry.api429,
      // Runs before reviews were counted have no entry.
      entry.reviews ?? "not read", usd(entry.reviewCostUSD)]));
}
