// FAKE_CLAUDE_SCRIPT for the review tests: a review or a verify session for
// lib/testing/fake-claude.js in script mode. Each call appends { kind, args, cwd, stdin,
// head, remotes } to FAKE_REVIEW_LOG.
//   Review session (no --json-schema): calls the Skill tool as a real session does; the
//   fork names the recipe "<effort> effort → test recipe" and the tool result carries
//   FAKE_REVIEW_TEXT. FAKE_REVIEW_FAIL=1 ends with an error result; FAKE_REVIEW_NO_SKILL=1
//   answers without the Skill call. Costs $0.70, or $0.30 when it fails.
//   Verify session (--json-schema): one finding per line of the review starting "- ";
//   a line holding REAL is confirmed, others rejected. FAKE_VERIFY_NONE=1 ends without
//   structured output. Costs $0.40.
import { appendFileSync } from "node:fs";

const git = (args, cwd) => Bun.spawnSync(["git", ...args], { cwd }).stdout.toString().trim();

export default async function session({ args, cwd, stdin, emit, option }) {
  const env = process.env;
  const model = option("--model");
  const verify = option("--json-schema") !== undefined;
  appendFileSync(env.FAKE_REVIEW_LOG, `${JSON.stringify({ kind: verify ? "verify" : "review", args, cwd, stdin, head: git(["rev-parse", "HEAD"], cwd), remotes: git(["remote"], cwd) })}\n`);
  emit({ type: "system", subtype: "init", model, tools: verify ? ["Read", "Grep", "Glob", "Bash", "StructuredOutput"] : ["Skill", "Agent", "Bash"], mcp_servers: [] });
  if (verify) {
    const review = /<review>\n([\s\S]*)\n<\/review>/.exec(stdin)?.[1] ?? "";
    const findings = review.split("\n").filter((line) => line.startsWith("- ")).map((line, i) => ({
      summary: line.slice(2), location: `a.js:${i + 1}`, verdict: line.includes("REAL") ? "confirmed" : "rejected", reason: `reason ${i + 1}`,
      title: `Fix ${line.slice(2)}`, change: "Change it.", size: "S", priority: "p2",
    }));
    emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.4, num_turns: 4, result: "", ...(env.FAKE_VERIFY_NONE === "1" ? {} : { structured_output: { findings } }) });
    return;
  }
  const skill = "toolu_skill";
  if (env.FAKE_REVIEW_NO_SKILL !== "1") {
    emit({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_0", model, content: [{ type: "tool_use", id: skill, name: "Skill", input: { skill: "code-review", args: stdin } }] } });
    emit({ type: "user", parent_tool_use_id: skill, message: { content: [{ type: "text", text: `Review target\n\n\`${option("--effort")} effort → test recipe\`` }] } });
    emit({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: skill, content: `Skill "code-review" completed (forked execution).\n\nResult:\n${env.FAKE_REVIEW_TEXT ?? "(none)"}` }] } });
  }
  emit({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_1", model, content: [{ type: "text", text: "done" }] } });
  if (env.FAKE_REVIEW_FAIL === "1") emit({ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.3, num_turns: 1 });
  else emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.7, num_turns: 3, result: "done" });
}
