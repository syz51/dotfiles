# Round 2 probes (board dotfiles-546)

Set these first, in each shell:

    S=<scratch>/r3-factory-a
    P=$S/probes

Runner: `/bin/sh $P/run-probe.sh <name>` runs one probe file and writes `$P/logs/<name>.txt`. Its exit code is the test exit code.
Mutation copies (`$S/mut-*`) already hold their change. Rebuild one by copying `$S/repo` and changing only the named line.
Copies that run a suite use TMPDIR outside the tree (`$P/tmp`), so tests do not walk up into a git checkout.
Copy-run form used below, with `ENVX` expanded by hand:

    env -i HOME=$P/home TMPDIR=$P/tmp PATH=/opt/homebrew/bin:/usr/bin:/bin:~/.bun/bin ~/.bun/bin/bun test <args>

Task ids: dotfiles-440, 441, 442, 443 and 158 exist. Blocks marked "note on" add evidence to that task. Blocks marked "new" need a new task.

## 1. Review titles stop at 200 (note on dotfiles-440)

    /bin/sh $P/run-probe.sh r2-review-titles; echo "exit=$?"

Expected: `TITLES 200 FIRST Task 1 HAS 201 false HAS 1000 false`, `1 pass`, `0 fail`, `exit=0`.

## 2. Friction open items past 1000 rows (note on dotfiles-440)

    /bin/sh $P/run-probe.sh r2-friction-unresolved; echo "exit=$?"

Expected: `UNRESOLVED 1000`, `1 pass`, `exit=0`. No warning is printed.
The probe imports `$S/mut-friction/claude/factory/friction/cli.js`, which exports `unresolvedItems`.

## 3. Empty lock file is taken over (note on dotfiles-158)

    /bin/sh $P/run-probe.sh r2-lock; echo "exit=$?"

Expected: `ACQUIRED: true CONTENT: <pid> PID: <pid>` (same pid twice), `1 pass`, `exit=0`.

## 4. Lock held by pid 1 is never taken over (note on dotfiles-442)

    /bin/sh $P/run-probe.sh r2-pid-lock; echo "exit=$?"

Expected: `(pass) a lock held by pid 1 is never taken over`, `(pass) a lock with an age stamp in the past, still held by pid 1, is refused`, `2 pass`, `exit=0`.

## 5. Digest says full, cuts the final message (note on dotfiles-441)

    /bin/sh $P/run-probe.sh r2-digest; echo "exit=$?"

Expected: `DIGEST LEN 15533 LABEL true FIRST true LAST true FULL FILLER false`, `(fail) the final message is shown in full, as its label says`, `1 fail`, `exit=1`. The failure is the evidence.

## 6. Digest size change passes every scoring test (note on dotfiles-441)

    cd $S/mut-digest && env -i HOME=$P/home TMPDIR=$P/tmp PATH=/opt/homebrew/bin:/usr/bin:/bin:~/.bun/bin ~/.bun/bin/bun test claude/factory/scoring; echo "exit=$?"

Copy change: `claude/factory/scoring/digest.js:15` `OUTPUT_CHARS` 300 to 100.
Expected: `270 pass`, `0 fail`, `exit=0`.

## 7. RECENT_DAYS: scoring copy not pinned (note on dotfiles-443)

Scoring copy (the gap):

    cd $S/mut-scoring-days && env -i HOME=$P/home TMPDIR=$P/tmp PATH=/opt/homebrew/bin:/usr/bin:/bin:~/.bun/bin ~/.bun/bin/bun test claude/factory/scoring; echo "exit=$?"

Copy change: `claude/factory/scoring/propose.js:45` `RECENT_DAYS` 30 to 7. Expected: `270 pass`, `0 fail`, `exit=0`.

Board copy (control, pinned):

    cd $S/mut-recent && env -i HOME=$P/home TMPDIR=$P/tmp PATH=/opt/homebrew/bin:/usr/bin:/bin:~/.bun/bin ~/.bun/bin/bun test claude/factory/board claude/factory/scoring; echo "exit=$?"

Copy change: `claude/factory/board/proposal.js:32` `RECENT_DAYS` 30 to 7.
Expected: `(fail) ... signals without feedback qualify once in 30 days`, `1 fail`, `exit=1`.

## 8. Evolve counts a later edit as a fix (note on dotfiles-443 item 6)

    /bin/sh $P/run-probe.sh r2-evolve-fixed; echo "exit=$?"

Expected: a line containing `"fixed":1`, `1 pass`, `exit=0`.

## 9. Judge budget resets each run (by design; owner decision on dotfiles-443 item 2)

    cd $S/repo && env -i HOME=$P/home TMPDIR=$P/tmp PATH=/opt/homebrew/bin:/usr/bin:/bin:~/.bun/bin ~/.bun/bin/bun test -t "run budget" claude/factory/friction/friction.test.js; echo "exit=$?"

Expected: `1 pass`, `0 fail`, `exit=0`. This pins the per-run cap (`claude/factory/friction/friction.test.js:367-376`).

## 10. LaunchAgent uninstall leaves a loaded job (new)

    /bin/sh $P/run-probe.sh r2-launchd; echo "exit=$?"

Expected: `STATUS: LaunchAgent: not installed; loaded`, `1 pass`, `exit=0`.
Proposed task:
- Title: Uninstall must not leave a loaded LaunchAgent with no plist.
- Problem: uninstall ignores a failed bootout, removes the plist, and status then reads "not installed; loaded".
- Evidence: block 10; `claude/factory/lib/launchd.js:87-90`, `:93-95`.
- Change: check the bootout result. When the job stays loaded, return an error and keep the plist, or report it in status.
- Size: S.

## 11. Same-day review rerun overwrites the record (new)

    cd $S/mut-review && env -i HOME=$P/home TMPDIR=$P/tmp PATH=/opt/homebrew/bin:/usr/bin:/bin:~/.bun/bin ~/.bun/bin/bun test claude/factory/review/r2-review-rerun.test.js; echo "exit=$?"

Expected: `REVIEW RECORDS 1 FIRST ... SECOND ... KEPT ...` (KEPT equals SECOND), `1 pass`, `exit=0`.
Proposed task:
- Title: Keep every review run on a day, not one record per UTC date.
- Problem: `review/cli.js:288` writes `main-<UTC date>.json`, so a rerun replaces the earlier run's record.
- Evidence: block 11.
- Change: key the record by run start time or run id, or append runs to one day file.
- Size: S.

## 12. Same-day weekly rerun overwrites the report (new)

    cd $S/mut-weekly && env -i HOME=$P/home TMPDIR=$P/tmp PATH=/opt/homebrew/bin:/usr/bin:/bin:~/.bun/bin ~/.bun/bin/bun test claude/factory/weekly/r2-weekly-rerun.test.js; echo "exit=$?"

Expected: `WEEKLY REPORTS 1 SAME PATH true FIRST ... SECOND ...`, `1 pass`, `exit=0`.
Proposed task:
- Title: Do not replace a same-day weekly report; write it atomically.
- Problem: `weekly/cli.js:181-182` writes `weekly-<DATE>.md` in place, so a rerun replaces it.
- Evidence: block 12. The partial-write risk (Round 2 G2) is unverified.
- Change: keep the earlier report or add a run suffix; write to a temp file and rename.
- Size: S.

## 13. Weekly status crashes on a damaged file (new)

    /bin/sh $P/run-probe.sh r2-weekly-status; echo "exit=$?"

Expected: `WEEKLY STATUS ERROR SyntaxError: JSON Parse error: Unexpected EOF`, `1 pass`, `exit=0`.
Proposed task:
- Title: Name the damaged file when weekly status cannot read it.
- Problem: `weekly/cli.js:223` parses `weekly-last.json` without a guard; the error has no file name.
- Evidence: block 13.
- Change: catch the parse error at the read, add the file path, rethrow.
- Size: S.

## 14. Damaged price cache blocks every refresh (new)

    /bin/sh $P/run-probe.sh r2-litellm; echo "exit=$?"

Expected: `LITELLM run 1: SyntaxError | run 2: SyntaxError FETCHES 0`, `1 pass`, `exit=0`.
Proposed task:
- Title: A damaged price cache must not block the refresh.
- Problem: `lib/litellm.js:16-20` throws on a damaged file, and the refresh at `:28` runs outside its try. No fetch runs, so the cache never heals.
- Evidence: block 14.
- Change: treat an unreadable cache as missing, then fetch; keep the read inside error handling with context.
- Size: S.

## 15. Judged record with a timed-out CLAUDE.md (new)

    /bin/sh $P/run-probe.sh r2-instructions-timeout; echo "exit=$?"

Expected: `PROJECT FILES [] MS 5003`, `1 pass`, `exit=0`. The run takes about 5 s.
Proposed task:
- Title: Record whether project instructions were read, and judge again when that changes.
- Problem: a blocked project file is judged as absent (`scoring/score.js:107-119`); the record keeps `project: []` (`:371`), and the key has no instruction state (`:83`).
- Evidence: block 15; G2 (rejudge) is unverified.
- Change: add an instructions state to the key or the record; rejudge when it changes.
- Size: M.

## 16. Torn friction.jsonl has no repair path (new)

    /bin/sh $P/run-probe.sh r2-torn-jsonl; echo "exit=$?"

Expected: a line ending `friction.jsonl:3: malformed JSON line`, `1 pass`, `exit=0`.
Proposed task:
- Title: Give a torn friction.jsonl a repair path.
- Problem: one torn last line stops every friction run, dry runs too (`lib/state.js:26-36`, `friction/cli.js:359`). No code path leaves that state.
- Evidence: block 16.
- Change: a repair step that keeps complete lines and moves the torn one aside; the owner picks truncate or quarantine (decision note).
- Size: M.

## 17. Root-less codex subagent listed as a session (new)

    cd $S/mut-codex && env -i HOME=$P/home TMPDIR=$P/tmp PATH=/opt/homebrew/bin:/usr/bin:/bin:~/.bun/bin ~/.bun/bin/bun test -t "R2 root-less subagent" claude/factory/lib/r2-codex-rootless.test.js; echo "exit=$?"

Expected: `ROOTLESS COUNT 1`, `1 pass`, `exit=0`.
Proposed task:
- Title: Do not list a codex subagent as a top-level session when its root is missing.
- Problem: `lib/codex.js:373` pushes a subagent with no root as a top-level session.
- Evidence: block 17. Effect on the "launched by an agent" metric is not measured.
- Change: skip or mark an orphan subagent; add a test for it.
- Size: S.

## 18. Scoring tests need a temp folder outside any checkout (new)

Failing copy (TMPDIR inside a git copy, as `run5.sh` does; `run5.sh` runs this five times and writes `logs/scoring-runs.txt`):

    cd $S/fresh-5x && env -i HOME=$S/fresh-5x/home TMPDIR=$S/fresh-5x/tmp PATH=/opt/homebrew/bin:/usr/bin:/bin:~/.bun/bin ~/.bun/bin/bun test claude/factory/scoring; echo "exit=$?"

Expected: `267 pass`, `3 fail`, `exit=1`. Failing tests:
- `(fail) review-skipped > flags an unreviewed push in syz51/papers, a repository review-scope.toml does not name`
- `(fail) review-skipped > flags an unreviewed push from a removed T3 worktree of a repository the board does not list`
- `(fail) score command > --session scores the named session again, by unique id prefix, even from a temporary folder`

Control, TMPDIR outside the tree:

    cd $S/fresh-5x && env -i HOME=$S/fresh-5x/home TMPDIR=$P/tmp PATH=/opt/homebrew/bin:/usr/bin:/bin:~/.bun/bin ~/.bun/bin/bun test claude/factory/scoring; echo "exit=$?"

Expected: `270 pass`, `0 fail`, `exit=0` (also in `logs/scoring-tmp-outside.txt`).
Proposed task:
- Title: Scoring tests must not depend on the temp folder's location.
- Problem: three tests fail when TMPDIR is inside a git checkout, because `gitCheckout` walks up to the enclosing repository (`scoring/review-scope.js:84-101`).
- Evidence: this block.
- Change: give each test a temp folder outside any repository, or set the repository root in the test.
- Size: S.
