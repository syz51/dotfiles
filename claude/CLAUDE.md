# Global Agent Defaults

## Working preferences

- Run Python tools and checks with `uv run`; use `bun` for JavaScript/TypeScript tooling. Respect project runtimes and lockfiles.
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

- Own planning, product and architecture design, judgment, communication, and completion verification. Delegate separable work big enough to justify a fresh start: investigation and evidence gathering to `explorer`, implementation and execution-heavy work (including authorized document/archive updates) to `worker`, and hard debugging/reasoning to `solver`. Handle trivial edits, small reads, and inseparable design exploration directly. Don't override an agent's configured model or effort.
- Give each task a standalone brief with the goal, decided design, scope, constraints, acceptance checks, and expected report; do not repeat shared instructions.
- Run independent tasks in parallel when useful, settling shared interfaces first. Isolate independent implementation when needed; transfer required uncommitted inputs explicitly, or share the checkout without concurrent edits to the same files.
- Check delegated results against the brief and diff and run missing checks; send corrections as a new task with the original brief and findings.

## Review

- `/code-review` is the only review process. For high-impact changes (shared or security-sensitive code, migrations, public interfaces, or anything hard to revert), run it once at `xhigh` on the final diff before pushing or reporting done; its level also sets the review's reasoning effort. Don't run a second review, `/simplify`, or `/security-review` unless I ask.
- Fix small findings yourself; delegate larger fixes with the original brief and findings, then rerun the affected checks instead of reviewing again.

## Basic safeguards

- Destructive actions, production changes, and external writes or communications require authorization. Ask if it has not already been granted; `sudo` alone is not destructive.
- Preserve unrelated work and existing safeguards. Keep reviews and advice read-only unless changes are requested.
- Do not expose secrets or commit credentials.
- Preserve pushed history unless I authorize rewriting it. When authorized, use an explicit expected-SHA `--force-with-lease`; never force-push a default branch or someone else's branch.
