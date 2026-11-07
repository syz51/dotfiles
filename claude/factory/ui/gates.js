// Gates a candidate must clear before any judge sees it: the project's checks pass, every
// shot loaded, no shot logs more errors than the same shot on the baseline, and the page
// checks' totals are no worse than the baseline's. They cost no model calls.
import { checkTotals } from "./checks.js";

const LABELS = {
  overflow: "screens that scroll sideways",
  contrast: "text below WCAG AA contrast",
  unlabeled: "controls without an accessible name",
  targets: "tap targets under 24 px on phones",
  missingAlt: "images without alt text",
};

// checks is runChecks' result, or null when the checks were skipped.
// Returns { ok, failures: [string], totals: { candidate, baseline } }.
export function evaluateGates({ checks, candidate, baseline }) {
  const failures = [];
  if (checks && !checks.ok) failures.push(`${checks.failed}:\n${checks.results.at(-1).output}`);
  const before = new Map(baseline.map((shot) => [shot.id, shot]));
  for (const shot of candidate) {
    if (shot.error) {
      failures.push(`${shot.id} did not capture: ${shot.error}`);
      continue;
    }
    const base = before.get(shot.id);
    for (const [key, what] of [["pageErrors", "page errors"], ["consoleErrors", "console errors"], ["failedRequests", "failed requests"]]) {
      const extra = shot[key].length - (base?.[key].length ?? 0);
      if (extra > 0) failures.push(`${shot.id} has ${extra} more ${what} than main: ${shot[key].slice(0, 3).join(" | ").slice(0, 400)}`);
    }
  }
  const totals = { candidate: checkTotals(candidate), baseline: checkTotals(baseline) };
  for (const [key, what] of Object.entries(LABELS)) {
    const extra = totals.candidate[key] - totals.baseline[key];
    if (extra <= 0) continue;
    const samples = candidate.flatMap((shot) => {
      const found = shot.checks?.[key];
      if (key === "overflow") return shot.checks?.overflowX ? [shot.id] : [];
      if (key === "missingAlt") return found ? [`${shot.id} (${found})`] : [];
      return (found?.samples ?? []).map((sample) => `${shot.id}: ${typeof sample === "string" ? sample : `"${sample.text}" ${sample.ratio}:1, needs ${sample.required}:1`}`);
    });
    failures.push(`${extra} more ${what} than main (${totals.candidate[key]} vs ${totals.baseline[key]}): ${samples.slice(0, 6).join("; ")}`);
  }
  return { ok: failures.length === 0, failures, totals };
}
