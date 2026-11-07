// A climb run: the state folder of one configuration's climb, its spending ledger, and the
// captured versions (main, the control, the references, each round's candidate). A run is
// tied to its configuration, the rubric and the owner's preferences; changing any of them
// starts a new run, so scores within a run stay comparable.
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendJsonl, readJson, readJsonl, statePath, writeJsonAtomic } from "../lib/state.js";
import { captureServed, CaptureError, captureShots, prepareRevision, resolveRev, runSetup } from "./capture.js";
import { productShots, referenceShots } from "./config.js";
import { avoidList, RUBRIC } from "./council.js";

export class RunError extends Error {}

export const runsDir = (config) => dirname(statePath("ui", config.name, "runs", "run"));

export function identity(config, avoid = avoidList()) {
  return createHash("sha256").update(JSON.stringify([config.hash, RUBRIC.version, avoid])).digest("hex").slice(0, 16);
}

const stamp = (date = new Date()) => date.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");

// A run by id, or the latest; null when there is none.
export function findRun(config, id) {
  const dir = runsDir(config);
  const ids = existsSync(dir) ? readdirSync(dir).filter((name) => existsSync(join(dir, name, "run.json"))).sort() : [];
  if (id && !ids.includes(id)) throw new RunError(`no run ${id} for ${config.name}; runs: ${ids.join(", ") || "none"}`);
  const pick = id ?? ids.at(-1);
  return pick ? { ...readJson(join(dir, pick, "run.json")), dir: join(dir, pick) } : null;
}

// The run to use: the latest one when it matches the configuration, a new one when asked
// for or when there is none. id picks a run by its id.
export async function openRun(config, { id, fresh = false, avoid = avoidList() } = {}) {
  const key = identity(config, avoid);
  const found = fresh && !id ? null : findRun(config, id);
  if (found) {
    if (found.identity !== key)
      throw new RunError(`run ${found.id} was started with a different configuration, rubric or preferences; scores across them do not compare. Pass --new-run to start a new run (its main branch is captured and its judges calibrated again).`);
    return found;
  }
  const sha = await resolveRev(config.rootDir, config.baseline);
  const run = { id: stamp(), identity: key, created: new Date().toISOString(), config: config.file, baseline: { rev: config.baseline, sha }, rubric: RUBRIC.version };
  const dir = join(runsDir(config), run.id);
  if (existsSync(join(dir, "run.json"))) throw new RunError(`run ${run.id} already exists; wait a second and try again`);
  writeJsonAtomic(join(dir, "run.json"), run);
  return { ...run, dir };
}

// One process at a time per run: two rounds at once would share captures and the ledger.
export function lockRun(run) {
  const file = join(run.dir, "lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(file, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(readJson(file, null));
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {}
      if (alive) throw new RunError(`run ${run.id} is in use by process ${pid}; wait for it to finish`);
      rmSync(file, { force: true });
    }
  }
  throw new RunError(`could not lock run ${run.id}`);
}

export const ledgerPath = (run) => join(run.dir, "ledger.jsonl");
export const spent = (run) => readJsonl(ledgerPath(run)).reduce((sum, entry) => sum + entry.usd, 0);
export const record = (run, what, usd) => appendJsonl(ledgerPath(run), { at: new Date().toISOString(), what, usd });

export const versionDir = (run, name) => join(run.dir, "versions", name);
export const roundsPath = (run) => join(run.dir, "rounds.jsonl");
export const rounds = (run) => readJsonl(roundsPath(run));
export const calibrationPath = (run) => join(run.dir, "calibration.json");

// Shot records with their metadata, as the council takes them.
const withMeta = (records, shots) => {
  const byId = new Map(shots.map((shot) => [shot.id, shot]));
  return records.map((item) => ({ ...byId.get(item.id), ...item }));
};

function saved(dir, shots) {
  const file = join(dir, "capture.json");
  const capture = readJson(file, null);
  if (!capture || !capture.shots.every((item) => existsSync(item.file))) return null;
  if (shots.some((shot) => !capture.shots.some((item) => item.id === shot.id))) return null;
  return capture;
}

function fatal(records, what) {
  const broken = records.filter((item) => item.error);
  if (broken.length) throw new CaptureError(`${what} did not capture, so there is nothing to compare against: ${broken.map((item) => `${item.id}: ${item.error}`).join("; ")}`);
}

// Main's shots, and the control's when control is set, captured once per run.
export async function baselineVersions(config, run, { control = false, log = () => {} } = {}) {
  const shots = productShots(config);
  const wanted = [["baseline", null], ...(control ? [["control", config.controlCss]] : [])].filter(([name]) => !saved(versionDir(run, name), shots));
  if (wanted.length) {
    log(`Capturing ${wanted.map(([name]) => (name === "baseline" ? "main" : name)).join(" and ")} at ${run.baseline.sha.slice(0, 12)}…`);
    const source = await prepareRevision(config, run.baseline.sha);
    try {
      for (const [name, inject] of wanted) {
        const dir = versionDir(run, name);
        rmSync(dir, { recursive: true, force: true });
        const records = await captureServed(config, source.root, shots, { dir, inject });
        fatal(records, name === "baseline" ? `main (${run.baseline.sha.slice(0, 12)})` : "the control");
        writeJsonAtomic(join(dir, "capture.json"), { sha: run.baseline.sha, at: new Date().toISOString(), shots: records });
      }
    } finally {
      source.dispose();
    }
  }
  return {
    baseline: withMeta(saved(versionDir(run, "baseline"), shots).shots, shots),
    control: control ? withMeta(saved(versionDir(run, "control"), shots).shots, shots) : null,
  };
}

// The references' shots, captured once per run.
export async function referenceVersions(config, run, { log = () => {} } = {}) {
  const shots = referenceShots(config);
  if (!shots.length) return [];
  const dir = versionDir(run, "references");
  if (!saved(dir, shots)) {
    log(`Capturing ${config.references.length} reference${config.references.length > 1 ? "s" : ""}…`);
    rmSync(dir, { recursive: true, force: true });
    const records = await captureShots(shots, { dir, settleMs: config.settleMs });
    fatal(records, "a reference");
    writeJsonAtomic(join(dir, "capture.json"), { at: new Date().toISOString(), shots: records });
  }
  const records = withMeta(saved(dir, shots).shots, shots);
  return config.references.map((ref) => ({ key: `ref:${ref.id}`, kind: "reference", title: ref.title, shots: records.filter((item) => item.ref === ref.id) }));
}

// Runs fn(root) on a candidate: the committed tree at sha, extracted and set up, or the
// working tree with its uncommitted changes (root), after the setup commands run in it.
// The extract is removed afterwards.
export async function withSource(config, { sha, root }, fn) {
  if (root) {
    const setup = await runSetup(config, root);
    if (!setup.ok) throw new CaptureError(`${setup.failed} in ${root}:\n${setup.results.at(-1).output}`);
    return fn(root);
  }
  const source = await prepareRevision(config, sha);
  try {
    return await fn(source.root);
  } finally {
    source.dispose();
  }
}

// A candidate's shots, served from root, as the version name.
export async function candidateShots(config, run, name, root) {
  const shots = productShots(config);
  const dir = versionDir(run, name);
  rmSync(dir, { recursive: true, force: true });
  const records = await captureServed(config, root, shots, { dir });
  writeJsonAtomic(join(dir, "capture.json"), { at: new Date().toISOString(), shots: records });
  return withMeta(records, shots);
}

// A captured version's shot records, or null.
export const capturedShots = (run, name) => readJson(join(versionDir(run, name), "capture.json"), null)?.shots ?? null;
