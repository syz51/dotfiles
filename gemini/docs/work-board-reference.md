# Work Board Reference

These rules are part of the global instructions (`~/.gemini/config/GEMINI.md`, Work board section) and have the same force. Read this file when filing `Proposal:` tasks, writing `ask_user` decision briefs, filing on another repository's board, or coordinating with Gemini-first offloading.

## Board Tools

- The `board` MCP server (lazy-loaded via `call_mcp_tool` after reading `<appDataDir>/mcp/board/` schemas) and `~/.cargo/bin/board` CLI connect to the shared work board. Use the `board` CLI where MCP tools are missing.

## `ask_user` Decision Briefs

- Before `ask_user`, search memory, the board (notes and answered asks), repositories, and related threads for the answer; an ask states what you found and asks only what remains.
- Open each board `ask_user` and the body of each task waiting on user decision or action with a short, plain brief: what it is (one sentence), why it waits on the user (with `Reason: <name>`), the options with their consequences, and your recommendation; put agent detail below.

## Filing Remaining Scope, Proposals & Cross-Repo Work

- Direct user requests get their own task, including work deferred for later: before changing files or state, add one unless a task already covers it, and claim it.
- Work in another repository goes on that repository's board; never assume it has none. Use `board boards` and `board status --board <slug>`, search first with `board ls --board <slug> --search <words>`, and add a note to an existing covering task instead of duplicating it.
- Before `task_done` and before ending a turn, file each remaining step, follow-up, and suggestion (checking first for a covering task to add a note to):
  - Remaining task scope as a sub-task (`parent`: your task).
  - Out-of-scope work as a proposal (`auto=false`, body starting `Proposal:` with problem, evidence without secrets, change, and size `S`/`M`/`L`) on that repo's board (or this one if it has none), naming the task where you found it.
  - User decisions/actions as a task with `auto=false`, setting `blocked` only once its `ask_user` is accepted.
- Keep your task open until every acceptance check passes.
- In your reply, every open item (a limit needing work, follow-up, suggestion, or step waiting on the user) must name its task or ask id, or state why it needs no work (`no action: <reason>` — an agent's verdict alone is not a reason). If filing fails, report the item instead. Never ask before filing. A handoff's `next` holds only your claimed task's first action. The `open-items` stop hook enforces this.
- Read-only work (reviews, investigations) files on the board too unless asked not to touch the board. `invoke_subagent` subagents share your board identity and never file — they report findings to you, and you file each real item you do not fix. Separate T3 threads (`delegate_task`, `t3_thread_launch`) file for themselves.

## Gemini-first Offloading

- **Gemini-first offloading**: Gemini App (separate Ultra pool via Cloud MCP + `board-ops` skill; `~/.config/gemini/docs/gemini-board-workflow.md`) handles complementary non-code web research, digests, backlog grooming, and additive user/feedback triage without altering or interfering with board judge or autopilot pipelines. Keep non-code findings, asks, and proposals cleanly structured on the board; reserve Antigravity Mac quota for local code, builds, tests, git, and deploys.
