import { issueKey } from "./council.js";

// The issue ledger of a climb: every screen and category the judges reported, followed across
// the run's rounds. A round's issues are matched to earlier ones by screen and category, the
// grouping topIssues uses. An issue stays open while the judges that reported it keep
// reporting it, and is resolved by the first later round in which one of them ran and no
// longer reported it on another commit: that round's commit holds the fix. A judge's silence
// on the same commit (a re-run, a hand-over round) proves nothing, so it resolves nothing. A new round's issues are marked
// unfixed (open since an earlier round), returning (reported again after a round resolved it,
// which can mean the judges ask to undo that fix), or both while a returned issue stays. The fixes that resolved an issue go to
// the judges as decisions already made, so they stop asking to undo them; a fix stays there
// when its issue returns, until a later fix on the same screen and category resolves it.

export const SETTLED_MAX = 20;

// The ledger after rounds (full round records, in order): Map<key, { screen, category, state:
// "open" | "resolved", since, fix, judges, sha, resolvedIn, settled: { round, fix } | null }>.
// Rounds without verdicts or without recorded issues are skipped.
export function ledger(rounds) {
  const entries = new Map();
  for (const round of rounds) {
    if (!round.verdicts?.length || !Array.isArray(round.issues)) continue;
    const ran = new Set(round.verdicts.map((v) => v.judge));
    const reported = new Set();
    for (const issue of round.issues) {
      const key = issueKey(issue);
      reported.add(key);
      const entry = entries.get(key);
      entries.set(key, {
        screen: issue.screen, category: issue.category, state: "open",
        since: entry?.state === "open" ? entry.since : round.round,
        fix: issue.fixes[0],
        judges: issue.judges,
        sha: round.sha,
        resolvedIn: null,
        settled: entry?.settled ?? null,
      });
    }
    for (const [key, entry] of entries)
      if (entry.state === "open" && !reported.has(key) && round.sha !== entry.sha && entry.judges.some((judge) => ran.has(judge)))
        entries.set(key, { ...entry, state: "resolved", resolvedIn: round.round, settled: { round: round.round, fix: entry.fix } });
  }
  return entries;
}

// A new round's issues, marked against the ledger of the rounds before it: since (the round
// an unfixed issue was first reported in) and returns ({ round, fix }: the latest round that
// resolved it and the fix the judges are told is settled), each when it applies.
export const markIssues = (issues, entries) => issues.map((issue) => {
  const entry = entries.get(issueKey(issue));
  if (!entry) return issue;
  return {
    ...issue,
    ...(entry.state === "open" ? { since: entry.since } : {}),
    ...(entry.settled ? { returns: entry.settled } : {}),
  };
});

// The fixes the judges are told are settled, the latest first: [{ screen, fix }], each on one
// line. Design numbers in a fix belong to the call that wrote it, so they are dropped.
const DESIGN_NUMBERS = /\bdesigns?\s*#?\d+(?:\s*(?:,|&|-|–|\band\b|\bor\b|\bto\b)\s*(?:(?:and|or)\s+)?(?:designs?\s*)?#?\d+)*/gi;
const oneLine = (text) => String(text).replace(/\s+/g, " ").trim();
export const settledFixes = (entries, limit = SETTLED_MAX) => [...entries.values()]
  .filter((entry) => entry.settled)
  .sort((a, b) => b.settled.round - a.settled.round)
  .slice(0, limit)
  .map((entry) => ({ screen: oneLine(entry.screen), fix: oneLine(entry.settled.fix.replace(DESIGN_NUMBERS, "another design")) }));
