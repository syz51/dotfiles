import { describe, expect, test } from "bun:test";
import { assistant, bash, init, read, result, skill, stream, text, toolResult, toolUse } from "./fixtures.js";
import {
  agentSpawns, bashRuns, completed, concurrentSpawns, cost, fileReads, finalText, initEvent, mainBashPrinted, parseStream,
  partialEvents, printedFrom, refusedBeforeWork, retryRefused, skillLoads, spawnEnds, subagentMessages, toolResults,
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

describe("cut-off streams and refusals", () => {
  test("a cut-off stream keeps its complete lines", () => {
    expect(partialEvents(`${JSON.stringify(init())}\n{"type":"assist`)).toEqual([init()]);
    expect(partialEvents()).toEqual([]);
  });

  test("a run the API refused before any tool call is told apart from other failures", () => {
    // Claude Code's result for "Credit balance is too low" (2.1.318).
    const refused = result({ is_error: true, api_error_status: 400, result: "Credit balance is too low" });
    expect(refusedBeforeWork([init(), refused])).toBe(true);
    expect(refusedBeforeWork([init(), result({ is_error: true, api_error_status: 401 })])).toBe(true);
    expect(refusedBeforeWork([init(), toolUse("Bash", { command: "rm x" }).event, refused]), "work was done").toBe(false);
    expect(refusedBeforeWork([init(), result({ subtype: "error_during_execution", is_error: true, api_error_status: 429 })])).toBe(false);
    expect(refusedBeforeWork([init(), result({ is_error: true, api_error_status: 500 })])).toBe(false);
    // Refused again on any billing: not for credit or the key.
    expect(refusedBeforeWork([init(), result({ is_error: true, api_error_status: 400, result: "Prompt is too long" })])).toBe(false);
    expect(refusedBeforeWork([init(), result({ is_error: true, api_error_status: 404, result: "There's an issue with the selected model" })])).toBe(false);
    expect(refusedBeforeWork([init(), result()])).toBe(false);
    expect(refusedBeforeWork([init()])).toBe(false);
  });
});

describe("retrying a refused run", () => {
  const refused = [init(), result({ is_error: true, api_error_status: 400, result: "Credit balance is too low", total_cost_usd: 0 })];

  test("runs once more after a refusal, with the time left, and keeps the refused try", async () => {
    const limits = [];
    const asked = [];
    const outcomes = [{ events: refused, n: 1 }, { events: [init(), result()], n: 2 }, { events: refused, n: 3 }];
    const attempt = async (limit, { subscription }) => {
      limits.push(limit);
      asked.push(subscription);
      if (limits.length === 1) await Bun.sleep(30);
      return outcomes[limits.length - 1];
    };
    const outcome = await retryRefused(attempt, 1000);
    expect([outcome.n, outcome.refused.n]).toEqual([2, 1]);
    expect(limits[0]).toBe(1000);
    expect(limits[1]).toBeLessThanOrEqual(975);
    // The second try asks for the subscription, whether or not the first one's hook reported.
    expect(asked).toEqual([false, true]);
  });

  test("a second try that throws keeps the refused try", async () => {
    let calls = 0;
    const error = await retryRefused(async () => {
      if (calls++) throw new Error("timeout");
      return { events: refused, n: 1 };
    }, 1000).catch((e) => e);
    expect([error.message, error.refused.n]).toEqual(["timeout", 1]);
  });

  test("anything else, a second refusal included, is returned as it is", async () => {
    let calls = 0;
    expect(await retryRefused(async () => ({ events: [init(), result()], n: ++calls }), 1000)).toEqual({ events: [init(), result()], n: 1 });
    calls = 0;
    const twice = await retryRefused(async () => ({ events: refused, n: ++calls }), 1000);
    expect([twice.n, twice.refused.n, calls]).toEqual([2, 1, 2]);
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

  test("needs every turn of a conversation to succeed", () => {
    expect(completed([init(), result({ result: "Running." }), result({ result: "391" })])).toBe(true);
    expect(completed([init(), result({ subtype: "error_during_execution", is_error: true }), result()])).toBe(false);
    expect(completed([init(), result({ is_error: true }), result()])).toBe(false);
    const limited = [init(), result({ subtype: "error_max_turns", is_error: true }), result()];
    expect(completed(limited, { allowMaxTurns: true }), "only the last turn may stop at the limit").toBe(false);
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

  test("a background spawn ends at its notification, not at its launch result", () => {
    const a = toolUse("Agent", { subagent_type: "worker" });
    const b = toolUse("Agent", { subagent_type: "worker" });
    const events = [a.event, toolResult(a.id, "Async agent launched successfully."), b.event, toolResult(b.id, "B"),
      text("working", { parent: a.id }), { type: "system", subtype: "task_notification", tool_use_id: a.id }];
    expect(Object.fromEntries(spawnEnds(events, [a, b]))).toEqual({ [a.id]: 5, [b.id]: 3 });
    expect(spawnEnds([a.event], [a]).has(a.id)).toBe(false);
  });

  test("assistant events without content are ignored", () => {
    expect(skillLoads([{ type: "assistant", message: {} }, assistant({ type: "thinking", thinking: "" })])).toEqual([]);
  });
});

// Shapes from live runs of the parallel-tracks scenario: the main session brings a track
// back with commands that name the worktree, and may leave its shell inside one.
describe("main-session check output", () => {
  const proof = { marker: "pricing-check:ok", dir: "/work/pricing" };
  const line = "pricing-check:ok /work/pricing";
  const worktree = "/work/.claude/worktrees/agent-a1";

  test("a line names the marker and the directory as words", () => {
    expect(printedFrom(`exit=0\n  ${line}\n`, proof.marker, proof.dir)).toBe(true);
    expect(printedFrom(`${line} CODE ok`, proof.marker, proof.dir)).toBe(true);
    expect(printedFrom("pricing-check:ok", proof.marker, proof.dir)).toBe(false);
    expect(printedFrom(`pricing-check:ok ${worktree}/pricing`, proof.marker, proof.dir)).toBe(false);
    expect(printedFrom("pricing-check:ok /work/pricing2", proof.marker, proof.dir)).toBe(false);
    expect(printedFrom(`console.log(\`${line}\`)`, proof.marker, proof.dir)).toBe(false);
  });

  test("counts a check that printed the main checkout's line after the given event", () => {
    const merged = [init(), text("track returned"),
      ...bash(`git -C ${worktree} diff --cached | git apply && bun pricing/check.js; echo "exit=$?"`, `${line}\nexit=0\n`)];
    expect(mainBashPrinted(merged, { ...proof, after: 1 })).toBe(true);
    // A copy from the worktree after a cd into it, then the check back in the checkout.
    const copied = [init(), text("track returned"), ...bash(`cd ${worktree}`, ""),
      ...bash(`cp ${worktree}/pricing/*.js /work/pricing/ && cd /work && bun pricing/check.js`, `${line}\n`)];
    expect(mainBashPrinted(copied, { ...proof, after: 1 })).toBe(true);
    // A later part of the command failed, but the check itself passed.
    const later = [init(), text("track returned"), ...bash("bun pricing/check.js && bun shipping/check.js", `${line}\nerror: wrong weight\n`, { isError: true })];
    expect(mainBashPrinted(later, { ...proof, after: 1 })).toBe(true);
    expect(mainBashPrinted(later, proof)).toBe(true);
  });

  test("rejects a check in a worktree, before the event, by a subagent, or quoted in other output", () => {
    const inWorktree = [init(), text("track returned"), ...bash(`cd ${worktree} && bun pricing/check.js`, `pricing-check:ok ${worktree}/pricing\n`)];
    expect(mainBashPrinted(inWorktree, { ...proof, after: 1 })).toBe(false);
    const early = [init(), ...bash("bun pricing/check.js", `${line}\n`), text("track returned")];
    expect(mainBashPrinted(early, { ...proof, after: 2 })).toBe(false);
    const subagent = [init(), text("track returned"), ...bash("bun pricing/check.js", `${line}\n`, { parent: "toolu_agent" })];
    expect(mainBashPrinted(subagent, { ...proof, after: 1 })).toBe(false);
    const quoted = [init(), text("track returned"), ...bash(`echo "expect ${line}"`, `expect ${line}\n`)];
    expect(mainBashPrinted(quoted, { ...proof, after: 1 })).toBe(false);
  });
});
