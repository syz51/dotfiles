---
name: deslop
description: Regression-tests-first cleanup and simplification workflow for messy or AI-generated code. Trigger when the user asks to cleanup, refactor, simplify, reduce duplication, tighten boundaries, or deslop a working code path without changing behavior.
---

# Deslop

Use this skill when the code mostly works but the diff is bloated, repetitive, noisy, over-abstracted, or hard to review.

## Use When

- The user asks to cleanup, refactor, simplify, or deslop code.
- A recent implementation works but needs a behavior-preserving cleanup pass.
- The code shows duplication, dead code, needless wrappers, or weak boundaries.

## Do Not Use When

- The task is primarily about adding behavior.
- The correct behavior is still unknown or untested.
- The cleanup would require an architecture rewrite the user did not ask for.

## Workflow

1. Lock behavior first.
   - Run the narrowest relevant existing tests, or add the smallest regression test needed before editing.
   - If the behavior is still unclear, stop and clarify before cleanup.
2. Bound the scope.
   - Prefer the requested files, the changed files, or a small named surface.
   - Do not expand scope just because nearby code is also imperfect.
3. Write a cleanup plan before editing.
   - List the exact smells you will address.
   - Order them from safest to riskiest.
4. Work one smell category at a time.
   - Dead code deletion
   - Duplicate removal
   - Needlessly indirect abstractions
   - Boundary and naming cleanup
   - Test reinforcement
5. Re-run the lightest meaningful verification after each pass.
   - Prefer targeted tests first, then lint/typecheck/build as needed.
6. Finish with an evidence-dense summary.
   - What was simplified
   - What verification ran
   - What risks remain

## Rules

- Prefer deletion over addition.
- No new dependencies unless explicitly requested.
- Keep diffs small, reviewable, and reversible.
- Do not mix behavior changes into a cleanup pass unless the user asked for both.

## Output

Return:

- Scope
- Behavior lock used
- Cleanup passes completed
- Verification run
- Remaining risks or deferred follow-ups
