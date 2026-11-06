import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectName } from "../../tests/lib/cleanup.js";
import { main } from "../cli.js";
import { API_FIRST, ClaudeCallError, judge, runTask } from "./claude.js";
import { fromLitellm, litellmFetchedAt, LITELLM_FILE, LITELLM_URL, MAX_AGE_MS, refreshLitellm } from "./litellm.js";
import { normalizeUsage, priceSource, requestCost } from "./pricing.js";
import { appendJsonl, readJsonl, readJson, stateDir, statePath, writeJsonAtomic } from "./state.js";
import { Transcript, usage, writeProjects } from "./testing/transcripts.js";
import { isAgentBrief, isAutomation, isHostPrompt, loadSessions, parseSession, readRecords, sessionFiles } from "./transcripts.js";

const FAKE = join(import.meta.dir, "testing", "fake-claude.js");
let scratch;
const saved = {};
const setEnv = (values) => {
  for (const [name, value] of Object.entries(values)) {
    if (!(name in saved)) saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "claude-factory-lib-"));
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe("pricing", () => {
  test("normalizes cache writes by duration, defaulting to five minutes", () => {
    expect(normalizeUsage(usage(1, 2, { cacheRead: 3, cacheWrite: 10, oneHour: 4 })))
      .toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite5m: 6, cacheWrite1h: 4 });
    expect(normalizeUsage({ input_tokens: 1, cache_creation_input_tokens: 7 }).cacheWrite5m).toBe(7);
  });

  test("prices each token type, and Haiku's long prompts at the higher tier", () => {
    const tokens = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 };
    expect(requestCost("claude-opus-5-5", tokens)).toBeCloseTo(4 + 20 + 0.2 + 5 + 8);
    expect(requestCost("claude-haiku-5-5", { ...tokens, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })).toBeCloseTo(0.5 + 2.5);
    expect(requestCost("claude-haiku-5-5", { input: 1000, output: 1000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })).toBeCloseTo((100 + 500) / 1e6);
    expect(requestCost("unknown-model", tokens)).toBeNull();
  });

  test("Sonnet 5.5 cache reads cost 0.05x input, per Anthropic's pricing page", () => {
    expect(requestCost("claude-sonnet-5-5", { input: 0, output: 0, cacheRead: 1e6, cacheWrite5m: 0, cacheWrite1h: 0 })).toBeCloseTo(0.1);
  });
});

describe("LiteLLM fallback prices", () => {
  const perToken = (perMillion) => perMillion / 1e6;
  const entries = {
    "gpt-test": {
      input_cost_per_token: perToken(2), output_cost_per_token: perToken(10), cache_read_input_token_cost: perToken(0.1), cache_creation_input_token_cost: perToken(2.5),
      input_cost_per_token_above_272k_tokens: perToken(4), output_cost_per_token_above_272k_tokens: perToken(15), cache_read_input_token_cost_above_272k_tokens: perToken(0.2),
      input_cost_per_token_above_1000k_tokens: perToken(8),
    },
    "bare-test": { input_cost_per_token: perToken(1), output_cost_per_token: perToken(3) },
    "claude-sonnet-5-5": { input_cost_per_token: perToken(99), output_cost_per_token: perToken(99) },
    "embedding-test": { input_cost_per_token: perToken(1), mode: "embedding" },
  };
  const tokens = (fields) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...fields });
  const writeCache = (dir, fetchedAt) => writeJsonAtomic(join(dir, LITELLM_FILE), { fetchedAt, source: LITELLM_URL, prices: entries });

  test("converts entries to prices per million tokens, with cache and long-prompt defaults", () => {
    expect(fromLitellm(entries["bare-test"])).toEqual({ input: 1, output: 3, cacheRead: 1, cacheWrite5m: 1, cacheWrite1h: 1 });
    const price = fromLitellm(entries["gpt-test"]);
    expect(price).toMatchObject({ input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 2.5 });
    expect(price.cacheRead).toBeCloseTo(0.1);
    // The lowest tier is the long-prompt price; fields it lacks keep the base price.
    expect(price.long).toMatchObject({ above: 272_000, input: 4, output: 15, cacheWrite5m: 2.5, cacheWrite1h: 2.5 });
    expect(fromLitellm(entries["embedding-test"])).toBeNull();
    expect(fromLitellm({ input_cost_per_token: -1, output_cost_per_token: 1 })).toBeNull();
  });

  test("models missing from the table take the cached price; the table wins; others stay unpriced", () => {
    setEnv({ CLAUDE_FACTORY_STATE: scratch });
    expect(requestCost("gpt-test", tokens({ input: 1e6 }))).toBeNull();
    // The list is read once per state folder.
    writeCache(join(scratch, "cached"), "2026-11-07T00:00:00.000Z");
    setEnv({ CLAUDE_FACTORY_STATE: join(scratch, "cached") });
    expect(requestCost("gpt-test", tokens({ input: 50_000, output: 50_000, cacheRead: 50_000, cacheWrite5m: 50_000 }))).toBeCloseTo(0.05 * (2 + 10 + 0.1 + 2.5));
    // A prompt over 272K tokens, cache reads included, takes the long-prompt price.
    expect(requestCost("gpt-test", tokens({ input: 100_000, cacheRead: 200_000, output: 100_000 }))).toBeCloseTo(0.1 * 4 + 0.2 * 0.2 + 0.1 * 15);
    expect(requestCost("claude-sonnet-5-5", tokens({ input: 1e6 }))).toBeCloseTo(2);
    expect([priceSource("gpt-test"), priceSource("claude-sonnet-5-5"), priceSource("embedding-test"), priceSource("toString")]).toEqual(["litellm", "table", null, null]);
    expect(litellmFetchedAt()).toBe("2026-11-07T00:00:00.000Z");
  });

  test("refreshes a missing or week-old list, keeps a fresh one, and notes a failed fetch", async () => {
    setEnv({ CLAUDE_FACTORY_STATE: scratch });
    const now = Date.parse("2026-11-07T00:00:00Z");
    const calls = [];
    const ok = async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ "bare-test": entries["bare-test"] }));
    };
    expect(await refreshLitellm({ fetch: ok, now })).toBe(true);
    expect(calls).toEqual([LITELLM_URL]);
    expect(readJson(join(scratch, LITELLM_FILE))).toEqual({ fetchedAt: "2026-11-07T00:00:00.000Z", source: LITELLM_URL, prices: { "bare-test": entries["bare-test"] } });
    expect(priceSource("bare-test")).toBe("litellm");
    expect(await refreshLitellm({ fetch: ok, now: now + MAX_AGE_MS - 1 })).toBe(false);
    expect(calls).toHaveLength(1);

    const notes = [];
    expect(await refreshLitellm({ fetch: async () => new Response("down", { status: 503 }), now: now + MAX_AGE_MS, notes })).toBe(false);
    expect(await refreshLitellm({ fetch: async () => new Response("[]"), now: now + MAX_AGE_MS, notes })).toBe(false);
    expect(notes).toEqual([
      "LiteLLM's price list could not be refreshed (HTTP 503); using the copy fetched 2026-11-07.",
      "LiteLLM's price list could not be refreshed (not a JSON object); using the copy fetched 2026-11-07.",
    ]);
    expect(priceSource("bare-test")).toBe("litellm");

    setEnv({ CLAUDE_FACTORY_STATE: join(scratch, "empty") });
    const none = [];
    await refreshLitellm({ fetch: async () => { throw new Error("offline"); }, notes: none });
    expect(none).toEqual(["LiteLLM's price list could not be refreshed (offline); models missing from the price table stay unpriced."]);
  });
});

describe("state", () => {
  test("lives under CLAUDE_FACTORY_STATE, else XDG_DATA_HOME", () => {
    expect(stateDir({ CLAUDE_FACTORY_STATE: "/x" })).toBe("/x");
    expect(stateDir({ XDG_DATA_HOME: "/data" })).toBe("/data/claude-factory");
  });

  test("JSON Lines and atomic JSON round-trip; damage fails with its location", () => {
    setEnv({ CLAUDE_FACTORY_STATE: scratch });
    const lines = statePath("a", "b.jsonl");
    expect(readJsonl(lines)).toEqual([]);
    appendJsonl(lines, { n: 1 });
    appendJsonl(lines, { n: 2 });
    expect(readJsonl(lines)).toEqual([{ n: 1 }, { n: 2 }]);
    writeFileSync(lines, '{"n":1}\n{bad\n');
    expect(() => readJsonl(lines)).toThrow(":2: malformed");
    const json = statePath("c.json");
    expect(readJson(json, "none")).toBe("none");
    writeJsonAtomic(json, { ok: true });
    expect(readJson(json)).toEqual({ ok: true });
    expect(readdirSync(scratch).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("transcripts", () => {
  test("parses prompts, deduplicated usage, tools, errors and metadata", () => {
    const t = new Transcript({ cwd: "/Users/test/app" })
      .prompt("Fix the login bug")
      .prompt("Context handoff (full_thread_summary): ...", { source: "system" })
      .prompt("meta", { isMeta: true })
      .prompt("<local-command-stdout>ok</local-command-stdout>")
      .assistant([{ type: "thinking", thinking: "" }, { type: "text", text: "Looking" }], { use: usage(10, 100) })
      .tool("Bash", { command: "bun test" }, "1 fail", { isError: true })
      .tool("Read", { file_path: "/a" }, "x")
      .interrupt()
      .apiError(429)
      .apiError(429)
      .compact()
      .prompt("no, that's the wrong file")
      .text("Fixed", { model: "claude-sonnet-5-5", use: usage(1, 10, { cacheRead: 0, cacheWrite: 0 }) })
      .title("Fix login")
      .prLink("https://github.com/o/r/pull/7")
      .prLink("https://github.com/o/r/pull/7")
      .costState(1.25);
    const root = writeProjects([{ transcript: t, tail: '{"partial' }]);
    try {
      const [{ file }] = sessionFiles(root);
      const session = parseSession(file);
      expect(session.id).toBe(t.sessionId);
      expect(session.cwd).toBe("/Users/test/app");
      expect(session.entrypoint).toBe("t3-code");
      expect(session.title).toBe("Fix login");
      expect(session.prompts.map((prompt) => prompt.text)).toEqual(["Fix the login bug", "no, that's the wrong file"]);
      // The two-block message counts once; so does each tool-use message.
      expect(session.assistantMessages).toBe(4);
      expect(session.models).toEqual({ "claude-opus-5-5": 3, "claude-sonnet-5-5": 1 });
      expect(session.usage["claude-opus-5-5"].output).toBe(300);
      expect(session.toolCalls.map((call) => [call.name, call.ok, call.output])).toEqual([["Bash", false, "1 fail"], ["Read", true, "x"]]);
      expect(session.interrupts).toBe(1);
      expect(session.apiErrors).toEqual({ 429: 2 });
      expect(session.compactions).toBe(1);
      expect(session.prLinks).toEqual([{ url: "https://github.com/o/r/pull/7", number: 7, repository: "o/r", at: expect.any(String) }]);
      expect([session.costUSD, session.costSource, session.linesAdded]).toEqual([1.25, "cost-state", 5]);
      expect(session.estimatedCostUSD).toBeGreaterThan(0);
      expect(session.malformedLines).toBe(1);
      expect(session.automation).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cost by model is priced per request, so Haiku's long-prompt tier applies only where a request hit it", () => {
    // Two Haiku requests of 60K prompt tokens each: neither passes 100K, though their sum does.
    const t = new Transcript().prompt("go")
      .text("a", { model: "claude-haiku-5-5", use: usage(60_000, 0, { cacheRead: 0, cacheWrite: 0 }) })
      .text("b", { model: "claude-haiku-5-5", use: usage(60_000, 0, { cacheRead: 0, cacheWrite: 0 }) });
    const root = writeProjects([{ transcript: t }]);
    try {
      expect(loadSessions({ root })[0].costByModel["claude-haiku-5-5"]).toBeCloseTo((120_000 * 0.1) / 1e6);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("estimates cost with subagents when there is no cost-state", () => {
    const main = new Transcript().prompt("go").text("ok", { use: usage(0, 1e6, { cacheRead: 0, cacheWrite: 0 }) });
    const agent = new Transcript({ sessionId: main.sessionId }).text("found", { model: "claude-haiku-5-5", effort: "xhigh", use: usage(0, 1e6, { cacheRead: 0, cacheWrite: 0 }) });
    const root = writeProjects([{ transcript: main, subagents: [{ id: "agent-a1", meta: { agentType: "explorer", description: "look" }, transcript: agent }] }]);
    try {
      const [session] = loadSessions({ root });
      expect(session.costSource).toBe("estimated");
      expect(session.costUSD).toBeCloseTo(20 + 0.5);
      expect(session.subagents).toEqual([expect.objectContaining({ id: "agent-a1", agentType: "explorer", model: "claude-haiku-5-5", effort: "xhigh", costUSD: 0.5, assistantMessages: 1, toolCalls: 0 })]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a fork counts only its own records and names its parent", () => {
    const parent = new Transcript();
    const copied = { forkedFrom: { sessionId: parent.sessionId, messageUuid: "m" } };
    const fork = new Transcript()
      .prompt("Original task", copied)
      .text("old answer", { ...copied, use: usage(0, 1e6, { cacheRead: 0, cacheWrite: 0 }) })
      .prompt("Follow-up in the fork")
      .text("new answer", { use: usage(0, 1e6, { cacheRead: 0, cacheWrite: 0 }) });
    const root = writeProjects([{ transcript: fork }]);
    try {
      const [session] = loadSessions({ root });
      expect(session.forkedFrom).toBe(parent.sessionId);
      expect(session.prompts.map((prompt) => prompt.text)).toEqual(["Follow-up in the fork"]);
      expect(session.inheritedPrompts.map((prompt) => prompt.text)).toEqual(["Original task"]);
      expect([session.assistantMessages, session.estimatedCostUSD]).toEqual([1, 20]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a fork's inherited prompts pass the same filters as its own", () => {
    const copied = { forkedFrom: { sessionId: "parent", messageUuid: "m" } };
    const fork = new Transcript()
      .prompt("Original task", copied)
      .prompt("Summary: run an ultra review", { ...copied, isCompactSummary: true })
      .prompt("Injected ultra review notice", { ...copied, source: "system" })
      .prompt("Continue where you left off.", copied)
      .prompt("<system-reminder>ultra</system-reminder>", copied);
    const root = writeProjects([{ transcript: fork }]);
    try {
      expect(loadSessions({ root })[0].inheritedPrompts.map((prompt) => prompt.text)).toEqual(["Original task"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a subagent on an unpriced model marks the session unpriced; bad meta counts as unreadable", () => {
    const main = new Transcript().prompt("go").text("ok");
    const agent = new Transcript({ sessionId: main.sessionId }).text("x", { model: "claude-future-9" });
    const root = writeProjects([{ transcript: main, subagents: [{ id: "agent-z", transcript: agent }] }]);
    try {
      writeFileSync(join(root, "-Users-test-project", main.sessionId, "subagents", "agent-z.meta.json"), "{bad");
      const [session] = loadSessions({ root });
      expect(session.unpriced).toBe(true);
      expect([session.subagents[0].unpriced, session.subagents[0].malformedLines, session.subagents[0].agentType]).toEqual([true, 1, null]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("host notices are not prompts; a delegation brief marks an agent-launched session", () => {
    const delegated = new Transcript()
      .prompt("Act as the implementation sub-agent for this task.")
      .prompt("Update on pull request #3 (https://github.com/o/r/pull/3), which T3 Code is watching:")
      .prompt("Context handoff (full_thread_summary):\nProvider context handoff.")
      .prompt("<command-name>/compact</command-name>")
      .prompt("<command-message>review</command-message>\n<command-name>/review</command-name>")
      .prompt("Continue where you left off.");
    const personal = new Transcript().prompt("Continue where you left off, but in Rust");
    const empty = new Transcript().prompt("Delegated task node:delegated-task:x [completed]");
    const root = writeProjects([{ transcript: delegated }, { transcript: personal }, { transcript: empty }]);
    try {
      const byId = Object.fromEntries(loadSessions({ root }).map((s) => [s.id, s]));
      expect([byId[delegated.sessionId].prompts.length, byId[delegated.sessionId].hostPrompts, byId[delegated.sessionId].origin]).toEqual([1, 5, "agent"]);
      expect([byId[personal.sessionId].prompts.length, byId[personal.sessionId].origin]).toEqual([1, "person"]);
      expect([byId[empty.sessionId].prompts.length, byId[empty.sessionId].origin]).toEqual([0, null]);
      expect(isHostPrompt("Delegated task node:delegated-task:abc")).toBe(true);
      expect(isAgentBrief("Act as the research subagent")).toBe(true);
      expect(isAgentBrief("Please act as the reviewer")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("long tool output keeps its start and end", () => {
    const long = `${"a".repeat(3000)}https://github.com/o/r/pull/9`;
    const root = writeProjects([{ transcript: new Transcript().tool("Bash", { command: "gh pr create" }, [{ type: "text", text: long }]) }]);
    try {
      const [{ toolCalls: [call] }] = loadSessions({ root });
      expect(call.output.length).toBeLessThan(2100);
      expect(call.output.startsWith("aaa")).toBe(true);
      expect(call.output).toContain("characters omitted");
      expect(call.output.endsWith("https://github.com/o/r/pull/9")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a stale cost-state yields to a clearly larger estimate", () => {
    const big = usage(0, 1e6, { cacheRead: 0, cacheWrite: 0 }); // $20 on Opus 5.5
    const stale = new Transcript().costState(1).prompt("more").text("x", { use: big });
    const current = new Transcript().prompt("go").text("x", { use: big }).costState(19.5);
    const root = writeProjects([{ transcript: stale }, { transcript: current }]);
    try {
      const byId = Object.fromEntries(loadSessions({ root }).map((s) => [s.id, s]));
      expect([byId[stale.sessionId].costSource, byId[stale.sessionId].costUSD]).toEqual(["estimated", 20]);
      expect([byId[current.sessionId].costSource, byId[current.sessionId].costUSD]).toEqual(["cost-state", 19.5]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadSessions filters by time; readRecords counts unreadable lines", () => {
    const old = new Transcript({ start: Date.parse("2026-01-01T00:00:00Z") }).prompt("old");
    const recent = new Transcript({ start: Date.parse("2026-11-01T00:00:00Z") }).prompt("new");
    const root = writeProjects([{ transcript: old }, { transcript: recent }]);
    try {
      expect(loadSessions({ root, since: 0 }).length).toBe(2);
      expect(loadSessions({ root, since: Date.parse("2026-10-01T00:00:00Z") }).map((s) => s.prompts[0].text)).toEqual(["new"]);
      const file = join(scratch, "x.jsonl");
      writeFileSync(file, '{"a":1}\n[1]\n"s"\nnope\n');
      expect(readRecords(file)).toEqual({ records: [{ a: 1 }, [1]], malformed: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("automation sessions are recognized by their folder", () => {
    expect(isAutomation("/Users/u/.local/share/codex-skills/investigations/attempts/x/work")).toBe(true);
    expect(isAutomation("/private/tmp/fixture", { temp: ["/private/tmp"] })).toBe(true);
    expect(isAutomation("/Users/u/project", { temp: ["/private/tmp"] })).toBe(false);
    expect(isAutomation(null)).toBe(false);
  });
});

describe("claude runner", () => {
  const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
  const fake = (mode, extra = {}) => setEnv({ CLAUDE_FACTORY_BIN: FAKE, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: join(scratch, "log.jsonl"), ...extra });
  const calls = () => readFileSync(join(scratch, "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

  test("judge sends the prompt on stdin in a restricted, unsaved session", async () => {
    fake("structured", { FAKE_CLAUDE_OUTPUT: '{"verdict":"pass"}', FAKE_CLAUDE_COST: "0.02" });
    const { output, costUSD } = await judge({ prompt: "Grade this 中文", schema, model: "claude-sonnet-5-5", budgetUsd: 0.3 });
    expect(output).toEqual({ verdict: "pass" });
    expect(costUSD).toBe(0.02);
    const [call] = calls();
    expect(call.stdin).toBe("Grade this 中文");
    for (const flag of ["--setting-sources", "--tools", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) expect(call.args).toContain(flag);
    expect(call.args[call.args.indexOf("--tools") + 1]).toBe("");
    expect(call.args[call.args.indexOf("--max-budget-usd") + 1]).toBe("0.3");
    expect(JSON.parse(call.args[call.args.indexOf("--json-schema") + 1])).toEqual(schema);
    expect(call.args).not.toContain("--system-prompt-file");
    expect(call.args).not.toContain("--append-system-prompt-file");
    expect(existsSync(call.cwd)).toBe(false);
  });

  test("judge's shared instructions replace the default system prompt, where Claude Code caches them", async () => {
    fake("structured", { FAKE_CLAUDE_OUTPUT: '{"verdict":"pass"}' });
    await judge({ prompt: "one session", system: "the rubric", schema, model: "m" });
    const [call] = calls();
    expect(call.system).toBe("the rubric");
    // The file lives in the judge's own folder, removed with it.
    expect(call.args[call.args.indexOf("--system-prompt-file") + 1].endsWith("/judge-system.md")).toBe(true);
    expect(call.args).not.toContain("--append-system-prompt-file");
    expect(call.stdin).toBe("one session");
    expect(existsSync(call.cwd)).toBe(false);
  });

  test.each(["tool", "mcp", "error", "malformed"])("judge fails closed on %s", async (mode) => {
    fake(mode);
    await expect(judge({ prompt: "x", schema, model: "m" })).rejects.toBeInstanceOf(ClaudeCallError);
  });

  test("a judge call that times out fails as a ClaudeCallError with its partial cost", async () => {
    const script = join(scratch, "slow.js");
    writeFileSync(script, `export default async ({ emit }) => { emit({ type: "system", subtype: "init", tools: [] }); process.stdout.write('{"type":"assist'); await Bun.sleep(5000); };`);
    fake("script", { FAKE_CLAUDE_SCRIPT: script });
    const error = await judge({ prompt: "x", schema, model: "m", timeoutMs: 300 }).catch((e) => e);
    expect(error).toBeInstanceOf(ClaudeCallError);
    expect(error.message).toContain("did not finish");
    expect(error.events.map((event) => event.subtype)).toEqual(["init"]);
    expect(error.costUSD).toBeNull();
  });

  test("judge reports the HTTP status of a failed call", async () => {
    fake("error");
    await expect(judge({ prompt: "x", schema, model: "m" })).rejects.toThrow("HTTP 429");
  });

  test("a call the API refused before it did anything runs once more, and only once", async () => {
    fake("refused", { FAKE_CLAUDE_OUTPUT: '{"verdict":"pass"}', FAKE_CLAUDE_COST: "0.02" });
    // The cost includes the refused try's; the second try asks claude-api for the subscription.
    expect(await judge({ prompt: "x", schema, model: "m" })).toMatchObject({ output: { verdict: "pass" }, costUSD: 0.04 });
    expect(calls().map((call) => call.subscription)).toEqual([undefined, "1"]);
    rmSync(join(scratch, "log.jsonl"));
    fake("refused", { FAKE_CLAUDE_REFUSALS: "2" });
    await expect(judge({ prompt: "x", schema, model: "m" })).rejects.toThrow("HTTP 400");
    expect(calls()).toHaveLength(2);
    rmSync(join(scratch, "log.jsonl"));
    fake("refused", { FAKE_CLAUDE_REFUSALS: "1", FAKE_CLAUDE_THEN: "task", FAKE_CLAUDE_TEXT: "done", FAKE_CLAUDE_REFUSAL_MS: "300" });
    const run = await runTask({ prompt: "x", cwd: scratch, env: { KEEP: "1" } });
    expect([run.ok, run.finalText, run.costUSD, calls().map((call) => call.subscription)]).toEqual([true, "done", 0.04, [undefined, "1"]]);
    // The duration includes the refused try's.
    expect(run.durationMs).toBeGreaterThanOrEqual(300);
    rmSync(join(scratch, "log.jsonl"));
    // Any other failure is not retried.
    fake("error");
    await expect(judge({ prompt: "x", schema, model: "m" })).rejects.toThrow("HTTP 429");
    expect(calls()).toHaveLength(1);
  });

  test("runTask passes the session options and returns the outcome", async () => {
    fake("task", { FAKE_CLAUDE_TEXT: "all done", FAKE_CLAUDE_WRITE: "out/answer.txt=42", FAKE_CLAUDE_COST: "0.5" });
    const cwd = mkdtempSync(join(scratch, "task-"));
    const run = await runTask({ prompt: "do it", cwd, model: "claude-haiku-5-5", effort: "low", agent: "explorer", settings: '{"a":1}', tools: ["Read", "Edit"], budgetUsd: 1, addDirs: ["/x", "/y"] });
    expect([run.ok, run.finalText, run.costUSD, run.turns]).toEqual([true, "all done", 0.5, 1]);
    expect(readFileSync(join(cwd, "out", "answer.txt"), "utf8")).toBe("42");
    const [call] = calls();
    expect(call.args).toEqual(expect.arrayContaining(["--agent", "explorer", "--settings", '{"a":1}', "--tools", "Read,Edit", "--effort", "low", "--no-session-persistence"]));
    expect(call.args.join(" ")).toContain("--add-dir /x --add-dir /y");
    // The user's MCP servers load unless strictMcp says otherwise.
    expect(call.args).not.toContain("--strict-mcp-config");
    await runTask({ prompt: "do it", cwd, strictMcp: true });
    expect(calls()[1].args).toContain("--strict-mcp-config");
    expect(calls()[1].args).not.toContain("--mcp-config");
  });

  test("runTask with readEffort reads the effort from the transcript, then deletes it", async () => {
    const config = join(scratch, "config");
    fake("task");
    const cwd = mkdtempSync(join(scratch, "task-"));
    // Session variables such as CLAUDE_CONFIG_DIR do not reach the session unless passed in env.
    const run = await runTask({ prompt: "do it", cwd, effort: "low", readEffort: true, env: { CLAUDE_CONFIG_DIR: config } });
    const [call] = calls();
    expect(call.args).not.toContain("--no-session-persistence");
    expect(call.args[call.args.indexOf("--session-id") + 1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(run.efforts).toEqual({ low: 1 });
    // The fake wrote the transcript and a subagent folder in the project folder; all are gone.
    expect(readdirSync(join(config, "projects"))).toEqual([]);
    // Without readEffort the session is not saved and no efforts are returned.
    const plain = await runTask({ prompt: "do it", cwd, effort: "low" });
    expect(calls()[1].args).toContain("--no-session-persistence");
    expect(calls()[1].args).not.toContain("--session-id");
    expect(plain.efforts).toBeUndefined();
  });

  test("runTask with readEffort counts each message once and skips subagents", async () => {
    const config = join(scratch, "config");
    const script = join(scratch, "efforts.js");
    // Two records of one message, a second message and a subagent message.
    writeFileSync(script, `export default ({ emit }) => {
      emit({ type: "system", subtype: "init", tools: [] });
      for (const [id, parent] of [["m1", null], ["m1", null], ["m2", null], ["s1", "toolu_1"]])
        emit({ type: "assistant", parent_tool_use_id: parent, message: { id, model: "m", content: [] } });
      emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0, num_turns: 2, result: "ok" });
    };`);
    fake("script", { FAKE_CLAUDE_SCRIPT: script, FAKE_CLAUDE_EFFORT: "xhigh" });
    const cwd = mkdtempSync(join(scratch, "task-"));
    expect((await runTask({ prompt: "x", cwd, effort: "low", readEffort: true, env: { CLAUDE_CONFIG_DIR: config } })).efforts).toEqual({ xhigh: 2 });
  });

  test("runTask with readEffort deletes the transcript of a failed session and of a refused try", async () => {
    const config = join(scratch, "config");
    const cwd = mkdtempSync(join(scratch, "task-"));
    const project = join(config, "projects", projectName(realpathSync(cwd)));
    // A session that saved its transcript and a subagent folder, then crashed.
    const script = join(scratch, "crash.js");
    writeFileSync(script, `import { mkdirSync, writeFileSync } from "node:fs";
      export default ({ option }) => {
        mkdirSync(${JSON.stringify(project)} + "/" + option("--session-id") + "/subagents", { recursive: true });
        writeFileSync(${JSON.stringify(project)} + "/" + option("--session-id") + ".jsonl", "{}\\n");
        process.exit(3);
      };`);
    fake("script", { FAKE_CLAUDE_SCRIPT: script });
    const env = { CLAUDE_CONFIG_DIR: config };
    // Another session in the same project stays, and so does the project folder.
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "other.jsonl"), "{}\n");
    await expect(runTask({ prompt: "x", cwd, readEffort: true, env })).rejects.toThrow("exit 3");
    expect(readdirSync(project)).toEqual(["other.jsonl"]);
    rmSync(join(project, "other.jsonl"));
    // A refused try and its retry use separate sessions; the efforts are the retry's.
    rmSync(join(scratch, "log.jsonl"));
    fake("refused", { FAKE_CLAUDE_THEN: "task", FAKE_CLAUDE_EFFORT: "medium" });
    const run = await runTask({ prompt: "x", cwd, readEffort: true, env });
    const ids = calls().map((call) => call.args[call.args.indexOf("--session-id") + 1]);
    expect(new Set(ids).size).toBe(2);
    expect(run.efforts).toEqual({ medium: 1 });
    expect(existsSync(project)).toBe(false);
  });

  test("runTask with readEffort returns null efforts when no transcript was saved", async () => {
    const cwd = mkdtempSync(join(scratch, "task-"));
    // Exiting before the fake saves leaves no transcript, as a CLI that ignored
    // --session-id would.
    const script = join(scratch, "nosave.js");
    writeFileSync(script, `export default ({ emit }) => { emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0, num_turns: 1, result: "ok" }); process.exit(0); };`);
    fake("script", { FAKE_CLAUDE_SCRIPT: script });
    const run = await runTask({ prompt: "x", cwd, readEffort: true, env: { CLAUDE_CONFIG_DIR: join(scratch, "config") } });
    expect([run.ok, run.efforts]).toEqual([true, null]);
  });

  test("runTask fails with the exit status when there is no stream", async () => {
    fake("exit", { FAKE_CLAUDE_EXIT: "5" });
    await expect(runTask({ prompt: "x", cwd: scratch })).rejects.toThrow("exit 5");
  });
});

describe("default binary", () => {
  test("is the API-first wrapper, which exists and is executable", () => {
    expect(API_FIRST.endsWith("claude/bin/claude-api")).toBe(true);
    expect(statSync(API_FIRST).mode & 0o111).toBeGreaterThan(0);
  });
});

describe("cli", () => {
  test("prints usage, rejects unknown commands", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(await main([])).toBe(2);
    expect(await main(["nope"])).toBe(2);
  });
});
