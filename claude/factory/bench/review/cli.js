// bench review: the /code-review level benchmark (review.js). Results and the last
// report live in the state folder under bench/review/.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { appendJsonl, readJsonl, statePath, writeJsonAtomic } from "../../lib/state.js";
import { cliVersion, runMatrix } from "../runner.js";
import { CASES_FILE, DEFAULT_CONFIGS, JUDGE_BUDGET, REPO_ROOT, REVIEW_BUDGETS, aggregate, loadCases, markdown, parseConfigs, runOne } from "./review.js";

export const resultsPath = () => statePath("bench", "review", "results.jsonl");

const USAGE = `Usage: bun ~/.claude/factory/cli.js bench review <subcommand> [options]

  list                       List cases
  run                        Review each case under each configuration, then judge the findings
      --case <id>            A case to run (repeatable; default all)
      --configs m:l,...      Model and review level pairs (default ${DEFAULT_CONFIGS})
      --trials N             Trials per case and configuration (default 3)
      --judge-model M        Judge model (default claude-opus-5-5)
      --parallel N           Runs at the same time (default 2)
      --max-total-usd X      Stop starting runs that could take spending past X (default 40)
      --repo <path>          The repository the cases come from (default this checkout)
      --dry-run              Print the matrix and its worst-case cost
  report                     Recall, findings, harmful findings, cost and time per configuration
      --batch <id>           Only this batch (repeatable; default all)
      --json

Every subcommand takes --cases <file> (default ${CASES_FILE}).`;

class UsageError extends Error {}

const OPTIONS = {
  cases: { type: "string", default: CASES_FILE },
  case: { type: "string", multiple: true, default: [] },
  configs: { type: "string", default: DEFAULT_CONFIGS },
  trials: { type: "string", default: "3" },
  "judge-model": { type: "string", default: "claude-opus-5-5" },
  parallel: { type: "string", default: "2" },
  "max-total-usd": { type: "string", default: "40" },
  repo: { type: "string", default: REPO_ROOT },
  "dry-run": { type: "boolean", default: false },
  batch: { type: "string", multiple: true, default: [] },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
};

const money = (value) => `$${value.toFixed(2)}`;

function number(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new UsageError(`${flag} must be a positive integer`);
  return parsed;
}

// Trials outermost, so a budget stop leaves every configuration with similar coverage.
export function matrix(cases, configs, trials) {
  const jobs = [];
  for (let trial = 1; trial <= trials; trial++)
    for (const benchCase of cases)
      for (const config of configs) jobs.push({ benchCase, ...config, trial, budgetUsd: REVIEW_BUDGETS[config.level] + JUDGE_BUDGET });
  return jobs;
}

async function runCommand(values) {
  let configs;
  try {
    configs = parseConfigs(values.configs);
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (!configs.length) throw new UsageError("--configs names no configuration");
  if (!/^claude-[a-z0-9-]+$/.test(values["judge-model"])) throw new UsageError("--judge-model needs a full model ID such as claude-opus-5-5");
  const trials = number(values.trials, "--trials");
  const parallel = number(values.parallel, "--parallel");
  const maxTotalUsd = Number(values["max-total-usd"]);
  if (!Number.isFinite(maxTotalUsd) || maxTotalUsd <= 0) throw new UsageError("--max-total-usd must be a positive number");
  const all = loadCases(values.cases);
  const missing = values.case.filter((id) => !all.some((benchCase) => benchCase.id === id));
  if (missing.length) throw new UsageError(`Unknown case: ${missing.join(", ")}`);
  const cases = values.case.length ? all.filter((benchCase) => values.case.includes(benchCase.id)) : all;
  const jobs = matrix(cases, configs, trials);
  const worst = jobs.reduce((sum, job) => sum + job.budgetUsd, 0);
  if (values["dry-run"]) {
    for (const job of jobs) console.log(`${job.benchCase.id} ${job.model} ${job.level} trial ${job.trial} ${money(job.budgetUsd)}`);
    console.log(`\n${jobs.length} runs, worst case ${money(worst)} (limit ${money(maxTotalUsd)}).`);
    return 0;
  }
  const version = await cliVersion();
  const batch = `${new Date().toISOString().replace(/[-:.]/g, "")}-${crypto.randomUUID().slice(0, 8)}`;
  const results = resultsPath();
  console.log(`Batch ${batch}: ${jobs.length} runs, worst case ${money(worst)}, limit ${money(maxTotalUsd)}, ${version ?? "unknown CLI version"}.`);
  const { records, spent, skipped } = await runMatrix(jobs, {
    parallel, maxTotalUsd,
    execute: (job) => runOne(job.benchCase, { model: job.model, level: job.level, trial: job.trial, batch, judgeModel: values["judge-model"], repo: values.repo }),
    onRecord(record) {
      appendJsonl(results, { ...record, cliVersion: version });
      const outcome = record.infra ? `INFRA (${record.error})`
        : record.kind === "bug" ? `${record.matched ? "found" : "missed"} the bug, ${record.findings} findings`
        : `${record.harmful} harmful of ${record.findings} findings`;
      console.log(`${record.caseId} ${record.model} ${record.level} trial ${record.trial}: ${outcome}, ${money(record.costUSD)}`);
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
  writeFileSync(statePath("bench", "review", "report.md"), `${text}\n`);
  writeJsonAtomic(statePath("bench", "review", "report.json"), summary);
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
        for (const benchCase of loadCases(values.cases)) console.log(`${benchCase.id.padEnd(36)} ${benchCase.kind.padEnd(5)} ${benchCase.head.slice(0, 12)}`);
        return 0;
      case "run":
        return await runCommand(values);
      case "report":
        return reportCommand(values);
      default:
        throw new UsageError(`Unknown bench review subcommand: ${subcommand}`);
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
