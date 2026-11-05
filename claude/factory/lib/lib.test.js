import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../cli.js";
import { ClaudeCallError, judge, runTask } from "./claude.js";
import { normalizeUsage, requestCost } from "./pricing.js";
import { appendJsonl, readJsonl, readJson, stateDir, statePath, writeJsonAtomic } from "./state.js";
import { Transcript, usage, writeProjects } from "./testing/transcripts.js";
import { isAutomation, loadSessions, parseSession, readRecords, sessionFiles } from "./transcripts.js";

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
      expect(session.toolCalls.map((call) => [call.name, call.ok])).toEqual([["Bash", false], ["Read", true]]);
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

  test("estimates cost with subagents when there is no cost-state", () => {
    const main = new Transcript().prompt("go").text("ok", { use: usage(0, 1e6, { cacheRead: 0, cacheWrite: 0 }) });
    const agent = new Transcript({ sessionId: main.sessionId }).text("found", { model: "claude-haiku-5-5", effort: "xhigh", use: usage(0, 1e6, { cacheRead: 0, cacheWrite: 0 }) });
    const root = writeProjects([{ transcript: main, subagents: [{ id: "agent-a1", meta: { agentType: "explorer", description: "look" }, transcript: agent }] }]);
    try {
      const [session] = loadSessions({ root });
      expect(session.costSource).toBe("estimated");
      expect(session.costUSD).toBeCloseTo(20 + 0.5);
      expect(session.subagents).toEqual([expect.objectContaining({ id: "agent-a1", agentType: "explorer", model: "claude-haiku-5-5", effort: "xhigh", costUSD: 0.5, toolCalls: 0 })]);
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
    expect(existsSync(call.cwd)).toBe(false);
  });

  test.each(["tool", "mcp", "error", "malformed"])("judge fails closed on %s", async (mode) => {
    fake(mode);
    await expect(judge({ prompt: "x", schema, model: "m" })).rejects.toBeInstanceOf(ClaudeCallError);
  });

  test("judge reports the HTTP status of a failed call", async () => {
    fake("error");
    await expect(judge({ prompt: "x", schema, model: "m" })).rejects.toThrow("HTTP 429");
  });

  test("runTask passes the session options and returns the outcome", async () => {
    fake("task", { FAKE_CLAUDE_TEXT: "all done", FAKE_CLAUDE_WRITE: "out/answer.txt=42", FAKE_CLAUDE_COST: "0.5" });
    const cwd = mkdtempSync(join(scratch, "task-"));
    const run = await runTask({ prompt: "do it", cwd, model: "claude-haiku-5-5", effort: "low", agent: "explorer", settings: '{"a":1}', tools: ["Read", "Edit"], budgetUsd: 1 });
    expect([run.ok, run.finalText, run.costUSD, run.turns]).toEqual([true, "all done", 0.5, 1]);
    expect(readFileSync(join(cwd, "out", "answer.txt"), "utf8")).toBe("42");
    const [call] = calls();
    expect(call.args).toEqual(expect.arrayContaining(["--agent", "explorer", "--settings", '{"a":1}', "--tools", "Read,Edit", "--effort", "low", "--no-session-persistence"]));
  });

  test("runTask fails with the exit status when there is no stream", async () => {
    fake("exit", { FAKE_CLAUDE_EXIT: "5" });
    await expect(runTask({ prompt: "x", cwd: scratch })).rejects.toThrow("exit 5");
  });
});

describe("cli", () => {
  test("prints usage, rejects unknown commands", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(await main([])).toBe(2);
    expect(await main(["nope"])).toBe(2);
  });
});
