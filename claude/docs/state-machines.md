# Implicit state machines

This document lists the implicit state machines of this repository. An implicit state machine is state that code keeps in files, locks, status fields or process state, with no type or table that names the states. The audit ran in November 2026 as board task dotfiles-546.

## How to read it

- Each machine has one block: where the code is, its states, its transitions with the line that enforces each, its gaps, and its tests.
- Paths are relative to the repository root.
- Line numbers are those of the audited commit 3525a13. Later changes move them. The change of this audit to `claude/factory/lib/transcripts.js` and `claude/factory/lib/lib.test.js` moved lines in those two files.
- Each gap has a verdict:
  - `confirmed`: a probe or a test showed the defect.
  - `by design`: a test or a text in the repository says the behavior is intended. The gap line cites it.
  - `refuted`: a probe showed that the suspected defect does not occur.
  - `unverified`: only a code reading exists. A filed task holds the probe.
- `Task:` names the board task (board `dotfiles`) that holds the gap. The audit fixed no gap of these lists; it filed each one.
- Probes ran on scratch copies with a sandboxed home folder and a fake `claude` program. No probe started a real model run.
- The audit also read the agent-skills repository. That repository is private, so its 43 machines, their gaps and the raw probe records are not in this document. Task dotfiles-748 holds that part.

## Counts

Machines: 120 in this repository. The agent-skills part has 43 more (task dotfiles-748).

| Area | Machines |
|---|---|
| Hooks | 17 |
| Tooling | 16 |
| Factory | 51 |
| Scripts and shell | 36 |

Gap lines by verdict: confirmed 162, by design 48, refuted 17, unverified 39. A gap that two machines share has a line in each. The agent-skills part has: confirmed 94, by design 27, refuted 15, unverified 3.

## Sequential work on hot paths

The audit measured each site before a change. One site had a measure that supports a change.

### Changed

- Site: the factory loaded every transcript in one thread for scoring and metrics (`claude/factory/lib/transcripts.js`, callers `claude/factory/scoring/score.js` and `claude/factory/metrics/cli.js`).
- Change: `loadSessionsParallel` splits the files over at most 8 worker threads (`claude/factory/lib/transcripts-worker.js`). Under 32 files it stays on one thread.
- Measure: one process per run, 3 runs each.

| Window | Sessions | Before (ms) | After (ms) |
|---|---|---|---|
| 7 days | 2112 | 4400, 4407, 4503 | 1453, 1791, 1755 |
| 30 days | 2378 | 7175, 7551, 8564 | 3077, 3234, 3391 |
| 1 day | 11 | 191 | 191 |

- Tests: `claude/factory/lib/lib.test.js`, "loadSessionsParallel gives loadSessions's sessions in its order, and fails on an unreadable transcript" and "loadSessionsParallel skips a transcript removed after listing, and fails when a thread ends without an answer".
- Not measured: the peak memory of a load without a window (`factory score --session`). Task dotfiles-749 holds the measure.

### Measured and not changed

No measure supports a change at these sites.

| Site | Measure | Reason |
|---|---|---|
| `stale-base` hook (session start) | 88 ms with a local origin, 882 ms with the real origin (5 runs) | The network fetch is about 90 % of the time. The 12 local git reads decide whether the fetch runs. |
| PreToolUse Bash guards | 8 to 13.5 ms each, over a 4.9 ms `bun` start floor | Claude Code starts them together. |
| `board-hook.sh` | 5.5 to 82 ms | The time is inside the board binary, which is in another repository. |
| `zsh -i` start | 54 ms | No slow step found. |
| `freshen-base` | 26.6 ms | Small. |
| `open-items`, `worktree-rule`, `guard-asks`, `auto-merge` | 7.3, 6.7, 7.1, 8.3 ms | Near the `bun` start floor. |
| atuin shell hook | 4.6 ms | Small. |
| config-sync check | `git fetch --quiet origin main` 754 to 801 ms (5 runs); four local reads 42 to 98 ms in total | The fetch is the cost, and it is one call. |

To reverse the stale-base decision: collapse its reads into one `git rev-parse` call and one `git config --get-regexp` call.

### Measured in agent-skills, filed and not changed

This audit does not change agent-skills. Each site has a task.

| Site | Measure | Task |
|---|---|---|
| Capture scan | 200 files of 200 turns: cold median 1815 ms, warm 1382 ms; one line takes 28 to 31 % cold and 47 to 58 % warm | dotfiles-706 |
| Capture note re-read | 4 to 7 % of the same run | dotfiles-707 |
| Sync collect, one `git cat-file` per feedback file | 7635 calls and 68.66 to 69.36 s of child time in a run with no new notes; collect wall 182.8 to 271.3 s over two sets of runs | dotfiles-730 |
| Sync validate, one `uv run` per skill folder | 12 starts per run; the real cost is not measured (the probe was offline) | dotfiles-731 |
| Sync `publication_scope`, git calls per changed path | 177 to 179 `ls-tree` and 120 `show` calls per run | dotfiles-732 |

## Owner decisions

| Decision | Answer (2026-11-15) | Task |
|---|---|---|
| Is the full-stop merge hand-over an only-me action? | Widen only-me to include a reserved merge. | dotfiles-573 |
| Spend caps across runs for the UI climb and the skill evaluations | A per-day cap for both, tunable. | dotfiles-725 |
| Legal transitions of an agent-skills investigation issue | A table; an issue leaves resolved only with a reason. | dotfiles-726 |
| Capture retry limits and the monitor's alert policy | Keep all retries, make repeats visible. | dotfiles-723 |

## Code not read, and gaps without a verdict

| Part | Task |
|---|---|
| Tooling files not read in full | dotfiles-574 |
| Factory core files read only in part | dotfiles-595 |
| Factory bench, metrics and UI files not read | dotfiles-623 |
| Scripts-area files not read in full | dotfiles-658 |
| agent-skills files not read (tests, `skills/`, `public/`, prompts, CI files) | dotfiles-741 |
| Scripts-area gaps without a verdict | dotfiles-657, dotfiles-744 |
| lean-prompt host effect without a repeatable check | dotfiles-747 |
| Factory candidates without a verdict | dotfiles-742, dotfiles-743 |
| agent-skills capture gaps without a verdict | dotfiles-724 |
| agent-skills jobs, sync and test candidates without a verdict | dotfiles-745, dotfiles-746 |

## Hooks

Machines: 17

### Shell command parser

- Where: `claude/hooks/shell.js:48-66`, `:153`, `:530`, `:673-674`; the Bash guards use it.
- States: depth 0 to 8; plain word; quoted word; `$'...'` word; command name built by `$(...)`; unwrapped wrapper command; too deep
- Transitions:
  - script -> words: the parser splits a command into words and applies quotes. Enforced at `claude/hooks/shell.js:153`.
  - words -> wrapped command: a listed wrapper (xargs, xcrun) gives its command. Enforced at `claude/hooks/shell.js:48-66`.
  - command -> nested command: the depth goes up by one per nested script. Enforced at `claude/hooks/shell.js:530`.
  - depth above 8 -> too deep: the parser returns `tooDeep` and each guard decides. Enforced at `claude/hooks/shell.js:673-674`.
- Gaps:
  - G1 (B4): `$'...'` quoting ends a word early, so the guards do not see a force push after it. Verdict: confirmed. Evidence: probe `rerun.sh fast` (guards): row `308 quote: echo $'a\'b'; git push --force origin main` exit 0; row `308 control` exit 2. Task: note on dotfiles-308.
  - G2 (B5): The wrapper table does not list setsid, ionice and flock, so a force push behind them passes. Verdict: confirmed. Evidence: guards rows `424 setsid`, `424 ionice`, `424 flock`, all exit 0. Task: dotfiles-424.
  - G3 (B3): The parser does not resolve a command name built by `$(...)`, so a force push behind it passes. Verdict: confirmed. Evidence: guards row `C3 control` with `$(echo g)it push --force origin main`, exit 0; `G=git; $G push --force origin main` exit 2. Task: dotfiles-556; note on dotfiles-305.
  - G4: A too-deep script returns `tooDeep`, and the callers differ in what they do with it. Verdict: by design. Evidence: `claude/hooks/shell.test.js:251-256`; `bun test claude/hooks` exit 0, 1366 pass. Task: none (by design, finding #6754).
- Tests: `claude/hooks/shell.test.js`, `claude/hooks/guard-git-push.test.js`, `claude/hooks/guard-runtimes.test.js`, `claude/hooks/guard-main-checkout.test.js`

### freshen-base lock (withLock)

- Where: `claude/hooks/freshen-base.js:15-18`, `:60-88`; used by `claude/hooks/stale-base.js:11`.
- States: free; held; aged (lock older than 120 s); waiting; busy (wait over 30 s); stolen
- Transitions:
  - free -> held: `mkdir` of `freshen-base.lock` in the git common directory succeeds. Enforced at `claude/hooks/freshen-base.js:67`.
  - held -> waiting: another run holds the lock, and the caller retries every 100 ms. Enforced at `claude/hooks/freshen-base.js:81`.
  - waiting -> busy: the wait passes 30 s and the lock is younger than 120 s; the call returns `BUSY`. Enforced at `claude/hooks/freshen-base.js:80`.
  - held -> aged and removed: the lock mtime is older than 120 s; the caller removes it and retries. Enforced at `claude/hooks/freshen-base.js:79`.
  - held -> free: the work ends and `finally` removes the lock by path. Enforced at `claude/hooks/freshen-base.js:86`.
- Gaps:
  - G1 (B14): `finally` removes the lock by path, so a late holder deletes the lock of a newer holder. Verdict: confirmed. Evidence: probe `p-lock.js` (exit 0): holder `out` at 6143 ms while the thief's lock exists; late holder `in` at 6252 ms while the thief stays in until 8216 ms. Task: dotfiles-342.
  - G2 (B14): A run takes over a lock older than 120 s while its holder still works. Verdict: confirmed. Evidence: probe `p-lock.js`: lock aged to 200 s at 3144 ms; thief `in` at 3213 ms while the holder works. Task: dotfiles-342.
  - G3 (B15): The stolen-lock and busy states have no test. Verdict: confirmed. Evidence: `grep -c` of `LOCK_STALE|120_000|steal|stale lock|aged|utimes` in `claude/hooks/freshen-base.test.js` prints 0. Task: dotfiles-342.
- Tests: `claude/hooks/freshen-base.test.js:192` (parallel calls take turns)

### freshen-base fast-forward

- Where: `claude/hooks/freshen-base.js:91-127`
- States: fetched; dirty (tracked changes); clean; merged; merge failed; merge timed out
- Transitions:
  - fetched -> dirty or clean: the output of `git status --porcelain --untracked-files=no` decides. Enforced at `claude/hooks/freshen-base.js:117`.
  - dirty -> skipped: the note says the tracked changes are kept. Enforced at `claude/hooks/freshen-base.js:117`.
  - clean -> merged: `git merge --ff-only` succeeds. Enforced at `claude/hooks/freshen-base.js:121`.
  - clean -> merge failed: the merge fails or hits the 10 s default timeout. Enforced at `claude/hooks/freshen-base.js:121`.
- Gaps:
  - G1 (B11): A failed status check reads as clean, so main fast-forwards over a dirty checkout. Verdict: confirmed. Evidence: probe `FAIL_STATUS=1 p-freshen.js F2-status-fails dirty` (exit 0): note "Fast-forwarded main by 1 commit(s)", status `M a.txt` kept; the control without the fault refuses. Task: dotfiles-439.
  - G2 (B12): The merge has the 10 s default git timeout, so the hook kills a slow fast-forward and the note gives no reason. Verdict: confirmed. Evidence: probe `SLOW_MERGE=30 p-freshen.js F1-merge-slow` (exit 0): killed at 10.6 s, note "failed (no output)"; the comment at `claude/hooks/freshen-base.js:120` says "No timeout". Task: dotfiles-557.
  - G3 (B13): The run has no total time budget. Verdict: confirmed. Evidence: probe `SLOW_CALL=7 p-freshen.js F4-slow-calls` (exit 0): 107.2 s against the 90 s hook timeout (`claude/settings.json:65-66`). Task: dotfiles-557.
  - G4 (B15): No test covers a status failure or a merge timeout. Verdict: confirmed. Evidence: grep for `FAIL_STATUS`, `status.*fail` and `fail.*status` in `claude/hooks/freshen-base.test.js` prints 0. Task: dotfiles-439 (status failure); dotfiles-557 (merge timeout).
- Tests: `claude/hooks/freshen-base.test.js:76-192` (fast-forward; dirty tree at `:108`; fetch failure at `:128`)

### stale-base lock and note

- Where: `claude/hooks/stale-base.js:20-62` (note at `:60`); `BUSY` and `withLock` come from `claude/hooks/freshen-base.js` at `:11`.
- States: fetched; fetch failed or timed out; lock busy; no note
- Transitions:
  - lock held -> fetched: the fetch succeeds and the note has no suffix. Enforced at `claude/hooks/stale-base.js:60`.
  - lock held -> fetch failed: the fetch fails or times out and the note gets a suffix. Enforced at `claude/hooks/stale-base.js:60`.
  - lock busy (`BUSY`) -> note with the failed-fetch suffix. Enforced at `claude/hooks/stale-base.js:60`.
- Gaps:
  - G1 (B16): A skipped fetch (lock busy) gets the "fetch failed" suffix. Verdict: confirmed. Evidence: probe `p-stale.js busy` (exit 0): 0 fetch lines and the suffix "as last fetched"; the free run has 1 fetch line and no suffix. Task: dotfiles-439.
  - G2 (B17): No test covers the busy branch. Verdict: confirmed. Evidence: `grep -ci busy claude/hooks/stale-base.test.js` prints 0. Task: dotfiles-439.
- Tests: `claude/hooks/stale-base.test.js:54-71`

### auto-merge and the --auto rule in guard-pr-merge

- Where: `claude/hooks/auto-merge.js:88-126`; `claude/hooks/guard-pr-merge.js:394-398`
- States: draft; mergeable now; waiting on required checks; reviews-only base; BEHIND or DIRTY; auto-merge armed
- Transitions:
  - draft -> skipped: the hook arms nothing. Enforced at `claude/hooks/auto-merge.js:107`.
  - reviews-only base -> skipped. Enforced at `claude/hooks/auto-merge.js:112-114`.
  - mergeable now -> skipped: the agent merges directly. Enforced at `claude/hooks/auto-merge.js:118`.
  - waiting on required checks -> armed: `enablePullRequestAutoMerge`. Enforced at `claude/hooks/auto-merge.js:119-126`.
  - `--auto` with checks pending on a reviews-only base -> refused. Enforced at `claude/hooks/guard-pr-merge.js:394`.
  - `--auto` with BEHIND or DIRTY -> no verdict from the guard. Enforced at `claude/hooks/guard-pr-merge.js:398`.
- Gaps:
  - G1 (B9): The guard refuses `--auto` on a reviews-only base with checks running, but auto-merge arms the same PR. Verdict: confirmed. Evidence: probe `p-433.js` (exit 0): guard "blocked ... checks are still running" for BLOCKED and UNSTABLE; auto-merge "auto-merge is on (squash)" for BLOCKED non-draft. Task: dotfiles-433.
  - G2 (B10): No test covers `--auto` on a DIRTY PR. Verdict: confirmed. Evidence: `grep -c DIRTY claude/hooks/guard-pr-merge.test.js` prints 1; with `--auto` on the same line it prints 0. Task: dotfiles-433.
  - G3 (B9, arming part): auto-merge arms a non-draft PR whose base requires checks. Verdict: confirmed. Evidence: probe `p-433.js` row "auto BLOCKED, non-draft ... auto-merge is on". Round 2 rates the window before the owner's word as by design (see "Full-stop hold and release" under Tooling). Task: dotfiles-434.
  - G4: Round 1 did not run the ui-climb path that could open a non-draft PR. Verdict: refuted. Evidence: round 2: `claude/skills/ui-climb/SKILL.md:223-225` holds the PR as a draft; `claude/tests/config.test.js:865` pins the text. Task: note on dotfiles-434.
  - G5: `--auto` with BEHIND or DIRTY gets no verdict. Verdict: by design. Evidence: `claude/hooks/guard-pr-merge.js:398`; `claude/hooks/guard-pr-merge.test.js:77`; the file exits 0, 292 pass. Task: none (by design, finding #6754).
- Tests: `claude/hooks/auto-merge.test.js`; `claude/hooks/guard-pr-merge.test.js:77-91`

### guard-pr-merge check states

- Where: `claude/hooks/guard-pr-merge.js:177` (classifyChecks), `:188-190` (status decides), `:413` (pending message)
- States: no runs; all passed; a run in progress; a run failed; several runs with one name
- Transitions:
  - all runs passed -> allowed. Enforced at `claude/hooks/guard-pr-merge.js:188-190`.
  - any run IN_PROGRESS -> blocked with "checks are still running". Enforced at `claude/hooks/guard-pr-merge.js:188-190`, message at `:413`.
  - any failing conclusion (FAILURE, CANCELLED, TIMED_OUT) -> blocked. Enforced at `claude/hooks/guard-pr-merge.js:177`.
  - runs with the same name -> every run counts. Pinned at `claude/hooks/guard-pr-merge.test.js:261`.
- Gaps:
  - G1 (B8): A run with status IN_PROGRESS blocks even when its conclusion is SUCCESS. Verdict: confirmed. Evidence: probe `p-pr.js` (exit 0): "blocked 360: CI / Changes IN_PROGRESS with conclusion SUCCESS". Open question, not checked: GitHub may never send this pair. Task: dotfiles-360.
  - G2: A later SUCCESS run does not clear an earlier CANCELLED run with the same name. Verdict: by design. Evidence: `claude/hooks/guard-pr-merge.test.js:261` ("every run with the same name counts, in either order"); the file exits 0, 292 pass. Task: none (by design, finding #6754; dotfiles-396 would change the pinned rule).
- Tests: `claude/hooks/guard-pr-merge.test.js:82-91`, `:261`

### guard-main-checkout branch changes and git queries

- Where: `claude/hooks/guard-main-checkout.js:142-164` (changesBranch), `:307` (findMainCheckoutViolation), `:335-339` (runGit, 2000 ms timeout), `:342-345` (temp roots)
- States: main checkout or other; branch change listed or not; git query ok or failed; path in a temp root or not
- Transitions:
  - listed branch-changing command on main -> blocked. Enforced at `claude/hooks/guard-main-checkout.js:142-164`, `:307`.
  - unlisted ref command (`symbolic-ref`, `update-ref`, `branch -m`) -> allowed. Enforced at `claude/hooks/guard-main-checkout.js:142-164`.
  - git query error or 2 s timeout -> undefined -> allowed. Enforced at `claude/hooks/guard-main-checkout.js:335-339`.
  - cwd under a temp root -> exempt. Enforced at `claude/hooks/guard-main-checkout.js:342-345`.
- Gaps:
  - G1 (B1): `symbolic-ref`, `update-ref` and `branch -m` are not in the branch-change list, so they pass. Verdict: confirmed. Evidence: probe `guard-main-checkout-inproc.js` (exit 0): "allowed 431: git symbolic-ref HEAD refs/heads/feature", "allowed 431: git update-ref refs/heads/main HEAD~1", "allowed 431: git branch -m feature other"; control "blocked control: git switch feature". Task: note on dotfiles-431.
  - G2 (B2): A git query that takes over 2 s returns undefined, so the guard allows the command. Verdict: confirmed. Evidence: probe `SLOW_CALL=3 p-main.js` (exit 0): "allowed in 2.01 s"; control "blocked in 0.08 s". No test covers a timeout. Task: note on dotfiles-431.
  - G3 (B3): `$(echo g)it switch feature` and `G=git; $G switch feature` pass. Verdict: confirmed. Evidence: inproc rows "allowed C4: $(echo g)it switch feature" and "allowed C4: G=git; $G switch feature". Task: dotfiles-556; note on dotfiles-305.
  - G4: Checkouts under a temp root are exempt. Verdict: by design. Evidence: comment at `claude/hooks/guard-main-checkout.js:342-345`. Task: none (by design, finding #6754).
  - G5: A command nested deeper than the parser follows passes. Verdict: by design. Evidence: `claude/hooks/guard-main-checkout.test.js:283` ("the guard fails open"); the file exits 0, 273 pass. Task: none (by design, finding #6754).
- Tests: `claude/hooks/guard-main-checkout.test.js:215`, `:283`, `:289`

### guard-git-push prefilter and config read

- Where: `claude/hooks/guard-git-push.js:43-45` (PUSH_CONFIG), `:152-156` (config read), `:153-154` (rewrite flags), `:265-269` (prefilter), `:274` (block exit)
- States: no push word (prefilter allows); config readable; config read failed; rewrite flags (force, lease, remove); mirror set
- Transitions:
  - no push word -> allowed. Enforced at `claude/hooks/guard-git-push.js:265-269`.
  - config read fails -> plain push allowed; the rewrite check still runs. Enforced at `claude/hooks/guard-git-push.js:152-156`.
  - rewrite check -> looks for force, lease and remove only. Enforced at `claude/hooks/guard-git-push.js:153-154`.
- Gaps:
  - G1 (B7): With the config read failed, the guard allows a push when `remote.<name>.mirror=true`. Verdict: confirmed. Evidence: guards row `432 timeout: git push, git config read stopped after 2 s` (`SLOW_CONFIG=5`) exit 0; row `control: git push, config readable` exit 2. Task: dotfiles-432.
  - G2: A plain push goes ahead when the config read fails. Verdict: by design. Evidence: `claude/hooks/guard-git-push.test.js:209` ("a git query that fails blocks only history rewrites"). Task: none (by design, finding #6754).
  - G3 (B3): A command name built by `$(...)` passes. Verdict: confirmed. Evidence: guards row `C3 control`, exit 0. Task: dotfiles-556; note on dotfiles-305.
  - G4: A too-deep script passes the guard. Verdict: refuted. Evidence: `claude/hooks/guard-git-push.test.js:259` ("a script nested too deeply to check is blocked"); the test passes. Task: none (refuted, finding #6754).
- Tests: `claude/hooks/guard-git-push.test.js:209`, `:259`, `:402`

### guard-runtimes depth and command words

- Where: `claude/hooks/guard-runtimes.js:13-20` (header), `:137` (depth limit), `:174` (`git remote -v`, 2000 ms timeout), `:235` (findRuntimeViolation), `:246` (block exit); `claude/hooks/shell.js:48` (`WRAPPERS`)
- States: runtime command word (blocked); depth 0 to 7; too deep (skipped); variable or substitution (not followed); `xargs` replace string; node checkout check passed; node checkout check timed out (blocked with the node reason)
- Transitions:
  - command word is a runtime -> blocked, exit 2. Enforced at `claude/hooks/guard-runtimes.js:235`, `:246`.
  - depth 8 or more -> skipped, allowed. Enforced at `claude/hooks/guard-runtimes.js:137`.
  - `xargs -I{}` or `-J %` -> the replace string is not put into the command word. No code applies it.
  - `git remote -v` times out -> result false -> blocked with the node reason. Enforced at `claude/hooks/guard-runtimes.js:174`.
- Gaps:
  - G1 (B6): `xargs -I{}` and `-J %` hide the runtime name in the replace string. Verdict: confirmed. Evidence: probe `xargs2`: `echo python3 | xargs -I{} {} -c 'print(1)'` exit 0 and the `-J %` form exit 0; control `python3 -c` exit 2. Round 2 probe P-XARGS repeats it; guard-git-push and guard-main-checkout block the same forms. Task: dotfiles-414.
  - G2: The guard does not follow variables and command substitutions in the command word. Verdict: by design. Evidence: header `claude/hooks/guard-runtimes.js:16-20`; `bun test claude/hooks/guard-runtimes.test.js` exit 0, 381 pass. Task: none (by design, findings #6754 and #6765).
  - G3: The guard skips scripts nested 8 or more levels. Verdict: by design. Evidence: `claude/hooks/guard-runtimes.test.js:283` ("scripts nested too deeply to follow are skipped, not blocked"). Open question: whether the `tooDeep` item of dotfiles-425 also applies here. Task: none (by design, findings #6754 and #6765).
  - G4: A slow `git remote -v` makes the guard fail open. Verdict: refuted. Evidence: probe P-GITTO: a 3 s fake git prints `[slow git exit=2]` with a block; a fast git prints `[fast git exit=0]`. Task: none (refuted, finding #6765).
  - G5: On a git timeout the block names the node rule, so the reason does not show that the git check failed. Verdict: confirmed. Evidence: probe P-GITTO prints "Blocked by the guard-runtimes hook: `node server.js` runs node..." on the timed-out run, exit 2. Task: dotfiles-568.
- Tests: `claude/hooks/guard-runtimes.test.js:283`, `:558` (malformed input gets a non-blocking exit). No git-timeout case.

### deck-view once-only and staleDecks

- Where: `claude/hooks/deck-view.js` (names, staleDecks, main), `claude/bin/deck-view.js` (render, shown.json)
- States: no shown decks (pass without reading the transcript); shown deck unchanged or not named (pass); shown deck changed and named (block); once only (`stop_hook_active`)
- Transitions:
  - `stop_hook_active`, or no readable transcript -> pass, exit 0.
  - shown.json empty or missing -> pass, exit 0, transcript not read.
  - a shown deck's sha256 differs from its last render and the transcript names it -> block, exit 2, with the render instruction.
  - `deck-view <deck>` renders it -> shown.json records the new sha256 -> the next stop passes.
  - shown.json unreadable -> pass, exit 0, reason on stderr (fails open).
- Gaps: a deck of the same file name in another folder counts as named. Two simultaneous renders can drop one entry from shown.json. Both by design: the cost is one extra render or one unwatched deck.
- Tests: `claude/hooks/deck-view.test.js`

### open-items once-only and unfiledItems

- Where: `claude/hooks/open-items.js:59-86` (openItems), `:89-92` (unfiledItems), `:95-101` (board query), `:110` (active check), `:125` (block exit)
- States: disabled; active; once only (`stop_hook_active`); items unfiled (block); no unfiled items (pass)
- Transitions:
  - disabled or `stop_hook_active` -> pass, exit 0. Enforced at `claude/hooks/open-items.js:110`.
  - active with unfiled items -> block, exit 2. Enforced at `claude/hooks/open-items.js:125`.
  - item names a board slug with `-<digits>` -> counts as filed. Enforced at `claude/hooks/open-items.js:90-91`.
  - board query fails or returns bad JSON -> undefined (fails open). Enforced at `claude/hooks/open-items.js:97`, `:101`.
- Gaps:
  - G1 (B20): With an empty slug list, the pattern `\b(?:)-\d+\b` matches any word-hyphen-digit text, so "UTF-8" counts as a filed task. Verdict: confirmed. Evidence: probe `p-open.js` (exit 0): `unfiledItems(["Not verified: UTF-8 handling"], [])` returns `[]`; with slug `dotfiles` it returns the item. End to end: no slug exits 0; slug `dotfiles` exits 2. Task: dotfiles-558.
  - G2: `stop_hook_active` gives a once-only pass. Verdict: by design. Evidence: `claude/hooks/open-items.test.js:118-126`; the test passes. Task: none (by design, finding #6754).
- Tests: `claude/hooks/open-items.test.js:9`, `:118-126`

### board-hook.sh exit mapping

- Where: `claude/hooks/board-hook.sh:8` (disabled), `:13-22` (mapping), `:23` (exec); wired in `claude/settings.json` and `codex/hooks.json`.
- States: board disabled; board enabled; exit 2 mapped to 1; exit passed through
- Transitions:
  - board disabled -> exit 0. Enforced at `claude/hooks/board-hook.sh:8`.
  - `pre-tool-use` or `post-tool-use-failure` with exit 2 -> exit 1. Enforced at `claude/hooks/board-hook.sh:13-22`.
  - any other event -> the board exit code passes through. Enforced at `claude/hooks/board-hook.sh:23`.
- Gaps:
  - G1 (B18): Seven of nine board events pass exit 2 through unchanged. Verdict: confirmed. Evidence: probe `p-board.sh`: `pre-tool-use exit=1`, `post-tool-use-failure exit=1`; `post-tool-use`, `session-start`, `user-prompt-submit`, `stop`, `pre-compact` and `session-end` each `exit=2`; `board-stop-failure` exit 2. The impact is latent: the real board exits 0 on these events (prior record, not rerun). Task: dotfiles-435.
  - G2 (B19): No test pins the exit mapping. Verdict: confirmed. Evidence: `claude/tests/config.test.js:530-560` expects status 0 only; a count of `toBe([12])` in lines 462-560 prints 0. Task: dotfiles-435.
- Tests: `claude/tests/config.test.js:462-500` (wiring), `:530-560` (behaviour, status 0 only)

### worktree-rule

- Where: `claude/hooks/worktree-rule.js:13` (marker), `:19` (lastIndexOf)
- States: inside a worktree (silent); outside (rule shown)
- Transitions:
  - path contains `/.claude/worktrees/` -> silent. Enforced at `claude/hooks/worktree-rule.js:19`.
  - otherwise -> rule shown. Enforced at `claude/hooks/worktree-rule.js:19`.
- Gaps: none found.
- Tests: `claude/hooks/worktree-rule.test.js:77-78`

### guard-asks and the ask gate (ask-policy)

- Where: `claude/hooks/guard-asks.js:7-8` (header), `:33-34` (label check), `:35` (help text), `:45` (block exit); `claude/hooks/ask-policy.json:7` (`only-me` definition), `:11` (`action_reasons`)
- States: policy readable; policy unreadable (allow); ask kind decision; ask kind action; reason label present or absent; allowed; blocked
- Transitions:
  - unreadable policy -> allow (fail open). Documented at `claude/hooks/guard-asks.js:7-8`.
  - action with a reason in `action_reasons` -> allowed. Enforced at `claude/hooks/guard-asks.js:33-34`.
  - action with another reason or with no reason -> blocked with help text, exit 2. Enforced at `claude/hooks/guard-asks.js:33-34`, `:35`, `:45`.
  - decision with any reason -> allowed. Enforced by the label check.
- Gaps:
  - G1 (hooks): An unreadable policy file lets the ask through. Verdict: by design. Evidence: header `claude/hooks/guard-asks.js:7-8`; `claude/hooks/guard-asks.test.js:89`. Task: none (by design, finding #6754).
  - G1 (tooling, P6): The gate checks only the label, so an action ask labelled `only-me` passes for a merge decision, although `claude/hooks/ask-policy.json:7` defines only-me as an in-person step. Verdict: by design. Evidence: probe `probe-ask.js`: "full-stop hand-over (merge decision, only-me): ALLOWED" and "action ask with cost reason: BLOCKED"; pins at `claude/tests/config.test.js:854-858` and `claude/hooks/guard-asks.test.js:17-18`. Task: dotfiles-573 (owner decision, ask #181).
- Tests: `claude/hooks/guard-asks.test.js:17-18`, `:89`; `claude/tests/config.test.js:405-406`, `:854-858`

### lean-prompt isDeferred

- Where: `claude/marketplace/lean-prompt/hooks/register.ts:6-10`; `claude/marketplace/lean-prompt/hooks/hooks.json`
- States: Artifact tool deferred (`isDeferred` true, description kept); other tools unchanged
- Transitions:
  - `tool.describe` for Artifact -> `isDeferred` true. Enforced at `claude/marketplace/lean-prompt/hooks/register.ts:6-10`.
- Gaps:
  - G1: No offline test checks the host effect (Artifact hidden from the first request and reachable by ToolSearch). Verdict: unverified. Evidence: `bun test claude/marketplace/lean-prompt/hooks/register.test.ts` exit 0, 2 pass, with a fake host `on` that shows registration only; a live session was not allowed. Task: dotfiles-747 (dotfiles-260, done, holds the one-time fresh-session check).
- Tests: `claude/marketplace/lean-prompt/hooks/register.test.ts:13-23` (fake `on`)

### codex trust-hooks

- Where: `codex/trust-hooks.js:4-10` (header), `:22` (reviewedHooks), `:27` (hooksToTrust), `:105` (hooks file compared with the reviewed copy), `:121-122` (approve set), `:126-134` (`config/batchWrite` with `expectedVersion: null`), `:138` (exit status), `:139-140` (`finally` closes the server)
- States: hooks file matches the reviewed copy or not; hook pending, trusted or changed; approval written or not; server open or closed
- Transitions:
  - file matches the reviewed copy -> pending hooks join the approve set. Enforced at `codex/trust-hooks.js:105`, `:121-122`.
  - approve set -> `config/batchWrite` approves the hooks with the hashes read from `hooks/list`. Enforced at `codex/trust-hooks.js:126-134`.
  - hooks file changes during `hooks/list` -> the write approves the changed hash. Not enforced.
  - pending hooks or problems -> exit 1. Enforced at `codex/trust-hooks.js:138`.
  - any exit -> server closed. Enforced at `codex/trust-hooks.js:139-140`.
- Gaps:
  - G1: `batchWrite` sends `expectedVersion: null`, so it does not detect a concurrent config write. Verdict: by design. Evidence: `claude/tests/codex-trust-hooks.test.js:98` pins it; the file exits 0, 6 pass. Task: none (by design, finding #6765).
  - G2: A stale origin/main leaves hooks unapproved until the change merges. Verdict: by design. Evidence: header `codex/trust-hooks.js:4-10`; the same run, 6 pass. Task: none (by design, finding #6754).
  - G3 (G-T1): The script compares the hooks file at line 105 and approves later, so a change in that window is approved with the new hash. Verdict: confirmed. Evidence: probe P-GT1 with a fake app-server: race mode prints `"status":0`, the approved hash `sha256:evil`, `fileMatchesReviewedAtEnd` false and "approved 1 hooks"; clean mode approves `sha256:ok`. The real Codex app-server was not started. Task: dotfiles-571.
- Tests: `claude/tests/codex-trust-hooks.test.js` (6 pass). No test covers a change between the check and the write.

### Exit-code and timeout contract per hook

- Where: `claude/settings.json:36` (guard-pr-merge 45 s), `:56` (guard-asks 10 s), `:65-66` (freshen-base 90 s), `:82` (auto-merge 60 s); block exits at `claude/hooks/guard-pr-merge.js:623`, `claude/hooks/guard-git-push.js:274`, `claude/hooks/guard-main-checkout.js:355`, `claude/hooks/guard-runtimes.js:246`, `claude/hooks/guard-asks.js:45`, `claude/hooks/open-items.js:125`
- States: allow (exit 0); non-blocking error (exit 1); block (exit 2); timed out (not tested)
- Transitions:
  - block condition -> exit 2. Enforced at the block exits above.
  - guard-pr-merge error (malformed input, crash) -> exit 2. Enforced at `claude/hooks/guard-pr-merge.js:617-620`.
  - other guard error (malformed input, uncaught) -> exit 1, and the command runs. Those guards have no catch.
  - Edit or Write tool call -> no PreToolUse hook. The matchers at `claude/settings.json:15`, `:41`, `:51`, `:61` cover Bash, `mcp__board__ask_user`, and EnterWorktree, Agent and Task only.
- Gaps:
  - G1 (B21): The same malformed input gets exit 2 from guard-pr-merge and exit 1 from the other guards. Verdict: confirmed. Evidence: guards probe, section "malformed stdin": guard-pr-merge exit 2 ("the guard failed (JSON Parse error ...)"); guard-git-push, guard-main-checkout, guard-runtimes, guard-asks and open-items exit 1. Task: dotfiles-545.
  - G2 (B22): No PreToolUse hook covers Edit or Write. Verdict: confirmed. Evidence: `grep -n '"matcher"' claude/settings.json` shows PreToolUse matchers at `:15`, `:41`, `:51`, `:61` only. Task: dotfiles-545.
  - G3: A hook can run past its timeout: freshen-base ran 107.2 s against 90 s. Verdict: confirmed. Evidence: probe `p-freshen.js F4-slow-calls` (see freshen-base fast-forward G3); the probe measured the run time and did not observe the kill. Task: dotfiles-557.
- Tests: each hook's own test pins its exit codes (for example `claude/hooks/guard-pr-merge.test.js:794`, `claude/hooks/guard-git-push.test.js:402`). No test compares hooks.

### Claude and Codex wiring parity

- Where: `codex/hooks.json:3-19` (two Bash guards, at `:13` and `:17`); `claude/settings.json` (10 hook scripts); `SETUP.md:282-283`
- States: hook wired on Claude only; on both; on Codex only
- Transitions:
  - hook added to `claude/settings.json` -> `codex/hooks.json` does not change. Not enforced: no test compares the two lists.
- Gaps:
  - G1 (B23): `SETUP.md` says Codex runs "the same guards", but Codex wires 2 Bash guards and Claude wires 4 Bash guards plus guard-asks. Verdict: confirmed. Evidence: probe `p-c7.js` (exit 0): Codex lists guard-git-push.js and guard-runtimes.js; Claude lists those two, guard-main-checkout.js, guard-pr-merge.js, and guard-asks.js on `mcp__board__ask_user`. Task: dotfiles-559.
  - G1 (round 2, Codex hook registration): The Codex file omits four guard hooks that the Claude settings register, and no record shows whether the subset is intended. Verdict: unverified. Evidence: `grep -o 'hooks/[a-z-]*\.js'` lists 10 names in `claude/settings.json` and 2 in `codex/hooks.json`; a run cannot show the intent. Task: dotfiles-559.
- Tests: none. The GPT model in `codex/config.example.toml` (round 1 item B24 of this record) is under "Codex example config model" in Tooling.

## Tooling

Machines: 16

### API key state and lock (api-first)

- Where: `claude/bin/api-first.js:138-167`, `:181`, `:186-206`, `:348-349`; `claude/bin/claude-api`; `claude/bin/api-first/claude`
- States: unchecked; ok; invalid; exhausted; refused; unknown; locked; stale lock
- Transitions:
  - unchecked -> ok, invalid, exhausted, refused or unknown: the check runs outside the lock and the result is stored under the lock. Enforced at `claude/bin/api-first.js:348`, `:349`.
  - free -> locked -> free: one decision holds the lock file. Enforced at `claude/bin/api-first.js:186-206` (release at `:204`).
  - locked -> stale -> taken over: a lock older than 2000 ms is removed with no compare. Enforced at `claude/bin/api-first.js:196`.
  - check result by status: 200 -> ok; 401 or 403 -> invalid; 400 or 402 with credit wording -> exhausted; other 4xx except 404, 408, 409 and 429 -> refused; else unknown. Enforced at `claude/bin/api-first.js:138-167`.
- Gaps:
  - G1 (P1): Two runs can check the same key at the same time, so two credit checks run. Verdict: confirmed. Evidence: probe `probe-dup.js` (exit 0): `{"case":"concurrent","checks":2,...}` and `{"case":"sequential","checks":1,...}`. Task: note on dotfiles-425.
  - G2 (P2): A stale-lock takeover can delete a lock that another run has just created. Verdict: confirmed. Evidence: probe `probe-lock.js` with an injected 1500 ms pause: run B enters before run A leaves; the control without the pause shows no overlap. The real window is small. Task: dotfiles-560.
  - G3: A 429 response never starts a backoff. Verdict: by design. Evidence: `claude/bin/api-first.js:165` excludes 429 from refused; `claude/tests/claude-api.test.js:110`; the file exits 0, 47 pass. Task: none (by design, finding #6765).
  - G4: A refused key stays out for up to 8 h. Verdict: by design. Evidence: `claude/bin/api-first.js:58` (MAX_BACKOFF_MS); `claude/tests/claude-api.test.js:224`. Task: none (by design, finding #6765).
  - G5: A run that uses its own apiKeyHelper reports no cost. Verdict: by design. Evidence: `claude/tests/claude-api.test.js:84`, `:93`; `claude/bin/api-first.js:125`. Task: none (by design, finding #6765).
- Tests: `claude/tests/claude-api.test.js` (47 pass)

### Spend ledger (decisions.jsonl)

- Where: `claude/bin/api-first.js:76` (decision log), `:222-229` (cost report), `:458-473` (spend total), `:492` (summary line), `:495-525` (command)
- States: run logged; cost known; cost unknown (not reported yet); cost untracked; logged before costs were recorded
- Transitions:
  - run starts in api mode -> logged. Enforced at `claude/bin/api-first.js:523-542`.
  - unknown -> known: the Stop, StopFailure or SessionEnd hook reports the cost. Enforced at `claude/bin/api-first.js:222-229`.
  - unknown with no cost -> counted as unreported. Enforced at `claude/bin/api-first.js:473`.
- Gaps:
  - G1 (P5): A run with no cost shows only in the all-time total; `--days 30` drops it and the command still exits 0. Verdict: confirmed. Evidence: `api-first.js spend` exit 0 with the row `probe 1 1 $0.0000` and "not reported yet"; `spend --days 30` exit 0 with empty tables. Task: dotfiles-561.
- Tests: `claude/tests/claude-api.test.js:503-562` (all-time totals, including `unreported: 1`). No test uses `--days`.

### claude-experiment preflight and cap

- Where: `claude/bin/experiment.js:43` (`OVER_CAP`), `:66-74` (exit text), `:308-309` (no-usage report and return), `:314` (cap return); `claude/bin/claude-experiment`
- States: preflight; no Messages usage seen; prompt over cap; within cap; run passed; run failed
- Transitions:
  - preflight -> no Messages usage seen: report, then return `OVER_CAP` (exit 3). Enforced at `claude/bin/experiment.js:308-309`.
  - preflight -> prompt tokens over cap: exit 3. Enforced at `claude/bin/experiment.js:314`.
  - preflight -> within cap: the run goes on.
- Gaps:
  - G1: The no-usage branch returns exit 3, the same code as the over-cap branch, and the exit text at lines 66-74 does not list it. Verdict: confirmed. Evidence: probe P-EX3 (a local `Bun.serve` upstream that returns no usage): `PROBE code=3 OVER_CAP=3 lines=["claude-experiment preflight: no Messages usage seen"]`, 1 pass, exit 0. Round 1 rated this by design from `claude/tests/claude-experiment.test.js:232`; round 2 corrects that: the line is an over-cap case. Task: dotfiles-565.
- Tests: `claude/tests/claude-experiment.test.js:230`, `:232` (over-cap cases). No offline test reaches lines 308-309.

### Computer-use session lock and approval log

- Where: `claude/marketplace/computer-use/server/desktop.js:390-413` (`holdLock`, rename at `:406`), `:461` (lost-lock error), `:514` (`logApproval`), `:573-596` (approve path); state files `session.json` and `approvals.log`
- States: free; held by a session (pid); stale (holder dead); taken over; lost by a session
- Transitions:
  - free -> held. Enforced at `claude/marketplace/computer-use/server/desktop.js:390-413`.
  - held by a dead pid -> taken over: rename to an aside name. Enforced at `desktop.js:406`.
  - held by another pid -> lost: a later call fails with "lost the session lock". Enforced at `desktop.js:461`.
  - approval logged, then the lock taken again. Enforced at `desktop.js:586` (log), `:596` (holdLock).
- Gaps:
  - G1 (P3): During a stale-lock takeover two sessions both get "Approved", and one of them then loses the session lock. Verdict: confirmed. Evidence: probe `probe-desk-lock.js` (fake helper, injected pause): "pid 100 request_access: Approved", then "pid 100 open_app ERROR: This session lost the session lock"; "pid 200 request_access: Approved". The control refuses pid 100. Task: note on dotfiles-436.
  - G2 (P4): A session that then loses the lock still logs its approval. Verdict: confirmed. Evidence: the same run: `approvals.log` has 2 lines; the control run has 1 line. Task: note on dotfiles-436.
- Tests: `claude/marketplace/computer-use/server/desktop.test.js` (149 pass; takeover of a dead holder near line 505). No test covers two sessions on one stale lock or an approval after a lost lock.

### Computer-use policy and Stop

- Where: `claude/marketplace/computer-use/server/desktop.js:200` (`policyPaths`), `:208-229` (`readPolicy`), `:233` (`STOP_SIGNALS`), `:240-242` (`panelExit`), `:437-442` (`userStop`), `:447-449` (`noticeStop`); `claude/marketplace/computer-use/policy.json`; `claude/marketplace/computer-use/README.md:22`, `:27-28`, `:47-53`
- States: approval auto; approval dialog; user Stop recorded; user Stop not recorded
- Transitions:
  - no state file -> bundled `policy.json` read -> approval auto. Enforced at `desktop.js:200`, `:208-229`.
  - state file says dialog -> approval dialog. Enforced at `desktop.js:208-229`.
  - panel exit 0 or a signal in `STOP_SIGNALS` -> user Stop. Enforced at `desktop.js:233`, `:240-242`.
  - user Stop -> `user-stopped` file written. Enforced at `desktop.js:437-442`.
- Gaps:
  - G1: `README.md:27-28` says the server uses `dialog` with no file at all, but the code reads the bundled `policy.json` and uses `auto`. Verdict: confirmed. Evidence: probe P-README prints `"approval":"auto"`, exit 0; `desktop.test.js:837` pins the bundled read as auto. Round 1 labelled the README claim "refuted"; round 2 withdrew that label and rates it a document defect. Task: dotfiles-566.
  - G2: The README says a panel kill counts as a Stop and a crash does not, and round 1 found no defined line between them. Verdict: by design. Evidence: `desktop.js:233`, `:240-242` match the README; probe `panel-exit.js` prints `user Stop` for exit 0, SIGTERM, SIGKILL, SIGINT, SIGHUP and SIGQUIT, and a failure for SIGSEGV, SIGABRT, exit 1 and exit 3. Caveat: an OS-sent SIGKILL reads as a user Stop; the real panel was not run. Task: none (by design, finding #6765).
- Tests: `claude/marketplace/computer-use/server/desktop.test.js:100-101` (stop panel), `:837-848` (readPolicy)

### Computer-use input gesture (helper)

- Where: `claude/marketplace/computer-use/server/helper.swift:223-231` (`post`), `:264` (drag button down), `:271` (drag button up), `:349-352` (overlay stop), `:392-395` (`drag` command)
- States: idle; gesture running (button or key down); gesture ended (up posted); stop requested; stopped (exit 4); overlay stopped (exit 0, stop file written)
- Transitions:
  - any event with the stop file present -> exit 4 before the event is posted. Enforced at `helper.swift:223-231`.
  - drag: button down (`:264`) -> moves -> button up (`:271`). A stop between the two exits with the button down; nothing releases it on exit.
  - overlay Stop button or Esc -> stop file written, exit 0. Enforced at `helper.swift:349-352`.
- Gaps:
  - G1: A stop during a drag exits 4 after button-down and before button-up, so the button stays down. Verdict: confirmed. Evidence: probe P-HELPER (fake sink in a scratch copy, real screen not used): `POST 5`, `POST 1`, `stopped by the user`, exit 4, and no `POST 2`; `swiftc -typecheck` exit 0. Round 1 also named click and key; those were read only, not run. Task: note on dotfiles-436.
  - G2: The helper has no test. Verdict: confirmed. Evidence: `grep -rl helper.swift claude/tests claude/marketplace --include=*.test.js` finds no file; `desktop.test.js` uses a fake helper. Task: note on dotfiles-436.
- Tests: none found

### Full-stop hold and release

- Where: `claude/skills/full-stop/SKILL.md:20`, `:26`, `:59`, `:66`, `:71-72`; `claude/hooks/auto-merge.js`
- States: working; draft (held); ready; auto-merge armed; auto-merge off; merged on the owner's word; blocked
- Transitions:
  - ready -> draft: the refused-draft fallback runs `gh pr ready <n> --undo`. Stated at `claude/skills/full-stop/SKILL.md:20`.
  - draft -> ready -> merged: the owner's merge word runs `gh pr ready <n>`, then the merge. Stated at `claude/skills/full-stop/SKILL.md:71-72`.
  - PR created as a draft -> the hook skips it ("skipped, it is a draft"). Enforced at `claude/hooks/auto-merge.js` (draft check).
  - PR created, not a draft, checks pending -> auto-merge armed ("auto-merge is on (merge commit)"). Enforced at `claude/hooks/auto-merge.js`.
  - PR created, not a draft, can merge now -> the hook skips it.
  - working -> blocked: the skill asks with what blocks it. Stated at `claude/skills/full-stop/SKILL.md:59`, `:66`.
- Gaps:
  - G1 (P7): Line 26 of the skill forbids `gh pr ready`, while lines 20 and 71-72 require it. Verdict: confirmed. Evidence: `grep -n -F 'gh pr ready' claude/skills/full-stop/SKILL.md` prints lines 20, 26, 71 and 72, exit 0. Task: dotfiles-562.
  - G2: Auto-merge arms on a non-draft PR before the owner's word, until the agent's next step. Verdict: by design. Evidence: `claude/hooks/auto-merge.test.js:43-50`, `:89` pin arming on `gh pr create` output; the file exits 0, 41 pass. Task: none (by design, finding #6765; the arming itself is noted on dotfiles-434).
- Tests: `claude/hooks/auto-merge.test.js` (41 pass); `claude/tests/config.test.js:830-866` (full-stop text pins)

### ui-climb climb, exit codes and wait

- Where: `claude/skills/ui-climb/SKILL.md:19` (exit codes), `:223-225` (PR step), `:227-231` (ask), `:238-247` (exit-4 wait); `claude/factory/ui/run.js:158-185` (reference capture retries)
- States: round running; pass (0); fail (1); error (2); budget spent (3); provisional pass (4); waiting for a re-run; asked
- Transitions:
  - reference capture fails -> retried up to `config.referenceCapture.tries` with a doubling wait. Enforced at `claude/factory/ui/run.js:158-185`.
  - exit 4 -> the agent waits, then reruns the round on the same commit. Stated at `claude/skills/ui-climb/SKILL.md:241`, `:247`; no count or duration is given.
  - reference still missing -> ask the owner. Stated at `claude/skills/ui-climb/SKILL.md:227-231`.
  - PR opened and held as a draft. Stated at `claude/skills/ui-climb/SKILL.md:223-225`.
- Gaps:
  - G1: Step 4 opens a non-draft PR, so auto-merge could arm before the owner answers. Verdict: refuted. Evidence: `claude/skills/ui-climb/SKILL.md:223-225` says "held as a draft as the `full-stop` skill says"; `claude/tests/config.test.js:865` pins that text. Task: none (refuted, finding #6765).
  - G2: Ask option labels can exceed the 60-character `ask_user` limit. Verdict: refuted. Evidence: round 1: the labels at `claude/skills/ui-climb/SKILL.md:139-150` have 33, 11, 33, 46 and 13 characters; the schema sets `maxLength` 60 per option. Round 2 did not rerun it. Task: none (refuted, finding #6765).
  - G3: The exit-4 re-run wait has no bound in the skill text. Verdict: confirmed. Evidence: probe P-UI counts 0 duration words in lines 238-247 (grep exit 1); the factory's own retry is bounded (`claude/factory/ui/run.js:158-185`). Task: dotfiles-567.
  - G4: Exit 4 means a provisional pass with a reference missing. Verdict: by design. Evidence: `claude/factory/ui/ui.test.js:1409` pins exit 4; the test "a reference that does not capture is named" exits 0, 1 pass. Task: none (by design, finding #6765).
- Tests: `claude/factory/ui/ui.test.js:1374-1414`; `claude/tests/config.test.js:865`, `:1217-1273`

### Blocked state (task and ask)

- Where: `claude/CLAUDE.md:71`; `claude/skills/full-stop/SKILL.md:59`, `:66`; `claude/skills/ui-climb/SKILL.md:229`
- States: task open; ask sent; ask accepted; task blocked; ask answered
- Transitions:
  - ask sent -> task blocked when the ask is accepted. Stated at `claude/CLAUDE.md:71`.
  - ask sent -> task blocked right after the ask. Stated at `claude/skills/full-stop/SKILL.md:59`, `:66`.
  - ask sent -> task blocked until the answer. Stated at `claude/skills/ui-climb/SKILL.md:229`.
- Gaps:
  - G1 (P8): Three documents give three different times for a task to become `blocked`. Verdict: confirmed. Evidence: `grep -n -E 'blocked|accepted'` on the three files prints `claude/CLAUDE.md:71`, full-stop lines 59 and 66, and ui-climb line 229, exit 0. Task: dotfiles-563.
- Tests: none found

### Review effort pointer

- Where: `claude/CLAUDE.md:86`; `claude/skills/diff-review/SKILL.md`; `claude/agents/reviewer.md:5`
- States: effort set on the reviewer agent; effort named in the skill the rule points to
- Transitions:
  - `claude/CLAUDE.md:86` names the `diff-review` skill for the review effort -> the skill has no effort text. Not enforced; `claude/agents/reviewer.md:5` sets `effort: high`.
- Gaps:
  - G1 (P9): The pointer at `claude/CLAUDE.md:86` names a skill that sets no effort. Verdict: confirmed. Evidence: `grep -c -i effort claude/skills/diff-review/SKILL.md` prints 0 (exit 1); line 5 of `claude/agents/reviewer.md` is `effort: high`. Task: dotfiles-564.
- Tests: `claude/tests/config.test.js:87` (expected `effort: "high"`), `:1039` (pins the pointer text)

### No-session-env

- Where: `claude/bin/no-session-env`; `claude/bin/session-env.js`
- States: session variables present; removed; bun missing (fail closed)
- Transitions:
  - environment -> list of session names. Enforced at `claude/bin/session-env.js:6-8`.
  - list -> unset and exec. Enforced at `claude/bin/no-session-env:15-21`.
  - bun missing -> failure, no command run. Enforced at `claude/bin/no-session-env:13`.
- Gaps: none found.
- Tests: `claude/tests/no-session-env.test.js:87-91` (fail-closed case; the file exits 0, 9 pass)

### Codex example config model

- Where: `codex/config.example.toml:1`; `codex/AGENTS.md:6`; `claude/tests/config.test.js:936-939` (AGENTS.md pin), `:1416-1440` (models scan, `claude/` folders only)
- States: example model is a Claude model; example model is a GPT model
- Transitions:
  - example file copied unchanged -> the active Codex config holds the GPT model. Not enforced.
- Gaps:
  - G1 (hooks item B24): `codex/config.example.toml:1` sets `model = "gpt-5.4"`, which breaks the Claude-only rule. Verdict: confirmed. Evidence: probe P-CFG: `grep -n '^model' codex/config.example.toml` prints `1:model = "gpt-5.4"`; `bun test claude/tests/config.test.js` still exits 0, 134 pass, because the models scan covers `claude/` only. Task: dotfiles-572.
  - G2: `codex/AGENTS.md:6` tells the agent to stop and ask instead of running Codex. Verdict: by design. Evidence: `claude/tests/config.test.js:936-939` pins it. Task: none (by design, finding #6765).
- Tests: `claude/tests/config.test.js:936-939`, `:1416-1440`

### Live suite session and teardown

- Where: `claude/tests/lib/live.js:217-218` (`noteOutside`), `:220-222` (`noteRefused`), `:243-250` (refused branches and catch), `:254`, `:311-324` (teardown; `stopLeftovers` at `:316`, `removeSessionArtifacts` at `:317`); `claude/tests/lib/cleanup.js:9`, `:23`
- States: session with cwd outside the suite root; recorded in `outside[]`; session failed (timeout or error); teardown run; leftovers stopped; transcript removed
- Transitions:
  - session returns output -> recorded. Enforced at `claude/tests/lib/live.js:254`.
  - session refused -> recorded. Enforced at `claude/tests/lib/live.js:222`.
  - session throws (timeout or error) -> not recorded. Not enforced: the catch at `:243-250` does not call `noteOutside`.
  - teardown -> `stopLeftovers`, then `removeSessionArtifacts`. Enforced at `claude/tests/lib/live.js:311-324`.
  - `stopLeftovers` throws -> `removeSessionArtifacts` is skipped. Not enforced.
- Gaps:
  - G-L1: A session with cwd outside the root that times out is not recorded, so its transcript stays after teardown. Verdict: confirmed. Evidence: probe P-GL1 (fake claude): `"sessionError":"Process timeout after 1000 ms..."`, `"teardownError":"none"`, `"transcriptRemains":true`, exit 0; the control with `L_MODE=complete` prints `"transcriptRemains":false`. Task: note on dotfiles-544.
  - G-L2: If `stopLeftovers` throws, teardown skips the artifact removal, so transcripts stay. Verdict: confirmed. Evidence: probe P-GL2 (fault injected in a scratch copy): `"teardownError":"injected stopLeftovers failure"`, `"transcriptRemains":true`, exit 0. Limit: no real `stopLeftovers` failure was produced. Task: note on dotfiles-544.
- Tests: `claude/tests/harness.test.js:181-187` (cleanup after the live-policy failure modes, cwd inside the root only; not run in the audit because it starts live children)

### runProcess timeout settle

- Where: `claude/tests/lib/process.js:96-115` (`stopLeftovers`), `:135-227` (`runProcess`), `:161-168` (kill helpers), `:171-173` (timer), `:218` (`child.on("close")`)
- States: running; timeout fired; descendants and group killed; settled (resolved or rejected)
- Transitions:
  - timeout fires -> SIGKILL to the tracked descendants and to the process group. Enforced at `claude/tests/lib/process.js:161-173`.
  - child exits -> settle on `close`. Enforced at `claude/tests/lib/process.js:218`. `close` waits until stdout closes.
- Gaps:
  - G-P1: A grandchild that calls `setsid`, is reparented and holds stdout open delays the rejection until it exits. Verdict: confirmed. Evidence: probe P-GP1 prints `REJECTED after 12024 ms: Process timeout after 2000 ms: sh`, exit 0; the grandchild is dead afterwards. Task: dotfiles-569.
- Tests: `claude/tests/lib/process.test.js:102-131` (a descendant under the intermediate process). None for a grandchild that holds stdout.

### Guidance symlink chain

- Where: `claude/tests/lib/guidance.js:14` (`canonical`), `:19-31` (`guidanceTargets`; chain loop at `:22-25`), `:101` (`scoreGuidance`); used by `claude/tests/live-dispatch.test.js:9`, `:111-112`
- States: path is a file; path is a symlink; chain resolves to a file; chain forms a cycle
- Transitions:
  - symlink -> resolve its target and repeat while the target is a symlink. Enforced at `claude/tests/lib/guidance.js:22-25`. No cycle guard.
- Gaps:
  - G-G1: A symlink cycle makes `guidanceTargets` loop without end. Verdict: confirmed. Evidence: probe P-GG1: a chain of one link prints `RETURNED spellings= 2`, exit 0; the `loop-a` to `loop-b` cycle never returns and exits 142 under a 5 s alarm. Severity is low: the code is a live test helper. Task: dotfiles-570.
- Tests: none found

### block-installs hook input

- Where: `claude/tests/lib/hooks/block-installs.js:1-2` (header), `:4` (download pattern), `:51` (`JSON.parse` of stdin), `:54-57` (check and exit 2); used by `claude/tests/lib/live.js:191` and `claude/factory/bench/runner.js:15`
- States: input parsed; input malformed or empty (uncaught); install or download blocked; other call allowed
- Transitions:
  - malformed or empty stdin -> uncaught error at `:51` -> exit 1, a non-blocking hook error, so the call runs. Not enforced.
  - install or download command -> exit 2, blocked. Enforced at `claude/tests/lib/hooks/block-installs.js:54-57`.
  - other call -> exit 0.
- Gaps:
  - G-B1: Malformed stdin exits 1, so the call proceeds, while the header says exit 2 blocks. Verdict: confirmed. Evidence: probe P-BI: `printf 'not json'` into the hook exits 1 with a stack trace at line 51; empty stdin exits 1; `npm install left-pad` exits 2; `ls` exits 0. Severity is lower: the hook runs only in live fixtures and the bench runner. Task: note on dotfiles-545.
- Tests: `claude/tests/lib/hooks.test.js:9-28` (valid inputs only)

## Factory

Machines: 51

Sources: the `e3-factory-a_*` and `r3-factory-a_*` records (friction, scoring, review, weekly, `lib`) and the `e4-factory-b_*` and `r4-factory-b_*` records (UI climb, bench, audit, metrics) of the audit. The raw records are not in this repository; task dotfiles-748 names their place. In evidence lines, `e3 §N`, `r3 §N`, `e4 Pn` and `r4 <label>` name a block of that track's probes file. Probe files exist only in the audit's scratch copy. A gap marked "(working note)" comes from an explorer's notes file; no probe ran on it.

### Friction cursor

- Where: `claude/factory/friction/cli.js:358`, `:359`, `:434`, `:436-438`, `:471`
- States: unread window; cursor advanced
- Transitions:
  - run start -> window: the run reads the record file and starts at the cursor. Enforced at `claude/factory/friction/cli.js:358` (window start) and `:359` (record read).
  - held or skipped turns pull the resume point back. Enforced at `claude/factory/friction/cli.js:434` and `:436-438`.
  - unread window -> cursor advanced: the run end writes the cursor. Enforced at `claude/factory/friction/cli.js:471`. A crash keeps the old cursor.
- Gaps:
  - G1 (C4a): The spend cap is per run, with no daily cap. Verdict: by design. Evidence: `claude/factory/friction/friction.test.js:367-376` pins the per-run cap (same gap as "Judge call spend" G2). Task: note on dotfiles-443 (item 2, daily total: owner decision); by design in finding #6783.
- Tests: `claude/factory/friction/friction.test.js:295` (exit 0; the prior verdict "cursor lost after a crash" is refuted by it), `:333-351` (cursor hold).

### Friction turn states

- Where: `claude/factory/friction/turns.js:26`, `:42-89`, `:95-147`, `:208`; `claude/factory/friction/cli.js:86-117`
- States: open; held; filed-feedback (skipped); scored; below minimum; judged; judge error
- Transitions:
  - open -> held: the turn is not complete and is recent. `newTurn` at `claude/factory/friction/turns.js:26`; hold at `claude/factory/friction/cli.js:93-95`. The 6 h rule is from the prior record.
  - turn already filed feedback -> skipped. Enforced at `claude/factory/friction/cli.js:97-98`.
  - scored -> below minimum: score under `--min-score`. Location not re-read.
  - judge error -> judged again, until 2 errors. Enforced at `claude/factory/friction/cli.js:445`.
- Gaps:
  - G1: Score weights are hand-set in code. Verdict: unverified. Evidence: code read only, `claude/factory/friction/turns.js:208`. Task: none (no work, finding #6783: a constant, no state or failing input found).
  - CX-steer (working note): A second user message inside one Codex turn is dropped from the digest. Verdict: unverified. Evidence: code read only, `claude/factory/friction/turns.js:138-143`. Task: dotfiles-742.
  - (working note): A Codex turn's `complete` flag is never reset to false, unlike a Claude turn. Verdict: unverified. Evidence: code read only, `claude/factory/friction/turns.js:111-112` against `:61`. Task: dotfiles-742.
- Tests: `claude/factory/friction/friction.test.js:333-351` (held turn), `:353-364` (never-ended turn judged at 7 h), `:378-387` (quiet period), `:389-397` (two judge errors, then left alone). Not run by name.

### Friction filing record

- Where: `claude/factory/friction/cli.js:288-311`, `:428`, `:467`, `:469`
- States: pending; board-filed (no record yet); filed (recorded); file-error; given up
- Transitions:
  - pending -> board-filed: the board accepts the feedback. Enforced at `claude/factory/friction/cli.js:303`, in the file loop at `:428`.
  - board-filed -> filed: the record is appended. Enforced at `claude/factory/friction/cli.js:308`.
  - file-error -> pending: retried on the next run. Enforced at `claude/factory/friction/cli.js:428`.
  - file-error three times -> given up. Pinned by `claude/factory/friction/friction.test.js:311`.
- Gaps:
  - G1 (FR-crash): A crash between the board accept and the record append makes the next run file again. Verdict: confirmed. Evidence: e3 §3, `probe-fr-crash.test.js`, exit 0, 1 pass; first run killed by SIGKILL, then `filings after rerun= 2`. Task: dotfiles-577.
  - G2: A given-up filing leaves no final record. Verdict: by design. Evidence: `claude/factory/friction/friction.test.js:311` (exit 0, 1 pass). Task: none (by design, finding #6783).
  - (working note): A crash between the judge call and the judged-record append at `:467` judges the turn again. Verdict: unverified. Evidence: code read only, `claude/factory/friction/cli.js:467`. Task: dotfiles-742.
- Tests: `claude/factory/friction/friction.test.js:259-293` (filed once), `:295` (exit 0), `:311` (exit 0).

### Judge call spend

- Where: `claude/factory/lib/claude.js:38-42`, `:65-113`; `claude/factory/friction/cli.js:390`, `:436`, `:448-457`
- States: attempt; refused; retried; succeeded; failed with cost; run budget spent (per run)
- Transitions:
  - attempt -> refused -> retried: a refused attempt is retried. Enforced at `claude/factory/lib/claude.js:81`.
  - retried -> succeeded: the cost is the spent amount plus the final call. Enforced at `claude/factory/lib/claude.js:106`.
  - retried -> failed: a `ClaudeCallError` is thrown with `costUSD`. Class at `claude/factory/lib/claude.js:38`.
  - failed call -> budget: friction uses `error.costUSD`, or the budget when absent. Enforced at `claude/factory/friction/cli.js:453-454`.
  - run start -> run budget: `spent` starts at 0 for each run. Enforced at `claude/factory/friction/cli.js:390`; cap check at `:436`.
- Gaps:
  - G1 (J-refused): When the final attempt fails after a refusal, `error.costUSD` leaves out the refused attempt's spend. Verdict: confirmed. Evidence: e3 §2, `probe-refused.test.js`, exit 0, 2 pass; `error.costUSD = 0.02` against `control costUSD = 0.04`. Task: dotfiles-576.
  - G2: The run budget resets on each run, so several runs in one day can spend more than one cap. Verdict: by design. Evidence: `claude/factory/friction/friction.test.js:367-376` pins the per-run cap; r3 §9, `bun test -t "run budget"`, exit 0, 1 pass. Task: note on dotfiles-443 (item 2, daily total: owner decision); by design in finding #6783.
  - FR-digest (working note): A local digest error inside the judge `try` counts as a judge error and as a full budget spend. Verdict: unverified. Evidence: code read only, `claude/factory/friction/cli.js:448-457`. Task: dotfiles-742.
  - (working note): A judge timeout reports `costUSD` null, and a `runTask` timeout reports 0. Verdict: by design. Evidence: `claude/factory/lib/lib.test.js:444` and `:630` pin both; the notes call the two treatments inconsistent. Task: none (by design, finding #6835).
- Tests: `claude/factory/friction/friction.test.js:367-376`; `claude/factory/lib/lib.test.js:444` (by name). `claude/factory/lib/lib.test.js:459` covers two refusals but asserts no cost.

### Friction record file (JSON Lines)

- Where: `claude/factory/lib/state.js:26-36` (`readJsonl`); `claude/factory/friction/cli.js:359`, `:373`
- States: intact; torn last line; every reader stopped
- Transitions:
  - intact -> torn: a crash leaves a partial last line. The read throws `<path>:<line>: malformed JSON line` at `claude/factory/lib/state.js:26-36`.
  - torn -> stopped: every friction run stops, dry runs too. The read at `claude/factory/friction/cli.js:359` is before the dry-run return at `:373`.
  - stopped -> intact: no code path. Neither file has a skip, repair or truncate step.
- Gaps:
  - G1 (J-torn): One torn last line stops every friction run, and no code path leaves that state. Verdict: confirmed. Evidence: r3 §16, probe `r2-torn-jsonl`, exit 0, 1 pass; `friction.jsonl:3: malformed JSON line`. Task: dotfiles-575.
- Tests: `claude/factory/lib/lib.test.js:143-157` pins the throw on a malformed line. No suite test covers a torn last line in a friction run.

### Board feature probe

- Where: `claude/factory/friction/cli.js:259-262` (`boardFilesCapture`), `:380-387`
- States: feature present; feature missing
- Transitions:
  - run start -> feature missing: the board help text lacks `--source`. Probe at `claude/factory/friction/cli.js:259`.
  - feature missing -> nothing judged; the cursor is kept. Enforced at `claude/factory/friction/cli.js:380-387`.
- Gaps:
  - G1: No board feature means nothing is judged or filed, and turns older than `--max-age-hours` are then never judged. Verdict: by design. Evidence: `claude/factory/friction/friction.test.js:399` (exit 0, 1 pass). Task: none (by design, finding #6783).
- Tests: `claude/factory/friction/friction.test.js:399`.

### Match set

- Where: `claude/factory/friction/cli.js:151-160` (`unresolvedItems`), `:400-405`; `claude/factory/board/cli.js:55-62` (`checkFeedback`)
- States: open items listed; list failed; full page
- Transitions:
  - list -> matched: open items and this run's filings are matched. Enforced at `claude/factory/friction/cli.js:152`.
  - list failed -> the run matches only its own filings and counts an error. Enforced at `claude/factory/friction/cli.js:400-405`.
  - full page (1000 rows) -> accepted with no warning. The board's own reader throws at a full page (`claude/factory/board/cli.js:55-62`).
- Gaps:
  - G1 (C4c): `board ls --limit 1000` has no full-page check, so open items past the first 1000 rows are missed without a warning. Verdict: confirmed. Evidence: r3 §2, probe `r2-friction-unresolved`, exit 0, 1 pass; `UNRESOLVED 1000`, no warning. Task: note on dotfiles-440.
- Tests: `claude/factory/friction/friction.test.js:548-557` (failed list), `:559-571` (cap of 200 known items). None for a full page.

### Evolve item states

- Where: `claude/factory/evolve/cli.js:56-72`, `:75-101`, `:113-117`, `:149`, `:154`
- States: routed open; fixed; not fixed (the working notes add: untriaged; declined but reported)
- Transitions:
  - routed open -> fixed: the owner task is done and its `updatedAt` is inside the window. Enforced at `claude/factory/evolve/cli.js:117`.
  - `updatedAt` comes from the task's `updated_at`. Owners are built at `claude/factory/evolve/cli.js:56-72`.
  - full page of 1000 items -> error reported, exit 1. Enforced at `claude/factory/evolve/cli.js:154`.
- Gaps:
  - G1 (C11): `updatedAt` stands in for the fix time, so a later edit to a done task counts as a fix. Verdict: confirmed. Evidence: r3 §8, probe `r2-evolve-fixed`, exit 0, 1 pass; a task done in October and edited on 13 November gives `"fixed":1`. Task: note on dotfiles-443 (item 6).
  - E-dropped (working note): A routed item whose owner task is dropped is neither routed open nor fixed, so it leaves the report. Verdict: unverified. Evidence: code read only, `claude/factory/evolve/cli.js:113-117`; no test has a dropped owner. Task: dotfiles-742.
  - (working note): Evolve has no paging, so items past the first 1000 are never read. Verdict: by design. Evidence: `claude/factory/evolve/evolve.test.js:185-189` pins the full-page error. Task: none (by design, finding #6835).
- Tests: `claude/factory/evolve/evolve.test.js:39`, `:159-168`, `:185`. None covers a later edit to a done task.

### Setup registry

- Where: `claude/factory/setups/cli.js:25`, `:40-74`; `claude/factory/evolve/cli.js:176`
- States: registered; invalid; required id missing; removed id (labelled)
- Transitions:
  - entry -> invalid: checked in `problems()`. Enforced at `claude/factory/setups/cli.js:40-74`.
  - required id absent -> problem. Enforced at `claude/factory/setups/cli.js:25` (`REQUIRED`).
  - removed id -> labelled `(not in setups.toml)`. Enforced at `claude/factory/evolve/cli.js:176`.
- Gaps:
  - G1 (C12): Removing a setup id leaves old filings whose `about` names no setup. Verdict: by design. Evidence: `claude/factory/evolve/evolve.test.js:84` pins the label; `evolve.test.js` exit 0, 9 pass. Task: none (by design, finding #6783).
  - (working note): The list mode prints the setups even when the registry has problems. Verdict: unverified. Evidence: code read only, `claude/factory/setups/cli.js:131-136`; not pinned. Task: dotfiles-742.
  - (working note): `owner.board` is not checked against the existing boards. Verdict: unverified. Evidence: code read only; the notes call it by design and cite no test. Task: dotfiles-742.
- Tests: `claude/factory/evolve/evolve.test.js:84`; `claude/factory/setups/setups.test.js` (6 pass; needs a `.git` folder).

### Proposal publish and retry

- Where: `claude/factory/scoring/propose.js:45`, `:287`, `:362-372`; `claude/factory/lib/proposal.js:121-129`, `:150`; `claude/factory/board/proposal.js:32`, `:303-312`
- States: candidate; branch pushed; PR created; proposed; error (pushed, no PR URL); killed (no record); retryable
- Transitions:
  - candidate -> branch pushed -> PR created: publish with `onPushed`. Enforced at `claude/factory/scoring/propose.js:287`.
  - gh exits 1 after it created the PR -> error. Enforced at `claude/factory/scoring/propose.js:366-371`.
  - error or dry-run -> retryable. Set at `claude/factory/lib/proposal.js:150` (`RETRYABLE`).
  - retry -> new branch. By design; pinned by `claude/factory/scoring/propose.test.js:310`.
  - board proposal, later repository fails -> partly-proposed, not retried. By design (`claude/factory/board/proposal.js:308-311`).
- Gaps:
  - G1 (C1): gh creates the PR, then exits 1; the retry opens a second PR for one proposal. Verdict: confirmed. Evidence: e3 §11, `probe-propose.test.js`, exit 0, 7 pass; `status=error pushed=true ... prUrl=null`, then `gh creates total=2`. Task: dotfiles-584.
  - G2 (P2): SIGKILL after gh creates the PR leaves no record and one remote branch; a rerun opens a second PR. Verdict: confirmed. Evidence: e3 §11, same probe; `records=0 gh creates=1`, then `rerun ... records=1 ... gh creates=2`. Task: dotfiles-585.
  - G3 (C2): `RECENT_DAYS = 30` is defined in two files, and only the board copy is pinned by a test. Verdict: confirmed. Evidence: r3 §7; `claude/factory/scoring/propose.js:45` set to 7 gives exit 0, 270 pass; `claude/factory/board/proposal.js:32` set to 7 gives exit 1, 1 fail. Task: note on dotfiles-443.
  - (working note): In a board proposal, a publish failure on the first repository throws and leaves a pushed branch with no PR. Verdict: unverified. Evidence: code read only, `claude/factory/board/proposal.js:310`; `claude/factory/board/board.test.js` does not pin it. Task: dotfiles-742.
  - (working note): Concurrent propose runs and a torn `proposals.jsonl` are not pinned. Verdict: unverified. Evidence: code read only; the branch stamp at `claude/factory/lib/proposal.js:95` is per second. Task: dotfiles-742.
- Tests: `claude/factory/scoring/propose.test.js:310` (exit 0, by name); a scratch probe copy of the proposal tests (25 pass, not in the tree); `claude/factory/board/board.test.js:422-433` (partly-proposed).

### Score record identity

- Where: `claude/factory/scoring/score.js:36`, `:73`, `:83`, `:271`, `:387`, `:401`; `claude/factory/scoring/rubric.js`
- States: eligible; quiet period; judged; judge error; ineligible
- Transitions:
  - eligible -> judged: the record is appended. Enforced at `claude/factory/scoring/score.js:387` and `:401`.
  - judge error -> retried until 2 errors. Enforced at `claude/factory/scoring/score.js:73` (`MAX_JUDGE_ERRORS`).
  - record key `sessionId:sha:rubricVersion`. Enforced at `claude/factory/scoring/score.js:83`.
  - quiet period of 30 minutes. Set at `claude/factory/scoring/score.js:36`.
- Gaps:
  - G1 (S1): Two score runs at once both judge the same session. Verdict: confirmed. Evidence: e3 §10, `probe-score.test.js`, exit 0, 2 pass; `concurrent scores.jsonl lines = 2 judge calls logged = 2`; control 1 and 1. Task: dotfiles-583.
  - G2: A judge prompt change without a version bump is not rescored. Verdict: refuted. Evidence: a changed prompt at `claude/factory/scoring/score.js:151` fails `claude/factory/scoring/score.test.js:72-79` (exit 1, 1 fail). Task: none (refuted, finding #6783).
  - (working note): A torn line in `scores.jsonl` stops the score run. Verdict: unverified. Evidence: code read only, `claude/factory/scoring/score.js:271` reads outside a `try`; not pinned. Task: dotfiles-742.
  - (working note): A crash between the judge call and the append leaves the spend unrecorded, and the session is judged again. Verdict: unverified. Evidence: code read only, `claude/factory/scoring/score.js:387`; not pinned. Task: dotfiles-742.
  - (working note): A session with no `endedAt` stays active and is never judged. Verdict: unverified. Evidence: code read only, `claude/factory/scoring/score.js:80`; not pinned. Task: dotfiles-742.
- Tests: `claude/factory/scoring/score.test.js:72-79`, `:301` (by name), `:321-342` (two errors, then skipped until `--retry-errors`).

### Rubric version gate

- Where: `claude/factory/scoring/rubric.json`; `claude/factory/scoring/rubric.js:3-6`; `claude/factory/scoring/digest.js:15`
- States: current version; older version (excluded from proposals)
- Transitions:
  - version bump -> older records excluded. The rule is at `claude/factory/scoring/rubric.js:3-6` (manual bump); the enforcement point was not re-read.
  - digest output size -> not pinned by any test. Limit `OUTPUT_CHARS` at `claude/factory/scoring/digest.js:15`.
- Gaps:
  - G1 (C5): Changing the digest output size passes every scoring test, so the output is not pinned. Verdict: confirmed. Evidence: r3 §6; `OUTPUT_CHARS` 300 set to 100; `bun test claude/factory/scoring`, exit 0, 270 pass, 0 fail. Task: note on dotfiles-441.
- Tests: none ties digest or detector output to the rubric version. `rubric.json` is at version 14 (commit 69cb566). Round 1 once saw 26 failures in both copies; they did not reproduce, and finding #6783 gives the temp-folder case of dotfiles-555 as the cause.

### Review title list

- Where: `claude/factory/review/cli.js:27`, `:145-149` (`openTitles`); `claude/factory/board/cli.js:55-62`
- States: titles listed; titles cut; full page
- Transitions:
  - board list (`ls --json --limit 1000`) -> closed filtered out -> first 200 titles kept. Enforced at `claude/factory/review/cli.js:145-149`.
  - full page -> no warning. The board's feedback reader throws at a full page (`claude/factory/board/cli.js:55-62`).
- Gaps:
  - G1 (C6): Duplicates beyond the first 200 open titles are not seen, and no warning is given. Verdict: confirmed. Evidence: r3 §1, probe `r2-review-titles`, exit 0, 1 pass; `TITLES 200 FIRST Task 1 HAS 201 false HAS 1000 false`. Task: note on dotfiles-440.
  - R5 (working note): The slice assumes the board lists the newest tasks first, and the board promises no order. Verdict: unverified. Evidence: code read only, `claude/factory/review/cli.js:148` against the comment at `claude/factory/board/cli.js:58`. Task: dotfiles-743.
- Tests: none found for the cap.

### Board snapshot

- Where: `claude/factory/board/cli.js:65-73`, `:122-128`; `claude/factory/board/proposal.js:72-86`
- States: fresh; failed read; empty
- Transitions:
  - read fails -> snapshot with errors. Init (`feedback: null, errors: []`) at `claude/factory/board/cli.js:65`; error capture at `:73`.
  - snapshot with errors -> exit 1. Enforced at `claude/factory/board/cli.js:128`.
  - proposal reads `snapshot.feedback ?? []` and does not read `errors`. Enforced at `claude/factory/board/proposal.js:75`.
- Gaps:
  - G1 (B1): A failed board read gives the same note as an empty board. Verdict: confirmed. Evidence: e3 §9, `probe-b1.test.js`, exit 0, 1 pass; both give `0 open feedback tasks (0 new); signals: none  nothing to propose`; `error text in result = false`. Task: dotfiles-582.
  - (working note): The run deletes the old snapshot before it collects, so no snapshot file exists for that time. Verdict: unverified. Evidence: code read only, `claude/factory/board/cli.js:122`, `:124`. Task: dotfiles-743.
- Tests: `claude/factory/board/board.test.js:128-136` (a statistics failure keeps the feedback). No test has `feedback` null. The prior stale-snapshot check was not re-run.

### Pid lock file

- Where: `claude/factory/lib/state.js:53-75` (`acquireLock`)
- States: free; held by a live pid; held by pid 1 (EPERM); stale; empty; taken over
- Transitions:
  - free -> held: an exclusive create writes the pid. Enforced at `claude/factory/lib/state.js:57`.
  - live pid -> refused. `process.kill(pid, 0)` succeeds at `claude/factory/lib/state.js:65-66`.
  - EPERM (a pid that is not ours, such as pid 1) -> refused. Enforced at `claude/factory/lib/state.js:68`.
  - ESRCH (dead pid) -> stale file removed -> retried. Enforced at `claude/factory/lib/state.js:69-72`.
  - empty file -> removed and taken over, because `Number("")` is 0. Enforced at `claude/factory/lib/state.js:62-72`.
- Gaps:
  - G1 (L1): Stale takeover is not atomic: several processes take one stale lock in one round. Verdict: confirmed. Evidence: e3 §4, `probe-lock.test.js`, exit 1, 1 fail (one-winner check); `winners per round = 4,2,2` of 50 processes. Task: dotfiles-578.
  - G2 (C13, L442): A lock that names pid 1 is never taken over, even when 30 days old. Verdict: confirmed. Evidence: r3 §4, probe `r2-pid-lock`, exit 0, 2 pass; e3 §5, `pid-1 lock results [false,false,false]`. Task: note on dotfiles-442.
  - G3: An empty lock file is taken over, so a writer between its create and its pid write can lose a live lock. Verdict: confirmed (takeover only; the race with a live writer is unverified). Evidence: r3 §3, probe `r2-lock`, exit 0, 1 pass; `ACQUIRED: true`. Task: note on dotfiles-158.
- Tests: round 2 found no suite test of takeover. The round-1 working notes cite `claude/factory/weekly/weekly.test.js:203-210` (pid 1 held at `:207-209`) and `:212-218` (live lock exit 3 at `:215`, stale pid taken at `:217`).

### LaunchAgent install and uninstall

- Where: `claude/factory/lib/launchd.js:73-82` (`installAgent`), `:87-90` (`uninstallAgent`), `:93-95` (`agentStatus`); `claude/factory/weekly/cli.js:214`; `claude/factory/friction/cli.js:513-521`, `:523-527`
- States: no plist; plist written; loaded; not loaded; removed
- Transitions:
  - install: bootout (result ignored), write plist, bootstrap. Enforced at `claude/factory/lib/launchd.js:73-82`.
  - bootstrap fails -> returns its exit code; the plist is kept. Enforced at `claude/factory/lib/launchd.js:80-81`.
  - uninstall: bootout (result ignored), plist removed. Enforced at `claude/factory/lib/launchd.js:87-90`.
  - status: `LaunchAgent: <plist or not installed>; loaded|not loaded`. Enforced at `claude/factory/lib/launchd.js:93-95`.
- Gaps:
  - G1 (L-boot): A failed bootstrap leaves the new plist on disk with the old job already unloaded, and status says not loaded. Verdict: confirmed. Evidence: e3 §6, `probe-launchd.test.js`, exit 0, 2 pass; `install code = 1 plist on disk = true`. Task: dotfiles-579.
  - G2 (U-boot): Uninstall ignores a failed bootout and removes the plist, so the job stays loaded with no plist. Verdict: confirmed. Evidence: r3 §10, probe `r2-launchd`, exit 0, 1 pass; `STATUS: LaunchAgent: not installed; loaded`. Task: dotfiles-580.
- Tests: `claude/factory/weekly/weekly.test.js:247`, `claude/factory/friction/friction.test.js:603` (exit 0, by name). Round 2 says the failure path is not pinned. The round-1 working notes say both tests use a fake `launchctl` whose bootout exits 3 and expect install and uninstall to return 0 (`claude/factory/weekly/weekly.test.js:262`, `:274`; `claude/factory/friction/friction.test.js:610`, `:616`).

### Transcript session listing

- Where: `claude/factory/lib/transcripts.js:15-27` (`sessionFiles`), `:188-228` (`parseSubagents`), `:271`, `:317-331` (`loadSessions`); `claude/factory/lib/codex.js:36`
- States: listed file; skipped link; session with subagents; session dropped
- Transitions:
  - entry -> listed: real files only. Enforced at `claude/factory/lib/transcripts.js:18-23`.
  - subagent folder -> read. Enforced at `claude/factory/lib/transcripts.js:188`.
  - subagent error (ENOENT) -> whole session dropped, with no count. Enforced at `claude/factory/lib/transcripts.js:317`.
- Gaps:
  - G1 (TR1): A valid symlink to a transcript is not read. Verdict: confirmed. Evidence: e3 §7, `probe-transcripts.test.js`, exit 0, 4 pass; `TR1c sessions = 1` for a real file and a symlink to it. Task: dotfiles-581.
  - G2 (TR1): A dangling symlink among the subagents drops the whole session. Verdict: confirmed. Evidence: e3 §7, same run; `TR1 control sessions = 1`, `TR1b sessions = 0`. Task: dotfiles-581.
  - (working note): A file removed between the listing and its `statSync` makes the whole listing fail. Verdict: unverified. Evidence: code read only, `claude/factory/lib/transcripts.js:23` and `claude/factory/lib/codex.js:36` are outside any `try`. Task: dotfiles-743.
  - TR2 (working note): An unpriced model lowers the estimate, so a stale cost-state snapshot can become the session cost. Verdict: unverified. Evidence: code read only, `claude/factory/lib/transcripts.js:271`, `:145`. Task: dotfiles-743.
- Tests: `claude/factory/lib/lib.test.js:351-373` (ENOENT skipped, other errors fatal). After this audit's change, `parseListedFile` holds the ENOENT rule for both `loadSessions` and the worker threads, and the tests are "loadSessions skips a transcript removed after listing" and "loadSessionsParallel skips a transcript removed after listing". Related tasks with other causes: dotfiles-544.

### Digest builder

- Where: `claude/factory/scoring/digest.js:15`, `:124`, `:211-213`, `:230-240`, `:241`
- States: complete; bounded; final message cut
- Transitions:
  - final message -> labelled "shown in full below". Label at `claude/factory/scoring/digest.js:124`.
  - final message -> cut to a quarter of the limit. Enforced at `claude/factory/scoring/digest.js:211-213`.
  - limit -> `OUTPUT_CHARS` 300. Set at `claude/factory/scoring/digest.js:15`.
- Gaps:
  - G1 (DG1): The label says the final message is shown in full, but it is cut. Verdict: confirmed. Evidence: r3 §5, probe `r2-digest`, exit 1, 1 fail (the failure is the evidence); `DIGEST LEN 15533 LABEL true ... FULL FILLER false` for a 20,000-character message. Task: note on dotfiles-441.
  - G2 (C5): `OUTPUT_CHARS` 300 changed to 100 passes every scoring test. Verdict: confirmed. Evidence: r3 §6 (see "Rubric version gate" G1), exit 0, 270 pass. Task: note on dotfiles-441.
  - (working note): The fallback cut at `:241` drops the final block when the shrink loop fails. Verdict: unverified. Evidence: code read only, `claude/factory/scoring/digest.js:230-240`, `:241`; reachability at the default limit is unclear. Task: dotfiles-743.
- Tests: `claude/factory/scoring/digest.test.js` (read in full). Its longest final message is about 5,600 characters, under the cut.

### Review record and board add

- Where: `claude/factory/review/cli.js:171-232` (`reviewRepo`), `:288`
- States: reviewed; verified (confirmed or rejected); filed (task id); failed (error on the record); day record written
- Transitions:
  - confirmed finding -> filed: the board add succeeds and the record gets the task id. Enforced at `claude/factory/review/cli.js:222-223`.
  - board add fails -> error on the record; the loop stops. Enforced at `claude/factory/review/cli.js:217-227`.
  - run -> `main-<UTC date>.json` written at the end. Enforced at `claude/factory/review/cli.js:288`.
- Gaps:
  - G1 (RV1): One failed board add stops the loop, so later confirmed findings are missing from the record. Verdict: confirmed. Evidence: e3 §13, `probe-add.test.js`, exit 0, 1 pass; `{"confirmed":[],"rejected":1,"error":"board add on dotfiles exited 1: board unreachable"}` with two findings marked real. Task: dotfiles-588.
  - G2: A same-day rerun overwrites the day's record. Verdict: confirmed. Evidence: r3 §11, `r2-review-rerun.test.js`, exit 0, 1 pass; `REVIEW RECORDS 1`, and the kept record is the second run's. Task: dotfiles-589.
  - R3 (working note): The board add has no idempotency key; only the verify prompt's title list guards against a duplicate task. Verdict: unverified. Evidence: code read only, `claude/factory/review/cli.js:222`, `:139`. Task: dotfiles-743.
  - R4 (working note): The record is written only at the end, so a crash after the filings loses their record. Verdict: unverified. Evidence: code read only, `claude/factory/review/cli.js:288`. Task: dotfiles-743.
  - (working note): The spend cap is per repository, with no cap for the run. Verdict: by design. Evidence: `claude/factory/review/review.test.js:92-97` pins the per-repository cap. Task: none (by design, finding #6835).
- Tests: `claude/factory/review/review.test.js:196` (by name). The date key is UTC; local-day behaviour was not checked.

### Review-skipped detector

- Where: `claude/factory/scoring/detectors.js:715`, `:720-784`; `claude/factory/scoring/review-scope.js:84-101`, `:124`, `:126-133`
- States: no edit; edit pending; settled; dropped (unmapped folder)
- Transitions:
  - edit -> pending: the file is located and not ignored. Enforced at `claude/factory/scoring/detectors.js:747`.
  - edit in an unmapped folder -> dropped, no pending entry. Enforced at `claude/factory/scoring/detectors.js:747`.
  - push -> settles the pending edits of its repository. Repository `""` settles none; `null` settles all. Enforced at `claude/factory/scoring/detectors.js:736` and `:771`.
  - T3 name -> checkout. `t3Checkout` at `claude/factory/scoring/review-scope.js:126`; null when names clash (`:124`).
  - folder -> repository: `gitCheckout` walks up to an enclosing repository (`claude/factory/scoring/review-scope.js:84-101`).
- Gaps:
  - G1 (D1): A push from an unknown folder settles nothing, so the verdict is `na` with an unreviewed edit. Verdict: confirmed. Evidence: e3 §12, `probe-d.test.js`, exit 0, 5 pass; `D1a unmapped cwd {"verdict":"na","hits":[]}`; the comment at `claude/factory/scoring/detectors.js:715` says every repository settles. Task: dotfiles-586.
  - G2 (D3): Two T3 checkouts with one name and different repositories drop the edit. Verdict: confirmed. Evidence: e3 §12, same run; `D3 t3Checkout two repos null`, `D3a ... {"verdict":"na","hits":[]}`; same-repository control gives `fail`. Task: dotfiles-587.
  - G3: The scoring tests depend on a temp folder outside any git checkout. Verdict: confirmed. Evidence: r3 §18; `TMPDIR` inside a git copy gives exit 1, 267 pass, 3 fail; outside gives exit 0, 270 pass. Task: note on dotfiles-555.
  - D2 (working note): Events without a timestamp sort first, which can change which push settles an edit. Verdict: unverified. Evidence: code read only, `claude/factory/scoring/detectors.js:753-756`; not pinned. Task: dotfiles-743.
- Tests: `claude/factory/scoring/detectors.test.js:515-521`, `:551-559` (repository-scoped settle), `:611-617` (review-skipped cases). No test covers the name clash or a known folder outside the checkouts.

### Weekly run

- Where: `claude/factory/weekly/cli.js:43-57`, `:165-193`, `:214`, `:219-227`
- States: free; locked; running; report written; status read
- Transitions:
  - lock held -> run refused (exit 3). Enforced at `claude/factory/weekly/cli.js:167` (`acquireLock`).
  - step fails -> reported; the later steps still run. By design; pinned by `claude/factory/weekly/weekly.test.js:179`.
  - report -> `weekly-<DATE>.md` written by a plain write. Enforced at `claude/factory/weekly/cli.js:181-182`.
  - status -> reads `weekly-last.json` with an unguarded `JSON.parse`. Enforced at `claude/factory/weekly/cli.js:223`.
  - uninstall result ignored. Enforced at `claude/factory/weekly/cli.js:214`.
- Gaps:
  - G1: A same-day rerun replaces the day's report. Verdict: confirmed. Evidence: r3 §12, `r2-weekly-rerun.test.js`, exit 0, 1 pass; `WEEKLY REPORTS 1 SAME PATH true`. Task: dotfiles-590.
  - G2: The report write is a plain write, so a crash inside it can leave a partial report. Verdict: unverified. Evidence: none run; the window is inside one `writeFileSync` call at `claude/factory/weekly/cli.js:181-182`. Task: dotfiles-590.
  - G3: `weekly status` crashes on a damaged `weekly-last.json` and does not name the file. Verdict: confirmed. Evidence: r3 §13, probe `r2-weekly-status`, exit 0, 1 pass; `WEEKLY STATUS ERROR SyntaxError: JSON Parse error: Unexpected EOF`. Task: dotfiles-591.
  - G4: The weekly uninstall ignores the uninstall result. Verdict: confirmed. Evidence: same probe as "LaunchAgent install and uninstall" G2 (r3 §10). Task: dotfiles-580.
  - (working note): A crash in the middle of a run leaves no summary, and status shows the previous run with no crash marker. Verdict: unverified. Evidence: code read only, `claude/factory/weekly/cli.js:183`, `:219-227`. Task: dotfiles-743.
  - (working note): Exit code 1 means both "needs attention" and "failed". Verdict: unverified. Evidence: code read only, `claude/factory/weekly/cli.js:189`; `claude/factory/weekly/weekly.test.js:172-177` pins exit 1 for attention. Task: dotfiles-743.
- Tests: `claude/factory/weekly/weekly.test.js:179` (exit 0, by name), `:247` (uninstall, normal path).

### LiteLLM price cache

- Where: `claude/factory/lib/litellm.js:16-20` (`cache`), `:27-45` (`refreshLitellm`); `claude/factory/lib/state.js:45-48` (`readJson`)
- States: no cache file; cache loaded; cache damaged; refreshed from the network
- Transitions:
  - no file or valid file -> loaded. Enforced at `claude/factory/lib/litellm.js:16-20`.
  - damaged file -> the read throws; `loaded` is not set, so every call reads again. Enforced at `claude/factory/lib/litellm.js:16-20`.
  - refresh reads the cache at `:28`, outside its `try`; the `try` covers only the fetch. Enforced at `claude/factory/lib/litellm.js:27-45`.
- Gaps:
  - G1: A damaged cache file makes every refresh throw, and no fetch ever runs, so the cache never heals. Verdict: confirmed. Evidence: r3 §14, probe `r2-litellm`, exit 0, 1 pass; `LITELLM run 1: SyntaxError | run 2: SyntaxError FETCHES 0`. Task: dotfiles-592.
  - (working note): A failed fetch records no attempt time, so every run fetches again while the cache is stale. Verdict: unverified. Evidence: code read only, `claude/factory/lib/litellm.js:27-45` (30 s limit at `:32`). Task: dotfiles-743.
- Tests: `claude/factory/lib/lib.test.js:81-134` (fallback, refresh, failed-fetch note). None for a damaged cache.

### Codex thread attach

- Where: `claude/factory/lib/codex.js:347-381` (`loadCodexSessions`; attach at `:373`)
- States: root thread; subagent with its root; subagent with no root; session listed
- Transitions:
  - subagent whose root is in the index -> attached as an inherited session. Enforced at `claude/factory/lib/codex.js:373`.
  - subagent whose root is missing -> listed as a top-level session, nothing attached. Enforced at `claude/factory/lib/codex.js:373`.
- Gaps:
  - G1: A subagent whose root thread is missing is listed as a top-level session. Verdict: confirmed. Evidence: r3 §17, `r2-codex-rootless.test.js`, exit 0, 1 pass; `ROOTLESS COUNT 1`. Its effect on the "launched by an agent" metric is not measured. Task: dotfiles-594.
- Tests: round 2 found no suite test for a root-less subagent. The round-1 working notes say `claude/factory/lib/codex.test.js:135-141` pins an orphan subagent as an agent-launched session.

### Bounded project-instruction read

- Where: `claude/factory/lib/probe.js:21-29` (`readFilesWithDeadline`); `claude/factory/scoring/score.js:83`, `:107-119`, `:371`
- States: files read; read blocked (null at the deadline); judged without project instructions; recorded with no project files
- Transitions:
  - read in time -> files returned. Enforced at `claude/factory/lib/probe.js:21-29`.
  - read blocked -> null at the deadline. By design (`claude/factory/lib/probe.js:1-4`, `:25-26`).
  - null -> judged without instructions, with the message "could not be read in time". Enforced at `claude/factory/scoring/score.js:107-119`.
  - judged -> record `{ global, project: [] }` under a key with no instruction part. Enforced at `claude/factory/scoring/score.js:371` and `:83`.
- Gaps:
  - G1: A project `CLAUDE.md` that blocks is judged as if absent, and the record shows no sign of it. Verdict: confirmed. Evidence: r3 §15, probe `r2-instructions-timeout`, exit 0, 1 pass; `PROJECT FILES [] MS 5003`. Task: dotfiles-593.
  - G2: Once judged under the same key, a session is not judged again when the file becomes readable. Verdict: unverified. Evidence: none run; a run needs a fake judge that was not built. Task: dotfiles-593.
- Tests: `claude/factory/lib/probe.test.js:14-22` (silent cut at `maxChars`), `:24-30` (deadline returns null). No score-suite test of this state was found.

### UI run lock and run identity

- Where: `claude/factory/ui/run.js:18-20` (identity), `:35-49` (`openRun`), `:57-66` (`holderAlive`), `:69-95` (`lockRun`)
- States: no lock; locked by a live pid; lock with no pid; stale lock; run identity matches or not
- Transitions:
  - no lock -> locked: exclusive create, then the pid is written. Enforced at `claude/factory/ui/run.js:73-75`.
  - locked -> released: the file is removed with no owner check. Enforced at `claude/factory/ui/run.js:76`.
  - live pid -> refused. Enforced at `claude/factory/ui/run.js:89-90`.
  - stale lock -> removed and taken again. Enforced at `claude/factory/ui/run.js:88-91`.
  - identity mismatch -> `RunError`. Enforced at `claude/factory/ui/run.js:39-40`. Existing `run.json` is checked at `:46-47`.
- Gaps:
  - P1: A lock whose pid now belongs to an unrelated live process stays held. Verdict: confirmed. Evidence: e4 P1; `A result: Error: run p1-run is in use by process <pid>; wait for it to finish`; an exited pid is taken over. Task: note on dotfiles-442.
  - U1: Unlock has no owner check, so a holder that lost its lock can remove the new holder's lock. Verdict: confirmed. Evidence: r4 U1, `u1-unlock.js main`, exit 0; "B still running when C finished: true"; control refuses B. Task: dotfiles-610.
  - U2: `openRun` checks, then writes `run.json`, so two processes can race. Verdict: confirmed. Evidence: r4 U2, `u2-openrun.js`, exit 0; "already exists" in 8 of 12 and 16 of 16 trials; two run folders across a second boundary did not reproduce. Task: dotfiles-611.
  - U12: The stale-lock steal is not atomic; two processes both acquire the lock. Verdict: confirmed. Evidence: r4 U12, `r2-steal-driver.js`, exit 0; 16 of 40 trials with two acquisitions (earlier 24 and 13 of 40); solo and fresh controls 0. Task: dotfiles-612.
- Tests: `claude/factory/ui/ui.test.js:222-239` (live holder refused `:226`; pid 1 refused `:233`; half-written lock `:236`; recovery `:239`). The pid 1 test does not make P1 by design.

### UI round record and round number

- Where: `claude/factory/ui/cli.js:364`, `:384`, `:477`, `:479`; `claude/factory/ui/run.js:105` (`fullRounds`)
- States: no round; round file written, no line yet; round recorded; file missing (summary fallback)
- Transitions:
  - number = lines in `rounds.jsonl` + 1. Enforced at `claude/factory/ui/cli.js:364`.
  - round file write, then line append. Enforced at `claude/factory/ui/cli.js:477` and `:479`.
  - missing round file -> summary line used, which holds no issues. Enforced at `claude/factory/ui/run.js:105`.
- Gaps:
  - P8: A kill between the file write and the line append leaves the round file with no line, and the next run reuses the number. Verdict: confirmed. Evidence: e4 P8; `rounds.jsonl lines: 2; next round number: 3; round-3.json exists: true`. Task: note on dotfiles-443 (item 4).
  - P7: With a round file missing, the issue's first round moves, and the issue is lost when no round file exists. Verdict: confirmed. Evidence: r4 P7, `p7-full.js`, exit 0; with the file "resolved in round 2 (since 1)"; without it `entries=0`. Task: dotfiles-600.
  - (working note): A stage error exits 2, the same code as a usage or setup error. Verdict: unverified. Evidence: code read only, `claude/factory/ui/cli.js:482`. Task: dotfiles-743.
- Tests: none located.

### UI issue ledger and settled fixes

- Where: `claude/factory/ui/ledger.js:1-12`, `:14`, `:19-44`; `claude/factory/ui/council.js:378-386`
- States per key: open (since round N); resolved (in round M); settled fix (at most `SETTLED_MAX`)
- Transitions:
  - issue in a round -> open or updated. Enforced at `claude/factory/ui/ledger.js:26`.
  - key missing from a later round with verdicts -> resolved (read, not probed).
  - settled list capped at 20. Enforced at `claude/factory/ui/ledger.js:14`.
  - stored fix is `fixes[0]` only. Enforced at `claude/factory/ui/ledger.js:32`.
- Gaps:
  - P5: A dirty round resolves an issue the same as a clean round; the ledger does not read the dirty flag. Verdict: confirmed. Evidence: e4 P5; the lines for `dirty=true` and `dirty=false` both give `state=resolved resolvedIn=2 since=1`. Task: dotfiles-599.
  - P6: A key with two fixes settles only the first. Verdict: confirmed. Evidence: e4 P6 (a probe, not a recorded climb); `fixes=["Fix A","Fix B"]`, then settled holds "Fix A" only; grouping is by design (`claude/factory/ui/council.js:378-386`). Task: note on dotfiles-331.
  - Settled-fix expiry at a structural round has no probe. Verdict: unverified. Evidence: none run; named in the round-1 record only. Task: dotfiles-331 (its part b, per the record).
- Tests: `claude/factory/ui/ui.test.js:486-522` (`SETTLED_MAX` at `:519-522`).

### UI champion verdict

- Where: `claude/factory/ui/cli.js:33-50`, `:126-133` (`championOf`); `claude/factory/ui/council.js:361-363`, `:364-368` (`championResult`)
- States: no champion; champion is a round
- Transitions:
  - `championOf` picks a round by its rule. Enforced at `claude/factory/ui/cli.js:126-133`.
  - `championResult` returns "rejected" when the lead is under the negative margin; "replaced" when eligible and the lead is over the margin or the round passes; else "held". Enforced at `claude/factory/ui/council.js:364-368`.
- Gaps:
  - The champion rule could differ from the documented one. Verdict: by design. Evidence: `claude/factory/ui/ui.test.js:711-716` pins the rule. Task: none (by design, finding #6784).
  - A passing, eligible round replaces the champion with a null lead. Verdict: by design. Evidence: comment at `claude/factory/ui/council.js:361-363`; test `claude/factory/ui/ui.test.js:697-699`. Task: none (by design, finding #6784).
  - U3: The usage text and the `--new-run` help do not describe pass, eligibility or the budget reset. Verdict: confirmed. Evidence: r4 U3; `--help` exit 0; 0 lines match "pass", "eligib" or "budget". Task: dotfiles-620.
  - The report and the status command could disagree on "pass". Verdict: refuted. Evidence: `claude/factory/ui/cli.js:453-454`, `claude/factory/ui/report.js:146`, `claude/factory/ui/ui.test.js:1060`. Task: none (refuted, finding #6835).
- Tests: `claude/factory/ui/ui.test.js:697-699`, `:711-716`.

### UI judge output read

- Where: `claude/factory/ui/council.js:194-232` (`readOutput`)
- States per judge output: accepted; issue or strength dropped; error
- Transitions:
  - a scored design that was not shown -> throw. Enforced at `claude/factory/ui/council.js:201`.
  - an issue or strength that names an unshown design -> dropped with no error. Enforced at `claude/factory/ui/council.js:230-231`.
- Gaps:
  - P21: An issue that names an unshown design is dropped silently, and a scored unshown design throws. Verdict: confirmed. Evidence: e4 P21; `issue with unknown design 7: no error`; control `threw Error: scored Design 7, which was not shown`. Task: dotfiles-609.
- Tests: `claude/factory/ui/ui.test.js:387-393`, `:1027` (scored error). None for the silent drop.

### UI judge retry

- Where: `claude/factory/ui/council.js:277-317` (`runJudge`)
- States per sample: first attempt; retry; done; failed twice (throws); judge failed (any sample rejected)
- Transitions:
  - call error -> retry when the budget has room. Enforced at `claude/factory/ui/council.js:286`, `:294-298`.
  - output error -> one retry. Enforced at `claude/factory/ui/council.js:304-306`.
  - no room for a retry -> `JudgeFailedError`. Enforced at `claude/factory/ui/council.js:286-287`.
  - second failure -> throw (`:309`). Any rejected sample rejects the judge (`:313-314`).
  - each call has a 900000 ms limit (`:293`), and its cost is recorded before a failure is reported (`:296`, `:301`).
- Gaps: none found.
- Tests: `claude/factory/ui/ui.test.js:585`, `:610`.

### UI capture batch and reference retries

- Where: `claude/factory/ui/capture.js:191-221` (`captureShots`); `claude/factory/ui/run.js:135`, `:163-197` (`referenceVersions`), `:220`
- States per shot: captured; errored (record); batch aborted (throw); old file accepted
- Transitions:
  - failed GET -> throw out of `captureShots`; later shots do not run. Enforced at `claude/factory/ui/capture.js:205`.
  - browse error or no file -> error recorded. Enforced at `claude/factory/ui/capture.js:211`.
  - nothing written but an old file exists -> error null. Enforced at `claude/factory/ui/capture.js:211`.
  - reference retry: the wait doubles up to the try count (`claude/factory/ui/run.js:177-178`). A throw at `:181` skips the retry loop.
  - folder clears: baseline and control at `claude/factory/ui/run.js:135`; candidate at `:220`; none in `referenceVersions`.
- Gaps:
  - P3: One failed GET aborts the batch, and later shots are not captured. Verdict: confirmed. Evidence: e4 P3; `failing: threw Error: GET /missing for third failed: 404` with 2 files on disk; control returned 3 records. Task: dotfiles-597.
  - P4: An old file counts as a capture when the browser writes nothing (latent; reachable in `referenceVersions`). Verdict: confirmed. Evidence: e4 P4; `P4: error=null ... content=old`. Task: dotfiles-598.
- Tests: none located.

### UI serve lifecycle

- Where: `claude/factory/ui/capture.js:88-97` (`freePort`), `:110-117` (`signalTree`), `:131-164` (`serve`)
- States: starting; waiting for ready; ready; exited before ready; timed out; stopping with leader alive; stopping with leader exited; stopped
- Transitions:
  - exit before ready -> throw (`claude/factory/ui/capture.js:155`). Deadline -> stop, then throw (`:158-160`).
  - stop, leader alive: TERM to the tree and the group (`:144-145`), wait up to 3 s (`:146`), then KILL (`:147-150`).
  - stop, leader exited: the tree is empty (`:144`); TERM to the group (`:145`); no wait and no KILL.
- Gaps:
  - P2: After the leader exits, `stop()` sends one TERM and returns at once, so a child that ignores TERM survives. Verdict: confirmed. Evidence: e4 P2; `exit-first: stop() returned after 0 ms`, `child ... alive after stop: true`. Task: dotfiles-596.
  - The leader-alive stop path could leave the child alive. Verdict: refuted. Evidence: e4 P2 alive block; `stop() returned after about 3100 ms`, `alive after stop: false`. Task: none (refuted, finding #6784).
  - U4: `freePort` returns a port that another process can take before the server binds. Verdict: confirmed. Evidence: r4 U4, `u4-serve.js foreign`, exit 0; `serve` returns the foreign server and the bind fails with EADDRINUSE; control exit 0. Task: dotfiles-613.
- Tests: `claude/factory/ui/ui.test.js:187-214` (leader-alive stop). No exit-first test found.

### UI extract temp folder

- Where: `claude/factory/ui/capture.js:65-81`; callers `claude/factory/ui/run.js:146`, `:212`
- States: folder created; extracted; disposed; left behind after a kill
- Transitions:
  - created by `mkdtemp` with prefix `claude-factory-ui-` (`claude/factory/ui/capture.js:70`); extracted (`:73`); removed by `dispose` (`:81`). No other code removes it.
- Gaps:
  - U9: SIGKILL leaves the folders, and no sweep or clean command exists. Verdict: confirmed. Evidence: r4 U9, `u-ui-kill.js`, exit 0; "killed holder: extract folders left = 2"; the error path adds none. Task: dotfiles-617.
- Tests: `claude/factory/ui/ui.test.js:156-172` (`dispose`). No test kills the process.

### UI budget and config identity

- Where: `claude/factory/ui/config.js:221-224`, `:230`, `:247-249`; `claude/factory/ui/run.js:18-20`, `:39-40`; `claude/factory/ui/council.js:266-270`, `:287`; `claude/factory/ui/cli.js:272`, `:288-289`
- States: config valid or invalid; config hash; run identity matches or not; spend per call, round and run
- Transitions:
  - bounds check (`claude/factory/ui/config.js:221-224`); call checked against round (`:230`).
  - hash of `JSON.stringify(raw)`, which keeps the file's key order (`claude/factory/ui/config.js:249`).
  - hash -> run identity (`claude/factory/ui/run.js:18-20`); mismatch throws (`:39-40`).
- Gaps:
  - P19: A round budget above the run budget loads; only the call is checked against the round. Verdict: confirmed. Evidence: e4 P19; `P19 round 3 above run 1: loaded without error`. Task: dotfiles-607.
  - P20: Reordering the keys changes the hash and refuses the old run, and the comment at `claude/factory/ui/config.js:247` says formatting does not count. Verdict: confirmed. Evidence: e4 P20; `same settings, keys reversed: ... equal=false`. Task: dotfiles-608.
  - P9: The budget is per run, with no cap across runs. Verdict: by design. Evidence: `claude/skills/ui-climb/SKILL.md:236`; r4 P9, two runs spent 0.9 each, 1.8 in total, against a run budget of 1. Task: none (by design, finding #6784); the cap across runs is an owner decision in dotfiles-725.
- Tests: `claude/factory/ui/ui.test.js:39-56`, `:83-99` (call against round at `:97`).

### UI calibrate and budget refusal

- Where: `claude/factory/ui/cli.js:46`, `:263-274` (`calibrateCommand`), `:275-292`
- States: rejected by the samples check (no run folder); run opened and locked; refused (exit 3, run folder kept); calibrating
- Transitions:
  - `--samples` outside 2 to 5 -> usage error, exit 2, before any folder. Enforced at `claude/factory/ui/cli.js:264-265`.
  - `openRun` creates the folder, then `lockRun`. Enforced at `claude/factory/ui/cli.js:266-267`.
  - budget refusal after the folder exists -> exit 3. Enforced at `claude/factory/ui/cli.js:269-273`.
  - otherwise -> captures and judges. Enforced at `claude/factory/ui/cli.js:275-292`.
- Gaps:
  - U7: A refused calibration leaves a run folder. Verdict: confirmed. Evidence: r4 U7, `calibrate-refused.sh`, exit 0; `--samples 5` exit 3, "run folders: 1", "judge stub calls: 0". Task: dotfiles-618.
  - U8: The help says "(default 3, at least 2)" and does not state the upper bound of 5. Verdict: confirmed. Evidence: r4 U8, same script; `--samples 6` and `--samples 1` exit 2 with "run folders: 0". Task: dotfiles-619.
  - (working note): The options are shared by all subcommands, so calibrate and status accept flags such as `--structural` silently. Verdict: unverified. Evidence: code read only, `claude/factory/ui/cli.js` (`parseArgs`). Task: dotfiles-743.
- Tests: `claude/factory/ui/ui.test.js:1366-1372` pins exit 3 and its message, not the run folder. It may sit in the skipped end-to-end block (`:870-873`); not run.

### UI contrast totals

- Where: `claude/factory/ui/checks.js:64-80`, `:147-159` (`checkTotals`)
- States per text element: skipped; unknown background; checked
- Transitions:
  - element with no own text, hidden, aria-hidden or disabled -> skipped. Enforced at `claude/factory/ui/checks.js:66-68`.
  - background unknown -> counted in `unknown`, then skipped. Enforced at `claude/factory/ui/checks.js:71-73`.
  - background known -> contrast checked. Enforced at `claude/factory/ui/checks.js:75-80`.
  - totals keep `contrast.count` only. Enforced at `claude/factory/ui/checks.js:153`.
- Gaps:
  - P18: Unknown backgrounds never reach the totals or the gates. Verdict: confirmed. Evidence: r4 P18, `p18-unknown.js`, exit 0; the output for unknown 4 and unknown 0 is identical. Task: dotfiles-621.
  - The in-page contrast check with a real background is not probed. Verdict: unverified. Evidence: none run; the probe needs a headless browser whose install needs the network. Task: dotfiles-623.
- Tests: none pins the unknown count.

### Bench matrix runner

- Where: `claude/factory/bench/cli.js:25`, `:57`, `:85-90`, `:118`, `:122-124`; `claude/factory/bench/runner.js:143` (`runMatrix`)
- States: cell (trial, case, config) pending or done; spend per invocation
- Transitions:
  - trial, then case, then config; each record is appended. Enforced at `claude/factory/bench/cli.js:85-90`.
  - spend stops at `--max-total-usd` (default 10 per invocation). Enforced at `claude/factory/bench/runner.js:143`.
- Gaps:
  - P14: A rerun runs every cell again and appends records, and each invocation has its own cap. Verdict: confirmed. Evidence: e4 P14; `invocation 1: ... sessions so far 2`, `invocation 2: ... sessions so far 4`. Task: note on dotfiles-443 (item 3; dotfiles-425 lists it too).
- Tests: `claude/factory/bench/bench.test.js:366-367`, `:382-383`, `:398`.

### Bench board runs, run ids and token cache

- Where: `claude/factory/bench/board/cli.js:96-114`, `:127-142`; `claude/factory/bench/board/tokens.js`
- States: run pending; run done; stop reason; token cache entry per cell
- Transitions:
  - sequence = count of earlier runs with the same series, model and effort (`claude/factory/bench/board/cli.js:96`, `:100`); run id `<series>-<n>` (`:106`).
  - `StopRun` ends a series on subscription, limit or `maxInfra` (`:111-114`).
  - token cache write (`:131`) and read (`:136`).
- Gaps:
  - P15: Two models in one series get the same run id. Verdict: confirmed. Evidence: e4 P15, `results.jsonl: t-1/claude-haiku-5-5, t-1/claude-opus-5-5`; r4 P15 extension, two records with run id `u6k-1`. Task: dotfiles-603.
  - U5: The token cache loses the counts already paid for when a later cell fails. Verdict: confirmed. Evidence: r4 U5, `u5-tokens.js partial`, exit 0; "claude calls 4", tokens file absent; `complete` gives 5 calls and a file. Task: dotfiles-614.
  - U6: `maxInfra` counts consecutive voids, not all voids. Verdict: by design. Evidence: `claude/factory/bench/board/cli.js:31` (help), `:101`, `:113-114`. Task: none (by design, finding #6784).
  - A SIGKILL of the bench matrix could leak its folder. Verdict: refuted. Evidence: round-2 probe `u6-kill`, exit 0; 1 folder before the kill, `clean` removed 1, 0 folders and 0 processes after. Task: none (refuted, finding #6835).
  - No clean runs at the start of a matrix. Verdict: by design. Evidence: `claude/factory/bench/board/README.md:63`. Task: none (by design, finding #6784).
- Tests: `claude/factory/bench/board/board.test.js:191-221`. None for the partial-failure cache.

### Bench board leftover clean

- Where: `claude/factory/bench/board/run.js:149-156` (`cleanLeftovers`)
- States: leftover root present; processes named by the root killed; root removed
- Transitions:
  - filter by prefix, skipping `tokens-` names. Enforced at `claude/factory/bench/board/run.js:150`.
  - `pkill -KILL -f <root>` (status not checked), then the root is removed. Enforced at `claude/factory/bench/board/run.js:152`, `:154`. Both run whether or not a run is live.
- Gaps:
  - P16: A root in use by a live run loses its process and its folder, and a child whose command line does not name the root survives as an orphan. Verdict: confirmed. Evidence: e4 P16; `after clean: process exited, signal SIGKILL; root exists: false`; control P16b shows `pkill -f` matches by command line only. Task: dotfiles-604.
  - U10: The filter skips token folders, so the leftovers of a kill stay. Verdict: confirmed. Evidence: see "Bench token count temp folder" U10. Task: dotfiles-615.
- Tests: `claude/factory/bench/board/board.test.js:10` imports `cleanLeftovers`. No test pins the token exclusion.

### Bench token count temp folder

- Where: `claude/factory/bench/board/tokens.js:14-29` (`inputTokens`); `claude/factory/bench/board/run.js:150`
- States: folder created; removed on return; left behind after a kill
- Transitions:
  - created by `mkdtemp` with prefix `board-bench-tokens-` (`claude/factory/bench/board/tokens.js:15`); removed in `finally` (`:27`). SIGKILL skips `finally`.
- Gaps:
  - U10: SIGKILL leaves the folders, and `bench board clean` does not remove them. Verdict: confirmed. Evidence: r4 U10, `r2-tokens-driver.js`, exit 0; "tokens folders while running=4 after SIGKILL=4 child exit=137"; clean prints "Nothing to clean." with 4 before and after. Task: dotfiles-615.
- Tests: none pins the token folders.

### Bench runOne workspace folder

- Where: `claude/factory/bench/runner.js:78-79`, `:87-134`
- States: root created; workspace filled; session run; removed in `finally`; left behind after a kill
- Transitions:
  - created by `mkdtemp` with prefix `claude-bench-<case>-` (`claude/factory/bench/runner.js:79`); removed in `finally` (`:132-134`).
  - `cleanLeftovers` matches only its own prefix (`claude/factory/bench/board/run.js:149-150`), and `claude/factory/bench/cli.js` has no clean command.
- Gaps:
  - U11: SIGKILL leaves the root, and nothing sweeps it. Verdict: confirmed. Evidence: r4 U11, `u-runner-kill.js`, exit 0; "claude-bench folders while running=1 after SIGKILL=1 child exit=null". Task: dotfiles-616.
- Tests: none pins removal after a kill.

### Bench board serve wait

- Where: `claude/factory/bench/board/run.js:52-57` (`freePort`), `:88-99` (`waitHealthy`)
- States: waiting; healthy; server exited (throws); timed out (throws)
- Transitions:
  - first `/healthz` answer -> healthy; any listener on the port answers. Enforced at `claude/factory/bench/board/run.js:93`.
  - server exited -> throw (`:91`). Timed out -> throw (`:99`).
  - `freePort` returns a port that was free before the server binds (`:55-56`).
- Gaps:
  - U4 (bench): Another process can take the port before the server binds, and the wait accepts it. Verdict: confirmed. Evidence: r4 U4, `r2-port.js foreign`, exit 0; "waitHealthy accepted foreign"; the stub exits 1. Task: dotfiles-613.
- Tests: none found for `freePort` or `waitHealthy`.

### Bench style aggregate and adopt

- Where: `claude/factory/bench/style/style.js:168`, `:169`, `:181`, `:199`, `:203`; `claude/factory/bench/style/cli.js:112` (`reportCommand`)
- States per variant: runs and `minTrials`. Decision: not measured (null); adopt; do not adopt
- Transitions:
  - usable filter. Enforced at `claude/factory/bench/style/style.js:169`.
  - adopt = keeps the facts and is shorter. Enforced at `claude/factory/bench/style/style.js:203`. `minTrials` is computed (`:181`) and not used by the decision.
  - the report pools all records. Enforced at `claude/factory/bench/style/cli.js:112`.
- Gaps:
  - P12: One run per variant gives adopt, with no trial floor. Verdict: confirmed. Evidence: e4 P12; `one trial each: adopt=true ... minTrials=1`; the earlier by-design label on `claude/factory/bench/style/style.test.js:175` is withdrawn. Task: dotfiles-601.
  - P13: Pooled records decide differently from one model's records. Verdict: confirmed. Evidence: e4 P13; pooled `adopt=false`, haiku only `adopt=true`, opus only `adopt=false`. Task: dotfiles-602.
  - With no usable runs the decision stays open. Verdict: by design. Evidence: `claude/factory/bench/style/style.test.js:196`. Task: none (by design, finding #6784).
- Tests: `claude/factory/bench/style/style.test.js:175`, `:196`, `:204`.

### Bench board Wilson report

- Where: `claude/factory/bench/board/report.js:9-16` (`wilson`), `:20-23` (`rate`)
- States: none (pure function)
- Transitions: none. `wilson` returns null when n is 0 (`claude/factory/bench/board/report.js:10`).
- Gaps:
  - P22: The report could pass k above n to `wilson`. Verdict: refuted. Evidence: e4 P22; `rate()` counts k over the same filtered set as n (`claude/factory/bench/board/report.js:21-22`); a direct `wilson(5, 3)` returns null bounds. Task: none (refuted, finding #6784).
- Tests: `claude/factory/bench/board/board.test.js:286-291`.

### Bench legacy roles

- Where: `claude/factory/bench/report.js:57` (`LEGACY_ROLES`), `:61`
- States: none (a mapping)
- Transitions: a record with role `solver` counts as `worker`. Enforced at `claude/factory/bench/report.js:61`.
- Gaps:
  - Old records keep a role name that the code maps. Verdict: by design. Evidence: `claude/factory/bench/bench.test.js:515-516`; the bench suite passed 42 of 42. Task: none (by design, finding #6784).
- Tests: `claude/factory/bench/bench.test.js:515-516`.

### Audit baseline acceptance

- Where: `claude/factory/audit/cli.js:17`, `:42-44` (`readBaseline`), `:84-86`, `:91`, `:95`, `:96`; `claude/factory/audit/audit.js:14-15`
- States per finding: accepted; failing (not accepted, at or above `--fail-on`); passing
- Transitions:
  - accepted = id present and rank(finding) <= rank(entry severity, or "high" when absent). Enforced at `claude/factory/audit/cli.js:95`.
  - failing list -> exit 1. Enforced at `claude/factory/audit/cli.js:96`.
  - malformed baseline -> `readBaseline` throws; the call at `:91` is outside a `try`.
- Gaps:
  - P11: A baseline entry without severity accepts a high finding. Verdict: confirmed. Evidence: e4 P11; `no severity: exit 0`, `severity info: exit 1`, `no entry: exit 1`. Task: note on dotfiles-443 (item 5).
  - U13: A malformed baseline gives an uncaught stack trace and exit 1, and usage errors exit 2. Verdict: confirmed. Evidence: r4 U13, `audit-baseline.sh`, exit 0; "malformed baseline exit=1". Task: dotfiles-622.
  - Acceptance is by id only. Verdict: by design. Evidence: `claude/factory/audit/audit.test.js:162-171`. Task: none (by design, finding #6784).
  - `--update-baseline` drops entries that no longer match. Verdict: by design. Evidence: `claude/factory/audit/cli.js:17`; probe ghost count 0. Task: none (by design, finding #6784).
- Tests: `claude/factory/audit/audit.test.js:81-105`, `:162-171`, `:206-211`.

### Audit sandbox profile

- Where: `claude/factory/audit/sandbox.js:71-79` (`profileFor`)
- States: none
- Transitions: none. A relative `allowWrite` throws (`claude/factory/audit/sandbox.js:74`).
- Gaps: none found.
- Tests: `claude/factory/audit/sandbox.test.js:21`, `:30`, `:37-38`, `:43-45`. The live suite was read, not run.

### Audit hook test runner

- Where: `claude/factory/audit/audit.js:242-253` (`hookTestFinding`)
- States: folder missing (medium finding); suites pass (info); suites fail (high)
- Transitions:
  - folder missing -> medium finding (`claude/factory/audit/audit.js:243`).
  - runs `bun test` on the folder (`:244`) and reads the pass and fail counts (`:246-248`): pass -> info (`:249-250`); fail -> high (`:251-252`).
- Gaps:
  - `--with-tests` could run live suites. Verdict: refuted. Evidence: a search of `claude/hooks` for live test files returned 0 files. Task: none (refuted, finding #6784).
- Tests: `claude/factory/audit/audit.test.js:231-234`.

### Metrics PR cache

- Where: `claude/factory/metrics/github.js:8`, `:9`, `:29`, `:34-36`, `:41`, `:45`, `:48`
- States per PR: absent; fresh OPEN; stale OPEN; MERGED or CLOSED (kept without expiry); refresh failed (note)
- Transitions:
  - cache used when the entry is not OPEN or is younger than 1 h; else gh. Enforced at `claude/factory/metrics/github.js:34-36`.
  - fresh result stored (`:41`); file written only when changed (`:48`).
  - gh failure -> note, and the PR is left out. Enforced at `claude/factory/metrics/github.js:45`.
- Gaps:
  - P17: A stale OPEN PR whose refresh fails is left out of the result, and the cache still holds its last state. Verdict: confirmed. Evidence: e4 P17; `stale OPEN (2 h old): returned 0 PR(s); gh calls 1; notes 1; cache still holds k1 true`. Task: dotfiles-605.
  - M16: A cached MERGED or CLOSED PR never refreshes, so a reopened PR stays CLOSED. Verdict: confirmed. Evidence: r4 M16 CLOSED, `metrics-closed.js`, exit 0; "PR 1 still CLOSED after reopen" two hours later on a fake clock; the OPEN control refreshed. Task: dotfiles-606.
  - A failing gh call becomes a note. Verdict: by design. Evidence: `claude/factory/metrics/metrics.test.js:351`. Task: none (by design, finding #6784).
  - The test at `claude/factory/metrics/metrics.test.js:303` could be flaky (one 5003 ms run against a 5000 ms limit in round 1). Verdict: refuted. Evidence: round 2, ten isolated runs of 49 to 240 ms, all passed; the slow run was a cold start. Task: none (refuted, finding #6835).
- Tests: `claude/factory/metrics/metrics.test.js:303`, `:313`, `:335`, `:351`. No test pins a CLOSED refresh.

### Metrics history append

- Where: `claude/factory/metrics/cli.js:21`, `:267`
- States: append only
- Transitions: each run appends one line with no dedupe. Enforced at `claude/factory/metrics/cli.js:267`.
- Gaps:
  - The history has no dedupe. Verdict: by design. Evidence: `claude/factory/metrics/metrics.test.js:546-550`. Task: none (by design, finding #6784).
- Tests: `claude/factory/metrics/metrics.test.js:546`.

### Metrics corrections

- Where: `claude/factory/metrics/corrections.js` (rules, `countCorrections`)
- States: none (a heuristic)
- Transitions: none.
- Gaps: none found.
- Tests: `claude/factory/metrics/corrections.test.js:49-51`.

## Scripts and shell

Machines: 36

Sources: the `e5-scripts_r2_machines-2.md` record (round 2) and the `e5-scripts_notes-*.md` working notes (round 1) of the audit. The raw records are not in this repository; task dotfiles-748 names their place. In evidence lines, `r2 Pn` names block Pn of `e5-scripts_r2_probes-2.md`. `round 1 case Pn` names a case of the round 1 config-sync probe; its numbers differ from the round 2 numbers. Probe files and logs exist only in the audit's scratch copy. Each gap sits in one block. dotfiles-658 holds the files that the audit did not read in full (mpv, nvim tests and Lua, tuios tests).

### explore socket discovery

- Where: `explore/bin/explore-dispatch:115-169`, `:127-132`, `:147-152`; `explore/bin/explore-key:51-61`
- States: nvim server listed; socket name read; socket checked; server answering; not found
- Transitions:
  - process snapshot -> socket name: `ps` lists nvim servers and `lsof -a -p PID -U -Fn` gives the names. Enforced at `explore/bin/explore-dispatch:127-132`, `:147-150`.
  - socket name -> rejected: the name fails the socket test. Enforced at `explore/bin/explore-dispatch:152`.
  - socket name -> answering: an RPC reaches the server pid. Enforced at `explore/bin/explore-dispatch:115-169`.
  - no answering server -> not found: the caller falls back. Enforced at `explore/bin/explore-key:51-61`.
- Gaps:
  - G1: `lsof` cuts unix socket names to 103 bytes on this macOS. The short name fails `[[ -S ]]`, so discovery misses the live server. Verdict: confirmed. Evidence: r2 P9: `DBG candidate=... len=103`, `explore_socket 0 fn_rc=1`; the headless test without its skip guard gives `FAILED (failures=1)`. Task: dotfiles-631.
  - Candidate deadline: each candidate socket gets one 2 s RPC, and no total limit applies (`explore/bin/explore-dispatch:115-168`). Verdict: unverified (round 1 run only; round 2 did not find its output again). Evidence: round 1 candidates probe: 5 dead candidates and 1 live candidate took 10.86 s, rc 0. Task: note on dotfiles-444 (#6791).
- Tests: `explore/tests/test_explore.py:344-346`, `:403-411`. No truncated-name case. Suite in three runs: `Ran 15 tests`, `FAILED (errors=1, skipped=1)`.

### explore key open or new window

- Where: `explore/bin/explore-key:51-61`; `explore/bin/explore-dispatch:70-90`, `:197-226`
- States: socket found; open accepted; open rejected; new window opened
- Transitions:
  - socket found -> open accepted: `explore_nvim_open` returns 0. Enforced at `explore/bin/explore-key:57`.
  - open rejected (any non-zero rc) -> new window. Enforced at `explore/bin/explore-key:61`.
  - RPC wait: 2 s bound, rc 124 on timeout. Enforced at `explore/bin/explore-dispatch:70-90`.
- Gaps:
  - G1: an open that times out can still apply in the editor. The caller then opens a second window. Verdict: confirmed (round 1 run; not rerun in round 2). Evidence: round 1 double-open probe, delay mode: rc 0, 2.48 s, editor applied 0.39 s after return, one new window. Task: note on dotfiles-444 (#6790, item 4; corrected lines 57 and 61).
- Tests: none found for the double-open case.

### explore JSON read

- Where: `explore/bin/explore-dispatch:5-7`
- States: running; done; hung
- Transitions:
  - running -> done: `nvim -l` exits. Enforced at `explore/bin/explore-dispatch:5-7`.
  - running -> hung: no time limit applies. Same lines.
- Gaps:
  - G1: `nvim -l` has no time limit, so a hung process blocks the caller. Verdict: confirmed. Evidence: r2 P7: `g hung nvim: rc=None timed_out_after_5s=True`; control `rc=0 ... stdout='["ok"]'`. Task: dotfiles-629.
- Tests: none for this call in `explore/tests/test_explore.py`.

### explore action scope write

- Where: `explore/bin/explore-action:24-25`, `:54-56`, `:61`, `:110`
- States: scope absent; scope current; scope empty during write; scope new
- Transitions:
  - scope current -> new: `print -r -- ... > "$session/scope"` truncates, then writes. Enforced at `explore/bin/explore-action:25`, `:61`.
  - result -> file: temp file, then `mv`. Enforced at `explore/bin/explore-action:54-56`.
  - multi-item move -> partial: a failure stops after some items. Enforced at `explore/bin/explore-action:110`.
- Gaps:
  - G1: the scope file is empty between open and write. An empty scope makes `explore-src` exit 1 with no output (observed, no verdict of its own). Verdict: confirmed (narrow). Evidence: r2 P8: `f writer: rc=0 size_between_open_and_write=0`. Task: dotfiles-630.
  - G2: a multi-item move can stop after some items. Verdict: unverified. Evidence: the message at `explore/bin/explore-action:110` says earlier items may have completed; no test and no run. Task: dotfiles-657 (item 3).
- Tests: none found for the scope file.

### explore installer for television

- Where: `explore/install-television.sh:3`, `:39`, `:43`
- States: patch step; build step; done
- Transitions:
  - patch fails -> exit before build. Enforced at `explore/install-television.sh:3` (`set -eu`), `:39`.
  - patch done -> build. Enforced at `explore/install-television.sh:43`.
- Gaps:
  - G1: an unreadable patch leaves a partial build. Verdict: refuted. Evidence: r2 run: `h unreadable patch: rc=1`; `build (cargo build) ran: False`; `h dest exists: False`. Task: none (refuted, finding #6795).
- Tests: none found for the installer.

### explore test socket guard

- Where: `explore/tests/test_explore.py:344-346`, `:403-411`
- States: short TMPDIR (run); long TMPDIR (skip)
- Transitions:
  - path over 100 bytes -> `skipTest`. Enforced at `explore/tests/test_explore.py:345-346`.
- Gaps:
  - G1: the guard's premise does not reproduce. nvim bound a 180-byte absolute path and answered RPC; the cause of the bind success was not checked. Verdict: refuted (premise). Evidence: r2 P10: `bytes=180`, `socket_file_seen=True`, `rpc rc=0 out=2`. Task: dotfiles-631 (removes the guard; finding #6795 holds the refutation).
  - G2: the TUI test has no guard and fails on the `lsof` truncation. Verdict: confirmed (same cause as explore socket discovery G1). Evidence: suite `errors=1` in three runs. Task: dotfiles-631.
- Tests: this block is a test guard; see `explore/tests/test_explore.py:403-411`.

### tuios install-fork

- Where: `tuios/install-fork.sh:15-60`; `tuios/tests/test_install_fork.py`
- States: Go checked; legacy migrated; dirty refusal (exit 1); fetched and fast-forwarded; cloned; building; staged (`tuios.new`); installed; backed up; verified
- Transitions:
  - start -> dirty refusal: a dirty source tree exits 1. Enforced at `tuios/install-fork.sh:26-29`.
  - source present -> fast-forwarded: fetch, checkout, ff-only; a diverged tree exits and keeps the binary. Enforced at `tuios/install-fork.sh:30-34`.
  - source absent or empty -> cloned. Enforced at `tuios/install-fork.sh:36`.
  - built -> staged -> installed: build to `tuios.new`, then `mv -f`. Enforced at `tuios/install-fork.sh:42-47`, `:48`.
  - regular file -> backup: `mv "$link" "$link.bak"`. Enforced at `tuios/install-fork.sh:55`.
  - linked -> verified: `"$link" --version | head -n 1`. Enforced at `tuios/install-fork.sh:60`.
- Gaps:
  - G1: two installs share the staged name `tuios.new`, and one fails at the `mv`. Verdict: confirmed. Evidence: r2 P11: `run A: rc=1 stderr='mv: rename ... tuios.new'`; run B rc 0. Task: dotfiles-632.
  - G2: the pipe to `head` hides the install's exit status. Verdict: confirmed. Evidence: r2 P12: `j install with broken fork: rc=0`; the same binary run directly: `rc=1 stderr='fork crashed'`. Task: dotfiles-633.
  - G3: an older `.bak` file is overwritten. Verdict: confirmed. Evidence: r2 P13: `k older backup overwritten: True`. Task: dotfiles-634.
  - A non-empty source folder without `.git` makes the clone exit 128; the stray file stays and no install runs. Verdict: confirmed (fails safe). Evidence: round 1 clone-branch probe: exit 128, "already exists and is not an empty directory". Task: note on dotfiles-444 (#6790, item 3).
- Tests: `tuios/tests/test_install_fork.py:76-84`, `:86-92`, `:94-104`, `:106-112`. The clone branch (`tuios/install-fork.sh:36`) is not pinned. Round 2 run: `Ran 4 tests`, `OK`; round 2 did not read the file in full (dotfiles-657 item 7).

### tuios wrapper

- Where: `tuios/bin/tuios:2-12`
- States: fork binary; Homebrew binary; not found (exit 127)
- Transitions:
  - fork binary executable -> run it. Enforced at `tuios/bin/tuios:7`.
  - else Homebrew binary. Enforced at `tuios/bin/tuios:8-10`.
  - else exit 127. Enforced at `tuios/bin/tuios:11-12`.
- Gaps:
  - A fork binary that is executable but fails has no fallback. Verdict: by design. Evidence: wrapper header at `tuios/bin/tuios:2-4`. Task: none (by design, finding #6795).
- Tests: none found.

### probe-ghostty-metrics restore

- Where: `tuios/bin/probe-ghostty-metrics.py:89`, `:93`, `:95-105`, `:115-117`, `:126`; `tuios/tests/test_ghostty_metrics_probe.py`
- States: raw mode; query sent; reply read; restored; reported
- Transitions:
  - query error -> finally restore -> error report. Enforced at `tuios/bin/probe-ghostty-metrics.py:93`, `:95-105`, `:126`.
- Gaps:
  - G1: a failed restore replaces the original error. Verdict: confirmed (low). Evidence: r2 P16: control `Timed out waiting for the cell-pixel response (2 seconds).`; fault run reports `"injected restore failure"`. Task: dotfiles-636.
  - G2: late or malformed reply bytes stay queued as shell input. Verdict: unverified. Evidence: round 1 probe `probe_metrics_leftover.py` only; round 2 did not find its output. Task: dotfiles-657 (item 1).
  - SIGKILL and SIGSTOP are not handled. Verdict: by design. Evidence: epilog at `tuios/bin/probe-ghostty-metrics.py:115-117`. Task: none (by design, finding #6795).
- Tests: `tuios/tests/test_ghostty_metrics_probe.py` (grep only: 4 matches for restore or tcsetattr).

### tuios dock machine label

- Where: `tuios/bin/dock-machine.py:66`, `:187-190`
- States: unknown (host `?`); local label; remote prompt label; ssh active; ssh unknown
- Transitions:
  - focused window read -> process snapshot -> `ps -p` lookup: three separate reads. Enforced at `tuios/bin/dock-machine.py:187`, `:188`, `:190`.
  - `active_ssh` walks the process tree for at most 32 passes; no result gives the local label.
  - `focused_window` waits 0.3 s per receive. Enforced at `tuios/bin/dock-machine.py:66`.
- Gaps: none found with a verdict. Three candidates are in the list at the end of this heading.
- Tests: `tuios/tests/test_dock_machine.py` (17 tests, OK).

### tuios dock clock

- Where: `tuios/config.toml:207-221`
- States: time shown; sleeping to the next minute
- Transitions:
  - loop: read the date, print it, sleep to the minute boundary. Enforced at `tuios/config.toml:207-221`.
- Gaps:
  - The clock can be stale after a laptop sleep and wake. Verdict: unverified. Evidence: `e5-scripts_notes-tuios.md`: the audit could not suspend the machine. Task: dotfiles-657 (item 6).
- Tests: `tuios/tests/test_dock_clock.py` (2 tests).

### ghostty launcher

- Where: `ghostty/tuios-launcher.py:14-22`, `:30`, `:32`, `:36-45`, `:46-56`, `:57-67`, `:77-81`; `ghostty/test-tuios-launcher.py:138-198`
- States: waiting for lock; listing sessions; choosing (attach, new or restore); confirming clients; done; failed
- Transitions:
  - waiting -> listing: `flock(LOCK_EX)` with no time limit. Enforced at `ghostty/tuios-launcher.py:30`.
  - listing -> failed: the `ls` read has a 2 s timeout; `TimeoutExpired` reaches the handler and exits 1. Enforced at `ghostty/tuios-launcher.py:14`, `:32`, `:79`.
  - listing -> choosing: attach the newest detached session, start a new one, or restore on rc 3. Enforced at `ghostty/tuios-launcher.py:36-43`.
  - confirming: poll with a 15 s deadline; list-clients errors are tolerated. Enforced at `ghostty/tuios-launcher.py:46-56`, `:49-51`.
  - done: unlock, wait, then terminate or kill in `finally`. Enforced at `ghostty/tuios-launcher.py:57-67`.
- Gaps:
  - G1: a hung first `ls` ends the launcher with exit 1 after 2 s, with no retry. The note on dotfiles-444 calls this timeout refuted; the round 2 run contradicts that. Verdict: confirmed. Evidence: r2 run: `first: rc=1 done_at=2.0s ... timed out after 2 seconds`; the second run gives the same. Task: dotfiles-425 (note #6760).
  - G2: the lock wait has no time limit. Verdict: by design. Evidence: `ghostty/test-tuios-launcher.py:138-157` pins the wait; suite `Ran 9 tests`, `OK`. Task: none (by design, finding #6795).
  - G3: list-clients errors are tolerated, and no test pins that. Verdict: by design. Evidence: comment at `ghostty/tuios-launcher.py:51`: "The client may still be starting the daemon." Task: dotfiles-657 (item 8, the missing test).
  - G4: `TimeoutExpired` from the launcher's `ls` may go unhandled. Verdict: refuted. Evidence: r2 run: the exception reaches the handler at `ghostty/tuios-launcher.py:79` and prints a message with no traceback. Task: none (refuted, finding #6795).
  - An empty list-clients reply, or a row without keys, ends the launcher with rc 1. The handler at `ghostty/tuios-launcher.py:49-51` catches only `CalledProcessError` and `TimeoutExpired`. Verdict: confirmed (latent). Evidence: round 1 `probe_listclients.py` exit 0: empty reply gives rc 1 in 0.07 s; a row without keys gives rc 1 in 0.08 s with `'pid'`. Task: note on dotfiles-444 (#6790, item 1).
- Tests: `ghostty/test-tuios-launcher.py:138-157` (lock wait), `:159-173` (attach), `:175-187` (bad listing; failed client releases lock), `:189-198` (deadline; lock release).

### shell vp launcher

- Where: `shell/bin/vp:3-25`; `shell/test-vp-launcher.py`
- States: project vp found; caller vp found; not found (exit 127)
- Transitions:
  - walk up for the project's `node_modules/.bin/vp`. Enforced at `shell/bin/vp:3-10`.
  - else walk `ps` args for the caller's vp, with a word split. Enforced at `shell/bin/vp:13-23`, `:16`.
  - else exit 127. Enforced at `shell/bin/vp:24-25`.
- Gaps:
  - G1: a project path with a space splits in the word loop, and the wrapper exits 127. Verdict: confirmed. Evidence: r2 P6: control `rc=0 stdout='CALLER-VP ran: from-wrapper'`; spaced path `rc=127 ... stderr='vp: no node_modules/.bin/vp in ...'`. Task: dotfiles-628.
- Tests: `shell/test-vp-launcher.py:33-63` (four cases; none with a space). Run: `Ran 4 tests`, `OK`.

### shell startup cache

- Where: `shell/cache.zsh:49-50`, `:66`, `:70-115`, `:117`; `shell/test-startup-fixes.py`
- States: no cache (live fallback); cache current (reused); regenerating; old cache kept after a failure; failed
- Transitions:
  - cache unusable -> live fallback. Enforced at `shell/cache.zsh:49-50`.
  - insecure folder or file -> not used. Enforced at `shell/cache.zsh:74-78`, `:82-86`.
  - signature match -> reuse. Enforced at `shell/cache.zsh:90`, `:117`.
  - generator fails, or the new file fails the syntax check -> keep the old cache. Enforced at `shell/cache.zsh:91-95`, `:104-109`.
  - temp write fails, or `mv` fails -> failed. Enforced at `shell/cache.zsh:97-103`, `:110-115`.
- Gaps:
  - A generator or syntax failure keeps the old cache. Verdict: by design. Evidence: `shell/cache.zsh:92-93`, `:106-107`; `shell/test-startup-fixes.py:171-183`. Task: none (by design, finding #6795).
  - Non-exported variables are not part of the signature. Verdict: by design. Evidence: `shell/cache.zsh:66`; `shell/test-startup-fixes.py:258-260`. Task: none (by design, finding #6795).
  - A switch between exported values regenerates the cache each time (cost only). Verdict: by design. Evidence: `shell/test-startup-fixes.py:255-256`. Task: none (by design, finding #6795).
- Tests: `shell/test-startup-fixes.py:171-183`, `:255-260`.

### shell startup-fix install

- Where: `shell/apply-startup-fixes.py:101-118`, `:126-130`, `:131-141`
- States: both files old; first file replaced; both files replaced
- Transitions:
  - transform both files -> write backups -> `os.replace` per file. Enforced at `shell/apply-startup-fixes.py:101-118`, `:126-130`, `:131-141`.
- Gaps:
  - A failure of the second replace leaves `.zshrc` new and `.bashrc` old. A second run fixes it. Verdict: confirmed. Evidence: round 1 `probe_partial_install.py` exit 0. Task: dotfiles-656.
- Tests: `shell/test-startup-fixes.py:436-517` (refusals before any write only).

### config-sync live-suite lock

- Where: `config-sync/config_sync.py:66`, `:135-153`, `:211`, `:287-297`; `config-sync/tests/test_config_sync.py:436-522`
- States: absent; held (live pid, age under MAX_HOLD); stale; removed
- Transitions:
  - held -> check skipped. Enforced at `config-sync/config_sync.py:287-297`; late check at `:211`.
  - held -> stale: pid dead, unparsable, zero, negative or huge; or age >= MAX_HOLD. Enforced at `config-sync/config_sync.py:135-153`.
  - stale -> removed: unlink. Enforced at `config-sync/config_sync.py:150`.
- Gaps:
  - G3: a lock that appears after the late check (211) and before the merge (243) does not stop the pull. Verdict: confirmed (narrow window). Evidence: round 1 case P3: control skips; with the lock taken during the merge, HEAD moved. Task: dotfiles-650.
  - G10: a lock renewed after `holds()` reads it is still unlinked. Verdict: confirmed (narrow). Evidence: r2 P17: `renewal landed before unlink: pid alive = True`; `g10 race: held = [] | lock exists = False`. Task: dotfiles-637.
  - G12: a live run older than MAX_HOLD loses its lock. Verdict: by design. Evidence: `config-sync/config_sync.py:66`; `config-sync/tests/test_config_sync.py:506-522`; suite `Ran 42 tests`, `OK`. Task: none (by design, finding #6795).
- Tests: `config-sync/tests/test_config_sync.py:436-522` (held; lock during fetch; released; unreadable entry stale; stale removed).

### config-sync checkout sync

- Where: `config-sync/config_sync.py:204-259`
- States: fetch-failed; off-main; dirty; diverged; pull-failed; restored; pulled; current
- Transitions:
  - branch read -> off-main: `symbolic-ref` gives no main branch. Enforced at `config-sync/config_sync.py:214`, `:236`.
  - `git status` -> dirty: changed files stop the pull. Enforced at `config-sync/config_sync.py:217`, `:223`, `:237`.
  - clean -> pulled: merge. Enforced at `config-sync/config_sync.py:243`.
  - pulled -> links checked. Enforced at `config-sync/config_sync.py:252-258`.
- Gaps:
  - G2: a failing `git status` (rc 128) gives an empty change list. The dirty guard is skipped and the pull runs over an unreported dirty tree. Verdict: confirmed. Evidence: round 1 case P2: `HEAD_moved=True, board_calls=0, reported=[]`. Task: dotfiles-649.
  - G6: a folder that is not a git repository is reported as "off-main: detached HEAD". The fetch failure stays hidden for 24 h. Verdict: confirmed. Evidence: round 1 case P6: the report signature shows detached HEAD. Task: dotfiles-653.
- Tests: none found for G2 or G6.

### config-sync report

- Where: `config-sync/config_sync.py:262-281`, `:311-319`; `config-sync/tests/test_config_sync.py:382-387`
- States: not reported; reported as feedback; reported as feedback-plain; reported as notification
- Transitions:
  - new problem signature -> report by the first channel that works. Enforced at `config-sync/config_sync.py:270-281`.
  - report -> `state.reported` saved: the report is filed at 314, the state is saved at 319. Enforced at `config-sync/config_sync.py:311-319`.
- Gaps:
  - G5: when the board and `osascript` both fail, the notification is recorded as delivered. No later report follows. Verdict: confirmed. Evidence: round 1 case P5: run 2 makes 0 calls; the rc at `config-sync/config_sync.py:280` is not checked. Task: dotfiles-652.
- Tests: `config-sync/tests/test_config_sync.py:382-387` uses a fake `osascript` with rc 0.

### config-sync fetch grace

- Where: `config-sync/config_sync.py:55`, `:289-297`, `:300-305`; `config-sync/tests/test_config_sync.py:449-464`
- States: fetch ok; failing inside the 24 h grace; failing and reported
- Transitions:
  - fetch fails -> `fetch_failing_since` set; over FETCH_GRACE -> reported. Enforced at `config-sync/config_sync.py:55`, `:300-305`.
  - check skipped by the lock -> fetch outcome dropped. Enforced at `config-sync/config_sync.py:289-297`.
- Gaps:
  - G4: a lock taken during a failed fetch drops the failure, so the grace restarts. Verdict: confirmed. Evidence: round 1 case P4: run 1 `since=None`; run 2 `since=+1h`; report at +25 h, not +24 h. Task: dotfiles-651.
- Tests: `config-sync/tests/test_config_sync.py:449-464` pins the head only.

### config-sync settings restore

- Where: `config-sync/config_sync.py:183-201`, `:223-233`; `config-sync/tests/test_config_sync.py:235-312`
- States: committed; reformatted; restored; kept and reported
- Transitions:
  - reformatted -> restored: same JSON and no write since the read. Enforced at `config-sync/config_sync.py:185-198`.
  - write before the check at 196 -> kept and reported. Enforced at `config-sync/config_sync.py:196-197`.
  - write between the check at 196 and the replace at 198 -> overwritten. Enforced at `config-sync/config_sync.py:196-198`.
  - committed text is read in text mode. Enforced at `config-sync/config_sync.py:224`.
- Gaps:
  - G7: a session write between the check at 196 and the replace at 198 is overwritten. Verdict: confirmed (round 1 run; the lines still hold). Evidence: round 1 case P8: session write `kept: False`; the test at `config-sync/tests/test_config_sync.py:287-303` never reaches this window. Task: dotfiles-641.
  - G11: a CRLF committed file is restored as LF. The file then differs from HEAD and the next pull fails. Verdict: confirmed (latent: the committed file is LF today). Evidence: r2 P18: `worktree bytes equal HEAD blob = False`; run 2 `pulled = False problems = ['pull-failed']`. Task: dotfiles-638.
  - G13: non-UTF-8 bytes raise `UnicodeDecodeError` in check and sync, and `state.json` is not written. Verdict: confirmed (narrow). Evidence: r2 P19; the read at `config-sync/config_sync.py:185` sits outside any try. Task: dotfiles-639.
- Tests: `config-sync/tests/test_config_sync.py:235-312` pins the restore, the kept write (287) and the failed restore (305). None pins G7, G11 or G13.

### config-sync state files

- Where: `config-sync/config_sync.py:104-109`, `:112-116`, `:119-122`
- States: state absent; state loaded; state saved through `state.tmp`; event appended
- Transitions:
  - load: `load_state`. Enforced at `config-sync/config_sync.py:104-109`.
  - save: write `path.with_suffix(".tmp")`, then replace. Enforced at `config-sync/config_sync.py:112-116`.
  - event: append to `events.jsonl`. Enforced at `config-sync/config_sync.py:119-122`.
- Gaps:
  - G1: a corrupt `state.json` makes every check raise `JSONDecodeError`. No pull and no board call follow. Verdict: confirmed. Evidence: round 1 case P1: raise in 2 attempts, file unchanged. Task: dotfiles-648.
  - G8: two check processes share `state.tmp`, so one `save_state` can raise `FileNotFoundError`. The report is filed before the save, so the next run files it again. Verdict: confirmed (mechanism; 3 trials with real processes gave no crash). Evidence: round 1 case P7b. Task: dotfiles-654.
  - G9: `events.jsonl` and `launchd.log` have no rotation. Verdict: confirmed (low). Evidence: round 1 case P9: 200 skips give 24800 bytes, 124 bytes per skipped check. Task: dotfiles-655.
  - Hygiene, not a state machine: a bytecode file under `config-sync/tests/__pycache__/` is tracked in git. Verdict: confirmed. Evidence: r2 P15: `git ls-files config-sync/tests | grep -c pyc` gives `1`. Task: dotfiles-635.
- Tests: none found for an invalid `state.json`.

### config-sync launch agent install

- Where: `config-sync/config_sync.py:348-367`; `config-sync/tests/test_config_sync.py:537-558`
- States: plist absent; plist written; unloaded; loaded
- Transitions:
  - plist written -> bootout (rc ignored) -> bootstrap; a failed bootstrap exits 1. Enforced at `config-sync/config_sync.py:359-365`.
- Gaps:
  - G14: a failed bootstrap leaves the plist and an unloaded agent. Verdict: confirmed. Evidence: r2 P20: `g14 install exit = 1 | calls = ['launchctl bootout', 'launchctl bootstrap']`; `plist exists after = True`. Task: dotfiles-640.
- Tests: `config-sync/tests/test_config_sync.py:537-558` pins the plist fields and the dry run only.

### disk-alert alert level

- Where: `disk-alert/disk_space_alert.py:72`, `:85`, `:156-181`
- States: ok; low; critical
- Transitions:
  - level change with hysteresis 2.0. Enforced at `disk-alert/disk_space_alert.py:72`, `:156-168`.
  - alert plan (24 h reminder; retry on pending). Enforced at `disk-alert/disk_space_alert.py:171-181`.
- Gaps: none found.
- Tests: `disk-alert/tests/test_disk_space_alert.py:77-92`, `:95-119`.

### disk-alert state file

- Where: `disk-alert/disk_space_alert.py:188-210`, `:213-217`
- States: missing; valid; invalid (fresh state with a warning)
- Transitions:
  - invalid file -> fresh `State()` with a stderr "Ignoring" line. Enforced at `disk-alert/disk_space_alert.py:193-209`.
  - save: `.tmp`, then rename, with no fsync. Enforced at `disk-alert/disk_space_alert.py:213-217`.
- Gaps: none found.
- Tests: `disk-alert/tests/test_disk_space_alert.py:805-824`.

### disk-alert episode thread

- Where: `disk-alert/disk_space_alert.py:768`, `:798`, `:810-842`, `:845-895`; `disk-alert/tests/test_disk_space_alert.py:123-215`
- States: no thread; thread; pending retry; reset (fresh state)
- Transitions:
  - thread -> same thread: send returns 0. Enforced at `disk-alert/disk_space_alert.py:822-827`.
  - send fails or times out -> new thread: start runs. Enforced at `disk-alert/disk_space_alert.py:822-827`, `:832-839`.
  - start with no id, or a timeout -> thread id dropped. Enforced at `disk-alert/disk_space_alert.py:836-839`, `:881`.
  - failed recovery notify -> reset. Enforced at `disk-alert/disk_space_alert.py:860-866`.
- Gaps:
  - DA-G1: a send that times out (rc 124) starts a second thread. Verdict: confirmed (round 1 run). Evidence: r2 P22, round 1 output: `[["thread", "send"], 124, "timed out after 1 seconds"]`, then `[["thread", "start"], 0, ""]`; the control has no start. Task: dotfiles-642.
  - DA-G1b: the send error is dropped from the record (`t3_error` is null). Verdict: confirmed (round 1 run). Evidence: the same run as DA-G1. Task: dotfiles-642.
  - DA-G2: a start that prints no id, or times out, leaves no thread id. The next episode starts a second thread. Verdict: confirmed (round 1 run). Evidence: r2 P22, round 1 output: `later_calls: ["start", "notify"]`, `later_thread: "mcp:new-2"`. Task: dotfiles-642.
  - DA-G7: a failed recovery notify resets the state, and the error appears only in events. Verdict: confirmed (low; round 1 run). Evidence: r2 P26, round 1 output: `"notify_error": "osascript exit 1: refused"`; `"state_after": {"level": "ok", "pending": false, "thread_id": null}`. Task: dotfiles-646.
- Tests: `disk-alert/tests/test_disk_space_alert.py:150`, `:168`, `:193`, `:204`, `:215`. Not pinned: DA-G1, DA-G1b, DA-G2 after a failed send, DA-G7.

### disk-alert sweeps

- Where: `disk-alert/disk_space_alert.py:280-290`, `:456-493`, `:560`, `:573`, `:593`, `:610-663`, `:666-702`, `:948-969`; `disk-alert/tests/test_disk_space_alert.py:304-404`, `:473`, `:617-781`
- States: folder idle, in use, removed; build lock listed, held, released; process snapshot read or unreadable
- Transitions:
  - idle -> removed: the scan says idle; the recheck reads only `<session>.jsonl`. Enforced at `disk-alert/disk_space_alert.py:481`.
  - listed -> locked: lock files are listed before the locks are taken. Enforced at `disk-alert/disk_space_alert.py:630-631`.
  - unreadable snapshot -> step ends. Enforced at `disk-alert/disk_space_alert.py:476-477`, `:288`.
  - `removable` error -> skipped. Enforced at `disk-alert/disk_space_alert.py:638-641`.
  - sweeper -> sweeper: no lock between runs. Enforced at `disk-alert/disk_space_alert.py:948`.
- Gaps:
  - DA-G3: a write to the scratch folder or a subagent transcript during the process check is missed, and the folder is removed. Verdict: confirmed (round 1 run). Evidence: round 1 output: `scratch-write {"folder_exists": false ...}`, `subagent-write {"folder_exists": false ...}`; control `folder_exists: true`. Task: note on dotfiles-437 (#6789).
  - DA-G4: two sweepers can run at once. The second removes the folder and the first exits 1. Verdict: confirmed (round 1 run). Evidence: r2 P23, round 1 output: `nested-session {"events": ["swept", "swept"], "first_exit": 1 ...}`. Task: dotfiles-643.
  - DA-G5: an unreadable process list ends the sessions step with no event, and the targets step returns with no record. Verdict: confirmed (round 1 run). Evidence: r2 P27, round 1 output: sessions `{"events": ["escalated"], "folder_exists": true}`; targets `{"swept": [], "target_built": true}`. Task: dotfiles-647.
  - DA-G6: an OSError from `removable()` is skipped with no record. Verdict: confirmed (by mock; the real trigger is a race only). Evidence: r2 P27, round 1 output: `removable-raises {"failures": [], "swept": []}`; the control sweeps. Task: dotfiles-647.
  - DA-G8: a build that starts after the lock listing and before the lock is taken loses its release folder. Verdict: confirmed (round 1 run). Evidence: round 1 output: control `release_lock_left: true`; race `release_folder_left: false`. Task: note on dotfiles-437 (#6789).
- Tests: `disk-alert/tests/test_disk_space_alert.py:304` (idle removed), `:337` (running kept), `:473` (time limit), `:655` (held build lock), `:710` (unreadable registry). Not pinned: DA-G3, DA-G4, DA-G5 (no event), DA-G6.

### disk-alert LaunchAgent install

- Where: `disk-alert/disk_space_alert.py:993`, `:997-1028`, `:1031-1052`; `disk-alert/tests/test_disk_space_alert.py:853-873`
- States: plist absent; plist written; unloaded; loaded
- Transitions:
  - plist written (1044) -> bootout (1046, rc ignored) -> bootstrap (1047); a failed bootstrap exits 1. Enforced at `disk-alert/disk_space_alert.py:1044-1050`.
- Gaps:
  - DA-G9: a failed bootstrap leaves the plist and an unloaded agent. The unloaded state follows from launchctl semantics; no real launchctl ran. Verdict: confirmed (round 1 run). Evidence: r2 P24, round 1 output: calls `bootout` then `bootstrap`; `"exit": 1, "plist_written": true`. Task: dotfiles-644.
- Tests: `disk-alert/tests/test_disk_space_alert.py:853`, `:873`. No bootstrap-failure case.

### vimtex tectonic build on save

- Where: `nvim/lua/config/autocmds.lua:26-29`, `:42-66`; `nvim/lua/config/options.lua:31`; `nvim/tests/vimtex.lua:50-73`
- States: idle; queued; waiting; building
- Transitions:
  - idle -> queued: save of a tectonic buffer. Enforced at `nvim/lua/config/autocmds.lua:26-29`.
  - queued -> waiting: the compiler runs; retry in 200 ms. Enforced at `nvim/lua/config/autocmds.lua:55-56`.
  - waiting -> building: the compiler is idle; start. Enforced at `nvim/lua/config/autocmds.lua:58-63`.
- Gaps:
  - G1: number 0 from `is_running()` counts as true in Lua at line 55. The installed plugin returns a Lua boolean, so only a latent risk remains. Verdict: refuted (for the installed plugin). Evidence: r2 P2: `real vimtex idle is_running ...: out=boolean false`; Lua check `0 truthy`, `v:false falsy`. Task: dotfiles-657 (item 4, the latent risk; finding #6795 holds the refutation).
  - G2: a cold TeX cache makes the save test fail: the cold build takes 100.4 s and the test waits 45 s. Verdict: confirmed. Evidence: r2 P1: `tests/vimtex.lua:57: Expected 2 successful builds, got 1`; `elapsed_s=100.4 pdf=True`; the warm run gives rc 0. Task: dotfiles-624.
- Tests: `nvim/tests/vimtex.lua:50-73`. It passes warm and fails cold.

### vimtex Skim protect

- Where: `nvim/autoload/config/vimtex.vim:9-19`; `nvim/scripts/protect-skim-notes.js:13-15`; `nvim/tests/protect-skim-notes.test.js`
- States: no PDF; annotated (refused); converted; protected; osascript running
- Transitions:
  - call -> osascript runs the script. Enforced at `nvim/autoload/config/vimtex.vim:9-19`.
  - annotated PDF -> refused. Enforced at `nvim/scripts/protect-skim-notes.js:13-15`.
- Gaps:
  - G1: `system()` waits for osascript with no time limit. Verdict: confirmed. Evidence: r2 P3: `B hung osascript: timed_out_after_8s=True result_written=False`; control `rc=0 ... result_written=True`. Task: dotfiles-625.
  - G2: the refusal has no test; the suite keeps 4 passes without it. Verdict: confirmed. Evidence: r2 P4: shipped script rc 1 with the refusal text; refusal lines removed, rc 0; `bun test` gives 4 pass in both cases. Task: dotfiles-626.
  - G3: the branch for a running Skim was not exercised; it needs Skim and the screen. Verdict: unverified. Evidence: no run (`e5-scripts_r2_machines-2.md`). Task: dotfiles-657 (item 9).
- Tests: `nvim/tests/protect-skim-notes.test.js` (4 pass; no refusal case).

### bun-outdated

- Where: `nvim/scripts/bun-outdated.js:25-26`; `nvim/tests/bun-outdated.test.js`
- States: rows read; names mapped; dependency entries
- Transitions:
  - row -> dependency entry; a later row overwrites an earlier one. Enforced at `nvim/scripts/bun-outdated.js:25-26`.
- Gaps:
  - G1: two workspace rows for one package keep only the last row. Verdict: confirmed. Evidence: r2 P5: `stdout='{"left-pad":{"current":"1.0.0","wanted":"1.0.0","latest":"1.3.0"}}'`; the 1.1.0 row is missing. Task: dotfiles-627.
- Tests: `nvim/tests/bun-outdated.test.js` (4 pass; no duplicate-row case).

### dashboard harness data folder

- Where: `nvim/tests/dashboard.py:68`, `:72-83`
- States: harness start; run loop; exit
- Transitions:
  - start -> run loop. Enforced at `nvim/tests/dashboard.py:68`.
  - data folder comes from HOME; the argv sets no `XDG_DATA_HOME`. Enforced at `nvim/tests/dashboard.py:72-83`.
- Gaps:
  - G1: the harness data folder follows HOME when HOME is inherited. Verdict: confirmed (low). Evidence: r2 P25: `D harness env, HOME inherited: rc=0`, data folder under the real home; a fake HOME moves it. Task: dotfiles-645.
  - G2: `run_loop(None, ...)` has no time limit (`nvim/tests/dashboard.py:68`). Verdict: unverified. Evidence: no run; the probe needs pynvim in the scratch environment. Task: dotfiles-657 (item 2).
- Tests: this block is a test harness; no test of the harness found.

### lazy bootstrap prompt

- Where: `nvim/lua/config/lazy.lua:9-12`
- States: clone ok; clone failed; waiting for key; exit
- Transitions:
  - failed clone -> prompt -> key read -> `os.exit(1)`. Enforced at `nvim/lua/config/lazy.lua:9-12`.
- Gaps:
  - G1: the prompt waits with no time limit. Verdict: by design. Evidence: prompt text at `nvim/lua/config/lazy.lua:9` ("Press any key to exit..."); r2 run `still waiting after 3 s=True`. Task: none (by design, finding #6795).
- Tests: none found.

### untracked file cache

- Where: `git/shared.gitconfig:9`
- States: cache off; cache on and current; cache stale
- Transitions:
  - restored folder mtime -> git rescans. Enforced by git, not by this file.
- Gaps:
  - G1: an mtime-only restore hides new untracked files. Verdict: refuted (APFS). Evidence: r2 run: `A cache on, dir mtime restored to 2020: rc=0 new.txt listed=True`; ctime moves to now after the restore. Task: none (refuted, finding #6795).
- Tests: none found.

### cargo test harness

- Where: `cargo/tests/test_cargo_config.py:63`
- States: RUSTUP_HOME from the environment; RUSTUP_HOME from the home folder
- Transitions:
  - environment unset -> home folder default. Enforced at `cargo/tests/test_cargo_config.py:63`.
- Gaps:
  - G1: the tests depend on the real HOME when RUSTUP_HOME is unset. Verdict: confirmed. Evidence: r2 P14: fake HOME gives `Ran 5 tests`, `FAILED (failures=4)`; fake HOME with RUSTUP_HOME gives `OK`. Task: note on dotfiles-555 (#6788).
- Tests: `cargo/tests/test_cargo_config.py` (105 lines).

### t3code settle_children plan

- Where: `t3code/settle_children.py`; `t3code/settle-children.prompt.md:19-20`; `t3code/tests/test_settle_children.py`
- States: plan built (snapshot); plan printed; verified
- Transitions:
  - query -> plan: the plan is a snapshot of the query. No line reference in the records.
  - plan -> settle: the prompt says T3 refuses an active thread (`t3code/settle-children.prompt.md:19-20`).
- Gaps:
  - The printed plan keeps a child that starts a run after the query. The consequence depends on T3 refusing an active thread, which no run checked. Verdict: unverified (the snapshot itself is confirmed). Evidence: round 1 `probe_settle_plan.py` exit 0: fresh query `[]`, printed plan still `[child]`. Task: dotfiles-657 (item 5).
- Tests: `t3code/tests/test_settle_children.py` (Ran 19, OK).

### t3code prune_branches delete window

- Where: `t3code/prune_branches.py:67`, `:360`, `:373-377`; `t3code/tests/test_prune_branches.py:793-810`
- States: branch listed; rechecked; blocked; deleted; deleted with archive ref
- Transitions:
  - listed -> rechecked: fresh read. Enforced at `t3code/prune_branches.py:360`.
  - rechecked -> blocked: `blocking_reason`, then the check for a restored abandoned thread. Enforced at `t3code/prune_branches.py:373`, `:374-375`.
  - rechecked -> deleted: `delete_branch`. Enforced at `t3code/prune_branches.py:377`.
  - lookups have a 60 s timeout. Enforced at `t3code/prune_branches.py:67`.
- Gaps:
  - A run that starts between the read at 360 and the delete at 377 loses its branch. Verdict: confirmed. Evidence: round 1 `probe_prune_window.py` exit 0: branch deleted, run status `running`. Task: note on dotfiles-444 (#6790, item 2).
  - An abandoned thread restored in the same window loses its branch; the work stays in the archive ref. Verdict: confirmed. Evidence: the same probe: deleted with archive, thread `archived_at None`. Task: note on dotfiles-444 (#6790, item 2).
- Tests: `t3code/tests/test_prune_branches.py:793-810` pins a restore during the lookups, before the read at 360. The 360-377 window is not pinned. Suite: Ran 57, OK.

#### Candidates without a verdict

- `explore_foreground` uses two `ps` reads for one decision (`explore/bin/explore-dispatch:42-66`, reads at 48 and 62). Task: dotfiles-744.
- `explore-key` rechecks the zle marker and then sends keys; a small window stays between them (`explore/bin/explore-key:22-29`). Task: dotfiles-744.
- dock-machine: an ssh chain deeper than 32 passes gives the local label (`tuios/bin/dock-machine.py`, `active_ssh`; round 1 probe with depth 40). Task: dotfiles-744.
- dock-machine: a reply that trickles 67 bytes at 0.05 s takes 3.73 s, because the 0.3 s timeout is per receive (`tuios/bin/dock-machine.py:66`). Task: dotfiles-744.
- dock-machine: an ssh exit between the snapshot and the lookup gives host `?` (`tuios/bin/dock-machine.py:187-190`). Task: dotfiles-744.
- No repository test loads the whole `tuios/config.toml` with the fork's loader (`tuios/config.toml:8-10`; only `tomllib` at `tuios/tests/test_dock_machine.py:161`). Task: dotfiles-744.
- A dock component failure hides its cell; the engine is outside the repository (`e5-scripts_notes-tuios.md`, doc lines 111-113). Task: dotfiles-744.
- The lock file `ghostty/tuios-launcher.lock` is tracked in git (hygiene). Task: dotfiles-744.
- The `git()` helper of prune_branches has no timeout; it runs local git only (`t3code/prune_branches.py:169-178`). Task: dotfiles-744.
- The config-sync agent (every 1800 s) and a separate hourly pull agent both fast-forward the same checkout with only git's index lock (`e5-scripts_notes-config-sync.md`, LaunchAgent facts). Task: dotfiles-744.
- How tuios loads `tuios/themes/nocturne.json` is unverified; nothing in `tuios/` or the install scripts names the file. Task: none (no work, note #6794).
