// The API-first wrapper: its planner (claude/bin/api-first.js) and the shell script that
// replaces itself with the real claude (claude/bin/claude-api).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCredit, decide, lifetime, MAX_BACKOFF_MS, MAX_DEPTH, mergedSettings, plan, readArgs, realClaude, recordRun, TTL_MS } from "../bin/api-first.js";

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
    expect(JSON.parse(mergedSettings(undefined, "h"))).toEqual({ apiKeyHelper: "h" });
    expect(JSON.parse(mergedSettings('{"permissions":{"deny":["WebFetch"]}}', "h"))).toEqual({ apiKeyHelper: "h", permissions: { deny: ["WebFetch"] } });
    expect(JSON.parse(mergedSettings(file, "h"))).toEqual({ apiKeyHelper: "h", hooks: { PreToolUse: [] } });
    expect(JSON.parse(mergedSettings('{"apiKeyHelper":"mine"}', "h")).apiKeyHelper).toBe("mine");
  });

  test("the report hooks follow the caller's own, and a caller's own key helper gets none", () => {
    const own = { hooks: [{ type: "command", command: "mine" }] };
    const merged = JSON.parse(mergedSettings(JSON.stringify({ hooks: { Stop: [own], PreToolUse: [own] } }), "h", "r"));
    const report = { hooks: [{ type: "command", command: "r" }] };
    expect(merged).toEqual({ apiKeyHelper: "h", hooks: { Stop: [own, report], StopFailure: [report], PreToolUse: [own] } });
    expect(JSON.parse(mergedSettings('{"apiKeyHelper":"mine"}', "h", "r"))).toEqual({ apiKeyHelper: "mine" });
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
    expect((await check(400, "not json")).status).toBe("refused");
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
    const state = recordRun(refusedRun, { env, now: now + 1 });
    expect(state).toMatchObject({ status: "exhausted", source: "run", refusals: 1 });
    const decision = await decide({ env, now: now + 2, check });
    expect(decision.mode).toBe("subscription");
    expect(decision.reason).toContain("(reported ");
    expect(decision.reason).toContain("a Claude Code run was refused (billing_error): Credit balance is too low");
    expect(calls).toHaveLength(1);
    expect(recordRun({ ...refusedRun, error: "authentication_failed" }, { env, now }).status).toBe("invalid");
  });

  test("while the check passes but runs are refused, each refusal stands twice as long, up to a cap", async () => {
    let now = Date.now();
    const { calls, check } = counting("ok");
    const spans = [];
    for (let round = 1; round <= 6; round++) {
      await decide({ env, now, check });
      const state = recordRun(refusedRun, { env, now });
      expect(state.refusals).toBe(round);
      spans.push(lifetime(state));
      expect((await decide({ env, now: now + lifetime(state) - 1, check })).mode).toBe("subscription");
      now += lifetime(state);
    }
    const base = TTL_MS.exhausted;
    expect(spans).toEqual([base, 2 * base, 4 * base, 8 * base, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
    expect(calls).toHaveLength(6);
  });

  test("a run that goes through clears the refusals, and ends one still standing", async () => {
    const now = Date.now();
    const { calls, check } = counting("ok");
    expect(recordRun(finishedRun, { env, now })).toBeNull();
    await decide({ env, now, check });
    recordRun(refusedRun, { env, now });
    // A run that started before the refusal finished on the API.
    expect(recordRun(finishedRun, { env, now: now + 1 })).toMatchObject({ refusals: 0, checkedAt: 0 });
    expect((await decide({ env, now: now + 2, check })).mode).toBe("api");
    expect(calls).toHaveLength(2);
    expect(lifetime(recordRun(refusedRun, { env, now: now + 3 }))).toBe(TTL_MS.exhausted);
    // Once the check passes again, later finished runs leave the entry alone.
    await decide({ env, now: now + 3 + TTL_MS.exhausted, check });
    expect(recordRun(finishedRun, { env, now })).toMatchObject({ status: "ok", refusals: 0 });
    expect(recordRun(finishedRun, { env, now })).toBeNull();
  });

  test("reports that are not a credit or key refusal change nothing", async () => {
    await decide({ env, check: statusOf("ok") });
    const before = readFileSync(join(root, "state", "state.json"), "utf8");
    for (const input of [{ ...refusedRun, error: "rate_limit" }, { ...refusedRun, error: "server_error" }, { hook_event_name: "SessionEnd" }])
      expect(recordRun(input, { env })).toBeNull();
    expect(readFileSync(join(root, "state", "state.json"), "utf8")).toBe(before);
    rmSync(join(root, "key"));
    expect(recordRun(refusedRun, { env })).toBeNull();
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

  test("passes through runs that are not print mode or that bring their own auth", async () => {
    const base = { ...env, PATH: fakeBin() };
    expect((await plan(["--version"], { env: base, check: statusOf("ok") })).mode).toBe("passthrough");
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) {
      const result = await plan(["-p", "x"], { env: { ...base, [name]: "set" }, check: statusOf("ok") });
      expect([result.mode, result.reason, result.settings]).toEqual(["passthrough", `caller set ${name}`, undefined]);
    }
  });

  test("API mode carries the merged settings; the subscription carries none", async () => {
    const base = { ...env, PATH: fakeBin() };
    const api = await plan(["-p", "x", "--settings", '{"a":1}'], { env: base, check: statusOf("ok") });
    expect(api.mode).toBe("api");
    const settings = JSON.parse(api.settings);
    expect(settings).toMatchObject({ apiKeyHelper: `cat '${join(root, "key")}'`, a: 1 });
    expect(Object.keys(settings.hooks).sort()).toEqual(["Stop", "StopFailure"]);
    rmSync(join(root, "state"), { recursive: true, force: true });
    const fallback = await plan(["-p", "x"], { env: base, check: statusOf("exhausted") });
    expect([fallback.mode, fallback.settings]).toEqual(["subscription", undefined]);
  });

  test("the report hook in the settings runs as given, records a refusal, and prints nothing", async () => {
    // A path with a quote and a space, to show the command quotes it.
    const keyDir = join(root, "it's here");
    mkdirSync(keyDir);
    writeFileSync(join(keyDir, "key"), "sk-test-key\n");
    const base = { ...env, PATH: fakeBin(), API_FIRST_KEY_FILE: join(keyDir, "key") };
    const { hooks } = JSON.parse((await plan(["-p", "x"], { env: base, check: statusOf("ok") })).settings);
    const hook = async (event, input) => {
      const proc = Bun.spawn(["/bin/sh", "-c", hooks[event][0].hooks[0].command], { env: base, stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe" });
      return { code: await proc.exited, out: await new Response(proc.stdout).text(), err: await new Response(proc.stderr).text() };
    };
    expect(await hook("StopFailure", refusedRun)).toEqual({ code: 0, out: "", err: "" });
    expect((await decide({ env: base, check: statusOf("ok") })).mode).toBe("subscription");
    const log = readFileSync(join(root, "state", "decisions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(log.at(-1)).toMatchObject({ mode: "refused", reason: "exhausted: a Claude Code run was refused (billing_error): Credit balance is too low" });
    expect(await hook("Stop", finishedRun)).toEqual({ code: 0, out: "", err: "" });
    expect((await decide({ env: base, check: statusOf("ok") })).mode).toBe("api");
  });

  test("past the nesting limit it stops", async () => {
    await expect(plan(["-p", "x"], { env: { ...env, PATH: fakeBin(), API_FIRST_DEPTH: String(MAX_DEPTH + 1) } })).rejects.toThrow("loop");
  });
});

describe("end to end", () => {
  // A fake claude that records its argv, its process id and whether a key variable
  // reached it, then exits with FAKE_EXIT.
  function fakeClaude() {
    const dir = join(root, "real");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "claude"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(root, "argv.txt")}"\necho $$ > "${join(root, "pid.txt")}"\n[ -n "\${ANTHROPIC_API_KEY:-}" ] && echo visible > "${join(root, "key-env.txt")}"\n[ -n "\${FAKE_REFUSED:-}" ] && "${process.execPath}" "${join(root, "refused.js")}" "$@"\nexit "\${FAKE_EXIT:-0}"\n`);
    // With FAKE_REFUSED, it ends as Claude Code ends a run the API refused for credit: it
    // runs the StopFailure hooks of its --settings.
    writeFileSync(join(root, "refused.js"), `import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const { hooks } = JSON.parse(args[args.indexOf("--settings") + 1]);
for (const group of hooks.StopFailure) for (const hook of group.hooks) spawnSync("/bin/sh", ["-c", hook.command], { input: ${JSON.stringify(JSON.stringify(refusedRun))}, stdio: ["pipe", "inherit", "inherit"] });
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
    const first = await runWrapper(["-p", "hello"], { api, exit: 1, extraEnv: { FAKE_REFUSED: "1" } });
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
