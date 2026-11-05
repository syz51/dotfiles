// bench: benchmark model and effort configurations on real tasks. Subcommands list,
// run, report and add-from-commit; results and reports live in the state folder.
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { addFromCommit } from "./add.js";
import { CASES_DIR, loadCases } from "./cases.js";
import { aggregate, markdown } from "./report.js";
import { cliVersion, runMatrix, runOne } from "./runner.js";
import { appendJsonl, readJsonl, statePath, writeJsonAtomic } from "../lib/state.js";

const DEFAULT_MODELS = "claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const resultsPath = () => statePath("bench", "results.jsonl");

const USAGE = `Usage: bun ~/.claude/factory/cli.js bench <subcommand> [options]

  list                       List cases
  run                        Run a model x effort x trials matrix
      --case <id>            A case to run (repeatable; default all)
      --models a,b           Models (default ${DEFAULT_MODELS})
      --efforts a,b          Efforts (default medium,high)
      --trials N             Trials per configuration (default 1)
      --parallel N           Runs at the same time (default 1)
      --max-total-usd X      Stop starting runs that could take spending past X (default 10)
      --dry-run              Print the matrix and its worst-case cost
  report                     Pass rate, cost and duration per configuration
      --case <id>, --role <role>, --margin X (default 0.1), --json
  add-from-commit            Make a case from a commit whose tests the oracle runs
      --repo <path> --sha <sha> --tests <path,...> --oracle "<cmd>" --id <id>
      [--role worker] [--prompt "..."] [--title "..."] [--budget-usd 3]
      [--timeout-ms 900000] [--oracle-timeout-ms 300000]

Every subcommand takes --cases <dir> (default ${CASES_DIR}).`;

const list = (value) => value.split(",").map((item) => item.trim()).filter(Boolean);

function number(value, flag, { integer = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed)))
    throw new UsageError(`${flag} must be a positive ${integer ? "integer" : "number"}`);
  return parsed;
}

class UsageError extends Error {}

const OPTIONS = {
  cases: { type: "string", default: CASES_DIR },
  case: { type: "string", multiple: true, default: [] },
  models: { type: "string", default: DEFAULT_MODELS },
  efforts: { type: "string", default: "medium,high" },
  trials: { type: "string", default: "1" },
  parallel: { type: "string", default: "1" },
  "max-total-usd": { type: "string", default: "10" },
  "dry-run": { type: "boolean", default: false },
  role: { type: "string" },
  margin: { type: "string", default: "0.1" },
  json: { type: "boolean", default: false },
  repo: { type: "string" },
  sha: { type: "string" },
  tests: { type: "string" },
  oracle: { type: "string" },
  id: { type: "string" },
  prompt: { type: "string" },
  title: { type: "string" },
  "budget-usd": { type: "string", default: "3" },
  "timeout-ms": { type: "string", default: "900000" },
  "oracle-timeout-ms": { type: "string", default: "300000" },
  help: { type: "boolean", short: "h", default: false },
};

const money = (value) => `$${value.toFixed(2)}`;

function selectCases(all, ids) {
  if (!ids.length) return all;
  const missing = ids.filter((id) => !all.some((benchCase) => benchCase.id === id));
  if (missing.length) throw new UsageError(`Unknown case: ${missing.join(", ")}`);
  return all.filter((benchCase) => ids.includes(benchCase.id));
}

// Trials outermost, so a budget stop leaves every configuration with similar coverage.
export function matrix(cases, models, efforts, trials) {
  const jobs = [];
  for (let trial = 1; trial <= trials; trial++)
    for (const benchCase of cases)
      for (const model of models)
        for (const effort of efforts) jobs.push({ benchCase, model, effort, trial, budgetUsd: benchCase.budgetUsd });
  return jobs;
}

async function runCommand(values) {
  const models = list(values.models);
  const efforts = list(values.efforts);
  // Full IDs, so the model each session reports can be checked against the request.
  if (!models.length || models.some((model) => !/^claude-[a-z0-9-]+$/.test(model)))
    throw new UsageError("--models needs full model IDs such as claude-sonnet-5-5");
  const badEffort = efforts.find((effort) => !EFFORTS.includes(effort));
  if (!efforts.length || badEffort) throw new UsageError(`--efforts must be from ${EFFORTS.join(", ")}`);
  const trials = number(values.trials, "--trials", { integer: true });
  const parallel = number(values.parallel, "--parallel", { integer: true });
  const maxTotalUsd = number(values["max-total-usd"], "--max-total-usd");
  const cases = selectCases(loadCases(values.cases), values.case);
  if (!cases.length) throw new UsageError(`No cases in ${values.cases}`);
  const jobs = matrix(cases, models, efforts, trials);
  const worst = jobs.reduce((sum, job) => sum + job.budgetUsd, 0);
  if (values["dry-run"]) {
    console.log("| Case | Role | Model | Effort | Trial | Budget |\n|---|---|---|---|---|---|");
    for (const job of jobs) console.log(`| ${job.benchCase.id} | ${job.benchCase.role} | ${job.model} | ${job.effort} | ${job.trial} | ${money(job.budgetUsd)} |`);
    let fit = 0;
    for (let total = 0; fit < jobs.length && total + jobs[fit].budgetUsd <= maxTotalUsd + 1e-9; fit++) total += jobs[fit].budgetUsd;
    console.log(`\n${jobs.length} runs, worst case ${money(worst)} (limit ${money(maxTotalUsd)}${fit < jobs.length ? `; at least the first ${fit} runs fit` : ""}).`);
    return 0;
  }
  const version = await cliVersion();
  const batch = `${new Date().toISOString().replace(/[-:.]/g, "")}-${crypto.randomUUID().slice(0, 8)}`;
  const results = resultsPath();
  let sequence = 0;
  console.log(`Batch ${batch}: ${jobs.length} runs, worst case ${money(worst)}, limit ${money(maxTotalUsd)}, ${version ?? "unknown CLI version"}.`);
  const { records, spent, skipped } = await runMatrix(jobs, {
    parallel, maxTotalUsd,
    execute: (job) => runOne(job.benchCase, { ...job, runId: `${batch}-${++sequence}`, batch, cliVersion: version }),
    onRecord(record) {
      appendJsonl(results, record);
      const status = record.infra ? "INFRA" : record.pass ? "PASS" : "FAIL";
      const cost = typeof record.costUSD === "number" ? `$${record.costUSD.toFixed(record.costUSD < 1 ? 3 : 2)}` : "cost n/a";
      console.log(`${status.padEnd(5)} ${record.caseId} ${record.model} ${record.effort} trial ${record.trial}: ${cost}, ${((record.durationMs ?? 0) / 1000).toFixed(1)}s, ${record.turns ?? "?"} turns`
        + `${record.modelObserved && record.modelObserved !== record.model ? `, ran ${record.modelObserved}` : ""}${record.error ? ` (${record.error.split("\n")[0]})` : ""}`);
    },
  });
  console.log(`\nSpent ${money(spent)} on ${records.length} runs; results in ${results}.`);
  if (skipped) console.log(`Stopped at the ${money(maxTotalUsd)} limit: ${skipped} runs not started.`);
  const infra = records.filter((record) => record.infra).length;
  if (infra) console.error(`${infra} runs failed for infrastructure reasons; fix the cause and rerun them.`);
  return infra ? 1 : 0;
}

function reportCommand(values) {
  const margin = Number(values.margin);
  if (!Number.isFinite(margin) || margin < 0 || margin > 1) throw new UsageError("--margin must be between 0 and 1");
  const report = aggregate(readJsonl(resultsPath()), { margin, caseIds: values.case, role: values.role });
  const text = markdown(report);
  writeFileSync(statePath("bench", "report.md"), text);
  writeJsonAtomic(statePath("bench", "report.json"), report);
  console.log(values.json ? JSON.stringify(report, null, 2) : text.trimEnd());
  return 0;
}

async function addCommand(values) {
  for (const flag of ["repo", "sha", "tests", "oracle", "id"])
    if (!values[flag]) throw new UsageError(`add-from-commit needs --${flag}`);
  const { benchCase, commit, parent } = await addFromCommit({
    repo: values.repo, sha: values.sha, tests: list(values.tests), oracle: values.oracle,
    role: values.role ?? "worker", id: values.id, prompt: values.prompt, title: values.title,
    casesDir: values.cases,
    budgetUsd: number(values["budget-usd"], "--budget-usd"),
    timeoutMs: number(values["timeout-ms"], "--timeout-ms", { integer: true }),
    oracleTimeoutMs: number(values["oracle-timeout-ms"], "--oracle-timeout-ms", { integer: true }),
    log: (line) => console.log(line),
  });
  console.log(`Created ${benchCase.file}: fixture ${parent.slice(0, 12)}, tests from ${commit.slice(0, 12)}; the oracle fails on the parent and passes on the commit.`);
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
      case "list": {
        const cases = loadCases(values.cases);
        for (const benchCase of cases)
          console.log(`${benchCase.id.padEnd(32)} ${benchCase.role.padEnd(8)} ${benchCase.fixture.type.padEnd(5)} ${money(benchCase.budgetUsd)}  ${benchCase.title}`);
        if (!cases.length) console.log(`No cases in ${values.cases}`);
        return 0;
      }
      case "run":
        return await runCommand(values);
      case "report":
        return reportCommand(values);
      case "add-from-commit":
        return await addCommand(values);
      default:
        throw new UsageError(`Unknown bench subcommand: ${subcommand}`);
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
