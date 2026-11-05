// FAKE_CLAUDE_SCRIPT for the bench tests: a task session for lib/testing/fake-claude.js
// in script mode, driven by FAKE_BENCH_* variables:
//   FAKE_BENCH_LOG       appends { args, cwd, agentFile, settings, env, started, ended }
//   FAKE_BENCH_SLEEP     milliseconds to work before answering
//   FAKE_BENCH_WRITE     "path=content" written in the working folder
//   FAKE_BENCH_TEXT      final text (default "done")
//   FAKE_BENCH_RAN       model the main thread reports (default the --model value)
//   FAKE_BENCH_SUBTYPE   result subtype (default success)
//   FAKE_BENCH_IS_ERROR  "1" flags a success result is_error, as a missing login does
//   FAKE_BENCH_API_ERROR api_error_status on the result
//   FAKE_BENCH_COST      total_cost_usd (default 0.05)
// `--version` prints a version line instead.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export default async function session({ args, cwd, emit, option }) {
  const env = process.env;
  if (args.includes("--version")) {
    console.log("9.9.9 (Claude Code)");
    return;
  }
  const started = Date.now();
  const agent = option("--agent");
  const agentPath = agent && join(cwd, ".claude", "agents", `${agent}.md`);
  const agentFile = agentPath && existsSync(agentPath) ? readFileSync(agentPath, "utf8") : null;
  const settings = option("--settings") ? JSON.parse(readFileSync(option("--settings"), "utf8")) : null;
  if (env.FAKE_BENCH_SLEEP) await Bun.sleep(Number(env.FAKE_BENCH_SLEEP));
  if (env.FAKE_BENCH_WRITE) {
    const [path, ...content] = env.FAKE_BENCH_WRITE.split("=");
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content.join("="));
  }
  const model = env.FAKE_BENCH_RAN || option("--model");
  emit({ type: "system", subtype: "init", model, tools: ["Bash", "Read", "Edit", "Write"], mcp_servers: [] });
  emit({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_1", model, content: [{ type: "text", text: "working" }] } });
  // A subagent on another model does not count against the requested model.
  emit({ type: "assistant", parent_tool_use_id: "toolu_sub", message: { id: "msg_2", model: "claude-haiku-5-5", content: [{ type: "text", text: "sub" }] } });
  const subtype = env.FAKE_BENCH_SUBTYPE ?? "success";
  emit({
    type: "result", subtype, is_error: subtype !== "success" || env.FAKE_BENCH_IS_ERROR === "1", num_turns: 3,
    total_cost_usd: Number(env.FAKE_BENCH_COST ?? 0.05), result: env.FAKE_BENCH_TEXT ?? "done",
    ...(env.FAKE_BENCH_API_ERROR ? { api_error_status: Number(env.FAKE_BENCH_API_ERROR) } : {}),
  });
  if (env.FAKE_BENCH_LOG)
    appendFileSync(env.FAKE_BENCH_LOG, `${JSON.stringify({
      args, cwd, agentFile, settings, started, ended: Date.now(),
      env: { TMPDIR: env.TMPDIR, UV_OFFLINE: env.UV_OFFLINE, CLAUDE_CODE_TMPDIR: env.CLAUDE_CODE_TMPDIR },
    })}\n`);
}
