// Code reviews in sessions and what came of their findings (claude/CLAUDE.md, Review).
// A review is one /code-review Skill call that was not refused or interrupted. The Review
// rule runs it in a background agent, whose skill runs forked as a child agent; the
// review's cost is that agent's and every agent below it. Outcomes come from the main
// session's ReportFindings calls, made after it decides on the findings, each finding
// with a category and an outcome.
import { isCodeReview } from "../lib/transcripts.js";
import { quantile, ratio, sum } from "./stats.js";

const LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"];
export const OUTCOMES = ["fixed", "no_change_needed", "skipped"];
// The categories the Review rule names; the first three name a defect, the rest a cleanup.
export const CATEGORIES = ["correctness", "security", "reliability", "efficiency", "simplification", "test-coverage", "conventions", "docs"];
const DEFECTS = new Set(CATEGORIES.slice(0, 3));

// The level a /code-review call ran at: the first argument that names one, so a flag
// before it does not hide it.
export function reviewLevel(args) {
  const words = String(args ?? "").trim().toLowerCase().split(/\s+/);
  return words.find((word) => LEVELS.includes(word)) ?? "default";
}

const time = (at) => Date.parse(at ?? "") || 0;

/**
 * A session's reviews and recorded outcomes:
 * { reviews: [{ level, at, agent, costUSD }], triages: [{ at, findings: [{ category, outcome }] }] }.
 * costUSD is null for a review the main thread ran without a forked agent; for one it
 * ran with a forked agent, it leaves out the main thread's own turns.
 */
export function sessionReviews(session) {
  const children = new Map();
  for (const agent of session.subagents)
    if (agent.parentAgentId) children.set(agent.parentAgentId, [...(children.get(agent.parentAgentId) ?? []), agent]);
  // An agent's cost with every agent below it, except those that ran reviews of their own,
  // which count toward those reviews.
  const treeCost = (agent) => agent.costUSD + sum((children.get(String(agent.id).replace(/^agent-/, "")) ?? [])
    .filter((child) => !child.codeReviews?.length)
    .map(treeCost));

  // A review the main thread runs forks an agent with neither a spawning tool call nor a
  // parent agent; it belongs to the latest review call made before it started.
  const own = session.toolCalls.filter(isCodeReview);
  const reviews = own.map((call) => ({ level: reviewLevel(call.input.args), at: call.at, agent: null, costUSD: null }));
  for (const agent of session.subagents.filter((agent) => agent.reviewFork && !agent.toolUseId && !agent.parentAgentId)) {
    const review = reviews.findLast((candidate) => time(candidate.at) <= time(agent.startedAt));
    if (review) review.costUSD = (review.costUSD ?? 0) + treeCost(agent);
  }
  for (const agent of session.subagents) {
    const runs = agent.codeReviews ?? [];
    // An agent that ran several reviews splits its cost evenly among them.
    for (const run of runs) reviews.push({ level: reviewLevel(run.args), at: run.at, agent: agent.id, costUSD: treeCost(agent) / runs.length });
  }

  // ReportFindings calls after one review, until the next starts, record that review: a
  // long list goes in several calls, and a call repeated or re-reported with outcomes
  // replaces the same findings. A record with no findings is a clean review.
  const starts = reviews.map((review) => time(review.at)).sort((a, b) => a - b);
  const records = new Map();
  for (const call of session.toolCalls) {
    if (call.name !== "ReportFindings" || call.ok === false || !Array.isArray(call.input?.findings)) continue;
    const after = starts.filter((start) => start <= time(call.at)).length;
    const record = records.get(after) ?? { at: call.at, findings: new Map(), clean: false };
    if (!call.input.findings.length) record.clean = true;
    for (const finding of call.input.findings.filter((finding) => finding && typeof finding === "object"))
      record.findings.set(`${finding.file}:${finding.line}:${finding.summary}`, {
        category: typeof finding.category === "string" && finding.category ? finding.category.toLowerCase() : "uncategorized",
        outcome: OUTCOMES.includes(finding.outcome) ? finding.outcome : null,
      });
    records.set(after, record);
  }
  // Only a record whose findings carry outcomes, or a clean one, records a triage.
  const triages = [...records.values()]
    .map((record) => ({ at: record.at, findings: [...record.findings.values()], clean: record.clean }))
    .filter((triage) => triage.findings.some((finding) => finding.outcome) || (triage.clean && !triage.findings.length))
    .map(({ at, findings }) => ({ at, findings }));
  return { reviews, triages };
}

/**
 * Review statistics over window entries ({ session, prs, reviews } with reviews from
 * sessionReviews). prInfo maps PR keys to GitHub state and revert, or is null.
 */
export function reviewStats(entries, prInfo) {
  const reviews = entries.flatMap((entry) => entry.reviews.reviews);
  const triages = entries.flatMap((entry) => entry.reviews.triages);
  const findings = triages.flatMap((triage) => triage.findings);
  const priced = reviews.filter((review) => review.costUSD !== null);
  const reviewCost = sum(priced.map((review) => review.costUSD));
  // Agents' cost is estimated from usage, so the share is of the estimated total, as for
  // the subagent share.
  const totalCost = sum(entries.map((entry) => entry.session.estimatedCostUSD));
  const byLevel = {};
  for (const review of reviews) byLevel[review.level] = (byLevel[review.level] ?? 0) + 1;
  const outcomes = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, findings.filter((finding) => finding.outcome === outcome).length]));
  const categories = new Map();
  for (const finding of findings) {
    const row = categories.get(finding.category) ?? { category: finding.category, findings: 0, ...Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) };
    row.findings++;
    if (finding.outcome) row[finding.outcome]++;
    categories.set(finding.category, row);
  }

  // A PR counts as reviewed when a session behind it ran a review.
  const reviewedSessions = new Set(entries.filter((entry) => entry.reviews.reviews.length).map((entry) => entry.session.id));
  const prs = new Map();
  for (const entry of entries)
    for (const link of entry.prs) {
      const pr = prs.get(link.key) ?? { key: link.key, reviewed: false };
      pr.reviewed ||= reviewedSessions.has(entry.session.id);
      prs.set(link.key, pr);
    }
  // Review rounds per change, from sessions that reviewed and linked exactly one PR: a
  // long session that links many PRs says nothing about rounds per change.
  const single = entries.filter((entry) => entry.prs.length === 1 && entry.reviews.reviews.length);
  const reverts = (reviewed) => {
    if (!prInfo) return null;
    const merged = [...prs.values()].filter((pr) => pr.reviewed === reviewed && prInfo.get(pr.key)?.state === "MERGED");
    const reverted = merged.filter((pr) => prInfo.get(pr.key).revertedBy).length;
    return { merged: merged.length, reverted, rate: ratio(reverted, merged.length) };
  };

  return {
    reviews: reviews.length,
    sessions: reviewedSessions.size,
    byLevel,
    cost: {
      totalUSD: reviewCost,
      medianUSD: quantile(priced.map((review) => review.costUSD), 0.5),
      // Reviews the main thread ran without a forked agent: their cost stays in the session's.
      unpriced: reviews.length - priced.length,
      // Reviews the main thread ran: their cost leaves out the main thread's own turns.
      mainThread: reviews.filter((review) => review.agent === null).length,
      share: ratio(reviewCost, totalCost),
    },
    recorded: {
      triages: triages.length,
      findings: findings.length,
      medianPerTriage: quantile(triages.map((triage) => triage.findings.length), 0.5),
      outcomes,
      outcomeShares: Object.fromEntries(OUTCOMES.map((outcome) => [outcome, ratio(outcomes[outcome], findings.length)])),
      // Findings fixed out of those with an outcome: the acceptance rate.
      fixedRate: ratio(outcomes.fixed, sum(Object.values(outcomes))),
      defectShare: ratio(findings.filter((finding) => DEFECTS.has(finding.category)).length, findings.length),
      categories: [...categories.values()].sort((a, b) => b.findings - a.findings || a.category.localeCompare(b.category)),
    },
    perChange: { sessions: single.length, mean: ratio(sum(single.map((entry) => entry.reviews.reviews.length)), single.length) },
    reverts: { reviewed: reverts(true), unreviewed: reverts(false) },
  };
}
