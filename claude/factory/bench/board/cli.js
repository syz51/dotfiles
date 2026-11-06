// bench board: the agent-board text format benchmark. Subcommands run, tokens and report;
// results live in the state folder under bench/board-formats.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { appendJsonl, readJson, readJsonl, stateDir, statePath, writeJsonAtomic } from "../../lib/state.js";
import { runMatrix } from "../runner.js";
import { aggregate, markdown } from "./report.js";
import { claudeBin, cleanLeftovers, runOne } from "./run.js";
import { CELLS } from "./scenario.js";
import { countTokens } from "./tokens.js";

const DIR = ["bench", "board-formats"];
export const resultsPath = () => statePath(...DIR, "results.jsonl");
const tokensPath = (series) => statePath(...DIR, `tokens-${series}.json`);

const USAGE = `Usage: bun ~/.claude/factory/cli.js bench board <subcommand> [options]

Benchmarks agent-board's experimental text formats and peer framings in Claude Code
sessions on the subscription (plain \`claude\`, never the API).

  run                        Run every cell until each has --trials scored runs
      --board-bin <path>     A board binary with the [experimental] switch (or BOARD_BENCH_BIN)
      --series <name>        Name of the series to add to (default main)
      --trials N             Scored runs per cell (default 20)
      --cells a,b            Cells (default all: ${CELLS.map((cell) => cell.id).join(", ")})
      --model <id>           Model (default claude-opus-5-5)
      --effort <level>       Effort (default high)
      --parallel N           Sessions at the same time (default 1)
      --max-infra N          Stop after N void runs in a row (default 3)
      --keep-streams         Keep each session's stream in the state folder, to check
                             the measures (transcript text: delete when done)
  tokens                     Count each cell's board text in model tokens
      --series <name>, --model <id>
  report                     Rates with 95% intervals per cell, format and framing
      --series <name>, --json
  clean                      After an interrupted run: stop its servers and sessions and
                             remove its folders and session entries (no run may be active)`;

class UsageError extends Error {}
class StopRun extends Error {}

const OPTIONS = {
  "board-bin": { type: "string" },
  series: { type: "string", default: "main" },
  trials: { type: "string", default: "20" },
  cells: { type: "string" },
  model: { type: "string", default: "claude-opus-5-5" },
  effort: { type: "string", default: "high" },
  parallel: { type: "string", default: "1" },
  "max-infra": { type: "string", default: "3" },
  "keep-streams": { type: "boolean", default: false },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
};

function positive(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new UsageError(`${flag} must be a positive integer`);
  return parsed;
}

// The jobs that bring every cell to trials scored runs, trials outermost, so a stop
// leaves the cells with similar counts.
export function pending(cells, trials, records) {
  const done = Object.fromEntries(cells.map((cell) => [cell.id, records.filter((record) => record.cell === cell.id && !record.infra).length]));
  const jobs = [];
  for (let trial = 1; trial <= trials; trial++)
    for (const cell of cells) if (done[cell.id] < trial) jobs.push({ cell, trial, budgetUsd: 0 });
  return jobs;
}

// A board binary that knows the experimental switch.
function checkBoard(bin) {
  const help = spawnSync(bin, ["snapshot", "--help"], { encoding: "utf8" });
  if (help.status !== 0 || !help.stdout.includes("--framing"))
    throw new UsageError(`${bin} is not a board binary with the experimental text format switch (bench/formats)`);
}

async function runCommand(values) {
  const boardBin = values["board-bin"] ?? process.env.BOARD_BENCH_BIN;
  if (!boardBin) throw new UsageError("run needs --board-bin or BOARD_BENCH_BIN");
  checkBoard(boardBin);
  claudeBin();
  if (!/^claude-[a-z0-9-]+$/.test(values.model)) throw new UsageError("--model needs a full model ID such as claude-opus-5-5");
  const trials = positive(values.trials, "--trials");
  const parallel = positive(values.parallel, "--parallel");
  const maxInfra = positive(values["max-infra"], "--max-infra");
  const ids = values.cells ? values.cells.split(",").map((id) => id.trim()).filter(Boolean) : CELLS.map((cell) => cell.id);
  const unknown = ids.filter((id) => !CELLS.some((cell) => cell.id === id));
  if (unknown.length) throw new UsageError(`Unknown cell: ${unknown.join(", ")}`);
  const cells = CELLS.filter((cell) => ids.includes(cell.id));
  const series = values.series;
  const path = resultsPath();
  const previous = readJsonl(path).filter((record) => record.series === series && record.model === values.model && record.effort === values.effort);
  const jobs = pending(cells, trials, previous);
  const version = spawnSync(claudeBin(), ["--version"], { encoding: "utf8" }).stdout?.trim().split("\n")[0] || null;
  console.log(`Series ${series}: ${jobs.length} runs to bring ${cells.length} cells to ${trials} scored runs, ${values.model} ${values.effort}, ${version ?? "unknown CLI version"}.`);
  let sequence = previous.length;
  let voidInRow = 0;
  try {
    await runMatrix(jobs, {
      parallel,
      async execute(job) {
        const record = await runOne(job.cell, { model: values.model, effort: values.effort, trial: job.trial, runId: `${series}-${++sequence}`, series, boardBin, cliVersion: version,
          streamDir: values["keep-streams"] ? join(stateDir(), ...DIR, "streams", series) : undefined });
        appendJsonl(path, record);
        const shown = ["claimBeforeEdit", "conflictReaction", "followsHandoff", "canaryHook", "canaryShow"].map((key) => `${key}=${record[key] ?? "-"}`).join(" ");
        console.log(`${record.infra ? "VOID " : "OK   "} ${record.cell} trial ${job.trial}: ${((record.durationMs ?? 0) / 1000).toFixed(0)}s ${shown}${record.error ? ` (${record.error.split("\n")[0]})` : ""}`);
        if (record.subscription === false) throw new StopRun("A session did not run on the subscription; stopped.");
        if (record.limited) throw new StopRun("Subscription usage limit reached; stopped. Rerun the same command after the reset to resume.");
        voidInRow = record.infra ? voidInRow + 1 : 0;
        if (voidInRow >= maxInfra) throw new StopRun(`${voidInRow} void runs in a row; stopped. Fix the cause and rerun to resume.`);
        return { ...record, costUSD: 0 };
      },
    });
  } catch (error) {
    if (!(error instanceof StopRun)) throw error;
    console.error(error.message);
    return 1;
  }
  console.log(`Done; results in ${path}.`);
  return 0;
}

async function tokensCommand(values) {
  const records = readJsonl(resultsPath()).filter((record) => record.series === values.series && !record.infra);
  if (!records.length) throw new UsageError(`No scored runs in series ${values.series}`);
  const tokens = await countTokens(records, values.model, (line) => console.log(line));
  writeJsonAtomic(tokensPath(values.series), tokens);
  return 0;
}

function reportCommand(values) {
  const report = aggregate(readJsonl(resultsPath()), { series: values.series, tokens: readJson(tokensPath(values.series), {}) });
  const text = markdown(report);
  writeFileSync(statePath(...DIR, `report-${values.series}.md`), text);
  writeJsonAtomic(statePath(...DIR, `report-${values.series}.json`), report);
  console.log(values.json ? JSON.stringify(report, null, 2) : text.trimEnd());
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
      case "run":
        return await runCommand(values);
      case "tokens":
        return await tokensCommand(values);
      case "report":
        return reportCommand(values);
      case "clean": {
        const roots = cleanLeftovers();
        console.log(roots.length ? `Removed ${roots.length} run folders:\n${roots.join("\n")}` : "Nothing to clean.");
        return 0;
      }
      default:
        throw new UsageError(`Unknown bench board subcommand: ${subcommand}`);
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
