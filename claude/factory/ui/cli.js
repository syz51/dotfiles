// ui: hill-climb a web UI's design. capture previews the shots; calibrate checks that the
// judges tell main from a degraded control and measures their noise; round gates and
// judges the committed candidate against main and the references; report and status
// summarize the run. State lives in the factory's state folder, per configuration name.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { appendJsonl, readJson, writeJsonAtomic } from "../lib/state.js";
import { CaptureError, resolveRev, runChecks, treeState } from "./capture.js";
import { ConfigError, loadConfig } from "./config.js";
import { calibrationOf, DEFAULT_NOISE, fixed, JudgeFailedError, judgeKey, money, runJudge, signed, topIssues, verdict } from "./council.js";
import { evaluateGates } from "./gates.js";
import { renderReport } from "./report.js";
import {
  baselineVersions, calibrationPath, candidateShots, capturedShots, findRun, identity, lockRun, openRun, record, referenceVersions,
  RunError, rounds, roundsPath, spent, versionDir, withSource,
} from "./run.js";

const USAGE = `Usage: bun ~/.claude/factory/cli.js ui <subcommand> [options]

  capture      Screenshot the working tree (or --rev), main and the references, and run
               the page checks; no judges. Prints where the screenshots are.
  calibrate    Score main against a deliberately degraded control, several times per
               judge: passes when every judge ranks the control clearly lower and its
               scores vary little between calls. Required before rounds.
  round        Gate and judge the committed candidate (HEAD) against main. Exit 0 when
               every judge passes the bar, 1 when it fails, 3 when the budget ran out.
  status       Rounds so far, spending, and whether the climb has plateaued.
  report       Write the run's HTML report: scores per round, screenshots, issues.

Options
  --config PATH     The climb configuration (default ui-climb.json)
  --run ID          Use this run instead of the latest
  --new-run         Start a new run: main is captured and the judges calibrated again
  --rev REV         capture: a commit instead of the working tree
  --samples N       calibrate: calls per judge (default 3, at least 2)
  --all-judges      round: run every judge even after one fails
  --allow-dirty     round: judge the working tree with uncommitted changes (recorded as dirty)
  --uncalibrated    round: run without a passing calibration, as a trial that never passes
  --checks          capture: run the configuration's checks too
  --out PATH        report: where to write the HTML (default in the run folder)
  --json            status, round: print JSON

Exit codes: 0 pass, 1 fail, 2 usage or setup error, 3 budget spent.`;

class UsageError extends Error {}

const OPTIONS = {
  config: { type: "string", default: "ui-climb.json" },
  run: { type: "string" },
  "new-run": { type: "boolean", default: false },
  rev: { type: "string" },
  samples: { type: "string", default: "3" },
  "all-judges": { type: "boolean", default: false },
  "allow-dirty": { type: "boolean", default: false },
  uncalibrated: { type: "boolean", default: false },
  checks: { type: "boolean", default: false },
  out: { type: "string" },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
};

const log = (message) => console.error(message);
const short = (sha) => sha.slice(0, 12);
const percent = (share) => (typeof share === "number" ? `${Math.round(share * 100)}%` : "–");
const firstLine = (text) => text.split("\n")[0].replace(/:$/, "").slice(0, 120);

// A judge's noise from its passing calibration; the defaults, flagged, otherwise.
function noiseOf(run, judge) {
  const entry = readJson(calibrationPath(run), null)?.judges?.[judgeKey(judge)];
  return entry?.pass ? entry : DEFAULT_NOISE;
}

function calibrated(config, run) {
  const calibration = readJson(calibrationPath(run), null);
  const missing = config.judges.filter((judge) => !calibration?.judges?.[judgeKey(judge)]?.pass);
  return { ok: missing.length === 0, missing };
}

// A short form of a judge's verdict for notes and tables.
const verdictLine = (v, pass) => `${v.judge} min ${v.lowest.toFixed(2)} (bar ${pass.min}) · ${signed(v.gain)} vs main${v.referenceMargin === null ? "" : ` · ${signed(v.referenceMargin)} vs refs`}`;

export function scoreLine(round, config) {
  const parts = [`score: round ${round.round} ${round.pass ? "pass" : "fail"}`];
  if (round.stage === "gates") parts.push(`gates: ${firstLine(round.gates.failures[0])}`);
  parts.push(...round.verdicts.map((v) => verdictLine(v, config.pass)));
  if (round.stage === "budget") parts.push("budget spent");
  if (round.stage === "error") parts.push(`error: ${firstLine(round.error)}`);
  if (round.calibrated === false) parts.push("uncalibrated");
  parts.push(money(round.costUSD), `${short(round.sha)}${round.dirty ? "+dirty" : ""}`);
  return parts.join(" · ");
}

// The climb has plateaued when the first judge's best gain over main in the last two
// judged rounds is no more than its noise above the best gain before them.
export function plateau(list, sigma) {
  const gains = list.filter((round) => round.verdicts?.length).map((round) => round.verdicts[0].gain);
  if (gains.length < 3) return { plateau: false, judged: gains.length };
  const before = Math.max(...gains.slice(0, -2));
  const recent = Math.max(...gains.slice(-2));
  return { plateau: recent <= before + sigma, judged: gains.length, before, recent };
}

function printGates(gates, dir) {
  const { candidate, baseline } = gates.totals;
  console.log(`Page checks (this vs main): ${Object.keys(candidate).map((key) => `${key} ${candidate[key]}/${baseline[key]}`).join(", ")}`);
  for (const failure of gates.failures) console.log(`  GATE ${failure}`);
  if (gates.failures.some((failure) => / did not capture: /.test(failure))) console.log(`  The app's output is in ${join(dir, "server.log")}.`);
}

async function captureCommand(config, values) {
  const run = await openRun(config, { id: values.run, fresh: values["new-run"] });
  const unlock = lockRun(run);
  try {
    const { baseline } = await baselineVersions(config, run, { log });
    const references = await referenceVersions(config, run, { log });
    const name = `preview-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}`;
    let source;
    if (values.rev) {
      source = { sha: await resolveRev(config.rootDir, values.rev) };
    } else source = { root: config.rootDir };
    log(`Capturing ${values.rev ? short(source.sha) : "the working tree"}…`);
    const { shots, checks } = await withSource(config, source, async (root) => ({
      checks: values.checks ? await runChecks(config, root) : null,
      shots: await candidateShots(config, run, name, root),
    }));
    const gates = evaluateGates({ checks, candidate: shots, baseline });
    console.log(`Run ${run.id} · main ${short(run.baseline.sha)}`);
    console.log(`This version (${versionDir(run, name)}):`);
    for (const shot of shots) console.log(`  ${shot.file}${shot.error ? `  ERROR ${shot.error}` : ""}`);
    console.log(`Main (${versionDir(run, "baseline")}):`);
    for (const shot of baseline) console.log(`  ${shot.file}`);
    for (const ref of references) {
      console.log(`Reference ${ref.title}:`);
      for (const shot of ref.shots) console.log(`  ${shot.file}`);
    }
    printGates(gates, versionDir(run, name));
    return shots.some((shot) => shot.error) ? 1 : 0;
  } finally {
    unlock();
  }
}

async function calibrateCommand(config, values) {
  const samples = Number(values.samples);
  if (!Number.isInteger(samples) || samples < 2 || samples > 5) throw new UsageError("--samples must be an integer from 2 to 5");
  const run = await openRun(config, { id: values.run, fresh: values["new-run"] });
  const unlock = lockRun(run);
  try {
    const need = config.judges.length * samples * config.budgetUsd.call;
    const left = config.budgetUsd.run - spent(run);
    if (need > left) {
      console.log(`Calibration could cost up to ${money(need)}; ${money(left)} of the run's ${money(config.budgetUsd.run)} is left. Raise budgetUsd.run or lower --samples.`);
      return 3;
    }
    const { baseline, control } = await baselineVersions(config, run, { control: true, log });
    const references = await referenceVersions(config, run, { log });
    const versions = [{ key: "baseline", kind: "product", shots: baseline }, { key: "control", kind: "product", shots: control }, ...references];
    const results = {};
    let cost = 0;
    let errored = false;
    for (const judge of config.judges) {
      log(`Calibrating ${judgeKey(judge)} with ${samples} calls…`);
      let result;
      try {
        result = await runJudge({
          judge: { ...judge, samples }, versions, config, seed: `${run.id}:calibrate`, budgetUsd: config.budgetUsd.call,
          room: () => config.budgetUsd.run - spent(run),
          spend: (usd) => {
            cost += usd;
            record(run, `calibrate ${judgeKey(judge)}`, usd);
          },
        });
      } catch (error) {
        if (!(error instanceof JudgeFailedError)) throw error;
        // Recorded, so the table shows it; the other judges still calibrate.
        errored = true;
        results[judgeKey(judge)] = { judge: judgeKey(judge), pass: false, error: error.message, reasons: [`could not finish: ${error.message}`], references: {} };
        continue;
      }
      results[judgeKey(judge)] = {
        ...calibrationOf(result),
        references: Object.fromEntries(references.map((ref) => [ref.key, result.overall[ref.key]])),
        scores: result.scores,
      };
    }
    const pass = Object.values(results).every((result) => result.pass);
    writeJsonAtomic(calibrationPath(run), { at: new Date().toISOString(), samples, judges: results, costUSD: cost });
    console.log(`Calibration, run ${run.id} · main ${short(run.baseline.sha)} · ${samples} calls per judge · ${money(cost)}`);
    console.log("| Judge | Main | Control | Drop | Lower in | σ category | σ overall | References | Result |\n|---|---|---|---|---|---|---|---|---|");
    for (const [key, result] of Object.entries(results))
      console.log(`| ${key} | ${fixed(result.baseline)} | ${fixed(result.control)} | ${fixed(result.drop)} | ${percent(result.lowerShare)} | ${fixed(result.sigmaCategory)} | ${fixed(result.sigmaOverall)} | ${Object.entries(result.references).map(([ref, score]) => `${ref.slice(4)} ${fixed(score)}`).join(", ") || "–"} | ${result.pass ? "pass" : `FAIL: ${result.reasons.join("; ")}`} |`);
    if (errored) {
      console.log("\nA judge could not finish its calls (its cost is counted): see the reason in the table, then calibrate again.");
      return 2;
    }
    if (!pass) console.log("\nA judge that cannot tell main from the control, or that varies this much, cannot steer a climb: change the judges (a stronger model or higher effort), the screens, or the control, then calibrate again.");
    return pass ? 0 : 1;
  } finally {
    unlock();
  }
}

async function roundCommand(config, values) {
  const run = await openRun(config, { id: values.run, fresh: values["new-run"] });
  const unlock = lockRun(run);
  try {
    const calibration = calibrated(config, run);
    if (!calibration.ok && !values.uncalibrated)
      throw new RunError(`run ${run.id} has no passing calibration for ${calibration.missing.map(judgeKey).join(", ")}: run \`ui calibrate\` first (or --uncalibrated for a trial that should not count)`);
    const tree = await treeState(config.rootDir);
    if (tree.dirty && !values["allow-dirty"])
      throw new RunError("the working tree has uncommitted changes: a round judges a commit, so commit first (or pass --allow-dirty to judge the tree as it is, recorded as dirty)");
    const firstNeed = config.judges[0].samples * config.budgetUsd.call;
    if (spent(run) + firstNeed > config.budgetUsd.run) {
      console.log(`The run's budget is spent: ${money(spent(run))} of ${money(config.budgetUsd.run)}, and a round needs up to ${money(firstNeed)}.`);
      return 3;
    }
    const number = rounds(run).length + 1;
    const name = `round-${number}`;
    const { baseline } = await baselineVersions(config, run, { log });
    const references = await referenceVersions(config, run, { log });
    log(`Round ${number}: checks and capture of ${short(tree.commit)}${tree.dirty ? " with uncommitted changes" : ""}…`);
    const { checks, shots } = await withSource(config, tree.dirty ? { root: config.rootDir } : { sha: tree.commit }, async (root) => {
      const checks = await runChecks(config, root);
      return { checks, shots: checks.ok ? await candidateShots(config, run, name, root) : [] };
    });
    const gates = evaluateGates({ checks, candidate: shots, baseline });
    const base = { round: number, at: new Date().toISOString(), sha: tree.commit, dirty: tree.dirty, calibrated: calibration.ok, gates };
    let result;
    if (!gates.ok) {
      result = { ...base, stage: "gates", pass: false, verdicts: [], costUSD: 0 };
    } else {
      const versions = [{ key: "baseline", kind: "product", shots: baseline }, { key: "candidate", kind: "product", shots }, ...references];
      const referenceKeys = references.map((ref) => ref.key);
      const judged = [];
      const verdicts = [];
      let cost = 0;
      let stage = "judges";
      let error = null;
      for (const judge of config.judges) {
        const need = judge.samples * config.budgetUsd.call;
        if (cost + need > config.budgetUsd.round || spent(run) + need > config.budgetUsd.run) {
          stage = "budget";
          break;
        }
        log(`Judging with ${judgeKey(judge)} (${judge.samples} calls)…`);
        let outcome;
        try {
          outcome = await runJudge({
            judge, versions, config, seed: `${run.id}:${number}`, budgetUsd: config.budgetUsd.call,
            room: () => Math.min(config.budgetUsd.round - cost, config.budgetUsd.run - spent(run)),
            spend: (usd) => {
              cost += usd;
              record(run, `round ${number} ${judgeKey(judge)}`, usd);
            },
          });
        } catch (failure) {
          if (!(failure instanceof JudgeFailedError)) throw failure;
          // Recorded with its cost, so the round's spending and number stay accounted for.
          stage = "error";
          error = failure.message;
          break;
        }
        judged.push(outcome);
        const v = verdict({ result: outcome, pass: config.pass, noise: noiseOf(run, judge), references: referenceKeys });
        verdicts.push({ ...v, calibrated: noiseOf(run, judge).calibrated !== false, references: Object.fromEntries(referenceKeys.map((key) => [key, outcome.overall[key]])), baseline: outcome.overall.baseline, scores: outcome.scores });
        if (!v.pass && !values["all-judges"]) break;
      }
      // An uncalibrated round is a trial: it never passes.
      const pass = calibration.ok && stage === "judges" && verdicts.length === config.judges.length && verdicts.every((v) => v.pass);
      result = { ...base, stage, pass, verdicts, costUSD: cost, ...(error ? { error } : {}), issues: topIssues(judged), samples: judged.map((outcome) => ({ judge: outcome.judge, samples: outcome.samples })) };
    }
    writeJsonAtomic(join(run.dir, "rounds", `${name}.json`), result);
    const { samples: _, issues: __, ...summary } = result;
    appendJsonl(roundsPath(run), { ...summary, gates: { ok: gates.ok, failures: gates.failures, totals: gates.totals }, verdicts: result.verdicts.map(({ scores, ...rest }) => rest) });
    printRound(result, config, run, values.json);
    if (result.stage === "budget") return 3;
    if (result.stage === "error") return 2;
    return result.pass ? 0 : 1;
  } finally {
    unlock();
  }
}

function printRound(result, config, run, json) {
  if (json) {
    const { samples, ...rest } = result;
    console.log(JSON.stringify({ ...rest, scoreLine: scoreLine(result, config) }, null, 2));
    return;
  }
  console.log(`Round ${result.round} of run ${run.id} · ${short(result.sha)}${result.dirty ? " +dirty" : ""} vs main ${short(run.baseline.sha)}${result.calibrated ? "" : " · UNCALIBRATED"}`);
  printGates(result.gates, versionDir(run, `round-${result.round}`));
  if (result.stage === "gates") console.log("\nThe gates failed, so no judge ran. Fix what they name and run the round again.");
  if (result.verdicts.length) {
    console.log("\n| Judge | This | Main | Lowest | Gain (bar) | vs refs | Result |\n|---|---|---|---|---|---|---|");
    for (const v of result.verdicts)
      console.log(`| ${v.judge} | ${fixed(v.overall)} | ${fixed(v.baseline)} | ${v.lowestCategory} ${fixed(v.lowest)} (bar ${config.pass.min}) | ${signed(v.gain)} (${fixed(v.gainBar)}) | ${v.referenceMargin === null ? "–" : signed(v.referenceMargin)} | ${v.pass ? "pass" : `fail: ${v.reasons.join("; ")}`} |`);
    const categories = Object.keys(result.verdicts[0].scores.candidate);
    console.log(`\n| Category | ${result.verdicts.map((v) => `${v.judge} this / main`).join(" | ")} |\n|---|${result.verdicts.map(() => "---|").join("")}`);
    for (const category of categories)
      console.log(`| ${category} | ${result.verdicts.map((v) => `${fixed(v.scores.candidate[category])} / ${fixed(v.scores.baseline[category])}`).join(" | ")} |`);
  }
  if (result.issues?.length) {
    console.log("\nTop issues (screen · category · severity × reports):");
    result.issues.forEach((issue, index) => {
      console.log(`${index + 1}. ${issue.screen} · ${issue.category} · ${issue.severity} ×${issue.count}: ${issue.problems[0]}`);
      console.log(`   fix: ${issue.fixes[0]}`);
    });
  }
  if (result.stage === "budget") console.log("\nThe budget ran out before every judge ran.");
  if (result.stage === "error") console.log(`\nA judge could not finish, so the round has no verdict (its cost is counted): ${result.error}\nRun the round again.`);
  if (!result.calibrated) console.log("\nThis round ran without a passing calibration: it is a trial and does not pass.");
  console.log(`\nScreenshots: ${versionDir(run, `round-${result.round}`)}`);
  console.log(`Spent this round ${money(result.costUSD)}; run total ${money(spent(run))} of ${money(config.budgetUsd.run)}.`);
  console.log(`\n${scoreLine(result, config)}`);
}

function statusCommand(config, values) {
  const run = existingRun(config, values);
  const list = rounds(run);
  const sigma = noiseOf(run, config.judges[0]).sigmaOverall;
  const status = {
    run: run.id, baseline: run.baseline, spentUSD: spent(run), budgetUSD: config.budgetUsd.run,
    calibrated: calibrated(config, run).ok, rounds: list.map((round) => ({ ...round, scoreLine: scoreLine(round, config) })),
    plateau: plateau(list, sigma), passed: list.some((round) => round.pass && !round.dirty && round.calibrated !== false),
  };
  if (values.json) {
    console.log(JSON.stringify(status, null, 2));
    return 0;
  }
  console.log(`Run ${run.id} · main ${short(run.baseline.sha)} · calibrated: ${status.calibrated ? "yes" : "no"} · spent ${money(status.spentUSD)} of ${money(status.budgetUSD)}`);
  for (const round of status.rounds) console.log(round.scoreLine);
  if (!list.length) console.log("No rounds yet.");
  console.log(status.plateau.plateau
    ? `Plateau: the last two rounds gained at most ${fixed(status.plateau.recent)} over main, against ${fixed(status.plateau.before)} before (noise ${fixed(sigma)}).`
    : `No plateau (${status.plateau.judged} judged round${status.plateau.judged === 1 ? "" : "s"}).`);
  return 0;
}

// status and report read a run without creating one.
function existingRun(config, values) {
  const run = findRun(config, values.run);
  if (!run) throw new RunError(`no ${values.run ? `run ${values.run}` : "run"} for ${config.name} yet: start one with \`ui capture\` or \`ui calibrate\``);
  if (run.identity !== identity(config)) log(`Note: run ${run.id} was started with a different configuration, rubric or preferences.`);
  return run;
}

function reportCommand(config, values) {
  const run = existingRun(config, values);
  const out = values.out ?? join(run.dir, "report.html");
  const list = rounds(run).map((round) => readJson(join(run.dir, "rounds", `round-${round.round}.json`), round));
  // The latest round with screenshots: a round whose checks failed has none.
  const shown = [...list].reverse().find((round) => capturedShots(run, `round-${round.round}`));
  const versions = { baseline: capturedShots(run, "baseline"), ...(shown ? { [`round-${shown.round}`]: capturedShots(run, `round-${shown.round}`) } : {}) };
  writeFileSync(out, renderReport({ config, run, rounds: list, calibration: readJson(calibrationPath(run), null), spentUSD: spent(run), versions }));
  console.log(out);
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
    const commands = { capture: captureCommand, calibrate: calibrateCommand, round: roundCommand, status: statusCommand, report: reportCommand };
    if (!commands[subcommand]) throw new UsageError(`Unknown ui subcommand: ${subcommand}`);
    const config = loadConfig(values.config);
    return await commands[subcommand](config, values);
  } catch (error) {
    if (error instanceof UsageError || error.code?.startsWith("ERR_PARSE_ARGS_")) {
      console.error(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    if (error instanceof ConfigError || error instanceof RunError || error instanceof CaptureError || error instanceof JudgeFailedError) {
      console.error(error.message);
      return 2;
    }
    // Anything else is a fault in the command, not a failed round: exit 1 means fail.
    console.error(error.stack ?? String(error));
    return 2;
  }
}
