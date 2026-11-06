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
// back: hooks merged into the same settings run `api-first.js report`, which records a run
// that the API refused for credit or the key (StopFailure: billing_error,
// authentication_failed), so later runs use the subscription, and clears that record after
// a run that went through (Stop). While the check keeps passing but runs keep being
// refused, each refusal keeps runs on the subscription twice as long as the last, up to
// MAX_BACKOFF_MS.
//
// Variables (named API_FIRST_* because callers strip CLAUDE_* from a child's environment):
//   API_FIRST_KEY_FILE   key file, default ~/.local/share/codex-skills/anthropic-api-key
//   API_FIRST_STATE      state folder, default ${XDG_STATE_HOME:-~/.local/state}/claude-api
//   API_FIRST_REAL_BIN   the real claude, default the first on PATH other than this wrapper
//   API_FIRST_BASE_URL   API base URL for the credit check (tests)
//   API_FIRST_DEPTH      nesting depth, set by claude-api; past MAX_DEPTH it stops a loop
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { appendJsonl, readJson, writeJsonAtomic } from "../factory/lib/state.js";

export const TTL_MS = { ok: 10 * 60 * 1000, exhausted: 30 * 60 * 1000, invalid: 30 * 60 * 1000, refused: 30 * 60 * 1000, unknown: 60 * 1000 };
export const MAX_BACKOFF_MS = 8 * 60 * 60 * 1000;
// Claude Code's StopFailure error types that mean this key cannot run Claude Code.
export const RUN_REFUSALS = { billing_error: "exhausted", authentication_failed: "invalid" };
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

// The caller's settings (a file path or JSON) with the key helper and the report hooks
// added after the caller's own hooks. A caller's own apiKeyHelper is kept, and then no
// report hooks are added: its runs say nothing about this key.
export function mergedSettings(value, helper, report) {
  const settings = value === undefined ? {} : JSON.parse(value.trim().startsWith("{") ? value : readFileSync(value, "utf8"));
  if (settings.apiKeyHelper !== undefined || report === undefined) return JSON.stringify({ apiKeyHelper: helper, ...settings });
  const hooks = { ...settings.hooks };
  for (const event of ["StopFailure", "Stop"]) hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: "command", command: report }] }];
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
  if (status === 401 || status === 403) return { status: "invalid", detail };
  if ([400, 402].includes(status) && /credit|billing|insufficient|usage limit|spend limit/i.test(message)) return { status: "exhausted", detail };
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

const hashOf = (key) => createHash("sha256").update(key).digest("hex").slice(0, 16);
const onApi = (status) => ["ok", "unknown"].includes(status);

// How long a state entry stands: its status's interval, doubled for each refusal a run
// reported in a row (state.refusals), up to MAX_BACKOFF_MS.
export function lifetime(state) {
  const base = TTL_MS[state.status] ?? 0;
  return state.source === "run" ? Math.min(base * 2 ** (state.refusals - 1), MAX_BACKOFF_MS) : base;
}

// The state entry for this key and check, or null when there is none.
function currentState(env) {
  const file = keyFile(env);
  if (!existsSync(file)) return { file, key: null, keyHash: null, cached: null };
  const key = readFileSync(file, "utf8").trim();
  const keyHash = hashOf(key);
  const cached = readState(stateDir(env));
  return { file, key, keyHash, cached: cached?.keyHash === keyHash && cached.check === CHECK ? cached : null };
}

// { mode: "api" | "subscription", reason }. A cached entry counts only for the same key and
// check, within its lifetime; an inconclusive check leaves the run on the API, where Claude
// Code reports the error itself. A passing check keeps the count of refusals that runs
// reported, so a refusal after it backs off further.
export async function decide({ env = process.env, now = Date.now(), check = checkCredit } = {}) {
  const { file, key, keyHash, cached } = currentState(env);
  if (key === null) return { mode: "subscription", reason: `no key file at ${file}` };
  let result;
  if (cached && now - cached.checkedAt < lifetime(cached)) result = { ...cached, cached: true };
  else {
    result = await check(key, env.API_FIRST_BASE_URL ? { baseUrl: env.API_FIRST_BASE_URL } : {});
    const refusals = onApi(result.status) ? cached?.refusals ?? 0 : 0;
    writeJsonAtomic(join(stateDir(env), "state.json"), { keyHash, check: CHECK, status: result.status, checkedAt: now, detail: result.detail, refusals });
  }
  const since = result.source === "run" ? "reported" : "checked";
  const reason = `${result.status}${result.cached ? ` (${since} ${new Date(result.checkedAt).toISOString()})` : ""}: ${result.detail}`;
  return { mode: onApi(result.status) ? "api" : "subscription", reason };
}

// A hook's report on an API run (the hook input Claude Code passes on stdin). A refusal for
// credit or the key moves later runs to the subscription; a run that went through clears
// the refusal count, and ends a refusal still standing (a run started before it), so the
// next run checks again. Returns the state written, or null when nothing changed.
export function recordRun(input, { env = process.env, now = Date.now() } = {}) {
  const { keyHash, cached } = currentState(env);
  if (keyHash === null) return null;
  const write = (state) => {
    writeJsonAtomic(join(stateDir(env), "state.json"), state);
    return state;
  };
  if (input.hook_event_name === "Stop") return cached?.refusals ? write({ ...cached, refusals: 0, ...(cached.source === "run" && { checkedAt: 0 }) }) : null;
  const status = RUN_REFUSALS[input.error];
  if (input.hook_event_name !== "StopFailure" || !status) return null;
  const message = String(input.last_assistant_message ?? "").slice(0, 200);
  return write({ keyHash, check: CHECK, status, checkedAt: now, source: "run", refusals: (cached?.refusals ?? 0) + 1,
    detail: `a Claude Code run was refused (${input.error}): ${message}` });
}

// The plan for argv: { bin, mode: "api" | "subscription" | "passthrough", settings, reason }.
// settings is the merged --settings value in API mode.
export async function plan(argv, { env = process.env, check } = {}) {
  const depth = Number(env.API_FIRST_DEPTH ?? 0);
  if (depth > MAX_DEPTH) throw new Error(`nested ${depth} deep, which means a loop; set API_FIRST_REAL_BIN to the real claude`);
  const bin = realClaude(env);
  const { print, settings } = readArgs(argv);
  if (!print) return { bin, mode: "passthrough", reason: "not print mode" };
  const own = OWN_AUTH.filter((name) => env[name]);
  if (own.length) return { bin, mode: "passthrough", reason: `caller set ${own.join(", ")}` };
  const decision = await decide({ env, check });
  if (decision.mode === "subscription") return { bin, ...decision };
  const helper = `cat ${quote(keyFile(env))}`;
  const report = `${quote(process.execPath)} ${quote(join(import.meta.dir, "api-first.js"))} report`;
  return { bin, ...decision, settings: mergedSettings(settings, helper, report) };
}

const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;

if (import.meta.main) {
  const [command, ...argv] = process.argv.slice(2);
  if (command === "report") {
    // A hook: Claude Code ignores StopFailure output, and Stop output must stay empty.
    const state = recordRun(JSON.parse(await Bun.stdin.text()));
    if (state?.source === "run")
      appendJsonl(join(stateDir(), "decisions.jsonl"), { at: new Date().toISOString(), mode: "refused", reason: `${state.status}: ${state.detail}`, cwd: process.cwd() });
    process.exit(0);
  }
  if (command !== "plan") {
    console.error("usage: bun api-first.js plan <claude args> | report < hook-input.json");
    process.exit(64);
  }
  let result;
  try {
    result = await plan(argv);
  } catch (error) {
    console.error(`claude-api: ${error.message}`);
    process.exit(70);
  }
  if (result.mode !== "passthrough" || result.reason !== "not print mode")
    appendJsonl(join(stateDir(), "decisions.jsonl"), { at: new Date().toISOString(), mode: result.mode, reason: result.reason, cwd: process.cwd() });
  if (result.mode === "subscription") console.error(`claude-api: running on the subscription (${result.reason})`);
  // Three lines for the shell: the real claude, the mode, the merged settings.
  process.stdout.write(`${result.bin}\n${result.mode}\n${result.settings ?? ""}\n`);
}
