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
import { barReach, barVerdict, calibrationOf, DEFAULT_NOISE, fixed, JudgeFailedError, judgeKey, money, precheck, runJudge, sd, signed, topIssues, verdict } from "./council.js";
import { evaluateGates } from "./gates.js";
import { ledger, markIssues, settledFixes } from "./ledger.js";
import { renderReport } from "./report.js";
import {
  baselineVersions, calibrationPath, candidateShots, capturedShots, findRun, fullRounds, identity, lockRun, openRun, record, referenceVersions,
  RunError, rounds, roundsPath, spent, versionDir, withSource,
} from "./run.js";

const USAGE = `Usage: bun ~/.claude/factory/cli.js ui <subcommand> [options]

  capture      Screenshot the working tree (or --rev), main and the references, and run
               the page checks; no judges. Prints where the screenshots are.
  calibrate    Score main against a deliberately degraded control, several times per
               judge: passes when every judge ranks the control clearly lower and its
               scores vary little between calls. Required before rounds.
  round        Gate and judge the committed candidate (HEAD) against main. Judges run in
               order: those before the last are regression pre-checks (the candidate
               must not score under main beyond pass.regression times their noise), and
               the last applies the bar. A failed pre-check stops the round, except
               until a round of the run has heard from every judge. Exit 0 when the
               pre-checks and the bar pass, 1 when one fails, 3 when the budget ran out,
               4 when they pass but a reference did not capture (a provisional pass).
  status       Rounds so far, spending, and whether the climb has plateaued.
  report       Write the run's HTML report: scores per round, screenshots, issues.

Options
  --config PATH     The climb configuration (default ui-climb.json)
  --run ID          Use this run instead of the latest
  --new-run         Start a new run: main is captured and the judges calibrated again
  --rev REV         capture: a commit instead of the working tree
  --samples N       calibrate: calls per judge (default 3, at least 2)
  --all-judges      round: run every judge even after one fails (do so on the round you hand over)
  --structural      round: mark the round as a structural change (a new system, not local fixes)
  --allow-dirty     round: judge the working tree with uncommitted changes (recorded as dirty)
  --uncalibrated    round: run without a passing calibration, as a trial that never passes
  --checks          capture: run the configuration's checks too
  --out PATH        report: where to write the HTML (default in the run folder)
  --json            status, round: print JSON

Exit codes: 0 pass, 1 fail, 2 usage or setup error, 3 budget spent, 4 provisional pass.`;

class UsageError extends Error {}

const OPTIONS = {
  config: { type: "string", default: "ui-climb.json" },
  run: { type: "string" },
  "new-run": { type: "boolean", default: false },
  rev: { type: "string" },
  samples: { type: "string", default: "3" },
  "all-judges": { type: "boolean", default: false },
  structural: { type: "boolean", default: false },
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

// A judge's noise from its passing calibration (the run's calibration.json); the defaults,
// flagged, otherwise.
function noiseOf(calibration, judge) {
  const entry = calibration?.judges?.[judgeKey(judge)];
  return entry?.pass ? entry : DEFAULT_NOISE;
}

// One judge's verdicts over the run's rounds, in order.
const verdictsOf = (list, key) => list.flatMap((round) => round.verdicts?.filter((v) => v.judge === key) ?? []);
const numbers = (values) => values.filter((value) => typeof value === "number");

// A judge's noise in a climb, for scores that are means of its samples. Scores are
// comparative, so main's score moves with the candidate beside it, more than between
// calibration's repeat calls: the noise is the larger of the calibrated one and the spread
// of main's scores over the run's judged rounds (list). sigmaOverall is for the gain over
// main; sigmaLowest for a category score.
export function climbNoise(calibration, judge, list) {
  const mains = verdictsOf(list, judgeKey(judge));
  const root = Math.sqrt(judge.samples);
  return {
    ...calibration,
    sigmaOverall: Math.max(calibration.sigmaOverall / root, sd(numbers(mains.map((v) => v.baseline)))),
    sigmaLowest: Math.max(calibration.sigmaCategory / root, sd(numbers(mains.map((v) => v.baselineLowest)))),
  };
}

// Main's overall score from a judge over the run's judged rounds: { low, high, rounds }.
function mainRange(list, judge) {
  const scores = numbers(verdictsOf(list, judgeKey(judge)).map((v) => v.baseline));
  return scores.length ? { low: Math.min(...scores), high: Math.max(...scores), rounds: scores.length } : null;
}

// The judges whose calibration warned that the bar may be out of their range, as [key, result]
// pairs; judges is a calibration's judges map.
const barWarnings = (judges) => Object.entries(judges ?? {}).filter(([, result]) => result.barReach?.warnings.length);

function calibrated(config, calibration) {
  const missing = config.judges.filter((judge) => !calibration?.judges?.[judgeKey(judge)]?.pass);
  return { ok: missing.length === 0, missing };
}

// A short form of a judge's verdict for notes and tables.
const verdictLine = (v, pass) => v.role === "precheck"
  ? `${v.judge} pre-check ${signed(v.gain)} vs main (floor ${signed(v.gainBar)})`
  : `${v.judge} min ${v.lowest.toFixed(2)} (bar ${pass.min}) · ${signed(v.gain)} vs main${v.referenceMargin === null ? "" : ` · ${signed(v.referenceMargin)} vs refs`}`;

// The references a round was judged without, for notes and the report.
export const missingLine = (ids) => `missing reference${ids.length === 1 ? "" : "s"}: ${ids.join(", ")}`;

export function scoreLine(round, config) {
  const parts = [`score: round ${round.round} ${round.pass ? "pass" : round.provisional ? "provisional pass" : "fail"}`];
  if (round.stage === "gates") parts.push(`gates: ${firstLine(round.gates.failures[0])}`);
  parts.push(...round.verdicts.map((v) => verdictLine(v, config.pass)));
  if (round.missingReferences?.length) parts.push(missingLine(round.missingReferences));
  if (round.stage === "budget") parts.push("budget spent");
  if (round.stage === "error") parts.push(`error: ${firstLine(round.error)}`);
  if (round.calibrated === false) parts.push("uncalibrated");
  if (round.structural) parts.push("structural");
  parts.push(money(round.costUSD), `${short(round.sha)}${round.dirty ? "+dirty" : ""}`);
  return parts.join(" · ");
}

// The climb has plateaued when nothing the bar still needs moved in the binding judge's last
// two judged rounds: the best of them is within the noise of the best before them. The
// binding judge is the latest round's first failing judge, else its bar judge. Its metrics are those still short
// of their bar: for a pre-check only the gain over its floor; for the bar judge the lowest category and the total shortfall under min (so progress on one of
// several tied categories counts), the gain over main, and the lead over the best reference
// when pass.references is set. noise(judge key) gives { lowest, gain }. movedAt is the latest
// round in which one of those metrics beat every earlier round by more than the noise, or null.
export function plateau(list, { min, references = null, noise }) {
  const judgedRounds = list.filter((round) => round.verdicts?.length);
  const judged = judgedRounds.length;
  if (judged < 3) return { plateau: false, judged, metrics: {} };
  const latestRound = judgedRounds.at(-1);
  const judge = (latestRound.verdicts.find((v) => !v.pass) ?? latestRound.verdicts.at(-1)).judge;
  const verdicts = verdictsOf(judgedRounds, judge);
  if (verdicts.length < 3) return { plateau: false, judged, judge, metrics: {} };
  const roundOf = judgedRounds.filter((round) => round.verdicts.some((v) => v.judge === judge)).map((round) => round.round);
  const latest = verdicts.at(-1);
  const sigma = noise(judge);
  // name: [values, noise, lower is better]
  const series = {};
  const bar = latest.role !== "precheck";
  if (bar && latest.lowest < min) {
    series.lowest = [verdicts.map((v) => v.lowest), sigma.lowest, false];
    if (verdicts.every((v) => typeof v.shortfall === "number")) series.shortfall = [verdicts.map((v) => v.shortfall), sigma.lowest * Math.sqrt(latest.underCount), true];
  }
  if (latest.gain < latest.gainBar) series.gain = [verdicts.map((v) => v.gain), sigma.gain, false];
  if (bar && references !== null && latest.referenceMargin !== null && latest.referenceMargin < references) series.references = [verdicts.map((v) => v.referenceMargin), sigma.lowest, false];
  const metrics = {};
  let movedAt = null;
  for (const [name, [values, spread, lower]] of Object.entries(series)) {
    const best = (items) => (lower ? Math.min(...items) : Math.max(...items));
    const beats = (value, before) => (lower ? value < before - spread : value > before + spread);
    const before = best(values.slice(0, -2));
    const recent = best(values.slice(-2));
    metrics[name] = { before, recent, noise: spread, moved: beats(recent, before) };
    for (let index = 1; index < values.length; index++)
      if (beats(values[index], best(values.slice(0, index)))) movedAt = Math.max(movedAt ?? 0, roundOf[index]);
  }
  const tracked = Object.values(metrics);
  return { plateau: tracked.length > 0 && tracked.every((metric) => !metric.moved), judged, judge, metrics, movedAt };
}

// The structural round a plateau has tried: the latest one after the metrics last moved
// (movedAt), as { round, followed }, or null. One that moved them has not stopped the climb,
// and a later plateau earns a new one. followed: a judged round came after it, the round
// that judged another commit, the one that fixes the structural round's own issues (a re-run
// of the same commit fixes nothing); until then the climb is not told to stop.
export function structuralTried(list, movedAt) {
  const since = movedAt ?? -Infinity;
  const structural = list.findLast((round) => round.verdicts?.length && round.structural && round.round > since);
  if (!structural) return null;
  return { round: structural.round, followed: list.some((round) => round.verdicts?.length && round.round > structural.round && round.sha !== structural.sha) };
}

// What a command says of the references that did not capture.
function printMissing(missing) {
  for (const ref of missing) console.log(`Reference ${ref.id} (${ref.title}) did not capture, so the judges compare without it: ${ref.error}`);
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
    const { references, missing } = await referenceVersions(config, run, { log });
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
    printMissing(missing);
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
    const { references, missing } = await referenceVersions(config, run, { log });
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
      const calibration = calibrationOf(result);
      results[judgeKey(judge)] = {
        ...calibration,
        references: Object.fromEntries(references.map((ref) => [ref.key, result.overall[ref.key]])),
        // Only the bar judge's reach matters: the pre-checks never apply the bar.
        barReach: judge !== config.judges.at(-1) ? null : barReach(result, { min: config.pass.min, references: references.map((ref) => ref.key), sigmaCategory: calibration.sigmaCategory }),
        scores: result.scores,
      };
    }
    const pass = Object.values(results).every((result) => result.pass);
    writeJsonAtomic(calibrationPath(run), { at: new Date().toISOString(), samples, judges: results, costUSD: cost, ...(missing.length ? { missingReferences: missing.map((ref) => ref.id) } : {}) });
    console.log(`Calibration, run ${run.id} · main ${short(run.baseline.sha)} · ${samples} calls per judge · ${money(cost)}`);
    console.log("| Judge | Main | Control | Drop | Lower in | σ category | σ overall | References | Result |\n|---|---|---|---|---|---|---|---|---|");
    for (const [key, result] of Object.entries(results))
      console.log(`| ${key} | ${fixed(result.baseline)} | ${fixed(result.control)} | ${fixed(result.drop)} | ${percent(result.lowerShare)} | ${fixed(result.sigmaCategory)} | ${fixed(result.sigmaOverall)} | ${Object.entries(result.references).map(([ref, score]) => `${ref.slice(4)} ${fixed(score)}`).join(", ") || "–"} | ${result.pass ? "pass" : `FAIL: ${result.reasons.join("; ")}`} |`);
    if (missing.length) {
      console.log("");
      printMissing(missing);
    }
    const unreachable = barWarnings(results);
    if (unreachable.length) {
      console.log(`\nBar reach: the bar ${config.pass.min} may be out of the judges' range.`);
      for (const [key, result] of unreachable)
        console.log(`- ${key}: ${result.barReach.warnings.join("; ")}. Best reference per category: ${Object.entries(result.barReach.bestReference).map(([id, score]) => `${id} ${fixed(score)}`).join(", ") || "none"}.`);
      // One bar every warned judge gives: the lowest floor and the largest lead.
      const suggestions = unreachable.map(([, result]) => result.barReach.suggestion).filter(Boolean);
      if (suggestions.length) {
        const min = Math.min(...suggestions.map((item) => item.min));
        const lead = Math.max(...suggestions.map((item) => item.references));
        console.log(`Suggested bar, from these reference scores: lead the best reference by ${lead} in every category, with ${min} (about the best reference's level) as the floor. In the configuration (with --new-run):`);
        console.log(`  "pass": { "min": ${min}, "gain": ${config.pass.gain}, "references": ${lead} }`);
      }
      console.log(`Before round 1, put this in a note and ask the owner whether to ${suggestions.length ? "use the suggested lead over the references, " : ""}go on as is, add a reference they rate at the bar, use a bar judge that uses the top of the scale, or lower the bar.`);
    }
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
    const calibrationFile = readJson(calibrationPath(run), null);
    const calibration = calibrated(config, calibrationFile);
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
    const previous = rounds(run);
    const number = previous.length + 1;
    // The issues of earlier rounds: this round's are marked against them, and the fixes that
    // resolved them go to the judges as settled.
    const entries = ledger(fullRounds(run, previous));
    const settled = settledFixes(entries);
    // Until a round has heard from every judge, rounds run them all, so the climb knows
    // whether they agree.
    const everyJudge = values["all-judges"] || !previous.some((round) => round.verdicts?.length === config.judges.length);
    const name = `round-${number}`;
    const { baseline } = await baselineVersions(config, run, { log });
    const { references, missing } = await referenceVersions(config, run, { log });
    log(`Round ${number}: checks and capture of ${short(tree.commit)}${tree.dirty ? " with uncommitted changes" : ""}…`);
    const { checks, shots } = await withSource(config, tree.dirty ? { root: config.rootDir } : { sha: tree.commit }, async (root) => {
      const checks = await runChecks(config, root);
      return { checks, shots: checks.ok ? await candidateShots(config, run, name, root) : [] };
    });
    const gates = evaluateGates({ checks, candidate: shots, baseline });
    const base = { round: number, at: new Date().toISOString(), sha: tree.commit, dirty: tree.dirty, calibrated: calibration.ok, ...(values.structural ? { structural: true } : {}), ...(missing.length ? { missingReferences: missing.map((ref) => ref.id) } : {}), gates };
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
      let skipped = [];
      for (const [index, judge] of config.judges.entries()) {
        const need = judge.samples * config.budgetUsd.call;
        if (spent(run) + need > config.budgetUsd.run) {
          stage = "budget";
          break;
        }
        if (cost + need > config.budgetUsd.round) {
          // A round an earlier judge failed has its verdict: the round's cap only skips the rest.
          if (verdicts.some((v) => !v.pass)) skipped = config.judges.slice(index).map(judgeKey);
          else stage = "budget";
          break;
        }
        log(`Judging with ${judgeKey(judge)} (${judge.samples} calls)…`);
        let outcome;
        try {
          outcome = await runJudge({
            judge, versions, config, seed: `${run.id}:${number}`, budgetUsd: config.budgetUsd.call, settled,
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
        const noise = climbNoise(noiseOf(calibrationFile, judge), judge, previous);
        // Every judge but the last is a regression pre-check; the last applies the bar.
        const judgeVerdict = index < config.judges.length - 1 ? precheck : verdict;
        const v = judgeVerdict({ result: outcome, pass: config.pass, noise, references: referenceKeys });
        verdicts.push({ ...v, calibrated: noise.calibrated !== false, references: Object.fromEntries(referenceKeys.map((key) => [key, outcome.overall[key]])), baseline: outcome.overall.baseline, scores: outcome.scores });
        if (!v.pass && !everyJudge) break;
      }
      // An uncalibrated round is a trial: it never passes. A pass judged without a reference
      // is provisional, unless the configuration accepts one (pass.allReferences false).
      const passed = calibration.ok && stage === "judges" && verdicts.length === config.judges.length && verdicts.every((v) => v.pass);
      const provisional = passed && missing.length > 0 && config.pass.allReferences;
      const pass = passed && !provisional;
      // How far each category is under the bar, by the bar judge (pre-checks do not apply it).
      const deficits = {};
      for (const v of verdicts.filter((item) => item.role !== "precheck"))
        for (const [category, score] of Object.entries(v.scores.candidate))
          if (score !== null && score < config.pass.min) deficits[category] = Math.max(deficits[category] ?? 0, config.pass.min - score);
      // Every issue, so the round can fix them all and the ledger misses none.
      result = {
        ...base, stage, pass, ...(provisional ? { provisional: true } : {}), verdicts, costUSD: cost, ...(error ? { error } : {}), ...(skipped.length ? { skipped } : {}), underBar: deficits,
        // The settled fixes the judges were told, when any judge was asked.
        issues: markIssues(topIssues(judged, "candidate", Infinity, deficits), entries), settled: verdicts.length || error ? settled : [],
        samples: judged.map((outcome) => ({ judge: outcome.judge, samples: outcome.samples })),
      };
    }
    writeJsonAtomic(join(run.dir, "rounds", `${name}.json`), result);
    const { samples: _, issues: __, settled: ___, ...summary } = result;
    appendJsonl(roundsPath(run), { ...summary, gates: { ok: gates.ok, failures: gates.failures, totals: gates.totals }, verdicts: result.verdicts.map(({ scores, ...rest }) => rest) });
    printRound(result, config, run, values.json);
    if (result.stage === "budget") return 3;
    if (result.stage === "error") return 2;
    if (result.provisional) return 4;
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
      console.log(`| ${v.judge} | ${fixed(v.overall)} | ${fixed(v.baseline)} | ${v.lowestCategory} ${fixed(v.lowest)}${v.role === "precheck" ? "" : ` (bar ${config.pass.min})`} | ${signed(v.gain)} (${v.role === "precheck" ? "floor " : ""}${fixed(v.gainBar)}) | ${v.referenceMargin === null ? "–" : signed(v.referenceMargin)} | ${v.pass ? "pass" : `fail: ${v.reasons.join("; ")}`} |`);
    const categories = Object.keys(result.verdicts[0].scores.candidate);
    console.log(`\n| Category | ${result.verdicts.map((v) => `${v.judge} this / main`).join(" | ")} |\n|---|${result.verdicts.map(() => "---|").join("")}`);
    for (const category of categories)
      console.log(`| ${category} | ${result.verdicts.map((v) => `${fixed(v.scores.candidate[category])} / ${fixed(v.scores.baseline[category])}`).join(" | ")} |`);
  }
  if (result.issues?.length) {
    console.log("\nIssues, categories under the bar first (screen · category · severity × reports). Fix every one, or say in the round's note why you keep it:");
    result.issues.forEach((issue, index) => {
      const marks = `${issue.underBar ? "[under bar] " : ""}${issue.since ? `[unfixed since round ${issue.since}] ` : ""}${issue.returns ? `[returns after round ${issue.returns.round}] ` : ""}`;
      console.log(`${index + 1}. ${marks}${issue.screen} · ${issue.category} · ${issue.severity} ×${issue.count}: ${issue.problems[0]}`);
      console.log(`   fix: ${issue.fixes[0]}`);
      if (issue.returns) console.log(`   Round ${issue.returns.round} resolved it with: ${issue.returns.fix}. If this undoes that fix, keep the better-scoring version and note the conflict.`);
    });
    const unfixed = result.issues.filter((issue) => issue.since).length;
    const returning = result.issues.filter((issue) => issue.returns).length;
    if (unfixed || returning)
      console.log(`\nLedger: ${unfixed} unfixed from an earlier round (try a different fix), ${returning} back after a fix.`);
  }
  if (result.settled?.length) console.log(`The judges were told ${result.settled.length} earlier fix${result.settled.length === 1 ? " is" : "es are"} settled.`);
  // A category under the bar that fewer than two reports named: what the judges said of the
  // design, a few of their summaries.
  const reports = (category) => (result.issues ?? []).filter((issue) => issue.category === category).reduce((sum, issue) => sum + issue.count, 0);
  const thin = Object.entries(result.underBar ?? {}).filter(([category]) => reports(category) < 2);
  const summaries = [...new Set((result.samples ?? []).flatMap((judge) => judge.samples.map((sample) => sample.summaries?.candidate).filter(Boolean)))].slice(0, 4);
  if (thin.length && summaries.length) {
    console.log(`\nUnder the bar with few issues named: ${thin.map(([category, deficit]) => `${category} (${fixed(config.pass.min - deficit)})`).join(", ")}. What the judges said of this design:`);
    for (const summary of summaries) console.log(`- ${summary}`);
  }
  if (result.stage === "budget") console.log("\nThe budget ran out before every judge ran.");
  if (result.skipped) console.log(`\nA judge failed, and the round's budget did not cover ${result.skipped.join(", ")}, so they did not run.`);
  if (result.stage === "error") console.log(`\nA judge could not finish, so the round has no verdict (its cost is counted): ${result.error}\nRun the round again.`);
  if (!result.calibrated) console.log("\nThis round ran without a passing calibration: it is a trial and does not pass.");
  if (result.missingReferences?.length) {
    console.log(`\nThe judges compared without ${result.missingReferences.join(", ")}, which did not capture.`);
    if (result.provisional) console.log("Every judge passed the bar, but a pass needs every reference (pass.allReferences): this is a provisional pass, not a final one. Run the round again on this commit once the reference captures.");
  }
  console.log(`\nScreenshots: ${versionDir(run, `round-${result.round}`)}`);
  console.log(`Spent this round ${money(result.costUSD)}; run total ${money(spent(run))} of ${money(config.budgetUsd.run)}.`);
  console.log(`\n${scoreLine(result, config)}`);
}

// What a plateau's metrics did, for the status line.
const METRIC = { lowest: "lowest category", shortfall: "total shortfall under the bar", gain: "gain over main", references: "lead over the best reference" };
const describeMetrics = (metrics) => Object.entries(metrics).map(([name, m]) => `${METRIC[name]} best ${fixed(m.recent)} vs ${fixed(m.before)} before (noise ${fixed(m.noise)})`).join("; ");

function statusCommand(config, values) {
  const run = existingRun(config, values);
  const list = rounds(run);
  const first = config.judges[0];
  const barJudge = config.judges.at(-1);
  const latest = [...list].reverse().find((round) => round.verdicts?.length);
  // The latest verdict on the bar; the latest round may have stopped at a pre-check.
  const barRound = [...list].reverse().find((round) => barVerdict(round));
  const latestBar = barRound ? barVerdict(barRound) : null;
  const spentUSD = spent(run);
  const calibration = readJson(calibrationPath(run), null);
  const noise = (key) => {
    const judge = config.judges.find((item) => judgeKey(item) === key) ?? first;
    const sigma = climbNoise(noiseOf(calibration, judge), judge, list);
    return { lowest: sigma.sigmaLowest, gain: sigma.sigmaOverall };
  };
  const status = {
    run: run.id, baseline: run.baseline, council: run.council ?? null, spentUSD, budgetUSD: config.budgetUsd.run,
    budgetLeftShare: Math.max(0, 1 - spentUSD / config.budgetUsd.run),
    calibrated: calibrated(config, calibration).ok, rounds: list.map((round) => ({ ...round, scoreLine: scoreLine(round, config) })),
    plateau: plateau(list, { min: config.pass.min, references: config.pass.references, noise }),
    passed: list.some((round) => round.pass && !round.dirty && round.calibrated !== false),
    provisional: list.some((round) => round.provisional && !round.dirty && round.calibrated !== false),
    barGap: latestBar ? config.pass.min - latestBar.lowest : null,
    lowestCategory: latestBar?.lowestCategory ?? null,
    judgesInLatest: latest ? { judged: latest.verdicts.length, of: config.judges.length } : null,
    main: { calibration: calibration?.judges?.[judgeKey(barJudge)]?.baseline ?? null, rounds: mainRange(list, barJudge) },
  };
  if (values.json) {
    console.log(JSON.stringify(status, null, 2));
    return 0;
  }
  console.log(`Run ${run.id} · main ${short(run.baseline.sha)} · council ${status.council ?? "–"} · calibrated: ${status.calibrated ? "yes" : "no"} · spent ${money(spentUSD)} of ${money(status.budgetUSD)} (${percent(status.budgetLeftShare)} left)`);
  for (const round of status.rounds) console.log(round.scoreLine);
  if (!list.length) console.log("No rounds yet.");
  if (status.main.rounds)
    console.log(`Main scored ${fixed(status.main.rounds.low)}–${fixed(status.main.rounds.high)} over ${status.main.rounds.rounds} judged round${status.main.rounds.rounds === 1 ? "" : "s"}${status.main.calibration === null ? "" : `, ${fixed(status.main.calibration)} in calibration`} (${judgeKey(barJudge)}; scores are comparative).`);
  if (latest && latest !== barRound) {
    const failed = latest.verdicts.find((v) => !v.pass);
    console.log(`Latest judged round ${latest.round}: ${failed ? `the regression pre-check ${failed.judge} failed it (${failed.reasons.join("; ")}), so` : ""} the bar judge did not score it.`);
  }
  if (barRound) {
    const v = latestBar;
    console.log(`${barRound === latest ? "Latest judged round" : "Latest round the bar judge scored:"} ${barRound.round}: lowest ${v.lowestCategory} ${fixed(v.lowest)}, ${status.barGap > 0 ? `${fixed(status.barGap)} under` : "at or over"} the bar ${config.pass.min}; gain ${signed(v.gain)} (bar ${fixed(v.gainBar)}).`);
  }
  if (latest) {
    if (latest.verdicts.length < config.judges.length)
      console.log(`It was judged by ${latest.verdicts.length} of ${config.judges.length} judges: run \`ui round --all-judges\` on the commit you hand over.`);
  }
  if (status.plateau.plateau) {
    console.log(`Plateau (${status.plateau.judge}): in the last two judged rounds nothing the bar needs moved beyond the noise: ${describeMetrics(status.plateau.metrics)}.`);
    const structural = structuralTried(list, status.plateau.movedAt);
    if (structural && !structural.followed) {
      console.log(`Structural round ${structural.round} has no fix round yet: fix the issues it reported in one more round on a new commit (not --structural) before you decide. Stop if that round does not move it either.`);
    } else if (structural) {
      console.log(`Structural round ${structural.round} and the round that fixed its issues did not move it either: stop the climb and say so in the last note.`);
      const unreachable = barWarnings(calibration?.judges);
      if (unreachable.length) {
        console.log(`Calibration warned that the bar ${config.pass.min} may be out of the judges' range: say so in that note too.`);
        for (const [key, result] of unreachable) console.log(`- ${key}: ${result.barReach.warnings.join("; ")}.`);
      }
    } else if (status.barGap > 0.5 && status.budgetLeftShare > 0.5)
      console.log(`The bar is ${fixed(status.barGap)} away with ${percent(status.budgetLeftShare)} of the budget left: before stopping, make one structural round aimed at ${status.lowestCategory} (a new system for it, not more local fixes), judged with \`ui round --structural\`. Stop if that round does not move it either.`);
  } else console.log(`No plateau (${status.plateau.judged} judged round${status.plateau.judged === 1 ? "" : "s"}${Object.keys(status.plateau.metrics).length ? `; ${describeMetrics(status.plateau.metrics)}` : ""}).`);
  return 0;
}

// status and report read a run without creating one.
function existingRun(config, values) {
  const run = findRun(config, values.run);
  if (!run) throw new RunError(`no ${values.run ? `run ${values.run}` : "run"} for ${config.name} yet: start one with \`ui capture\` or \`ui calibrate\``);
  if (run.identity !== identity(config)) log(`Note: run ${run.id} was started with a different configuration, judges' rubric or prompts, or preferences.`);
  return run;
}

function reportCommand(config, values) {
  const run = existingRun(config, values);
  const out = values.out ?? join(run.dir, "report.html");
  const list = fullRounds(run);
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
