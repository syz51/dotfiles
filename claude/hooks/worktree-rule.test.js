import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { claudeWorktree, output, rule } from "./worktree-rule.js";

const HOOK = join(import.meta.dir, "worktree-rule.js");
const WT = "/repo/.claude/worktrees/agent-a47b";

function run(input) {
  const result = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout;
}

describe("which paths are Claude Code worktrees", () => {
  test("a path under .claude/worktrees/<name> gives the worktree root", () => {
    expect(claudeWorktree(WT)).toBe(WT);
    expect(claudeWorktree(`${WT}/src/lib`)).toBe(WT);
  });

  test("a main checkout, a T3 worktree and a bare worktrees folder give none", () => {
    expect(claudeWorktree("/repo")).toBeUndefined();
    expect(claudeWorktree("/home/u/.t3/worktrees/.config/t3-abc")).toBeUndefined();
    expect(claudeWorktree("/repo/.claude/worktrees/")).toBeUndefined();
    expect(claudeWorktree(undefined)).toBeUndefined();
  });
});

describe("when the hook speaks", () => {
  test("after EnterWorktree it names the new worktree and the subagents to restart", () => {
    const out = output({ hook_event_name: "PostToolUse", tool_name: "EnterWorktree", cwd: "/repo", tool_response: { worktreePath: "/repo/.claude/worktrees/probe" } });
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain("stays in /repo/.claude/worktrees/probe.");
    expect(out.hookSpecificOutput.additionalContext).toContain("Subagents started before EnterWorktree");
  });

  test("a subagent whose cwd is a Claude Code worktree gets the rule without the restart line", () => {
    const out = output({ hook_event_name: "SubagentStart", cwd: WT, agent_id: "a47b", agent_type: "worker" });
    expect(out.hookSpecificOutput).toEqual({ hookEventName: "SubagentStart", additionalContext: rule(WT) });
    expect(rule(WT)).not.toContain("Subagents started before");
  });

  test("a session that starts or compacts inside such a worktree gets the rule", () => {
    const out = output({ hook_event_name: "SessionStart", source: "compact", cwd: `${WT}/sub` });
    expect(out.hookSpecificOutput).toEqual({ hookEventName: "SessionStart", additionalContext: rule(WT) });
  });

  test("it stays quiet outside Claude Code worktrees and for other tools or events", () => {
    expect(output({ hook_event_name: "SubagentStart", cwd: "/repo" })).toBeUndefined();
    expect(output({ hook_event_name: "SessionStart", cwd: "/home/u/.t3/worktrees/.config/t3-abc" })).toBeUndefined();
    expect(output({ hook_event_name: "PostToolUse", tool_name: "Bash", cwd: WT })).toBeUndefined();
    expect(output({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: WT })).toBeUndefined();
  });

  test("as a command it prints the JSON output, or nothing", () => {
    expect(JSON.parse(run({ hook_event_name: "SubagentStart", cwd: WT })).hookSpecificOutput.additionalContext).toBe(rule(WT));
    expect(run({ hook_event_name: "SubagentStart", cwd: "/repo" })).toBe("");
  });
});

// The forms come from live probes on Claude Code 2.1.319 (dotfiles-111): these were refused,
// and plain loops, pipes, heredocs, cd and VAR=value prefixes without them passed.
describe("the rule names the measured forms and the allowed routes", () => {
  const text = rule(WT, { entered: true });
  test.each([
    ["git words in compound forms", "git, gitleaks or the word git inside a loop, `$(…)` or heredoc, or next to a `$variable` or `$?`"],
    ["code-running programs with computed values", "A program that runs code, such as sed, bash or bun, given a `$variable` or `$(…)` value"],
    ["eval anywhere", "The word eval anywhere, even in a quoted grep pattern. Write the pattern as `ev[a]l`."],
    ["other checkouts", "git, `git -C` or `cd` aimed at another checkout. Do that work from a session or delegate started there."],
    ["gitleaks git", "`gitleaks git`. Write the diff to a scratch file in its own call, then run `gitleaks dir <file>`."],
    ["no hidden scripts", "never hide a refused command in a script"],
    ["what passes", "Loops, pipes, heredocs, `cd` and `VAR=value cmd` pass without these forms."],
    ["polls", "For a poll, use a loop of plain commands with no git word, such as `until gh pr checks 12; do sleep 30; done`, or the Monitor tool."],
  ])("%s", (_, phrase) => expect(text).toContain(phrase));
});
