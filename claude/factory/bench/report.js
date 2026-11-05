// Benchmark report: pass rate, median cost and duration per configuration (model and
// effort), for each case and for each role across its cases; the cost-vs-pass-rate
// Pareto front; and the cheapest configuration within a margin of the best pass rate.
export const MIN_TRIALS = 3;

export function median(values) {
  const sorted = values.filter((value) => typeof value === "number").sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const configKey = (record) => `${record.model} ${record.effort}`;

function summarize(records) {
  const passes = records.filter((record) => record.pass).length;
  return {
    model: records[0].model, effort: records[0].effort, runs: records.length, passes,
    passRate: passes / records.length,
    medianCostUSD: median(records.map((record) => record.costUSD)),
    medianDurationMs: median(records.map((record) => record.durationMs)),
  };
}

// Configurations no other configuration beats on both cost and pass rate. Configurations
// without a known cost are left out.
export function paretoFront(configs) {
  const priced = configs.filter((config) => typeof config.medianCostUSD === "number");
  return priced.filter((config) => !priced.some((other) => other !== config
    && other.medianCostUSD <= config.medianCostUSD && other.passRate >= config.passRate
    && (other.medianCostUSD < config.medianCostUSD || other.passRate > config.passRate)))
    .sort((a, b) => a.medianCostUSD - b.medianCostUSD);
}

// The cheapest configuration whose pass rate is within margin of the best, once every
// configuration has at least MIN_TRIALS runs.
export function recommend(configs, margin, minRuns = (config) => config.runs) {
  if (!configs.length) return { status: "no runs" };
  const short = configs.filter((config) => minRuns(config) < MIN_TRIALS);
  if (short.length)
    return { status: "not enough trials", need: MIN_TRIALS, short: short.map(({ model, effort }) => `${model} ${effort}`) };
  const best = Math.max(...configs.map((config) => config.passRate));
  const eligible = configs.filter((config) => config.passRate >= best - margin - 1e-9 && typeof config.medianCostUSD === "number")
    .sort((a, b) => a.medianCostUSD - b.medianCostUSD || b.passRate - a.passRate);
  if (!eligible.length) return { status: "no priced configuration" };
  const { model, effort, passRate, medianCostUSD } = eligible[0];
  return { status: "ok", model, effort, passRate, medianCostUSD, bestPassRate: best, margin };
}

const groupBy = (items, key) => items.reduce((groups, item) => {
  const name = key(item);
  (groups[name] ??= []).push(item);
  return groups;
}, {});

// Aggregates results records. Infrastructure failures are counted but not scored.
export function aggregate(records, { margin = 0.1, caseIds, role } = {}) {
  const selected = records.filter((record) => (!caseIds?.length || caseIds.includes(record.caseId)) && (!role || record.role === role));
  const scored = selected.filter((record) => !record.infra);
  const roles = Object.entries(groupBy(scored, (record) => record.role)).sort(([a], [b]) => a.localeCompare(b)).map(([name, roleRecords]) => {
    const cases = Object.entries(groupBy(roleRecords, (record) => record.caseId)).sort(([a], [b]) => a.localeCompare(b)).map(([caseId, caseRecords]) => {
      const configs = Object.values(groupBy(caseRecords, configKey)).map(summarize)
        .sort((a, b) => (a.medianCostUSD ?? Infinity) - (b.medianCostUSD ?? Infinity));
      return { caseId, configs, pareto: paretoFront(configs), recommendation: recommend(configs, margin) };
    });
    // Across the role's cases, only configurations that ran every case compare fairly:
    // their pass rate is the mean of per-case pass rates and their cost the sum of
    // per-case medians.
    const keys = Object.keys(groupBy(roleRecords, configKey))
      .filter((key) => cases.every((entry) => entry.configs.some((config) => configKey(config) === key)));
    const overall = keys.map((key) => {
      const perCase = cases.map((entry) => entry.configs.find((config) => configKey(config) === key));
      const costs = perCase.map((config) => config.medianCostUSD);
      return {
        model: perCase[0].model, effort: perCase[0].effort,
        runs: perCase.reduce((sum, config) => sum + config.runs, 0),
        minCaseRuns: Math.min(...perCase.map((config) => config.runs)),
        passRate: perCase.reduce((sum, config) => sum + config.passRate, 0) / perCase.length,
        medianCostUSD: costs.every((cost) => typeof cost === "number") ? costs.reduce((a, b) => a + b, 0) : null,
        medianDurationMs: perCase.reduce((sum, config) => sum + (config.medianDurationMs ?? 0), 0),
      };
    }).sort((a, b) => (a.medianCostUSD ?? Infinity) - (b.medianCostUSD ?? Infinity));
    return {
      role: name, cases, overall, pareto: paretoFront(overall),
      recommendation: recommend(overall, margin, (config) => config.minCaseRuns),
    };
  });
  return {
    generatedAt: new Date().toISOString(), margin, runs: selected.length,
    infraFailures: selected.length - scored.length, roles,
  };
}

const usd = (value) => typeof value === "number" ? `$${value.toFixed(value < 1 ? 3 : 2)}` : "n/a";
const seconds = (ms) => typeof ms === "number" ? `${(ms / 1000).toFixed(1)}s` : "n/a";
const percent = (rate) => `${Math.round(rate * 100)}%`;
const name = (config) => `${config.model} ${config.effort}`;

function table(configs, pareto) {
  const front = new Set(pareto);
  return ["| Configuration | Pass rate | Median cost | Median duration | Runs | Pareto |", "|---|---|---|---|---|---|",
    ...configs.map((config) => `| ${name(config)} | ${percent(config.passRate)} | ${usd(config.medianCostUSD)} | ${seconds(config.medianDurationMs)} | ${config.runs} | ${front.has(config) ? "yes" : ""} |`)];
}

function recommendation(result) {
  switch (result.status) {
    case "ok":
      return `Recommendation: ${result.model} ${result.effort} (${percent(result.passRate)} at ${usd(result.medianCostUSD)}; best ${percent(result.bestPassRate)}, margin ${percent(result.margin)}).`;
    case "not enough trials":
      return `Recommendation: not enough trials (need ${result.need} per configuration; short: ${result.short.join(", ")}).`;
    default:
      return `Recommendation: none (${result.status}).`;
  }
}

export function markdown(report) {
  const lines = ["# Benchmark report", "", `Generated ${report.generatedAt}. ${report.runs} runs`
    + (report.infraFailures ? `, ${report.infraFailures} infrastructure failures left out` : "") + `. Margin ${percent(report.margin)}.`];
  if (!report.roles.length) lines.push("", "No scored runs.");
  for (const role of report.roles) {
    lines.push("", `## Role: ${role.role}`);
    for (const entry of role.cases)
      lines.push("", `### Case: ${entry.caseId}`, "", ...table(entry.configs, entry.pareto), "", recommendation(entry.recommendation));
    if (role.cases.length > 1) {
      lines.push("", `### All ${role.role} cases`, "", "Configurations that ran every case: mean pass rate, summed median cost and duration.", "");
      lines.push(...(role.overall.length ? table(role.overall, role.pareto) : ["No configuration ran every case."]), "", recommendation(role.recommendation));
    }
  }
  return `${lines.join("\n")}\n`;
}
