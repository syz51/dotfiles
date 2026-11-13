# Probes for the round 2 confirmed gaps (dotfiles-546)

Run from any shell. Each block sets its own paths. Every block uses fake binaries only. Blocks assume the exports at the top of `rerun.sh` (HOME, TMP, TMPDIR and the stub guards), or run through it.
Round 1 blocks (P1 to P22) stay in `scratchpad/e4-factory-b/probes.md`. P15 has a round 2 extension below.
Stub guards: `CLAUDE_FACTORY_BIN` and `BOARD_BENCH_CLAUDE` point at `$R/fakes/claude-stub.sh` (exit 99, logs calls).
Group runs: `bash "$R/probes/rerun.sh" A`, `B`, `C`. Summary: `$R/tmp/rerun/summary.txt`.

Common header for every block:

```
R=<scratch>/r4-factory-b
P=$R/probes
CLONE=$R/clone
```

## U1. Unlock has no owner check (ui/run.js:76)

```
env XDG_DATA_HOME="$R/home/.local/share" bun "$P/u1-unlock.js" main; echo "exit=$?"
env XDG_DATA_HOME="$R/home/.local/share" bun "$P/u1-unlock.js" control; echo "exit=$?"
```

- Expected: `main` exit 0, "B still running when C finished: true". `control` exit 0, B refused.
- Proposed task: "UI run lock: unlock only the lock this run holds". Size S.
- Problem: `unlock` removes the lock without checking its pid. A holder that lost its lock can remove the new holder's lock.
- Change: compare the pid in the lock file before removing it (`ui/run.js:76`).

## U2. openRun checks, then writes (ui/run.js:43-47)

```
env XDG_DATA_HOME="$R/home/.local/share" bun "$P/u2-openrun.js" 12; echo "exit=$?"
```

- Expected: exit 0, at least one trial with "already exists". Earlier runs: 8 of 12 and 16 of 16.
- Proposed task: "UI openRun: create run.json exclusively". Size S.
- Change: write `run.json` with an exclusive create (`wx`) and treat "exists" as a refusal.

## U12. Lock steal is not atomic (ui/run.js:82-91)

```
for mode in plain delay solo fresh; do env SCR="$R" bun "$P/r2-steal-driver.js" "$mode"; echo "mode=$mode exit=$?"; done
```

- Expected (round 2, group C): plain "trialsWithTwoAcquisitions=16" of 40; delay 5 of 5; solo 0 of 10; fresh 0 of 20. Earlier plain runs: 24 of 40 and 13 of 40.
- Proposed task: "UI lock: take over a stale lock without a window". Size S.
- Problem: two processes can both see the lock as stale and both acquire it. Not the reused-pid case (dotfiles-442).
- Change: take over by rename, then verify the owner pid before use.

## U4. freePort races the server bind (ui/capture.js:88-97; bench/board/run.js:52-57)

```
env XDG_DATA_HOME="$R/home/.local/share" bun "$P/u4-serve.js" foreign; echo "exit=$?"
env XDG_DATA_HOME="$R/home/.local/share" bun "$P/u4-serve.js" control; echo "exit=$?"
env SCR="$R" bun "$P/r2-port.js" foreign; echo "exit=$?"
```

- Expected: `u4-serve foreign` exit 0, serve returns FOREIGN and the bind fails with EADDRINUSE. `control` exit 0. Bench `r2-port foreign` exit 0, "waitHealthy accepted foreign"; the stub exits 1.
- Proposed task: "Serve and bench wait: bind the port in the server and check its identity". Size S.
- Change: let the server pick its own port and report it, or send a per-run token on `/healthz` and check it.

## U5. Token cache loses counts on a partial failure (bench/board/cli.js:127-142)

```
for mode in partial complete haiku; do env BOARD_BENCH_CLAUDE="$P/tokens-fake.js" bun "$P/u5-tokens.js" $mode; echo "mode=$mode exit=$?"; done
```

- Expected: `partial` exit 0, "claude calls 4", tokens file absent. `complete` exit 0, "calls 5", file present. `haiku` exit 0.
- Proposed task: "bench token cache: save each cell's counts as they finish". Size S.
- Problem: a failure before the cache write drops every count already paid for.

## U10. Token temp folders survive SIGKILL and bench board clean skips them (bench/board/tokens.js:15,27; bench/board/run.js:150)

```
env SCR="$R" BOARD_BENCH_CLAUDE="$R/probes/r2-claude-sleep.sh" bun "$P/r2-tokens-driver.js"; echo "exit=$?"
env TMPDIR="$R/tmp/r2-tokens" TMP="$R/tmp/r2-tokens" HOME="$R/home" XDG_DATA_HOME="$R/home/.local/share" CLONE="$R/clone" BOARD_BENCH_CLAUDE="$R/fakes/claude-stub.sh" bun "$P/u6-matrix.js" clean; echo "exit=$?"
ls "$R/tmp/r2-tokens" | grep -c '^board-bench-tokens-'
```

- Expected: driver exit 0, "tokens folders while running=N after SIGKILL=N child exit=137" with N of 1 or more (earlier 1, 2, 3, 4). Clean exit 0, "Nothing to clean." The last count does not fall (4 before and 4 after in round 2).
- Proposed task: "bench board clean: remove board-bench-tokens folders left by a kill". Size S.
- Change: drop the `tokens-` exclusion at `bench/board/run.js:150`, or remove the folder on start.

## U11. runOne workspace folder survives SIGKILL (bench/runner.js:79,132-134)

Needs the full-history copy `$R/fullclone` and the sleep stub. No API key is passed.

```
env SCR="$R" bun "$P/u-runner-kill.js"; echo "exit=$?"
```

- Expected: "claude-bench folders while running=1 after SIGKILL=1 child exit=null". Exit 0.
- Proposed task: "bench runOne: sweep claude-bench folders from a killed run". Size S.
- Change: remove stale `claude-bench-*` roots in the clean command, or write the root under the run folder.

## U9. UI capture folder survives SIGKILL (ui/capture.js:70-81)

```
env TMP="$R/tmp/uk" TMPDIR="$R/tmp/uk" bun "$P/u-ui-kill.js"; echo "exit=$?"
```

- Expected: "killed holder: extract folders left = 2". "bad sha: Error; folders = 2" (the error path adds none).
- Proposed task: "UI capture: remove stale claude-factory-ui folders". Size S.
- Note: `ui/cli.js` has no clean command. Only `dispose` removes the folder.

## U7 and U8. Calibrate: refused run folder, and the samples help range (ui/cli.js:264-273, :46)

```
bash "$P/calibrate-refused.sh"; echo "exit=$?"
```

- Expected: `--samples 6` and `--samples 1` exit 2 with "run folders: 0". `--samples 5` exit 3, "could cost up to $5.00", "run folders: 1". `--samples 3` exit 3, "$3.00". "judge stub calls: 0".
- Proposed task U7: "UI calibrate: check the budget before opening the run folder". Size S.
- Proposed task U8: "UI help: state the calibrate --samples range from 2 to 5". Size S.

## U3. USAGE does not describe pass, eligibility or the budget reset (ui/cli.js:33-50, :44)

```
env HOME="$R/home" bun "$CLONE/claude/factory/ui/cli.js" --help | grep -ci 'pass\|eligib\|budget'
```

- Expected: 0 matching lines. Exit 0 for the help run.
- Proposed task: "UI USAGE: describe pass, eligibility and the budget reset". Size S.

## P7. A missing round file drops an issue's entry (ui/run.js:105; ui/cli.js:364)

```
env CLONE="$R/clone" bun "$P/p7-full.js"; echo "exit=$?"
```

- Expected: with round-1.json, "home|hierarchy resolved in round 2 (since 1)". Without it, "entries=0".
- Proposed task: "UI ledger: keep an issue when its round file is missing". Size S.

## P18. Unknown contrast backgrounds never reach the totals (ui/checks.js:71-73, :147-159)

```
bun "$P/p18-unknown.js"; echo "exit=$?"
```

- Expected: identical output for unknown 4 and unknown 0.
- Proposed task: "UI gates: count unknown contrast backgrounds in the totals". Size S.
- Change: add `unknown` to `checkTotals` and show it at the gate.

## M16 CLOSED. A cached MERGED or CLOSED PR never refreshes (metrics/github.js:34-36)

```
bun "$P/metrics-closed.js"; echo "exit=$?"
```

- Expected: "PR 1 still CLOSED after reopen", two hours later on a fake clock. PR 2 (OPEN) refreshed, views 2 to 3.
- Proposed task: "metrics PR cache: refresh MERGED and CLOSED entries on the TTL". Size S.
- Change: change the `:35` condition so only the state check counts for OPEN entries.

## U13. A malformed audit baseline gives a stack trace and exit 1 (audit/cli.js:43-44, :91)

```
bash "$P/audit-baseline.sh"; echo "exit=$?"
```

- Expected: "update-baseline exit=0", "ghost count 0". "malformed baseline exit=1" and the line "not an audit baseline".
- Proposed task: "audit: report a malformed baseline as a usage error". Size S.
- Note: usage errors exit 2 (`audit/cli.js:73-74`).

## P15 extension. Two models in one series share a run id (round 1 block: probes.md P15)

```
env BOARD_BENCH_CLAUDE="$P/claude-pattern.sh" TMPDIR="$R/tmp/u6k" HOME="$R/home-u6k" XDG_DATA_HOME="$R/home-u6k/.local/share" bun "$P/u6-matrix.js" run u6k claude-haiku-5-5 1 3 O --keep-streams; echo "exit=$?"
grep -c '"runId":"u6k-1"' "$R/home-u6k/.local/share/claude-factory/bench/board-formats/results.jsonl"
```

- Expected: exit 0. Two records with runId "u6k-1", one per model (opus from the round 2 run, haiku from this one).
- Holder: no open board task. Proposed task (round 1 P15): "bench board: give each model its own run id sequence". Size S.
- Note: the second command's results path follows the layout seen in round 2. Check it before you rely on it.

## P9. Per-run budget only (open question, no task)

```
env XDG_DATA_HOME="$R/home-p9" bun "$P/p9-budget.js"; echo "exit=$?"
```

- Expected: exit 0. Two runs spent 0.9 each, 1.8 in total, against `budgetUsd.run` 1.
- Verdict: per-run cap by design (`claude/skills/ui-climb/SKILL.md:236`). A cap across runs is for the owner. Reason: design or cost.

## Not probed (blocked)

- In-page contrast with a real background (`ui/checks.js:71-73`). Blocked: a headless Chromium install needs a network download.
- UI end-to-end suite (`ui/ui.test.js:870-873`, 13 skipped). Not run, to avoid the skipped live path.
