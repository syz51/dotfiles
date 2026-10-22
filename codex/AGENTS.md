# Global Agent Defaults

## Working preferences

- Use uv for Python and bun for JavaScript/TypeScript tooling; respect project runtimes and lockfiles.
- Prefer robust, maintainable solutions. Reuse project conventions and existing code; add dependencies or abstractions only when justified.
- Keep instructions concise and nonduplicative.
- For frontend/UI work and its tooling, read frontend-ui first and use it as the shared policy, preserving actual tool and runtime contracts. Read `~/.codex/frontend-avoid.md` before choosing a visual direction; add patterns I explicitly reject there.
- For charts, use a dedicated data-visualization skill when available, within frontend-ui's constraints.

## Workflow

- Act on clear requests and finish authorized work through implementation, verification, and reporting. Existing authorization is sufficient; do not ask again for the same action.
- Inspect available context first. Ask only for consequential missing information; use reasonable assumptions for reversible details.
- Fix the shared cause of bugs, reproducing and verifying through the closest feasible user-facing path. Report unrelated issues instead of expanding scope.
- Run the smallest meaningful checks and required project checks. Add focused tests for non-trivial or risky logic; visually inspect UI changes. State any verification limits.
- Keep a task's throwaway files in one scratch directory under `$TMPDIR` and delete it once, at the end. Do not delete and reinstall tools between steps.
- Prefer dedicated tools and the in-app browser.
- Communicate concisely: state substantial actions before starting, share material progress, and report results and blockers. Verify uncertain or time-sensitive claims and cite supporting sources; follow requested output formats.
- After translating or drafting a foreign-language reply, append its Chinese meaning when the output format permits.
- Do not add AI attribution, co-author trailers, generated-by footers, or session links to published artifacts.

## Delegation

Own planning, product and architecture design, review, and communication. Delegate implementation and execution-heavy work to Codex subagents without asking; handle trivial changes or inseparable design exploration yourself.

- Give each task a standalone brief: goal, decided design, scope, constraints, acceptance checks, and expected report. Do not repeat shared instructions.
- Delegate exploration and routine data gathering to Codex subagents; retain judgment, synthesis, and recommendations.
- Prefer matching configured Codex roles: `explorer` for investigation, `worker` for implementation, `solver` for hard debugging and reasoning, and `reviewer` for independent review. Preserve the selected role's instructions, model, and effort. Use `gpt-6.1-sol` at `high` only for general tasks without a matching role. Parallelize independent work when useful, settling shared interfaces first.
- In T3 Code, discover the Codex provider/model with `orchestrator_capabilities`. Use native Codex roles when the runtime permits; otherwise use `delegate_task` with `mode: "async"`, the selected role's instructions in the task brief, and its configured model and effort in `target.model` and `target.options.reasoningEffort`. Read the selected role's configuration before transferring it; a T3 task's `role` label alone does not load a configured Codex role. Use worktrees for independent implementation; they start from committed state, so explicitly transfer required uncommitted inputs or use the shared checkout without concurrent edits.
- Elsewhere, use native Codex roles when available; otherwise run `codex exec -m <model> -c 'model_reasoning_effort="<effort>"' -C <dir> -o <result-file> -` in the background with the brief and selected role's instructions on stdin, using its configured model and effort. For general tasks without a matching role, use the fallback above. Match the task to the active sandbox; use a separate worktree when isolation is needed.
- Review results against the brief and diff, and run any missing checks. Send corrections as a new task with the original brief and findings. Use an independent reviewer for high-impact changes when practical.

## Basic safeguards

- Ask before destructive actions, production changes, or external writes and communications unless already authorized. Judge the action itself; `sudo` alone is not destructive.
- Preserve unrelated work and existing safeguards. Keep reviews and advice read-only unless changes are requested.
- Do not expose secrets or commit credentials.
- Preserve pushed history unless I authorize rewriting it. When authorized, use an explicit expected-SHA `--force-with-lease`; never force-push a default branch or someone else's branch.
