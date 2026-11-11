# opencode notes

The instructions in `~/.claude/CLAUDE.md` were written for Claude Code. In opencode, apply them with these translations.

## Tools

- Claude's `Bash`, `Read`, `Grep`, `Glob`, `WebFetch` and `WebSearch` are `shell`, `read`, `grep`, `glob`, `webfetch` and `websearch`. Use native `patch` for `Edit` and `Write` when those tools are absent.
- `Skill` is `skill`. OpenCode discovers both `~/.claude/skills` and `~/.agents/skills`; duplicate IDs in `.agents` override `.claude`. OpenCode-native and explicit skill sources can override both.
- `AskUserQuestion` is `question`.
- `Agent` is native `subagent`. The `explorer`, `worker` and `solver` agents keep their Delegation roles; `general` stands in for `general-purpose`. Native children have no automatic worktree isolation.
- Discover OpenCode's worktree tools with `search({ namespace: "opencode", query: "worktree" })` inside `execute`. Call the returned exact tool path through `tools` inside `execute`; do not call a guessed direct `opencode_worktree_create` tool. Create an editing child's worktree before delegation and name it in the brief. Move the current session with the discovered `session_move` tool when needed.
- The board's MCP tools are `board_<tool>`, such as `board_board_snapshot` and `board_task_claim`. Never pass their `agent` argument: the `claude-hooks` plugin fills in this session's board identity. The `board` CLI in `shell` gets the same identity, `opencode:<session id>`, from `OPENCODE_SESSION_ID`. The board's weekly usage hold covers only Claude Code, so it does not stop opencode sessions; a paused board still does.
- The computer-use tools are `desktop_<tool>`.
- Determine capabilities from the current tool catalog and host instructions. Native OpenCode does not provide Claude Code's `ToolSearch` or `/code-review`. A host can supply T3, artifacts, scheduling, or review tools, including through Code Mode. Discover these before treating a host-specific step as unavailable.

## Hooks

- The `claude-hooks` plugin runs the hooks in `~/.claude/settings.json`: the guards, the board hooks, atuin, `freshen-base` and `stale-base`.
- A guard refuses a tool call with an error that gives its reason. Find the allowed route as `CLAUDE.md` says; never pass a guard through a script it cannot see.
- This imports supported hook events, not all Claude settings. OpenCode's config, permissions, compaction, MCP servers, and plugin loading remain separate.
- `setup-policy` preserves role restrictions even under a host's full-access session rules. Explorers use native reads, searches, and web fetches; custom `explorer` can also load skills. They cannot run shell, Code Mode, mutations, MCP actions, or subagents. Worker, solver, and general cannot start more subagents. These are role guardrails, not an OS sandbox.

## Review

- Without a host-provided review process, review high-impact changes once using one `general` subagent with the final diff. Ask for correctness, security, and reliability defects with file:line evidence. Give it the required isolated worktree.
- Decide each finding as the Review section says. Without a host-provided findings tool, record outcomes as a `decision` note on the board task.

## Threads and memory

- Use actual host guidance to identify a T3 thread. A hosted parent follows that host's lifecycle and settle rules. A native `subagent` child never settles the parent's thread. A standalone session has no T3 thread to settle.
- Memory comes from the plugin, not OpenCode's native instructions discovery. Native children receive the project's memory index on their first context request, without running root lifecycle hooks. Children do not file board work; their parent files their findings. Use the injected memory path and read needed fact files explicitly. To save memory, write one file per fact with `name`, `description`, and `metadata.type` frontmatter, then update that directory's `MEMORY.md`.

## Models

- In opencode, the user chose GPT models over Claude. `CLAUDE.md`'s Claude-only rule covers Claude Code; here it means: use only the models that the user configured.
- The default model is `opencode/gpt-6.1-sol` with per-model `reasoningEffort: "xhigh"`. The catalog default drops root `#variant` suffixes, so configuration does not rely on one. `worker` and `solver` explicitly select `opencode/gpt-6.1-sol#xhigh`; `explorer` selects `opencode/gpt-6-luna#max`.
- Never pass a `model` to `subagent`; each agent keeps its configured model. Never start the `codex` CLI.
