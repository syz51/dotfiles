// The issue ledger of a climb: every screen and category the judges reported, followed across
// the run's rounds. A round's issues are matched to earlier ones by screen and category, the
// grouping topIssues uses. An issue stays open while the judges that reported it keep
// reporting it, and is resolved by the first later round in which one of them ran and no
// longer reported it: that round's commit holds the fix. A new round's issues are marked
// unfixed (open since an earlier round) or returning (reported again after a round resolved
// it, which can mean the judges ask to undo that fix). The fixes that resolved an issue go to
// the judges as decisions already made, so they stop asking to undo them; a fix stays there
// when its issue returns, until a later fix on the same screen and category resolves it.

export const SETTLED_MAX = 20;

const keyOf = (issue) => `${issue.screen}|${issue.category}`;

// The ledger after rounds (full round records, in order): Map<key, { screen, category, state:
// "open" | "resolved", since, fix, judges, resolvedIn, settled: { round, fix } | null }>. Rounds
// without verdicts or without recorded issues are skipped.
export function ledger(rounds) {
  const entries = new Map();
  for (const round of rounds) {
    if (!round.verdicts?.length || !Array.isArray(round.issues)) continue;
    const ran = new Set(round.verdicts.map((v) => v.judge));
    const reported = new Set();
    for (const issue of round.issues) {
      const key = keyOf(issue);
      reported.add(key);
      const entry = entries.get(key);
      entries.set(key, {
        screen: issue.screen, category: issue.category, state: "open",
        since: entry?.state === "open" ? entry.since : round.round,
        fix: issue.fixes[0],
        // Rounds from before issues named their judges count every judge that ran.
        judges: issue.judges ?? [...ran],
        resolvedIn: null,
        settled: entry?.settled ?? null,
      });
    }
    for (const [key, entry] of entries)
      if (entry.state === "open" && !reported.has(key) && entry.judges.some((judge) => ran.has(judge)))
        entries.set(key, { ...entry, state: "resolved", resolvedIn: round.round, settled: { round: round.round, fix: entry.fix } });
  }
  return entries;
}

// A new round's issues, marked against the ledger of the rounds before it: since (the round
// an unfixed issue was first reported in) or returns ({ round, fix }: the round that resolved
// it and the fix that did).
export const markIssues = (issues, entries) => issues.map((issue) => {
  const entry = entries.get(keyOf(issue));
  if (entry?.state === "open") return { ...issue, since: entry.since };
  if (entry?.state === "resolved") return { ...issue, returns: { round: entry.resolvedIn, fix: entry.fix } };
  return issue;
});

// The fixes the judges are told are settled, the latest first: [{ screen, fix }]. Design
// numbers in a fix belong to the call that wrote it, so they are dropped.
export const settledFixes = (entries, limit = SETTLED_MAX) => [...entries.values()]
  .filter((entry) => entry.settled)
  .sort((a, b) => b.settled.round - a.settled.round)
  .slice(0, limit)
  .map((entry) => ({ screen: entry.screen, fix: entry.settled.fix.replace(/\bDesigns? \d+(?:(?:,\s*|\s+and\s+)\d+)*/g, "another design") }));
