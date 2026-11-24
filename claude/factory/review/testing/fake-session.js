// FAKE_CLAUDE_SCRIPT for the review tests: a diff-review or a verify session for
// lib/testing/fake-claude.js in script mode. Each call appends { kind, args, cwd, stdin,
// head, remotes } to FAKE_REVIEW_LOG.
//   Review session (no --json-schema): replies directly with FAKE_REVIEW_TEXT (JSON array
//   of diff-review findings). FAKE_REVIEW_FAIL=1 ends with an error result;
//   FAKE_REVIEW_EMPTY=1 ends with an empty result string. Costs $0.70, or $0.30 on failure.
//   Verify session (--json-schema): parses findings from the <review> block (JSON array or
//   "- " lines); a finding holding REAL is confirmed, others rejected. FAKE_VERIFY_NONE=1
//   ends without structured output. Costs $0.40.
import { appendFileSync } from "node:fs";

const git = (args, cwd) => Bun.spawnSync(["git", ...args], { cwd }).stdout.toString().trim();

function parseFindings(review) {
  try {
    const parsed = JSON.parse(review);
    if (Array.isArray(parsed)) {
      return parsed.map((item, i) => ({
        summary: String(item.summary ?? ""),
        location: `${item.file ?? "a.js"}:${item.line ?? i + 1}`,
        verdict: String(item.summary ?? "").includes("REAL") ? "confirmed" : "rejected",
        reason: `reason ${i + 1}`,
        title: `Fix ${item.summary ?? ""}`,
        change: "Change it.",
        size: "S",
        priority: "p2",
      }));
    }
  } catch {}
  return review.split("\n").filter((line) => line.startsWith("- ")).map((line, i) => ({
    summary: line.slice(2), location: `a.js:${i + 1}`, verdict: line.includes("REAL") ? "confirmed" : "rejected", reason: `reason ${i + 1}`,
    title: `Fix ${line.slice(2)}`, change: "Change it.", size: "S", priority: "p2",
  }));
}

export default async function session({ args, cwd, stdin, emit, option }) {
  const env = process.env;
  const model = option("--model");
  const verify = option("--json-schema") !== undefined;
  appendFileSync(env.FAKE_REVIEW_LOG, `${JSON.stringify({ kind: verify ? "verify" : "review", args, cwd, stdin, head: git(["rev-parse", "HEAD"], cwd), remotes: git(["remote"], cwd) })}\n`);
  emit({ type: "system", subtype: "init", model, tools: verify ? ["Read", "Grep", "Glob", "Bash", "StructuredOutput"] : ["Read", "Grep", "Glob", "Bash"], mcp_servers: [] });
  if (verify) {
    const review = /<review>\n([\s\S]*)\n<\/review>/.exec(stdin)?.[1] ?? "";
    const findings = parseFindings(review);
    emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.4, num_turns: 4, result: "", ...(env.FAKE_VERIFY_NONE === "1" ? {} : { structured_output: { findings } }) });
    return;
  }
  const text = env.FAKE_REVIEW_EMPTY === "1" ? "" : (env.FAKE_REVIEW_TEXT ?? "[]");
  emit({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_1", model, content: [{ type: "text", text }] } });
  if (env.FAKE_REVIEW_FAIL === "1") emit({ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.3, num_turns: 1 });
  else emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.7, num_turns: 3, result: text });
}
