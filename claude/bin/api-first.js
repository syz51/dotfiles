// The billing plan for claude-api: whether a run uses the Anthropic API or the claude.ai
// subscription, and the --settings that give Claude Code the key. claude-api (a shell
// script) runs `bun api-first.js plan <args>` and replaces itself with the real claude, so
// a caller that kills the process it started kills claude itself.
//
// Only print-mode runs (-p/--print) are billed to the API, and only when the caller set no
// auth or endpoint of its own (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL);
// anything else passes through untouched. The key reaches Claude Code through an
// apiKeyHelper merged into the run's last --settings, so it is not in the environment, where
// an `env` dump would expose it by accident. It is not a secret from the agent: a session
// running as you can still read the key file.
//
// The credit check is a plain one-token Messages request: it finds a bad key or no credit
// at all. It cannot stand in for Claude Code's own requests, which the API may refuse for
// credit while plain ones are served. Nor can a request made to look like Claude Code's:
// on 2026-11-06 the API refused any request carrying Claude Code's beta or its Agent SDK
// identity line, even while real Claude Code runs on the same key were served, and earlier
// that day real runs were refused while minimal ones went through. So API runs report
// back: StopFailure and Stop hooks merged into the same settings leave each hook input in
// the state folder's reports/, and the next plan folds them in (see applyReport). A run
// the API refused for credit or the key moves later runs to the subscription; a run that
// went through clears the count. While the check keeps passing but runs keep being
// refused, each refusal keeps runs on the subscription twice as long as the last, up to
// MAX_BACKOFF_MS.
//
// The same path records what each API run cost. Neither the Stop hook's input nor any other
// hook's carries the cost, and claude-api cannot read the run's result, since it has
// replaced itself with claude. Claude Code writes the session's running total to the
// transcript as a "cost-state" line when it exits, after Stop but before SessionEnd
// (2.1.319). So a SessionEnd hook adds the transcript's last two such lines to its report,
// and the next plan logs the run's cost: the last total, less the one before it when a
// resumed session carried that one over. A run that keeps no transcript
// (--no-session-persistence) has no such line, and its cost is logged as unknown. A caller
// that reads the run's stream, such as the factory, logs the result event's cost by session
// instead (logResultCost), and the summary fills the unknown cost from it.
// `bun api-first.js spend` sums the log by caller and day.
//
// Variables (named API_FIRST_* because callers strip CLAUDE_* from a child's environment):
//   API_FIRST_KEY_FILE   key file, default ~/.local/share/codex-skills/anthropic-api-key
//   API_FIRST_STATE      state folder, default ${XDG_STATE_HOME:-~/.local/state}/claude-api
//   API_FIRST_REAL_BIN   the real claude, default the first on PATH other than this wrapper
//   API_FIRST_BASE_URL   API base URL for the credit check (tests)
//   API_FIRST_DEPTH      nesting depth, set by claude-api; past MAX_DEPTH it stops a loop
//   API_FIRST_SUBSCRIPTION  1 runs on the subscription without a check: for a caller
//                        retrying a run the API refused, whose hook may have been cut off
//                        before it reported the refusal
//   API_FIRST_CALLER     the caller's name in the log; default the caller's script, read
//                        from the process API_FIRST_CALLER_PID (set by claude-api)
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { appendJsonl, readJson, readJsonl, writeJsonAtomic } from "../factory/lib/state.js";

export const TTL_MS = { ok: 10 * 60 * 1000, exhausted: 30 * 60 * 1000, invalid: 30 * 60 * 1000, refused: 30 * 60 * 1000, unknown: 60 * 1000 };
export const MAX_BACKOFF_MS = 8 * 60 * 60 * 1000;
// Claude Code's StopFailure error types that mean this key cannot run Claude Code.
export const RUN_REFUSALS = { billing_error: "exhausted", authentication_failed: "invalid" };
// Wording of the API's refusals for credit or a spend limit.
export const CREDIT_REFUSAL = /credit|billing|insufficient|usage limit|spend limit/i;
// A cached result counts only for the check that made it. An earlier check sent Claude
// Code's beta ("messages+claude-code-20250219"), which the API refused even for keys that
// Claude Code could use.
const CHECK = "messages";
// A wrapped session may run a script that goes through the wrapper again; deeper than this
// is a loop.
export const MAX_DEPTH = 4;
const SHIM_DIR = resolve(import.meta.dir, "api-first");
const OWN_AUTH = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];

const home = (env) => env.HOME || homedir();
export const keyFile = (env = process.env) => env.API_FIRST_KEY_FILE || join(home(env), ".local", "share", "codex-skills", "anthropic-api-key");
export const stateDir = (env = process.env) => env.API_FIRST_STATE || join(env.XDG_STATE_HOME || join(home(env), ".local", "state"), "claude-api");
export const decisionLog = (env = process.env) => join(stateDir(env), "decisions.jsonl");

const real = (path) => {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
};

// The real claude: API_FIRST_REAL_BIN, else the first claude on PATH that is neither this
// wrapper, its shim nor a link to them, however PATH spells it (~/.claude is a link).
export function realClaude(env = process.env) {
  if (env.API_FIRST_REAL_BIN) return env.API_FIRST_REAL_BIN;
  const own = new Set([real(SHIM_DIR), real(join(SHIM_DIR, "claude")), real(join(import.meta.dir, "claude-api"))].filter(Boolean));
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir || own.has(real(dir))) continue;
    const candidate = join(dir, "claude");
    if (own.has(real(candidate))) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch (error) {
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  throw new Error("no claude executable on PATH; set API_FIRST_REAL_BIN");
}

// Options before a `--` end-of-options marker: whether the run is in print mode, and the
// last --settings value (Claude Code applies only the last one).
export function readArgs(argv) {
  let print = false;
  let settings;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") break;
    if (arg === "-p" || arg === "--print") print = true;
    else if (arg === "--settings") settings = argv[++index];
    else if (arg.startsWith("--settings=")) settings = arg.slice("--settings=".length);
  }
  return { print, settings };
}

// The caller's settings: a file path or JSON, or none.
export const readSettings = (value) => value === undefined ? {} : JSON.parse(value.trim().startsWith("{") ? value : readFileSync(value, "utf8"));

// The caller's settings with the key helper and the report hooks ({ event: command })
// added after the caller's own hooks. A caller's own apiKeyHelper is kept, and then no
// report hook is added: its runs say nothing about this key and are not billed to it.
export function mergedSettings(settings, helper, reports) {
  if (settings.apiKeyHelper !== undefined || reports === undefined) return JSON.stringify({ apiKeyHelper: helper, ...settings });
  const hooks = { ...settings.hooks };
  for (const [event, command] of Object.entries(reports)) hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: "command", command }] }];
  return JSON.stringify({ ...settings, apiKeyHelper: helper, hooks });
}

// ok: the key works and has credit. exhausted: out of credit or past a spend limit. invalid: the key was refused. refused: any other definite
// refusal of this fixed, valid request, whatever its wording, since a run would be refused
// too. unknown: the check could not tell (no answer, a rate limit, a server error, or a
// missing check model, which says nothing about the caller's model).
export async function checkCredit(key, { baseUrl = "https://api.anthropic.com", fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  let status;
  let body;
  try {
    const response = await fetchImpl(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    body = await response.text();
  } catch (error) {
    return { status: "unknown", detail: `request failed: ${error.message}` };
  }
  if (status === 200) return { status: "ok", detail: "HTTP 200" };
  let message = body;
  try {
    message = JSON.parse(body)?.error?.message ?? body;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const detail = `HTTP ${status}: ${String(message).slice(0, 200)}`;
  // Only the API's own error answer is a definite refusal; a proxy's page is not.
  if (message === body) return { status: "unknown", detail };
  if (status === 401 || status === 403) return { status: "invalid", detail };
  if ([400, 402].includes(status) && CREDIT_REFUSAL.test(message)) return { status: "exhausted", detail };
  if (status >= 400 && status < 500 && ![404, 408, 409, 429].includes(status)) return { status: "refused", detail };
  return { status: "unknown", detail };
}

function readState(dir) {
  try {
    return readJson(join(dir, "state.json"), null);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

const onApi = (status) => ["ok", "unknown"].includes(status);
const reportsDir = (env) => join(stateDir(env), "reports");
const STALE_MS = 60 * 60 * 1000;
const LOCK_STALE_MS = 2000;

// Runs fn holding state.lock, so plans running together do not overwrite each other's
// state. fn only reads and writes local files, so the lock is held for milliseconds; one
// older than LOCK_STALE_MS was left by a plan that died, and is taken over.
function locked(dir, fn) {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, "state.lock");
  for (const deadline = Date.now() + 5 * LOCK_STALE_MS; ;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const since = statSync(lock, { throwIfNoEntry: false })?.mtimeMs;
      if (since !== undefined && Date.now() - since > LOCK_STALE_MS) rmSync(lock, { force: true });
      else if (Date.now() > deadline) throw new Error(`${lock} stays locked`);
      else Bun.sleepSync(5);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

// How long a state entry stands: its status's interval, doubled for each refusal a run
// reported in a row (state.refusals), up to MAX_BACKOFF_MS.
export function lifetime(state) {
  const base = TTL_MS[state.status] ?? 0;
  return state.source === "run" ? Math.min(base * 2 ** (state.refusals - 1), MAX_BACKOFF_MS) : base;
}

// The hook commands an API run reports through, by event: each saves the hook input as
// reports/<plannedAt>-<keyHash>-r<run>-<pid>.json. Plain sh, cat, sed and grep, because
// Claude Code does not wait for StopFailure hooks and kills them when it exits (2.1.318): a
// 2-second hook was cut off, so the hook has to finish in milliseconds. The SessionEnd
// report adds, after the input line, the last two cost-state lines of the transcript the
// input names. The file appears whole or not at all. The hooks print nothing and always
// exit 0: a report that fails must not block a Stop (exit 2) or add an error to the run.
export function reportHooks(dir, keyHash, plannedAt, run) {
  const name = `${plannedAt}-${keyHash}-r${run}-$$`;
  const save = (extra) => `{ cd ${quote(dir)} && cat > .${name} && { ${extra}mv .${name} ${name}.json; }; } >/dev/null 2>&1; exit 0`;
  const report = save("");
  const cost = save(`t=$(sed -n 's/.*"transcript_path":"\\([^"]*\\)".*/\\1/p' .${name}); echo >> .${name}; `
    + `[ ! -f "$t" ] || grep '^{"type":"cost-state"' "$t" | tail -n 2 >> .${name}; `);
  return { StopFailure: report, Stop: report, SessionEnd: cost };
}

// What a run cost, from its SessionEnd report: { costUSD, detail? }, costUSD null when the
// report holds no cost-state line for the run's session. A resumed session carries its
// total over, so the run's cost is its last total less the one before it.
export function runCost(input, lines) {
  const totals = lines.filter((line) => line?.type === "cost-state" && line.sessionId === input.session_id && Number.isFinite(line.totalCostUSD))
    .map((line) => line.totalCostUSD);
  if (!totals.length) return { costUSD: null, detail: "no cost-state line in the run's transcript; a run with --no-session-persistence keeps none" };
  const [before, last] = totals.length > 1 ? totals.slice(-2) : [0, totals[0]];
  return { costUSD: last >= before ? last - before : last };
}

// A report file's name: plannedAt, keyHash, and the run id, which reports from before
// costs were recorded lack.
const REPORT_NAME = /^(\d+)-([0-9a-f]+)(?:-r([0-9a-f]+))?-\d+\.json$/;

const parsed = (text) => {
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
};

// A report's hook input and the JSON lines after it ({ input, lines }), or null when the
// input is damaged. A damaged line after it is left out.
export function parseReport(text) {
  const [first, ...rest] = text.split("\n").filter((line) => line.trim());
  const input = parsed(text)?.value ?? parsed(first ?? "")?.value;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  return { input, lines: parsed(text) ? [] : rest.map((line) => parsed(line)?.value) };
}

// The log line for run's SessionEnd report, saved at `at`.
const costLine = (run, { input, lines }, at) => ({ at: new Date(at).toISOString(), mode: "cost", run, session: input.session_id, ...runCost(input, lines) });

// The state after one run report ({ input, plannedAt, at }) for the state's key. A refusal
// for credit or the key (StopFailure) moves later runs to the subscription, unless one for
// the same reason already stands: runs refused together count once. A run that went through (Stop) clears
// the count, unless a check made after its plan has replaced the entry it ran under.
export function applyReport(state, { input, keyHash, plannedAt, at }) {
  if (input.hook_event_name === "Stop")
    return state?.refusals && state.source !== "run" && plannedAt >= state.checkedAt ? { ...state, refusals: 0 } : state;
  const status = RUN_REFUSALS[input.error];
  if (input.hook_event_name !== "StopFailure" || !status) return state;
  if (state?.source === "run" && state.status === status && at - state.checkedAt < lifetime(state)) return state;
  const message = String(input.last_assistant_message ?? "").slice(0, 200);
  return { keyHash, check: CHECK, status, checkedAt: at, source: "run", refusals: (state?.refusals ?? 0) + 1,
    detail: `a Claude Code run was refused (${input.error}): ${message}` };
}

// Folds the reports waiting in reports/ into state (this key's entry, or null), and logs
// each refusal it records and each run's cost. A report is claimed by renaming it, so two
// plans never fold the same one. Costs are logged whatever the key; other reports for
// another key are dropped, as are leftovers of cut-off hooks.
function foldReports(env, keyHash, state, now) {
  const dir = reportsDir(env);
  if (!existsSync(dir)) return state;
  const log = decisionLog(env);
  const reports = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const match = REPORT_NAME.exec(name);
    if (!match) {
      if (name.startsWith(".") && now - statSync(path, { throwIfNoEntry: false })?.mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true });
      continue;
    }
    const claimed = join(dir, `.${name}.${process.pid}`);
    let at;
    try {
      at = statSync(path).mtimeMs;
      renameSync(path, claimed);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const report = parseReport(readFileSync(claimed, "utf8"));
    rmSync(claimed);
    if (!report) continue;
    if (report.input.hook_event_name === "SessionEnd") {
      if (match[3]) appendJsonl(log, costLine(match[3], report, at));
    } else if (match[2] === keyHash) reports.push({ input: report.input, keyHash, plannedAt: Number(match[1]), at });
  }
  for (const report of reports.sort((a, b) => a.at - b.at)) {
    const next = applyReport(state, report);
    if (next !== state && next.source === "run" && next.checkedAt === report.at)
      appendJsonl(log, { at: new Date(report.at).toISOString(), mode: "refused", reason: `${next.status}: ${next.detail}`, cwd: report.input.cwd });
    state = next;
  }
  return state;
}

// { mode: "api" | "subscription", reason, keyHash }. Run reports are folded in first. A
// cached entry counts only for the same key and check, within its lifetime; an
// inconclusive check leaves the run on the API, where Claude Code reports the error itself.
// A passing check keeps the count of refusals that runs reported, so a refusal after it
// backs off further; a refusal reported while the check ran stands.
export async function decide({ env = process.env, now = Date.now(), check = checkCredit } = {}) {
  const file = keyFile(env);
  if (!existsSync(file)) return { mode: "subscription", reason: `no key file at ${file}` };
  const key = readFileSync(file, "utf8").trim();
  const keyHash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const dir = stateDir(env);
  const stateFile = join(dir, "state.json");
  // This key's entry with the waiting reports folded in; called holding the lock.
  const folded = () => {
    const state = readState(dir);
    const before = state?.keyHash === keyHash && state.check === CHECK ? state : null;
    const after = foldReports(env, keyHash, before, now);
    if (after !== before) writeJsonAtomic(stateFile, after);
    return after;
  };
  const standing = (state) => state && now - state.checkedAt < lifetime(state);
  let result = locked(dir, folded);
  if (standing(result)) result = { ...result, cached: true };
  else {
    const previous = result;
    const checked = await check(key, env.API_FIRST_BASE_URL ? { baseUrl: env.API_FIRST_BASE_URL } : {});
    result = locked(dir, () => {
      const latest = folded();
      if (latest?.source === "run" && latest.checkedAt !== previous?.checkedAt && standing(latest)) return { ...latest, cached: true };
      const refusals = onApi(checked.status) ? latest?.refusals ?? 0 : 0;
      writeJsonAtomic(stateFile, { keyHash, check: CHECK, status: checked.status, checkedAt: now, detail: checked.detail, refusals });
      return checked;
    });
  }
  const since = result.source === "run" ? "reported" : "checked";
  const reason = `${result.status}${result.cached ? ` (${since} ${new Date(result.checkedAt).toISOString()})` : ""}: ${result.detail}`;
  return { mode: onApi(result.status) ? "api" : "subscription", reason, keyHash };
}

// The plan for argv: { bin, mode: "api" | "subscription" | "passthrough", settings, reason, run }.
// settings is the merged --settings value in API mode, and run the id its cost is logged under.
export async function plan(argv, { env = process.env, check, now = Date.now() } = {}) {
  const depth = Number(env.API_FIRST_DEPTH ?? 0);
  if (depth > MAX_DEPTH) throw new Error(`nested ${depth} deep, which means a loop; set API_FIRST_REAL_BIN to the real claude`);
  const bin = realClaude(env);
  const { print, settings: value } = readArgs(argv);
  if (!print) return { bin, mode: "passthrough", reason: "not print mode" };
  let settings;
  try {
    settings = readSettings(value);
  } catch (error) {
    // Claude Code reports a --settings value it cannot read itself.
    if (!(error instanceof SyntaxError) && !["ENOENT", "EACCES", "EISDIR", "ENOTDIR"].includes(error.code)) throw error;
    return { bin, mode: "passthrough", reason: `unreadable --settings: ${error.message}` };
  }
  const own = OWN_AUTH.filter((name) => env[name] || settings.env?.[name]);
  if (own.length) return { bin, mode: "passthrough", reason: `caller set ${own.join(", ")}` };
  if (env.API_FIRST_SUBSCRIPTION === "1") return { bin, mode: "subscription", reason: "asked for by API_FIRST_SUBSCRIPTION" };
  const { keyHash, ...decision } = await decide({ env, check, now });
  if (decision.mode === "subscription") return { bin, ...decision };
  mkdirSync(reportsDir(env), { recursive: true });
  const helper = `cat ${quote(keyFile(env))}`;
  const run = randomBytes(6).toString("hex");
  return { bin, ...decision, run, settings: mergedSettings(settings, helper, reportHooks(reportsDir(env), keyHash, now, run)) };
}

const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;

// A caller's name from its command line: the folder and name of the script it runs (or
// the module after -m), else its program's name.
export function callerName(command) {
  const words = command.trim().split(/\s+/);
  const module = words.indexOf("-m");
  if (module > 0 && words[module + 1]) return words[module + 1];
  const script = words.slice(1).find((word) => !word.startsWith("-") && /\.(?:[cm]?[jt]s|py|sh|rb)$/.test(word));
  return script ? join(basename(dirname(script)), basename(script)) : basename(words[0] ?? "");
}

// The caller to log: API_FIRST_CALLER, else the name of the process API_FIRST_CALLER_PID,
// else null.
export function caller(env = process.env) {
  if (env.API_FIRST_CALLER) return env.API_FIRST_CALLER;
  if (!/^\d+$/.test(env.API_FIRST_CALLER_PID ?? "")) return null;
  const ps = spawnSync("ps", ["-o", "command=", "-p", env.API_FIRST_CALLER_PID], { encoding: "utf8" });
  return ps.status === 0 && ps.stdout.trim() ? callerName(ps.stdout) : null;
}

// The costs of runs whose SessionEnd reports wait in reports/ for the next plan, by run
// id. They are read, not claimed.
function waitingCosts(env) {
  const dir = reportsDir(env);
  const costs = [];
  if (!existsSync(dir)) return costs;
  for (const name of readdirSync(dir)) {
    const run = REPORT_NAME.exec(name)?.[3];
    if (!run) continue;
    let text;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const report = parseReport(text);
    if (report?.input.hook_event_name === "SessionEnd") costs.push(costLine(run, report, Date.now()));
  }
  return costs;
}

// Logs what a run cost from the result event of its stream, by session, for a caller that
// reads the stream. A run that keeps no transcript has no other record of its cost. The
// line says nothing of how the run was billed; spendSummary counts it only for an API
// run's session. An event without a session or a cost logs nothing.
export function logResultCost(event, env = process.env, at = Date.now()) {
  if (typeof event?.session_id !== "string" || !Number.isFinite(event.total_cost_usd)) return;
  appendJsonl(decisionLog(env), { at: new Date(at).toISOString(), mode: "cost", session: event.session_id, costUSD: event.total_cost_usd, source: "result" });
}

// API spend from the decision log's entries: per caller, per day (UTC) and in total, the
// API runs, the known cost and the runs whose cost is unknown. An unknown cost counts as
// unknown, never as $0: a run logged before costs were recorded has no run id, one that
// kept no transcript and whose caller logged no result cost has a null cost, and one whose
// report was not folded yet has none. A result cost (source "result") only fills a run's
// null cost through the session its report names, so each run counts once. A result cost
// that no API run's report names is not counted: it may be a subscription run's.
export function spendSummary(entries, { since = -Infinity } = {}) {
  const runCosts = new Map();
  const resultCosts = new Map();
  for (const entry of entries)
    if (entry.mode === "cost") {
      if (entry.source === "result") resultCosts.set(entry.session, entry.costUSD);
      else runCosts.set(entry.run, entry);
    }
  const costs = new Map([...runCosts].map(([run, line]) => [run, line.costUSD ?? resultCosts.get(line.session) ?? null]));
  const empty = () => ({ runs: 0, usd: 0, unknown: 0 });
  const total = { ...empty(), before: 0, untracked: 0, unreported: 0 };
  const byCaller = new Map();
  const byDay = new Map();
  for (const entry of entries) {
    if (entry.mode !== "api" || Date.parse(entry.at) < since) continue;
    const cost = entry.run === undefined ? undefined : costs.get(entry.run);
    const buckets = [total, ...[[byCaller, entry.caller ?? "(not logged)"], [byDay, entry.at.slice(0, 10)]]
      .map(([map, key]) => map.get(key) ?? map.set(key, empty()).get(key))];
    for (const bucket of buckets) {
      bucket.runs++;
      if (typeof cost === "number") bucket.usd += cost;
      else bucket.unknown++;
    }
    if (entry.run === undefined) total.before++;
    else if (cost === null) total.untracked++;
    else if (cost === undefined) total.unreported++;
  }
  const sorted = (map) => [...map].sort(([a], [b]) => a.localeCompare(b)).map(([key, bucket]) => ({ key, ...bucket }));
  return { total, byCaller: sorted(byCaller), byDay: sorted(byDay) };
}

const dollars = (usd) => `$${usd.toFixed(4)}`;

// The summary as text tables.
export function spendLines({ total, byCaller, byDay }, log) {
  const table = (title, rows) => {
    const width = Math.max(title.length, ...rows.map((row) => row.key.length));
    return [`${title.padEnd(width)}  runs  unknown  known cost`,
      ...rows.map((row) => `${row.key.padEnd(width)}  ${String(row.runs).padStart(4)}  ${String(row.unknown).padStart(7)}  ${dollars(row.usd).padStart(10)}`), ""];
  };
  return [`API spend logged in ${log}. Days are UTC.`,
    "Unknown costs are not counted as $0: a run without a logged cost is unknown, and the known cost is a lower bound while any run is unknown.", "",
    ...table("caller", byCaller), ...table("day", byDay),
    `Total: ${total.runs} API runs, known cost ${dollars(total.usd)}, ${total.unknown} unknown`
      + ` (${total.before} logged before costs were recorded, ${total.untracked} without a transcript to read, ${total.unreported} not reported yet).`];
}

const SPEND_USAGE = "usage: bun api-first.js spend [--days N]\n  API spend by caller and by day from decisions.jsonl; --days keeps the last N days.";

// `spend`: prints the summary of the log and of the reports waiting to be folded.
export function spend(argv, env = process.env) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, options: { days: { type: "string" }, help: { type: "boolean", default: false } } }));
  } catch (error) {
    console.error(`${error.message}\n${SPEND_USAGE}`);
    return 64;
  }
  if (values.help) {
    console.log(SPEND_USAGE);
    return 0;
  }
  const days = values.days === undefined ? undefined : Number(values.days);
  if (days !== undefined && !(Number.isInteger(days) && days > 0)) {
    console.error(`--days must be a whole number above 0\n${SPEND_USAGE}`);
    return 64;
  }
  const log = decisionLog(env);
  const since = days === undefined ? -Infinity : Date.now() - days * 86_400_000;
  console.log(spendLines(spendSummary([...readJsonl(log), ...waitingCosts(env)], { since }), log).join("\n"));
  return 0;
}

if (import.meta.main) {
  const [command, ...argv] = process.argv.slice(2);
  if (command === "spend") process.exit(spend(argv));
  if (command !== "plan") {
    console.error("usage: bun api-first.js plan <claude args>\n       bun api-first.js spend [--days N]");
    process.exit(64);
  }
  let result;
  try {
    result = await plan(argv);
  } catch (error) {
    console.error(`claude-api: ${error.message}`);
    process.exit(70);
  }
  if (result.mode !== "passthrough" || result.reason !== "not print mode") {
    const billed = result.mode === "api" ? { run: result.run, caller: caller() } : {};
    appendJsonl(decisionLog(), { at: new Date().toISOString(), mode: result.mode, reason: result.reason, cwd: process.cwd(), ...billed });
  }
  if (result.mode === "subscription") console.error(`claude-api: running on the subscription (${result.reason})`);
  // Three lines for the shell: the real claude, the mode, the merged settings.
  process.stdout.write(`${result.bin}\n${result.mode}\n${result.settings ?? ""}\n`);
}
