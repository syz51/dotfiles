import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Transcript, writeProjects } from "../lib/testing/transcripts.js";
import { loadSessions } from "../lib/transcripts.js";
import { buildDigest, compactInput } from "./digest.js";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function session(transcript, subagents = []) {
  const root = writeProjects([{ transcript, subagents }]);
  roots.push(root);
  return loadSessions({ root })[0];
}

test("holds metadata, prompts, assistant text once per message, tool calls, subagents and the final message", () => {
  const t = new Transcript({ cwd: "/Users/test/app" })
    .title("Fix login")
    .prompt("Fix the login bug")
    .assistant([{ type: "thinking", thinking: "secret" }, { type: "text", text: "Looking at auth." }, { type: "text", text: "Second block." }])
    .tool("Bash", { command: "bun test\nauth" }, `${"x".repeat(1000)}1 fail`, { isError: true })
    .tool("Agent", { subagent_type: "explorer", description: "map the auth module", prompt: "long brief" }, "found it")
    .interrupt()
    .prompt("no, the other file")
    .text(`Done. ${"Final report. ".repeat(400)}`)
    .costState(2.5);
  const agent = new Transcript({ sessionId: t.sessionId }).tool("Read", { file_path: "/a" }, "x");
  const digest = buildDigest(session(t, [{ id: "agent-a1", meta: { agentType: "explorer", description: "map the auth module" }, transcript: agent }]));
  expect(digest).toContain("Project: -Users-test-project  cwd: /Users/test/app");
  expect(digest).toContain("Title: Fix login");
  expect(digest).toContain("Cost: $2.50 (cost-state)");
  expect(digest).toContain("[P1] PROMPT (sdk,");
  expect(digest).toContain("Fix the login bug");
  expect(digest).toContain("[P2] PROMPT");
  expect(digest).toContain("[A1] ASSISTANT: Looking at auth.\nSecond block.");
  expect(digest).not.toContain("secret");
  expect(digest).toMatch(/\[T1\] Bash \(ERROR\) bun test ⏎ auth → x+ \[…\d+ chars…\] x+1 fail/);
  expect(digest).toContain("[T2] Agent (ok) explorer: map the auth module");
  expect(digest).toContain("- explorer on claude-opus-5-5/high: map the auth module (1 tool calls, 0 errors, $");
  expect(digest).toContain("[interrupted by the user]");
  expect(digest).toContain("[A2] ASSISTANT: (final message, shown in full below)");
  expect(digest).toContain(`## Final assistant message [A2]\nDone. ${"Final report. ".repeat(400)}`);
});

test("shows host notices in order, labelled apart from prompts, and slash commands by name and arguments", () => {
  const t = new Transcript()
    .prompt("Context handoff (full_thread_summary): earlier thread renamed foo. Newest request: rename bar too.")
    .text("Renaming bar.")
    .prompt("<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>high origin/main</command-args>")
    .prompt("Delegated task node:delegated-task:abc finished: tests pass.")
    .prompt("Update on pull request #3 (https://github.com/o/r/pull/3): a check failed.")
    .prompt("Fix the check")
    .text("Fixed.");
  const s = session(t);
  expect(s.prompts.map((prompt) => prompt.text)).toEqual(["Fix the check"]);
  const digest = buildDigest(s);
  expect(digest).toContain("Prompts: 1; host notices: 4;");
  const events = digest.slice(digest.indexOf("## Events"), digest.indexOf("## Final"));
  const order = ["[H1] HOST NOTICE (", "Context handoff (full_thread_summary): earlier thread", "[A1] ASSISTANT: Renaming bar.",
    "[H2] HOST NOTICE (slash command, ", "): /review high origin/main", "[H3] HOST NOTICE", "Delegated task node:delegated-task:abc", "[H4] HOST NOTICE", "Update on pull request #3", "[P1] PROMPT", "Fix the check"];
  const positions = order.map((text) => events.indexOf(text));
  expect(positions.every((position) => position >= 0), JSON.stringify(positions)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(events).not.toContain("<command-name>");
});

test("host notices are bounded like prompts and kept ahead of other events", () => {
  const t = new Transcript().prompt("Start");
  t.prompt(`Context handoff (full_thread_summary): long-handoff ${"h".repeat(10_000)} newest request`);
  for (let i = 0; i < 20; i++) t.prompt(`Context handoff (full_thread_summary): handoff-${i} ${"h".repeat(2500)}`).tool("Read", { file_path: `/file-${i}.js` }, "y".repeat(2000));
  t.text("All done.");
  const digest = buildDigest(session(t), { maxChars: 20_000 });
  expect(digest.length).toBeLessThanOrEqual(20_000);
  // Each notice keeps its start and end within the prompt bound.
  const notice = /\[H1\][^\n]*\n([^\n]*)/.exec(digest)[1];
  expect(notice.length).toBeLessThanOrEqual(4000);
  expect(notice).toEndWith("newest request");
  expect(digest).toContain("handoff-19 ");
  expect(digest).toMatch(/omitted to fit the digest: \d+ host notices? …/);
});

test("bounds each part: prompts, tool inputs and outputs", () => {
  const t = new Transcript().prompt(`start ${"p".repeat(10_000)} end`).tool("Bash", { command: "c".repeat(1000) }, "o".repeat(5000)).text("ok");
  const digest = buildDigest(session(t));
  const prompt = /\[P1\][^\n]*\n([^\n]*)/.exec(digest)[1];
  expect(prompt.length).toBeLessThanOrEqual(4000);
  expect(prompt.startsWith("start")).toBe(true);
  expect(prompt.endsWith("end")).toBe(true);
  const tool = digest.split("\n").find((line) => line.startsWith("[T1]"));
  expect(tool.length).toBeLessThan("[T1] Bash (ok) ".length + 300 + 3 + 300 + 1);
  expect(compactInput("Edit", { file_path: "/a.js", old_string: "abc", new_string: "abcdef" })).toBe("/a.js (-3/+6 chars)");
  expect(compactInput("Mystery", { a: 1 })).toBe('{"a":1}');
});

test("a long session stays within the limit, keeps every prompt, the start and the end, and says what it omitted", () => {
  const t = new Transcript().prompt("FIRST PROMPT");
  for (let i = 0; i < 400; i++) {
    t.tool("Read", { file_path: `/file-${i}.js` }, "y".repeat(400));
    if (i % 100 === 50) t.prompt(`Follow-up ${i}`);
  }
  t.text("All done.");
  const s = session(t);
  const digest = buildDigest(s, { maxChars: 20_000 });
  expect(digest.length).toBeLessThanOrEqual(20_000);
  expect(digest).toContain("FIRST PROMPT");
  for (const i of [50, 150, 250, 350]) expect(digest).toContain(`Follow-up ${i}`);
  expect(digest).toContain("/file-0.js");
  expect(digest).toContain("/file-399.js");
  expect(digest).not.toContain("/file-200.js");
  expect(digest).toMatch(/\[… omitted to fit the digest: \d+ tool calls …\]/);
  expect(digest).toMatch(/\(partial: \d+ of 406 events omitted to fit 20000 characters\)/);
  expect(digest).toContain("## Final assistant message [A1]\nAll done.");
  // Deterministic: the same session gives the same digest.
  expect(buildDigest(s, { maxChars: 20_000 })).toBe(digest);
});

test("a forked session shows its parent's prompts as context, then only its own events", () => {
  const forkedFrom = { sessionId: "parent-1", messageUuid: "m1" };
  const t = new Transcript()
    .prompt("Parent's request", { forkedFrom })
    .prompt("Parent's summary", { forkedFrom, isCompactSummary: true })
    .tool("Bash", { command: "parent-command" }, "ok", { forkedFrom })
    .text("Parent's answer", { forkedFrom })
    .prompt("Fork's request")
    .text("Fork's answer");
  const digest = buildDigest(session(t));
  expect(digest).toContain("Forked from session parent-1: its 4 inherited records are left out");
  expect(digest).toContain("## Prompts from the parent conversation, before the fork; the fork's own events follow\n[I1] PROMPT (sdk,");
  expect(digest).toContain("Parent's request");
  expect(digest).not.toContain("Parent's summary");
  expect(digest).not.toContain("parent-command");
  expect(digest).not.toContain("Parent's answer");
  expect(digest.indexOf("Parent's request")).toBeLessThan(digest.indexOf("## Events"));
  expect(digest).toContain("## Events\n[P1] PROMPT");
  expect(digest).toContain("Fork's request");
  expect(digest).toContain("## Final assistant message [A1]\nFork's answer");
});

test("a long fork stays within the limit and keeps the start of its parent's task", () => {
  const forkedFrom = { sessionId: "parent-1", messageUuid: "m1" };
  const t = new Transcript();
  for (let i = 0; i < 30; i++) t.prompt(`parent-prompt-${i} ${"q".repeat(2000)}`, { forkedFrom }).text(`parent reply ${i}`, { forkedFrom });
  t.prompt("Fork's request");
  for (let i = 0; i < 200; i++) t.tool("Read", { file_path: `/file-${i}.js` }, "y".repeat(400));
  t.text("All done.");
  const digest = buildDigest(session(t), { maxChars: 30_000 });
  expect(digest.length).toBeLessThanOrEqual(30_000);
  expect(digest).toContain("parent-prompt-0 ");
  expect(digest).toContain("Fork's request");
  expect(digest).toContain("/file-199.js");
  expect(digest).toContain("## Final assistant message [A1]\nAll done.");
});

test("prompts beyond half the space keep their start and end too", () => {
  const t = new Transcript();
  for (let i = 0; i < 40; i++) t.prompt(`prompt-${i} ${"z".repeat(3000)}`).text(`reply ${i}`);
  const digest = buildDigest(session(t), { maxChars: 30_000 });
  expect(digest.length).toBeLessThanOrEqual(30_000);
  expect(digest).toContain("prompt-0 ");
  expect(digest).toContain("prompt-39 ");
  expect(digest).toMatch(/omitted to fit the digest: 1 prompt …/);
});
