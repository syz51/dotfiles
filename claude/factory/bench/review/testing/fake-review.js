// FAKE_CLAUDE_SCRIPT for the review benchmark tests: a review session or a judge call for
// lib/testing/fake-claude.js in script mode.
//   Review session (no --json-schema): calls the Skill tool as a real session does. The fork
//   (parent_tool_use_id = the Skill call) names the recipe "<effort> effort → test recipe"
//   and calls ReportFindings once; the Skill tool result carries FAKE_REVIEW_TEXT. A
//   <synthetic> message follows, as Claude Code adds. FAKE_REVIEW_RAN replaces the model it
//   reports; FAKE_REVIEW_LEVEL replaces the recipe's level; FAKE_REVIEW_NO_SKILL=1 answers
//   without the Skill call; FAKE_REVIEW_FAIL=1 ends with an error result. Appends
//   { args, cwd, stdin, head, remotes } to FAKE_REVIEW_LOG.
//   Judge call: one finding per line of the review starting "- "; a line holding MATCH is
//   matches (bug cases) or harmful (clean cases), others other or valid.
//   FAKE_REVIEW_JUDGE_BAD=1 answers without a findings list.
import { appendFileSync } from "node:fs";

const git = (args, cwd) => Bun.spawnSync(["git", ...args], { cwd }).stdout.toString().trim();

export default async function session({ args, cwd, stdin, emit, option }) {
  const env = process.env;
  const model = option("--model");
  if (args.includes("--version")) {
    console.log("9.9.9 (Claude Code)");
    return;
  }
  const schema = option("--json-schema");
  if (schema) {
    const bug = JSON.parse(schema).properties.findings.items.properties.verdict.enum.includes("matches");
    const lines = stdin.split("\n").filter((line) => line.startsWith("- "));
    const findings = lines.map((line) => ({ summary: line.slice(2), location: "x", verdict: line.includes("MATCH") ? (bug ? "matches" : "harmful") : bug ? "other" : "valid", reason: "r" }));
    emit({ type: "system", subtype: "init", model, tools: ["StructuredOutput"], mcp_servers: [] });
    emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.02, num_turns: 1, result: "", structured_output: env.FAKE_REVIEW_JUDGE_BAD === "1" ? { verdicts: [] } : { findings } });
    return;
  }
  if (env.FAKE_REVIEW_LOG) appendFileSync(env.FAKE_REVIEW_LOG, `${JSON.stringify({ args, cwd, stdin, head: git(["rev-parse", "HEAD"], cwd), remotes: git(["remote"], cwd) })}\n`);
  const ran = env.FAKE_REVIEW_RAN ?? model;
  const skill = "toolu_skill";
  emit({ type: "system", subtype: "init", model: ran, tools: ["Skill", "Agent", "Bash"], mcp_servers: [] });
  if (env.FAKE_REVIEW_NO_SKILL !== "1") {
    emit({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_0", model: ran, content: [{ type: "tool_use", id: skill, name: "Skill", input: { skill: "code-review", args: stdin } }] } });
    emit({ type: "user", parent_tool_use_id: skill, message: { content: [{ type: "text", text: `Review target\n\n\`${env.FAKE_REVIEW_LEVEL ?? option("--effort")} effort → test recipe\`` }] } });
    emit({ type: "assistant", parent_tool_use_id: skill, message: { id: "msg_1", model: ran, content: [{ type: "tool_use", id: "toolu_1", name: "ReportFindings", input: { findings: [{ file: "a.js", summary: "reported" }] } }] } });
    emit({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: skill, content: `Skill "code-review" completed (forked execution).\n\nResult:\n${env.FAKE_REVIEW_TEXT ?? "(none)"}` }] } });
  }
  emit({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_2", model: "<synthetic>", content: [{ type: "text", text: "(none)" }] } });
  emit({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_3", model: ran, content: [{ type: "text", text: "done" }] } });
  if (env.FAKE_REVIEW_FAIL === "1") emit({ type: "result", subtype: "error_during_execution", is_error: true, total_cost_usd: 0.3, num_turns: 1 });
  else emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.7, num_turns: 3, result: "done" });
}
