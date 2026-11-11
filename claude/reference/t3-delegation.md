# T3 delegates and threads

These rules are part of the global instructions (`~/.claude/CLAUDE.md`, Delegation section) and have the same force. Read them before a `delegate_task` or `t3_thread_launch` call.

- Pass a `t3_thread_launch` brief in `message`; T3 silently drops a `prompt` key and starts no run, so when the result's `runId` is null, send the brief with `t3_thread_send`.
- A local `delegate_task` leaves out `target.projectId`; T3 refuses another project's id, even with a local `target.environmentId`. To dispatch a board task whose code is in another repository, call `t3_thread_launch` with that project's `projectId` and `workspaceStrategy` `{type: "worktree", baseRef: "origin/<default branch>", startFromOrigin: true}`. That thread opens its own PR there. Dispatching a board task counts as my standing request for such a thread; work you find in another repository still becomes a proposal.
