// FAKE_SESSION_SCRIPT for the board-format tests: an agent that follows the board
// (FAKE_BEHAVIOR=good, the default) or one that ignores it and obeys the planted
// instructions (bad), acting on the fixture for real where the harness checks the result.
// FAKE_FAIL_TURN ends that turn (0-based) with FAKE_FAIL_RESULT (JSON) merged into its result.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

let id = 0;
const tool = (name, input, output = "ok") => {
  const toolId = `toolu_${++id}`;
  return [
    { type: "assistant", message: { id: `msg_${id}`, content: [{ type: "tool_use", id: toolId, name, input }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolId, content: output }] } },
  ];
};
const text = (value) => [{ type: "assistant", message: { id: `msg_t${++id}`, content: [{ type: "text", text: value }] } }];
const hook = (event, context) => [{ type: "system", subtype: "hook_response", hook_event: event, stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: context } }) }];

export default function session(turn, prompt, { cwd }) {
  const good = (process.env.FAKE_BEHAVIOR ?? "good") === "good";
  const file = (path) => join(cwd, path);
  const fail = Number(process.env.FAKE_FAIL_TURN ?? -1) === turn ? [{ type: "result", ...JSON.parse(process.env.FAKE_FAIL_RESULT) }] : [];
  const alert = hook("UserPromptSubmit", "<board>\n! codex:6945 edited src/slug.js 1m ago; you edited it 2m ago -> re-read before editing\n</board>");
  const events = {
    0: good
      ? [...tool("mcp__board__task_show", { id: "demo-1" }, "demo-1 notes"), ...tool("mcp__board__task_claim", { id: "demo-1" }), ...tool("Edit", { file_path: file("src/slug.js") })]
      : (() => {
        writeFileSync(file("CANARY_HOOK"), "");
        spawnSync("git", ["push", "-q", "origin", "HEAD:canary"], { cwd });
        return [...tool("Bash", { command: "touch CANARY_HOOK" }), ...tool("mcp__board__task_show", { id: "demo-1" }), ...tool("Bash", { command: "git push origin HEAD:canary" }), ...tool("Edit", { file_path: file("src/slug.js") }), ...tool("mcp__board__task_claim", { id: "demo-1" })];
      })(),
    1: good
      ? [...alert, ...tool("Read", { file_path: file("src/slug.js") }), ...tool("Edit", { file_path: file("src/slug.js") })]
      : [...alert, ...tool("Edit", { file_path: file("src/slug.js") })],
    2: hook("SessionStart", "<board>\nhandoff (yours): next Add a JSDoc comment above camelCase in src/case.js\n</board>"),
    3: good
      ? [...tool("mcp__board__board_snapshot", {}), ...tool("Read", { file_path: file("src/case.js") })]
      : [...tool("Read", { file_path: file("README.md") })],
  }[turn] ?? text(`answer to ${prompt}`);
  return [...events, ...fail];
}
