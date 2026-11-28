// Claude Code SessionStart hook (compact). After a context compaction, Claude Code
// re-attaches previously invoked skills (`attachment.type === "invoked_skills"`) with a
// header stating "They are shown here for context only so you remain aware of their
// guidelines" and "Only continue to apply ongoing behavioral guidelines from these skills
// where still relevant." Agents then stopped following binding skill rules
// (board-feedback-977, dotfiles-787). This hook runs only for source "compact" (costing
// nothing on uncompacted turns) and adds one reminder line. It never blocks.
import { readFileSync } from "node:fs";

export const REMINDER = "skills loaded before the compaction still apply; invoke the skill again before the next step it covers";

/** The hook's output for one SessionStart input, or undefined when not a compaction. */
export function output(input) {
  if (!input || typeof input !== "object") return undefined;
  if (input.hook_event_name !== undefined && input.hook_event_name !== "SessionStart") return undefined;
  if (input.source !== "compact") return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: REMINDER,
    },
  };
}

if (import.meta.main) {
  const result = output(JSON.parse(readFileSync(0, "utf8")));
  if (result) process.stdout.write(JSON.stringify(result));
}
