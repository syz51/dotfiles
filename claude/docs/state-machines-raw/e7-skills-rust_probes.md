Repository: agent-skills
Task: dotfiles-546 (state-machine audit). Probes: 37 probe IDs. Files: probes.md (this file), machines.md.

# Rerun conventions

- Set `S` to the scratch folder named in the brief. Every scratch script hardcodes the same path.
- Run `mkdir -p "$S/probes/rerun"` once. Write each rerun to `"$S/probes/rerun/<name>.out"`.
- Hashes, timestamps and temp names change between runs. Expected lines below keep only stable parts. `<sha>` means "same value as the line before".
- Run `run-probes.sh`, `run-insteadof.sh`, `run-trusted-d1.sh` and `run-trusted-d2.sh` one at a time. All four delete and rebuild `$S/probes/run`.
- Probes use fake HOME, fake `git`/`claude`/`gitleaks` binaries, and scratch remotes. No live Claude call or paid API call runs.
- Python runs through `uv run --no-project python`. `validate_skill.py` runs as `uv run` (its PEP 723 header declares pyyaml).

# Probe key

- R-a: Export subject length. machines.md Export G1. Runner `run-probes.sh`, block A.
- R-b: Corrupt config or daily state. Config G2, Daily G1. Runner `run-probes.sh`, block B.
- R-c: Crash after push. Export G2 (refuted). Runner `run-probes.sh`, block C.
- R-e: SIGKILL during fetch. Export G4. Runner `run-probes.sh`, block E.
- R-g: SIGKILL during daily run. Daily G2. Runner `run-probes.sh`, block G.
- R-i: Global insteadOf rule. Export G3. Runner `run-insteadof.sh`.
- R-d1: Trusted state removed. State files G1. Runner `run-trusted-d1.sh`.
- R-d2: Public main ref deleted. State files G2. Runner `run-trusted-d2.sh`.
- EV-a, EV-c, EV-e: Evidence probes. Evidence G1, G3, G5. `probes/ev/evidence_probe.py` with argument a, c or e.
- EV-b: Evidence failed run. Evidence G2. `probes/ev/eb_probe.py`.
- EV-d2: Backoff lost on SIGKILL. Evidence G4. `probes/ev/backoff_lost_probe.py`.
- I-b, I-d, I-h, I-r: Investigation probes. Investigation G2, Investigation cycle G1, Investigation G1, Investigation G3. `probes/inv/probe_investigations.py`.
- J-2, J-b, J-c: Weekly review probes. Weekly review G1, G3, G2. `probes/inv/probe_attempts.py`.
- PR-a to PR-g: Prompt review probes. Prompt review G3 and Ledger G1 (PR-a), Ledger G2 (PR-b), Prompt review G1 (PR-c), Ledger G3 (PR-d), Prompt review G5 (PR-e), Prompt review G4 (PR-f), Prompt review G2 (PR-g). Run through `run-py-probes.sh`.
- P1: Prompt bundle. Prompt bundle G1. Run through `run-py-probes.sh`.
- S1, S2: Skill evals. Skill eval G1, G2. Run through `run-py-probes.sh`.
- RG-1: read_guidance codex-skills root. read_guidance G1. `probes/py/probe_guidance.py`.
- VS-1 to VS-3: validate_skill. validate G1, G2, G3 (refuted). `validate/*` cases.
- LB-1: License bundler. License G1. `probes/py/probe_licenses.py`.
- FA-1: frontend_avoid same-second branch. frontend_avoid G1. `probes/py/probe_frontend_avoid.py`.
- AO-1: Activation event order. Activation G1 (refuted). `probes/act/order_probe.py`.

# 1. Export and daily (run-probes.sh)

Command:
bash "$S/probes/run-probes.sh" > "$S/probes/rerun/run-probes.out" 2>&1; echo "rc=$?"

Expected lines:
- `bytes S69=67 S100=100 S105=105`
- `A1 exit=0 calls=1 main=<sha> state=<sha>`
- `A2 exit=1 calls=1 main=<sha> state=<sha>` (105-byte subject), then `Publication failed: Uninformative or invalid commit message`
- `A3 same input again exit=1 calls_total=2 main=<sha> state=<sha>`, same message
- `A4 exit=0 calls_total=3 main=<new sha> state=<same>` (100-byte subject)
- `C1 exit=137 calls=1 main=<sha> state_before=<sha> state_after=<sha>`
- `C2 next publish exit=0 calls_total=1 main=<sha> state=<sha>` (state equals main)
- `E killed; fetch_pid_seen=yes; leftover candidate checkouts:`, then two lines ending `/checkout/.git`
- `E2 next publish exit=0 main=<sha> state=<sha>`
- `G status after SIGKILL:` JSON with `"success":null` and no `finished_at`
- `G2 next daily exit=0 status=` JSON with `"success":true`
- `B1 exit=1 status_unchanged=yes calls=0`, then `Publication failed: invalid JSON configuration or local state.`
- `B2 exit=1 status_unchanged=yes`
- `B3 after manual delete exit=0`

# 2. Export insteadOf (run-insteadof.sh)

Command:
bash "$S/probes/run-insteadof.sh" > "$S/probes/rerun/run-insteadof.out" 2>&1; echo "rc=$?"

Expected lines:
- `I1 exit=1 calls=1 main= state=` (main is empty: this probe runs no earlier publish)
- `Publication failed: Public candidate changed during message generation`

# 3. Trusted state (run-trusted-d1.sh, run-trusted-d2.sh)

Commands:
bash "$S/probes/run-trusted-d1.sh" > "$S/probes/rerun/run-trusted-d1.out" 2>&1; echo "rc=$?"
bash "$S/probes/run-trusted-d2.sh" > "$S/probes/rerun/run-trusted-d2.out" 2>&1; echo "rc=$?"

Expected lines, d1:
- `D0 exit=0 main=<sha> state=<sha>`
- `D1b exit=0 calls=0 main=<sha> state=<sha>` (state file removed, public tree equal to candidate)
- `D1 exit=1 calls=0 main=<sha> state=` (state removed, source changed)
- `Publication failed: Existing public repository requires trusted state`

Expected lines, d2:
- `D0 exit=0 main=<sha> state=<sha>`
- `D2 exit=1 calls=0 main= state=<sha>`
- `Publication failed: Public main disappeared`

# 4. Python probes (run-py-probes.sh)

Command:
bash "$S/probes/run-py-probes.sh"

It writes `"$S/probes/out/<name>.out"` with `rc=` appended, and `probes/out/run-py.done` at the end. Check each file for `rc=0` (the expected value). Expected lines:

- p1.out (P1): `approved promptsSha256 still matches = True`; `V1 rendered before = True | V2 rendered after = True | rendered text changed = True`; `rc=0`.
- pr-a.out (PR-a): `PR-a after interruption: status success = False | events = 1`; `PR-a after promoted rerun: outcome = promoted | events = 3 | pending = 2 | pending without terminal (orphans) = 1`.
- pr-b.out (PR-b): `PR-b pending attempts frozen = 1023 | ... refusal = Prompt attempt ledger requires explicit archival`; `PR-b next review raised: Prompt review failed; due remains pending`.
- pr-c.out (PR-c): `PR-c raised: Prompt review failed; due remains pending | __cause__ = None | context suppressed = True`; `failure_class = review_failed`.
- pr-d.out (PR-d): `PR-d files on disk = 3`; `PR-d ledger readable = no | Broken prompt attempt conclusion`.
- pr-e.out (PR-e): `PR-e child exit code = 9 (9 means killed at push)`; `PR-e registered prompt-review worktrees = 1 | leftover temp dirs = 1`; `PR-e main HEAD unchanged = True | origin/main unchanged = True`.
- pr-f.out (PR-f): `PR-f exit = 1 | last stderr line = ValueError: Due requires timezone`; `PR-f status file unchanged = True`.
- pr-g.out (PR-g): `PR-g status success = False | failure_class = review_failed | lock named in status = False`; `PR-g completion marker written = False`; `PR-g control without lock: outcome = promoted`.
- s1.out (S1): `S1 run_process invocations started = 3 | completed without error = 2 | cases = 30 | result.json files = 2 | summary.json exists = False`; the RuntimeError escapes main.
- s2.out (S2): `S2 normal exit: code = 0 | timed out = False | descendant alive after return = True`; `S2 timeout path: code = -15 | timed out = True | descendant alive after return = False`.
- guidance.out (RG-1): `G2 codex-skills path -> ('rust/SKILL.md', 0)`; `G3 other root refused -> refused: Not the shared guidance reader`.
- licenses.out (LB-1): `U1-symlink-outside-root raised ValueError: Unsafe dependency notice: dep`; `U2-notice-over-1MiB raised ValueError: Unsafe dependency notice: dep`; `U3-control-normal returned 43 chars`.
- frontend-avoid.out (FA-1): control single run opens one pull (`outcome` has a `url`); `R run A outcome = {'error': 'GitHub request failed: DELETE git'}`; `R run B outcome = {'error': 'GitHub request failed: POST git'}`; `R branches left = [] | pulls opened = 0`.
- order-rerun.out (AO-1): `success-then-failure passed=False completed=False`; `failure-then-success passed=False completed=False`; `success-only passed=True completed=True`.

# 5. Evidence (EV-a, EV-b, EV-c, EV-e, EV-d2)

Commands (argument a, c or e selects the probe):
uv run --no-project python "$S/probes/ev/evidence_probe.py" "$S" a > "$S/probes/rerun/ev-a.out" 2>&1; echo "rc=$?"
uv run --no-project python "$S/probes/ev/evidence_probe.py" "$S" c > "$S/probes/rerun/ev-c.out" 2>&1; echo "rc=$?"
uv run --no-project python "$S/probes/ev/evidence_probe.py" "$S" e > "$S/probes/rerun/ev-e.out" 2>&1; echo "rc=$?"
uv run --no-project python "$S/probes/ev/eb_probe.py" "$S" > "$S/probes/rerun/ev-b.out" 2>&1; echo "rc=$?"

Expected lines:
- EV-a: `E-a run=1 verify_calls=1 correct_calls=1 receipts=0 rate_limited=1 pending=1`; `E-a run=2 verify_calls=2 correct_calls=2 receipts=0 rate_limited=1 pending=1`.
- EV-b: `EV-b run1 rc=0 success=True paid_calls=1`; `EV-b receipts=1`; `EV-b run2 rc=1 stdout='Source verification failed; source data and existing receipts are preserved.' stderr_bytes=0 status_unchanged=True paid_calls=0`.
- EV-c: `E-c valid_attempts_after_skip=3`; `E-c after_corrupt attempts=1 exit=no_exception counts_unavailable=1 file_now_valid=yes`.
- EV-e: `E-e assessments=2 latest=1 latest_summary=Second summary exit=no_exception`.

EV-d2 (backoff lost on SIGKILL). Use a new root folder for each sequence. Names below are examples.
uv run --no-project python "$S/probes/ev/backoff_lost_probe.py" "$S" "$S/probes/ev/bl-control-1" control
uv run --no-project python "$S/probes/ev/backoff_lost_probe.py" "$S" "$S/probes/ev/bl-control-1" rerun > "$S/probes/rerun/bl-control.out" 2>&1
uv run --no-project python "$S/probes/ev/backoff_lost_probe.py" "$S" "$S/probes/ev/bl-kill-1" kill; echo "rc=$?"
uv run --no-project python "$S/probes/ev/backoff_lost_probe.py" "$S" "$S/probes/ev/bl-kill-1" rerun > "$S/probes/rerun/bl-kill.out" 2>&1
- Control: `MODE=control backoff_file_before=no calls=['t1', 't2'] ... backoff_file_after=yes`. Rerun: `MODE=rerun backoff_file_before=yes calls=[] ... backoff_file_after=yes` (window honoured).
- Kill: `rc=137` and no output. Rerun: `MODE=rerun backoff_file_before=no calls=['t1', 't2'] unresolved=0 checked=0 backoff_file_after=yes`.

# 6. Investigations and weekly review

Commands:
uv run --no-project python "$S/probes/inv/probe_investigations.py" "$S" > "$S/probes/rerun/inv.out" 2>&1; echo "rc=$?"
uv run --no-project python "$S/probes/inv/probe_attempts.py" "$S" > "$S/probes/rerun/attempts.out" 2>&1; echo "rc=$?"

Expected lines, investigations:
- I-b: `I-b both record calls returned: True`; `I-b event files: 2`; `I-b inventory raised ValueError: Unlinked investigation histories`.
- I-d: `I-d first attempt raised CalledProcessError, returncode 128`; `I-d partial files: ['dirty.py']`; `I-d .snapshot.json present: False`; `I-d retry: refused: Project snapshot needs a new destination and registered Git root`.
- I-h: `I-h open -> resolved: accepted`; `I-h resolved -> dropped: accepted`.
- I-r: `I-r open heads in working tree: 1`; `I-r outstanding in new cycle: 0`.

Expected lines, weekly review:
- J-2: `J-2 main advanced by the killed run: True`; `J-2 active status: running`; `J-2 review calls on the next run: 1`; `J-2 killed run candidate is still on main: True`.
- J-c: `J-c work dirs after kill: 1`; `J-c active file present: False`; `J-c folder has attempt.json: [False]`.
- J-b: `J-b run 1 refused: JSONDecodeError`; `J-b run 2 refused: JSONDecodeError`.

# 7. Validate skill (VS-1 to VS-3)

Command, per case (no `--no-project`):
uv run "$S/repo/scripts/validate_skill.py" "$S/probes/validate/<case>/skill"; echo "rc=$?"
Cases: `nonutf8`, `bom`, `control`, `crlf`.
- nonutf8 (VS-1): traceback whose last line contains `UnicodeDecodeError: 'utf-8' codec can't decode byte 0xff in position 37`; rc=1.
- bom (VS-2): `SKILL.md must start with YAML frontmatter between --- lines`; rc=1.
- control: `Skill is valid.`; rc=0.
- crlf (VS-3, refuted): `Skill is valid.`; rc=0.

# 8. Unit tests (cargo and Python)

- `CARGO_TARGET_DIR="$S/target" cargo test --locked --manifest-path "$S/repo/Cargo.toml"`: the `N passed` lines add up to 83, with 0 failed.
- `CARGO_TARGET_DIR="$S/target" cargo test --locked --manifest-path "$S/repo/Cargo.toml" --lib gitleaks_path_is_absolute_or_a_program_name`: `1 passed` (Config G1, by design).
- `CARGO_TARGET_DIR="$S/target" cargo test --locked --manifest-path "$S/repo/Cargo.toml" --test rust_daily overlapping_job_never_calls_publication`: `1 passed; 8 filtered out` (Daily G3, by design).
- Python, from the scratch tests folder: `uv run --no-project python -m unittest test_evidence test_prompt_review test_skill_evals`: `Ran 148 tests`, `OK`. The exact invocation was not recorded in the outputs; this form is unverified.
- Prompt review rotation (Prompt review G6, by design): `test_rotation_keeps_past_weekly_targets_and_resumes_after_daily_period`: `Ran 1 test`, `OK`.

# 9. Outside the 18 machines (not proposed; check on the live checkout)

- `secret-scan-one.out`: `FAIL: test_config_allows_only_manifest_hashes_and_catches_planted_secrets` in the scratch copy only (SS-1). Unverified on the live checkout.
- `test_skill_packages` ERRORs in scratch: the scratch copy has no public/files overlay. Unverified on the live checkout.

# Unverified gaps (no probe run; read only)

Each needs a probe before a task is proposed. Machines.md gives the citations.
- Export G5 (direct git at `src/export.rs:420`).
- Daily G4 (two writers of daily-status.json), Daily G5 (deferred path writes success null).
- Message G2 (record_fallback has no lock).
- Investigation G4 (remote_issue_events returns None on any CalledProcessError).
- Investigation cycle G2 (orphan folders), G3 (process.wait has no timeout), G4 (no cycle expiry).
- Prompt bundle G2 (copy_bundle partial stage).
- Skill eval G3 (no total cost cap; design question).
- Activation G2 (truncated node output clears node state).
- read_guidance G2 (continuation and mismatch paths).
- frontend_avoid G2 (state file has no lock), G3 (kill before state write).
- State files G4 (flock released on death; OS behaviour).

# Proposed tasks

One block per confirmed gap group. Size: S, M or L. Each task is `auto=false` only where marked. Gaps cross-listed in machines.md point to the same task.

### P-1 Align the commit subject limit between message and export [S]
- Covers: Export G1, Message G1.
- Problem: message validation allows 12 to 120 bytes, but export rejects 101 to 120 after the paid call.
- Evidence: R-a (A2, A3 exit 1 after one paid call; A4 100 bytes exit 0); `src/message.rs:46-47`; `src/export.rs:1016-1017`.
- Change: share one subject bound between the generator and export; add a test with a 101 to 120 byte subject.

### P-2 Compare the raw configured origin URL, not the insteadOf-rewritten one [S]
- Covers: Export G3.
- Evidence: R-i (I1 exit 1, calls=1, main unchanged); `src/export.rs:953-955`.
- Change: read the configured URL from the config file for the origin check; add a test with an insteadOf rule.

### P-3 Clean up candidate checkouts left by a killed publish fetch [S/M]
- Covers: Export G4.
- Evidence: R-e (two leftover `.git` entries; E2 exit 0); `src/export.rs:832`.
- Change: remove stale `tmp` candidate checkouts before a new fetch; test a SIGKILL during fetch.

### P-4 Name the recovery step for lost trusted state; test both refusal messages [M]
- Covers: State files G1, G2, G3. Owner must choose the recovery route (design).
- Evidence: R-d1 (exit 1, calls=0, message); R-d2 (exit 1, calls=0, main absent); grep for "trusted state|disappeared" in tests returns 0.
- Change: the message names the recovery step; add tests for both refusals.

### P-5 Name the bad state file and write a failure status when daily or config state is corrupt [S]
- Covers: Config G2, Daily G1.
- Evidence: R-b (B1 exit 1, status unchanged, calls 0; message names no file); `src/main.rs:66-67`; `src/daily.rs:58`.
- Change: include the file path in the message; write a failed status before exit.

### P-6 Do not leave daily status at success null after SIGKILL; set a finish marker [S]
- Covers: Daily G2.
- Evidence: R-g (status success null, no finished_at; G2 next run success true).
- Change: write a running marker and treat a stale one as failed on read. Parent to check overlap with dotfiles-357 and dotfiles-527.

### P-7 Conclude prompt attempts orphaned by a crash after push [S]
- Covers: Prompt review G3, Ledger G1.
- Evidence: PR-a (events 3, pending without terminal = 1 after the promoted rerun).
- Change: on rerun, write the terminal event for a pending attempt whose push already happened.

### P-8 Add archival for the 1024-event prompt attempt ledger [M]
- Covers: Ledger G2.
- Evidence: PR-b (1023 frozen; refusal requires explicit archival; the next review fails).
- Change: archive terminal events past the cap into a dated file; keep the cap check.

### P-9 Keep failure cause and lock name in prompt review status [S]
- Covers: Prompt review G1, G2. Monitor side: dotfiles-357.
- Evidence: PR-c (`__cause__ = None`, context suppressed); PR-g (lock not named, no completion marker).
- Change: write the exception text and the lock name to status; write a completion marker on lock-busy.

### P-10 Lock prompt ledger writes or refuse a second terminal event [S]
- Covers: Ledger G3. Trigger not reproduced; consequence confirmed.
- Evidence: PR-d (3 files, ledger unreadable).
- Change: lock `finish_attempt` and refuse a second terminal event.

### P-11 Sweep prompt-review worktrees and temp dirs left by a killed push [S/M]
- Covers: Prompt review G5.
- Evidence: PR-e (exit 9; 1 registered worktree; 1 temp dir; main and origin unchanged).
- Change: remove stale registered worktrees and temp dirs at the start of publish.

### P-12 Accept a naive --due, or fail with a clear message before any status write [S]
- Covers: Prompt review G4.
- Evidence: PR-f (ValueError traceback; status unchanged).
- Change: move due parsing inside the try, or reject with a clear message before any status write.

### P-13 Pin maintenance-prompt.md in the approved bundle hash [S]
- Covers: Prompt bundle G1. Owner confirmation recommended (design).
- Evidence: P1 (approved hash still matches; rendered text changed).
- Change: add the file to `PROMPT_PATHS` and `bundle_hash`; add a test that edits it.

### P-14 Write summary.json and stop workers when a case raises a non-caught error [M]
- Covers: Skill eval G1.
- Evidence: S1 (3 started, 2 completed; summary.json absent).
- Change: record every case error; always write summary.json.

### P-15 Kill case-process descendants on normal exit [S]
- Covers: Skill eval G2. Low impact: the real case tools are Read and Skill only (`scripts/skill_evals.py:42`).
- Evidence: S2 (descendant alive after normal exit).
- Change: kill the process group after a normal exit too.

### P-16 Keep a verified result when a correction is rate limited [S/M]
- Covers: Evidence G1.
- Evidence: EV-a (run 2 repeats verify and correct calls; receipts 0).
- Change: store the verified result before correction; do not repeat the paid verify.

### P-17 Mark evidence-status.json failed and print the cause when a run aborts [S]
- Covers: Evidence G2.
- Evidence: EV-b (run 2 rc 1; stderr empty; status still success true).
- Change: write a failed status and print the cause to stderr.

### P-18 Report a corrupt backoff file instead of resetting it silently [S]
- Covers: Evidence G3.
- Evidence: EV-c (attempts reset to 1; no report).
- Change: report the corrupt file and keep it aside.

### P-19 Save each backoff entry when it is set, not at run end [S]
- Covers: Evidence G4.
- Evidence: EV-d2 (kill loses the schedule; rerun checks again).
- Change: save after each entry is set.

### P-20 Report two receipt heads with no supersedes [S]
- Covers: Evidence G5.
- Evidence: EV-e (two assessments; newest used silently).
- Change: report a conflict instead of choosing the newest.

### P-21 Lock investigation record writes against a stale second head [S/M]
- Covers: Investigation G2.
- Evidence: I-b (two record calls both return; inventory raises).
- Change: take an exclusive lock around record; read the head inside the lock.

### P-22 Remove partial project snapshots before a retry [S]
- Covers: Investigation cycle G1.
- Evidence: I-d (partial files left; retry refused).
- Change: write the snapshot to a temp folder and rename it, or remove the partial destination on failure.

### P-23 Define an investigation state transition table (design ask, auto=false) [S]
- Covers: Investigation G1. Owner decides which transitions are legal (design).
- Evidence: I-h (open -> resolved accepted; resolved -> dropped accepted).
- Change: after the owner decides, add a transition table and tests. Recommend: keep resolved -> dropped only with a reason.

### P-24 Agree the working-tree head with the committed cycle [M]
- Covers: Investigation G3.
- Evidence: I-r (1 open head in working tree; 0 outstanding in the new cycle).
- Change: build the cycle from the committed head set.

### P-25 Recover a weekly review killed after the fast-forward merge [S/M]
- Covers: Weekly review G1.
- Evidence: J-2 (main advanced; active status running; next run starts a new review).
- Change: on the next run, detect a merged candidate and finish the attempt.

### P-26 Retire orphan work dirs left between worktree add and attempt save [S]
- Covers: Weekly review G2.
- Evidence: J-c (work dir without attempt.json survives a clean run).
- Change: retirement also lists work dirs without attempt.json.

### P-27 Quarantine a truncated active-attempt.json instead of blocking every run [S]
- Covers: Weekly review G3.
- Evidence: J-b (every run refused with JSONDecodeError).
- Change: move the corrupt file aside and report it.

### P-28 Make frontend-avoid branch names unique per run [S]
- Covers: frontend_avoid G1.
- Evidence: FA-1 (two runs in one second: both fail; no pulls; control run opens one pull).
- Change: add a per-run suffix; cleanup deletes only its own branch.

### P-29 Remove the codex-skills root from read_guidance [S]
- Covers: read_guidance G1. Recommended removal; the owner has no Codex subscription (owner decides).
- Evidence: RG-1 (codex-skills path accepted); `tests/test_read_guidance.py` has no codex case.
- Change: drop the root from `read_guidance.py:52`; add a test that refuses it.

### P-30 Report non-UTF-8 and BOM SKILL.md as validation errors [S]
- Covers: validate G1, G2.
- Evidence: VS-1 (traceback), VS-2 (misleading frontmatter message).
- Change: read bytes and report a decode error; report a BOM with its own message; add tests.

### P-31 Test the unsafe-notice branch of the license bundler [S]
- Covers: License G1.
- Evidence: LB-1 (both unsafe cases raise; the branch has no test).
- Change: add tests for a symlink outside the root and a notice over 1 MiB.
