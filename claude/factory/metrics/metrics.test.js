import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../cli.js";
import { LITELLM_FILE, LITELLM_URL } from "../lib/litellm.js";
import { readJson, readJsonl, writeJsonAtomic } from "../lib/state.js";
import { codexUsage, Rollout, writeRollouts } from "../lib/testing/codex.js";
import { Transcript, usage, writeProjects } from "../lib/testing/transcripts.js";
import { run } from "./cli.js";
import { CACHE_FILE, OPEN_TTL_MS } from "./github.js";

const FAKE_GH = join(import.meta.dir, "testing", "fake-gh.js");
// The week ending UNTIL is the window; the week before it is the previous window.
const UNTIL = "2026-11-08T00:00:00.000Z";
const WINDOW = ["--days", "7", "--until", UNTIL];
const at = (iso) => Date.parse(iso);
const free = usage(0, 0, { cacheRead: 0, cacheWrite: 0 });

let scratch;
let projects;
let output;
let logSpy;
const saved = {};
const setEnv = (values) => {
  for (const [name, value] of Object.entries(values)) {
    if (!(name in saved)) saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "claude-factory-metrics-"));
  projects = join(scratch, "config", "projects");
  setEnv({
    CLAUDE_CONFIG_DIR: join(scratch, "config"),
    CODEX_HOME: join(scratch, "codex"),
    CLAUDE_FACTORY_STATE: join(scratch, "state"),
    CLAUDE_FACTORY_GH: FAKE_GH,
    FAKE_GH_DATA: join(scratch, "gh.json"),
    FAKE_GH_LOG: join(scratch, "gh.log"),
  });
  gh({});
  // A fresh price list, so runs with GitHub lookups never fetch LiteLLM's.
  writeJsonAtomic(join(scratch, "state", LITELLM_FILE), { fetchedAt: new Date().toISOString(), source: LITELLM_URL, prices: {
    "gpt-listed": { input_cost_per_token: 2e-6, output_cost_per_token: 10e-6, cache_read_input_token_cost: 0.1e-6 },
  } });
  output = [];
  logSpy = spyOn(console, "log").mockImplementation((...args) => output.push(args.join(" ")));
});

afterEach(() => {
  logSpy.mockRestore();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  rmSync(scratch, { recursive: true, force: true });
});

const gh = (data) => writeFileSync(join(scratch, "gh.json"), JSON.stringify(data));
const ghCalls = () => (existsSync(join(scratch, "gh.log")) ? readFileSync(join(scratch, "gh.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
const write = (sessions) => writeProjects(sessions, projects);

async function report(...args) {
  output.length = 0;
  expect(await run([...WINDOW, "--json", ...args])).toBe(0);
  return JSON.parse(output.join("\n"));
}

const session = (start, { cost = 1, cwd = "/Users/test/app", prompts = ["Do the task"] } = {}) => {
  const transcript = new Transcript({ start: at(start), cwd });
  for (const text of prompts) transcript.prompt(text).text("ok", { use: free });
  return transcript.costState(cost);
};

const pr = (number, fields = {}) => ({
  number, url: `https://github.com/o/r/pull/${number}`, title: `Change ${number}`, state: "MERGED", createdAt: "2026-11-02T00:00:00Z",
  mergedAt: "2026-11-03T00:00:00Z", closedAt: "2026-11-03T00:00:00Z", additions: 10, deletions: 2, headRefName: `b${number}`, ...fields,
});

describe("windows", () => {
  test("splits sessions by last activity into the window and the previous one", async () => {
    write([
      { transcript: session("2026-11-03T10:00:00Z", { cost: 4 }) },
      // Started in the previous window, last active in this one.
      { transcript: session("2026-10-31T23:59:00Z", { cost: 2, prompts: ["a", "b", "c", "d", "e"] }).prompt("late").meta({ type: "x", timestamp: "2026-11-02T00:00:00Z" }) },
      { transcript: session("2026-10-28T10:00:00Z", { cost: 3 }) },
      { transcript: session("2026-10-20T10:00:00Z", { cost: 100 }) },
      { transcript: session("2026-11-09T10:00:00Z", { cost: 100 }) },
    ]);
    const { current, previous, window, previousWindow } = await report("--no-gh");
    expect(window).toEqual({ since: "2026-11-01T00:00:00.000Z", until: UNTIL, days: 7 });
    expect(previousWindow).toEqual({ since: "2026-10-25T00:00:00.000Z", until: "2026-11-01T00:00:00.000Z" });
    expect([current.sessions, current.cost.totalUSD, current.cost.medianUSD]).toEqual([2, 6, 3]);
    expect(current.prompts).toEqual({ total: 7, meanPerSession: 3.5, medianPerSession: 3.5 });
    expect(current.cost.sources).toEqual({ "cost-state": 2, estimated: 0 });
    expect([previous.sessions, previous.cost.totalUSD]).toEqual([1, 3]);
  });

  test("--since sets the window; bad options fail with usage", async () => {
    write([{ transcript: session("2026-11-06T10:00:00Z") }, { transcript: session("2026-11-03T10:00:00Z") }]);
    output.length = 0;
    expect(await run(["--since", "2026-11-05T00:00:00Z", "--until", UNTIL, "--no-gh", "--json"])).toBe(0);
    const json = JSON.parse(output.join("\n"));
    expect([json.window.days, json.current.sessions, json.previous.sessions]).toEqual([3, 1, 1]);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await run(["--days", "7", "--since", "2026-11-01"])).toBe(2);
      expect(await run(["--days", "0"])).toBe(2);
      expect(await run(["--since", "yesterday"])).toBe(2);
      expect(await run(["--bogus"])).toBe(2);
    } finally {
      errors.mockRestore();
    }
    expect(await run(["--help"])).toBe(0);
    expect(output.at(-1)).toContain("--include-automation");
  });

  test("excludes automation sessions unless asked, and filters by project", async () => {
    write([
      { transcript: session("2026-11-03T10:00:00Z", { cost: 1 }), project: "-Users-test-app" },
      { transcript: session("2026-11-03T11:00:00Z", { cost: 5, cwd: "/private/tmp/fixture" }), project: "-private-tmp-fixture" },
      { transcript: session("2026-11-03T12:00:00Z", { cost: 7, cwd: "/Users/test/other" }), project: "-Users-test-other" },
    ]);
    const plain = await report("--no-gh");
    expect([plain.current.sessions, plain.excluded.automation]).toEqual([2, 1]);
    expect(plain.projects.map((project) => [project.label, project.current.sessions])).toEqual([["/Users/test/other", 1], ["/Users/test/app", 1]]);
    expect((await report("--no-gh", "--include-automation")).current.sessions).toBe(3);
    const filtered = await report("--no-gh", "--project", "OTHER");
    expect([filtered.current.sessions, filtered.current.cost.totalUSD, filtered.excluded.project]).toEqual([1, 7, 1]);
  });
});

describe("session metrics", () => {
  test("prompts, corrections, interrupts, errors, compactions, subagents and model mix", async () => {
    const main = new Transcript({ start: at("2026-11-03T10:00:00Z") })
      .prompt("no, this first prompt is the task")
      .tool("Bash", { command: "bun test" }, "1 fail", { isError: true })
      .tool("Read", { file_path: "/a" }, "x")
      .tool("Read", { file_path: "/b" }, "y")
      .tool("Read", { file_path: "/c" }, "z")
      .interrupt()
      .prompt("you forgot the tests")
      .apiError(429)
      .apiError(429)
      .apiError(500)
      .compact()
      .prompt("Update on pull request #3 (https://github.com/o/r/pull/3), which T3 Code is watching for you:\n- Checks failed")
      .prompt("no problem, thanks")
      .text("done", { use: usage(0, 1e6, { cacheRead: 0, cacheWrite: 0 }) });
    const agent = new Transcript({ sessionId: main.sessionId, start: at("2026-11-03T10:05:00Z") })
      .tool("Grep", { pattern: "x" }, "nothing", { isError: true, model: "claude-haiku-5-5", use: usage(0, 1e6, { cacheRead: 0, cacheWrite: 0 }) })
      .tool("Read", { file_path: "/d" }, "x", { model: "claude-haiku-5-5", use: free });
    write([{ transcript: main, subagents: [{ id: "agent-1", meta: { agentType: "explorer" }, transcript: agent }] }]);
    const { current, notes } = await report("--no-gh");
    expect(current.prompts.total).toBe(3);
    expect(current.corrections).toEqual({ heuristic: true, followUps: 2, corrections: 1, rate: 0.5 });
    expect(current.interrupts).toEqual({ total: 1, perSession: 1 });
    expect(current.toolErrors).toEqual({ main: { known: 4, errors: 1, rate: 0.25 }, subagents: { calls: 2, errors: 1, rate: 0.5 } });
    expect(current.apiErrors).toEqual({ 429: 2, 500: 1 });
    expect(current.compactions).toEqual({ total: 1, perSession: 1 });
    // $20 of Opus output in the main session and $0.50 of Haiku output in the subagent.
    expect(current.cost.sources).toEqual({ "cost-state": 0, estimated: 1 });
    expect(current.cost.totalUSD).toBeCloseTo(20.5, 1);
    expect(current.subagents.runs).toBe(1);
    expect(current.subagents.share).toBeCloseTo(0.5 / 20.5);
    expect(current.modelMix.map(({ role, model, runs, messages, costUSD }) => [role, model, runs, messages, Number(costUSD.toFixed(1))])).toEqual([
      ["main", "claude-opus-5-5", 1, 5, 20],
      ["explorer", "claude-haiku-5-5", 1, 2, 0.5],
    ]);
    expect(notes.some((note) => note.includes("1 prompts were host notices"))).toBe(true);
  });

  test("lists the five costliest sessions with their titles", async () => {
    write([1, 9, 3, 7, 5, 2].map((cost, index) => ({ transcript: session(`2026-11-0${index + 2}T10:00:00Z`, { cost }).title(`Task ${cost}`) })));
    const { topSessions } = await report("--no-gh");
    expect(topSessions.map((entry) => [entry.title, entry.costUSD, entry.prompts])).toEqual([["Task 9", 9, 1], ["Task 7", 7, 1], ["Task 5", 5, 1], ["Task 3", 3, 1], ["Task 2", 2, 1]]);
  });

  test("counts only a fork's own records and notes the fork", async () => {
    const parent = session("2026-11-03T10:00:00Z");
    const fork = new Transcript({ start: at("2026-11-03T10:00:00Z") })
      .prompt("Do the task", { forkedFrom: { sessionId: parent.sessionId, messageUuid: "m" } })
      .prompt("now something else");
    write([{ transcript: parent }, { transcript: fork }]);
    const { notes, current } = await report("--no-gh");
    expect(notes).toContainEqual(expect.stringContaining(`is a fork of ${parent.sessionId.slice(0, 8)}, also counted here; only its own records count`));
    // The parent's one prompt and the fork's own one; the copied prompt is not counted again.
    expect(current.prompts.total).toBe(2);
  });

  test("splits sessions a person ran from agent-launched ones", async () => {
    write([
      { transcript: session("2026-11-03T10:00:00Z", { cost: 2 }) },
      { transcript: new Transcript({ start: at("2026-11-03T11:00:00Z") }).prompt("Act as the review sub-agent for this task.").costState(5) },
    ]);
    const { current } = await report("--no-gh");
    expect(current.origin).toEqual({ person: { sessions: 1, costUSD: 2 }, agent: { sessions: 1, costUSD: 5 } });
  });

  test("includes Codex sessions: subagents, tokens, prompts, PRs and the shared project", async () => {
    write([{ transcript: session("2026-11-03T10:00:00Z", { cost: 2, cwd: "/Users/test/app" }), project: "-Users-test-app" }]);
    const none = { cached: 0, reasoning: 0 };
    const parent = new Rollout({ start: at("2026-11-04T10:00:00Z"), cwd: "/Users/test/app", model: "gpt-main" })
      .prompt("Ship the change")
      .response(codexUsage(1_000_000, 0, none));
    const worker = new Rollout({ parent, role: "worker", model: "gpt-small" })
      .exec("bad()", "Script failed\nOutput:\n", { use: codexUsage(500_000, 0, none) });
    parent.exec('text(await tools.exec_command({cmd:"gh pr create --fill"}))', "Script completed\nOutput:\nhttps://github.com/o/r/pull/9\n", { use: codexUsage(0, 0, none) })
      .prompt("no, use a draft PR")
      .interrupt();
    const old = new Rollout({ start: at("2026-10-28T10:00:00Z"), cwd: "/Users/test/app" }).prompt("Earlier").response();
    writeRollouts([parent, worker, old], join(scratch, "codex", "sessions"));
    const { current, previous, projects, prs, notes } = await report("--no-gh");
    expect([current.sessions, previous.sessions]).toEqual([2, 1]);
    expect(current.harness.claude).toMatchObject({ sessions: 1, costUSD: 2, unpricedSessions: 0 });
    // The unpriced Codex session does not count toward the cost quantiles.
    expect([current.cost.medianUSD, current.cost.p90USD]).toEqual([2, 2]);
    expect(current.harness.codex).toEqual({ sessions: 1, costUSD: 0, unpricedSessions: 1, tokens: 1_500_000, subagentRuns: 1 });
    expect(previous.harness.codex.sessions).toBe(1);
    expect(current.prompts.total).toBe(3);
    expect(current.corrections).toMatchObject({ followUps: 1, corrections: 1 });
    expect(current.interrupts.total).toBe(1);
    expect(current.toolErrors.subagents).toEqual({ calls: 1, errors: 1, rate: 1 });
    expect(current.modelMix.filter((row) => row.model.startsWith("gpt")).map(({ role, model, runs, messages, tokens }) => [role, model, runs, messages, tokens]))
      .toEqual([["main", "gpt-main", 1, 2, 1_000_000], ["worker", "gpt-small", 1, 1, 500_000]]);
    expect(projects.map((project) => [project.project, project.current.sessions])).toEqual([["-Users-test-app", 2]]);
    expect(prs.map((pr) => [pr.number, pr.sessions.length])).toEqual([[9, 1]]);
    expect(notes).toContainEqual(expect.stringContaining("Codex sessions: subagent threads count with their root"));
    const markdown = readFileSync(join(scratch, "state", "reports", "metrics-2026-11-08.md"), "utf8");
    expect(markdown).toContain("| Codex sessions | 1 | 1 | 0 |");
    expect(markdown).toContain("Codex 1 sessions, $0.00, 1.5M tokens, 1 subagent runs (1 sessions unpriced)");
    expect(readJsonl(join(scratch, "state", "metrics-history.jsonl"))[0]).toMatchObject({ codexSessions: 1, codexTokens: 1_500_000 });
    // History marks runs from before Codex was read.
    const [entry] = readJsonl(join(scratch, "state", "metrics-history.jsonl"));
    const { codexSessions, codexTokens, ...legacy } = entry;
    writeFileSync(join(scratch, "state", "metrics-history.jsonl"), `${JSON.stringify(legacy)}\n${JSON.stringify(entry)}\n`);
    output.length = 0;
    expect(await run(["--history"])).toBe(0);
    const rows = output.join("\n").split("\n");
    expect(rows[0]).toContain("| Sessions | Codex sessions |");
    expect(rows[2]).toContain("| 2 | not read |");
    expect(rows[3]).toContain("| 2 | 1 |");
  });

  test("prices models missing from the table from the cached LiteLLM list and notes them", async () => {
    const none = { cached: 0, reasoning: 0 };
    const priced = new Rollout({ start: at("2026-11-04T10:00:00Z"), cwd: "/Users/test/app", model: "gpt-listed" })
      .prompt("Ship the change")
      .response(codexUsage(1_000_000, 100_000, { cached: 500_000, reasoning: 0 }));
    const unknown = new Rollout({ start: at("2026-11-05T10:00:00Z"), cwd: "/Users/test/app", model: "gpt-unlisted" }).prompt("Other").response(codexUsage(10, 10, none));
    writeRollouts([priced, unknown], join(scratch, "codex", "sessions"));
    // Without --no-gh: the fresh fixture list is not fetched again.
    const fetchSpy = spyOn(globalThis, "fetch");
    const { current, notes } = await report();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    // 500K uncached input at $2, 500K cached at $0.10 and 100K output at $10 per MTok.
    expect(current.harness.codex).toMatchObject({ sessions: 2, unpricedSessions: 1 });
    expect(current.harness.codex.costUSD).toBeCloseTo(1 + 0.05 + 1);
    expect(notes).toContainEqual(expect.stringMatching(/^Priced from LiteLLM's list \(fetched \d{4}-\d\d-\d\d\), as the price table lacks them: gpt-listed\.$/));
  });
});

describe("pull requests", () => {
  // A links PR 1 by a pr-link record and PR 2 by gh pr create output; B links PR 2 only.
  // A Bash call that is not gh pr create links nothing.
  const linked = () => {
    const a = session("2026-11-03T10:00:00Z", { cost: 10, prompts: ["one", "two"] })
      .prLink("https://github.com/o/r/pull/1")
      .tool("Bash", { command: "git push -u origin b && gh pr create --fill" }, "remote: https://github.com/o/r/pull/new/b\nhttps://github.com/o/r/pull/2\n")
      .tool("Bash", { command: "gh pr view 3 --web" }, "https://github.com/o/r/pull/3");
    const b = session("2026-11-04T10:00:00Z", { cost: 4 }).tool("Bash", { command: "gh pr create --draft" }, "https://github.com/o/r/pull/2");
    write([{ transcript: a }, { transcript: b }]);
    return { a, b };
  };

  test("links PRs from both sources and splits session cost evenly across them", async () => {
    const { a, b } = linked();
    const { prs, current } = await report("--no-gh");
    expect(prs.map((entry) => [entry.number, entry.sessions.length, entry.costUSD, entry.prompts, entry.state])).toEqual([[2, 2, 9, 2, null], [1, 1, 5, 1, null]]);
    expect(prs[0].sessions.sort()).toEqual([a.sessionId, b.sessionId].sort());
    expect([current.prs.linked, current.prs.merged, current.prs.costPerMergedUSD]).toEqual([2, null, null]);
    expect(ghCalls()).toEqual([]);
  });

  test("counts branches pushed, each once, and shows them in the report", async () => {
    write([
      { transcript: session("2026-11-03T10:00:00Z").tool("Bash", { command: "git push -u origin b" }, "remote: https://github.com/o/r/pull/new/b\nTo https://github.com/o/r.git\n * [new branch]      b -> b\n") },
      { transcript: session("2026-11-04T10:00:00Z").tool("Bash", { command: "git push" }, "To https://github.com/o/r.git\n   abc1234..def5678  b -> b\n   1234567..89abcde  c -> c\n") },
      { transcript: session("2026-11-04T12:00:00Z").tool("Bash", { command: "git push -q" }, "") },
    ]);
    const { current } = await report("--no-gh");
    expect(current.pushes).toEqual({ branches: 2, created: 1, sessions: 2 });
    const markdown = readFileSync(join(scratch, "state", "reports", "metrics-2026-11-08.md"), "utf8");
    expect(markdown).toMatch(/\| Branches pushed \| 2 \|/);
    expect(markdown).toContain("Branches pushed: 2 (1 new) from 2 sessions");
  });

  test("merged-PR cost and prompts use GitHub state; reverts are found once per repository", async () => {
    linked();
    gh({
      prs: { "https://github.com/o/r/pull/1": pr(1), "https://github.com/o/r/pull/2": pr(2, { title: "Add widget", mergedAt: "2026-11-04T12:00:00Z" }) },
      reverts: { "o/r": [
        { number: 8, title: 'Revert "Add widget"', body: "", url: "https://github.com/o/r/pull/8", mergedAt: "2026-11-05T00:00:00Z" },
        { number: 9, title: "Reverting nothing related", body: "#1", url: "https://github.com/o/r/pull/9", mergedAt: "2026-11-05T00:00:00Z" },
      ] },
    });
    const { prs, current } = await report();
    expect(current.prs).toMatchObject({ linked: 2, known: 2, merged: 2, open: 0, closed: 0, reverted: 1 });
    expect(current.prs.costPerMergedUSD).toBe(7);
    expect(current.prs.spendPerMergedUSD).toBe(7);
    expect(current.prs.promptsPerMerged).toBe(1.5);
    expect(prs.find((entry) => entry.number === 2)).toMatchObject({ title: "Add widget", state: "MERGED", additions: 10, revertedBy: { number: 8 } });
    expect(prs.find((entry) => entry.number === 1).revertedBy).toBeNull();
    expect(ghCalls().filter((args) => args[1] === "list")).toEqual([["pr", "list", "--repo", "o/r", "--state", "merged", "--search", "Revert in:title", "--json", "number,title,body,url,mergedAt", "--limit", "100"]]);
  });

  test("cost per merged PR leaves out PRs of sessions with an unknown cost", async () => {
    write([{ transcript: session("2026-11-03T10:00:00Z", { cost: 6 }).prLink("https://github.com/o/r/pull/1") }]);
    const codex = new Rollout({ start: at("2026-11-04T10:00:00Z") })
      .exec('tools.mcp__t3_code__link_pull_request({url:"https://github.com/o/r/pull/2"})');
    writeRollouts([codex], join(scratch, "codex", "sessions"));
    gh({ prs: { "https://github.com/o/r/pull/1": pr(1), "https://github.com/o/r/pull/2": pr(2) } });
    const { current } = await report();
    expect(current.prs).toMatchObject({ linked: 2, merged: 2, costPerMergedUSD: 6, spendPerMergedUSD: 6 });
    expect(current.prs.promptsPerMerged).toBe(0.5);
  });

  test("caches merged PRs for good and refreshes open ones after an hour", async () => {
    linked();
    gh({ prs: { "https://github.com/o/r/pull/1": pr(1), "https://github.com/o/r/pull/2": pr(2, { state: "OPEN", mergedAt: null, closedAt: null }) }, reverts: { "o/r": [] } });
    const views = () => ghCalls().filter((args) => args[1] === "view").map((args) => args[2]).sort();
    await report();
    expect(views()).toEqual(["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"]);
    await report();
    expect(views().length).toBe(2);
    const path = join(scratch, "state", CACHE_FILE);
    const cache = readJson(path);
    for (const entry of Object.values(cache.prs)) entry.fetchedAt -= OPEN_TTL_MS + 1000;
    writeJsonAtomic(path, cache);
    gh({ prs: { "https://github.com/o/r/pull/1": pr(1), "https://github.com/o/r/pull/2": pr(2) }, reverts: { "o/r": [] } });
    const { current } = await report();
    expect(views()).toEqual(["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2", "https://github.com/o/r/pull/2"]);
    expect(current.prs.merged).toBe(2);
  });

  test("a failing gh call becomes a note and the report still completes", async () => {
    linked();
    gh({ prs: { "https://github.com/o/r/pull/1": pr(1) } });
    const { prs, current, notes } = await report();
    expect(current.prs).toMatchObject({ linked: 2, known: 1, merged: 1 });
    expect(prs.find((entry) => entry.number === 2).state).toBeNull();
    expect(notes).toContainEqual(expect.stringContaining("gh pr view https://github.com/o/r/pull/2 failed (exit 1: GraphQL: Could not resolve"));
    expect(notes).toContainEqual(expect.stringContaining("gh pr list --repo o/r failed"));
    // A gh that cannot start at all is a failure too.
    setEnv({ CLAUDE_FACTORY_GH: join(scratch, "missing-gh") });
    rmSync(join(scratch, "state", CACHE_FILE));
    const missing = await report();
    expect(missing.current.prs.known).toBe(0);
    expect(missing.notes.filter((note) => note.startsWith("gh pr view"))).toHaveLength(2);
  });
});

// Code reviews (claude/CLAUDE.md, Review): the session starts the `reviewer` agent, then
// records each finding's outcome. Older sessions ran /code-review, whose skill runs forked,
// themselves or through a background wrapper agent with the fork as its child; every
// shape counts.
describe("code reviews", () => {
  // Opus output at $20 per million tokens: dollars as output tokens.
  const spend = (usd) => ({ use: usage(0, usd * 50_000, { cacheRead: 0, cacheWrite: 0 }) });
  const finding = (category, summary, outcome) => ({ file: "a.js", line: 1, summary, failure_scenario: "f", category, ...(outcome ? { outcome } : {}) });
  // The forked review agent's first prompt is the review recipe.
  const recipe = (start) => new Transcript({ start: at(start) }).prompt("Review target: `HEAD`\n\n`xhigh effort → 10 inline angles`");

  function reviewed() {
    // A: a background review. The wrapper ($1) has a forked child ($2), which starts a
    // web-fetch agent ($0.50); the wrapper also starts an agent that runs its own low
    // review ($1). The session lists the findings, then records outcomes in two calls; an
    // interrupted call records nothing.
    const a = new Transcript({ start: at("2026-11-03T10:00:00Z") })
      .prompt("Ship the change")
      .tool("Agent", { description: "Review the commit", prompt: "Run /code-review xhigh origin/main...abc1234", run_in_background: true }, "started", { use: free })
      .tool("ReportFindings", { findings: [finding("correctness", "a"), finding("simplification", "b")] }, "ok", { use: free })
      .tool("ReportFindings", { level: "xhigh", findings: [finding("correctness", "a", "fixed"), finding("Correctness", "c", "no_change_needed")] }, "ok", { use: free })
      .tool("ReportFindings", { findings: [finding("simplification", "b", "skipped"), finding("efficiency", "d", "fixed")] }, "ok", { use: free })
      .tool("ReportFindings", { findings: [finding("correctness", "a", "skipped")] }, "[Request interrupted by user for tool use]", { isError: true, use: free })
      .prLink("https://github.com/o/r/pull/1");
    const wrapper = new Transcript({ sessionId: a.sessionId, start: at("2026-11-03T10:01:00Z") })
      .tool("Skill", { skill: "code-review", args: "xhigh origin/main...abc1234" }, "15 findings", spend(1));
    const child = recipe("2026-11-03T10:01:30Z").text("findings", spend(2));
    const fetcher = new Transcript({ start: at("2026-11-03T10:01:40Z") }).prompt("Read the page").text("page", spend(0.5));
    const nested = new Transcript({ start: at("2026-11-03T10:02:00Z") }).prompt("Check it")
      .tool("Skill", { skill: "code-review", args: "low" }, "done", spend(1));
    // B: the main thread runs a medium review, records it, runs a high review with a flag
    // first, and has a review refused, then records a clean result. Each review forks an
    // agent ($1 and $2); a /simplify fork ($5) is not a review.
    const b = new Transcript({ start: at("2026-11-04T10:00:00Z") })
      .prompt("Review my change")
      .tool("Skill", { skill: "code-review", args: "medium" }, "done", { use: free })
      .tool("ReportFindings", { findings: [finding("efficiency", "e", "fixed")] }, "ok", { use: free })
      .tool("Skill", { skill: "code-review", args: "--max-findings all high" }, "done", { use: free })
      .tool("Skill", { skill: "code-review", args: "max" }, "The user doesn't want to proceed with this tool use.", { isError: true, use: free })
      .tool("ReportFindings", { findings: [] }, "ok", { use: free })
      .prLink("https://github.com/o/r/pull/2");
    const first = recipe("2026-11-04T10:00:01.500Z").text("findings", spend(1));
    const second = recipe("2026-11-04T10:00:05.500Z").text("findings", spend(2));
    const simplify = new Transcript({ start: at("2026-11-04T10:00:06Z") }).prompt("Simplify the change").text("done", spend(5));
    // C: no review; D: a review without a forked agent and two PRs.
    const c = session("2026-11-05T10:00:00Z").prLink("https://github.com/o/r/pull/3");
    const d = new Transcript({ start: at("2026-11-05T12:00:00Z") })
      .prompt("Review both")
      .tool("Skill", { skill: "code-review", args: "high HEAD~1" }, "done", { use: free })
      .prLink("https://github.com/o/r/pull/4")
      .prLink("https://github.com/o/r/pull/5");
    const forkMeta = { agentType: "general-purpose", spawnDepth: 1 };
    write([
      { transcript: a, subagents: [
        { id: "agent-w1", meta: { agentType: "general-purpose", toolUseId: "toolu_2", spawnDepth: 1 }, transcript: wrapper },
        { id: "agent-c1", meta: { agentType: "general-purpose", parentAgentId: "w1", spawnDepth: 2 }, transcript: child },
        { id: "agent-g1", meta: { agentType: "web-fetch", toolUseId: "toolu_9", parentAgentId: "c1", spawnDepth: 3 }, transcript: fetcher },
        { id: "agent-n1", meta: { agentType: "general-purpose", toolUseId: "toolu_8", parentAgentId: "w1", spawnDepth: 2 }, transcript: nested },
      ] },
      { transcript: b, subagents: [
        { id: "agent-f1", meta: forkMeta, transcript: first },
        { id: "agent-f2", meta: forkMeta, transcript: second },
        { id: "agent-s1", meta: forkMeta, transcript: simplify },
      ] },
      { transcript: c },
      { transcript: d },
    ]);
  }

  test("counts reviews by level, prices each from its agents, and reads recorded outcomes", async () => {
    reviewed();
    const { current, previous } = await report("--no-gh");
    const reviews = current.reviews;
    expect([reviews.reviews, reviews.sessions, reviews.byLevel]).toEqual([5, 3, { xhigh: 1, low: 1, medium: 1, high: 2 }]);
    // A's review $3.50 (wrapper, forked child and its web-fetch agent) and the nested low
    // review $1, counted once; B's $1 and $2, each from its own fork. D's has no forked
    // agent, so it is unpriced.
    expect(reviews.cost.totalUSD).toBeCloseTo(7.5);
    expect(reviews.cost.medianUSD).toBeCloseTo(1.5);
    expect([reviews.cost.unpriced, reviews.cost.mainThread]).toEqual([1, 3]);
    // Of the estimated total, the same base as the subagent share.
    expect(reviews.cost.share).toBeCloseTo((7.5 / current.subagents.costUSD) * current.subagents.share);
    // A's calls merge into one record of 4 findings; B records one review with 1 finding
    // and a clean one.
    expect(reviews.recorded).toMatchObject({
      triages: 3, findings: 5, medianPerTriage: 1,
      outcomes: { fixed: 3, no_change_needed: 1, skipped: 1 }, outcomeShares: { fixed: 0.6, no_change_needed: 0.2, skipped: 0.2 },
      fixedRate: 0.6, defectShare: 0.4,
    });
    expect(reviews.recorded.categories).toEqual([
      { category: "correctness", findings: 2, fixed: 1, no_change_needed: 1, skipped: 0 },
      { category: "efficiency", findings: 2, fixed: 2, no_change_needed: 0, skipped: 0 },
      { category: "simplification", findings: 1, fixed: 0, no_change_needed: 0, skipped: 1 },
    ]);
    // A and B linked one PR each; D's two PRs leave it out of rounds per change.
    expect(reviews.perChange).toEqual({ sessions: 2, mean: 2 });
    expect(reviews.reverts).toEqual({ reviewed: null, unreviewed: null });
    expect(previous.reviews).toMatchObject({ reviews: 0, recorded: { triages: 0, fixedRate: null } });
  });

  test("counts a reviewer agent run at the agent's effort and prices it from that agent", async () => {
    // One run with its agent ($2, with a web-fetch agent below it, $0.50), one whose agent
    // left no transcript, and one refused.
    const main = new Transcript({ start: at("2026-11-05T14:00:00Z") })
      .prompt("Ship the change")
      .tool("Agent", { description: "Review the commit", subagent_type: "reviewer", prompt: "origin/main...abc1234", run_in_background: true }, "started", { use: free })
      .tool("ReportFindings", { findings: [finding("docs", "a", "fixed")] }, "ok", { use: free })
      .tool("Agent", { subagent_type: "reviewer", prompt: "origin/main...def5678" }, "[]", { use: free })
      .tool("Agent", { subagent_type: "reviewer", prompt: "HEAD" }, "The user doesn't want to proceed with this tool use.", { isError: true, use: free })
      .tool("Agent", { subagent_type: "explorer", prompt: "Review the commit" }, "done", { use: free });
    const reviewer = new Transcript({ start: at("2026-11-05T14:00:10Z") }).prompt("origin/main...abc1234").text("[]", { ...spend(2), effort: "medium" });
    const fetcher = new Transcript({ start: at("2026-11-05T14:00:20Z") }).prompt("Read the page").text("page", spend(0.5));
    write([{ transcript: main, subagents: [
      { id: "agent-r1", meta: { agentType: "reviewer", toolUseId: "toolu_1", spawnDepth: 1 }, transcript: reviewer },
      { id: "agent-g1", meta: { agentType: "web-fetch", toolUseId: "toolu_9", parentAgentId: "r1", spawnDepth: 2 }, transcript: fetcher },
    ] }]);
    const { reviews } = (await report("--no-gh")).current;
    expect([reviews.reviews, reviews.sessions, reviews.byLevel]).toEqual([2, 1, { medium: 1, default: 1 }]);
    expect(reviews.cost.totalUSD).toBeCloseTo(2.5);
    expect([reviews.cost.unpriced, reviews.cost.mainThread]).toEqual([1, 0]);
    expect(reviews.recorded).toMatchObject({ triages: 1, findings: 1, outcomes: { fixed: 1 } });
  });

  test("compares the revert rate of reviewed and unreviewed merged PRs, and reports it all", async () => {
    reviewed();
    gh({
      prs: Object.fromEntries([1, 2, 3, 4, 5].map((number) => [`https://github.com/o/r/pull/${number}`, pr(number, { title: `Change ${number}` })])),
      reverts: { "o/r": [{ number: 9, title: 'Revert "Change 2"', body: "", url: "https://github.com/o/r/pull/9", mergedAt: "2026-11-06T00:00:00Z" }] },
    });
    const { current } = await report();
    expect(current.reviews.reverts).toEqual({
      reviewed: { merged: 4, reverted: 1, rate: 0.25 },
      unreviewed: { merged: 1, reverted: 0, rate: 0 },
    });
    const markdown = readFileSync(join(scratch, "state", "reports", "metrics-2026-11-08.md"), "utf8");
    expect(markdown).toContain("- Reviews: 5 (reviewer agent and /code-review runs, not counting refused or interrupted ones) in 3 sessions; levels: high 2, low 1, medium 1, xhigh 1.");
    expect(markdown).toContain("- Cost: $7.50, median $1.50 per review");
    expect(markdown).toContain("3 reviews ran in a session's main thread");
    expect(markdown).toContain("3 reviews recorded through ReportFindings, with 5 findings, median 1 per review. fixed 3 (60.0%), no change needed 1 (20.0%), skipped 1 (20.0%)");
    expect(markdown).toContain("Correctness, security or reliability findings: 40.0%");
    expect(markdown).toContain("Reverts: reviewed PRs 1 of 4 merged (25.0%); unreviewed PRs 0 of 1 merged (0.0%).");
    expect(markdown).toContain("| correctness | 2 | 1 | 1 | 0 |");
    expect(markdown).toContain("| Revert rate, reviewed merged PRs | 25.0% |");
    const [entry] = readJsonl(join(scratch, "state", "metrics-history.jsonl"));
    expect(entry).toMatchObject({ reviews: 5, recordedFindings: 5, findingsFixedRate: 0.6 });
    expect(entry.reviewCostUSD).toBeCloseTo(7.5);
  });
});

describe("outputs", () => {
  test("--json prints the report shape and writes both files", async () => {
    write([{ transcript: session("2026-11-03T10:00:00Z") }, { transcript: session("2026-10-30T10:00:00Z") }]);
    const json = await report("--no-gh");
    expect(Object.keys(json).sort()).toEqual(["current", "excluded", "filters", "generatedAt", "notes", "previous", "previousWindow", "projects", "prs", "topSessions", "window"]);
    expect(Object.keys(json.current).sort()).toEqual(["apiErrors", "compactions", "corrections", "cost", "harness", "interrupts", "modelMix", "origin", "prompts", "prs", "pushes", "reviews", "sessions", "subagents", "toolErrors"]);
    expect(json.filters).toEqual({ project: null, includeAutomation: false, gh: false });
    expect(json.projects[0]).toMatchObject({ project: "-Users-test-project", current: { sessions: 1 }, previous: { sessions: 1 } });
    const reports = join(scratch, "state", "reports");
    expect(readJson(join(reports, "metrics-2026-11-08.json"))).toEqual(json);
    const markdown = readFileSync(join(reports, "metrics-2026-11-08.md"), "utf8");
    for (const heading of ["## Headline", "## Cost", "### Costliest sessions", "## Effort and quality", "## Code reviews", "## Subagents and models", "## Projects", "## Pull requests", "## Notes"])
      expect(markdown).toContain(heading);
    expect(markdown).toContain("| Sessions | 1 | 1 | 0 |");
    expect(markdown).toContain("Correction rate (heuristic)");
  });

  test("prints the Markdown path; --out and a non-default window change the file", async () => {
    write([{ transcript: session("2026-11-03T10:00:00Z") }]);
    const out = join(scratch, "out");
    expect(await main(["metrics", "--days", "30", "--until", UNTIL, "--no-gh", "--out", out, "--project", "Test Project"])).toBe(0);
    expect(output.at(-1)).toBe(join(out, "metrics-2026-11-08-30d-test-project.md"));
    expect(existsSync(join(out, "metrics-2026-11-08-30d-test-project.json"))).toBe(true);
  });

  test("appends one history line per run and prints the trend with --history", async () => {
    write([{ transcript: session("2026-11-03T10:00:00Z", { cost: 2.5 }) }]);
    await report("--no-gh");
    await report("--no-gh", "--days", "3");
    const history = readJsonl(join(scratch, "state", "metrics-history.jsonl"));
    expect(history.map((entry) => [entry.days, entry.sessions, entry.costUSD])).toEqual([[7, 1, 2.5], [3, 0, 0]]);
    expect(history[0].report).toEndWith("metrics-2026-11-08.md");
    output.length = 0;
    expect(await run(["--history"])).toBe(0);
    const table = output.join("\n").split("\n");
    expect(table).toHaveLength(4);
    expect(table[2]).toContain("2026-11-01 to 2026-11-08");
    expect(table[2]).toContain("$2.50");
    output.length = 0;
    expect(await run(["--history", "--json"])).toBe(0);
    expect(JSON.parse(output.join("\n"))).toEqual(history);
  });
});
