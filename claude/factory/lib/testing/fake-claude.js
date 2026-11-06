#!/usr/bin/env bun
// A stand-in for `claude -p --output-format stream-json` in the factory's tests. It
// appends its argv, cwd, stdin and the text of a --system-prompt-file as one JSON
// line to FAKE_CLAUDE_LOG and answers by
// FAKE_CLAUDE_MODE:
//   structured    init with only StructuredOutput, then a success result whose
//                 structured_output is FAKE_CLAUDE_OUTPUT (JSON)
//   tool          like structured, but the session also calls Bash
//   mcp           like structured, but init lists an MCP server
//   error         an error_during_execution result with api_error_status 429
//   refused       Claude Code's result when the API refuses the run for credit (HTTP 400),
//                 for the first FAKE_CLAUDE_REFUSALS calls (default 1) that share the
//                 FAKE_CLAUDE_LOG; later calls answer as FAKE_CLAUDE_THEN (default
//                 structured)
//   malformed     a line that is not JSON
//   exit          no output and exit status FAKE_CLAUDE_EXIT (default 1)
//   task          a success result with text FAKE_CLAUDE_TEXT; when FAKE_CLAUDE_WRITE is
//                 set to "path=content", writes that file in the working folder first
//   script        runs the module at FAKE_CLAUDE_SCRIPT with { args, cwd, stdin, emit }
// FAKE_CLAUDE_COST sets total_cost_usd (default 0.01).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const stdin = await Bun.stdin.text();
const env = process.env;
const systemFile = option("--system-prompt-file");
const system = systemFile === undefined ? undefined : readFileSync(systemFile, "utf8");
if (env.FAKE_CLAUDE_LOG) appendFileSync(env.FAKE_CLAUDE_LOG, `${JSON.stringify({ args, cwd: process.cwd(), stdin, system })}\n`);

let mode = env.FAKE_CLAUDE_MODE ?? "structured";
if (mode === "refused") {
  const calls = readFileSync(env.FAKE_CLAUDE_LOG, "utf8").trim().split("\n").length;
  if (calls > Number(env.FAKE_CLAUDE_REFUSALS ?? 1)) mode = env.FAKE_CLAUDE_THEN ?? "structured";
}
const cost = Number(env.FAKE_CLAUDE_COST ?? 0.01);
const model = option("--model") ?? "claude-opus-5-5";
const emit = (event) => console.log(JSON.stringify(event));
const init = (extra = {}) => emit({ type: "system", subtype: "init", model, tools: ["StructuredOutput"], mcp_servers: [], ...extra });
const result = (extra = {}) => emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: cost, num_turns: 1, result: "", ...extra });

switch (mode) {
  case "structured":
  case "tool":
  case "mcp": {
    init(mode === "mcp" ? { mcp_servers: [{ name: "x", status: "connected" }] } : {});
    if (mode === "tool")
      emit({ type: "assistant", message: { id: "msg_1", model, content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "true" } }] } });
    result({ structured_output: JSON.parse(env.FAKE_CLAUDE_OUTPUT ?? "{}") });
    break;
  }
  case "error":
    init();
    emit({ type: "result", subtype: "error_during_execution", is_error: true, api_error_status: 429, total_cost_usd: 0 });
    break;
  case "refused":
    init();
    emit({ type: "result", subtype: "success", is_error: true, api_error_status: 400, result: "Credit balance is too low", total_cost_usd: 0 });
    process.exit(1);
  case "malformed":
    console.log("{not json");
    break;
  case "exit":
    process.exit(Number(env.FAKE_CLAUDE_EXIT ?? 1));
  case "task": {
    init({ tools: ["Bash", "Read", "Edit", "Write"] });
    if (env.FAKE_CLAUDE_WRITE) {
      const [path, ...content] = env.FAKE_CLAUDE_WRITE.split("=");
      mkdirSync(dirname(join(process.cwd(), path)), { recursive: true });
      writeFileSync(join(process.cwd(), path), content.join("="));
    }
    result({ result: env.FAKE_CLAUDE_TEXT ?? "done" });
    break;
  }
  case "script": {
    const module = await import(env.FAKE_CLAUDE_SCRIPT);
    await module.default({ args, cwd: process.cwd(), stdin, emit, option });
    break;
  }
  default:
    console.error(`Unknown FAKE_CLAUDE_MODE ${mode}`);
    process.exit(64);
}
