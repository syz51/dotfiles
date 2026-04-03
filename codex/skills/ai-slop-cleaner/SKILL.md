---
name: ai-slop-cleaner
description: Use this skill for cleanup, refactor, or deslop work where behavior must stay stable. It enforces regression-tests-first cleanup, a bounded scope, one smell category per pass, and explicit quality gates before claiming the code is cleaner.
argument-hint: "[scope or file list]"
---

# AI Slop Cleaner

Use this skill when the code works but is bloated, repetitive, over-abstracted, or generally AI-shaped in a way that lowers signal quality.

## Use When

- The user asks to clean up, refactor, simplify, or deslop code.
- A recent implementation works but left duplicate code, dead branches, or noisy wrappers.
- You want a disciplined cleanup workflow without broad rewrites.

## Do Not Use When

- The main problem is a functional bug that still needs a fix.
- The user wants broad redesign or architecture changes.
- You cannot protect current behavior well enough to cleanup safely.

## Workflow

1. Lock behavior first.
   - Run existing targeted tests, or add the narrowest regression coverage needed.
   - If behavior is untested, do not start cleanup until the expected behavior is pinned down.
2. Write a cleanup plan before editing.
   - State the exact scope.
   - List the smells to remove.
   - Order them from safest to riskiest.
3. Work one smell category per pass.
   - Dead code deletion
   - Duplicate removal
   - Naming and error-handling cleanup
   - Boundary cleanup
   - Test reinforcement
4. Re-run the lightest meaningful verification after each pass.
5. Stop when the code is materially simpler and the diff is still small and reviewable.

## Scope Rules

- Keep the pass bounded to the requested files or the changed-file set when one is available.
- Prefer deletion over addition.
- Reuse existing utilities before adding helpers.
- Do not introduce new dependencies unless the user explicitly asks for them.
- Do not mix cleanup with unrelated feature work.

## Quality Gates

Before calling the cleanup complete, verify as many of these as apply:

- targeted regression tests
- lint
- typecheck
- relevant unit or integration tests
- no widened scope beyond the planned files

## Output

Report:

- scope cleaned
- behavior lock used
- simplifications made
- verification run
- remaining risks or intentionally deferred cleanup
