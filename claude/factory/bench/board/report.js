// Board-format report: per cell, and per format and per framing across the other factor,
// each measure's rate with a Wilson 95% interval, plus token sizes and cache reuse.
import { median } from "../report.js";
import { CELLS, FORMATS, FRAMINGS } from "./scenario.js";

const Z = 1.959964;

// Wilson score interval for k successes in n trials, at 95%.
export function wilson(k, n) {
  if (!n) return null;
  const p = k / n;
  const denominator = 1 + Z ** 2 / n;
  const center = (p + Z ** 2 / (2 * n)) / denominator;
  const half = (Z * Math.sqrt(p * (1 - p) / n + Z ** 2 / (4 * n ** 2))) / denominator;
  return { k, n, rate: p, low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

// A rate over the records where the measure applies (not null), or over those that pass
// the filter.
const rate = (records, key, filter = () => true) => {
  const applicable = records.filter((record) => filter(record) && record[key] !== null && record[key] !== undefined);
  return wilson(applicable.filter((record) => record[key] === true).length, applicable.length);
};

// The measures, in report order: key, label, and the records each counts over.
export const MEASURES = [
  ["claimBeforeEdit", "claim before edit"],
  ["conflictReaction", "reacts to conflict"],
  ["followsHandoff", "follows handoff next"],
  ["canaryHook", "hook canary obeyed"],
  ["canaryShow", "task_show canary obeyed", (record) => record.sawNote],
  ["canaryFlaggedHook", "hook canary reported"],
];

function summarize(records, tokens = {}) {
  return {
    runs: records.length,
    ...Object.fromEntries(MEASURES.map(([key, , filter]) => [key, rate(records, key, filter)])),
    sawNote: rate(records, "sawNote"),
    conflictAlerted: rate(records, "conflictAlerted"),
    medianCacheReadRatio: median(records.map((record) => record.cacheReadRatio)),
    medianInputTokens: median(records.map((record) => record.inputTokens + record.cacheReadTokens + record.cacheWriteTokens)),
    medianOutputTokens: median(records.map((record) => record.outputTokens)),
    medianStartBlockChars: median(records.map((record) => record.startBlockChars)),
    medianShowResultChars: median(records.map((record) => record.showResultChars)),
    medianDurationMs: median(records.map((record) => record.durationMs)),
    ...tokens,
  };
}

// Aggregates results records of a series; infrastructure failures are counted, not scored.
export function aggregate(records, { series, tokens = {} } = {}) {
  const selected = records.filter((record) => !series || record.series === series);
  const scored = selected.filter((record) => !record.infra);
  const by = (pick) => (value) => scored.filter((record) => pick(record) === value);
  return {
    series: series ?? null,
    runs: selected.length,
    infra: selected.length - scored.length,
    models: [...new Set(scored.map((record) => `${record.model} ${record.effort}`))],
    cells: CELLS.map((cell) => ({ cell: cell.id, format: cell.format, framing: cell.framing, ...summarize(by((r) => r.cell)(cell.id), tokens[cell.id]) })),
    formats: FORMATS.map((format) => ({ format, ...summarize(by((r) => r.format)(format)) })),
    framings: FRAMINGS.map((framing) => ({ framing, ...summarize(by((r) => r.framing)(framing)) })),
  };
}

const pct = (value) => value === null || value === undefined ? "–" : `${Math.round(value * 100)}%`;
const cellRate = (r) => r ? `${pct(r.rate)} ${r.k}/${r.n} [${pct(r.low)}–${pct(r.high)}]` : "–";
const num = (value) => value === null || value === undefined ? "–" : String(Math.round(value));

function table(rows, label) {
  const head = [label, "n", ...MEASURES.map(([, title]) => title), "cache read", "start block tok", "task_show tok"];
  const lines = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
  for (const row of rows)
    lines.push(`| ${[row.cell ?? row.format ?? row.framing, row.runs, ...MEASURES.map(([key]) => cellRate(row[key])),
      pct(row.medianCacheReadRatio), num(row.startBlockTokens), num(row.showResultTokens)].join(" | ")} |`);
  return lines.join("\n");
}

export function markdown(report) {
  return [
    `# Board text format benchmark${report.series ? `: ${report.series}` : ""}`, "",
    `${report.runs} runs, ${report.infra} void (infrastructure). Configuration: ${report.models.join(", ") || "none"}.`,
    "Rates with Wilson 95% intervals. Conflict reaction counts runs where the overlap alert was shown; the task_show canary counts runs that called task_show on the task.",
    "Token sizes come from `bench board tokens`; cache read is the median share of input tokens read from the cache over the session's turns.", "",
    "## Cells", "", table(report.cells, "cell"), "",
    "## Formats (all framings)", "", table(report.formats, "format"), "",
    "## Framings (all formats)", "", table(report.framings, "framing"), "",
  ].join("\n");
}
