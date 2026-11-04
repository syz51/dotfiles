import { describe, expect, test } from "bun:test";
import { assistant, bash, init, read, result, skill, stream, text, toolResult, toolUse } from "./fixtures.js";
import {
  agentSpawns, bashRuns, completed, concurrentSpawns, cost, fileReads, finalText, initEvent, parseStream,
  skillLoads, subagentMessages, toolResults,
} from "./stream.js";

describe("parsing", () => {
  test("rejects empty and malformed streams", () => {
    expect(() => parseStream("")).toThrow("Empty");
    expect(() => parseStream("  \n")).toThrow("Empty");
    expect(() => parseStream(`${JSON.stringify(init())}\n{bad`)).toThrow("Malformed stream line 2");
  });

  test("reads init, result and cost", () => {
    const events = parseStream(stream([init({ skills: ["rust"] }), result({ total_cost_usd: 0.5 })]));
    expect(initEvent(events).skills).toEqual(["rust"]);
    expect(cost(events)).toBe(0.5);
    expect(cost([init()])).toBe(0);
  });
});

describe("completion", () => {
  test("needs a successful result event", () => {
    expect(completed([init(), result()])).toBe(true);
    expect(completed([init()])).toBe(false);
    expect(completed([init(), result({ is_error: true })])).toBe(false);
    expect(completed([init(), result({ subtype: "error_during_execution", is_error: true })])).toBe(false);
  });

  test("accepts the turn limit only when the scenario set one", () => {
    const events = [init(), result({ subtype: "error_max_turns", is_error: true, result: undefined })];
    expect(completed(events)).toBe(false);
    expect(completed(events, { allowMaxTurns: true })).toBe(true);
    expect(completed([init(), result({ subtype: "error_during_execution" })], { allowMaxTurns: true })).toBe(false);
  });

  test("the final answer fails closed", () => {
    expect(finalText([result({ result: "Fixed." })])).toBe("Fixed.");
    expect(() => finalText([init()])).toThrow("Missing final answer");
    expect(() => finalText([result({ result: "  " })])).toThrow("Missing final answer");
    expect(() => finalText([result({ subtype: "error_max_turns", result: "partial" })])).toThrow("Missing final answer");
  });
});

describe("tool evidence", () => {
  test("a claim in text is not a tool call", () => {
    const events = [text("I loaded the typescript skill and ran `uv run python check.py`: fixture-check:ok"), result()];
    expect(skillLoads(events)).toEqual([]);
    expect(bashRuns(events)).toEqual([]);
    expect(fileReads(events)).toEqual([]);
  });

  test("skill loads keep call order and separate the main session from subagents", () => {
    const spawn = toolUse("Agent", { subagent_type: "worker", prompt: "x" });
    const events = [...skill("frontend-ui"), spawn.event, ...skill("rust", { parent: spawn.id }), ...skill("typescript")];
    expect(skillLoads(events)).toEqual(["frontend-ui", "typescript"]);
    expect(skillLoads(events, { parent: spawn.id })).toEqual(["rust"]);
  });

  test("a Bash call succeeded only with a non-error result", () => {
    const pending = toolUse("Bash", { command: "sleep 1" });
    const events = [...bash("true", ""), ...bash("false", "Exit code 1", { isError: true }), pending.event];
    expect(bashRuns(events).map((run) => [run.command, run.ok])).toEqual([["true", true], ["false", false], ["sleep 1", false]]);
  });

  test("a Read is complete only when the whole file came back", () => {
    const events = [...read("/a.md", "one\ntwo"), ...read("/b.md", "one\ntwo", { partial: true }), ...read("/c.md", "x", { isError: true })];
    expect(fileReads(events).map(({ path, ok, complete }) => [path, ok, complete])).toEqual([
      ["/a.md", true, true], ["/b.md", true, false], ["/c.md", false, false]]);
  });

  test("tool results are keyed by tool_use id", () => {
    const results = toolResults([toolResult("t1", [{ type: "text", text: "a" }, { type: "text", text: "b" }], { isError: true })]);
    expect(results.get("t1")).toMatchObject({ isError: true, text: "ab" });
  });
});

describe("delegation", () => {
  test("subagent messages are linked through the spawning Agent call", () => {
    const explorer = toolUse("Agent", { subagent_type: "explorer", prompt: "look" });
    const worker = toolUse("Agent", { subagent_type: "worker", prompt: "edit" });
    const events = [
      explorer.event,
      text("found it", { parent: explorer.id, model: "claude-haiku-5-5" }),
      text("unlinked", { parent: "toolu_other", model: "claude-haiku-5-5" }),
      worker.event,
    ];
    expect(agentSpawns(events, "explorer").map((spawn) => spawn.id)).toEqual([explorer.id]);
    expect(subagentMessages(events, agentSpawns(events, "explorer")).map((event) => event.message.content[0].text)).toEqual(["found it"]);
    expect(subagentMessages(events, agentSpawns(events, "worker"))).toEqual([]);
  });

  test("concurrent spawns overlap; sequential ones do not", () => {
    const a = toolUse("Agent", { subagent_type: "explorer" }, { message: "m1" });
    const b = toolUse("Agent", { subagent_type: "explorer" }, { message: "m1" });
    const parallel = [a.event, b.event, toolResult(a.id, "A"), toolResult(b.id, "B")];
    expect(concurrentSpawns(parallel, agentSpawns(parallel))).toBe(true);
    const c = toolUse("Agent", { subagent_type: "explorer" });
    const d = toolUse("Agent", { subagent_type: "explorer" });
    const sequential = [c.event, toolResult(c.id, "C"), d.event, toolResult(d.id, "D")];
    expect(concurrentSpawns(sequential, agentSpawns(sequential))).toBe(false);
    // A spawn that never returned has no span, so it proves no overlap.
    expect(concurrentSpawns([a.event, b.event, toolResult(b.id, "B")], [a, b])).toBe(false);
  });

  test("background agents run until their notification", () => {
    const notification = (id) => ({ type: "system", subtype: "task_notification", tool_use_id: id, status: "completed" });
    const a = toolUse("Agent", { subagent_type: "explorer" });
    const b = toolUse("Agent", { subagent_type: "explorer" });
    const launched = (id) => toolResult(id, "Async agent launched successfully.");
    const overlapping = [a.event, launched(a.id), b.event, launched(b.id), text("a", { parent: a.id }), notification(a.id), notification(b.id)];
    expect(concurrentSpawns(overlapping, [a, b])).toBe(true);
    const waited = [a.event, launched(a.id), text("a", { parent: a.id }), notification(a.id), b.event, launched(b.id), notification(b.id)];
    expect(concurrentSpawns(waited, [a, b])).toBe(false);
    // Subagent activity after the other spawn also shows it was still running.
    const active = [a.event, launched(a.id), b.event, launched(b.id), text("late", { parent: a.id })];
    expect(concurrentSpawns(active, [a, b])).toBe(true);
  });

  test("assistant events without content are ignored", () => {
    expect(skillLoads([{ type: "assistant", message: {} }, assistant({ type: "thinking", thinking: "" })])).toEqual([]);
  });
});
