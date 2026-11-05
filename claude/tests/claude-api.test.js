// The API-first wrapper (claude/bin/claude-api): settings merging, the credit check, the
// cached decision and fallback, and an end-to-end run against a fake API and fake claude.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCredit, decide, isPrintMode, OK_TTL_MS, plan, realClaude, startedBySelf, UNAVAILABLE_TTL_MS, withKeyHelper } from "../bin/claude-api";

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
  env = { HOME: root, PATH: "/usr/bin:/bin", CLAUDE_API_KEY_FILE: join(root, "key"), XDG_STATE_HOME: join(root, "state") };
});

const response = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("settings", () => {
  const helper = "cat '/k'";
  test("adds the key helper when the caller passed no settings", () => {
    expect(withKeyHelper(["-p", "hi"], helper)).toEqual(["-p", "hi", "--settings", JSON.stringify({ apiKeyHelper: helper })]);
  });

  test("merges into the last --settings, inline or a file, and drops earlier ones as Claude Code would", () => {
    const file = join(root, "s.json");
    writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [] } }));
    const merged = (argv) => JSON.parse(withKeyHelper(argv, helper).at(-1));
    expect(merged(["-p", "--settings", '{"permissions":{"deny":["WebFetch"]}}'])).toEqual({ apiKeyHelper: helper, permissions: { deny: ["WebFetch"] } });
    expect(merged(["-p", "--settings", file])).toEqual({ apiKeyHelper: helper, hooks: { PreToolUse: [] } });
    expect(merged(["-p", "--settings", '{"a":1}', `--settings=${file}`])).toEqual({ apiKeyHelper: helper, hooks: { PreToolUse: [] } });
    expect(withKeyHelper(["-p", "--settings", '{"a":1}', "--settings", '{"b":2}'], helper).filter((arg) => arg === "--settings")).toHaveLength(1);
  });

  test("keeps a caller's own apiKeyHelper", () => {
    expect(JSON.parse(withKeyHelper(["-p", "--settings", '{"apiKeyHelper":"mine"}'], helper).at(-1)).apiKeyHelper).toBe("mine");
  });

  test("only print-mode runs are billed to the API", () => {
    expect(isPrintMode(["-p", "x"])).toBe(true);
    expect(isPrintMode(["--print"])).toBe(true);
    expect(isPrintMode(["--version"])).toBe(false);
    expect(isPrintMode([])).toBe(false);
  });
});

describe("credit check", () => {
  const check = (status, body) => checkCredit("k", { fetchImpl: async () => response(status, body) });

  test("classifies the API's answer", async () => {
    expect((await check(200, { content: [] })).status).toBe("ok");
    expect((await check(401, { error: { message: "invalid x-api-key" } })).status).toBe("invalid");
    expect((await check(400, { error: { message: "Your credit balance is too low to access the Anthropic API." } })).status).toBe("exhausted");
    expect((await check(402, { error: { message: "billing problem" } })).status).toBe("exhausted");
    expect((await check(429, { error: { message: "rate limited" } })).status).toBe("unknown");
    expect((await check(400, "not json")).status).toBe("unknown");
    expect((await checkCredit("k", { fetchImpl: async () => { throw new Error("offline"); } })).status).toBe("unknown");
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
    const check = async (key) => {
      calls.push(key);
      return { status, detail: status };
    };
    return { calls, check };
  };

  test("without a key file, runs on the subscription without checking", async () => {
    const { calls, check } = counting("ok");
    rmSync(join(root, "key"));
    expect((await decide({ env, check })).mode).toBe("subscription");
    expect(calls).toHaveLength(0);
  });

  test("a working key means the API, cached for the OK interval", async () => {
    const { calls, check } = counting("ok");
    const now = Date.now();
    expect((await decide({ env, now, check })).mode).toBe("api");
    expect(calls).toEqual(["sk-test-key"]);
    expect((await decide({ env, now: now + OK_TTL_MS - 1, check })).mode).toBe("api");
    expect(calls).toHaveLength(1);
    await decide({ env, now: now + OK_TTL_MS + 1, check });
    expect(calls).toHaveLength(2);
  });

  test("exhausted credit or a refused key falls back to the subscription and is rechecked later", async () => {
    for (const status of ["exhausted", "invalid"]) {
      rmSync(join(root, "state"), { recursive: true, force: true });
      const { calls, check } = counting(status);
      const now = Date.now();
      const decision = await decide({ env, now, check });
      expect([decision.mode, decision.reason.startsWith(status)]).toEqual(["subscription", true]);
      expect((await decide({ env, now: now + UNAVAILABLE_TTL_MS - 1, check })).mode).toBe("subscription");
      expect(calls).toHaveLength(1);
      await decide({ env, now: now + UNAVAILABLE_TTL_MS + 1, check });
      expect(calls).toHaveLength(2);
    }
  });

  test("an inconclusive check stays on the API and is not cached", async () => {
    const { calls, check } = counting("unknown");
    expect((await decide({ env, check })).mode).toBe("api");
    expect((await decide({ env, check })).mode).toBe("api");
    expect(calls).toHaveLength(2);
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

  test("finds the real claude past the api-first shim", () => {
    const dir = fakeBin();
    expect(realClaude({ PATH: `${SHIM}:${dir}` })).toBe(join(dir, "claude"));
    expect(realClaude({ PATH: dir, CLAUDE_API_REAL_BIN: "/x/claude" })).toBe("/x/claude");
    expect(() => realClaude({ PATH: SHIM })).toThrow("no claude executable");
    // The shim through a link to the checkout, as ~/.claude/bin/api-first is.
    const link = join(root, "linked-bin");
    symlinkSync(join(SHIM, ".."), link);
    expect(realClaude({ PATH: `${join(link, "api-first")}:${dir}` })).toBe(join(dir, "claude"));
    expect(() => realClaude({ PATH: join(link, "api-first") })).toThrow("no claude executable");
  });

  test("knows when it was started directly by itself", () => {
    expect(startedBySelf({ CLAUDE_API_WRAPPER_PID: "41" }, 41)).toBe(true);
    expect(startedBySelf({ CLAUDE_API_WRAPPER_PID: "41" }, 42)).toBe(false);
    expect(startedBySelf({}, 41)).toBe(false);
  });

  test("never passes key variables on; only print mode is changed", async () => {
    const dir = fakeBin();
    const base = { ...env, PATH: dir, ANTHROPIC_API_KEY: "leak", ANTHROPIC_AUTH_TOKEN: "leak" };
    const interactive = await plan(["--version"], { env: base, check: async () => ({ status: "ok", detail: "" }) });
    expect([interactive.argv, interactive.decision, interactive.env.ANTHROPIC_API_KEY, interactive.env.ANTHROPIC_AUTH_TOKEN]).toEqual([["--version"], null, undefined, undefined]);
    const api = await plan(["-p", "hi"], { env: base, check: async () => ({ status: "ok", detail: "" }) });
    expect(api.decision.mode).toBe("api");
    expect(JSON.parse(api.argv.at(-1))).toEqual({ apiKeyHelper: `cat '${join(root, "key")}'` });
    expect(api.env.ANTHROPIC_API_KEY).toBeUndefined();
    rmSync(join(root, "state"), { recursive: true, force: true });
    const fallback = await plan(["-p", "hi"], { env: base, check: async () => ({ status: "exhausted", detail: "" }) });
    expect([fallback.decision.mode, fallback.argv, fallback.env.ANTHROPIC_API_KEY]).toEqual(["subscription", ["-p", "hi"], undefined]);
  });
});

describe("loop guard", () => {
  test("a wrapper whose real claude is its own shim stops instead of looping", async () => {
    const proc = Bun.spawn([WRAPPER, "--version"], { env: { ...env, PATH: process.env.PATH, CLAUDE_API_REAL_BIN: join(SHIM, "claude") }, stderr: "pipe" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
    const code = await proc.exited;
    clearTimeout(timer);
    expect(code).toBe(70);
    expect(await new Response(proc.stderr).text()).toContain("started by itself");
  });
});

describe("end to end", () => {
  // A fake claude that records its argv and whether a key variable reached it, then
  // exits with FAKE_EXIT.
  function fakeClaude() {
    const dir = join(root, "real");
    mkdirSync(dir);
    writeFileSync(join(dir, "claude"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(root, "argv.txt")}"\n[ -n "$ANTHROPIC_API_KEY" ] && echo key-visible > "${join(root, "leak.txt")}"\nexit "\${FAKE_EXIT:-0}"\n`);
    chmodSync(join(dir, "claude"), 0o755);
    return dir;
  }

  async function runWrapper(args, { apiStatus, exit = 0, viaShim = false }) {
    const server = Bun.serve({ port: 0, fetch: () => apiStatus === 200 ? response(200, { content: [] }) : response(apiStatus, { error: { message: "Your credit balance is too low" } }) });
    try {
      const real = fakeClaude();
      const program = viaShim ? join(SHIM, "claude") : WRAPPER;
      const proc = Bun.spawn([program, ...args], {
        env: { ...env, PATH: `${viaShim ? `${SHIM}:` : ""}${real}:${process.env.PATH}`, CLAUDE_API_BASE_URL: `http://localhost:${server.port}`, FAKE_EXIT: String(exit), ANTHROPIC_API_KEY: "leak" },
        stderr: "pipe",
      });
      const code = await proc.exited;
      return { code, stderr: await new Response(proc.stderr).text(), argv: readFileSync(join(root, "argv.txt"), "utf8").trim().split("\n") };
    } finally {
      server.stop(true);
    }
  }
  const decisions = () => readFileSync(join(root, "state", "claude-api", "decisions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

  test("with credit, the run gets the key helper, no key variable, and the child's exit status", async () => {
    const run = await runWrapper(["-p", "hello"], { apiStatus: 200, exit: 3 });
    expect(run.code).toBe(3);
    expect(run.argv.slice(0, 3)).toEqual(["-p", "hello", "--settings"]);
    expect(JSON.parse(run.argv[3]).apiKeyHelper).toContain(join(root, "key"));
    expect(() => readFileSync(join(root, "leak.txt"))).toThrow();
    expect(decisions().map((entry) => entry.mode)).toEqual(["api"]);
  });

  test("without credit, the run falls back to the subscription and says so; the shim works the same", async () => {
    const run = await runWrapper(["-p", "hello"], { apiStatus: 400, viaShim: true });
    expect(run.code).toBe(0);
    expect(run.argv).toEqual(["-p", "hello"]);
    expect(run.stderr).toContain("running on the subscription (exhausted");
    expect(decisions().map((entry) => entry.mode)).toEqual(["subscription"]);
  });
});
