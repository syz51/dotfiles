# Delegation compatibility and general fallback

Read this when selecting a general fallback without a matching configured role,
or when the active runtime cannot apply native configured Codex roles.
The runtime's current tools, permissions, and orchestration instructions govern
execution. Do not use another provider, a CLI, or a new thread to bypass an
unavailable requested provider or a runtime restriction.

## Preserve the role contract

- Read the selected role's configuration at `~/.codex/agents/<role>.toml`. Transfer
  its actual `developer_instructions`, model, and reasoning effort; a role label
  alone does not load that configuration. Never infer settings from a role name.
- For a general task with no matching configured role, the preferred fallback is
  `gpt-6.1-sol` with `high` reasoning. If unavailable, report the limitation;
  follow the active runtime's rules for any alternative.
- Children inherit the active sandbox and approval constraints. Role prose cannot
  grant permissions. Keep the brief scoped and wait for the actual result before
  claiming completion.

## Select the supported execution surface

- Prefer native configured roles when the active runtime permits the requested
  model and execution settings.
- In T3 Code, use its current delegation instructions to choose native delegation
  or `delegate_task`, including provider, worktree, settings, and background-work
  constraints. Call `orchestrator_capabilities` before the first `delegate_task`
  in the thread; do not call it merely to use native roles. Read live tool schemas
  instead of retaining argument layouts here. Never create a top-level thread
  unless the user requests one.
- Outside T3 Code, a local `codex exec` fallback is appropriate only when the
  runtime permits it and the installed CLI supports the required controls. Check
  its help; pass the configured model/effort and working directory, send the
  standalone brief and role instructions on stdin, capture a result file under
  the task scratch directory, and run in the background only when supported.
  Bound execution, await completion, inspect the diff/checks, and clean up
  task-owned artifacts. Do not broaden the sandbox to make a fallback work.

## Preserve inputs and isolation

Worktrees begin from committed state. Transfer necessary uncommitted inputs
explicitly and verify them in the child checkout. Use the runtime's worktree
facility when it owns checkout binding; do not create shell worktrees as a
substitute. When sharing a checkout, assign disjoint files and avoid concurrent
edits to the same file. Match isolation to the task and active sandbox.
