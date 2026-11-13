# Implicit state machines: ui, bench, audit, metrics (dotfiles-546, explorer track)

Checkout: read-only worktree at HEAD 3525a13, clean. Probes ran in the scratch copy `$SCRATCH/clone`.
Paths are repo-relative to `claude/factory/` unless they start with `claude/`.
Pids and ports are placeholders. Gap IDs P<n> match the blocks in `$SCRATCH/probes.md`.

Verdicts: confirmed (probe run), by design (document or test cited), refuted, unverified (reading only).
Task: a board id, or "new" (no open task found; the parent files it).

## Coverage

- 18 machine entries: 15 stateful (M1-M12, M14, M16, M17) and 3 stateless (M13, M15, M18).
- Read in full: ui/run.js, ui/capture.js, ui/gates.js, bench/add.js, bench/report.js, bench/board/tokens.js, bench/board/measure.js, bench/board/report.js, metrics/prs.js, metrics/corrections.js, audit/sandbox.js.
- Read in ranges, with the cited lines: ui/cli.js, ui/config.js, ui/council.js, ui/ledger.js, ui/checks.js (only :71-73), bench/cli.js, bench/runner.js, bench/board/cli.js, bench/board/run.js, bench/style/style.js, bench/style/cli.js, audit/cli.js, audit/audit.js, metrics/cli.js, metrics/github.js.
- Test files, cited lines only: ui/ui.test.js, audit/audit.test.js, metrics/metrics.test.js, bench/style/style.test.js.

## Not read

- Source, not read: bench/review/cli.js, bench/review/review.js, metrics/markdown.js, metrics/reviews.js, metrics/stats.js, ui/report.js.
- Tests, not read: bench/bench.test.js, bench/board/board.test.js, bench/review/review.test.js, audit/sandbox.test.js, metrics/corrections.test.js. audit/sandbox.live.test.js is a live suite; not read, not run.
- Fixtures and data, not read: bench/cases.js, bench/cases/*/overlay/*.js, bench/board/scenario.js, the 8 test files under */testing/ folders, JSON data files.
- bench/board/scenario.js: an earlier read returned text that read like an instruction. Treated as fixture data; not acted on.

## Board check (read on this pass)

- dotfiles-442: open, p3, proposal "Fix factory lock takeover for a reused pid". Holds P1.
- dotfiles-443: open, p3, proposal with ten items. Items 3, 4 and 5 hold P14, P8 and P11.
- dotfiles-331: open, p3, blocked on dotfiles-332. Holds P6 as evidence. Its decision note (2026-11-09) says to revisit "only if a recorded climb shows two problems merged". P6 is a probe, not a recorded climb. A note on 331 should say so.
- dotfiles-425: open, p3, triage proposal. Lists the bench rerun, metrics dedupe and UI round repeat. Its second-pass notes give by-design verdicts for metrics.test.js:546, audit.test.js:162 and friction.test.js:399 (outside these folders).
- dotfiles-441: open, p3, rubric version pins for scoring. Does not cover the UI config hash.
- dotfiles-546: doing, p1. Its body asks for by-design and refuted verdicts as finding notes on the task, and for a task per code not read.

## M1. UI run lock and run identity

- Where: ui/run.js:18-20 (identity), :35-49 (openRun), :57-66 (holderAlive), :69-95 (lockRun).
- States: no lock; locked by a live pid; lock with no pid; stale lock; run identity matches or not.
- Transitions:
  - no lock to locked: run.js:73-75 (wx create, write pid).
  - locked to released: run.js:76 (rm, no owner check).
  - live pid, refused: run.js:89-90.
  - stale lock, removed and taken again: run.js:88-91.
  - identity mismatch, RunError: run.js:39-40. Existing run.json: run.js:46-47.
- Gaps:
  - P1, confirmed: a lock whose pid now belongs to an unrelated live process stays held. Task: dotfiles-442.
  - U1, unverified: unlock at run.js:76 has no owner check. A holder that lost its lock to a steal could remove the new holder's lock.
  - U2, unverified: openRun checks, then writes run.json (run.js:46-47). Two processes can race.
- Tests: ui/ui.test.js:222-239. Live holder refused (:226). Pid 1 refused (:233). Half-written lock raises RunError (:236). Recovery (:239). The pid 1 test pins the same live-pid rule that P1 shows for a reused pid. It does not make P1 by design.

## M2. UI round record and round number

- Where: ui/cli.js:364 (number), :384 (base record with dirty flag), :477 (round file write), :479 (rounds.jsonl append). ui/run.js:105 (fullRounds falls back to the summary line).
- States: no round; round file written, no line yet; round recorded (file and line); file missing (summary fallback).
- Transitions:
  - number = lines in rounds.jsonl + 1 (cli.js:364).
  - round file write (:477), then line append (:479).
  - fullRounds falls back to the summary when the file is missing (run.js:105).
- Gaps:
  - P8, confirmed: a kill between :477 and :479 leaves round-N.json with no line. The next run reuses N. Task: dotfiles-443 item 4.
  - P7, confirmed, low, narrowed: with round-1.json missing, an issue's first round moves from 1 to 2. Full loss of the missing round's issues was not probed. Task: new.
- Tests: not located in this pass.

## M3. UI issue ledger and settled fixes

- Where: ui/ledger.js:14 (SETTLED_MAX 20), :19-44 (ledger), :22 (skips rounds without verdicts or issues), :26 (key), :32 (stores fixes[0]). Header :1-12. Grouping by screen|category: ui/council.js:378-386.
- States per key: open (since round N); resolved (resolvedIn M); settled fix (kept, at most SETTLED_MAX).
- Transitions:
  - issue in a round: open or updated (:26).
  - key missing from a later round with verdicts: resolved (read, not probed).
  - settled list capped at SETTLED_MAX (:14).
  - stored fix is fixes[0] only (:32).
- Gaps:
  - P5, confirmed: a dirty round resolves an issue the same as a clean round. The ledger does not read the dirty flag set at ui/cli.js:384. --allow-dirty is at cli.js:356-357. Task: new.
  - P6, confirmed as a probe: a key with two fixes settles only the first (:32). Grouping is by design (council.js:378; ledger.js:1-12). Task: dotfiles-331, see Board check.
  - Settled-fix expiry at a structural round: part of dotfiles-331 (b). No probe.
- Tests: ui/ui.test.js:486-522 (settledFixes; SETTLED_MAX at :519-522).

## M4. UI champion verdict

- Where: ui/cli.js:126-133 (championOf), ui/council.js:364 (championResult), USAGE text ui/cli.js:33-50, --new-run help :44 (earlier read).
- States: no champion; champion is a round.
- Transitions: championOf picks a round by its rule (cli.js:126-133). championResult reads it (council.js:364).
- Gaps:
  - By design: the rule is pinned by ui/ui.test.js:711-716 (verified).
  - U3, unverified, low (documentation): USAGE does not describe the pass and eligibility rules. The --new-run help (:44) does not say the budget resets. Not run.
- Tests: ui/ui.test.js:711-716.

## M5. UI judge output read

- Where: ui/council.js:194-232 (readOutput). :201 (scored design not shown: throw). :230 (issues filtered). :231 (strengths filtered).
- States per judge output: accepted; issue or strength dropped; error.
- Transitions: scored design not shown: throw (:201). Issue or strength naming an unshown design: dropped with no error (:230, :231).
- Gaps:
  - P21, confirmed, low: an issue naming an unshown design is dropped silently. A scored unshown design throws. Task: new.
- Tests: ui/ui.test.js:387-393 (readOutput). ui/ui.test.js:1027 pins the scored error ("scored Design 99, which was not shown"). No test for the silent drop was found.

## M6. UI capture batch and reference retries

- Where: ui/capture.js:191-221 (captureShots). :205 (GET failure throws). :211 (error = report.error, or no file). ui/run.js:163-197 (referenceVersions): :172-173 (tries, delayMs, loop), :177-178 (doubling delay), :181 (capture call), :190 (CaptureError when none captured).
- States per shot: captured; errored (record); batch aborted (throw); old file accepted.
- Transitions:
  - failed GET at :205 throws out of captureShots. Later shots of the batch do not run.
  - browse error or no file: error recorded (:211).
  - no file written but an old file exists: error null (:211, P4).
  - reference retry: wait doubles up to tries (run.js:177-178). A throw from captureShots at run.js:181 skips the retry loop (code reading).
  - folder clears: baseline and control at run.js:135; candidate at run.js:220. None in referenceVersions (run.js:163-197).
- Gaps:
  - P3, confirmed: one failed GET aborts the batch. Later shots are not captured. Task: new.
  - P4, confirmed, latent: an old file counts as a capture (:211) when the browser writes nothing. Reachable in referenceVersions, which does not clear the folder. Task: new.
- Tests: not located in this pass.

## M7. UI serve lifecycle

- Where: ui/capture.js:88-97 (freePort), :110-117 (signalTree), :131-164 (serve): :144 (tree), :145 (TERM), :146 (wait loop, 3 s), :147-150 (KILL), :155 (exit before ready: throw), :158-160 (timeout: stop, throw).
- States: starting; waiting for ready; ready; exited before ready; timed out; stopping with leader alive; stopping with leader exited; stopped.
- Transitions:
  - exit before ready: throw (:155).
  - deadline: stop, then throw (:158-160).
  - stop, leader alive: tree = descendants (:144). TERM to tree and group (:145). Wait up to 3 s (:146). KILL to tree and group (:148).
  - stop, leader exited: tree = [] (:144). TERM to group (:145). Wait skipped. No KILL.
- Gaps:
  - P2, confirmed: after the leader exits on its own, stop() sends one TERM and returns at once. A child that ignores TERM survives. Task: new.
  - Refuted: the leader-alive path. The child was dead after about 3.1 s (P2, alive block).
  - U4, unverified, low: freePort (:88-97) can return a port that another process takes first.
- Tests: ui/ui.test.js:187-214 covers the leader-alive stop and descendants in other process groups. No exit-first test was found in this pass.

## M8. UI budget and config identity

- Where: ui/config.js:221-224 (budget bounds), :230 (call against round), :249 (hash: sha256 of JSON.stringify(raw)), :247 (comment: formatting does not count). ui/run.js:18-20 (identity), :39-40 (mismatch throws).
- Spend: ui/council.js:266-270 (request size limit), :287 (retry budget check). ui/cli.js:272 (calibration message), :288-289 (spend tally).
- States: config valid or invalid; config hash; run identity matches or not; spend per call, round and run.
- Transitions: bounds check (:221-224). Call against round (:230). Hash of the file's key order (:249). Hash into run identity (run.js:18-20). Mismatch throws (run.js:39-40).
- Gaps:
  - P19, confirmed, low: budgetUsd.round above budgetUsd.run loads. Only the call is checked against the round (:230). Task: new.
  - P20, confirmed: reordering keys changes the hash, so the same settings refuse the old run (run.js:39-40). The comment at config.js:247 says formatting does not count. Task: new.
  - P9, open question: per-run budget is by design (claude/skills/ui-climb/SKILL.md:236, checked). A cap across runs is for the owner. Design or cost.
- Tests: ui/ui.test.js:39-56 (config defaults; budgetUsd at :56). :83-99 (validation; call must not exceed round at :97).

## M9. bench matrix runner

- Where: bench/cli.js:25, :57 (--max-total-usd default 10 per invocation), :85-90 (trial outermost), :118 (batch id), :122-124 (runId `${batch}-${++sequence}`). bench/runner.js:143 (runMatrix, maxTotalUsd, onRecord). Ranges from the earlier read.
- States: cell (trial, case, config) pending or done; spend per invocation.
- Transitions: trial, then case, then config. Each record is appended. Spend stops at the cap (runner.js:143).
- Gaps:
  - P14, confirmed: a rerun runs every cell again and appends records (2, then 4 sessions). Each invocation has its own cap. Task: dotfiles-443 item 3. Also in dotfiles-425.
- Tests: bench/bench.test.js not read.

## M10. bench board runs and run ids

- Where: bench/board/cli.js:96 (previous, filtered by series, model and effort), :97 (pending), :100 (sequence = previous.length), :106 (runId `${series}-${++sequence}`). :111-114 (StopRun: subscription, limit, maxInfra). :127-142 (token cache), :131 (write), :136 (read, earlier read).
- States: run pending; run done; stop reason; token cache entry per cell.
- Transitions: sequence from earlier runs (:100), then runId (:106). StopRun ends a series (:111-114).
- Gaps:
  - P15, confirmed: two models in one series get the same run id (t-1). Task: new.
  - U5, unverified: staleness of the token cache (:127-142). Task: none yet.
  - U6, unverified: whether maxInfra counts consecutive voids (:114).
- Tests: bench/board/board.test.js not read.

## M11. bench board leftover clean

- Where: bench/board/run.js:149-154 (cleanLeftovers). :152 (spawnSync pkill -KILL -f root; status not checked). :154 (rmSync root).
- States: leftover root present; processes named by the root killed; root removed.
- Transitions: pkill by argv (:152), then rm of the root (:154). Both run whatever pkill returns, and whether a run is live.
- Gaps:
  - P16, confirmed: a root in use by a live run loses its process and its folder. Task: new.
  - P16 orphan, same gap: a child whose argv does not name the root survives with ppid 1 (`sleep 60`).
  - P16b, confirmed (control): pkill -f matches by argv only.
- Tests: bench/board/board.test.js not read.

## M12. bench style aggregate and adopt

- Where: bench/style/style.js:168 (aggregate), :169 (usable filter), :181 (minTrials), :199 (keepsFacts), :203 (adopt = keepsFacts && shorter). bench/style/cli.js:112 (reportCommand pools all records, earlier read).
- States per variant: runs and minTrials. Decision: not measured (null), adopt, or do not adopt.
- Transitions: usable filter (:169). Decision at :203. minTrials is computed (:181) but not used by the decision.
- Gaps:
  - P12, confirmed: one run per variant gives adopt=true. No trial floor. Task: new.
  - Correction: the earlier "by design" label on style.test.js:175 is withdrawn. That test is a positive case with two runs per variant.
  - P13, confirmed: pooled records decide differently from one model's records. Task: new.
- Tests: bench/style/style.test.js:175 (positive case), :196 (no usable runs leaves the decision open, by design), :204 (matrix order).

## M13. bench board Wilson report (stateless)

- Where: bench/board/report.js:9-16 (wilson; :10 returns null when n is 0). rate() at :20-23 counts k over the same filtered set as n.
- States: none. Pure function.
- Gaps:
  - P22, refuted for the report path. wilson(5, 3) returns null bounds when called directly. rate() cannot pass k > n, since k is a subset count of n (report.js:21-22).
- Tests: bench/board/board.test.js not read.

## M14. audit baseline acceptance

- Where: audit/cli.js:42-44 (readBaseline, error on malformed). :85-86 (update-baseline writes severity and title, earlier read). :95 (accepted). :96 (failing list, exit 1, earlier read). audit/audit.js:14-15 (severities, rank). cli.js:29 (--fail-on default medium, earlier read).
- States per finding: accepted; failing (not accepted, at or above --fail-on); passing.
- Transitions: accepted = id present and rank(finding) <= rank(entry.severity ?? "high") (:95).
- Gaps:
  - P11, confirmed: an entry without severity accepts a high finding (exit 0). Severity info does not (exit 1). No entry: exit 1. Task: dotfiles-443 item 5.
  - By design: acceptance by id (audit/audit.test.js:162-171). Malformed baseline fails loudly (audit.test.js:206-210).
- Tests: audit/audit.test.js:81-105 (severity tests), :162, :206.

## M15. audit sandbox profile (stateless)

- Where: audit/sandbox.js (read in full). profileFor :71-79 throws on a relative allowWrite (:74, earlier read).
- States: none.
- Gaps: none found.
- Tests: audit/sandbox.test.js not read.

## M16. metrics PR cache

- Where: metrics/github.js:8 (OPEN_TTL_MS, 1 h), :9 (CACHE_FILE), :29 (read cache), :34-36 (use cache when not OPEN or fresh), :41 (store), :45 (failure note), :48 (write only if changed).
- States per PR: absent; fresh OPEN; stale OPEN; MERGED or CLOSED (kept without expiry); refresh failed (note).
- Transitions: cache or gh (:34-36). Store fresh result (:41). gh failure: note, and the PR is left out (:45). Write only when changed (:48).
- Gaps:
  - P17, confirmed: a stale OPEN PR whose refresh fails is left out of the result. The cache keeps its last state, and the note says the state is unknown. Task: new.
  - By design: the failing-gh note (metrics.test.js:351, "a failing gh call becomes a note").
  - Flake: metrics.test.js:303 took 5003 ms against 5000 ms once. Reruns passed. Not a state gap. Task: new (S).
- Tests: metrics/metrics.test.js:303, :351.

## M17. metrics history append

- Where: metrics/cli.js:21 (HISTORY), :267 (appendJsonl, no dedupe; earlier read).
- States: append only.
- Gaps: none. By design: no dedupe (metrics.test.js:546-550, verified name; dotfiles-425 note: 0 exact duplicates in the real file).
- Tests: metrics/metrics.test.js:546.

## M18. metrics corrections (stateless)

- Where: metrics/corrections.js (read in full): rules, countCorrections.
- States: none. Heuristic.
- Gaps: none in state terms.
- Tests: metrics/corrections.test.js not read.

## Refuted or by design, with citations

- Refuted: P22, wilson k > n from the report (bench/board/report.js:20-23).
- Refuted: the leader-alive stop path in M7 (P2, alive block).
- By design: P6 grouping (ui/council.js:378-386; ui/ledger.js:1-12).
- By design: P9 per-run budget (claude/skills/ui-climb/SKILL.md:236).
- By design: metrics history (metrics/metrics.test.js:546). Audit acceptance by id (audit/audit.test.js:162). Champion rule (ui/ui.test.js:711-716). Style with no usable runs (bench/style/style.test.js:196). Malformed audit baseline (audit/audit.test.js:206). Failing gh note (metrics/metrics.test.js:351).

## Unverified (reading only)

- ui/checks.js:71-73 (contrast). ui/capture.js:88-97 (freePort race). bench/board/cli.js:127-142 (token cache). ui/run.js:76 (unlock). bench/board/cli.js:114 (maxInfra). ui/run.js:46-47 (openRun race). ui/cli.js:33-50 and :44 (USAGE, low; not run). P7 full loss of issues.
