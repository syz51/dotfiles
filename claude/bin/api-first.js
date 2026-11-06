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

export const TTL_MS = { ok: 10 * 60 * 1000, exhausted: 30 * 60 * 1000, invalid: 30 * 60 * 1000, unknown: 60 * 1000 };
// The beta on Claude Code's main-loop requests. The API gates them on their own credit rule:
// a key whose plain Messages calls succeed can get "credit balance is too low" for the same
// request with this beta (credits that cannot be spent on Claude Code), so the check sends
// it too. A cached result counts only for the check that made it.
export const CLAUDE_CODE_BETA = "claude-code-20250219";
const CHECK = `messages+${CLAUDE_CODE_BETA}`;
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

// The caller's settings (a file path or JSON) with the key helper added; a caller's own
// apiKeyHelper is kept.
export function mergedSettings(value, helper) {
  const settings = value === undefined ? {} : JSON.parse(value.trim().startsWith("{") ? value : readFileSync(value, "utf8"));
  return JSON.stringify({ apiKeyHelper: helper, ...settings });
}

// ok: the key works and has credit for Claude Code. exhausted: out of credit (for Claude
// Code) or past a spend limit. invalid: the key was refused. unknown: the check could not tell.
export async function checkCredit(key, { baseUrl = "https://api.anthropic.com", fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  let status;
  let body;
  try {
    const response = await fetchImpl(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-beta": CLAUDE_CODE_BETA, "content-type": "application/json" },
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
  if ([400, 402].includes(status) && /credit balance|billing|insufficient|usage limit|spend limit/i.test(message)) return { status: "exhausted", detail };
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

// { mode: "api" | "subscription", reason }. A cached check counts only for the same key and
// check, within its status's interval; an inconclusive check leaves the run on the API,
// where Claude Code reports the error itself.
export async function decide({ env = process.env, now = Date.now(), check = checkCredit } = {}) {
  const file = keyFile(env);
  if (!existsSync(file)) return { mode: "subscription", reason: `no key file at ${file}` };
  const key = readFileSync(file, "utf8").trim();
  const keyHash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const dir = stateDir(env);
  const cached = readState(dir);
  let result;
  if (cached?.keyHash === keyHash && cached.check === CHECK && now - cached.checkedAt < (TTL_MS[cached.status] ?? 0)) result = { ...cached, cached: true };
  else {
    result = await check(key, env.API_FIRST_BASE_URL ? { baseUrl: env.API_FIRST_BASE_URL } : {});
    writeJsonAtomic(join(dir, "state.json"), { keyHash, check: CHECK, status: result.status, checkedAt: now, detail: result.detail });
  }
  const reason = `${result.status}${result.cached ? ` (checked ${new Date(result.checkedAt).toISOString()})` : ""}: ${result.detail}`;
  return { mode: ["ok", "unknown"].includes(result.status) ? "api" : "subscription", reason };
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
  const helper = `cat '${keyFile(env).replace(/'/g, "'\\''")}'`;
  return { bin, ...decision, settings: mergedSettings(settings, helper) };
}

if (import.meta.main) {
  const [command, ...argv] = process.argv.slice(2);
  if (command !== "plan") {
    console.error("usage: bun api-first.js plan <claude args>");
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
