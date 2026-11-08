// Claude Code PreToolUse hook for the board's ask_user tool. Enforces the Autonomy rule in
// ~/.claude/CLAUDE.md: agents notify the user only for a reason that ask-policy.json lists
// (design, cost, irreversible, outside, only-me), and do every other step themselves. An ask
// must name its reason as `Reason: <name>`; an `action` ask, which hands the user a step,
// must name one of the policy's action_reasons. Otherwise the hook blocks the ask (exit 2)
// and its stderr tells the agent what to do instead. The user tunes the reasons in
// ask-policy.json. The guard fails open: on a crash or an unreadable policy the ask goes through.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REASON = /\breason:\s*`?([a-z][a-z-]*)/i;

/** Why `input` (the ask_user tool input) must not reach the user under `policy`, or undefined. */
export function askViolation(input, policy) {
  const names = Object.keys(policy.reasons);
  const question = typeof input?.question === "string" ? input.question : "";
  const reason = question.match(REASON)?.[1]?.toLowerCase();
  const listed = names.map((name) => `- ${name}: ${policy.reasons[name]}`).join("\n");
  const never = policy.never.map((line) => `- ${line}`).join("\n");
  const help = `The user is notified only for these reasons (~/.claude/hooks/ask-policy.json):\n${listed}\n`
    + `These are never reasons to ask; do the step yourself:\n${never}`;
  if (!reason)
    return `the ask names no reason. If it fits one, add \`Reason: <name>\` to its "why it waits on you" line and ask again.\n${help}`;
  if (!names.includes(reason))
    return `\`Reason: ${reason}\` is not a listed reason.\n${help}`;
  if (input.kind === "action" && !policy.action_reasons.includes(reason))
    return `an action ask hands the user a step, which only \`Reason: ${policy.action_reasons.join("` or `")}\` allows. `
      + `Do the step yourself, or ask for the decision (kind decision) and then act on the answer.\n${help}`;
  return undefined;
}

if (import.meta.main) {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const policy = JSON.parse(readFileSync(process.env.ASK_POLICY ?? join(import.meta.dir, "ask-policy.json"), "utf8"));
  const violation = askViolation(input?.tool_input, policy);
  if (violation) {
    process.stderr.write(`Blocked by the guard-asks hook: ${violation}\n`);
    process.exit(2);
  }
}
