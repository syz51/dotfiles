// The API-first wrapper: its planner (claude/bin/api-first.js) and the shell script that
// replaces itself with the real claude (claude/bin/claude-api).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyReport, caller, callerName, checkCredit, decide, lifetime, MAX_BACKOFF_MS, MAX_DEPTH, mergedSettings, parseReport, plan, readArgs, readSettings,
  realClaude, runCost, spendLines, spendSummary, TTL_MS,
} from "../bin/api-first.js";

const WRAPPER = join(import.meta.dir, "..", "bin", "claude-api");
const SHIM = join(import.meta.dir, "..", "bin", "api-first");
const roots = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

let root;
let env;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claude-api-test-"));
  roots.push(root);
  writeFileSync(join(root, "key"), "sk-test-key\n", { mode: 0o600 });
  env = { HOME: root, PATH: "/usr/bin:/bin", API_FIRST_KEY_FILE: join(root, "key"), API_FIRST_STATE: join(root, "state") };
});

const response = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const statusOf = (status) => async () => ({ status, detail: status });
// The API as observed on 2026-11-06: plain Messages calls succeed, but a request carrying
// Claude Code's beta is refused for credit, whether or not Claude Code's own requests are.
const LOW_CREDIT = { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } };
// The hook input Claude Code passes when the API refuses a run for credit, and when a turn
// ends normally (Claude Code 2.1.318).
const refusedRun = { hook_event_name: "StopFailure", error: "billing_error", last_assistant_message: "Credit balance is too low" };
const finishedRun = { hook_event_name: "Stop", stop_hook_active: false };
// The hook input of a print run's SessionEnd, and the cost-state line Claude Code writes to
// the transcript as the run exits, before SessionEnd (both recorded from 2.1.319, with the
// ids and figures replaced). A resumed run adds a line with the session's new total.
const SESSION = "11111111-2222-3333-4444-555555555555";
const sessionEnd = (transcript, sessionId = SESSION) => ({ session_id: sessionId, transcript_path: transcript, cwd: "/work", prompt_id: "p1", hook_event_name: "SessionEnd", reason: "other" });
const costState = (totalCostUSD, sessionId = SESSION) => ({
  type: "cost-state", sessionId, totalCostUSD, totalAPIDuration: 1830, totalAPIDurationWithoutRetries: 1830, totalToolDuration: 0, totalLinesAdded: 0,
  totalLinesRemoved: 0, totalDuration: 2950, startTime: 1794122198767, hasUnknownModelCost: false,
  modelUsage: { "claude-haiku-5-5": { inputTokens: 10, outputTokens: 5, thinkingTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 0, webSearchRequests: 0, costUSD: totalCostUSD } },
});
const assistantLine = { parentUuid: null, isSidechain: false, type: "assistant", sessionId: SESSION, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } };
function transcript(lines, name = "transcript.jsonl") {
  const file = join(root, name);
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return file;
}
const KEY_HASH = createHash("sha256").update("sk-test-key").digest("hex").slice(0, 16);
// Leaves a report as the hook does, written at `at`.
let reportPid = 0;
// A run id names the run it reports for; reports from before costs were recorded have none.
function report(input, { plannedAt = 0, at = Date.now(), keyHash = KEY_HASH, run } = {}) {
  const dir = join(root, "state", "reports");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${plannedAt}-${keyHash}${run ? `-r${run}` : ""}-${++reportPid}.json`);
  writeFileSync(file, typeof input === "string" ? input : JSON.stringify(input));
  utimesSync(file, at / 1000, at / 1000);
}
const state = () => JSON.parse(readFileSync(join(root, "state", "state.json"), "utf8"));
const loggedModes = () => readFileSync(join(root, "state", "decisions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const claudeCodeGated = (headers) => String(headers["anthropic-beta"] ?? "").split(",").includes("claude-code-20250219") ? response(400, LOW_CREDIT) : response(200, {});

describe("arguments and settings", () => {
  test("print mode and the last --settings are read before a -- marker only", () => {
    expect(readArgs(["-p", "--settings", "a", "--settings=b", "x"])).toEqual({ print: true, settings: "b" });
    expect(readArgs(["--print", "--", "--settings", "c", "-p"])).toEqual({ print: true, settings: undefined });
    expect(readArgs(["--", "-p"])).toEqual({ print: false, settings: undefined });
    expect(readArgs(["--version"]).print).toBe(false);
  });

  test("the key helper is merged into the caller's settings, inline or from a file", () => {
    const file = join(root, "s.json");
    writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [] } }));
    const merged = (value) => JSON.parse(mergedSettings(readSettings(value), "h"));
    expect(merged(undefined)).toEqual({ apiKeyHelper: "h" });
    expect(merged('{"permissions":{"deny":["WebFetch"]}}')).toEqual({ apiKeyHelper: "h", permissions: { deny: ["WebFetch"] } });
    expect(merged(file)).toEqual({ apiKeyHelper: "h", hooks: { PreToolUse: [] } });
    expect(merged('{"apiKeyHelper":"mine"}').apiKeyHelper).toBe("mine");
  });

  test("the report hooks follow the caller's own, and a caller's own key helper gets none", () => {
    const own = { hooks: [{ type: "command", command: "mine" }] };
    const reports = { StopFailure: "r", Stop: "r", SessionEnd: "c" };
    const merged = JSON.parse(mergedSettings({ hooks: { Stop: [own], PreToolUse: [own] } }, "h", reports));
    const hook = (command) => ({ hooks: [{ type: "command", command }] });
    expect(merged).toEqual({ apiKeyHelper: "h", hooks: { Stop: [own, hook("r")], StopFailure: [hook("r")], SessionEnd: [hook("c")], PreToolUse: [own] } });
    expect(JSON.parse(mergedSettings({ apiKeyHelper: "mine" }, "h", reports))).toEqual({ apiKeyHelper: "mine" });
  });
});

describe("credit check", () => {
  const check = (status, body) => checkCredit("k", { fetchImpl: async () => response(status, body) });

  test("classifies the API's answer, spend limits included", async () => {
    expect((await check(200, {})).status).toBe("ok");
    expect((await check(401, { error: { message: "invalid x-api-key" } })).status).toBe("invalid");
    expect((await check(400, { error: { message: "Your credit balance is too low to access the Anthropic API." } })).status).toBe("exhausted");
    expect((await check(400, { error: { message: "You have reached your specified API usage limits." } })).status).toBe("exhausted");
    expect((await check(402, { error: { message: "billing problem" } })).status).toBe("exhausted");
    expect((await check(400, { error: { message: "This organization has been disabled." } })).status).toBe("refused");
    // A page from something other than the API, such as a proxy's, is no answer about the key.
    for (const status of [400, 401, 402, 403]) expect((await check(status, "<html>Bad Request</html>")).status).toBe("unknown");
    expect((await check(402, { error: { message: "payment required" } })).status).toBe("refused");
    for (const status of [404, 408, 409, 429, 500, 529]) expect((await check(status, { error: { message: "x" } })).status).toBe("unknown");
  });

  test("a failed request or a body that cannot be read is inconclusive, not a crash", async () => {
    expect((await checkCredit("k", { fetchImpl: async () => { throw new Error("offline"); } })).status).toBe("unknown");
    const stalled = { status: 200, text: async () => { throw new Error("The operation timed out."); } };
    expect(await checkCredit("k", { fetchImpl: async () => stalled })).toEqual({ status: "unknown", detail: "request failed: The operation timed out." });
  });

  test("sends the key in a header and asks for one token of Haiku, a plain request", async () => {
    let seen;
    await checkCredit("sk-x", { baseUrl: "http://fake", fetchImpl: async (url, init) => { seen = { url, init }; return response(200, {}); } });
    expect(seen.url).toBe("http://fake/v1/messages");
    expect(seen.init.headers["x-api-key"]).toBe("sk-x");
    expect(JSON.parse(seen.init.body)).toEqual({ model: "claude-haiku-5-5", max_tokens: 1, messages: [{ role: "user", content: "ok" }] });
  });

  test("the check does not pose as Claude Code, which the API refuses for credit even when Claude Code is served", async () => {
    let headers;
    const result = await checkCredit("k", { fetchImpl: async (url, init) => { headers = init.headers; return claudeCodeGated(init.headers); } });
    expect(result.status).toBe("ok");
    expect(headers).not.toHaveProperty("anthropic-beta");
  });
});

describe("decision", () => {
  const counting = (status) => {
    const calls = [];
    return { calls, check: async (key) => { calls.push(key); return { status, detail: status }; } };
  };

  test("without a key file, the subscription, without a check", async () => {
    const { calls, check } = counting("ok");
    rmSync(join(root, "key"));
    expect((await decide({ env, check })).mode).toBe("subscription");
    expect(calls).toHaveLength(0);
  });

  test("each status is cached for its interval, inconclusive ones briefly", async () => {
    for (const [status, mode] of [["ok", "api"], ["exhausted", "subscription"], ["invalid", "subscription"], ["refused", "subscription"], ["unknown", "api"]]) {
      rmSync(join(root, "state"), { recursive: true, force: true });
      const { calls, check } = counting(status);
      const now = Date.now();
      expect((await decide({ env, now, check })).mode).toBe(mode);
      expect((await decide({ env, now: now + TTL_MS[status] - 1, check })).mode).toBe(mode);
      expect(calls).toHaveLength(1);
      await decide({ env, now: now + TTL_MS[status] + 1, check });
      expect(calls).toHaveLength(2);
    }
  });

  test("a cached result belongs to its key; a new key is checked again", async () => {
    const { calls, check } = counting("invalid");
    expect((await decide({ env, check })).mode).toBe("subscription");
    writeFileSync(join(root, "key"), "sk-new-key\n");
    await decide({ env, check });
    expect(calls).toEqual(["sk-test-key", "sk-new-key"]);
  });

  test("a result cached by an earlier kind of check is checked again", async () => {
    // The first check wrote no `check` field; the next sent Claude Code's beta, and its
    // "exhausted" held for keys Claude Code could use. Same key, fresh entry: only `check`
    // differs.
    const now = Date.now();
    expect((await decide({ env, now, check: statusOf("exhausted") })).mode).toBe("subscription");
    const file = join(root, "state", "state.json");
    const { check: _, ...old } = JSON.parse(readFileSync(file, "utf8"));
    const { calls, check } = counting("ok");
    for (const entry of [old, { ...old, check: "messages+claude-code-20250219" }]) {
      writeFileSync(file, JSON.stringify(entry));
      expect((await decide({ env, now: now + 1, check })).mode).toBe("api");
    }
    expect(calls).toHaveLength(2);
  });

  test("a run the API refuses moves later runs to the subscription without a check", async () => {
    const now = Date.now();
    const { calls, check } = counting("ok");
    await decide({ env, now, check });
    report(refusedRun, { plannedAt: now, at: now + 1 });
    const decision = await decide({ env, now: now + 2, check });
    expect(decision.mode).toBe("subscription");
    expect(decision.reason).toContain("(reported ");
    expect(decision.reason).toContain("a Claude Code run was refused (billing_error): Credit balance is too low");
    expect(calls).toHaveLength(1);
    expect(state()).toMatchObject({ status: "exhausted", source: "run", refusals: 1, checkedAt: now + 1 });
    expect(loggedModes().at(-1)).toMatchObject({ at: new Date(now + 1).toISOString(), mode: "refused" });
    expect(readdirSync(join(root, "state", "reports"))).toEqual([]);
  });

  test("refusals for credit or the key count, other run endings do not", () => {
    const at = 1_000;
    const run = (input, previous = null) => applyReport(previous, { input, keyHash: "k", plannedAt: 0, at });
    expect(run(refusedRun)).toMatchObject({ status: "exhausted", refusals: 1 });
    expect(run({ ...refusedRun, error: "authentication_failed" })).toMatchObject({ status: "invalid", refusals: 1 });
    const ok = { keyHash: "k", check: "messages", status: "ok", checkedAt: 0, refusals: 0 };
    for (const input of [{ ...refusedRun, error: "rate_limit" }, { ...refusedRun, error: "server_error" }, { ...refusedRun, error: "model_not_found" }, { hook_event_name: "SessionEnd" }])
      expect(run(input, ok)).toBe(ok);
  });

  test("while the check passes but runs are refused, each refusal stands twice as long, up to a cap", async () => {
    let now = Date.now();
    const { calls, check } = counting("ok");
    const spans = [];
    for (let round = 1; round <= 6; round++) {
      await decide({ env, now, check });
      report(refusedRun, { plannedAt: now, at: now });
      expect((await decide({ env, now, check })).mode).toBe("subscription");
      expect(state().refusals).toBe(round);
      spans.push(lifetime(state()));
      expect((await decide({ env, now: now + lifetime(state()) - 1, check })).mode).toBe("subscription");
      now += lifetime(state());
    }
    const base = TTL_MS.exhausted;
    expect(spans).toEqual([base, 2 * base, 4 * base, 8 * base, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
    expect(calls).toHaveLength(6);
  });

  test("a refusal for another reason while one stands is recorded", async () => {
    const now = Date.now();
    await decide({ env, now, check: statusOf("ok") });
    report(refusedRun, { plannedAt: now, at: now + 1 });
    report({ ...refusedRun, error: "authentication_failed" }, { plannedAt: now, at: now + 2 });
    expect((await decide({ env, now: now + 3, check: statusOf("ok") })).reason).toStartWith("invalid ");
    expect(state()).toMatchObject({ status: "invalid", refusals: 2, checkedAt: now + 2 });
    expect(loggedModes().filter((entry) => entry.mode === "refused")).toHaveLength(2);
  });

  test("runs refused together count once", async () => {
    const now = Date.now();
    await decide({ env, now, check: statusOf("ok") });
    for (let index = 1; index <= 4; index++) report(refusedRun, { plannedAt: now, at: now + index });
    expect((await decide({ env, now: now + 5, check: statusOf("ok") })).mode).toBe("subscription");
    expect(state()).toMatchObject({ refusals: 1, checkedAt: now + 1 });
    expect(loggedModes().filter((entry) => entry.mode === "refused")).toHaveLength(1);
  });

  test("a run that went through clears the count, but not a refusal that stands, nor after a later check", async () => {
    const now = Date.now();
    const { calls, check } = counting("ok");
    await decide({ env, now, check });
    report(refusedRun, { plannedAt: now, at: now });
    // A run planned before the refusal finishes on the API; the refusal stands.
    report(finishedRun, { plannedAt: now - 100, at: now + 1 });
    expect((await decide({ env, now: now + 2, check })).mode).toBe("subscription");
    expect(state()).toMatchObject({ source: "run", refusals: 1 });
    // The refusal runs out; the check passes and keeps the count.
    const later = now + TTL_MS.exhausted;
    expect((await decide({ env, now: later, check })).mode).toBe("api");
    expect(state()).toMatchObject({ status: "ok", refusals: 1 });
    // A run planned before that check proves nothing about it; one planned after does.
    report(finishedRun, { plannedAt: now, at: later + 1 });
    await decide({ env, now: later + 2, check });
    expect(state().refusals).toBe(1);
    report(finishedRun, { plannedAt: later, at: later + 3 });
    await decide({ env, now: later + 4, check });
    expect(state().refusals).toBe(0);
    expect(calls).toHaveLength(2);
    expect(loggedModes().filter((entry) => entry.mode === "refused")).toHaveLength(1);
  });

  test("a refusal reported while the check runs stands", async () => {
    const now = Date.now();
    const check = async () => {
      report(refusedRun, { plannedAt: now - 1, at: now });
      return { status: "ok", detail: "HTTP 200" };
    };
    expect((await decide({ env, now, check })).mode).toBe("subscription");
    expect(state()).toMatchObject({ status: "exhausted", source: "run" });
  });

  test("reports for another key, damaged ones and leftovers of cut-off hooks are dropped", async () => {
    const now = Date.now();
    report(refusedRun, { keyHash: "0123456789abcdef", at: now });
    report("{cut off", { at: now });
    for (const input of ["null", "[1]", '"text"', "7"]) report(input, { at: now });
    const dir = join(root, "state", "reports");
    const old = (now - 2 * 3600_000) / 1000;
    writeFileSync(join(dir, ".old-partial"), "{");
    utimesSync(join(dir, ".old-partial"), old, old);
    mkdirSync(join(dir, ".old-folder"));
    writeFileSync(join(dir, ".old-folder", "x"), "");
    utimesSync(join(dir, ".old-folder"), old, old);
    writeFileSync(join(dir, ".writing-now"), "{");
    expect((await decide({ env, now, check: statusOf("ok") })).mode).toBe("api");
    expect(readdirSync(dir)).toEqual([".writing-now"]);
  });

  test("a plan waits for another plan's lock on the state, and takes over one left by a plan that died", async () => {
    const lock = join(root, "state", "state.lock");
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(lock, "1");
    // Another process holds the lock for 300 ms; decide blocks this one meanwhile.
    const holder = Bun.spawn(["/bin/sh", "-c", `sleep 0.3; rm -f '${lock}'`]);
    let started = Date.now();
    expect((await decide({ env, check: statusOf("ok") })).mode).toBe("api");
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    await holder.exited;
    writeFileSync(lock, "1");
    const stale = (Date.now() - 3000) / 1000;
    utimesSync(lock, stale, stale);
    started = Date.now();
    expect((await decide({ env, now: Date.now() + TTL_MS.ok, check: statusOf("ok") })).mode).toBe("api");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(existsSync(lock)).toBe(false);
  });

  test("plans running together lose no refusal", async () => {
    const script = join(root, "decide.js");
    const module = join(import.meta.dir, "..", "bin", "api-first.js");
    writeFileSync(script, `import { decide } from ${JSON.stringify(module)};\nawait decide({ env: JSON.parse(process.argv[2]), check: async () => ({ status: "ok", detail: "HTTP 200" }) });\n`);
    const now = Date.now();
    await decide({ env, now, check: statusOf("ok") });
    report(refusedRun, { plannedAt: now, at: now + 1 });
    const runs = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, script, JSON.stringify(env)], { stderr: "pipe" }));
    expect(await Promise.all(runs.map((run) => run.exited))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(state()).toMatchObject({ source: "run", refusals: 1 });
  });

  test("a damaged state file means a fresh check", async () => {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "state.json"), "{bad");
    const { calls, check } = counting("ok");
    expect((await decide({ env, check })).mode).toBe("api");
    expect(calls).toHaveLength(1);
  });
});

describe("plan", () => {
  const fakeBin = () => {
    const dir = join(root, "bin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "claude"), "#!/bin/sh\n");
    chmodSync(join(dir, "claude"), 0o755);
    return dir;
  };

  test("finds the real claude past the shim, also through a link to the checkout", () => {
    const dir = fakeBin();
    expect(realClaude({ PATH: `${SHIM}:${dir}` })).toBe(join(dir, "claude"));
    const link = join(root, "linked-bin");
    symlinkSync(join(SHIM, ".."), link);
    expect(realClaude({ PATH: `${join(link, "api-first")}:${dir}` })).toBe(join(dir, "claude"));
    expect(realClaude({ PATH: dir, API_FIRST_REAL_BIN: "/x/claude" })).toBe("/x/claude");
    expect(() => realClaude({ PATH: join(link, "api-first") })).toThrow("no claude executable");
  });

  test("passes through runs that are not print mode or that bring their own auth, in the environment or their settings", async () => {
    const base = { ...env, PATH: fakeBin() };
    expect((await plan(["--version"], { env: base, check: statusOf("ok") })).mode).toBe("passthrough");
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) {
      for (const [args, environment] of [[["-p", "x"], { ...base, [name]: "set" }], [["-p", "x", "--settings", JSON.stringify({ env: { [name]: "set" } })], base]]) {
        const result = await plan(args, { env: environment, check: statusOf("ok") });
        expect([result.mode, result.reason, result.settings]).toEqual(["passthrough", `caller set ${name}`, undefined]);
      }
    }
  });

  test("settings it cannot read pass through, for Claude Code to report", async () => {
    const base = { ...env, PATH: fakeBin() };
    for (const value of ["{bad", join(root, "missing.json"), root]) {
      const result = await plan(["-p", "x", "--settings", value], { env: base, check: statusOf("ok") });
      expect(result.mode).toBe("passthrough");
      expect(result.reason).toStartWith("unreadable --settings: ");
    }
  });

  test("a caller retrying a refused run asks for the subscription, without a check", async () => {
    const base = { ...env, PATH: fakeBin(), API_FIRST_SUBSCRIPTION: "1" };
    const calls = [];
    const check = async (key) => { calls.push(key); return { status: "ok", detail: "HTTP 200" }; };
    const result = await plan(["-p", "x"], { env: base, check });
    expect([result.mode, result.settings, calls.length]).toEqual(["subscription", undefined, 0]);
    // A caller's own auth still passes through.
    expect((await plan(["-p", "x"], { env: { ...base, ANTHROPIC_API_KEY: "k" }, check })).mode).toBe("passthrough");
  });

  test("API mode carries the merged settings; the subscription carries none", async () => {
    const base = { ...env, PATH: fakeBin() };
    const api = await plan(["-p", "x", "--settings", '{"a":1}'], { env: base, check: statusOf("ok") });
    expect(api.mode).toBe("api");
    const settings = JSON.parse(api.settings);
    expect(settings).toMatchObject({ apiKeyHelper: `cat '${join(root, "key")}'`, a: 1 });
    expect(Object.keys(settings.hooks).sort()).toEqual(["SessionEnd", "Stop", "StopFailure"]);
    expect(api.run).toMatch(/^[0-9a-f]{12}$/);
    rmSync(join(root, "state"), { recursive: true, force: true });
    const fallback = await plan(["-p", "x"], { env: base, check: statusOf("exhausted") });
    expect([fallback.mode, fallback.settings]).toEqual(["subscription", undefined]);
  });

  test("the report hook in the settings runs as given, without bun, and its report is folded into the next plan", async () => {
    // A state folder with a quote and a space, to show the command quotes it.
    const base = { ...env, PATH: "/usr/bin:/bin", API_FIRST_REAL_BIN: "/x/claude", API_FIRST_STATE: join(root, "it's state") };
    const now = Date.now();
    const { hooks } = JSON.parse((await plan(["-p", "x"], { env: base, check: statusOf("ok"), now })).settings);
    expect(hooks.Stop).toEqual(hooks.StopFailure);
    const command = hooks.StopFailure[0].hooks[0].command;
    expect(command).not.toContain("bun");
    const proc = Bun.spawn(["/bin/sh", "-c", command], { env: { PATH: "/usr/bin:/bin" }, stdin: new Blob([JSON.stringify(refusedRun)]), stdout: "pipe", stderr: "pipe" });
    expect([await proc.exited, await new Response(proc.stdout).text(), await new Response(proc.stderr).text()]).toEqual([0, "", ""]);
    const reports = readdirSync(join(root, "it's state", "reports"));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(new RegExp(`^${now}-${KEY_HASH}-r[0-9a-f]{12}-\\d+\\.json$`));
    expect((await plan(["-p", "x"], { env: base, check: statusOf("ok") })).mode).toBe("subscription");
    expect(existsSync(join(root, "it's state", "reports", reports[0]))).toBe(false);
    // A report that cannot be saved fails quietly with exit 0, which never blocks a Stop.
    rmSync(join(root, "it's state"), { recursive: true });
    const failing = Bun.spawn(["/bin/sh", "-c", command], { env: { PATH: "/usr/bin:/bin" }, stdin: new Blob(["{}"]), stdout: "pipe", stderr: "pipe" });
    expect([await failing.exited, await new Response(failing.stdout).text(), await new Response(failing.stderr).text()]).toEqual([0, "", ""]);
  });

  test("past the nesting limit it stops", async () => {
    await expect(plan(["-p", "x"], { env: { ...env, PATH: fakeBin(), API_FIRST_DEPTH: String(MAX_DEPTH + 1) } })).rejects.toThrow("loop");
  });
});

describe("costs", () => {
  test("a run's cost is its session's last total, less the one a resumed session carried over", () => {
    expect(runCost(sessionEnd("t"), [costState(0.25)])).toEqual({ costUSD: 0.25 });
    expect(runCost(sessionEnd("t"), [costState(0.1), costState(0.35)]).costUSD).toBeCloseTo(0.25, 10);
    // Another session's line, and a total lower than the one before, which no carry-over explains.
    expect(runCost(sessionEnd("t"), [costState(9, "other"), costState(0.2)])).toEqual({ costUSD: 0.2 });
    expect(runCost(sessionEnd("t"), [costState(0.5), costState(0.2)])).toEqual({ costUSD: 0.2 });
    const none = runCost(sessionEnd("t"), [undefined, { type: "cost-state", sessionId: SESSION, totalCostUSD: "1" }]);
    expect(none.costUSD).toBeNull();
    expect(none.detail).toContain("--no-session-persistence");
  });

  test("a report is its hook input, then any JSON lines; a damaged input is no report", () => {
    expect(parseReport(JSON.stringify(finishedRun))).toEqual({ input: finishedRun, lines: [] });
    expect(parseReport(`${JSON.stringify(sessionEnd("t"))}\n\n${JSON.stringify(costState(1))}\n{cut\n`)).toEqual({ input: sessionEnd("t"), lines: [costState(1), undefined] });
    for (const text of ["{cut off", "", "null", "[1]", `7\n${JSON.stringify(costState(1))}`]) expect(parseReport(text)).toBeNull();
  });

  test("the SessionEnd hook adds the transcript's cost, and the next plan logs it under the run", async () => {
    const base = { ...env, API_FIRST_REAL_BIN: "/x/claude" };
    const first = await plan(["-p", "x"], { env: base, check: statusOf("ok") });
    const command = JSON.parse(first.settings).hooks.SessionEnd[0].hooks[0].command;
    expect(command).not.toContain("bun");
    // A resumed session: the earlier run left 0.1, this one ends at 0.35.
    const file = transcript([assistantLine, costState(0.1), assistantLine, costState(0.35)]);
    const proc = Bun.spawn(["/bin/sh", "-c", command], { env: { PATH: "/usr/bin:/bin" }, stdin: new Blob([JSON.stringify(sessionEnd(file))]), stdout: "pipe", stderr: "pipe" });
    expect([await proc.exited, await new Response(proc.stdout).text(), await new Response(proc.stderr).text()]).toEqual([0, "", ""]);
    const dir = join(root, "state", "reports");
    const [name] = readdirSync(dir);
    expect(name).toMatch(new RegExp(`-r${first.run}-\\d+\\.json$`));
    expect(parseReport(readFileSync(join(dir, name), "utf8"))).toEqual({ input: sessionEnd(file), lines: [costState(0.1), costState(0.35)] });
    expect((await plan(["-p", "x"], { env: base, check: statusOf("ok") })).mode).toBe("api");
    const logged = loggedModes();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ mode: "cost", run: first.run, session: SESSION });
    expect(logged[0].costUSD).toBeCloseTo(0.25, 10);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a run without a transcript is logged with an unknown cost, and its report still saves", async () => {
    const base = { ...env, API_FIRST_REAL_BIN: "/x/claude" };
    const first = await plan(["-p", "x"], { env: base, check: statusOf("ok") });
    const command = JSON.parse(first.settings).hooks.SessionEnd[0].hooks[0].command;
    const proc = Bun.spawn(["/bin/sh", "-c", command], { env: { PATH: "/usr/bin:/bin" }, stdin: new Blob([JSON.stringify(sessionEnd(join(root, "missing.jsonl")))]) });
    expect(await proc.exited).toBe(0);
    await plan(["-p", "x"], { env: base, check: statusOf("ok") });
    expect(loggedModes()).toEqual([expect.objectContaining({ mode: "cost", run: first.run, costUSD: null })]);
  });

  test("a SessionEnd report from before costs were recorded, without a run id, is dropped", async () => {
    report(sessionEnd(transcript([costState(1)])));
    await decide({ env, check: statusOf("ok") });
    expect(existsSync(join(root, "state", "decisions.jsonl"))).toBe(false);
    expect(readdirSync(join(root, "state", "reports"))).toEqual([]);
  });
});

describe("callers", () => {
  test("a caller is named by its script's folder and name, its module, or its program", () => {
    expect(callerName("/opt/bun/bin/bun test claude/tests/live.test.js")).toBe("tests/live.test.js");
    expect(callerName("bun /home/u/.claude/factory/cli.js weekly --pr")).toBe("factory/cli.js");
    expect(callerName("uv run python research/masters.py --limit 3")).toBe("research/masters.py");
    expect(callerName("python3 -m research.batch --all")).toBe("research.batch");
    expect(callerName("/bin/zsh -c claude-api -p hi")).toBe("zsh");
  });

  test("API_FIRST_CALLER names the caller, else the process API_FIRST_CALLER_PID", () => {
    expect(caller({ API_FIRST_CALLER: "masters", API_FIRST_CALLER_PID: String(process.pid) })).toBe("masters");
    const own = spawnSync("ps", ["-o", "command=", "-p", String(process.pid)], { encoding: "utf8" }).stdout;
    expect(caller({ API_FIRST_CALLER_PID: String(process.pid) })).toBe(callerName(own));
    expect(caller({})).toBeNull();
    expect(caller({ API_FIRST_CALLER_PID: "1; rm -rf /" })).toBeNull();
  });
});

describe("spend", () => {
  // A log as the planner writes it: a run from before costs were recorded, runs with a
  // cost, one without a transcript, one not reported yet, and lines that are not API runs.
  const LOG = [
    { at: "2026-11-07T08:00:00.000Z", mode: "api", reason: "ok: HTTP 200", cwd: "/w" },
    { at: "2026-11-07T09:00:00.000Z", mode: "api", reason: "ok: HTTP 200", cwd: "/w", run: "a1", caller: "tests/live.test.js" },
    { at: "2026-11-07T09:05:00.000Z", mode: "cost", run: "a1", session: "s1", costUSD: 0.5 },
    { at: "2026-11-08T01:00:00.000Z", mode: "api", reason: "ok: HTTP 200", cwd: "/w", run: "b2", caller: "research/masters.py" },
    { at: "2026-11-08T01:00:00.000Z", mode: "api", reason: "ok: HTTP 200", cwd: "/w", run: "c3", caller: "research/masters.py" },
    { at: "2026-11-08T01:10:00.000Z", mode: "cost", run: "b2", session: "s2", costUSD: 1.25 },
    { at: "2026-11-08T01:11:00.000Z", mode: "cost", run: "c3", session: "s3", costUSD: null, detail: "no cost-state line" },
    { at: "2026-11-08T02:00:00.000Z", mode: "api", reason: "ok: HTTP 200", cwd: "/w", run: "d4", caller: "tests/live.test.js" },
    { at: "2026-11-08T03:00:00.000Z", mode: "subscription", reason: "exhausted: HTTP 400", cwd: "/w" },
    { at: "2026-11-08T03:00:00.000Z", mode: "refused", reason: "exhausted: a Claude Code run was refused", cwd: "/w" },
  ];

  test("sums API runs by caller and day, and counts unknown costs apart, never as $0", () => {
    const summary = spendSummary(LOG);
    expect(summary.total).toEqual({ runs: 5, usd: 1.75, unknown: 3, before: 1, untracked: 1, unreported: 1 });
    expect(summary.byCaller).toEqual([
      { key: "(not logged)", runs: 1, usd: 0, unknown: 1 },
      { key: "research/masters.py", runs: 2, usd: 1.25, unknown: 1 },
      { key: "tests/live.test.js", runs: 2, usd: 0.5, unknown: 1 },
    ]);
    expect(summary.byDay).toEqual([{ key: "2026-11-07", runs: 2, usd: 0.5, unknown: 1 }, { key: "2026-11-08", runs: 3, usd: 1.25, unknown: 2 }]);
    expect(spendSummary(LOG, { since: Date.parse("2026-11-08T00:00:00Z") }).total).toMatchObject({ runs: 3, usd: 1.25, unknown: 2 });
    const text = spendLines(summary, "log").join("\n");
    expect(text).toContain("Unknown costs are not counted as $0");
    expect(text).toContain("Total: 5 API runs, known cost $1.7500, 3 unknown (1 logged before costs were recorded, 1 without a transcript to read, 1 not reported yet).");
  });

  test("the spend command prints the log, with the costs still waiting in reports/", () => {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "decisions.jsonl"), LOG.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    // Run d4's SessionEnd report, not yet folded by a plan.
    report(`${JSON.stringify(sessionEnd("t", "s4"))}\n${JSON.stringify(costState(0.1, "s4"))}`, { run: "d4" });
    const module = join(import.meta.dir, "..", "bin", "api-first.js");
    const run = (...args) => spawnSync(process.execPath, [module, "spend", ...args], { env: { ...env, PATH: process.env.PATH }, encoding: "utf8" });
    const result = run();
    expect([result.status, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toContain(`API spend logged in ${join(root, "state", "decisions.jsonl")}. Days are UTC.`);
    expect(result.stdout).toMatch(/^tests\/live\.test\.js +2 +0 +\$0\.6000$/m);
    expect(result.stdout).toMatch(/^2026-11-08 +3 +1 +\$1\.3500$/m);
    expect(result.stdout).toContain("Total: 5 API runs, known cost $1.8500, 2 unknown (1 logged before costs were recorded, 1 without a transcript to read, 0 not reported yet).");
    // Reading does not claim the report; the next plan folds it.
    expect(readdirSync(join(root, "state", "reports"))).toHaveLength(1);
    expect(run("--days", "0").status).toBe(64);
    expect(run("--bogus").status).toBe(64);
  });
});

describe("end to end", () => {
  // A fake claude that records its argv, its process id and whether a key variable
  // reached it, then exits with FAKE_EXIT.
  function fakeClaude() {
    const dir = join(root, "real");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "claude"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(root, "argv.txt")}"\necho $$ > "${join(root, "pid.txt")}"\n[ -n "\${ANTHROPIC_API_KEY:-}" ] && echo visible > "${join(root, "key-env.txt")}"\n[ -n "\${FAKE_HOOKS:-}" ] && "${process.execPath}" "${join(root, "hooks.js")}" "$@"\nexit "\${FAKE_EXIT:-0}"\n`);
    // With FAKE_HOOKS ({ event: input }), it ends as Claude Code ends a run: it runs those
    // events' hooks of its --settings, in order, each given its input.
    writeFileSync(join(root, "hooks.js"), `import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const { hooks } = JSON.parse(args[args.indexOf("--settings") + 1]);
for (const [event, input] of Object.entries(JSON.parse(process.env.FAKE_HOOKS)))
  for (const group of hooks[event]) for (const hook of group.hooks) spawnSync("/bin/sh", ["-c", hook.command], { input: JSON.stringify(input), stdio: ["pipe", "inherit", "inherit"] });
`);
    chmodSync(join(dir, "claude"), 0o755);
    return dir;
  }

  async function runWrapper(args, { apiStatus = 200, api, exit = 0, viaShim = false, extraEnv = {} } = {}) {
    const fetch = api ?? (() => apiStatus === 200 ? response(200, {}) : response(apiStatus, { error: { message: "Your credit balance is too low" } }));
    const server = Bun.serve({ port: 0, fetch });
    try {
      const real = fakeClaude();
      const proc = Bun.spawn([viaShim ? join(SHIM, "claude") : WRAPPER, ...args], {
        env: { ...env, PATH: `${viaShim ? `${SHIM}:` : ""}${real}:${process.env.PATH}`, API_FIRST_BASE_URL: `http://localhost:${server.port}`, FAKE_EXIT: String(exit), ...extraEnv },
        stderr: "pipe",
      });
      const code = await proc.exited;
      const read = (name) => readFileSync(join(root, name), "utf8").trim();
      return { code, pid: proc.pid, stderr: await new Response(proc.stderr).text(), argv: read("argv.txt").split("\n"), claudePid: Number(read("pid.txt")) };
    } finally {
      server.stop(true);
    }
  }
  const decisions = () => readFileSync(join(root, "state", "decisions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

  test("with credit: claude replaces the wrapper, gets the key helper, no key variable, and its exit status stands", async () => {
    const run = await runWrapper(["-p", "hello"], { exit: 3 });
    expect(run.code).toBe(3);
    // exec: the process the caller started is claude itself, so killing it kills claude.
    expect(run.claudePid).toBe(run.pid);
    expect(run.argv.slice(0, 3)).toEqual(["-p", "hello", "--settings"]);
    expect(JSON.parse(run.argv[3]).apiKeyHelper).toContain(join(root, "key"));
    expect(() => readFileSync(join(root, "key-env.txt"))).toThrow();
    expect(decisions().map((entry) => entry.mode)).toEqual(["api"]);
  });

  test("an API run is logged with its run id and caller, and the next plan logs what it cost", async () => {
    const file = transcript([assistantLine, costState(0.0123)]);
    await runWrapper(["-p", "hello"], { extraEnv: { FAKE_HOOKS: JSON.stringify({ Stop: finishedRun, SessionEnd: sessionEnd(file) }) } });
    await runWrapper(["-p", "again"]);
    const [first, cost, second, ...rest] = decisions();
    // The wrapper's caller is this test process.
    expect(first).toMatchObject({ mode: "api", run: expect.stringMatching(/^[0-9a-f]{12}$/), caller: caller({ API_FIRST_CALLER_PID: String(process.pid) }) });
    expect(first.caller).toBeTruthy();
    expect(cost).toEqual({ at: expect.any(String), mode: "cost", run: first.run, session: SESSION, costUSD: 0.0123 });
    expect([second.mode, second.run === first.run, rest]).toEqual(["api", false, []]);
    expect(spendSummary(decisions()).total).toEqual({ runs: 2, usd: 0.0123, unknown: 1, before: 0, untracked: 0, unreported: 1 });
  });

  test("the merged settings go before a -- marker, and earlier --settings are dropped", async () => {
    const run = await runWrapper(["-p", "--settings", '{"a":1}', "--", "--settings is prompt text"]);
    expect(run.argv.slice(0, 2)).toEqual(["-p", "--settings"]);
    expect(JSON.parse(run.argv[2])).toMatchObject({ a: 1 });
    expect(run.argv.slice(3)).toEqual(["--", "--settings is prompt text"]);
  });

  test("without credit, the subscription, said on stderr; the shim works the same", async () => {
    const run = await runWrapper(["-p", "hello"], { apiStatus: 400, viaShim: true });
    expect([run.code, run.argv]).toEqual([0, ["-p", "hello"]]);
    expect(run.stderr).toContain("running on the subscription (exhausted");
    expect(decisions().map((entry) => entry.mode)).toEqual(["subscription"]);
  });

  test("credit that only Claude Code's requests are refused moves runs to the subscription after the first refusal", async () => {
    const api = (request) => claudeCodeGated(Object.fromEntries(request.headers));
    const first = await runWrapper(["-p", "hello"], { api, exit: 1, extraEnv: { FAKE_HOOKS: JSON.stringify({ StopFailure: refusedRun }) } });
    expect([first.code, first.argv[2]]).toEqual([1, "--settings"]);
    const second = await runWrapper(["-p", "hello"], { api });
    expect(second.argv).toEqual(["-p", "hello"]);
    expect(second.stderr).toContain("running on the subscription (exhausted (reported ");
    expect(second.stderr).toContain("a Claude Code run was refused (billing_error): Credit balance is too low");
    expect(decisions().map((entry) => entry.mode)).toEqual(["api", "refused", "subscription"]);
  });

  test("a caller's own key is left alone", async () => {
    const run = await runWrapper(["-p", "hello"], { extraEnv: { ANTHROPIC_API_KEY: "callers-own" } });
    expect(run.argv).toEqual(["-p", "hello"]);
    expect(readFileSync(join(root, "key-env.txt"), "utf8").trim()).toBe("visible");
    expect(decisions().at(-1)).toMatchObject({ mode: "passthrough", reason: "caller set ANTHROPIC_API_KEY" });
  });

  test("a loop through the shim stops at the nesting limit", async () => {
    const proc = Bun.spawn([WRAPPER, "--version"], { env: { ...env, PATH: process.env.PATH, API_FIRST_REAL_BIN: join(SHIM, "claude") }, stderr: "pipe" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 15_000);
    const code = await proc.exited;
    clearTimeout(timer);
    expect(code).toBe(70);
    expect(await new Response(proc.stderr).text()).toContain("which means a loop");
  });
});
