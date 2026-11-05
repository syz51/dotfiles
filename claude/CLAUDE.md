# Global Agent Defaults

## Working preferences

- Run all Python through `uv run`, including one-off scripts and inline snippets; never invoke a Python interpreter, `pip` or `pytest` directly. Run JavaScript/TypeScript scripts, checks, tooling and package queries with `bun` or `bunx`; use npm, npx, pnpm or yarn only where the project's lockfiles select them. Respect project runtimes.
- Reuse project conventions and existing code. Add dependencies or abstractions only when justified; keep single-use logic inline unless extraction clarifies a complex boundary or meaningful concept.
- Validate unknown inputs at their owning boundary, then pass validated, typed values inward. Do not recheck invariants established by validation, constructors, or trusted internal contracts.
- Let errors propagate unless this layer can recover, add useful context, or translate them at a boundary. Keep `try`/`catch` narrow; never silently swallow errors.
- Never turn on fast mode, the `ultrathink` or `ultracode` effort levels, or an `ultra` code review.

## Skills

- Load skills with the Skill tool before matching work: `frontend-ui` for frontend/UI work or its tooling, including TSX and Vue; `typescript` for TypeScript implementation, review, debugging, migration, or tooling; `rust` for Rust or Cargo/toolchain work; and `tauri` for Tauri work. When several apply, load `frontend-ui` first. Follow each skill's routing to the references the task needs; unrelated work in a TypeScript or Rust repository needs neither language skill.
- Before choosing a visual direction, read `~/.claude/frontend-avoid.md`. Record only patterns I explicitly reject as defaults; keep project-specific exclusions in that project's instructions.
- For charts, load a data-visualization skill such as `dataviz` and apply it within `frontend-ui`'s constraints.

## Workflow

- Inspect available context, then finish authorized work through implementation, verification, and reporting without repeated confirmation. Ask only for consequential missing information or actions beyond existing authorization; use reasonable assumptions for reversible details.
- Fix shared causes and verify through the closest feasible user-facing path. Report unrelated issues without expanding scope.
- Run the smallest meaningful checks and required project checks. Add focused tests for non-trivial or risky logic; visually inspect UI changes and state verification limits.
- Keep temporary files in the session scratchpad when one is provided, otherwise in one task directory under `$TMPDIR`; remove them before finishing. Do not delete and reinstall tools between steps.
- Prefer dedicated tools. Inspect UI with the `headless-browser` skill; use the in-app browser only when I ask for it.
- Keep responses and durable instructions concise and nonduplicative. State substantial actions before starting, share material progress, and report results and blockers. Verify uncertain or time-sensitive claims and cite supporting sources.
- For a requested draft or translation into a non-Chinese language, include the reply followed by its Chinese meaning. Omit the meaning only when an explicit output-only or structured-format requirement excludes it. Do not duplicate Chinese-only replies.
- Do not add AI attribution or generated-by footers to commits, PRs, or anything else I publish.

## Delegation

- This section is my standing request to use subagents, so don't wait for me to ask. Delegate only when running work in parallel pays off: sizeable, independent tracks that can run at the same time, such as a wide investigation of separate areas, with one agent per track, or one such track running while you continue other work. Do everything else yourself, including work that shares this conversation's context, iterates with me, or takes only a handful of tool calls. Don't use subagents to verify your own work beyond the Review section's `/code-review`. Agents that stand in for a tool you lack, such as `web-fetch`, are tool use, not delegation.
- Choose each track's agent by what it does: read-only investigation to `explorer`, file edits and other state-changing work to `worker`, and hard debugging or reasoning to `solver`. Keep the count low, and don't override an agent's configured model or effort.
- Settle shared interfaces first, then give each agent a standalone brief with the goal, decided design, scope, constraints, acceptance checks, and expected report; do not repeat shared instructions.
- Isolate tracks that edit files with the runtime's worktree facility, never a worktree made in the shell. A new worktree never has uncommitted changes, so transfer required inputs explicitly and have the child verify them in its checkout. Afterwards bring its changes into this checkout and remove the worktree and its branch, unless I say otherwise. Otherwise share the checkout without concurrent edits to the same files.
- Keep planning, design, judgment, communication, and completion verification yourself. Check delegated results against the brief and diff and run missing checks, then fix what remains yourself; delegate a correction only when it is again a parallel track, as a new task with the original brief and findings.

## Review

- `/code-review` is the only review process. For high-impact changes (shared or security-sensitive code, migrations, public interfaces, or anything hard to revert), run it once at `xhigh` on the final diff before pushing or reporting done; its level also sets the review's reasoning effort. Don't run a second review, `/simplify`, or `/security-review` unless I ask.
- Check each finding against the code before deciding. Fix every one that is a real defect in what the change is meant to do and verify the fix, delegating only fixes that split into parallel tracks under the Delegation section, then rerun the affected checks instead of reviewing again. Report the rest, as with unrelated issues, instead of fixing them.

## Basic safeguards

- Destructive actions, production changes, and external writes or communications require authorization. Ask if it has not already been granted; `sudo` alone is not destructive.
- Preserve unrelated work and existing safeguards. Keep reviews and advice read-only unless changes are requested.
- Do not expose secrets or commit credentials.
- Preserve pushed history unless I authorize rewriting it. When authorized, use an explicit expected-SHA `--force-with-lease`; never force-push a default branch or someone else's branch.
