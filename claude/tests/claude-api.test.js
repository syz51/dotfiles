// The API-first wrapper: its planner (claude/bin/api-first.js) and the shell script that
// replaces itself with the real claude (claude/bin/claude-api).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCredit, decide, MAX_DEPTH, mergedSettings, plan, readArgs, realClaude, TTL_MS } from "../bin/api-first.js";

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
});

describe("credit check", () => {
  const check = (status, body) => checkCredit("k", { fetchImpl: async () => response(status, body) });

  test("classifies the API's answer, spend limits included", async () => {
    expect((await check(200, {})).status).toBe("ok");
    expect((await check(401, { error: { message: "invalid x-api-key" } })).status).toBe("invalid");
    expect((await check(400, { error: { message: "Your credit balance is too low to access the Anthropic API." } })).status).toBe("exhausted");
    expect((await check(400, { error: { message: "You have reached your specified API usage limits." } })).status).toBe("exhausted");
    expect((await check(402, { error: { message: "billing problem" } })).status).toBe("exhausted");
    expect((await check(429, { error: { message: "rate limited" } })).status).toBe("unknown");
    expect((await check(400, "not json")).status).toBe("unknown");
  });

  test("a failed request or a body that cannot be read is inconclusive, not a crash", async () => {
    expect((await checkCredit("k", { fetchImpl: async () => { throw new Error("offline"); } })).status).toBe("unknown");
    const stalled = { status: 200, text: async () => { throw new Error("The operation timed out."); } };
    expect(await checkCredit("k", { fetchImpl: async () => stalled })).toEqual({ status: "unknown", detail: "request failed: The operation timed out." });
  });

  test("sends the key in a header and asks for one token of Haiku", async () => {
    let seen;
    await checkCredit("sk-x", { baseUrl: "http://fake", fetchImpl: async (url, init) => { seen = { url, init }; return response(200, {}); } });
    expect(seen.url).toBe("http://fake/v1/messages");
    expect(seen.init.headers["x-api-key"]).toBe("sk-x");
    expect(JSON.parse(seen.init.body)).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 1 });
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
    for (const [status, mode] of [["ok", "api"], ["exhausted", "subscription"], ["invalid", "subscription"], ["unknown", "api"]]) {
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
    expect(JSON.parse(api.settings)).toEqual({ apiKeyHelper: `cat '${join(root, "key")}'`, a: 1 });
    rmSync(join(root, "state"), { recursive: true, force: true });
    const fallback = await plan(["-p", "x"], { env: base, check: statusOf("exhausted") });
    expect([fallback.mode, fallback.settings]).toEqual(["subscription", undefined]);
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
    writeFileSync(join(dir, "claude"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(root, "argv.txt")}"\necho $$ > "${join(root, "pid.txt")}"\n[ -n "\${ANTHROPIC_API_KEY:-}" ] && echo visible > "${join(root, "key-env.txt")}"\nexit "\${FAKE_EXIT:-0}"\n`);
    chmodSync(join(dir, "claude"), 0o755);
    return dir;
  }

  async function runWrapper(args, { apiStatus = 200, exit = 0, viaShim = false, extraEnv = {} } = {}) {
    const server = Bun.serve({ port: 0, fetch: () => apiStatus === 200 ? response(200, {}) : response(apiStatus, { error: { message: "Your credit balance is too low" } }) });
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
