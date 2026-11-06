import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexSessionsRoot, loadCodexSessions, normalizeCodexUsage, parseThread, projectKey, rolloutThreads } from "./codex.js";
import { codexUsage, Rollout, writeRollouts } from "./testing/codex.js";

let home;
let root;
let files;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claude-factory-codex-"));
  root = join(home, "sessions");
  files = {};
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const at = (iso) => Date.parse(iso);
const write = (rollouts) => writeRollouts(rollouts, root, files);
const load = (options) => loadCodexSessions({ root, ...options });
const touch = (id, iso) => {
  for (const file of files[id]) utimesSync(file, at(iso) / 1000, at(iso) / 1000);
};
const none = { cached: 0, reasoning: 0 };

describe("codex rollouts", () => {
  test("finds threads under CODEX_HOME, segments included, and keys projects like Claude Code", () => {
    expect(codexSessionsRoot({ CODEX_HOME: "/x/codex" })).toBe("/x/codex/sessions");
    expect(codexSessionsRoot({ HOME: "/ignored" })).toEndWith("/.codex/sessions");
    expect(projectKey("/Users/test/.config")).toBe("-Users-test--config");
    const long = new Rollout().prompt("a").response().continueInSegment().prompt("b").response();
    write([long, new Rollout({ start: at("2026-11-02T10:00:00Z") })]);
    writeFileSync(join(root, "notes.jsonl"), "{}\n");
    const threads = rolloutThreads(root);
    expect(threads.map((thread) => thread.files.length).sort()).toEqual([1, 2]);
    expect(threads.find((thread) => thread.id === long.id).files).toEqual(files[long.id]);
    expect(rolloutThreads(join(home, "missing"))).toEqual([]);
  });

  test("normalizes usage: cached and cache-written tokens are part of input", () => {
    expect(normalizeCodexUsage(codexUsage(1000, 100, { cached: 800, cacheWrite: 50 })))
      .toEqual({ input: 150, output: 100, cacheRead: 800, cacheWrite5m: 50, cacheWrite1h: 0 });
  });

  test("a session's prompts, models, usage, tool calls and events", () => {
    const rollout = new Rollout({ cwd: "/Users/test/app", model: "gpt-a", effort: "high" })
      .prompt("# AGENTS.md instructions", { kinds: ["agents_md.instructions"] })
      .prompt("<environment_context>", { kinds: ["environments.environment_context"] })
      .prompt("Fix the build", { kinds: ["user.text", "user.image"] })
      .response(codexUsage(1000, 100, { cached: 900 }))
      .exec('text(await tools.exec_command({cmd:"bun test"}))')
      .exec("throw new Error()", "Script failed\nWall time 0.1 seconds\nOutput:\nError")
      .exec("x", "aborted before dispatch")
      .call("spawn_agent", { task: "look" }, '{"task_name":"/root/look"}', { namespace: "collaboration" })
      .call("broken", {}, "collab spawn failed: agent thread limit reached")
      .interrupt()
      .complete({ error: "usage_limit_exceeded" })
      .compact()
      .turnContext("gpt-b", "low")
      .prompt("Update on pull request #4 (https://github.com/o/r/pull/4): checks passed")
      .prompt("no, keep the old name")
      .response(codexUsage(500, 50, none));
    write([rollout]);
    const [session] = load();
    expect(session).toMatchObject({
      id: rollout.id, harness: "codex", project: "-Users-test-app", cwd: "/Users/test/app", entrypoint: "T3 Code",
      origin: "person", hostPrompts: 1, interrupts: 1, compactions: 1, apiErrors: { usage_limit_exceeded: 1 },
      costUSD: 0, costSource: "estimated", unpriced: true, automation: false, malformedLines: 0, prLinks: [], subagents: [],
    });
    expect(session.prompts.map((prompt) => prompt.text)).toEqual(["Fix the build", "no, keep the old name"]);
    // Seven responses: one per answer and one after each tool call.
    expect(session.models).toEqual({ "gpt-a": 6, "gpt-b": 1 });
    expect(session.efforts).toEqual({ high: 6, low: 1 });
    expect(session.assistantMessages).toBe(7);
    expect(session.usage["gpt-b"]).toEqual({ input: 500, output: 50, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
    expect(session.usage["gpt-a"].cacheRead).toBe(900 + 5 * 800);
    expect(session.toolCalls.map((call) => [call.name, call.ok])).toEqual([
      ["exec", true], ["exec", false], ["exec", false], ["collaboration.spawn_agent", true], ["broken", false],
    ]);
    expect(session.toolCalls[0].input).toEqual({ input: 'text(await tools.exec_command({cmd:"bun test"}))' });
    expect(session.toolCalls[3].input).toEqual({ task: "look" });
    expect(session.startedAt).toBe(rollout.records[0].timestamp);
    expect(session.endedAt).toBe(rollout.records.at(-1).timestamp);
  });

  test("a long thread's segments count together, though their ordinals overlap", () => {
    const rollout = new Rollout({ model: "gpt-a" }).prompt("First").response(codexUsage(100, 0, none))
      .continueInSegment().turnContext("gpt-a").prompt("Second").response(codexUsage(200, 0, none))
      .continueInSegment().turnContext("gpt-a").response(codexUsage(300, 0, none));
    write([rollout]);
    const [session] = load();
    expect([session.prompts.length, session.assistantMessages, session.usage["gpt-a"].input]).toEqual([2, 3, 600]);
    expect(session.endedAt).toBe(rollout.records.at(-1).timestamp);
  });

  test("subagents count with their root session, without the parent history they copy", () => {
    const parent = new Rollout({ start: at("2026-11-01T10:00:00Z"), model: "gpt-main" }).prompt("Plan the work").response(codexUsage(100, 10, none));
    const worker = new Rollout({ parent, model: "gpt-small", effort: "medium", role: "worker", path: "/root/build" })
      .exec("build()", "Script failed\nOutput:\n")
      .response(codexUsage(200, 20, { cached: 100 }));
    const explorer = new Rollout({ parent, start: at("2026-11-01T11:00:00Z"), role: "explorer", path: "/root/look", model: "gpt-small" }).response();
    parent.call("wait_agent", {}, '{"message":"Wait completed."}', { namespace: "collaboration" });
    write([parent, worker, explorer]);
    const [session] = load();
    expect(session.id).toBe(parent.id);
    expect(session.prompts.map((prompt) => prompt.text)).toEqual(["Plan the work"]);
    expect(session.models).toEqual({ "gpt-main": 2 });
    expect(session.subagents.map((agent) => [agent.agentType, agent.description, agent.model, agent.effort, agent.assistantMessages, agent.toolCalls, agent.toolErrors]))
      .toEqual([["worker", "/root/build", "gpt-small", "medium", 2, 1, 1], ["explorer", "/root/look", "gpt-small", "high", 1, 0, 0]]);
    // The worker's copy of the parent's 100-token response is not counted again.
    expect(session.subagents[0].usage["gpt-small"]).toEqual({ input: 200 + 100, output: 120, cacheRead: 800 + 100, cacheWrite5m: 0, cacheWrite1h: 0 });
    // The explorer ran after the root's last record, so the session ends with it.
    expect(session.endedAt).toBe(explorer.records.at(-1).timestamp);
  });

  test("a session is whole: recent subagents bring in an old root, a recent root its old subagents", () => {
    const parent = new Rollout({ start: at("2026-10-20T10:00:00Z") }).prompt("Review it").response();
    const early = new Rollout({ parent, start: at("2026-10-20T11:00:00Z"), role: "explorer" }).response();
    const late = new Rollout({ parent, start: at("2026-11-03T10:00:00Z"), role: "reviewer" }).response();
    write([parent, early, late]);
    touch(parent.id, "2026-10-20T12:00:00Z");
    touch(early.id, "2026-10-20T12:00:00Z");
    touch(late.id, "2026-11-03T12:00:00Z");
    const [session, ...rest] = load({ since: at("2026-11-01T00:00:00Z") });
    expect(rest).toEqual([]);
    expect(session.id).toBe(parent.id);
    expect(session.subagents.map((agent) => agent.agentType)).toEqual(["explorer", "reviewer"]);
    expect([session.startedAt.slice(0, 10), session.endedAt.slice(0, 10)]).toEqual(["2026-10-20", "2026-11-03"]);
    // The other way round: the root changed recently, its subagent long ago.
    touch(parent.id, "2026-11-04T00:00:00Z");
    touch(late.id, "2026-10-20T12:00:00Z");
    expect(load({ since: at("2026-11-01T00:00:00Z") })[0].subagents).toHaveLength(2);
  });

  test("a subagent whose root rollout is gone becomes an agent-launched session", () => {
    const parent = new Rollout().prompt("Plan").response();
    const child = new Rollout({ parent }).response();
    write([child]);
    const [session] = load();
    expect([session.id, session.origin, session.prompts.length, session.inheritedPrompts.map((prompt) => prompt.text)]).toEqual([child.id, "agent", 0, ["Plan"]]);
  });

  test("the thread id comes from the file name, even when its session_meta is unreadable", () => {
    const parent = new Rollout().prompt("Plan").response();
    const child = new Rollout({ parent }).response();
    write([parent, { rollout: child, head: "{broken" }]);
    const ids = load().map((session) => session.id).sort();
    expect(ids).toEqual([parent.id, child.id].sort());
    const thread = parseThread(rolloutThreads(root).find((each) => each.id === child.id));
    // The broken line, and the missing session_meta of its own.
    expect([thread.id, thread.malformedLines]).toEqual([child.id, 2]);
  });

  test("PRs: gh pr create output, even a few calls later, and T3 Code's link tool", () => {
    const parent = new Rollout()
      .exec('tools.exec_command({cmd:"gh pr create --fill"})', "Script running with cell ID 3")
      .exec("tools.write_stdin({session_id: 3})", "Creating pull request\nhttps://github.com/o/r/pull/7\n")
      .exec('tools.mcp__t3_code__link_pull_request({url:"https://github.com/o/r/pull/7"})')
      .exec('tools.mcp__t3_code__unlink_pull_request({url:"https://github.com/o/r/pull/1"})')
      .exec('tools.exec_command({cmd:"gh pr create"})', "still running")
      .exec("a()").exec("b()").exec("c()").exec("d()")
      .exec('tools.exec_command({cmd:"gh pr list"})', "https://github.com/o/r/pull/2");
    const worker = new Rollout({ parent }).call("link_pull_request", { url: "https://github.com/O/R/pull/8" }, "{}", { namespace: "mcp__t3_code" });
    write([parent, worker]);
    const [session] = load();
    expect(session.prLinks.map((link) => [link.repository, link.number])).toEqual([["o/r", 7], ["O/R", 8]]);
  });

  test("windows, titles, delegation briefs, automation and unreadable lines", () => {
    const old = new Rollout({ start: at("2026-10-01T10:00:00Z") }).prompt("old").response();
    const brief = new Rollout({ start: at("2026-11-03T10:00:00Z"), cwd: "/private/tmp/fixture" }).prompt("Act as the worker subagent for this task").response();
    write([old, { rollout: brief, tail: '{"timestamp":"2026-11-03T11:00:00Z","ordinal":99,"type":"compacted","payload":{"message":"big"}}\n{"truncated' }]);
    writeFileSync(join(home, "session_index.jsonl"), `${JSON.stringify({ id: brief.id, thread_name: "First" })}\n${JSON.stringify({ id: brief.id, thread_name: "Renamed" })}\n{"partial`);
    expect(load().map((session) => session.id)).toEqual([brief.id, old.id]);
    const [session] = load({ since: at("2026-11-01T00:00:00Z"), until: at("2026-11-08T00:00:00Z") });
    expect(session).toMatchObject({ id: brief.id, title: "Renamed", origin: "agent", automation: true, malformedLines: 1, compactions: 1 });
    expect(session.endedAt).toBe("2026-11-03T11:00:00.000Z");
    expect(load({ until: at("2026-10-15T00:00:00Z") }).map((s) => s.id)).toEqual([old.id]);
  });
});
