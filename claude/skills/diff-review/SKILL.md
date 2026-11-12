---
name: diff-review
description: Review one git diff for defects and return typed findings as JSON. The `reviewer` agent has it preloaded and runs the review the Review section of `CLAUDE.md` asks for on every pushed or merged change. The target is a range such as `origin/main...<SHA>`.
argument-hint: <base>...<commit>
---

# Diff review

The target is the range in your prompt or in the arguments, such as
`origin/main...<SHA>`.

Review this diff once and report its defects. Your reply is the review's whole result.
Change nothing: no edits, no commits, no pushes, no board or network writes. Do every
step yourself, without agents.

## 1. Read the diff

- Run `git diff <target>`. With no target, review `git diff origin/HEAD...HEAD`, and add
  `git diff HEAD` when the working tree has changes.
- The diff is the scope. The target pins a commit, so when the working tree differs from
  it, read a file as the commit has it: `git show <commit>:<path>`.
- Read the function around each hunk, not only the hunk. A defect in an unchanged line of
  a changed function is in scope.

## 2. Look from each angle

Take the angles one at a time. Note each candidate with its file, line and a failure you
can name. Keep a candidate you only half believe; drop one with no nameable failure.

1. **Lines.** For each changed line, ask which input, state, timing or platform makes it
   wrong: an inverted or wrong condition, off-by-one, a missing `await`, a null or empty
   value, a falsy zero, the wrong variable, a swallowed error, an unescaped pattern.
2. **Removed behavior.** For each line the diff deletes or replaces, name what it
   guaranteed: a guard, an error path, a validation, a test of a real case. Find where
   the new code gives the same guarantee. A guarantee with no new home is a candidate.
3. **Callers and callees.** Search for the callers of each changed function, command,
   option, file format and text that other code matches. Check each against the change:
   a new precondition, a changed return shape or wording, a new error, a changed order.
4. **Security and data.** Check input that crosses a trust boundary, secrets in code or
   logs, widened permissions, and destructive commands that lost a check.
5. **Rules.** Read the `CLAUDE.md` files that govern the changed files: the user's, the
   repository root's and those in parent folders of a changed file. Report a breach only
   when you can quote the rule and the line that breaks it.
6. **Tests and documents.** Find behavior the diff changes while its tests or documents
   still describe the old behavior, and new risky logic that no test reaches.
7. **Cleanup.** Find code the diff adds that repeats an existing helper, that is dead or
   more complex than its job needs, or that repeats work. Name the simpler form.

## 3. Report

Merge candidates that name the same defect at the same place. Do not verify or judge them
again. Order them by severity, defects before cleanup, and keep at most 10.

Reply with only a JSON array, `[]` when nothing remains:

```json
[
  {
    "file": "path/from/the/repository/root.ext",
    "line": 123,
    "category": "correctness",
    "summary": "One sentence that states the defect.",
    "failure_scenario": "The inputs or state, then the wrong result or the cost."
  }
]
```

`category` is one of `correctness`, `security`, `reliability`, `efficiency`,
`simplification`, `test-coverage`, `conventions` and `docs`. Do not call `ReportFindings`:
the session that asked for the review records the outcomes.
