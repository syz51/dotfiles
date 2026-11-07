// Code reviews in sessions and what came of their findings (claude/CLAUDE.md, Review).
// A review is one /code-review Skill call. The Review rule runs it in a background agent,
// whose skill runs forked as a child agent; the review's cost is that agent's and its
// children's. Outcomes come from the main session's ReportFindings calls, made after it
// decides on the findings, each finding with a category and an outcome.
import { isCodeReview } from "../lib/transcripts.js";
import { quantile } from "./stats.js";

const sum = (values) => values.reduce((total, value) => total + value, 0);
const ratio = (part, whole) => (whole ? part / whole : null);

export const LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"];
export const OUTCOMES = ["fixed", "no_change_needed", "skipped"];
// Categories that name a defect rather than a cleanup; the rest are cleanups or other.
const CORRECTNESS = new Set(["correctness", "security", "bug", "data-loss", "concurrency", "race-condition", "crash", "regression", "reliability", "safety"]);
export const isCorrectness = (category) => CORRECTNESS.has(category);

// The level a /code-review call ran at: its first argument when that names one.
export function reviewLevel(args) {
  const first = String(args ?? "").trim().split(/\s+/)[0]?.toLowerCase();
  return LEVELS.includes(first) ? first : "default";
}

const agentKey = (id) => String(id).replace(/^agent-/, "");

/**
 * A session's reviews and recorded outcomes:
 * { reviews: [{ level, at, agent, costUSD }], triages: [{ at, level, findings: [{ category, outcome }] }] }.
 * costUSD is null for a review the main thread ran without a forked agent; for one it
 * ran with a forked agent, it leaves out the main thread's own turns.
 */
export function sessionReviews(session) {
  // A skill the main thread runs forked leaves an agent with neither a spawning tool call
  // nor a parent agent. Such agents' cost splits evenly among the main thread's reviews.
  const own = session.toolCalls.filter(isCodeReview);
  const forked = session.subagents.filter((agent) => !agent.toolUseId && !agent.parentAgentId);
  const ownCost = own.length && forked.length ? sum(forked.map((agent) => agent.costUSD)) / own.length : null;
  const reviews = own.map((call) => ({ level: reviewLevel(call.input.args), at: call.at, agent: null, costUSD: ownCost }));
  const children = new Map();
  for (const agent of session.subagents)
    if (agent.parentAgentId) children.set(agent.parentAgentId, [...(children.get(agent.parentAgentId) ?? []), agent]);
  for (const agent of session.subagents) {
    const runs = agent.codeReviews ?? [];
    if (!runs.length) continue;
    // An agent that ran several reviews splits its cost evenly among them.
    const cost = agent.costUSD + sum((children.get(agentKey(agent.id)) ?? []).map((child) => child.costUSD));
    for (const run of runs) reviews.push({ level: reviewLevel(run.args), at: run.at, agent: agent.id, costUSD: cost / runs.length });
  }
  const triages = session.toolCalls
    .filter((call) => call.name === "ReportFindings" && Array.isArray(call.input?.findings))
    .map((call) => ({
      at: call.at,
      level: LEVELS.includes(call.input.level) ? call.input.level : null,
      findings: call.input.findings.filter((finding) => finding && typeof finding === "object").map((finding) => ({
        category: typeof finding.category === "string" && finding.category ? finding.category.toLowerCase() : "uncategorized",
        outcome: OUTCOMES.includes(finding.outcome) ? finding.outcome : null,
      })),
    }))
    // Only a report whose findings carry outcomes records a triage.
    .filter((triage) => triage.findings.some((finding) => finding.outcome));
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
  const totalCost = sum(entries.map((entry) => entry.session.costUSD));
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
  const counts = triages.map((triage) => triage.findings.length);

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
      unsplit: reviews.length - priced.length,
      // Reviews the main thread ran: their cost leaves out the main thread's own turns.
      mainThread: reviews.filter((review) => review.agent === null).length,
      share: ratio(reviewCost, totalCost),
    },
    recorded: {
      triages: triages.length,
      findings: findings.length,
      medianPerTriage: quantile(counts, 0.5),
      meanPerTriage: ratio(findings.length, triages.length),
      outcomes,
      outcomeShares: Object.fromEntries(OUTCOMES.map((outcome) => [outcome, ratio(outcomes[outcome], findings.length)])),
      // Findings fixed out of those with an outcome: the acceptance rate.
      fixedRate: ratio(outcomes.fixed, sum(Object.values(outcomes))),
      correctnessShare: ratio(findings.filter((finding) => isCorrectness(finding.category)).length, findings.length),
      categories: [...categories.values()].sort((a, b) => b.findings - a.findings || a.category.localeCompare(b.category)),
    },
    perChange: { sessions: single.length, mean: ratio(sum(single.map((entry) => entry.reviews.reviews.length)), single.length) },
    reverts: { reviewed: reverts(true), unreviewed: reverts(false) },
  };
}
