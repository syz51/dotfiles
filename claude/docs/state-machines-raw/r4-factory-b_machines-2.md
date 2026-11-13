# Implicit state machines, round 2: ui, bench, audit, metrics (dotfiles-546)

Checkout: read-only, HEAD 3525a13, clean. Probes ran in scratch copies: `clone` (git init copy) and `fullclone` (full history).
Claude calls: fake binaries only (stub exit 99, sleep stub, pattern stub). No live model, no network.
Paths are repo-relative to `claude/factory/` unless they start with `claude/`.
Round 1 record: `<scratch>/e4-factory-b/machines.md`.
Gap IDs keep round 1 names (P<n>, U<n>). Each confirmed gap has a block in `probes-2.md`.

Summary of round 2:
- New machines: 9 (listed first).
- Corrected whole entries: 13 (M1, M2, M4, M7, M8, M9, M10, M11, M13, M14, M15, M16, M18).
- Unchanged round 1 entries, not copied: M3, M5, M6, M12, M17.
- Machine count after round 2: 27.

## UI contrast totals

- Where: `ui/checks.js:64-80` (contrast loop), `ui/checks.js:147-159` (`checkTotals`, read by the gates).
- States per text element: skipped; unknown background; checked.
- Transitions:
  - Element skipped (no own text, hidden, aria-hidden or disabled): `ui/checks.js:66-68`.
  - Background unknown: counted in `unknown`, then skipped: `ui/checks.js:71-73`.
  - Background known: contrast checked against the required ratio: `ui/checks.js:75-80`.
  - Totals keep `contrast.count` only: `ui/checks.js:153`. The unknown count never reaches the totals.
- Gaps:
  - P18, confirmed: unknown backgrounds never reach the totals. Evidence: `bun probes/p18-unknown.js` exit 0 (rerun A). Output for unknown 4 and unknown 0 is identical. Task: new.
  - In-page contrast with a real background (`ui/checks.js:71-73`): unverified. Blocked: the headless Chromium browser is not installed, and its download needs the network, which this round does not use.
- Tests: none pins the unknown count. `grep -c unknown ui/ui.test.js` hits only unrelated fields and an issue-name case (`ui/ui.test.js:80`, `:400`).

## UI judge retry

- Where: `ui/council.js:277-317` (`runJudge`), `:283-310` (`sample`), `:312` (`allSettled`).
- States per sample: first attempt; retry; done; failed twice (throws); judge failed (any sample rejected).
- Transitions:
  - Call error: retry if the room check passes: `ui/council.js:286`, `:294-298`.
  - Output error (`JudgeOutputError`): retry once: `ui/council.js:304-306`.
  - No room for a retry: throws `JudgeFailedError`: `ui/council.js:286-287`.
  - Second failure: throws: `ui/council.js:309`.
  - Any rejected sample rejects the judge: `ui/council.js:313-314`.
- Gaps: None found.
  - Each call has a 900000 ms limit: `ui/council.js:293`.
  - Each call's cost is recorded before a failure is reported: `ui/council.js:296`, `:301`, comment `:311`.
- Tests: `ui/ui.test.js:585` (`runJudge` with budget), `ui/ui.test.js:610` (`failed twice`).

## UI calibrate and budget refusal

- Where: `ui/cli.js:263-274` (`calibrateCommand`); help `ui/cli.js:46`.
- States: rejected by the samples check (no run folder); run opened and locked; refused (exit 3, run folder kept); calibrating.
- Transitions:
  - `--samples` outside 2 to 5: usage error, exit 2, before any folder: `ui/cli.js:264-265`.
  - `openRun` creates the folder, then `lockRun`: `ui/cli.js:266-267`.
  - Budget refusal after the folder exists: `ui/cli.js:269-273`, returns 3.
  - Otherwise: captures and judges: `ui/cli.js:275-292`.
- Gaps:
  - U7, confirmed, low: a refused calibration leaves a run folder. Evidence: `bash probes/calibrate-refused.sh` exit 0. `--samples 5` exit 3 ("could cost up to $5.00"); `--samples 3` exit 3 ("$3.00"); run folder count 1 after the refusal; judge stub calls 0. Task: new.
  - U8, confirmed, low, documentation: help does not state the upper bound. Evidence: `calibrate --samples 6` and `--samples 1` exit 2 with no run folder. `--samples 5` passes the check (`ui/cli.js:265`). Help `ui/cli.js:46`: "(default 3, at least 2)". Task: new.
- Tests: `ui/ui.test.js:1366-1372` pins exit 3 and the message "could cost up to $1.50". It does not check the run folder. This test may sit in the end-to-end block that `ui/ui.test.js:870-873` skips. Not run in round 2.

## UI extract temp folder

- Where: `ui/capture.js:65-81` (extract source with `dispose`); `ui/capture.js:70` (mkdtemp `claude-factory-ui-`), `:73` (`extractCommit`), `:81` (`dispose` removes it). Callers: `ui/run.js:146`, `ui/run.js:212`.
- States: folder created; extracted; disposed; left behind after a kill.
- Transitions: created (`ui/capture.js:70`), extracted (`:73`), removed by `dispose` (`:81`). No other code removes it.
- Gaps:
  - U9, confirmed: SIGKILL leaves the folders. Evidence: `bun probes/u-ui-kill.js` exit 0: "killed holder: extract folders left = 2". The error path adds none: "bad sha: Error; folders = 2" (2 before, 2 after). Task: new.
  - No sweep: `grep -rn claude-factory-ui- ui` finds only `ui/capture.js:70` and test prefixes. `ui/cli.js` has no clean command (`grep -c clean` = 0). Part of U9's task.
  - Real `$TMPDIR` holds one `claude-factory-ui-*` folder dated 2026-11-11. Kept, not removed. Origin not confirmed; a kill fits it.
- Tests: `ui/ui.test.js:156-172` (`dispose` used in tests). No test kills the process.

## Bench token count temp folder

- Where: `bench/board/tokens.js:14-29` (`inputTokens`): `:15` (mkdtemp `board-bench-tokens-`), `:27` (`rmSync` in `finally`). Clean skip: `bench/board/run.js:150`.
- States: folder created; removed on return; left behind after a kill.
- Transitions: created (`bench/board/tokens.js:15`) to removed in `finally` (`:27`). SIGKILL skips `finally`. `cleanLeftovers` skips names with the `tokens-` prefix (`bench/board/run.js:150`).
- Gaps:
  - U10, confirmed: SIGKILL leaves the folders, and `bench board clean` does not remove them. Evidence: `bun probes/r2-tokens-driver.js` exit 0: "tokens folders while running=4 after SIGKILL=4 child exit=137". Then `bench board clean` exit 0, "Nothing to clean.": 4 folders before, 4 after. Task: new.
- Tests: none pins the token folders. `grep -c board-bench-tokens bench/board/board.test.js` = 0 (exit 1).

## Bench runOne workspace folder

- Where: `bench/runner.js:78-79` (mkdtemp `claude-bench-<case>-`), `:87-134` (`try`/`finally`), `:132-134` (`rmSync` of the root).
- States: root created; workspace filled; session run; removed in `finally`; left behind after a kill.
- Transitions: created (`bench/runner.js:79`), removed (`:134`). `cleanLeftovers` matches only its own prefix (`bench/board/run.js:149-150`).
- Gaps:
  - U11, confirmed: SIGKILL leaves the root. Evidence: `bun probes/u-runner-kill.js` exit 0: "claude-bench folders while running=1 after SIGKILL=1 child exit=null". The child used the sleep stub, a scratch HOME and no API key. Task: new.
  - No sweep: `grep -rn claude-bench bench` (outside cases) finds only creation sites: `bench/runner.js:79`, `bench/add.js:40`, `bench/review/review.js:175`. `bench/cli.js` has no clean command.
- Tests: none pins removal after a kill (`bench/bench.test.js:28` makes its own scratch folder).

## Bench board serve wait

- Where: `bench/board/run.js:52-57` (`freePort`), `:88-99` (`waitHealthy`).
- States: waiting; healthy; server exited (throws, `:91`); timed out (throws, `:99`).
- Transitions:
  - First `/healthz` answer: healthy: `bench/board/run.js:93`. Any listener on the port answers, including a foreign process.
  - `freePort` returns a port that was free before the server binds: `:55-56`.
- Gaps:
  - U4 family, confirmed: the port can be taken before the server binds. Evidence: `bun probes/r2-port.js foreign` exit 0: `waitHealthy` accepted a foreign server; the stub exited 1. Task: new (same family as `ui/capture.js:88-97`, see M7).
- Tests: none found. `grep -c 'freePort\|waitHealthy' bench/board/board.test.js` = 0.

## Bench legacy roles

- Where: `bench/report.js:57` (`LEGACY_ROLES`, comment "dotfiles-457"), `:61` (mapping).
- States: none (a mapping).
- Transitions: a record with role `solver` counts as `worker`: `bench/report.js:61`.
- Gaps: None found. By design: the test `bench/bench.test.js:515-516` pins it. The bench suite passes in the full-history copy (42 of 42, earlier in round 2).
- Tests: `bench/bench.test.js:515-516`.

## Audit hook test runner

- Where: `audit/audit.js:242-253` (`hookTestFinding`).
- States: folder missing (`:243`, medium finding); suites pass (`:249-250`, info); suites fail (`:251-252`, high).
- Transitions: runs `bun test` on the folder (`:244`), reads pass and fail counts (`:246-248`).
- Gaps:
  - Refuted: "`--with-tests` runs live suites". `find claude/hooks -name "*live*"` returned 0 files (exit 0). No live file is in scope.
  - None other found.
- Tests: `audit/audit.test.js:231-234` pins a passing and a failing suite.

## M1. UI run lock and run identity (corrected)

- Where: `ui/run.js:18-20` (identity), `:35-49` (`openRun`), `:57-66` (`holderAlive`), `:69-95` (`lockRun`).
- States: no lock; locked by a live pid; lock with no pid; stale lock; run identity matches or not.
- Transitions:
  - No lock to locked: `ui/run.js:73-75` (wx create, write pid).
  - Locked to released: `ui/run.js:76` (rm, no owner check).
  - Live pid, refused: `ui/run.js:89-90`.
  - Stale lock, removed and taken again: `ui/run.js:88-91`.
  - Identity mismatch: `ui/run.js:39-40`. Existing run.json: `ui/run.js:46-47`.
- Gaps:
  - P1, confirmed (round 1): a lock whose pid belongs to an unrelated live process stays held. Task: dotfiles-442.
  - U1, confirmed: unlock has no owner check (`ui/run.js:76`). Evidence: `rerun.sh A` `u1-main` exit 0 ("B still running when C finished: true"). `u1-control` exit 0 (B refused). Task: new.
  - U2, confirmed: `openRun` checks, then writes `run.json` (`ui/run.js:43-47`). Evidence: `u2-openrun` exit 0, trial 12 "already exists". Earlier: 8 of 12 and 16 of 16. Two folders across a second boundary (`ui/run.js:22`) not reproduced: `r2-openrun` exit 0, 12 trials, trialsWithTwoRunDirs=0. Note only.
  - U12, confirmed: lock steal race (`ui/run.js:82-91`). Evidence, `rerun.sh C`: plain exit 0, 16 of 40 trials with two acquisitions (earlier 24 of 40 and 13 of 40). Delay exit 0, 5 of 5. Solo exit 0, 0 of 10. Fresh exit 0, 0 of 20. Distinct from dotfiles-442 (reused pid). Task: new.
- Tests: `ui/ui.test.js:222-239` (live holder refused at :226; pid 1 refused at :233; half-written lock raises RunError at :236; recovery at :239).

## M2. UI round record and round number (corrected)

- Where: `ui/cli.js:364` (number), `:384` (base record with dirty flag), `:477` (round file write), `:479` (rounds.jsonl append). `ui/run.js:105` (fullRounds falls back to the summary line).
- States: no round; round file written, no line yet; round recorded; file missing (summary fallback).
- Transitions: number = lines in rounds.jsonl + 1 (`ui/cli.js:364`). File write (`:477`), then append (`:479`). Missing file: summary fallback (`ui/run.js:105`).
- Gaps:
  - P8, confirmed (round 1): a kill between `:477` and `:479` leaves round-N.json with no line; the next run reuses N. Task: dotfiles-443 item 4.
  - P7, confirmed, full loss: with round-1.json missing, the issue's first round moves to 2 and the issue is lost when no round file exists. Evidence: `rerun.sh A` `p7-full` exit 0. With round-1.json: entry home|hierarchy resolved in round 2 (since 1). Without it: entries=0; the fallback record has no issues. Task: new (proposal S).
- Tests: none located in round 1; not searched in round 2.

## M4. UI champion verdict (corrected)

- Where: `ui/cli.js:126-133` (`championOf`), `ui/council.js:364-368` (`championResult`); USAGE `ui/cli.js:33-50`, `--new-run` help `:44`.
- States: no champion; champion is a round.
- Transitions:
  - `championOf` picks a round by its rule (`ui/cli.js:126-133`).
  - `championResult` returns "rejected" when lead < -margin; "replaced" when eligible and (lead > margin or pass); else "held" (`ui/council.js:364-368`).
- Gaps:
  - Replacement with lead null: `championResult` returns "replaced" when the round passes and is eligible. By design: comment `ui/council.js:361-363`; test `ui/ui.test.js:697-699`. Evidence: `rerun.sh A` `champion` exit 0. Open question for the owner: is replacement without a head-to-head lead the intent?
  - U3, confirmed, low, documentation: USAGE and `--new-run` help do not describe the pass and eligibility rules, or that the budget resets. Evidence: `bun <clone>/claude/factory/ui/cli.js --help` exit 0; `grep -ci 'pass\|eligib\|budget'` on the output = 0. Task: new.
- Tests: `ui/ui.test.js:697-699` (replacement), `:711-716` (championOf rule).

## M7. UI serve lifecycle (corrected)

- Where: `ui/capture.js:88-97` (`freePort`), `:110-117` (`signalTree`), `:131-164` (`serve`): `:144` (tree), `:145` (TERM), `:146` (wait, 3 s), `:147-150` (KILL), `:155` (exit before ready: throw), `:158-160` (timeout: stop, throw).
- States: starting; waiting for ready; ready; exited before ready; timed out; stopping with leader alive; stopping with leader exited; stopped.
- Transitions:
  - Exit before ready: throw (`:155`). Deadline: stop, then throw (`:158-160`).
  - Stop, leader alive: tree = descendants (`:144`). TERM to tree and group (`:145`). Wait up to 3 s (`:146`). KILL (`:148`).
  - Stop, leader exited: tree = [] (`:144`). TERM to group (`:145`). No wait, no KILL.
- Gaps:
  - P2, confirmed (round 1): after the leader exits, `stop()` sends one TERM and returns at once. A child that ignores TERM survives. Task: new.
  - Refuted: the leader-alive path. The child was dead after about 3.1 s (P2 alive block).
  - U4, confirmed: `freePort` (`:88-97`) returns a port another process takes first. Evidence: `rerun.sh A` `u4-foreign` exit 0 (serve returns FOREIGN; EADDRINUSE). `u4-control` exit 0. Task: new (family with bench board serve wait).
- Tests: `ui/ui.test.js:187-214` (leader-alive stop, descendants in other groups). No exit-first test found.

## M8. UI budget and config identity (corrected)

- Where: `ui/config.js:221-224` (bounds), `:230` (call against round), `:247` (comment: formatting does not count), `:249` (hash of JSON.stringify(raw)). `ui/run.js:18-20` (identity), `:39-40` (mismatch throws).
- Spend: `ui/council.js:266-270` (request size), `:287` (retry budget check). `ui/cli.js:272` (calibration message), `:288-289` (spend tally).
- States: config valid or invalid; config hash; run identity matches or not; spend per call, round and run.
- Transitions: bounds check (`ui/config.js:221-224`). Hash of the file's key order (`:249`). Hash into identity (`ui/run.js:18-20`). Mismatch throws (`:39-40`).
- Gaps:
  - P19, confirmed, low: `budgetUsd.round` above `budgetUsd.run` loads. Only the call is checked against the round (`ui/config.js:230`). Task: new.
  - P20, confirmed: reordering keys changes the hash and refuses the old run (`ui/run.js:39-40`). The comment at `ui/config.js:247` says formatting does not count. Task: new.
  - P9, open question: the per-run budget is by design (`claude/skills/ui-climb/SKILL.md:236`). Round 2: `rerun.sh A` `p9-budget` exit 0. Two runs spent 0.9 each, 1.8 in total, against `budgetUsd.run` 1. No cap across runs exists. Owner decision: Reason: design or cost.
- Tests: `ui/ui.test.js:39-56` (defaults), `:83-99` (validation; call must not exceed round at `:97`).

## M9. bench matrix runner (corrected)

- Where: `bench/cli.js:25`, `:57` (`--max-total-usd` default 10 per invocation), `:85-90` (trial outermost), `:118` (batch id), `:122-124` (runId `${batch}-${++sequence}`). `bench/runner.js:143` (`runMatrix`).
- States: cell (trial, case, config) pending or done; spend per invocation.
- Transitions: trial, then case, then config. Each record is appended. Spend stops at the cap (`bench/runner.js:143`).
- Gaps:
  - P14, confirmed (round 1): a rerun runs every cell again and appends records (2, then 4 sessions). Each invocation has its own cap. Task: dotfiles-443 item 3 (also dotfiles-425).
- Tests: `bench/bench.test.js:366-367`, `:382-383`, `:398` (`runMatrix` with `maxTotalUsd`).

## M10. bench board runs, run ids and token cache (corrected)

- Where: `bench/board/cli.js:96` (previous, filtered by series, model, effort), `:97` (pending), `:100` (sequence = previous.length), `:106` (runId `${series}-${++sequence}`), `:111-114` (StopRun), `:127-142` (token cache). Token counting: `bench/board/tokens.js`.
- States: run pending; run done; stop reason; token cache entry per cell.
- Transitions: sequence from earlier runs (`:100`), then runId (`:106`). StopRun ends a series (`:111-114`). Cache write (`:131`), read (`:136`).
- Gaps:
  - P15, confirmed: two models in one series get the same run id. Evidence: `u6k` (claude-opus-5-5) exit 0, and `u6k-haiku` (claude-haiku-5-5, same HOME) exit 0. Both records have runId `u6k-1`; results.jsonl has two records. Task: new (no open board task found; search "run id" matched none).
  - U5, confirmed: the token cache loses counts on a partial failure (`bench/board/cli.js:127-142`). Evidence: `rerun.sh A` `u5-partial` exit 0: claude calls 4, tokens file absent. `u5-complete` exit 0: calls 5, file present. `u5-haiku` exit 0. Earlier: model overwrite and a missing model field. Task: new.
  - U6, by design: maxInfra counts consecutive voids. `bench/board/cli.js:31` (help), `:101`, `:113-114`.
  - Refuted as a leak: bench matrix SIGKILL. `u6-kill` exit 0: 1 folder before the kill; `clean` removed 1; afterwards 0 folders and 0 live processes named it. No start-of-matrix clean: by design (`bench/board/README.md:63`).
  - Token count folders on kill: see U10 (new machine above).
- Tests: `bench/board/board.test.js:191-221` (runOne with runId). No test for the partial-failure cache found.

## M11. bench board leftover clean (corrected)

- Where: `bench/board/run.js:149-156` (`cleanLeftovers`). `:150` (filter: prefix, skips `tokens-`). `:152` (`pkill -KILL -f`, status not checked). `:154` (`rmSync` root).
- States: leftover root present; processes named by the root killed; root removed.
- Transitions: pkill by argv (`:152`), then rm of the root (`:154`). Both run for any root found, whether or not a run is live.
- Gaps:
  - P16, confirmed (round 1): a root used by a live run loses its process and its folder. Task: new.
  - P16 orphan, same gap: a child whose argv does not name the root survives with ppid 1 (`sleep 60`).
  - P16b, confirmed (control): `pkill -f` matches by argv only.
  - U10, confirmed: token folders (`board-bench-tokens-*`) are skipped by the filter (`:150`), so SIGKILL leftovers stay. Evidence: `tokens-clean-r2`: "Nothing to clean.", 4 folders before and after. Task: new.
- Tests: `bench/board/board.test.js:10` imports `cleanLeftovers`. No test pins the token exclusion.

## M13. bench board Wilson report (corrected Tests)

- Where: `bench/board/report.js:9-16` (`wilson`; `:10` returns null when n is 0). `rate()` at `:20-23` counts k over the same filtered set as n.
- States: none. Pure function.
- Gaps:
  - P22, refuted: `wilson(5, 3)` returns null bounds when called directly. `rate()` cannot pass k > n, since k is a subset count of n (`bench/board/report.js:21-22`).
- Tests: `bench/board/board.test.js:286-291` (`wilson(0, 0)` null; `wilson(20, 20).high` = 1).

## M14. audit baseline acceptance (corrected)

- Where: `audit/cli.js:42-44` (`readBaseline` throws on a malformed file), `:84-86` (`update-baseline` writes `{ version: 1, updatedAt, accepted }`), `:91` (read call, outside a try), `:95` (accepted), `:96` (failing list, exit 1). `audit/audit.js:14-15` (severities, rank). `audit/cli.js:17` (help).
- States per finding: accepted; failing (not accepted, at or above `--fail-on`); passing.
- Transitions: accepted = id present and rank(finding) <= rank(entry.severity ?? "high") (`:95`).
- Gaps:
  - P11, confirmed (round 1): an entry without severity accepts a high finding (exit 0). Task: dotfiles-443 item 5.
  - U13, confirmed, low: a malformed baseline gives an uncaught stack trace and exit 1 (`audit/cli.js:43-44`, `:91`). Usage errors exit 2 (`:73-74`). Evidence: `bash probes/audit-baseline.sh` exit 0. Task: new.
  - By design: `--update-baseline` drops entries that no longer match (`audit/cli.js:17`). Evidence: probe ghost count 0. Acceptance by id: `audit/audit.test.js:162-171`.
- Tests: `audit/audit.test.js:81-105` (severity), `:162-171` (by id), `:206-211` (malformed throws).

## M15. audit sandbox profile (stateless, corrected Tests)

- Where: `audit/sandbox.js` (read in full). `profileFor` `:71-79` throws on a relative `allowWrite` (`:74`).
- States: none.
- Gaps: None found.
- Tests: `audit/sandbox.test.js:21`, `:30`, `:37-38`, `:43-45` (read in full in round 2). The live suite `audit/sandbox.live.test.js` was read, not run.

## M16. metrics PR cache (corrected)

- Where: `metrics/github.js:8` (`OPEN_TTL_MS`, 1 h), `:9` (`CACHE_FILE`), `:29` (read), `:34-36` (use cache), `:41` (store), `:45` (failure note), `:48` (write only if changed).
- States per PR: absent; fresh OPEN; stale OPEN; MERGED or CLOSED; refresh failed (note).
- Transitions: cache or gh (`:34-36`). Store fresh result (`:41`). gh failure: note, and the PR is left out (`:45`). Write only when changed (`:48`).
- Gaps:
  - P17, confirmed (round 1): a stale OPEN PR whose refresh fails is left out. Task: new.
  - MERGED and CLOSED never refresh: the condition at `metrics/github.js:35` (`cached.pr.state !== "OPEN" || now - cached.fetchedAt < OPEN_TTL_MS`) keeps any non-OPEN entry. Evidence: `bun probes/metrics-closed.js` exit 0. PR 1 is still CLOSED after a reopen, two hours later on a fake clock. PR 2 (OPEN) refreshed, views 2 to 3 (control). Task: new (proposal S).
  - Flake `metrics/metrics.test.js:303`: round 1 saw one 5003 ms run. Round 2, ten isolated runs: 240, 51, 49, 49, 53, 49, 50, 52, 50, 50 ms, all passed. The first run was a cold start. Not reproduced. Board: dotfiles-243 (dropped, same test).
- Tests: `metrics/metrics.test.js:303`, `:313` (closed count), `:335` (PR 2 OPEN refresh), `:351` (failing gh note). No test pins a CLOSED refresh (`grep -c CLOSED` = 0).

## M18. metrics corrections (stateless, corrected Tests)

- Where: `metrics/corrections.js` (read in full): rules, `countCorrections`.
- States: none. Heuristic.
- Gaps: None in state terms.
- Tests: `metrics/corrections.test.js:49-51` (read in full in round 2; `countCorrections` cases).

## Round 2 verdicts: by design, refuted, unverified

- By design: U6 (`bench/board/cli.js:31`, `:101`, `:113-114`). No start-of-matrix clean (`bench/board/README.md:63`). Legacy roles (`bench/report.js:57`; `bench/bench.test.js:515-516`). Champion replacement (`ui/council.js:361-363`; `ui/ui.test.js:697-699`). Ghost entries dropped by `--update-baseline` (`audit/cli.js:17`). P9 per-run budget (`claude/skills/ui-climb/SKILL.md:236`).
- Refuted: bench matrix SIGKILL leak (`u6-kill`, exit 0). `--with-tests` live scope (`audit/audit.js:242-253`; no live file). P22 (`bench/board/report.js:21-22`). Metrics flake (not reproduced, ten runs). Report pass vs status pass (`ui/cli.js:453-454`; `ui/report.js:146`; `ui/ui.test.js:1060`).
- Unverified: in-page contrast (`ui/checks.js:71-73`). Blocked: needs headless Chromium, whose install needs a network download. The UI end-to-end suite is skipped (`ui/ui.test.js:870-873`, 13 skipped), not run.

## Board check (round 2)

- Searched with `board ls --board dotfiles --search <word>`: run id, tokens, clean, contrast, metrics, CLOSED, baseline, budget, calibrat, champion, extract, port.
- No open task covers the new gaps. The matches were unrelated.
- Holders kept: P1 dotfiles-442; P8 and P14 dotfiles-443 items 4 and 3; P11 dotfiles-443 item 5; P6 dotfiles-331; P14 also dotfiles-425; P19 and P20: the budget and config searches matched no related task.
- Dropped: dotfiles-243 (metrics test timeout), holds the flake.
