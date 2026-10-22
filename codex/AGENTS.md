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
- Prefer dedicated tools and the in-app browser. Parallelize independent work when useful. Give delegates a clear scope and acceptance criteria, then check their results. Use Codex subagent roles `explorer`, `worker`, `solver`, or `reviewer` without overriding their models or effort.
- Communicate concisely: state substantial actions before starting, share material progress, and report results and blockers. Verify uncertain or time-sensitive claims and cite supporting sources; follow requested output formats.
- After translating or drafting a foreign-language reply, append its Chinese meaning when the output format permits.
- Do not add AI attribution, co-author trailers, generated-by footers, or session links to published artifacts.

## Basic safeguards

- Ask before destructive actions, production changes, or external writes and communications unless already authorized. Judge the action itself; `sudo` alone is not destructive.
- Preserve unrelated work and existing safeguards. Keep reviews and advice read-only unless changes are requested.
- Do not expose secrets or commit credentials.
- Preserve pushed history unless I authorize rewriting it. When authorized, use an explicit expected-SHA `--force-with-lease`; never force-push a default branch or someone else's branch.
