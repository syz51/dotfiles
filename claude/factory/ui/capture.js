// Captures versions of a UI: prepares a source (the working tree, or a git revision
// extracted with git archive, which leaves the repository untouched), serves it on a free
// port, and screenshots every shot through the headless-browser skill's script, with the
// page checks evaluated just before each screenshot.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { childEnv, runProcess } from "../../tests/lib/process.js";
import { injectCssExpression, pageChecksExpression } from "./checks.js";
import { NARROW_WIDTH, STEP_FLAGS } from "./config.js";

export const BROWSE = () => process.env.CLAUDE_FACTORY_BROWSE || join(import.meta.dir, "..", "..", "skills", "headless-browser", "scripts", "browse.ts");
const SETUP_SCRIPT = join(import.meta.dir, "..", "..", "skills", "headless-browser", "scripts", "setup.sh");

export class CaptureError extends Error {}

const tail = (value, size = 1500) => (value.length > size ? `…${value.slice(-size)}` : value);

async function git(cwd, args) {
  const result = await runProcess(["git", "-C", cwd, ...args], { cwd, env: process.env, timeout: 60_000 });
  if (result.code !== 0) throw new CaptureError(`git ${args.join(" ")} failed: ${tail(result.stderr.trim())}`);
  return result.stdout.trim();
}

export async function repoRoot(dir) {
  return git(dir, ["rev-parse", "--show-toplevel"]);
}

export async function resolveRev(dir, rev) {
  return git(dir, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).catch(() => {
    throw new CaptureError(`${rev} is not a commit in ${dir}: fetch it, or set "baseline" in the config to a ref that exists`);
  });
}

// The working tree's commit and whether it has changes on top.
export async function treeState(dir) {
  const [commit, status] = await Promise.all([git(dir, ["rev-parse", "HEAD"]), git(dir, ["status", "--porcelain"])]);
  return { commit, dirty: status.length > 0 };
}

async function runSteps(commands, cwd, what, timeout = 900_000) {
  const results = [];
  for (const argv of commands) {
    const started = Date.now();
    const result = await runProcess(argv, { cwd, env: childEnv(process.env), timeout }).catch((error) => ({ code: null, stdout: "", stderr: error.message }));
    results.push({ argv, code: result.code, ms: Date.now() - started, output: tail(`${result.stdout}\n${result.stderr}`.trim()) });
    if (result.code !== 0) return { ok: false, results, failed: `${what} \`${argv.join(" ")}\` exited ${result.code ?? "without finishing"}` };
  }
  return { ok: true, results };
}

// The setup commands (installing dependencies), run in root.
export const runSetup = (config, root) => runSteps(config.setup, root, "setup");

// The project's checks (type check, tests, build), run in root before a round.
export const runChecks = (config, root = config.rootDir) => runSteps(config.checks, root, "check");

// A copy of the config's root folder at commit sha, with the setup commands run in it.
// Returns { root, dispose }.
export async function prepareRevision(config, sha) {
  const top = await repoRoot(config.rootDir);
  const dir = mkdtempSync(join(tmpdir(), "claude-factory-ui-"));
  try {
    const archive = spawn("git", ["-C", top, "archive", "--format=tar", sha], { stdio: ["ignore", "pipe", "pipe"] });
    const extract = spawn("tar", ["-x", "-C", dir], { stdio: ["pipe", "ignore", "pipe"] });
    archive.stdout.pipe(extract.stdin);
    let errors = "";
    archive.stderr.on("data", (chunk) => (errors += chunk));
    extract.stderr.on("data", (chunk) => (errors += chunk));
    const exited = (child) => new Promise((resolve) => child.on("close", resolve));
    const [archived, extracted] = await Promise.all([exited(archive), exited(extract)]);
    if (archived !== 0 || extracted !== 0) throw new CaptureError(`could not extract ${sha.slice(0, 12)}: ${tail(errors.trim())}`);
    const root = join(dir, relative(top, config.rootDir));
    if (!existsSync(root)) throw new CaptureError(`${relative(top, config.rootDir) || "."} does not exist at ${sha.slice(0, 12)}`);
    const setup = await runSetup(config, root);
    if (!setup.ok) throw new CaptureError(`${setup.failed} at ${sha.slice(0, 12)}:\n${setup.results.at(-1).output}`);
    return { root, dispose: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Starts the app from root on a free port and waits until its ready path answers.
// Returns { origin, stop }; stop ends the server's whole process group.
export async function serve(config, root, logFile) {
  const port = await freePort();
  const argv = config.serve.command.map((part) => part.replaceAll("{port}", String(port)));
  const log = openSync(logFile, "a");
  const child = spawn(argv[0], argv.slice(1), { cwd: root, env: childEnv(process.env), detached: true, stdio: ["ignore", log, log] });
  closeSync(log);
  let exit = null;
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve((exit = { code, signal }))));
  child.on("error", (error) => (exit = { error }));
  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const stop = async () => {
    if (exit) return;
    signal("SIGTERM");
    const timer = setTimeout(() => signal("SIGKILL"), 3000);
    await exited;
    clearTimeout(timer);
  };
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + config.serve.timeoutMs;
  while (true) {
    if (exit) throw new CaptureError(`\`${argv.join(" ")}\` exited before it was ready (${exit.error?.message ?? `code ${exit.code}`}): ${tail(readFileSync(logFile, "utf8"))}`);
    const ok = await fetch(`${origin}${config.serve.ready}`).then((response) => response.ok, () => false);
    if (ok) return { origin, stop };
    if (Date.now() > deadline) {
      await stop();
      throw new CaptureError(`\`${argv.join(" ")}\` did not answer ${config.serve.ready} on port ${port} within ${config.serve.timeoutMs} ms: ${tail(readFileSync(logFile, "utf8"))}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// The headless-browser command for one shot. inject adds CSS before the checks run.
export function browseArgv(shot, { url, out, settleMs, inject }) {
  const argv = ["bun", BROWSE(), url, "--width", String(shot.width), "--height", String(shot.height), "--scheme", shot.scheme, "--reduced-motion", "--timeout", "20000"];
  for (const step of shot.steps) argv.push(STEP_FLAGS[step.kind], step.arg);
  if (inject) argv.push("--eval", injectCssExpression(inject));
  if (settleMs) argv.push("--wait", String(settleMs));
  argv.push("--eval", pageChecksExpression(NARROW_WIDTH), "--shot", out);
  return argv;
}

async function browse(argv) {
  const result = await runProcess(argv, { env: childEnv(process.env), timeout: 120_000 }).catch((error) => {
    throw new CaptureError(`the headless browser did not finish: ${error.message}`);
  });
  if (result.code === 3) throw new CaptureError(`Playwright is not installed for the headless-browser skill: run sh ${SETUP_SCRIPT}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new CaptureError(`the headless browser printed no report (exit ${result.code}): ${tail(result.stderr.trim())}`);
  }
}

// Screenshots shots into dir. origin is the served app for product shots (a reference shot
// carries its own url or file). A shot that fails to load or run its steps is recorded with
// its error; the caller decides whether that is fatal. Returns the shot records.
export async function captureShots(shots, { dir, origin, settleMs, inject }) {
  mkdirSync(dir, { recursive: true });
  const records = [];
  for (const shot of shots) {
    const out = join(dir, `${shot.id}.png`);
    if (shot.file) {
      copyFileSync(shot.file, out);
      records.push({ id: shot.id, file: out, error: null, checks: null, pageErrors: [], consoleErrors: [], failedRequests: [] });
      continue;
    }
    const call = async (path) => {
      const response = await fetch(`${origin}${path}`).catch((error) => ({ ok: false, status: error.message }));
      if (!response.ok) throw new CaptureError(`GET ${path} for ${shot.id} failed: ${response.status}`);
    };
    for (const path of shot.before ?? []) await call(path);
    const report = await browse(browseArgv(shot, { url: shot.url ?? `${origin}${shot.path}`, out, settleMs, inject }));
    for (const path of shot.after ?? []) await call(path);
    const evals = report.evals ?? [];
    let error = report.error ?? (existsSync(out) ? null : "no screenshot was written");
    if (!error && report.status >= 400) error = `HTTP ${report.status}`;
    if (!error && inject && evals[0]?.value !== true) error = "the control style sheet did not apply";
    records.push({
      id: shot.id, file: out, error, status: report.status,
      checks: evals.at(-1)?.value ?? null,
      pageErrors: report.pageErrors ?? [], consoleErrors: report.consoleErrors ?? [], failedRequests: report.failedRequests ?? [],
    });
  }
  return records;
}

// Serves root and captures shots, then stops the server whatever happened.
export async function captureServed(config, root, shots, { dir, inject }) {
  mkdirSync(dir, { recursive: true });
  const server = await serve(config, root, join(dir, "server.log"));
  try {
    return await captureShots(shots, { dir, origin: server.origin, settleMs: config.settleMs, inject });
  } finally {
    await server.stop();
  }
}
