# Reporting setup feedback

These rules are part of the global instructions (`~/.claude/CLAUDE.md`, Feedback section) and have the same force. Read them when a setup gets in your way.

- When a setup gets in your way (the board, these instructions, an agent definition, a skill, a hook, a tool or its configuration, storage, T3, or a project's own setup), report it once with the `feedback` MCP tool, or `board feedback --about <setup> --activity <activity> '<what happened>'` where the tool is missing, then continue with a workaround; a problem you got past still needs its report. Name the setup (an id from `~/.config/setups.toml`, `other` when unsure), what you were doing (`explore`, `research`, `design`, `plan`, `build`, `review`, `operate` or `other`), the error or cost, and the workaround. A report makes a task; repeats add to it; triage routes it to the setup's owner, so don't follow it up. Report it in your reply instead when filing fails; subagents report it to their parent, which files it.
- Report friction with the setup, not defects in the work itself: a project's bugs stay on its board, and a skill's guidance problems go through that skill's own feedback capture.
