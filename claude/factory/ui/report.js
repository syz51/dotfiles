// The run's report: one self-contained HTML file (screenshots inlined) with the score per
// round, the latest round's categories and issues, main beside the latest candidate for
// every shot, the gates and the calibration. Every string from a judge or the
// configuration is escaped.
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { IMAGE_TYPES } from "./config.js";
import { barVerdict, fixed, judgeKey, money, RUBRIC, signed } from "./council.js";

export const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const image = (file) => (file && existsSync(file) ? `data:${IMAGE_TYPES[extname(file).toLowerCase()] ?? "image/png"};base64,${readFileSync(file).toString("base64")}` : null);
const OUTCOME = { gates: "gates failed", budget: "budget", error: "error" };
const CHAMPION = { replaced: ["pass", "new champion"], held: ["", "held"], rejected: ["fail", "rejected"] };

// A round's result against the run's champion, for the rounds table.
function championCell(round) {
  const record = round.champion;
  if (!record?.result) return `<td class="muted">${record ? "not scored" : "–"}</td>`;
  const [tone, label] = CHAMPION[record.result];
  const against = record.round === null ? "main" : `round ${record.round}`;
  return `<td><span class="pill ${tone}">${label}</span> <span class="muted">vs ${against}${record.lead === null ? "" : ` ${signed(record.lead)}`}</span></td>`;
}

// Labels at the end of the lines, moved apart so none overlaps: [[y, text]] by y.
export function endLabels(labels, gap = 14) {
  const sorted = [...labels].sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < sorted.length; index++)
    if (sorted[index][0] < sorted[index - 1][0] + gap) sorted[index] = [sorted[index - 1][0] + gap, sorted[index][1]];
  return sorted;
}

// A line chart of the bar judge's overall and lowest category score per judged round,
// with main's overall and the pass bar for scale.
export function chart(rounds, bar) {
  // The bar judge's scores; a round that stopped at a pre-check has none on the bar.
  const points = rounds.filter((round) => barVerdict(round)).map((round) => ({ round: round.round, overall: barVerdict(round).overall, lowest: barVerdict(round).lowest, main: barVerdict(round).baseline }));
  if (!points.length) return `<p class="muted">No judged rounds yet.</p>`;
  const width = 640;
  const height = 240;
  const pad = { left: 36, right: 96, top: 12, bottom: 28 };
  const values = points.flatMap((point) => [point.overall, point.lowest, point.main]).concat(bar);
  const low = Math.max(1, Math.floor(Math.min(...values) - 0.5));
  const high = Math.min(10, Math.ceil(Math.max(...values) + 0.25));
  const x = (index) => pad.left + (points.length === 1 ? (width - pad.left - pad.right) / 2 : (index * (width - pad.left - pad.right)) / (points.length - 1));
  const y = (value) => pad.top + ((high - value) * (height - pad.top - pad.bottom)) / (high - low || 1);
  const ticks = [];
  for (let value = low; value <= high; value += high - low > 4 ? 1 : 0.5) ticks.push(value);
  const line = (key) => points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(point[key]).toFixed(1)}`).join(" ");
  const series = [["overall", "Overall", "var(--series-1)"], ["lowest", "Lowest category", "var(--series-2)"]];
  const last = points.length - 1;
  return `<figure class="chart scroll">
<svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chart-title">
<title id="chart-title">Score per round: overall and lowest category against the pass bar ${bar}</title>
${ticks.map((value) => `<line class="grid" x1="${pad.left}" x2="${width - pad.right}" y1="${y(value)}" y2="${y(value)}"/><text class="axis" x="${pad.left - 6}" y="${y(value) + 4}" text-anchor="end">${value}</text>`).join("\n")}
${points.map((point, index) => `<text class="axis" x="${x(index)}" y="${height - 8}" text-anchor="middle">${point.round}</text>`).join("")}
<line class="bar" x1="${pad.left}" x2="${width - pad.right}" y1="${y(bar)}" y2="${y(bar)}"/>
<path class="main" d="${line("main")}"/>
${series.map(([key, name, color]) => `<path d="${line(key)}" fill="none" stroke="${color}" stroke-width="2"/>
${points.map((point, index) => `<circle cx="${x(index)}" cy="${y(point[key])}" r="4" fill="${color}" stroke="var(--surface)" stroke-width="2"><title>Round ${point.round}: ${name.toLowerCase()} ${fixed(point[key])}</title></circle>`).join("")}`).join("\n")}
${endLabels([[y(bar), `bar ${bar}`], [y(points[last].main), `main ${fixed(points[last].main)}`], [y(points[last].overall), `overall ${fixed(points[last].overall)}`], [y(points[last].lowest), `lowest ${fixed(points[last].lowest)}`]])
    .map(([at, text]) => `<text class="label" x="${width - pad.right + 6}" y="${(at + 4).toFixed(1)}">${text}</text>`).join("")}
</svg>
<figcaption><span class="key" style="--key: var(--series-1)"></span>Overall <span class="key" style="--key: var(--series-2)"></span>Lowest category <span class="key dashed"></span>Main's overall · bar judge, by round</figcaption>
</figure>`;
}

function roundsTable(rounds, config) {
  if (!rounds.length) return `<p class="muted">No rounds yet.</p>`;
  return `<div class="scroll"><table>
<thead><tr><th>Round</th><th>Commit</th><th>Result</th>${config.judges.map((judge) => `<th>${escape(judgeKey(judge))}<br><span class="muted">lowest · gain · refs</span></th>`).join("")}<th>Champion</th><th class="num">Cost</th></tr></thead>
<tbody>${rounds.map((round) => `<tr><td>${round.round}</td><td><code>${escape(round.sha.slice(0, 12))}${round.dirty ? "+dirty" : ""}</code></td>
<td>${round.pass ? `<span class="pill pass">pass</span>` : `<span class="pill fail">${round.provisional ? "provisional pass" : OUTCOME[round.stage] ?? "fail"}</span>`}${round.calibrated === false ? ` <span class="muted">uncalibrated</span>` : ""}${round.missingReferences?.length ? ` <span class="muted">without ${escape(round.missingReferences.join(", "))}</span>` : ""}</td>
${config.judges.map((judge) => {
    const v = round.verdicts?.find((item) => item.judge === judgeKey(judge));
    return v ? `<td class="num">${fixed(v.lowest)} · ${signed(v.gain)} · ${v.referenceMargin === null ? "–" : signed(v.referenceMargin)}</td>` : `<td class="muted">not run</td>`;
  }).join("")}${championCell(round)}<td class="num">${money(round.costUSD)}</td></tr>`).join("\n")}</tbody></table></div>`;
}

function categoryTable(round) {
  if (!round?.verdicts?.length || !round.verdicts[0].scores) return "";
  return `<div class="scroll"><table>
<thead><tr><th>Category</th>${round.verdicts.map((v) => `<th class="num">${escape(v.judge)}<br><span class="muted">this · main</span></th>`).join("")}</tr></thead>
<tbody>${RUBRIC.categories.map((category) => `<tr><td>${escape(category.name)}</td>${round.verdicts.map((v) => {
    const mine = v.scores.candidate[category.id];
    const main = v.scores.baseline[category.id];
    const delta = typeof mine === "number" && typeof main === "number" ? mine - main : null;
    return `<td class="num">${fixed(mine)} · ${fixed(main)}${delta === null ? "" : ` <span class="${delta > 0.005 ? "up" : delta < -0.005 ? "down" : "muted"}">${signed(delta)}</span>`}</td>`;
  }).join("")}</tr>`).join("\n")}</tbody></table></div>`;
}

function issuesList(round) {
  if (!round?.issues?.length) return `<p class="muted">No issues recorded for this round.</p>`;
  return `<ol class="issues">${round.issues.map((issue) => `<li><p>${issue.underBar ? `<span class="pill fail">under bar</span> ` : ""}${issue.since ? `<span class="pill fail">unfixed since round ${issue.since}</span> ` : ""}${issue.returns ? `<span class="pill fail">returns after round ${issue.returns.round}</span> ` : ""}<strong>${escape(issue.screen)}</strong> · ${escape(issue.category)} · <span class="sev ${escape(issue.severity)}">${escape(issue.severity)}</span> · reported ${issue.count}×</p>
<p>${escape(issue.problems[0])}</p><p class="muted">Fix: ${escape(issue.fixes[0])}</p></li>`).join("\n")}</ol>`;
}

function gatesBlock(round) {
  if (!round?.gates) return "";
  const { candidate, baseline } = round.gates.totals;
  const names = { overflow: "Sideways scroll", contrast: "Low-contrast text", unlabeled: "Unlabeled controls", targets: "Small tap targets", missingAlt: "Images without alt" };
  return `<div class="scroll"><table><thead><tr><th>Page check</th><th class="num">This</th><th class="num">Main</th></tr></thead><tbody>
${Object.entries(names).map(([key, name]) => `<tr><td>${name}</td><td class="num">${candidate[key]}</td><td class="num">${baseline[key]}</td></tr>`).join("\n")}</tbody></table></div>
${round.gates.failures.length ? `<ul class="failures">${round.gates.failures.map((failure) => `<li><pre>${escape(failure)}</pre></li>`).join("")}</ul>` : `<p class="muted">Every gate passed.</p>`}`;
}

function shotsBlock(round, versions) {
  const candidate = round ? versions[`round-${round.round}`] : null;
  const baseline = versions.baseline;
  if (!candidate?.length || !baseline?.length) return `<p class="muted">No screenshots of a round yet.</p>`;
  const before = new Map(baseline.map((shot) => [shot.id, shot]));
  return candidate.map((shot) => {
    const main = image(before.get(shot.id)?.file);
    const mine = image(shot.file);
    return `<section class="shot"><h3><code>${escape(shot.id)}</code></h3><div class="pair">
<figure>${main ? `<img src="${main}" alt="Main: ${escape(shot.id)}" loading="lazy">` : `<p class="muted">missing</p>`}<figcaption>Main</figcaption></figure>
<figure>${mine ? `<img src="${mine}" alt="Round ${round.round}: ${escape(shot.id)}" loading="lazy">` : `<p class="muted">${escape(shot.error ?? "missing")}</p>`}<figcaption>Round ${round.round}</figcaption></figure>
</div></section>`;
  }).join("\n");
}

function calibrationBlock(calibration) {
  if (!calibration) return `<p class="muted">Not calibrated yet.</p>`;
  return `<div class="scroll"><table><thead><tr><th>Judge</th><th class="num">Main</th><th class="num">Control</th><th class="num">Drop</th><th class="num">Lower in</th><th class="num">σ category</th><th class="num">σ overall</th><th>Result</th></tr></thead><tbody>
${Object.entries(calibration.judges).map(([key, item]) => `<tr><td>${escape(key)}</td><td class="num">${fixed(item.baseline)}</td><td class="num">${fixed(item.control)}</td><td class="num">${fixed(item.drop)}</td><td class="num">${typeof item.lowerShare === "number" ? `${Math.round(item.lowerShare * 100)}%` : "–"}</td><td class="num">${fixed(item.sigmaCategory)}</td><td class="num">${fixed(item.sigmaOverall)}</td><td>${item.pass ? `<span class="pill pass">pass</span>` : `<span class="pill fail">fail</span> ${escape(item.reasons.join("; "))}`}</td></tr>`).join("\n")}</tbody></table></div>
<p class="muted">${calibration.samples} calls per judge, ${money(calibration.costUSD)}, ${escape(calibration.at)}.</p>
${Object.entries(calibration.judges).filter(([, item]) => item.barReach?.warnings.length).map(([key, item]) => `<p><strong>Bar reach, ${escape(key)}:</strong> ${escape(item.barReach.warnings.join("; "))}.</p>`).join("\n")}`;
}

// Why a round has fewer verdicts than judges.
function partialReason(round) {
  if (round.stage === "error") return `In round ${round.round} a judge could not finish its calls, so the judges after it did not score it.`;
  if (round.stage === "budget") return `In round ${round.round} the budget ran out before every judge ran.`;
  if (round.skipped?.length) return `In round ${round.round} a judge failed and the round's budget did not cover ${round.skipped.join(", ")}.`;
  return `Round ${round.round} stopped at a regression pre-check that failed; the bar judge did not score it.`;
}

// rounds are the full round records; versions maps a version name to its shot records;
// champion is the run's best commit ({ round, sha }, round null for main), or null for a run
// recorded before champions were tracked.
export function renderReport({ config, run, rounds, calibration, spentUSD, versions, champion = null }) {
  const latest = rounds.at(-1);
  const judged = [...rounds].reverse().find((round) => round.verdicts?.length);
  const onBar = [...rounds].reverse().map(barVerdict).find(Boolean);
  const passed = rounds.find((round) => round.pass && !round.dirty);
  const provisional = rounds.find((round) => round.provisional && !round.dirty);
  const status = passed ? `Passed in round ${passed.round}` : provisional ? `Provisional pass in round ${provisional.round}` : latest ? `Not passed after ${rounds.length} round${rounds.length > 1 ? "s" : ""}` : "No rounds yet";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UI climb report</title>
<style>
:root {
  color-scheme: light;
  --surface: #fcfcfb; --raised: #f3f2ef; --border: #dedcd6; --text: #0b0b0b; --muted: #52514e;
  --series-1: #2a78d6; --series-2: #eb6834; --good: #1d7a3e; --good-bg: #e3f3e8; --bad: #b42318; --bad-bg: #fbe7e5;
  --radius: 8px; --gap: 16px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --surface: #1a1a19; --raised: #242422; --border: #3a3936; --text: #f0efec; --muted: #c3c2b7;
    --series-1: #3987e5; --series-2: #d95926; --good: #7fd49c; --good-bg: #183a24; --bad: #ff9c92; --bad-bg: #44201c;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --surface: #1a1a19; --raised: #242422; --border: #3a3936; --text: #f0efec; --muted: #c3c2b7;
  --series-1: #3987e5; --series-2: #d95926; --good: #7fd49c; --good-bg: #183a24; --bad: #ff9c92; --bad-bg: #44201c;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1120px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 40px 0 12px; padding-top: 16px; border-top: 1px solid var(--border); }
h3 { font-size: 14px; margin: 0 0 8px; font-weight: 600; }
p { margin: 0 0 8px; }
code, pre { font: 13px/1.45 ui-monospace, "SF Mono", Menlo, monospace; }
pre { white-space: pre-wrap; margin: 0; }
.muted { color: var(--muted); }
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--gap); margin: 20px 0 0; }
.summary div { background: var(--raised); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; }
.summary dt { color: var(--muted); font-size: 13px; }
.summary dd { margin: 2px 0 0; font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { font-weight: 600; font-size: 13px; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 13px; font-weight: 600; }
.pill.pass { color: var(--good); background: var(--good-bg); }
.pill.fail { color: var(--bad); background: var(--bad-bg); }
.up { color: var(--good); } .down { color: var(--bad); }
.chart { margin: 0; }
.chart svg { width: 100%; min-width: 520px; max-width: 760px; height: auto; display: block; }
.chart .grid { stroke: var(--border); stroke-width: 1; }
.chart .axis, .chart .label { fill: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.chart .label { fill: var(--text); }
.chart .bar { stroke: var(--text); stroke-width: 1; stroke-dasharray: 2 4; }
.chart .main { fill: none; stroke: var(--muted); stroke-width: 2; stroke-dasharray: 6 4; }
.chart figcaption { color: var(--muted); font-size: 13px; display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; }
.key { display: inline-block; width: 16px; height: 0; border-top: 2px solid var(--key); margin-right: -6px; vertical-align: middle; }
.key.dashed { border-top: 2px dashed var(--muted); }
.issues { padding-left: 24px; }
.issues li { margin-bottom: 14px; }
.sev.high { color: var(--bad); font-weight: 600; }
.failures { padding-left: 20px; }
.shot { margin: 0 0 28px; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: var(--gap); }
.pair figure { margin: 0; }
.pair img { width: 100%; height: auto; display: block; border: 1px solid var(--border); border-radius: var(--radius); }
.pair figcaption { color: var(--muted); font-size: 13px; margin-top: 4px; }
@media (max-width: 700px) { .pair { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
<h1>UI climb: ${escape(config.name)}</h1>
<p class="muted">Run ${escape(run.id)} · main <code>${escape(run.baseline.sha.slice(0, 12))}</code> (${escape(run.baseline.rev)}) · rubric v${RUBRIC.version}${run.council ? ` · council <code>${escape(run.council)}</code>` : ""}</p>
<dl class="summary">
<div><dt>Status</dt><dd>${escape(status)}</dd></div>
<div><dt>Rounds</dt><dd>${rounds.length}</dd></div>
<div><dt>Latest lowest</dt><dd>${onBar ? `${fixed(onBar.lowest)} / ${config.pass.min}` : "–"}</dd></div>
<div><dt>Latest gain over main</dt><dd>${onBar ? signed(onBar.gain) : "–"}</dd></div>
<div><dt>Champion</dt><dd>${champion ? (champion.round === null ? "main" : `round ${champion.round} · <code>${escape(champion.sha.slice(0, 12))}</code>`) : "–"}</dd></div>
<div><dt>Spent</dt><dd>${money(spentUSD)} of ${money(config.budgetUsd.run)}</dd></div>
</dl>
${latest?.missingReferences?.length ? `<p style="margin-top:12px"><span class="pill fail">${escape(latest.missingReferences.length === 1 ? "missing reference" : "missing references")}</span> Round ${latest.round} was judged without ${escape(latest.missingReferences.join(", "))}, which did not capture.${config.pass.allReferences ? " A pass without every reference is provisional, not final: judge the round again once it captures." : ""}</p>` : ""}
${judged && judged.verdicts.length < config.judges.length ? `<p style="margin-top:12px"><span class="pill fail">${judged.verdicts.length} of ${config.judges.length} judges</span> ${escape(partialReason(judged))}</p>` : ""}
<p class="muted" style="margin-top:12px">${config.judges.length > 1 ? `Judges before the last are regression pre-checks: a round stops when one scores the candidate under main by more than ${config.pass.regression} times its noise. ` : ""}A round passes when the last judge scores each category at least ${config.pass.min}, the overall at least ${config.pass.gain} above main (or twice the judge's noise, if larger)${config.pass.references === null ? "" : `, and each category ${signed(config.pass.references)} or more over the best reference`}. Judges see every version unlabeled and shuffled. The last judge also scores the run's champion, its best commit so far: a round more than ${config.pass.champion} times that judge's noise over it becomes the champion, and one that far under it is rejected.</p>
<h2>Score by round</h2>
${chart(rounds, config.pass.min)}
<h2>Rounds</h2>
${roundsTable(rounds, config)}
${judged ? `<h2>Categories in round ${judged.round}</h2>${categoryTable(judged)}<h2>Top issues in round ${judged.round}</h2>${issuesList(judged)}` : ""}
${latest ? `<h2>Gates in round ${latest.round}</h2>${gatesBlock(latest)}` : ""}
${(() => {
    const shown = [...rounds].reverse().find((round) => versions[`round-${round.round}`]);
    return `<h2>Main and round ${shown?.round ?? "–"}</h2>\n${shotsBlock(shown, versions)}`;
  })()}
<h2>Calibration</h2>
${calibrationBlock(calibration)}
</main>
</body>
</html>
`;
}
