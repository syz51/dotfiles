# Recording review findings

This rule is part of the global instructions (`~/.claude/CLAUDE.md`, Review section) and has the same force. Read it when the `reviewer` agent has returned its findings.

- Once you have decided on every finding, record the outcomes: call `ReportFindings` once with every finding, its category and its outcome, `fixed` for one you fixed, `no_change_needed` for one that is wrong or intentional, and `skipped` for a real one you filed or did not apply. Split more than 32 findings into calls of 32, and record a review without findings as an empty list. The categories are `correctness`, `security`, `reliability`, `efficiency`, `simplification`, `test-coverage`, `conventions` and `docs`. Report the result in your reply as well.
