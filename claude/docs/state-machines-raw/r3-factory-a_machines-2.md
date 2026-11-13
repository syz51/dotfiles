# Factory machines, round 2 (board dotfiles-546)

Scope: `claude/factory` at HEAD 3525a13 (branch refactor/state-machine-audit).
Round 1 record: `scratchpad/e3-factory-a/machines.md`.
Probe commands: `scratchpad/r3-factory-a/probes-2.md`.

Count: 21 Round 1 entries, plus 3 new entries = 24 machines considered.
This file holds 18 entries: 15 corrected Round 1 entries (whole) and 3 new.
Not copied (unchanged, no new verdict): Friction cursor, Friction turn states, Friction filing record, Board feature probe, Board snapshot, Transcript session listing.

### Judge call spend

- Where: `claude/factory/lib/claude.js`, `claude/factory/friction/cli.js`
- States: attempt, refused, retried, succeeded, failed with cost, run budget spent (per run)
- Transitions:
  - attempt -> refused -> retried: a refused attempt is retried. Enforced at `claude/factory/lib/claude.js:81`.
  - retried -> succeeded: cost is the spent amount plus the final call. Enforced at `claude/factory/lib/claude.js:106`.
  - retried -> failed: a `ClaudeCallError` is thrown with `costUSD`. Class at `claude/factory/lib/claude.js:38`.
  - failed call -> budget: friction uses `error.costUSD`, or the budget when absent. Enforced at `claude/factory/friction/cli.js:453-454`.
  - run start -> run budget: `spent` starts at 0 for each run. Enforced at `claude/factory/friction/cli.js:390`; cap check at `:436`.
- Gaps:
  - G1 When the final attempt fails after a refusal, `error.costUSD` leaves out the refused attempt's spend. Verdict: confirmed (Round 1 run, not repeated in Round 2). Evidence: Round 1 `bun test claude/factory/lib/probe-refused.test.js`, exit 0, 2 pass; error cost 0.02 against a control of 0.04. Task: new.
  - G2 The run budget resets on each run, so several runs in one day can spend more than one cap. Verdict: by design for the per-run cap; the missing daily total is an owner choice. Evidence: `claude/factory/friction/friction.test.js:367-376` pins the per-run cap; `bun test -t "run budget" claude/factory/friction/friction.test.js` in the HEAD copy, exit 0, 1 pass. Task: dotfiles-443 item 2 (owner decision: add a daily total or keep per-run).
- Tests: `claude/factory/friction/friction.test.js:367-376`; `claude/factory/lib/lib.test.js:444` (Round 1, by name).

### Friction record file (JSON Lines)

- Where: `claude/factory/lib/state.js` (`readJsonl`, `:26-36`), `claude/factory/friction/cli.js` (read at `:359`, dry-run return at `:373`)
- States: intact, torn last line, every reader stopped
- Transitions:
  - intact -> torn: a crash leaves a partial last line. Read check at `claude/factory/lib/state.js:26-36` (throws `<path>:<line>: malformed JSON line`).
  - torn -> stopped: every friction run stops, dry runs too. Caller reads at `claude/factory/friction/cli.js:359`, before the dry-run return at `:373`.
  - stopped -> intact: no code path. `lib/state.js` and `friction/cli.js` have no skip, repair or truncate step.
- Gaps:
  - G1 One torn last line stops every friction run, and no code path leaves that state. Verdict: confirmed. Evidence: `/bin/sh $P/run-probe.sh r2-torn-jsonl`, exit 0, 1 pass; output `friction.jsonl:3: malformed JSON line`. The no-repair part is from reading `lib/state.js:26-43` and `friction/cli.js:345-373`. Task: new.
- Tests: none found in the suite for a torn line (Round 1 check); probe `r2-torn-jsonl` only.

### Match set

- Where: `claude/factory/friction/cli.js` (`unresolvedItems`, `:151-160`), `claude/factory/board/cli.js` (`checkFeedback`, `:55-62`)
- States: open items listed, list failed, full page
- Transitions:
  - list -> matched: open items and this run's filings are matched. Enforced at `claude/factory/friction/cli.js:152`.
  - list failed -> capture-only matching. Prior record only (`:151-157`).
  - full page (1000 rows) -> accepted with no warning. `friction/cli.js:151-160` has no full-page check. The board's own feedback reader throws at a full page (`claude/factory/board/cli.js:55-62`).
- Gaps:
  - G1 `board ls --limit 1000` has no full-page check, so open items past the first 1000 rows can be missed without a warning. Verdict: confirmed. Evidence: `/bin/sh $P/run-probe.sh r2-friction-unresolved`, exit 0, 1 pass; output `UNRESOLVED 1000`, no warning. Task: dotfiles-440.
- Tests: none found for a full page (Round 1 check); probe only.

### Evolve item states

- Where: `claude/factory/evolve/cli.js`
- States: routed open, fixed, not fixed
- Transitions:
  - routed open -> fixed: owner task is done and `updatedAt` is inside the window. Enforced at `claude/factory/evolve/cli.js:117`.
  - `updatedAt` comes from the task's `updated_at`. Owners built at `claude/factory/evolve/cli.js:56-72`.
- Gaps:
  - G1 `updatedAt` stands in for the fix time, so a later edit to a done task counts as a fix. Verdict: confirmed. Evidence: `/bin/sh $P/run-probe.sh r2-evolve-fixed`, exit 0, 1 pass; a task done in October and edited on 13 November gives `"fixed":1` for the week to 14 November. Task: dotfiles-443 item 6.
- Tests: `claude/factory/evolve/evolve.test.js:39`, `:185` (Round 1, by name). As far as I read them, none covers a later edit to a done task.

### Setup registry

- Where: `claude/factory/setups/cli.js`, `claude/factory/evolve/cli.js`
- States: registered, invalid, required id missing, removed id (labelled)
- Transitions:
  - entry -> invalid: checked in `problems()`. Enforced at `claude/factory/setups/cli.js:40-74`.
  - required id absent -> problem. Enforced at `claude/factory/setups/cli.js:25` (`REQUIRED`).
  - removed id -> labelled `(not in setups.toml)`. Label at `claude/factory/evolve/cli.js:176`.
- Gaps:
  - G1 Removing a setup id leaves old filings whose `about` names no setup. Verdict: by design. Evidence: `claude/factory/evolve/evolve.test.js:84` pins the label; `bun test claude/factory/evolve/evolve.test.js`, exit 0, 9 pass; `claude/factory/setups/setups.test.js`, exit 0, 6 pass (run in `repo/`, which has `.git`). Task: none.
- Tests: `claude/factory/evolve/evolve.test.js:84`; `claude/factory/setups/setups.test.js` (6 pass).

### Score record identity

- Where: `claude/factory/scoring/score.js`, `claude/factory/scoring/rubric.js`
- States: eligible, quiet period, judged, judge error, ineligible
- Transitions:
  - eligible -> judged: record appended. Enforced at `claude/factory/scoring/score.js:387` and `:401`.
  - judge error -> retried until 2 errors. Enforced at `claude/factory/scoring/score.js:73` (`MAX_JUDGE_ERRORS`).
  - record key `sessionId:sha:rubricVersion`. Enforced at `claude/factory/scoring/score.js:83`.
  - quiet period 30 minutes. Set at `claude/factory/scoring/score.js:36`.
- Gaps:
  - G1 Two score runs at once both judge the same session. Verdict: confirmed (Round 1 run, not repeated). Evidence: Round 1 `bun test claude/factory/scoring/probe-score.test.js`, exit 0, 2 pass; concurrent runs wrote 2 lines and made 2 judge calls; sequential control wrote 1 line. Task: new.
  - G2 A judge prompt change without a version bump is not rescored. Verdict: refuted. Evidence: copy `mut-judge` with the prompt at `claude/factory/scoring/score.js:151` changed; `bun test claude/factory/scoring`, exit 1, 1 fail: "rubric > the judge's prompt is pinned to the rubric version". The pin at `claude/factory/scoring/score.test.js:72-79` fails the suite, so the change cannot land silently. Task: none.
- Tests: `claude/factory/scoring/score.test.js:72-79`, `:301` (Round 1, by name).

### Rubric version gate

- Where: `claude/factory/scoring/rubric.json`, `claude/factory/scoring/rubric.js`, `claude/factory/scoring/digest.js`
- States: current version, older version (excluded from proposals)
- Transitions:
  - version bump -> older records excluded. Rule documented at `claude/factory/scoring/rubric.js:3-6` (manual bump); enforcement point not re-read.
  - digest output size -> not pinned by any test. Limit `OUTPUT_CHARS` at `claude/factory/scoring/digest.js:15`.
- Gaps:
  - G1 Changing the digest output size passes every scoring test, so the output is not pinned. Verdict: confirmed. Evidence: copy `mut-digest` with `OUTPUT_CHARS` 300 changed to 100 at `digest.js:15`; `bun test claude/factory/scoring`, exit 0, 270 pass, 0 fail (Round 2). Round 1 gave the same for four test files. Task: dotfiles-441.
  - Round 1 "26 fail in both copies" did not reproduce in Round 2; see the test-isolation gap in Review-skipped detector G3.
- Tests: none ties digest or detector output to the rubric version.
- Changed since 2026-11-12: `claude/factory/scoring/rubric.json` version is 14 (prior 13), commit 69cb566.

### Review title list

- Where: `claude/factory/review/cli.js` (`openTitles`, `:145-149`; cap `TITLES` at `:27`), `claude/factory/board/cli.js` (`checkFeedback`, `:55-62`)
- States: titles listed, titles cut, full page
- Transitions:
  - board list (`ls --json --limit 1000`) -> closed filtered out -> first 200 titles kept. Enforced at `claude/factory/review/cli.js:145-149`.
  - full page -> no warning. The board's feedback reader throws at a full page (`claude/factory/board/cli.js:55-62`).
- Gaps:
  - G1 Duplicates beyond the first 200 open titles are not seen, and no warning is given. Verdict: confirmed. Evidence: `/bin/sh $P/run-probe.sh r2-review-titles`, exit 0, 1 pass; with 1000 open rows the output is `TITLES 200 FIRST Task 1 HAS 201 false HAS 1000 false`. Task: dotfiles-440.
- Tests: none found for the cap (Round 1 check); probe only.

### Pid lock file

- Where: `claude/factory/lib/state.js` (`acquireLock`, `:53-75`)
- States: free, held by a live pid, held by pid 1 (EPERM), stale, empty, taken over
- Transitions:
  - free -> held: exclusive create writes the pid. Enforced at `claude/factory/lib/state.js:57`.
  - live pid -> refused. `process.kill(pid, 0)` succeeds at `claude/factory/lib/state.js:65-66`.
  - EPERM (pid not ours, such as pid 1) -> refused. Enforced at `claude/factory/lib/state.js:68`.
  - ESRCH (dead pid) -> stale file removed -> retried. Enforced at `claude/factory/lib/state.js:69-72`.
  - empty file -> removed and taken over, because `Number("")` is 0 and no live pid matches. Enforced at `claude/factory/lib/state.js:62-72`.
- Gaps:
  - G1 Stale takeover is not atomic: several processes take one stale lock in one round. Verdict: confirmed (Round 1 run, not repeated). Evidence: Round 1 `bun test claude/factory/lib/probe-lock.test.js`, exit 1, 1 fail (one-winner check); winners per round 4, 2, 2 out of 50 processes. Task: new.
  - G2 A lock naming pid 1 is never taken over, even when 30 days old. Verdict: confirmed. Evidence: `/bin/sh $P/run-probe.sh r2-pid-lock`, exit 0, 2 pass ("a lock held by pid 1 is never taken over"; "a lock with an age stamp in the past, still held by pid 1, is refused"). Mechanism: EPERM at `:68`. Task: dotfiles-442.
  - G3 An empty lock file is taken over. Verdict: confirmed for the takeover: `/bin/sh $P/run-probe.sh r2-lock`, exit 0, 1 pass; `ACQUIRED: true`, content is the new pid. Unverified for the race: a live writer between the create at `:57` and its pid write could lose its lock. Not run in Round 2. Task: dotfiles-158 (its body matches this code).
- Tests: Round 1 `claude/factory/lib/probe-lock.test.js`, `probe-pid1.test.js` (scratch); Round 2 `r2-lock`, `r2-pid-lock` (scratch). No suite test of takeover found.

### LaunchAgent install and uninstall

- Where: `claude/factory/lib/launchd.js` (`installAgent` `:73-82`, `uninstallAgent` `:87-90`, `agentStatus` `:93-95`), `claude/factory/weekly/cli.js:214`, `claude/factory/friction/cli.js`
- States: no plist, plist written, loaded, not loaded, removed
- Transitions:
  - install: bootout (result ignored), write plist, bootstrap. Enforced at `claude/factory/lib/launchd.js:73-82`.
  - bootstrap fails -> returns its exit code; plist kept. Enforced at `claude/factory/lib/launchd.js:80-81`.
  - uninstall: bootout (result ignored), plist removed. Enforced at `claude/factory/lib/launchd.js:87-90`.
  - status: `LaunchAgent: <plist or not installed>; loaded|not loaded`. Enforced at `claude/factory/lib/launchd.js:93-95`.
- Gaps:
  - G1 A failed bootstrap leaves the plist on disk, and status says not loaded. Verdict: confirmed (Round 1 run, not repeated). Evidence: Round 1 `bun test claude/factory/lib/probe-launchd.test.js`, exit 0, 2 pass; `install code = 1 plist on disk = true`; status `not loaded`. Task: new.
  - G2 Uninstall ignores a failed bootout, removes the plist, and status then reads "not installed; loaded". Verdict: confirmed. Evidence: `/bin/sh $P/run-probe.sh r2-launchd`, exit 0, 1 pass; fake `launchctl` bootout exits 5, print exits 0; output `STATUS: LaunchAgent: not installed; loaded`. The plist is gone while the job stays loaded. Task: new.
- Tests: `claude/factory/weekly/weekly.test.js:247`, `claude/factory/friction/friction.test.js:603` (exit 0, by name; normal path). The failure path is not pinned.

### Digest builder

- Where: `claude/factory/scoring/digest.js`
- States: complete, bounded, final message cut
- Transitions:
  - final message -> labelled "shown in full below". Label at `claude/factory/scoring/digest.js:124`.
  - final message -> cut to a quarter of the limit. Enforced at `claude/factory/scoring/digest.js:211-213` (`ends(final.text, Math.floor(maxChars / 4))`).
  - limit -> `OUTPUT_CHARS` 300. Set at `claude/factory/scoring/digest.js:15`.
- Gaps:
  - G1 The label says the final message is shown in full, but it is cut. Verdict: confirmed. Evidence: `/bin/sh $P/run-probe.sh r2-digest`, exit 1, 0 pass, 1 fail; `DIGEST LEN 15533 LABEL true FIRST true LAST true FULL FILLER false` for a 20,000-character final message. Task: dotfiles-441.
  - G2 `OUTPUT_CHARS` 300 changed to 100 passes every scoring test. Verdict: confirmed. Evidence: Rubric version gate G1 (`mut-digest`, exit 0, 270 pass). Task: dotfiles-441.
- Tests: `claude/factory/scoring/digest.test.js` (read in full, Round 1): its longest final message is about 5,600 characters, under the cut. No test uses a final message over 15,000 characters.

### Review record and board add

- Where: `claude/factory/review/cli.js`
- States: reviewed, verified (confirmed or rejected), filed (task id), failed (error on the record), day record written
- Transitions:
  - confirmed finding -> filed: board add succeeds; the record gets the task id. Enforced at `claude/factory/review/cli.js:222-223`.
  - board add fails -> error on the record; loop stops. Enforced at `claude/factory/review/cli.js:217-227`.
  - run -> `main-<UTC date>.json` written. Enforced at `claude/factory/review/cli.js:288` (`startedAt.slice(0, 10)`).
- Gaps:
  - G1 One failed board add stops the loop, so later confirmed findings are missing from the record. Verdict: confirmed (Round 1 run, not repeated). Evidence: Round 1 `bun test -t "failures end the repository with the reason and what it spent" claude/factory/review/probe-add.test.js`, exit 0, 1 pass; `add-fail {"confirmed":[],"rejected":1,"error":"board add on dotfiles exited 1: board unreachable"}`. Task: new.
  - G2 A same-day rerun overwrites the day's record. Verdict: confirmed. Evidence: copy `mut-review`, `bun test claude/factory/review/r2-review-rerun.test.js`, exit 0, 1 pass; `REVIEW RECORDS 1`; first and second `startedAt` differ; `KEPT` is the second. Task: new.
- Tests: `claude/factory/review/review.test.js:196` (Round 1, by name).
- Open: the date key is UTC; local-day behaviour not checked.

### Review-skipped detector

- Where: `claude/factory/scoring/detectors.js`, `claude/factory/scoring/review-scope.js`
- States: no edit, edit pending, settled, dropped (unmapped folder)
- Transitions:
  - edit -> pending: file located and not ignored. Enforced at `claude/factory/scoring/detectors.js:747`.
  - edit in an unmapped folder -> dropped, no pending entry. Enforced at `claude/factory/scoring/detectors.js:747`.
  - push -> settles pending edits of its repo. Repo `""` settles none; repo `null` settles all. Enforced at `claude/factory/scoring/detectors.js:736` and `:771`.
  - T3 name -> checkout. `t3Checkout` at `claude/factory/scoring/review-scope.js:126`; null when names clash (`:124`).
  - folder -> repo: `gitCheckout` walks up to an enclosing repository (`claude/factory/scoring/review-scope.js:84-101`).
- Gaps:
  - G1 A push from an unknown folder settles nothing, so the verdict is `na` with an unreviewed edit. Verdict: confirmed (Round 1 run, not repeated). Evidence: Round 1 `bun test claude/factory/scoring/probe-d.test.js`, exit 0, 5 pass; `D1a unmapped cwd {"verdict":"na","hits":[]}`. The comment at `claude/factory/scoring/detectors.js:715` says every repository settles. Task: new.
  - G2 Two T3 checkouts with one name and different repos drop the edit. Verdict: confirmed (Round 1 run, not repeated). Evidence: Round 1 same file; `D3a {"verdict":"na","hits":[]}`; `D3b` and `D3c` give `fail`. Task: new.
  - G3 The scoring tests depend on the temp folder being outside any git checkout. Verdict: confirmed. Evidence: `$S/fresh-5x` (git init copy) with TMPDIR inside it: `bun test claude/factory/scoring` exit 1, 267 pass, 3 fail (two `review-skipped` tests and `score command > --session ... even from a temporary folder`). TMPDIR outside: exit 0, 270 pass (`logs/scoring-tmp-outside.txt`). Task: new (S). The walk-up in G-note above is not counted as a gap: no document or test pins it.
- Tests: `claude/factory/scoring/detectors.test.js` (partly read); the suite was run in Round 2 (see G3). Changed since 2026-11-12: commits 91bd6c8, 98ab42b, 3cbe0a7, 69cb566 (Round 1 check).

### Weekly run

- Where: `claude/factory/weekly/cli.js`
- States: free, locked, running, report written, status read
- Transitions:
  - lock held -> run refused. Enforced at `claude/factory/weekly/cli.js:167` (`acquireLock`).
  - report -> `weekly-<DATE>.md` written by a plain write. Enforced at `claude/factory/weekly/cli.js:181-182`.
  - status -> reads `weekly-last.json` with an unguarded `JSON.parse`. Enforced at `claude/factory/weekly/cli.js:223`.
  - uninstall result ignored. Enforced at `claude/factory/weekly/cli.js:214`.
- Gaps:
  - G1 A same-day rerun replaces the day's report. Verdict: confirmed. Evidence: copy `mut-weekly`, `bun test claude/factory/weekly/r2-weekly-rerun.test.js`, exit 0, 1 pass; `WEEKLY REPORTS 1 SAME PATH true`; first and second `startedAt` differ. Task: new.
  - G2 The report write is a plain write, so a crash inside it can leave a partial report. Verdict: unverified. Tried: nothing. The window sits inside one `writeFileSync` call (`:181-182`); a timed kill would test the runtime, not this code. Task: new (with G1).
  - G3 `weekly status` crashes on a damaged `weekly-last.json` and does not name the file. Verdict: confirmed. Evidence: `/bin/sh $P/run-probe.sh r2-weekly-status`, exit 0, 1 pass; `WEEKLY STATUS ERROR SyntaxError: JSON Parse error: Unexpected EOF`. Task: new (S).
  - G4 The uninstall result is ignored. Same as LaunchAgent G2, confirmed. Task: new (one item with LaunchAgent G2).
- Tests: `claude/factory/weekly/weekly.test.js:179` (partial weekly success by design, exit 0, by name), `:247` (uninstall normal path, exit 0, by name).

### Proposal publish and retry

- Where: `claude/factory/scoring/propose.js`, `claude/factory/lib/proposal.js`, `claude/factory/board/proposal.js`
- States: candidate, branch pushed, PR created, proposed, error (pushed, no PR URL), killed (no record), retryable
- Transitions:
  - candidate -> branch pushed -> PR created: publish with `onPushed`. Enforced at `claude/factory/scoring/propose.js:287`.
  - gh exits 1 after it created the PR -> error. Enforced at `claude/factory/scoring/propose.js:366-371`.
  - error or dry-run -> retryable. Set at `claude/factory/lib/proposal.js:150` (`RETRYABLE`).
  - retry -> new branch. By design; pinned by `claude/factory/scoring/propose.test.js:310`.
- Gaps:
  - G1 gh creates the PR, then exits 1. The retry opens a second PR for one proposal. Verdict: confirmed (Round 1 run, not repeated). Evidence: Round 1 `bun test claude/factory/scoring/probe-propose.test.js`, exit 0, 7 pass; first run `status=error pushed=true prUrl=null`; `gh creates total=2`. Task: new.
  - G2 SIGKILL after gh creates the PR leaves no record and one remote branch; a rerun opens a second PR. Verdict: confirmed (Round 1 run, not repeated). Evidence: same probe file; `records=0`, remote branches 1; rerun `records=1 gh creates=2`. Task: new.
  - G3 `RECENT_DAYS = 30` is defined in two files, and only the board copy is pinned by a test. Verdict: confirmed. Evidence: copy `mut-scoring-days` with `claude/factory/scoring/propose.js:45` changed to 7: `bun test claude/factory/scoring`, exit 0, 270 pass. Control copy `mut-recent` with `claude/factory/board/proposal.js:32` changed to 7: `bun test claude/factory/board claude/factory/scoring`, exit 1, 1 fail ("signals without feedback qualify once in 30 days"). Task: dotfiles-443.
- Tests: `claude/factory/scoring/propose.test.js:310` (exit 0, by name); `claude/factory/scoring/propose-instr.test.js` (25 pass, Round 1). Changed since 2026-11-12: commit 0c4ddba (`lib/proposal.js`, `propose.test.js`).

### LiteLLM price cache

- Where: `claude/factory/lib/litellm.js` (`cache` `:16-20`, `refreshLitellm` `:27-45`), `claude/factory/lib/state.js` (`readJson`, `:45-48`)
- States: no cache file, cache loaded, cache damaged, refreshed from the network
- Transitions:
  - no file or valid file -> loaded: `cache()` reads the cache file. Enforced at `claude/factory/lib/litellm.js:16-20`.
  - damaged file -> read throws; `loaded` is not set, so every call reads again. Enforced at `claude/factory/lib/litellm.js:16-20` (`readJson` unguarded at `claude/factory/lib/state.js:45-48`).
  - refresh reads the cache at `:28`, outside its try; the try covers only the fetch. Enforced at `claude/factory/lib/litellm.js:27-45`.
- Gaps:
  - G1 A damaged cache file makes every refresh throw, and no fetch ever runs, so the cache never heals. Verdict: confirmed. Evidence: `/bin/sh $P/run-probe.sh r2-litellm`, exit 0, 1 pass; output `LITELLM run 1: SyntaxError | run 2: SyntaxError FETCHES 0`. Task: new.
- Tests: none found for a damaged cache (not checked in Round 2 beyond the probe); probe `r2-litellm` only.

### Codex thread attach

- Where: `claude/factory/lib/codex.js` (`loadCodexSessions`, `:347-381`; attach at `:373`)
- States: root thread, subagent with its root, subagent with no root (root-less), session listed
- Transitions:
  - subagent whose root is in the index -> attached as an inherited session. Enforced at `claude/factory/lib/codex.js:373` (`parseThread(..., { inherited: true })`).
  - subagent whose root is missing -> listed as a top-level session, nothing attached. Enforced at `claude/factory/lib/codex.js:373`.
- Gaps:
  - G1 A subagent whose root thread is missing is listed as a top-level session. Verdict: confirmed. Evidence: copy `mut-codex`, `bun test -t "R2 root-less subagent" claude/factory/lib/r2-codex-rootless.test.js`, exit 0, 1 pass; output `ROOTLESS COUNT 1`; the entry is top-level and has no subagent attached. Its effect on the "launched by an agent" metric is not measured. Task: new (S).
- Tests: none in the suite pins a root-less subagent (Round 2 check).

### Bounded project-instruction read

- Where: `claude/factory/lib/probe.js` (`readFilesWithDeadline`, `:21-29`), `claude/factory/scoring/score.js` (`projectInstructions` `:107-119`; key `:83`; record `:371`)
- States: files read, read blocked (null at deadline), judged without project instructions, recorded with no project files
- Transitions:
  - read in time -> files returned. Enforced at `claude/factory/lib/probe.js:21-29`.
  - read blocked -> null at the deadline (SIGKILL). Enforced at `claude/factory/lib/probe.js:21-29`. By design: `claude/factory/lib/probe.js:1-4`, `:25-26`.
  - null -> judged without instructions; message "could not be read in time; judging without them." Enforced at `claude/factory/scoring/score.js:107-119`.
  - judged -> record `{ global, project: [] }` under key `sessionId:sha:rubricVersion`, which has no instruction part. Enforced at `claude/factory/scoring/score.js:371` and `:83`.
- Gaps:
  - G1 A project `CLAUDE.md` that blocks is judged as if absent, and the record shows no sign of it. Verdict: confirmed. Evidence: `/bin/sh $P/run-probe.sh r2-instructions-timeout`, exit 0, 1 pass; output `PROJECT FILES [] MS 5003`. Task: new.
  - G2 Once judged under the same key, a session is not judged again when the file becomes readable. Verdict: unverified. Tried: nothing in Round 2. A run needs a judge call; a fake `claude` on `PATH` could stand in for it (not built). Task: new (with G1).
- Tests: probe `r2-probe-timeout` shows the by-design deadline (blocked read returns null at 304 ms, regular file read, exit 0, 2 pass). No score-suite test of this state was found (not checked in Round 2).

## Prior record check (Round 1 machines A-L, verdicts C1-C13)

Round 2 re-read only the code that the changed entries cite. Other items carry the Round 1 result.

- A Friction cursor: still holds (`friction/cli.js:436`, `:471` read in Round 2).
- B Turn states, D Board feature probe: carried from Round 1 (not re-read in Round 2).
- E Match set: still holds (`friction/cli.js:152`); confirmed, dotfiles-440.
- F Evolve item states: still holds (`evolve/cli.js:117`); confirmed, dotfiles-443 item 6.
- G Setup registry: still holds (`setups/cli.js:25`); by design.
- H Proposal retry: still holds; G1 and G2 confirmed in Round 1; G3 confirmed in Round 2 (dotfiles-443).
- I Score record identity: still holds (`score.js:83`, `:36`, `:73`); G1 confirmed; G2 refuted.
- J Rubric version gate: changed (`rubric.json` version 14; prior 13). G1 confirmed, dotfiles-441.
- K Review titles: still holds (`review/cli.js:27`, `:148`); confirmed, dotfiles-440.
- L Board snapshot: still holds (`board/cli.js:65`, `:128`); not re-read in Round 2 beyond `:55-62`.
- C1 retry on a new branch: by design (`scoring/propose.test.js:310`).
- C2 `RECENT_DAYS` duplicate: still holds; confirmed in Round 2 (dotfiles-443).
- C3 partial weekly success: by design (`weekly/weekly.test.js:179`).
- C4a per-run cap, no daily cap: per-run cap by design (`friction/friction.test.js:367-376`); daily total is an owner decision (dotfiles-443 item 2). Changed from "unverified".
- C4b no board: by design (`friction/friction.test.js:399`); C4d three file errors: by design (`friction/friction.test.js:311`). Carried from Round 1; `friction.test.js` as a whole passes (31 pass, exit 0, Round 2).
- C4c `board ls --limit 1000`: still holds; confirmed, dotfiles-440.
- C4e cursor after crash: refuted (`friction/friction.test.js:295`; file passes, Round 2).
- C5 digest and detectors not tied to the rubric version: confirmed, dotfiles-441.
- C6 review title cap: still holds; confirmed, dotfiles-440.
- C11 Evolve `updatedAt` proxy: still holds; confirmed, dotfiles-443 item 6.
- C12 setup id removal: by design (`evolve/evolve.test.js:84`; 9 pass, exit 0, Round 2).
- C13 lock with pid 1: confirmed, dotfiles-442.
- C7-C10: out of scope in Round 1; not re-checked.
