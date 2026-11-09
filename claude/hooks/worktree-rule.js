// Claude Code hook for PostToolUse (EnterWorktree), SubagentStart and SessionStart. In a
// worktree-isolated session, Claude Code's own guard refuses each Bash command it cannot
// verify stays in the worktree. It runs inside Bash execution, after every hook, and no
// setting turns it off for a foreground session or a subagent. A broad CLAUDE.md rule did not
// stop the refusals (board-feedback-109, dotfiles-111), so this hook gives the forms the
// guard refuses, measured on Claude Code 2.1.319, at the moment isolation starts: after
// EnterWorktree, at the start of a subagent whose cwd is a Claude Code worktree (worktree
// isolation, or a parent that entered one), and at session start or after compaction there.
// Claude Code puts these worktrees under <repo>/.claude/worktrees/<name>; T3 worktree
// threads live elsewhere and run without the guard, so they get nothing. It never blocks.
import { readFileSync } from "node:fs";

const MARKER = "/.claude/worktrees/";

/** The Claude Code worktree that holds `path`, or undefined. */
export function claudeWorktree(path) {
  if (typeof path !== "string") return undefined;
  const at = path.indexOf(MARKER);
  if (at === -1) return undefined;
  const name = path.slice(at + MARKER.length).split("/")[0];
  return name ? path.slice(0, at + MARKER.length + name.length) : undefined;
}

/** The note for a session or agent isolated in `worktree`. */
export function rule(worktree, { entered = false } = {}) {
  const lines = [
    `Worktree isolation: Claude Code refuses each Bash command that it cannot verify stays in ${worktree}. No setting turns this off. It refuses these forms; write around them, and never hide a refused command in a script:`,
    "- git, gitleaks or the word git inside a loop, `$(…)` or heredoc, or next to a `$variable` or `$?`. Run git with literal arguments, alone or joined to plain commands with && or |.",
    "- A program that runs code, such as sed, bash or bun, given a `$variable` or `$(…)` value. Give it literal paths and text.",
    "- The word eval anywhere, even in a quoted grep pattern. Write the pattern as `ev[a]l`.",
    "- git, `git -C` or `cd` aimed at another checkout. Do that work from a session or delegate started there.",
    "- `gitleaks git`. Write the diff to a scratch file in its own call, then run `gitleaks dir <file>`.",
    "Loops, pipes, heredocs, `cd` and `VAR=value cmd` pass without these forms. For a poll, use a loop of plain commands with no git word, such as `until gh pr checks 12; do sleep 30; done`, or the Monitor tool.",
  ];
  if (entered) lines.push("Subagents started before EnterWorktree stay outside the worktree, and the guard refuses their Bash calls: stop them and start them again.");
  return lines.join("\n");
}

/** The hook's output for one input, or undefined when the session is not isolated. */
export function output(input) {
  const event = input.hook_event_name;
  if (event === "PostToolUse") {
    if (input.tool_name !== "EnterWorktree") return undefined;
    const worktree = claudeWorktree(input.tool_response?.worktreePath ?? input.cwd);
    return worktree && { hookSpecificOutput: { hookEventName: event, additionalContext: rule(worktree, { entered: true }) } };
  }
  if (event !== "SubagentStart" && event !== "SessionStart") return undefined;
  const worktree = claudeWorktree(input.cwd);
  return worktree && { hookSpecificOutput: { hookEventName: event, additionalContext: rule(worktree) } };
}

if (import.meta.main) {
  const result = output(JSON.parse(readFileSync(0, "utf8")));
  if (result) process.stdout.write(JSON.stringify(result));
}
