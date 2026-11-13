# Factory implicit state machines (dotfiles-546)

Date: 2026-11-14. Tree read: git archive of the dotfiles worktree at HEAD 3525a13.
Scope: `claude/factory`, except `ui/`, `bench/`, `metrics/` and `audit/` (out of scope).
Verdicts come from runs listed in `probes.md`, unless marked "unverified" (code read only) or "by design" (test run by name).
Coverage is partial. See "Files not read in full".

## Machines (21)

### Friction cursor

- Where: `claude/factory/friction/cli.js`
- States: unread window, cursor advanced
- Transitions:
  - unread window -> cursor advanced: run end writes the cursor. Enforced at `claude/factory/friction/cli.js:471`.
  - run start -> window: run reads the record file. Enforced at `claude/factory/friction/cli.js:359`. Cursor read path not re-checked.
- Gaps:
  - G1 The spend cap is per run, with no daily cap. Verdict: unverified (code read; prior record measured spend). Evidence: `claude/factory/friction/cli.js:436` checks `spent + options.budgetUsd > options.maxTotalUsd`. Task: dotfiles-443.
- Tests: `claude/factory/friction/friction.test.js:295` (exit 0, by name).

### Friction turn states

- Where: `claude/factory/friction/turns.js`, `claude/factory/friction/cli.js`
- States: open, held, filed-feedback (skipped), scored, below minimum, judged, judge error
- Transitions:
  - open -> held: turn not complete and recent. Function at `claude/factory/friction/turns.js:26` (`newTurn`). The 6 h rule is from the prior record; not re-read.
  - turn already filed feedback -> skipped. Enforced at `claude/factory/friction/cli.js:97-98`.
  - scored -> below minimum: score under `--min-score`. Location not re-read this span.
  - judge error -> judged again, until 2 errors. Enforced at `claude/factory/friction/cli.js:445`.
- Gaps:
  - G1 Score weights are hand-set in code. Verdict: unverified (code read only). Evidence: `claude/factory/friction/turns.js:208`. Task: new.
- Tests: none checked this span.

### Friction filing record

- Where: `claude/factory/friction/cli.js`
- States: pending, board-filed (no record yet), filed (recorded), file-error, given up
- Transitions:
  - pending -> board-filed: board accepts the feedback. Enforced at `claude/factory/friction/cli.js:428` (file loop).
  - board-filed -> filed: record appended. Enforced at `claude/factory/friction/cli.js:308`.
  - file-error -> pending: retried on the next run. Enforced at `claude/factory/friction/cli.js:428`.
  - file-error three times -> given up. Pinned by `claude/factory/friction/friction.test.js:311`.
- Gaps:
  - G1 A crash between the board accept and the record append makes the next run file again. Verdict: confirmed. Evidence: `bun test` on `claude/factory/friction/probe-fr-crash.test.js`, exit 0, 1 pass. Task: new.
  - G2 A given-up filing leaves no final record. Verdict: by design. Evidence: `claude/factory/friction/friction.test.js:311` (exit 0, 1 pass). Task: none.
- Tests: `claude/factory/friction/friction.test.js:295` (exit 0), `:311` (exit 0).

### Judge call spend

- Where: `claude/factory/lib/claude.js`, `claude/factory/friction/cli.js`
- States: attempt, refused, retried, succeeded, failed with cost
- Transitions:
  - attempt -> refused -> retried: a refused attempt is retried. Enforced at `claude/factory/lib/claude.js:81`.
  - retried -> succeeded: cost is the spent amount plus the final call. Enforced at `claude/factory/lib/claude.js:106`.
  - retried -> failed: a `ClaudeCallError` is thrown with `costUSD`. Class at `claude/factory/lib/claude.js:38`.
  - failed call -> budget: friction uses `error.costUSD`, or the budget when absent. Enforced at `claude/factory/friction/cli.js:453`.
- Gaps:
  - G1 When the final attempt fails after a refusal, `error.costUSD` leaves out the refused attempt's spend. Verdict: confirmed. Evidence: `bun test` on `claude/factory/lib/probe-refused.test.js`, exit 0, 2 pass. Error `costUSD` 0.02; control with the same two calls gives 0.04. By reading, friction then records 0.02 (`claude/factory/friction/cli.js:453`). Task: new.
- Tests: `claude/factory/lib/lib.test.js:444` (exit 0, by name). Probe: `claude/factory/lib/probe-refused.test.js` (scratch).

### Friction record file (JSON Lines)

- Where: `claude/factory/lib/state.js`, `claude/factory/friction/cli.js`
- States: intact, torn last line, read error
- Transitions:
  - intact -> torn: a crash leaves a partial last line. Read check at `claude/factory/lib/state.js:32` (throw).
  - torn -> run stops: every friction run stops, dry runs too. Caller reads records at `claude/factory/friction/cli.js:359`.
- Gaps:
  - G1 One torn last line stops every friction run, dry runs too. Verdict: confirmed. Evidence: `bun test` on `claude/factory/friction/probe-torn.test.js`, exit 0, 1 pass. Message ends `friction.jsonl:2: malformed JSON line`. Task: new.
- Tests: none in the suite checked this span; probe `claude/factory/friction/probe-torn.test.js` (scratch).

### Board feature probe

- Where: `claude/factory/friction/cli.js`
- States: feature present, feature missing
- Transitions:
  - run start -> feature missing: help text lacks `--source`. Probe at `claude/factory/friction/cli.js:259` (`boardFilesCapture`).
  - feature missing -> nothing judged. Pinned by `claude/factory/friction/friction.test.js:399`.
- Gaps:
  - G1 No board feature means nothing is judged or filed. Verdict: by design. Evidence: `claude/factory/friction/friction.test.js:399` (exit 0, 1 pass). Task: none.
- Tests: `claude/factory/friction/friction.test.js:399`.

### Match set

- Where: `claude/factory/friction/cli.js`
- States: open items listed, list failed
- Transitions:
  - list -> matched: open items and this run's filings are matched. Enforced at `claude/factory/friction/cli.js:152`.
  - list failed -> capture-only matching. Prior record only (`:151-157`); not re-read.
- Gaps:
  - G1 `board ls --limit 1000` has no full-page check. Verdict: unverified (code read; prior verdict C4c). Evidence: `claude/factory/friction/cli.js:152`. Task: dotfiles-440.
- Tests: none checked this span.

### Evolve item states

- Where: `claude/factory/evolve/cli.js`
- States: routed open, fixed, not fixed
- Transitions:
  - routed open -> fixed: owner task is done and `updatedAt` is inside the window. Enforced at `claude/factory/evolve/cli.js:117`.
  - `updatedAt` is set from the task. Set at `claude/factory/evolve/cli.js:64`. Window logic at `:75-101` (read only).
- Gaps:
  - G1 `updatedAt` stands in for the fix time, so a later edit to a done task counts as a fix. Verdict: unverified (code read; prior record C11 says latent). Evidence: `claude/factory/evolve/cli.js:64`, `:117`. Task: new.
- Tests: `claude/factory/evolve/evolve.test.js:39` (exit 0, by name), `:185` (exit 0, by name).

### Setup registry

- Where: `claude/factory/setups/cli.js`
- States: registered, invalid, required id missing
- Transitions:
  - entry -> invalid: checked in `problems()`. Enforced at `claude/factory/setups/cli.js:40-42`.
  - required id absent -> problem. Enforced at `claude/factory/setups/cli.js:25` (`REQUIRED`).
- Gaps:
  - G1 Removing a setup id leaves old filings with an `about` that names no setup. Verdict: unverified (code read; prior record C12; the about check is at `claude/factory/friction/cli.js:236`). Task: new.
- Tests: `claude/factory/setups/setups.test.js` needs a `.git` folder; not run in the git archive copy (environment).

### Proposal publish and retry

- Where: `claude/factory/scoring/propose.js`, `claude/factory/lib/proposal.js`, `claude/factory/board/proposal.js`
- States: candidate, branch pushed, PR created, proposed, error (pushed, no PR URL), killed (no record), retryable
- Transitions:
  - candidate -> branch pushed -> PR created: publish with `onPushed`. Enforced at `claude/factory/scoring/propose.js:287`.
  - gh exits 1 after it created the PR -> error. Enforced at `claude/factory/scoring/propose.js:366-371`.
  - error or dry-run -> retryable. Set at `claude/factory/lib/proposal.js:150` (`RETRYABLE`).
  - retry -> new branch. By design; pinned by `claude/factory/scoring/propose.test.js:310`.
- Gaps:
  - G1 gh creates the PR, then exits 1. The retry opens a second PR for one proposal. Verdict: confirmed. Evidence: `bun test` on `claude/factory/scoring/probe-propose.test.js`, exit 0, 7 pass. First run `status=error pushed=true prUrl=null`; `gh creates total=2`. Task: new.
  - G2 SIGKILL after gh creates the PR leaves no record and one remote branch. A rerun opens a second PR. Verdict: confirmed. Evidence: same probe file. `records=0`, remote branches 1; rerun `records=1 gh creates=2`. Task: new.
  - G3 `RECENT_DAYS = 30` is defined in two files. Verdict: unverified (grep only; no probe shows a mismatch). Evidence: `claude/factory/scoring/propose.js:45`, `claude/factory/board/proposal.js:32`. Task: dotfiles-443.
- Tests: `claude/factory/scoring/propose.test.js:310` (exit 0, by name); `claude/factory/scoring/propose-instr.test.js` (25 pass, by file).

### Score record identity

- Where: `claude/factory/scoring/score.js`
- States: eligible, quiet period, judged, judge error, ineligible
- Transitions:
  - eligible -> judged: record appended. Enforced at `claude/factory/scoring/score.js:387` and `:401`.
  - judge error -> retried until 2 errors. Enforced at `claude/factory/scoring/score.js:73` (`MAX_JUDGE_ERRORS`).
  - record key: `sessionId:sha:rubricVersion`. Enforced at `claude/factory/scoring/score.js:83`.
  - quiet period 30 minutes. Set at `claude/factory/scoring/score.js:36`.
- Gaps:
  - G1 Two score runs at once both judge the same session. Verdict: confirmed. Evidence: `bun test` on `claude/factory/scoring/probe-score.test.js`, exit 0, 2 pass. Concurrent: 2 lines, 2 judge calls. Sequential control: 1 line, 1 call. Task: new.
  - G2 The judge prompt is not in the key, so a prompt change without a version bump is not rescored. Verdict: unverified (code read). Evidence: key at `claude/factory/scoring/score.js:83` has three parts; the bump is manual (`claude/factory/scoring/rubric.js:3-6`, prior record). Task: new.
- Tests: `claude/factory/scoring/score.test.js:301` (exit 0 alone; judge calls fail in some test orders in this environment).

### Rubric version gate

- Where: `claude/factory/scoring/rubric.json`, `claude/factory/scoring/rubric.js`
- States: current version, older version (excluded from proposals)
- Transitions:
  - version bump -> older records excluded. Rule documented at `claude/factory/scoring/rubric.js:3-6`; enforcement point not re-read.
- Gaps:
  - G1 Changing the digest output size passes every scoring test, so the output is not pinned. Verdict: confirmed. Evidence: `bun test --timeout 60000` on four scoring test files (`detectors`, `digest`, `propose`, `score`) in the baseline copy and in a copy with `claude/factory/scoring/digest.js:15` set to 100. Both: exit 0, `270 pass`, `0 fail`. Earlier runs in this span gave 26 fail in both copies; this rerun did not reproduce them. Task: dotfiles-441.
- Tests: none ties digest or detector output to the rubric version.
- Changed since 2026-11-12: `claude/factory/scoring/rubric.json` version is 14 (prior record: 13), from commit 69cb566.

### Review title list

- Where: `claude/factory/review/cli.js`
- States: titles listed, titles cut
- Transitions:
  - board list -> first 200 titles kept. Cap `TITLES` at `claude/factory/review/cli.js:27`; slice at `:148`.
- Gaps:
  - G1 Duplicates beyond the first 200 titles are not seen. Verdict: unverified (code read; prior verdict C6 says latent). Evidence: `claude/factory/review/cli.js:27`, `:148`. Task: dotfiles-440.
- Tests: none checked this span.

### Board snapshot

- Where: `claude/factory/board/cli.js`, `claude/factory/board/proposal.js`
- States: fresh, failed read, empty
- Transitions:
  - read fails -> snapshot with errors. Snapshot init (`feedback: null, errors: []`) at `claude/factory/board/cli.js:65`; error capture at `:73`.
  - snapshot with errors -> exit 1. Enforced at `claude/factory/board/cli.js:128`.
  - proposal reads feedback. Enforced at `claude/factory/board/proposal.js:75` (`snapshot.feedback ?? []`).
- Gaps:
  - G1 A failed board read gives the same note as an empty board. Verdict: confirmed. Evidence: `bun test` on `claude/factory/board/probe-b1.test.js`, exit 0, 1 pass. Both results: `0 open feedback tasks (0 new); signals: none  nothing to propose`. Error text absent. Task: new.
  - Not re-checked this span: the prior stale-snapshot check (machine L, prior record).
- Tests: `claude/factory/board/probe-b1.test.js` (scratch).

### Pid lock file

- Where: `claude/factory/lib/state.js` (`acquireLock`)
- States: free, held by a live pid, held by pid 1 (EPERM), stale, taken over
- Transitions:
  - free -> held: exclusive create writes the pid. Enforced at `claude/factory/lib/state.js:57`.
  - live pid -> refused. `process.kill(pid, 0)` succeeds at `claude/factory/lib/state.js:65-66`.
  - EPERM (pid not ours, such as pid 1) -> refused. Enforced at `claude/factory/lib/state.js:68`.
  - ESRCH (dead pid) -> stale file removed -> retried. Enforced at `claude/factory/lib/state.js:69-72`.
- Gaps:
  - G1 Stale takeover is not atomic. Several processes take one stale lock in one round. Verdict: confirmed. Evidence: `bun test` on `claude/factory/lib/probe-lock.test.js`, exit 1, 1 fail (one-winner check). Rerun winners per round: 4,2,2 (50 processes). Earlier runs: 3,2,1; 3,4,7; 1,3,3. Related: dotfiles-342 (freshen-base takeover). Task: new.
  - G2 A lock naming pid 1 is never taken over. Verdict: confirmed. Evidence: `bun test` on `claude/factory/lib/probe-pid1.test.js`, exit 0, 1 pass. `L442 pid-1 lock results [false,false,false] file "1"`; dead-pid control `true`. Mechanism: EPERM at `claude/factory/lib/state.js:68`. Task: dotfiles-442.
  - G3 An empty lock file: `Number("")` is 0, so the file takes the stale branch and is removed at `claude/factory/lib/state.js:62-72`. Verdict: unverified (code read; not run). Open question: a reader can see the file after the create and before the pid write (`:57`), and remove a live lock. Task: dotfiles-158 (its description may not match this code; check its body).
- Tests: `claude/factory/lib/probe-lock.test.js`, `claude/factory/lib/probe-pid1.test.js` (scratch). No suite test of takeover checked this span.

### LaunchAgent install and uninstall

- Where: `claude/factory/lib/launchd.js`, `claude/factory/weekly/cli.js`, `claude/factory/friction/cli.js`
- States: no plist, plist written, loaded, not loaded, removed
- Transitions:
  - install: bootout, write plist, bootstrap. Enforced at `claude/factory/lib/launchd.js:76-79`.
  - bootstrap fails -> returns its exit code; plist kept. Enforced at `claude/factory/lib/launchd.js:80-81`.
  - uninstall: bootout (result not checked), plist removed. Enforced at `claude/factory/lib/launchd.js:87-90`.
- Gaps:
  - G1 A failed bootstrap leaves the plist on disk, and status says not loaded. Verdict: confirmed. Evidence: `bun test` on `claude/factory/lib/probe-launchd.test.js`, exit 0, 2 pass. `install code = 1 plist on disk = true`; `status = ... not loaded`. Task: new.
  - G2 Uninstall ignores a failed bootout and removes the plist. Verdict: unverified (behaviour shown by probe, exit 0; intent not known). Evidence: `PROBE U-boot uninstall result = undefined plist on disk after = false` with bootout exit 5. The normal path is pinned by tests (see below); the failure path is not. Task: new (confirm intent first).
- Tests: `claude/factory/weekly/weekly.test.js:247` (exit 0), `claude/factory/friction/friction.test.js:603` (exit 0). Probe: `claude/factory/lib/probe-launchd.test.js` (scratch).

### Transcript session listing

- Where: `claude/factory/lib/transcripts.js`
- States: listed file, skipped link, session with subagents, session dropped
- Transitions:
  - entry -> listed: real files only. Enforced at `claude/factory/lib/transcripts.js:18-23`.
  - subagent folder -> read. Enforced at `claude/factory/lib/transcripts.js:188` (`parseSubagents`).
  - subagent error -> whole session dropped. Enforced at `claude/factory/lib/transcripts.js:317` (`loadSessions`).
- Gaps:
  - G1 A valid symlink to a transcript is not read. Verdict: confirmed. Evidence: `bun test` on `claude/factory/lib/probe-transcripts.test.js`, exit 0, 4 pass. `TR1c sessions = 1` with a real file and a symlink to it (2 if symlinks were read). Task: new.
  - G2 A dangling symlink subagent drops the whole session. Verdict: confirmed. Evidence: same run. `TR1 control sessions = 1`; `TR1b sessions = 0`. Task: new.
- Tests: probe `claude/factory/lib/probe-transcripts.test.js` (scratch). Related, different causes: dotfiles-345, dotfiles-544.

### Digest builder

- Where: `claude/factory/scoring/digest.js`
- States: complete, bounded, final message cut
- Transitions:
  - final message -> labelled "shown in full below". Label at `claude/factory/scoring/digest.js:124`.
  - final message -> cut to a quarter of the limit. Enforced at `claude/factory/scoring/digest.js:212` (`ends(final.text, Math.floor(maxChars / 4))`).
- Gaps:
  - G1 The label says the final message is shown in full, but it is cut. Verdict: confirmed. Evidence: `bun test` on `claude/factory/scoring/probe-digest.test.js`, exit 0, 1 pass. Label `[A1] ASSISTANT: (final message, shown in full below)`; final message 20,020 characters; digest length 15528; marker `[…5020 chars…]`. Task: new.
  - G2 (prior C5) The same finding, seen from the digest. Verdict: confirmed. Evidence: see rubric gate G1. Task: dotfiles-441.
- Tests: `claude/factory/scoring/digest.test.js` (read in full). Its long final message is about 5,600 characters, under the cut. No test uses a final message over 15,000 characters.

### Review record and board add

- Where: `claude/factory/review/cli.js`
- States: reviewed, verified (confirmed or rejected), filed (task id), failed (error on the record)
- Transitions:
  - confirmed finding -> filed: board add succeeds; push with the task id. Enforced at `claude/factory/review/cli.js:222-223`.
  - board add fails -> error on the record. Enforced at `claude/factory/review/cli.js:217-227` (catch at `:227`).
  - run day -> `main-DATE.json` written. Enforced at `claude/factory/review/cli.js:288`.
- Gaps:
  - G1 One failed board add stops the loop, so later confirmed findings are missing from the record. Verdict: confirmed. Evidence: `bun test -t "failures end the repository with the reason and what it spent" claude/factory/review/probe-add.test.js`, exit 0, 1 pass. `RV1 add-fail {"confirmed":[],"rejected":1,"error":"board add on dotfiles exited 1: board unreachable"}`. The fixture marks two findings REAL (`claude/factory/review/testing/fake-session.js:24`). Task: new.
  - G2 A same-day rerun overwrites the day's record (`claude/factory/review/cli.js:288`; weekly `claude/factory/weekly/cli.js:181-182`). Verdict: unverified (code read). Task: new.
- Tests: `claude/factory/review/review.test.js:196` (exit 0, by name).

### Review-skipped detector

- Where: `claude/factory/scoring/detectors.js`, `claude/factory/scoring/review-scope.js`
- States: no edit, edit pending, settled by a review or a push
- Transitions:
  - edit -> pending: file located and not ignored. Enforced at `claude/factory/scoring/detectors.js:747`.
  - edit in an unmapped folder -> dropped, no pending entry. Enforced at `claude/factory/scoring/detectors.js:747`.
  - push -> settles pending edits of its repo. Repo `""` settles none; repo `null` settles all. Enforced at `claude/factory/scoring/detectors.js:736` and `:771`.
  - T3 name -> checkout. `t3Checkout` at `claude/factory/scoring/review-scope.js:126`; null when names clash (`:124`).
- Gaps:
  - G1 A push from an unknown folder settles nothing, so the verdict is `na` with an unreviewed edit. Verdict: confirmed. Evidence: `bun test` on `claude/factory/scoring/probe-d.test.js`, exit 0, 5 pass. `D1a unmapped cwd {"verdict":"na","hits":[]}`; `D1b no cwd` and `D1c known cwd` give `fail`. The comment at `claude/factory/scoring/detectors.js:715` says every repository settles when the folder is unknown. Task: new.
  - G2 Two T3 checkouts with one name and different repos drop the edit. Verdict: confirmed. Evidence: same run. `D3 t3Checkout two repos null`; `D3a {"verdict":"na","hits":[]}`; `D3b` (same repo) `fail`; `D3c` (one root) `fail`. No test covers the clash case (grep of the scoring tests). Task: new.
- Tests: `claude/factory/scoring/detectors.test.js` (not run by name this span). Changed since 2026-11-12: commits 91bd6c8, 98ab42b, 3cbe0a7, 69cb566.

### Weekly run

- Where: `claude/factory/weekly/cli.js`
- States: free, locked, running, report written
- Transitions:
  - lock held -> run refused. Enforced at `claude/factory/weekly/cli.js:167` (`acquireLock`).
  - report -> `weekly-DATE.md` written with a plain write. Enforced at `claude/factory/weekly/cli.js:181-182`.
  - uninstall result ignored. Enforced at `claude/factory/weekly/cli.js:214`.
- Gaps:
  - G1 The report write is not atomic, and a rerun the same day replaces the file. Verdict: unverified (code read). Task: new.
  - G2 Uninstall result is ignored. Same behaviour as machine "LaunchAgent install and uninstall" G2. Verdict: unverified. Task: new (one item with that G2).
- Tests: `claude/factory/weekly/weekly.test.js:179` (exit 0, by name; failing step reported, others still run), `:247` (exit 0, by name).

## Prior record check

Prior record: `scratchpad/prior/factory-machines.md` and `scratchpad/prior/factory-verdicts.md`.
Machines A-L are in scope. Machines M-P (ui, bench, metrics, audit) are out of scope and were not re-checked.

- A Friction cursor: still holds. Cursor write at `friction/cli.js:471`; cap check at `:436`.
- B Turn states: still holds. `friction/turns.js:26`, `:208`.
- C Finding filing: still holds. Key at `friction/cli.js:71`; record append at `:308`. New confirmed gap (filing G1).
- D Board feature probe: still holds at `friction/cli.js:259`. The run path was not re-read.
- E Match set: still holds. `--limit 1000` at `friction/cli.js:152`.
- F Evolve item states: still holds at `evolve/cli.js:117`.
- G Setup registry: still holds. `REQUIRED` at `setups/cli.js:25`.
- H Proposal retry: still holds, with confirmed gaps G1 and G2 (duplicate PR, orphan branch). Changed since 2026-11-12 by commit 0c4ddba (`lib/proposal.js`, `propose.test.js`).
- I Score record identity: still holds. Key at `score.js:83`; quiet period `:36`; error cap `:73`. New confirmed gap (concurrent runs, G1).
- J Rubric version gate: changed. `scoring/rubric.json` version is 14 (prior 13), from commit 69cb566.
- K Review titles: still holds. `review/cli.js:27`, `:148`.
- L Board snapshot: still holds at `board/cli.js:65` and `:128`. New confirmed gap (failed read looks empty). The stale-snapshot check was not re-run.

Prior verdicts (C1-C13):
- C1 Retry on a new branch: by design (`scoring/propose.test.js:310`, exit 0). The duplicate PR consequence is confirmed (machine 10 G1).
- C2 `RECENT_DAYS` duplicate: still holds (`scoring/propose.js:45`, `board/proposal.js:32`). Task dotfiles-443.
- C3 Partial weekly success: by design (`weekly/weekly.test.js:179`, exit 0). The other pins were not re-run.
- C4a Per-run cap, no daily cap: still holds (`friction/cli.js:436`). Unverified this span. Task dotfiles-443.
- C4b No board: by design (`friction/friction.test.js:399`, exit 0).
- C4c `board ls --limit 1000`: still holds (`friction/cli.js:152`). Task dotfiles-440.
- C4d Three file errors: by design (`friction/friction.test.js:311`, exit 0).
- C4e Cursor after crash: refuted (`friction/friction.test.js:295`, exit 0).
- C5 Digest and detectors not tied to the rubric version: confirmed, provisional. Task dotfiles-441.
- C6 Review title cap: still holds (`review/cli.js:27`, `:148`). Task dotfiles-440.
- C11 Evolve `updatedAt` proxy: still holds (`evolve/cli.js:117`). Unverified this span. Task: new.
- C12 Setup id removal: still holds in the code read. `evolve/evolve.test.js:39` (exit 0).
- C13 Lock with pid 1: confirmed by `probe-pid1` (exit 0). Task dotfiles-442.
- C7-C10: out of scope.

## Files not read in full

- `claude/factory/cli.js`, `claude/factory/PLAN.md`
- `lib/state.js` (only `:24-33`, `:53-75`), `lib/claude.js` (only `:38-42`, `:65`, `:81`, `:106`), `lib/proposal.js` (only `:121-142`, `:150`), `lib/launchd.js` (only `:73-96`), `lib/transcripts.js` (only `:18-26`, `:188-202`, `:317-331`), `lib/litellm.js` (only `:27-45`), `lib/pricing.js` (only `:12`), `lib/testing/*`
- `lib/*.test.js`: run by name only (`lib/lib.test.js:106`, `:444`, `:630`)
- `scoring/score.js`, `scoring/digest.js`, `scoring/detectors.js` (only `:683`, `:715`, `:720-784`), `scoring/review-scope.js`, `scoring/propose.js`, `scoring/rubric.js`, `scoring/high-impact.js` (not read)
- `scoring/detectors.test.js` (partly), `scoring/score.test.js` (partly)
- `friction/cli.js`, `friction/turns.js` (partly); friction tests run by name only
- `evolve/cli.js`, `setups/cli.js`, `board/cli.js`, `board/proposal.js`, `review/cli.js`, `review/review.test.js`, `weekly/cli.js` (all partly)
- Tests read in full: `scoring/digest.test.js` only.
