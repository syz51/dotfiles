# Probes for the confirmed gaps

Run from the scratch copy. `E` is the e2-tooling scratch folder (`<scratch>`); `R` is `$E/repo` (HEAD 3525a13). Use `env -u RUN_CLAUDE_LIVE` and `HOME=$E/home` for every command. Nothing here calls a live model, a paid API or the board, and no step runs `helper.swift`. Timings vary; a race that does not show may need a different start offset.

Gaps not listed here (by design or refuted) have their evidence in `machines.md`.

## P1 Two credit checks for one key (api-first)

- Gap: decide() runs the credit check outside the lock, so two runs check the same key. Verdict: confirmed. Task: dotfiles-425 (its api-first item).
- Commands:
  - `cd "$E/probes" && E="$E" env -u RUN_CLAUDE_LIVE HOME="$E/home" bun probe-dup.js; echo "exit=$?"`
- Expected output: `exit=0`, then two lines:
  - `{"case":"concurrent","checks":2,"first":"ok: probe","second":"ok: probe"}`
  - `{"case":"sequential","checks":1,"second":"ok (checked ...): probe"}`
- Evidence: `logs/probe-dup.txt`.
- Proposed task:
  - Title: Run one credit check per key at a time in api-first.
  - Problem: a second run checks the same key while the first is still checking.
  - Evidence: P1 output, checks 2 concurrent and 1 sequential.
  - Change: take the lock before the check, or re-read the stored result after taking the lock and skip the check when it is fresh. Add a test with two concurrent decide() calls that expects one check.
  - Size: S.

## P2 Stale-lock takeover deletes a fresh lock (api-first)

- Gap: a stale takeover removes `state.lock` without comparing it to the stale one, so a second run can enter while the first is inside. Verdict: confirmed under an injected pause. Task: new.
- Setup: the lock is `<dir>/state.lock`, stale after 2000 ms (`claude/bin/api-first.js:181`, `:186-196`). The pause sits between the stale check and the `rmSync`.
- Commands:
  - `D="$E/probes/lock-rerun"; mkdir -p "$D"; printf 999 > "$D/state.lock"; touch -t 202001010000 "$D/state.lock"`
  - `cd "$E/probes" && E="$E" PAUSE_MS=1500 bun probe-lock.js "$D" A 0 > "$E/logs/lock-rerun-A.txt" 2>&1 &`
  - `cd "$E/probes" && E="$E" bun probe-lock.js "$D" B 300 > "$E/logs/lock-rerun-B.txt" 2>&1; echo "B exit=$?"`
  - `wait; echo "A exit=$?"`
- Expected output: `B exit=0` and `A exit=0`. In each log, `in` comes before `out`. The two in-to-out intervals overlap: one run enters before the other leaves (the rerun gave A in at ...216705 and B out at ...217034). Control without the pause (`logs/lock-control.txt`): the intervals do not overlap.
- Evidence: `logs/lock-injected-A.txt`, `logs/lock-injected-B.txt`, `logs/lock-control.txt`.
- Proposed task:
  - Title: Compare the lock's identity before removing a stale lock in api-first.
  - Problem: `locked()` removes a lock it read as stale without checking that the file is still the same one.
  - Evidence: P2 injected run, B enters before A leaves.
  - Change: rename the stale file to a unique name and check that it is the stale one before removing it, or use an atomic `mkdir` lock with a holder id. Add a test that starts two takeovers at once.
  - Size: S.

## P3 Two sessions both approved in a computer-use takeover

- Gap: during a stale-lock takeover, two sessions both get "Approved", and one then loses the lock. Verdict: confirmed (fake helper, injected pause). Task: dotfiles-436 item 3.
- Setup: a state folder whose `session.json` names a dead pid (9999). `probe-desk-lock.js` takes `<stateDir> <pid> <pauseMs> <startMs>`; the pause runs inside `holds()`, which returns false for pid 9999. Start pid 200 first, and pid 100 with the 250 ms offset: pid 100 must write its session after pid 200 reads the stale holder, or the race does not show.
- Commands:
  - `SD="$E/probes/desk-rerun"; mkdir -p "$SD"; printf '{"pid":9999}\n' > "$SD/session.json"`
  - `cd "$E/probes" && E="$E" bun probe-desk-lock.js "$SD" 200 400 0 > "$E/logs/desk-rerun-200.txt" 2>&1 &`
  - `cd "$E/probes" && E="$E" bun probe-desk-lock.js "$SD" 100 0 250 > "$E/logs/desk-rerun-100.txt" 2>&1; echo "pid100 exit=$?"`
  - `wait`
- Expected output: both logs have `request_access: Approved: Helium`. Pid 100's log then has `open_app ERROR: This session lost the session lock`. `session.json` ends `{"pid":200}`.
- Control (one session, no race): `logs/desk-control-100.txt` shows pid 100 refused with "Another session (pid 200) is controlling this computer".
- Evidence: `logs/desk-injected-100.txt`, `logs/desk-injected-200.txt`, `logs/desk-control-100.txt`.
- Proposed task:
  - Title: Make the computer-use stale-lock takeover safe for two sessions.
  - Problem: the rename in `holdLock` moves the live lock, so two sessions can both approve, and one loses the lock after approving.
  - Evidence: P3 injected run.
  - Change: take the stale lock with an atomic rename to a unique name, then confirm the holder is still the stale pid. Add a test with two sessions that race for one stale lock; expect one approval.
  - Size: S.

## P4 Approval logged by a session that then loses the lock

- Gap: an approval is written to `approvals.log` before the second `holdLock`, so a session that loses the lock still logs its approval. Verdict: confirmed. Task: dotfiles-436 item 2.
- Commands: the same run as P3, then count the lines:
  - `wc -l < "$E/probes/desk-rerun/approvals.log"`
- Expected output: 2 lines in the racing run (one per session), and 1 line in the control run (`probes/desk-control/approvals.log`). The line for pid 100 is written before its later lost-lock error.
- Proposed task:
  - Title: Write the approval log only after the session holds the lock.
  - Problem: `logApproval` runs before the second `holdLock` (`claude/marketplace/computer-use/server/desktop.js:586`, lock at `:596`).
  - Evidence: P4 log lines.
  - Change: move the log write after the lock check, or log the lost-lock case as a separate event. Add a test that a lost lock leaves no approval line.
  - Size: S.

## P5 Unreported spend hidden by --days

- Gap: a run with no cost is shown only in the all-time total. `--days 30` drops it and exits 0. Verdict: confirmed. Task: new.
- Commands:
  - `cd "$E/repo" && API_FIRST_STATE="$E/probes/spend-aging" HOME="$E/home" bun claude/bin/api-first.js spend > "$E/logs/spend-aging-all.txt" 2>&1; echo "all exit=$?"`
  - `cd "$E/repo" && API_FIRST_STATE="$E/probes/spend-aging" HOME="$E/home" bun claude/bin/api-first.js spend --days 30 > "$E/logs/spend-aging-30.txt" 2>&1; echo "days30 exit=$?"`
  - `grep -c 'not reported yet' "$E/logs/spend-aging-all.txt"`
- Fixture: `probes/spend-aging/decisions.jsonl`, one line dated `2026-09-01T10:00:00.000Z`, run `oldrun00001`, no cost.
- Expected output: `all exit=0` with the row `probe 1 1 $0.0000`; the grep count is 1. `days30 exit=0` with empty caller and day tables.
- Evidence: `logs/spend-aging-all.txt`, `logs/spend-aging-30.txt`.
- Proposed task:
  - Title: Show unreported API runs in every spend view and give them an exit state.
  - Problem: `spend --days N` drops runs with no cost, and the command exits 0 either way.
  - Evidence: P5 outputs.
  - Change: count unreported runs inside the window, print them in the day and caller tables, and exit non-zero (or print a fixed status) when any run is unreported. Add a test for `--days`.
  - Size: S.

## P6 Action ask labelled only-me for a merge decision

- Gap: the ask gate checks the label only. An action ask labelled only-me passes for a merge decision, which `ask-policy.json:7` defines as an in-person step. Verdict: by design (pinned), with a policy conflict. Task: new (owner decision).
- Command: `cd "$E/probes" && E="$E" bun probe-ask.js; echo "exit=$?"`
- Expected output: `exit=0`, and the line `full-stop hand-over (merge decision, only-me): ALLOWED`. The line `action ask with cost reason: BLOCKED: an action ask hands the user a step, which only ...` appears too.
- Evidence: `logs/probe-ask.txt`; pins `claude/tests/config.test.js:854-858` and `claude/hooks/guard-asks.test.js:17-18`.
- Proposed task:
  - Title: Decide whether the merge hand-over is an only-me action.
  - Problem: `full-stop` asks an action with `Reason: only-me` to merge, but the policy says only-me is an in-person step.
  - Evidence: P6 output.
  - Change (owner decides): either keep the merge hand-over as a decision ask, or change the policy text to include merge decisions. Filed as `auto=false` with `Reason: design`.
  - Size: S.

## P7 gh pr ready forbidden and required (full-stop)

- Gap: `full-stop` both forbids and requires `gh pr ready`. Verdict: confirmed by text. Task: new.
- Command: `cd "$E/repo" && grep -n 'gh pr ready' claude/skills/full-stop/SKILL.md; echo "exit=$?"`
- Expected output: `exit=0`; line 20 (`gh pr ready <n> --undo`), line 26 ("Never run `gh pr ready`, merge, ..."), lines 71-72 (release runs `gh pr ready <n>`).
- Proposed task:
  - Title: Make one rule for gh pr ready in full-stop.
  - Problem: line 26 forbids a command that lines 20 and 71 require.
  - Evidence: P7 output.
  - Change: state when `gh pr ready` runs (the user's merge word only, or the refused-draft fallback). Pin it in `claude/tests/config.test.js` near line 842.
  - Size: S.

## P8 Three times for blocked (task and ask)

- Gap: three documents set different times to mark a task `blocked`. Verdict: confirmed by text. Task: new.
- Command: `cd "$E/repo" && grep -n 'blocked' claude/CLAUDE.md claude/skills/full-stop/SKILL.md claude/skills/ui-climb/SKILL.md; echo "exit=$?"`
- Expected output: `exit=0`; `claude/CLAUDE.md:71` ("only once its `ask_user` is accepted"); `full-stop SKILL.md:59` ("Then set the task `blocked`" after the ask); `ui-climb SKILL.md:229` ("task `blocked` until the answer").
- Proposed task:
  - Title: Set one rule for when a task becomes blocked.
  - Problem: CLAUDE.md, full-stop and ui-climb set different times for `blocked`.
  - Evidence: P8 output.
  - Change: choose one trigger (the ask is accepted, or the ask is sent) and use it in all three files. Pin it in `claude/tests/config.test.js`.
  - Size: S.

## P9 Review effort pointer (CLAUDE.md)

- Gap: `CLAUDE.md:86` names the `diff-review` skill for the review effort, but that skill has no effort text. The effort is set in `reviewer.md:5`. Verdict: confirmed by text. Task: new.
- Commands:
  - `cd "$E/repo" && grep -c -i effort claude/skills/diff-review/SKILL.md; echo "exit=$?"`
  - `cd "$E/repo" && sed -n 5p claude/agents/reviewer.md`
- Expected output: `0` and `exit=1` from the first command; `effort: high` from the second.
- Proposed task:
  - Title: Point the review effort in CLAUDE.md at reviewer.md.
  - Problem: the pointer goes to a skill that does not set effort.
  - Evidence: P9 output.
  - Change: change CLAUDE.md:86 to name `claude/agents/reviewer.md`, and pin it in `claude/tests/config.test.js`.
  - Size: S.
