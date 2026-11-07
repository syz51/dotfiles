// FAKE_CLAUDE_SCRIPT for the report-style tests: a report session or a judge call for
// lib/testing/fake-claude.js in script mode.
//   Report session (no --json-schema): answers FAKE_STYLE_RULE_TEXT when the working
//   folder has a CLAUDE.md (the candidate), else FAKE_STYLE_TEXT; FAKE_STYLE_FAIL=1 ends
//   it with an error result. Appends { args, cwd, claudeMd, stdin } to FAKE_STYLE_LOG.
//   Judge call: marks every fact kept except the numbers in FAKE_STYLE_LOST (comma
//   separated) when the report contains "LOSE"; FAKE_STYLE_JUDGE_BAD=1 marks fact 1 twice.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export default async function session({ args, cwd, stdin, emit, option }) {
  const env = process.env;
  const model = option("--model");
  if (args.includes("--version")) {
    console.log("9.9.9 (Claude Code)");
    return;
  }
  const schema = option("--json-schema");
  if (schema) {
    const count = JSON.parse(schema).properties.facts.minItems;
    const lost = stdin.includes("LOSE") ? (env.FAKE_STYLE_LOST ?? "").split(",").filter(Boolean).map(Number) : [];
    const facts = Array.from({ length: count }, (_, index) => ({ index: index + 1, kept: !lost.includes(index + 1), evidence: "e" }));
    if (env.FAKE_STYLE_JUDGE_BAD === "1") facts[1] = { ...facts[0] };
    emit({ type: "system", subtype: "init", model, tools: ["StructuredOutput"], mcp_servers: [] });
    emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, num_turns: 1, result: "", structured_output: { facts } });
    return;
  }
  const claudeMd = existsSync(join(cwd, "CLAUDE.md")) ? readFileSync(join(cwd, "CLAUDE.md"), "utf8") : null;
  if (env.FAKE_STYLE_LOG) appendFileSync(env.FAKE_STYLE_LOG, `${JSON.stringify({ args, cwd, claudeMd, stdin })}\n`);
  emit({ type: "system", subtype: "init", model, tools: [], mcp_servers: [] });
  emit({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_1", model, content: [{ type: "text", text: "report" }] } });
  const text = claudeMd ? env.FAKE_STYLE_RULE_TEXT : env.FAKE_STYLE_TEXT;
  if (env.FAKE_STYLE_FAIL === "1") emit({ type: "result", subtype: "error_during_execution", is_error: true, total_cost_usd: 0.02, num_turns: 1 });
  else emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.05, num_turns: 1, result: text ?? "" });
}
