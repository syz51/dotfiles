Repository: agent-skills

# Machines, round 2 (explorer 2)

Scratch root: `S`. Repository copy: `S/repo` (git clone of the checkout at 7e772d6, no hardlinks).
Verdicts: confirmed, by design, refuted, unverified. Probe blocks are in `S/probes-2.md` (labels R2-n).
Round 1 record: `S/../e7-skills-rust/machines.md`.

## Corrections to round 1

- Investigation issue events: round 1 said exit 128 is refused at `record`.
- Corrected: `remote_issue_events` returns None on any rev-parse failure (`investigations.py:170-173`).
- The real missing-folder refusal came from `merge-base` at `investigations.py:389`, not from the guard.
- Frontend G1: corrected mechanism. Run B's create fails on the name collision.
- Its cleanup (`frontend_avoid.py:207-209`) then deletes run A's branch.
- Activation G2: by design, not a gap. Tests at `test_activation_trace.py:394` and `:743` pin truncated output as uncertain.
- Prompt review ledger G3: refuted for the reachable trigger (`P-10`, see section 4).
- FA-1 output path: round 1 cited `probes/r2/out/rerun-fa1.out`, which does not exist.
- Round 1 output is `S/probes/rerun/probe_frontend_avoid.out`. Round 2 rerun: `S/probes/r2-final/fa1.out`.
- E-d2 backoff probe: a rerun on a stale folder gave `calls=[]` and no defect. Round 2 reran on a fresh folder and reproduced it.

## Files read (round 2 state)

- `scripts/prompt_review.py`: read in full (round 1). Lines 709-716, 855-915, 1035-1040 re-read in round 2.
- `scripts/evidence.py`: read in full.
- `scripts/investigations.py`: read in full. Lines 166-175 and 385-391 re-read in round 2.
- `scripts/frontend_avoid.py`: read in full. Lines 185-256 re-read in round 2.
- `scripts/skill_evals.py`: read in full.
- `scripts/activation_trace.py`: read in full.
- `scripts/read_guidance.py`: read in full.
- `scripts/prompt_runtime.py`: read in full.
- `scripts/validate_skill.py`, `scripts/bundle_rust_licenses.py`: read in full (round 1).
- Tests read in full: `test_frontend_avoid.py`, `test_prompt_runtime.py`, `test_read_guidance.py`, `test_validate_skill.py`, `test_rust_license_bundle.py`, `test_secret_scan.py`, `test_skill_packages.py`, `test_repository_content.py`, `test_skill_evals.py`, `test_investigations.py`, `test_claude_live.py`.
- Tests read in two ranges only: `test_prompt_review.py`, `test_evidence.py`, `test_activation_trace.py`. Round 2 checked their coverage with grep.
- Prompt-evals JSON cases: shape only (data, not logic).
- `scripts/jobs.py`, `scripts/capture.py`: outside scope, referenced only.

## 1. Prompt review completion marker (new in round 2)

Where: `prompt_review.py` `run()` 859-912. Marker file: `prompt-review-state.json` in the state folder. Status file: `prompt-review-status.json`.

States:
- none: no marker. `prior` is `{}` (866-870).
- done(D): marker holds `completed_due` = D and `result`, saved at 904.
- unreadable: an `OSError` or `ValueError` at 869 reads as "none".

Transitions:
- none to done(D): review passes (900), sources still current (901), `completed < due` (903), save (904).
- done(D) to already_reviewed: `due` is at or before D (896-898). Status saved at 905.
- done(D) to review: `due` is after D (900).
- any to failed: exception (907). Status saved at 908-909 with `previous_success = prior.get('result')`.
- Failed runs leave the marker unchanged (908-912). The due key stays pending.
- Published record (893) is a second check. It exists only for runs with a change. Probe A shows no record folder after a no_change run.

Gaps:
- G1: unreadable marker reads as none. Verdict: confirmed (R2-11).
- Evidence: run C outcome `no_change`, `model_calls=12`. Control B outcome `already_reviewed`, `model_calls=0`.
- Cause: 869-870. For no_change runs the marker is the only memory of the due key.
- Test: none. `test_prompt_review.py` writes only valid JSON for the marker (1027-1054). The grep for corrupt or truncated markers had no match (rc 1).
- G2: failure after a success loses the previous result when the marker is unreadable. Verdict: confirmed (R2-12).
- Evidence: D1 `previous_success outcome: no_change`. D2 `previous_success outcome: None`.
- Test: none.
- Two sources of truth: marker (896) and published record (893). Verdict: by design for changed prompts. For no_change runs, the marker alone decides.
- Suppression of the same and earlier due keys: no gap. Tests at 1027-1054 cover it. `if completed < due` (903) never moves the marker back.

## 2. Investigation issue events

Where: `investigations.py` `remote_issue_events` 168-173. Guard inside `record()` (387-).

States:
- origin/main readable: list of event hashes.
- origin/main missing: None. By design (docstring line 169).
- rev-parse fails (rc 1 for a broken ref, rc 128 for a git error): None. Gap (R2-1).
- object missing behind a valid sha: raises CalledProcessError. Loud, so refused.

Transitions:
- None makes the guard skip (`record` accepts the write).
- An exception stops `record`.

Gaps:
- R2-1 fail-open on any rev-parse failure. Verdict: confirmed, scope corrected to all rev-parse failures.
- Corrupt loose ref (rc 1): accepted. Evidence: `probe_inv_g4_real_r2.out:17-18`.
- Git exit 128: `remote_issue_events` returns None (`probe_inv_g4_real_r2.out:14`). Record accepts with the guard skipped (`probe_inv_r2.out:5-6`).
- Real missing-folder case refuses only because `merge-base` at 389 raises (`probe_inv_g4_real_r2.out:15`).
- Missing origin/main: by design. Accepted at `probe_inv_g4_real_r2.out:8-9`. Control with readable origin/main refuses a foreign event (`:11-12`).
- Object missing: raises (`:20-21`). Loud, by design.
- Round 1 G1 to G3: still hold. Code identical. Not rerun.
- Tests: no test uses a corrupt or broken origin/main (grep rc 1). Test setup sets origin/main only with `update-ref` (188-195).

## 3. Investigation cycle

Where: `validate_cycle` 414-442 (`'complete': True` at 442). `run` 452-593 (wait at 566). `snapshot_project` 622-645.

States: run started, then logs and artifacts written, then run record saved. Cycle: open dispositions, then complete.

Gaps:
- R2-2 (C-G2) run record write fails after logs and artifacts: confirmed. Category: partial write.
- Evidence: after failure `(1, 1, 0)` (log folders, artifact folders, run records). After clean retry `(2, 2, 1)`. The failed attempt's folders stay (`probe_inv_r2.out:11-12`).
- R2-3 (C-G3) run waits with no time limit: confirmed. Category: wait with no time limit.
- Evidence: `wait() timeout arguments: [None, None]` (`probe_inv_r2.out:14`). Hang not reproduced; the probe child exited normally.
- Tests: no test sets or checks a wait timeout (grep matches were fixture text).
- R2-4 (C-G4) complete with an open disposition: confirmed. Category: state with wrong completion.
- Evidence: after one open disposition `(1, 1, True)`. Second record accepted, open count still 1, complete still True (`probe_inv_r2.out:16-17`).
- Test coverage for R2-4: unverified. `test_investigations.py:130-132` covers a cycle that closes open work, not an open disposition at completion.
- Round 1 G1: still holds. Code identical. Not rerun.

## 4. Prompt review cycle (busy path)

Where: `prompt_review.py` `main` 1035-1040. Lock file `cycle.lock`, flock at 1037, busy message, `return 1`.

States: free, then locked, then run. Busy, then exit 1 with no status.

Gaps:
- G2: busy path writes no status file. Verdict: confirmed.
- Evidence: `busy (lock held) | rc = 1 | output = Prompt review cycle busy | run called = False`. Status and state files absent (`probe_busy_status_r2.out:1-2`).
- The control at lines 3-4 stubs `run`, so it proves only that `run` is reached.
- Test: none. The grep for "busy" in `test_prompt_review.py` had no match (rc 1).
- Monitor side: dotfiles-357.

## 5. Prompt review attempt ledger

Where: `finish_attempt` 709-716 (already concluded at 716). Attempt files in `prompt-attempts`. `attempt_events`.

States: open, then one terminal event.

Gaps:
- G3 (P-10): refuted for the reachable trigger.
- Second finish refused: `Prompt attempt already concluded`. Terminal events: 1 (`probe_misc_r2.out:2-3`).
- A concurrent main review is refused by `cycle.lock`: rc 1, attempt files unchanged at 2 (`probe_misc_r2.out:4`).
- A second terminal event needs a direct double write (round 1 PR-d). Recommendation: withdraw G3, or keep it as hardening.
- G1, G2 (round 1): still hold. Not rerun. Code identical.
- Test: `test_prompt_review.py:330-340` writes `{}` into a terminal attempt and expects `identity mismatch`. Covered.

## 6. Prompt bundle approval

Where: `prompt_runtime.py` `copy_bundle` 116-127 (refusal 122-123; in-place write 125-126).

States: destination absent, then copying, then complete. Partial destination: refuse.

Gaps:
- R2-5 (G2) partial copy blocks retry: confirmed. Category: state with no exit.
- Evidence: `G2 copy raised: injected write failure`. `G2 files left in destination prompts: ['correct.md']`. `G2 re-copy refused: Prompt destination already exists` (`probe_misc_r2.out:6-8`).
- The operator must delete the partial folder by hand.
- Test: none. The grep for injected or OSError failures had no match (rc 1). `test_prompt_runtime.py:142-148` tests a "partial" input mode, not a copy interruption.
- G1 (round 1): still holds. Not rerun.

## 7. Skill evaluation run

Where: `skill_evals.py` `run_process` 146-165. `Popen` with `start_new_session=True` (149). `communicate(input, timeout)` (151). `killpg` (156). Unbounded `communicate()` after the kill (164). `TOOLS` at 42.

States: running, then exit or timeout, then group kill, then drain pipes.

Gaps:
- R2-6 (G3) no cost cap on runs: confirmed absence. Verdict: by design pending owner decision (reason: cost).
- Evidence: `grep -n -i "cost\|budget\|usd\|max_calls" scripts/skill_evals.py` gives rc 1 with no lines.
- R2-7 (S-G1) escaped grandchild holds the pipe: confirmed.
- Evidence: `run_process(timeout=2) returned within 25 s: False`. `grandchild started in its own session: True`. After the grandchild was killed by hand: `returned, code/timed_out = -15 True` (`probe_skill_r2.out:1-3`).
- Mechanism: `killpg` (156) reaches only the leader's group. A grandchild in its own session keeps the pipe open. Then unbounded `communicate()` (164) waits.
- Test: `test_skill_evals.py:359` (`test_timeout_kills_descendants_after_leader_exits`) covers the leader-exits case. No test starts a child in its own session (grep for `start_new_session` or `setsid` in tests: none; the only match is the script at 149).

## 8. Activation trace

Where: `activation_trace.py` `node_read_observations` 692; `state.clear` 711; truncation 713-714.

Verdict for G2: by design. Round 1 read truncation as a silent loss. The tests pin truncated or extra node output as uncertain, not as proof.

Tests: `ActivationTraceTests` at `test_activation_trace.py:394` and `:743`. Round 2 rerun by exact name: `Ran 2 tests`, `OK`, rc 0.

## 9. read_guidance envelope

Where: `read_guidance.py` legacy `codex-skills` check 52. `read` 62. `observed` 79-95.

States: request root accepted (`agent-skills` or legacy `codex-skills`), then chunk read, then envelope with `coverage: partial`.

Gaps:
- R2-8 (G2) chunks from two file versions join: confirmed.
- Evidence: three chunks at starts 0, 6000, 12000 each accepted with `coverage = partial`. `G2 reconstructed letters = {'a': 6000, 'b': 8000} | chunks = 3` (`probe_misc_r2.out:10-13`).
- Only the wrong-offset envelope is refused (`probe_misc_r2.out:14`). No file version or hash check across chunks.
- Test: none. The grep for chunk or version tests had no match (rc 1).
- RG-1 legacy `codex-skills` root: accepted, untested. Verdict: confirmed untested. Keep or drop is a design question.
- Evidence: `G2 codex-skills path -> ('rust/SKILL.md', 0)`. grep for `codex-skills` in `test_read_guidance.py`: rc 1.

## 10. frontend_avoid proposal

Where: `remove_orphans` 187-193. `create` 196-210 (branch name to the second at 197; POST refs 199; except cleanup 204-209). `propose` 213-256 (state read 225; PATCH 248; create call 251; state write 254-255).

States: state absent or present, then plan, then update an open PR, or create a branch, PUT the file, and open a PR, then write state.

Gaps:
- G1 (P-28) same-second runs collide. Verdict: confirmed, mechanism corrected.
- Evidence: `R run A outcome = {'error': 'GitHub request failed: DELETE git'}`. `R run B outcome = {'error': 'GitHub request failed: POST git'}`. `R branches left = [] | pulls opened = 0` (`S/probes/r2-ev/logs/fa1-rerun.out`).
- Call order: B's POST fails, then B deletes A's branch (`B:DELETE git/refs/heads/...`), then A's delete fails.
- Mechanism: the except clause (207-209) deletes a branch that run B did not create.
- G2 overlapping propose runs open two PRs: confirmed (R2-9).
- Evidence: `G2 pulls opened: 2`. Heads for 100100 and 100000 (`probe_front_r2.out:2-3`). State lists one handled hash.
- G3 kill before the state write: refuted.
- Evidence: after a kill, `G3 run 2 outcome: unchanged | pulls = 1` (`probe_front_r2.out:6-7`). The retry does not duplicate.
- F-G4 orphan sweep deletes an in-flight branch: confirmed (R2-10, new).
- Evidence: `F-G4 run A outcome: RuntimeError('GitHub request failed: DELETE git')`. `F-G4 run B outcome: created`. `F-G4 pulls opened: 1 | ... | branches left: [...]` (`probe_front_sweep_r2.out:2-4`).
- Mechanism: `remove_orphans` (192-193) deletes any proposal branch with no PR. Run A was paused before its PUT, and its branch had no PR yet.
- Test: `test_frontend_avoid.py:328` covers stale orphan removal only. Grep for overlap, concurrency, or orphan (rc 0) matched only line 328. No test covers an in-flight branch or two runs.
