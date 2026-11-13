Repository: agent-skills

# Probes, round 2

## Setup

- `S` is the scratch root (the `r7b-skills-scripts` folder). Set it first: `S=<absolute scratch root>`.
- Every probe below takes `S` as its first argument, except where a block says otherwise.
- Run each Python probe as: `no-session-env uv run --no-project python <script> "$S"`.
- Fake `claude` and `codex` programs sit first on PATH and log any real attempt.
- Probes use `S/fakehome` as HOME. No Claude call and no paid API call runs.
- Expected rc is 0 unless a block says otherwise.
- Output folders: `S/probes/r2/out/rerun-final/` (round 2 reruns, identical to saved), `S/probes/r2-final/` (this check), `S/probes/r2-ev/logs/` (round 2 evidence logs).

## Confirmed gaps

### R2-1 Investigation: remote origin/main check fails open on any rev-parse failure

Command: `cd "$S/probes/r2" && no-session-env uv run --no-project python probe_inv_g4_real_r2.py "$S"`
Expected lines (rc 0):
- `rev-parse rc: 1 | remote_issue_events = None`
- `missing origin/main writer A -> accepted` (by design, docstring line 169)
- `control writer A -> refused: ValueError Investigation frontend-ui/focus has events on origin/main ...`
- `rev-parse rc: 128 | remote_issue_events = None`
- `corrupt ref writer A -> accepted`
- `rev-parse rc: 0 | remote_issue_events = raised CalledProcessError rc=128`
- `corrupt ref writer A -> refused: CalledProcessError ...`

Command: `cd "$S/probes/r2" && no-session-env uv run --no-project python probe_inv_r2.py "$S"`
Expected line (rc 0): `I-G4 rev-parse exit 128: record accepted (guard skipped)`

### R2-2, R2-3, R2-4 Investigation cycle (C-G2, C-G3, C-G4)

Command: same as R2-1 with `probe_inv_r2.py`.
Expected lines (rc 0):
- `C-G2 after failure: log folders, artifact folders, run records = (1, 1, 0)`
- `C-G2 after clean retry: log folders, artifact folders, run records = (2, 2, 1)`
- `C-G3 wait() timeout arguments: [None, None] | exit_code: 1 | timed_out: False`
- `C-G4 after one open disposition: dispositions, open, complete = 1 1 True`
- `C-G4 second record accepted; dispositions, open, complete = 2 1 True`

### R2-5 Prompt bundle partial copy; R2-8 read_guidance chunks; P-10 ledger

Command: `cd "$S/probes/r2" && no-session-env uv run --no-project python probe_misc_r2.py "$S"`
Expected lines (rc 0):
- `P-10 sequential second finish: refused: Prompt attempt already concluded`
- `P-10 terminal events for the attempt: 1`
- `P-10 main review with cycle.lock held: rc = 1 | output = Prompt review cycle busy | attempt files before, after = 2 2`
- `G2 copy raised: injected write failure` (R2-5)
- `G2 files left in destination prompts: ['correct.md']`
- `G2 re-copy refused: Prompt destination already exists`
- `G2 chunk 1 start = 0 accepted coverage = partial` (and chunks 2 and 3, starts 6000 and 12000)
- `G2 reconstructed letters = {'a': 6000, 'b': 8000} | chunks = 3` (R2-8)
- `G2 wrong-offset envelope refused: Guidance envelope differs from its command`

### R2-6 Skill evaluation: no cost cap (by design pending owner decision)

Command: `cd "$S/repo" && grep -n -i "cost\|budget\|usd\|max_calls" scripts/skill_evals.py; echo "rc=$?"`
Expected: no lines, `rc=1`.

### R2-7 Skill evaluation: unbounded communicate after an escaped grandchild

Command: `cd "$S/probes/r2/skill" && no-session-env uv run --no-project python probe_skill_r2.py "$S"`
Expected lines (rc 0):
- `S-G1 run_process(timeout=2) returned within 25 s: False`
- `S-G1 grandchild started in its own session: True`
- `S-G1 after the grandchild was killed: returned, code/timed_out = -15 True`

### R2-9 and R2-10 Frontend proposal: overlapping runs, orphan sweep

Command: `cd "$S/probes/r2" && no-session-env uv run --no-project python probe_front_r2.py "$S"`
Expected lines (rc 0):
- `G2 pulls opened: 2 | heads: [(1, 'skill-feedback/frontend-avoid-20261114-100100'), (2, 'skill-feedback/frontend-avoid-20261114-100000')]`
- `G3 run 2 outcome: unchanged | pulls = 1 | heads: [(1, 'skill-feedback/frontend-avoid-20261114-100000')]` (G3 refuted)

Command: `cd "$S/probes/r2" && no-session-env uv run --no-project python probe_front_sweep_r2.py "$S"`
Expected lines (rc 0):
- `F-G4 run A outcome: RuntimeError('GitHub request failed: DELETE git')`
- `F-G4 run B outcome: created`
- `F-G4 pulls opened: 1 | heads: ['skill-feedback/frontend-avoid-20261114-100100'] | branches left: ['skill-feedback/frontend-avoid-20261114-100100']`

### R2-11 and R2-12 Prompt review completion marker (unreadable marker)

Command: `cd "$S/probes/r2" && no-session-env uv run --no-project python probe_review_state_r2.py "$S"`
Expected lines (rc 0):
- `A first run: outcome=no_change model_calls=12 status_success=True`
- `B second run intact: outcome=already_reviewed model_calls=0 status_success=True`
- `C state parse error: JSONDecodeError`
- `C run with corrupt state: outcome=no_change model_calls=12 status_success=True`
- `D1 intact prior success: False failure_class: review_failed previous_success outcome: no_change`
- `D2 corrupt prior success: False failure_class: review_failed previous_success outcome: None`
- `real CLI attempted: False`

### Prompt review cycle busy path (G2)

Command: `cd "$S/probes/r2" && no-session-env uv run --no-project python probe_busy_status_r2.py "$S"`
Expected lines (rc 0):
- `busy (lock held) | rc = 1 | output = Prompt review cycle busy | run called = False`
- `busy (lock held) | status file exists = False | state file exists = False`

### Frontend proposal same-second race (G1, task P-28)

Command: `cd "$S/probes/py" && no-session-env uv run --no-project python probe_frontend_avoid.py`
Expected lines (rc 0):
- `C control single run: outcome = {'url': 'https://example.invalid/pull/1'} | branches = [...-100000'] | pulls = 1`
- `R run A outcome = {'error': 'GitHub request failed: DELETE git'}`
- `R run B outcome = {'error': 'GitHub request failed: POST git'}`
- `R branches left = [] | pulls opened = 0`

### Activation trace by-design (round 1 G2, rerun)

Command: `cd "$S/repo" && no-session-env uv run --no-project python -m unittest -v tests.test_activation_trace.ActivationTraceTests.test_extra_or_truncated_node_output_does_not_prove_single_read tests.test_activation_trace.ActivationTraceTests.test_truncated_supported_node_reads_and_unattributed_batches_stay_uncertain`
Expected: two test lines, `Ran 2 tests`, `OK`, rc 0.
(A `-k` filter matches three tests, so use the exact names.)

### read_guidance legacy root (RG-1)

Command: `cd "$S/probes/py" && HOME="$S/fakehome" no-session-env uv run --no-project python probe_guidance.py`
Expected lines (rc 0):
- `G1 agent-skills path -> ('rust/SKILL.md', 0)`
- `G2 codex-skills path -> ('rust/SKILL.md', 0)`
- `G3 other root refused -> refused: Not the shared guidance reader`

## Still holds (round 1 reruns, this round)

- Evidence set: `cd "$S/probes/r2-ev" && no-session-env uv run --no-project python evidence_probe.py "$S" a` (also `c` and `e`).
- E-a: `E-a run=1 verify_calls=1 correct_calls=1 receipts=0 rate_limited=1 pending=1`, `E-a run=2 ...` (rc 0).
- E-c: `E-c valid_attempts_after_skip=3`, `E-c after_corrupt attempts=1 exit=no_exception counts_unavailable=1 file_now_valid=yes` (rc 0).
- E-e: `E-e assessments=2 latest=1 latest_summary=Second summary exit=no_exception` (rc 0).
- EV-b: `no-session-env uv run --no-project python eb_probe.py "$S"`. Expected `EV-b run1 rc=0 success=True paid_calls=1`, `EV-b receipts=1`, `EV-b run2 rc=1 ... status_unchanged=True paid_calls=0` (rc 0).
- E-d2 backoff lost on SIGKILL. The folders must be fresh; the probe does not clear them. Run in this order, with `B="$S/probes/r2-ev"`:
  - `rm -rf "$B/bl-control" "$B/bl-kill"`
  - `no-session-env uv run --no-project python backoff_lost_probe.py "$S" "$B/bl-control" control` (rc 0)
  - `no-session-env uv run --no-project python backoff_lost_probe.py "$S" "$B/bl-kill" kill` (rc 137, SIGKILL)
  - `no-session-env uv run --no-project python backoff_lost_probe.py "$S" "$B/bl-kill" rerun` (rc 0)
  - Expected rerun line: `MODE=rerun backoff_file_before=no calls=['t1', 't2'] ...`. Defect reproduced: the settled t1 is called again.
- E-d in-flight check repeats after SIGKILL. Remove the folder first, then use it: `F="$S/probes/r2-final/bk"; rm -rf "$F"`:
  - `no-session-env uv run --no-project python backoff_kill_probe.py "$S" "$F" kill` (rc 137)
  - `no-session-env uv run --no-project python backoff_kill_probe.py "$S" "$F" rerun` (rc 0)
  - Expected rerun line: `MODE=rerun calls=['t2'] unresolved=1 checked=1 backoff_file=yes receipts=2`.
  - Verdict: the in-flight paid call repeats. No start record exists before a paid call. Design question.

## Coverage greps (test claims)

Run from `$S/repo`. Each prints its own exit code.
- `grep -n -i "corrupt\|truncat\|JSONDecode" tests/test_prompt_review.py` gives rc 1 (marker tests).
- `grep -n -i "busy" tests/test_prompt_review.py` gives rc 1.
- `grep -n -i "injected\|OSError" tests/test_prompt_runtime.py` gives rc 1.
- `grep -n -i "chunk\|version" tests/test_read_guidance.py` gives rc 1.
- `grep -n "codex-skills" tests/test_read_guidance.py` gives rc 1.
- `grep -n -i "corrupt\|broken" tests/test_investigations.py` gives rc 1.
- `grep -n -i "overlap\|concurr\|orphan" tests/test_frontend_avoid.py` gives rc 0, line 328 only.
- `grep -n "start_new_session\|setsid" tests/test_skill_evals.py scripts/skill_evals.py` gives rc 0, script line 149 only.

## Proposed tasks (auto=false, body starts "Proposal:")

Each entry: title, problem, evidence, change, size.

1. Investigation: fail-open on any origin/main check error (R2-1). Size S.
- Problem: `remote_issue_events` returns None on any rev-parse failure, so `record` skips the guard.
- Evidence: `probe_inv_g4_real_r2.out:17-18`, `probe_inv_r2.out:5-6`.
- Change: return None only when the ref is absent. Raise on other git errors.

2. Investigation run: failed record write leaves folders with no record (R2-2). Size M.
- Problem: a failed run record leaves log and artifact folders, and a retry adds more.
- Evidence: `probe_inv_r2.out:11-12`.
- Change: write the record last through a temp file, or remove the folders on failure.

3. Investigation run: child wait has no time limit (R2-3). Size S.
- Problem: `run()` waits with no timeout (566).
- Evidence: `probe_inv_r2.out:14`. The hang was not reproduced.
- Change: pass a timeout, kill on expiry, and record a timed-out result.

4. Investigation cycle: complete with open dispositions (R2-4). Size S.
- Problem: `validate_cycle` sets `complete: True` (442) with an open disposition.
- Evidence: `probe_inv_r2.out:16-17`.
- Change: complete only when the open count is zero.

5. Prompt bundle: partial copy blocks retry (R2-5). Size M.
- Problem: a copy that fails midway leaves a destination that refuses every retry.
- Evidence: `probe_misc_r2.out:6-8`.
- Change: copy to a temp folder and rename on success, or remove the partial folder on failure.

6. Skill evaluation: no cost cap on a run (R2-6). Owner decision (reason: cost), auto=false.
- Problem: nothing caps calls or spend per evaluation run.
- Evidence: the grep in R2-6 gives no match.
- Change: owner chooses a cap, or none. Recommendation: set a per-run cap before the next paid run.

7. Skill evaluation: escaped grandchild holds the pipe (R2-7). Size S.
- Problem: `killpg` reaches only the leader's group. A grandchild in its own session keeps the pipe open, and the unbounded `communicate()` (164) waits forever.
- Evidence: `probe_skill_r2.out:1-3`.
- Change: track and kill descendants, and bound the post-kill `communicate`.

8. read_guidance: chunks from two file versions join (R2-8). Size M.
- Problem: chunks are checked for offset only. A chunk chain can mix two versions of one file.
- Evidence: `probe_misc_r2.out:10-14`.
- Change: check a file version or hash on each chunk. Reject a mixed chain.

9. Frontend proposal: overlapping runs open two PRs (R2-9). Size S.
- Problem: `propose` reads state with no lock, so two runs both create PRs.
- Evidence: `probe_front_r2.out:2-3`.
- Change: take a lock around read, create and state write.

10. Frontend sweep: deletes an in-flight branch (R2-10). Size S.
- Problem: `remove_orphans` (192-193) deletes any branch with no PR, including a branch another run is about to use.
- Evidence: `probe_front_sweep_r2.out:2-4`.
- Change: delete only branches older than a grace period, or only branches this run created.

11. Prompt review: unreadable completion marker reruns the due week (R2-11). Size M.
- Problem: an unreadable marker is read as `{}` (869-870). A no_change run leaves no record, so the due week reruns.
- Evidence: `probe_review_state_r2.out` lines C and B (12 model calls against 0).
- Change: fail loudly on an unreadable marker, or write the marker atomically and keep a record for no_change runs.

12. Prompt review: failure loses the previous result on an unreadable marker (R2-12). Size S.
- Problem: `previous_success` becomes None (909).
- Evidence: `probe_review_state_r2.out` lines D1 and D2.
- Change: keep the last result in the status file. Fixing R2-11 fixes this too.

13. Frontend proposal: same-second runs collide (P-28, corrected mechanism). Size S.
- Problem: names are built to the second (197). The except clause (207-209) deletes the other run's branch.
- Evidence: `fa1-rerun.out` (B deletes A's branch, then both runs fail).
- Change: add a unique suffix, and delete only a branch this run created.

14. Prompt review ledger: double terminal event (P-10, refuted for the reachable trigger). Size S.
- Problem: none for the reachable trigger. A second terminal event needs a direct double write.
- Evidence: `probe_misc_r2.out:2-4`.
- Change: recommend withdrawal. If kept, reword as hardening (assert one terminal event).

15. Evidence backoff: in-flight paid check repeats after SIGKILL (E-d, design question). Size S.
- Problem: no start record exists before a paid call, so a kill repeats the call.
- Evidence: E-d rerun, `calls=['t2']`.
- Change: owner decides. Option: write a start record before each paid call.

16. Evidence backoff: settled backoff lost on SIGKILL (E-d2, round 1 task). Size S.
- Problem: the backoff entry is not saved before the next check runs. A kill loses it.
- Evidence: E-d2 fresh-folder rerun, `backoff_file_before=no calls=['t1','t2']`.
- Change: save the backoff entry before the next check starts. File if not already on the board.

## Notes for the parent (not tasks)

- dotfiles-357: the busy path writes no status file. See the busy-path block.
- dotfiles-356: copy-dependent tests. An rsync exclusion removed tracked files (round 2 setup friction).
- E-d and E-d2 probes are not idempotent: they need fresh folders.
