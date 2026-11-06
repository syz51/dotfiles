#!/usr/bin/env bun
// A stand-in for a multi-turn `claude -p --input-format stream-json` session in the
// board-format benchmark's tests. Appends { who: "claude", args, cwd, env, settings, mcp }
// to FAKE_LOG at start and { who: "turn", prompt } per user message, then answers each
// message with the events of FAKE_SESSION_SCRIPT's default export
// (turn, prompt, { cwd, args }) → events, which may also act on the working folder, then
// a result whose usage, model and is_error come from the script's events or defaults. The
// first turn starts with a SessionStart hook response carrying FAKE_START_BLOCK and an
// init event with apiKeySource FAKE_API_KEY_SOURCE (default "none"). `--version` prints a
// version line.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const env = process.env;
if (args.includes("--version")) {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const log = (record) => env.FAKE_LOG && appendFileSync(env.FAKE_LOG, `${JSON.stringify(record)}\n`);
const read = (path) => (path ? JSON.parse(readFileSync(path, "utf8")) : null);
log({
  who: "claude", args, cwd: process.cwd(), settings: read(option("--settings")), mcp: read(option("--mcp-config")),
  env: { BOARD_HOME: env.BOARD_HOME, BOARD_KEYCHAIN: env.BOARD_KEYCHAIN, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, AGENT_BOARD_HOOKS: env.AGENT_BOARD_HOOKS, BOARD_TOKEN: env.BOARD_TOKEN, TMPDIR: env.TMPDIR, CLAUDECODE: env.CLAUDECODE },
});
const script = env.FAKE_SESSION_SCRIPT ? (await import(env.FAKE_SESSION_SCRIPT)).default : () => [];
const model = option("--model");
const emit = (event) => console.log(JSON.stringify(event));
let turn = 0;
let cost = 0;
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const prompt = JSON.parse(line).message.content;
  log({ who: "turn", prompt });
  if (turn === 0) {
    // FAKE_EXTRA_BLOCK: a second board block, as a board hook in the user's settings adds.
    for (const block of [env.FAKE_START_BLOCK ?? "", ...(env.FAKE_EXTRA_BLOCK ? [env.FAKE_EXTRA_BLOCK] : [])])
      emit({ type: "system", subtype: "hook_response", hook_event: "SessionStart", hook_name: "SessionStart:startup", stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: block } }) });
    emit({ type: "system", subtype: "init", model, apiKeySource: env.FAKE_API_KEY_SOURCE ?? "none", tools: ["Bash", "Read", "Edit"], mcp_servers: [{ name: "board", status: "connected" }] });
  }
  const events = await script(turn, prompt, { cwd: process.cwd(), args });
  const result = events.find((event) => event.type === "result");
  for (const event of events) if (event !== result) emit(event.type === "assistant" ? { parent_tool_use_id: null, ...event, message: { model, ...event.message } } : event);
  cost += 0.01;
  emit({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done", total_cost_usd: cost,
    usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 10, output_tokens: 5 }, ...result });
  turn++;
}
