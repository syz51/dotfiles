// bench style: the report-style benchmark (style.js). Results and the last report live
// in the state folder under bench/style/.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { appendJsonl, readJsonl, statePath, writeJsonAtomic } from "../../lib/state.js";
import { cliVersion, runMatrix } from "../runner.js";
import { CASES_FILE, VARIANTS, aggregate, loadCases, markdown, runOne } from "./style.js";

export const resultsPath = () => statePath("bench", "style", "results.jsonl");

const USAGE = `Usage: bun ~/.claude/factory/cli.js bench style <subcommand> [options]

  list                       List cases and their fact counts
  run                        Write each case's report under each variant, then judge its facts
      --case <id>            A case to run (repeatable; default all)
      --variants a,b         From ${VARIANTS.join(", ")} (default both)
      --trials N             Trials per case and variant (default 3)
      --model M              Report model (default claude-opus-5-5)
      --effort E             Report effort (default high, the configured effort)
      --judge-model M        Judge model (default claude-sonnet-5-5)
      --parallel N           Runs at the same time (default 4)
      --max-total-usd X      Stop starting runs that could take spending past X (default 20)
      --dry-run              Print the matrix and its worst-case cost
  report                     Facts kept and sentence length per variant, and the decision
      --batch <id>           Only this batch (repeatable; default all)
      --json

Every subcommand takes --cases <file> (default ${CASES_FILE}).`;

class UsageError extends Error {}

const OPTIONS = {
  cases: { type: "string", default: CASES_FILE },
  case: { type: "string", multiple: true, default: [] },
  variants: { type: "string", default: VARIANTS.join(",") },
  trials: { type: "string", default: "3" },
  model: { type: "string", default: "claude-opus-5-5" },
  effort: { type: "string", default: "high" },
  "judge-model": { type: "string", default: "claude-sonnet-5-5" },
  parallel: { type: "string", default: "4" },
  "max-total-usd": { type: "string", default: "20" },
  "dry-run": { type: "boolean", default: false },
  batch: { type: "string", multiple: true, default: [] },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
};

// Budgets per call: a report is one tool-less turn; the judge reads it once.
const REPORT_BUDGET = 1;
const JUDGE_BUDGET = 0.5;

const money = (value) => `$${value.toFixed(2)}`;
const list = (value) => value.split(",").map((item) => item.trim()).filter(Boolean);

function number(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new UsageError(`${flag} must be a positive integer`);
  return parsed;
}

// Trials outermost, so a budget stop leaves both variants with similar coverage.
export function matrix(cases, variants, trials) {
  const jobs = [];
  for (let trial = 1; trial <= trials; trial++)
    for (const benchCase of cases)
      for (const variant of variants) jobs.push({ benchCase, variant, trial, budgetUsd: REPORT_BUDGET + JUDGE_BUDGET });
  return jobs;
}

async function runCommand(values) {
  const variants = list(values.variants);
  if (!variants.length || variants.some((variant) => !VARIANTS.includes(variant))) throw new UsageError(`--variants must be from ${VARIANTS.join(", ")}`);
  for (const flag of ["model", "judge-model"])
    if (!/^claude-[a-z0-9-]+$/.test(values[flag])) throw new UsageError(`--${flag} needs a full model ID such as claude-sonnet-5-5`);
  const trials = number(values.trials, "--trials");
  const parallel = number(values.parallel, "--parallel");
  const maxTotalUsd = Number(values["max-total-usd"]);
  if (!Number.isFinite(maxTotalUsd) || maxTotalUsd <= 0) throw new UsageError("--max-total-usd must be a positive number");
  const all = loadCases(values.cases);
  const missing = values.case.filter((id) => !all.some((benchCase) => benchCase.id === id));
  if (missing.length) throw new UsageError(`Unknown case: ${missing.join(", ")}`);
  const cases = values.case.length ? all.filter((benchCase) => values.case.includes(benchCase.id)) : all;
  const jobs = matrix(cases, variants, trials);
  const worst = jobs.reduce((sum, job) => sum + job.budgetUsd, 0);
  if (values["dry-run"]) {
    for (const job of jobs) console.log(`${job.benchCase.id} ${job.variant} trial ${job.trial} ${money(job.budgetUsd)}`);
    console.log(`\n${jobs.length} runs, worst case ${money(worst)} (limit ${money(maxTotalUsd)}).`);
    return 0;
  }
  const version = await cliVersion();
  const batch = `${new Date().toISOString().replace(/[-:.]/g, "")}-${crypto.randomUUID().slice(0, 8)}`;
  const results = resultsPath();
  console.log(`Batch ${batch}: ${jobs.length} runs, worst case ${money(worst)}, limit ${money(maxTotalUsd)}, ${version ?? "unknown CLI version"}.`);
  const options = { model: values.model, effort: values.effort, judgeModel: values["judge-model"], batch, budgetUsd: REPORT_BUDGET, judgeBudgetUsd: JUDGE_BUDGET };
  const { records, spent, skipped } = await runMatrix(jobs, {
    parallel, maxTotalUsd,
    execute: (job) => runOne(job.benchCase, { ...options, variant: job.variant, trial: job.trial }),
    onRecord(record) {
      appendJsonl(results, { ...record, cliVersion: version });
      const outcome = record.infra ? `INFRA (${record.error})` : `kept ${record.kept}/${record.facts}, ${record.stats.meanWords.toFixed(1)} words per sentence`;
      console.log(`${record.caseId} ${record.variant} trial ${record.trial}: ${outcome}, ${money(record.costUSD)}`);
    },
  });
  console.log(`\nSpent ${money(spent)} on ${records.length} runs; results in ${results}.`);
  if (skipped) console.log(`Stopped at the ${money(maxTotalUsd)} limit: ${skipped} runs not started.`);
  console.log(`\n${markdown(aggregate(records))}`);
  const infra = records.filter((record) => record.infra).length;
  if (infra) console.error(`${infra} runs failed for infrastructure reasons; fix the cause and rerun them.`);
  return infra ? 1 : 0;
}

function reportCommand(values) {
  const records = readJsonl(resultsPath()).filter((record) => !values.batch.length || values.batch.includes(record.batch));
  const summary = aggregate(records);
  const text = markdown(summary);
  writeFileSync(statePath("bench", "style", "report.md"), `${text}\n`);
  writeJsonAtomic(statePath("bench", "style", "report.json"), summary);
  console.log(values.json ? JSON.stringify(summary, null, 2) : text);
  return 0;
}

export async function run(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(USAGE);
    return subcommand ? 0 : 2;
  }
  try {
    const { values } = parseArgs({ args: rest, options: OPTIONS, strict: true, allowPositionals: false });
    if (values.help) {
      console.log(USAGE);
      return 0;
    }
    switch (subcommand) {
      case "list":
        for (const benchCase of loadCases(values.cases)) console.log(`${benchCase.id.padEnd(22)} ${String(benchCase.facts.length).padStart(2)} facts  ${benchCase.title}`);
        return 0;
      case "run":
        return await runCommand(values);
      case "report":
        return reportCommand(values);
      default:
        throw new UsageError(`Unknown bench style subcommand: ${subcommand}`);
    }
  } catch (error) {
    if (error instanceof UsageError || error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || error.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      console.error(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    console.error(error.message);
    return 1;
  }
}
