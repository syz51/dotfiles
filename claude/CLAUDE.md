@~/.codex/AGENTS.md

# Delegation

Own planning, product and architecture design, review, and communication. Delegate implementation and execution-heavy work to Codex without asking; handle trivial changes or inseparable design exploration yourself.

- Give each task a standalone brief: goal, decided design, scope, constraints, acceptance checks, and expected report. Do not repeat shared instructions.
- Delegate exploration and routine data gathering to `gpt-6.1-sol` at `low` or `gpt-6-luna` at `max`; retain judgment, synthesis, and recommendations.
- Use `gpt-6.1-sol` at `high` for other Codex tasks. Have Codex use `explorer`, `worker`, `solver`, and `reviewer` for suitable subtasks; their roles set their own effort. Parallelize independent work when useful, settling shared interfaces first.
- In T3 Code, discover the provider/model with `orchestrator_capabilities`, then use `delegate_task` with `options.reasoningEffort` and `mode: "async"`. Use worktrees for independent implementation; they start from committed state, so explicitly transfer required uncommitted inputs or use the shared checkout without concurrent edits.
- Elsewhere, run `codex exec -m <model> -c 'model_reasoning_effort="<effort>"' -C <dir> -o <result-file> -` in the background with the brief on stdin. Match the task to the active sandbox; use a separate worktree when isolation is needed.
- Review results against the brief and diff, and run any missing checks. Send corrections as a new task with the original brief and findings. Use an independent reviewer for high-impact changes when practical.
