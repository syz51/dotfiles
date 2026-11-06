import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexSessionsRoot, loadCodexSessions, normalizeCodexUsage, parseRollout, projectKey, rolloutFiles } from "./codex.js";
import { codexUsage, Rollout, writeRollouts } from "./testing/codex.js";

let home;
let root;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claude-factory-codex-"));
  root = join(home, "sessions");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const at = (iso) => Date.parse(iso);
const load = (options) => loadCodexSessions({ root, ...options });

describe("codex rollouts", () => {
  test("finds rollouts under CODEX_HOME and keys projects like Claude Code", () => {
    expect(codexSessionsRoot({ CODEX_HOME: "/x/codex" })).toBe("/x/codex/sessions");
    expect(codexSessionsRoot({ HOME: "/ignored" })).toEndWith("/.codex/sessions");
    expect(projectKey("/Users/test/.config")).toBe("-Users-test--config");
    const rollout = new Rollout();
    writeRollouts([rollout], root);
    writeFileSync(join(root, "notes.jsonl"), "{}\n");
    expect(rolloutFiles(root).map((entry) => entry.id)).toEqual([rollout.id]);
    expect(rolloutFiles(join(home, "missing"))).toEqual([]);
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
      .response(codexUsage(500, 50, { cached: 0 }));
    const [session] = load({ root: writeRollouts([rollout], root) });
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

  test("subagents count with their root session, without the parent history they copy", () => {
    const parent = new Rollout({ start: at("2026-11-01T10:00:00Z"), model: "gpt-main" }).prompt("Plan the work").response(codexUsage(100, 10, { cached: 0 }));
    const worker = new Rollout({ parent, model: "gpt-small", effort: "medium", role: "worker", path: "/root/build" })
      .exec("build()", "Script failed\nOutput:\n")
      .response(codexUsage(200, 20, { cached: 100 }));
    const explorer = new Rollout({ parent, start: at("2026-11-01T11:00:00Z"), role: "explorer", path: "/root/look", model: "gpt-small" }).response();
    parent.call("wait_agent", {}, '{"message":"Wait completed."}', { namespace: "collaboration" });
    writeRollouts([parent, worker, explorer], root);
    // Only the subagent changed recently: its root still loads.
    const recent = at("2026-11-05T00:00:00Z");
    for (const { file, id } of rolloutFiles(root)) {
      const time = id === parent.id ? at("2026-10-01T00:00:00Z") : recent;
      utimesSync(file, time / 1000, time / 1000);
    }
    const sessions = load({ since: recent - 1000 });
    expect(sessions).toHaveLength(0); // the root's own last activity is before since
    const [session] = load({ since: at("2026-09-01T00:00:00Z") });
    expect(session.id).toBe(parent.id);
    expect(session.prompts.map((prompt) => prompt.text)).toEqual(["Plan the work"]);
    expect(session.models).toEqual({ "gpt-main": 2 });
    expect(session.subagents.map((agent) => [agent.agentType, agent.description, agent.model, agent.effort, agent.assistantMessages, agent.toolCalls, agent.toolErrors]))
      .toEqual([["worker", "/root/build", "gpt-small", "medium", 2, 1, 1], ["explorer", "/root/look", "gpt-small", "high", 1, 0, 0]]);
    // The worker's copy of the parent's 100-token response is not counted again.
    expect(session.subagents[0].usage["gpt-small"]).toEqual({ input: 200 + 100, output: 120, cacheRead: 800 + 100, cacheWrite5m: 0, cacheWrite1h: 0 });
  });

  test("a subagent whose root rollout is gone becomes an agent-launched session", () => {
    const parent = new Rollout().prompt("Plan").response();
    const child = new Rollout({ parent }).response();
    writeRollouts([child], root);
    const [session] = load();
    expect([session.id, session.origin, session.prompts.length, session.inheritedPrompts.map((prompt) => prompt.text)]).toEqual([child.id, "agent", 0, ["Plan"]]);
  });

  test("windows, titles, delegation briefs, automation and unreadable lines", () => {
    const old = new Rollout({ start: at("2026-10-01T10:00:00Z") }).prompt("old").response();
    const brief = new Rollout({ start: at("2026-11-03T10:00:00Z"), cwd: "/private/tmp/fixture" }).prompt("Act as the worker subagent for this task").response();
    writeRollouts([old, { rollout: brief, tail: '{"timestamp":"2026-11-03T11:00:00Z","ordinal":99,"type":"compacted","payload":{"message":"big"}}\n{"truncated' }], root);
    writeFileSync(join(home, "session_index.jsonl"), `${JSON.stringify({ id: brief.id, thread_name: "First" })}\n${JSON.stringify({ id: brief.id, thread_name: "Renamed" })}\n{"partial`);
    expect(load().map((session) => session.id)).toEqual([brief.id, old.id]);
    const [session] = load({ since: at("2026-11-01T00:00:00Z"), until: at("2026-11-08T00:00:00Z") });
    expect(session).toMatchObject({ id: brief.id, title: "Renamed", origin: "agent", automation: true, malformedLines: 1, compactions: 1 });
    expect(session.endedAt).toBe("2026-11-03T11:00:00.000Z");
    expect(load({ until: at("2026-10-15T00:00:00Z") }).map((s) => s.id)).toEqual([old.id]);
  });

  test("parseRollout reads a thread without its session", () => {
    const rollout = new Rollout().prompt("Hi").response();
    writeRollouts([rollout], root);
    const thread = parseRollout(rolloutFiles(root)[0].file);
    expect([thread.id, thread.rootId, thread.subagent, thread.texts.length]).toEqual([rollout.id, rollout.id, false, 1]);
  });
});
