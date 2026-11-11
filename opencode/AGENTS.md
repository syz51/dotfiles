# opencode notes

The instructions in `~/.claude/CLAUDE.md` were written for Claude Code. In opencode, apply them with these translations.

## Tools

- Claude's `Bash`, `Read`, `Edit`, `Write`, `Grep`, `Glob`, `WebFetch` and `WebSearch` are `shell`, `read`, `edit`, `write`, `grep`, `glob`, `webfetch` and `websearch`.
- `Skill` is `skill`. The skills in `~/.claude/skills` load as they do in Claude Code.
- `AskUserQuestion` is `question`.
- `Agent` is `subagent`. The `explorer`, `worker` and `solver` agents keep the roles that the Delegation section gives them; `general` stands in for `general-purpose`. A subagent has no worktree isolation: create one with `opencode_worktree_create` and name it in the brief.
- `EnterWorktree` is `opencode_worktree_create`.
- The board's MCP tools are `board_<tool>`, such as `board_board_snapshot` and `board_task_claim`. Never pass their `agent` argument: the `claude-hooks` plugin fills in this session's board identity. The `board` CLI in `shell` gets the same identity from `CLAUDE_CODE_SESSION_ID`.
- The computer-use tools are `desktop_<tool>`.
- opencode has no `ToolSearch`, `Artifact`, `ReportFindings`, `Monitor`, `ScheduleWakeup` or T3 tools. Skip the instructions that depend only on them.

## Hooks

- The `claude-hooks` plugin runs the hooks in `~/.claude/settings.json`: the guards, the board hooks, atuin, `freshen-base` and `stale-base`.
- A guard refuses a tool call with an error that gives its reason. Find the allowed route as `CLAUDE.md` says; never pass a guard through a script it cannot see.

## Review

- `/code-review` does not exist here. For a change that `CLAUDE.md` calls high-impact, start one `general` subagent with the final diff, such as `git diff origin/main...HEAD`, and ask it to report correctness, security and reliability defects with file:line evidence.
- Decide each finding as the Review section says. Record the outcomes as a `decision` note on the board task in place of `ReportFindings`.

## Threads and memory

- An opencode session is not a T3 thread. Skip the T3 thread rules, such as settling.
- The plugin adds Claude Code's memory index for this project, `MEMORY.md`, to the context at session start. To save a memory, write one file per fact in that directory with `name`, `description` and `metadata.type` frontmatter, then add a one-line pointer to `MEMORY.md`.

## Models

- Use only `opencode/claude-opus-5-5` and `opencode/claude-haiku-5-5`, with a `#variant` for the effort level.
