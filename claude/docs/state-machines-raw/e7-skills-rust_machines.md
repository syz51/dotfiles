Repository: agent-skills

Audited commit: 7e772d6 (live checkout, read only). Probes ran on a scratch copy of that commit.
Machines: 18.
Changed since 2026-11-12 in src, scripts or tests: 6c0d302, 8582722, aa04dd8 (all ancestors of 7e772d6). I checked their file lists only. Line-level effect on each machine is not checked; no new machine was found in the file lists.
Probe IDs (R-a, EV-b, PR-a, ...) are defined in probes.md.

### Export run

- Where: `src/export.rs` (`acquire` 52, `lock_file` 62, `prepare` 434, `execute_with_checks` 783, `message_quality` 1013), `src/main.rs` (31-44, 50-53), `src/cancellation.rs`
- States: idle, locked, fetched, refused, candidate-checked, message-generated, pushed, state-saved, cancelled, failed
- Transitions:
  - idle -> locked: publication lock taken. Enforced at `src/export.rs:52-62`.
  - locked -> fetched: origin fetched. Enforced at `src/export.rs:837`.
  - fetched -> refused: trusted state missing or public main absent. Enforced at `src/export.rs:514` and `src/export.rs:518`.
  - fetched -> candidate-checked: temp checkout, secret scan, candidate tests. Enforced at `src/export.rs:832` and `src/export.rs:882-888`.
  - candidate-checked -> message-generated: generated message returned. Enforced at `src/message.rs:246`.
  - message-generated -> refused: origin URL differs after generation. Enforced at `src/export.rs:953-955`.
  - message-generated -> failed: subject outside 12 to 100 bytes. Enforced at `src/export.rs:1016-1017`; error at `src/export.rs:1033`.
  - message-generated -> pushed: push to public main. Enforced at `src/export.rs:994`.
  - pushed -> state-saved: export state written. Enforced at `src/export.rs:997-1004`.
  - any -> cancelled: SIGINT or SIGTERM seen at a poll. Enforced at `src/export.rs:130-131` and `src/export.rs:195-198`.
- Gaps:
  - G1 A subject of 101 to 120 bytes passes message validation (12 to 120) and fails `message_quality` after the paid call. Verdict: confirmed. Evidence: R-a: A2 exit=1 calls=1; A3 exit=1 calls_total=2; A4 (100 bytes) exit=0. Bounds at `src/message.rs:46-47` and `src/export.rs:1016-1017`. Task: new (P-1).
  - G2 A crash after push and before the state save. Verdict: refuted. Evidence: R-c: C1 exit=137, state unchanged; C2 exit=0 calls_total=1, state equals main. Task: none.
  - G3 A global `insteadOf` rule rewrites `remote get-url origin`, so the check after generation fails. Verdict: confirmed (latent; this Mac has no such rule). Evidence: R-i: I1 exit=1 calls=1, main unchanged, "Public candidate changed during message generation". Enforced at `src/export.rs:953-955`. Task: new (P-2).
  - G4 SIGKILL during fetch leaves a candidate checkout in the temp dir. Verdict: confirmed (residue only; next run exit=0). Evidence: R-e: "E killed; fetch_pid_seen=yes", two leftover `.tmp*/checkout/.git` entries, E2 exit=0. Temp dir at `src/export.rs:832`. Task: new (P-3).
  - G5 A direct `Command::new("git")` at `src/export.rs:420` skips the polled helper (`src/export.rs:212-227`), so SIGTERM is not seen during it. Verdict: unverified (reading only; no probe run). Evidence: `src/export.rs:420`. Task: new (unverified).
- Tests: `tests/rust_export.rs` (17 tests) and `tests/rust_message.rs` (21 tests). `cargo test --locked`: 83 passed, exit 0. No test builds a 101 to 120 byte subject.

### Configuration load

- Where: `src/config.rs` (`Config::load` 75, `from_value` 78, checks 83 and 119-140, `gitleaks_path` field 38, default 44), `src/main.rs` (66-69)
- States: unread, parsed, rejected, valid
- Transitions:
  - unread -> parsed: config file read as typed data. Enforced at `src/config.rs:75-78`.
  - parsed -> rejected: schema_version not 1, target_url mismatch, or no files. Enforced at `src/config.rs:83`.
  - parsed -> valid: scope and duplicate checks pass. Enforced at `src/config.rs:119-140`.
  - parse error -> generic message: serde error prints one fixed line. Enforced at `src/main.rs:66-67`.
- Gaps:
  - G1 `gitleaks_path` defaults to the bare name `gitleaks`, which PATH resolves at run time. Verdict: by design. Evidence: test `src/config.rs:177` (`gitleaks_path_is_absolute_or_a_program_name`); `cargo test --locked --lib gitleaks_path_is_absolute_or_a_program_name` exit 0, "1 passed". Bare name accepted at `src/config.rs:164-165`. Task: none.
  - G2 A config or state parse error names no file. Verdict: confirmed. Evidence: R-b: B1 exit=1 status_unchanged=yes calls=0; stderr "Publication failed: invalid JSON configuration or local state." Enforced at `src/main.rs:66-67`. Task: new (P-5).
- Tests: none pins the generic message in `tests/rust_export.rs` or `tests/rust_daily.rs`. The unit test at `src/config.rs:177` pins the path rule only.

### Daily deadline run

- Where: `src/daily.rs` (`run_with` 49, `read_state` 102), job lock at `src/daily.rs:55` (lock code `src/export.rs:52-62`), dispatch `src/main.rs:31-44`
- States: due, locked, skipped, started, succeeded, failed, deferred, refused, killed while started
- Transitions:
  - due -> locked: job.lock acquired. Enforced at `src/daily.rs:55`.
  - due -> refused: job.lock busy; the error propagates and no status is written. Enforced at `src/daily.rs:55`.
  - locked -> skipped: stored completed_due at or after the due time. Enforced at `src/daily.rs:58-60`.
  - locked -> failed: stored state unreadable, before any status write. Enforced at `src/daily.rs:58`.
  - locked -> started: start status written with success null. Enforced at `src/daily.rs:63-64`.
  - started -> succeeded: status success true, then state saved. Enforced at `src/daily.rs:90-93` and `src/daily.rs:95`.
  - started -> failed: status success false with error and finished_at. Enforced at `src/daily.rs:82-87`.
  - started -> deferred: publish lock held; status outcome "deferred", success null, finished_at set. Enforced at `src/daily.rs:73-78`.
  - started -> killed while started: SIGKILL; no code writes a finish. Enforced at `src/daily.rs:63-64` (the last write).
- Gaps:
  - G1 A corrupt daily state fails before the start status is written. The status keeps its old value and the message is generic. Verdict: confirmed. Evidence: R-b: B1 exit=1 status_unchanged=yes calls=0; B2 exit=1 status_unchanged=yes; B3 exit=0 after manual delete. Enforced at `src/daily.rs:58`. Task: new (P-5).
  - G2 SIGKILL during the run leaves daily-status.json with success null and no finished_at. The next run clears it. Verdict: confirmed. Evidence: R-g: "G status after SIGKILL" shows success null, no finished_at; "G2 next daily exit=0" shows success true. Enforced at `src/daily.rs:63-64`. Task: new (P-6). Parent to check overlap with dotfiles-357 and dotfiles-527.
  - G3 An overlapping run while job.lock is held. Verdict: by design. Evidence: test `tests/rust_daily.rs:91-105` (`overlapping_job_never_calls_publication`); `cargo test --locked --test rust_daily overlapping_job_never_calls_publication` exit 0, "1 passed". The stale-alert monitor side is open: dotfiles-357. Task: dotfiles-357 (monitor side only).
  - G4 Two writers of daily-status.json: `src/daily.rs` and `scripts/public_export_job.py:31,37,40`. Verdict: unverified (reading only; no probe or test). Evidence: grep of both files. Task: new (unverified). dotfiles-527 reads this file.
  - G5 The deferred path (`src/daily.rs:73-78`) writes success null with finished_at set. Verdict: unverified (a probe needs `export.lock` held). Task: new (unverified).
- Tests: `tests/rust_daily.rs` (9 tests). Lines 74-89 assert only `is_err()` for corrupt state. Lines 91-105 pin the job-lock refusal.

### State files and locks

- Where: `src/export.rs:52-62` (lock), `src/export.rs:81` (save), `src/export.rs:511-518` (trusted state), `scripts/prompt_review.py:879-883` (skill-sync.lock), `src/daily.rs` (daily state)
- States: lock free, lock held, state absent, state valid, state corrupt, public main present, public main absent
- Transitions:
  - lock free -> lock held: flock acquired. Enforced at `src/export.rs:52-62`.
  - state absent -> accepted: public tree already equals the candidate ("exact" branch). Enforced at `src/export.rs:511-514`.
  - state absent -> refused: public tree differs and trusted state is required. Enforced at `src/export.rs:514`.
  - public main present -> absent: publish refused. Enforced at `src/export.rs:518`.
  - state valid -> corrupt: manual edit; daily refuses before its start write. Enforced at `src/daily.rs:58` and `src/main.rs:66-67`.
- Gaps:
  - G1 Losing the trusted state stops publication, and the message names no recovery step. Verdict: confirmed. Evidence: R-d1: D1 exit=1 calls=0, main unchanged, "Publication failed: Existing public repository requires trusted state"; D1b exit=0 calls=0 when the public tree is exact. Enforced at `src/export.rs:514`. Task: new (P-4). Choice of recovery route is for the owner.
  - G2 Losing the public main ref stops publication with "Public main disappeared". Verdict: confirmed. Evidence: R-d2: D0 exit=0; D2 exit=1 calls=0, main absent, state kept. Enforced at `src/export.rs:518`. Task: new (P-4).
  - G3 Neither refusal message appears in any test. Verdict: confirmed. Evidence: `grep -rn "trusted state\|disappeared" tests | wc -l` prints 0. Task: new (P-4).
  - G4 A killed run releases its flock on death, so the next run is not blocked. Verdict: unverified (reading only; the OS releases flock on process exit). Evidence: `src/export.rs:52-62`. Task: none unless probed.
- Tests: no test for the two refusal messages. The lock-busy path is pinned at `tests/rust_daily.rs:91-105`.

### Message generation and fallback

- Where: `src/message.rs` (`generate_message` 246, `api_auth` 370, `read_fallback` 414, `retry_at` 443, `record_fallback` 474-500, `parse_stream` 612, `validate` 749, `run` 947), bounds `src/message.rs:46-47`
- States: requested, parsed, rejected, accepted, rate-limited, waiting
- Transitions:
  - requested -> parsed: stream read into a commit message. Enforced at `src/message.rs:612`.
  - parsed -> rejected: subject outside 12 to 120 bytes. Enforced at `src/message.rs:722` and `src/message.rs:804-805`.
  - parsed -> rejected: body and subject over the body limit. Enforced at `src/message.rs:809`.
  - parsed -> accepted: validation passes. Enforced at `src/message.rs:749`.
  - requested -> rate-limited: fallback entry recorded. Enforced at `src/message.rs:474-500`.
  - rate-limited -> waiting: retry time set. Enforced at `src/message.rs:443`.
  - waiting -> requested: retry time passed. Enforced at `src/message.rs:414`.
- Gaps:
  - G1 The message side accepts 12 to 120 bytes. The export side rejects 101 to 120 after the paid call. Verdict: confirmed. Evidence: R-a: A2 and A3 (see Export run G1). Task: new (P-1, same task as Export G1).
  - G2 `record_fallback` reads and rewrites the fallback file with no lock, so two runs can drop an entry. Verdict: unverified (reading only). Evidence: `src/message.rs:474-500`. Task: new (unverified).
- Tests: `tests/rust_message.rs` (21 tests). No case builds a 101 to 120 byte subject.

### Investigation issue events

- Where: `scripts/investigations.py` (`validate_event` 78, rules 114-116 and 120, `heads_for` 135, raise 148, `inventory` 155, `remote_issue_events` 168 with except 172, `require_unbranched` 180, `record` 387, save with `exclusive=True` 54-57)
- States: open, provisional, blocked, resolved, dropped; one head per issue
- Transitions:
  - any -> any: `record` writes the new event. No transition table exists. Enforced at `scripts/investigations.py:387` (no state check).
  - any -> open, provisional or blocked: needs a board task. Enforced at `scripts/investigations.py:114-116`.
  - any -> resolved: needs baseline, candidate and contrast behavior evidence. Enforced at `scripts/investigations.py:120` and `scripts/investigations.py:374-384`.
  - resolved -> dropped: accepted with no check. Enforced at `scripts/investigations.py:387` (no state check).
- Gaps:
  - G1 No transition table: open -> resolved and resolved -> dropped are accepted. Verdict: confirmed (accepted behavior). Evidence: I-h: "I-h open -> resolved: accepted", "I-h resolved -> dropped: accepted". Whether these must be legal is the owner's decision. Task: new (P-23, design ask).
  - G2 `record` takes no lock, so two calls can both write a head. Inventory and cycle validation then raise. Verdict: confirmed. Evidence: I-b: "I-b both record calls returned: True", "I-b event files: 2", then "I-b inventory raised ValueError: Unlinked investigation histories". Task: new (P-21).
  - G3 Working-tree heads and the committed cycle disagree. Verdict: confirmed. Evidence: I-r: "I-r open heads in working tree: 1", "I-r outstanding in new cycle: 0". Sources at `scripts/investigations.py:155-165` and `scripts/investigations.py:258`. Task: new (P-24).
  - G4 `remote_issue_events` returns None on any CalledProcessError, not only a missing origin/main. Verdict: unverified (reading only). Evidence: `scripts/investigations.py:168-173`. Task: new (unverified).
- Tests: `tests/test_investigations.py` (34 tests; names at lines 182, 304, 311, 318, 332, 343, 357, 364, 376, 434, 453, 463, 474). No test covers concurrent `record` calls or resolved -> dropped.

### Investigation cycle, run and project snapshot

- Where: `scripts/investigations.py` (`prepare` 258, `cycle_data` 295, `validate_cycle` 414, `run` 452, `process.wait` 566, logs and run record 588-593, `snapshot_project` 622)
- States: cycle written, running, finished, recorded, snapshot absent, snapshot copying, snapshot saved, retry refused
- Transitions:
  - none -> cycle written: `prepare` writes the cycle file. Enforced at `scripts/investigations.py:258`.
  - running -> finished: runner process waited on. Enforced at `scripts/investigations.py:566`.
  - finished -> recorded: logs and artifacts written, then the run record. Enforced at `scripts/investigations.py:588-593`.
  - snapshot absent -> copying: destination created and filled. Enforced at `scripts/investigations.py:635`.
  - copying -> snapshot saved: `.snapshot.json` written. Enforced at `scripts/investigations.py:645`.
  - copying -> retry refused: destination exists. Enforced at `scripts/investigations.py:627`.
- Gaps:
  - G1 A fault during the copy leaves a partial destination, and every retry is refused. Verdict: confirmed. Evidence: I-d: "I-d first attempt raised CalledProcessError, returncode 128", "I-d partial files: ['dirty.py']", "I-d .snapshot.json present: False", "I-d retry: refused: Project snapshot needs a new destination and registered Git root". Enforced at `scripts/investigations.py:627`. Task: new (P-22).
  - G2 Logs and artifacts are written before the run record, so a save failure leaves orphan folders. Verdict: unverified (reading only). Evidence: `scripts/investigations.py:588-593`. Task: new (unverified).
  - G3 `process.wait()` at `scripts/investigations.py:566` has no timeout. Verdict: unverified (reading only). Task: new (unverified).
  - G4 A cycle has no expiry or end state. Verdict: unverified (reading only). Evidence: `scripts/investigations.py:414-442`. Task: new (unverified).
- Tests: `tests/test_investigations.py` (same names as above). No test covers a snapshot retry or a runner timeout.

### Evidence records and backoff

- Where: `scripts/evidence.py` (`BACKOFF` 36, `parse_receipt` 138, `latest_receipt` 149-159, `load_backoff` 307, `save_backoff` 338, `verify` 360, `main` 550)
- States: unchecked, pending, checked, backoff corrupt, run ok, run failed, two receipt heads
- Transitions:
  - unchecked -> pending: rate limit or error saved to backoff. Enforced at `scripts/evidence.py:422` (no targets) and `scripts/evidence.py:546` (end of run).
  - pending -> pending: attempt count grows; a window still open skips the check. Enforced at `scripts/evidence.py:409-412`.
  - pending -> checked: verify result and correction, then receipt written exclusively. Enforced at `scripts/evidence.py:505` and `scripts/evidence.py:510`.
  - rate limit during correction: no backoff entry and no receipt. Enforced at `scripts/evidence.py:519-523`.
  - backoff corrupt -> empty: silent reset. Enforced at `scripts/evidence.py:317`.
  - run ok -> run failed: caught in `main`; status file not rewritten. Enforced at `scripts/evidence.py:577` and `scripts/evidence.py:580`.
  - two receipt heads -> newest used: silent. Enforced at `scripts/evidence.py:149-159`.
- Gaps:
  - G1 A rate limit during correction, after a paid verify, loses that result. The next run pays for verify again. Verdict: confirmed. Evidence: EV-a: run=1 verify_calls=1 correct_calls=1 receipts=0 rate_limited=1; run=2 verify_calls=2 correct_calls=2 receipts=0. Keeping the note pending is pinned at `tests/test_evidence.py:665-674` and `:730-747`. The repeated paid call is not pinned. Task: new (P-16).
  - G2 A failed run leaves evidence-status.json with success true and prints nothing to stderr. Verdict: confirmed. Evidence: EV-b: run1 rc=0 success=True paid_calls=1; run2 rc=1, stdout "Source verification failed; source data and existing receipts are preserved.", stderr_bytes=0, status_unchanged=True, paid_calls=0. The abort is pinned at `tests/test_evidence.py:416-417`; the stale success status is not. Task: new (P-17).
  - G3 A corrupt backoff file resets attempt counts with no report. Verdict: confirmed (the silent part). Evidence: EV-c: "valid_attempts_after_skip=3"; "after_corrupt attempts=1 exit=no_exception". The reset is pinned at `tests/test_evidence.py:1043-1053`; the silence is not. Task: new (P-18).
  - G4 Backoff is saved only at run end. A SIGKILL loses the run's backoff entries, so the rerun checks again. Verdict: confirmed. Evidence: EV-d2: control run "backoff_file_after=yes"; kill run rc=137 with no output; rerun "MODE=rerun backoff_file_before=no calls=['t1', 't2']". The control rerun, with the file kept, makes no calls. Task: new (P-19).
  - G5 Two receipt heads with no supersedes: the newest is used silently. Verdict: confirmed. Evidence: EV-e: "E-e assessments=2 latest=1 latest_summary=Second summary exit=no_exception". No test pins this. Task: new (P-20).
- Tests: `tests/test_evidence.py` pins 416-417, 665-674, 730-747, 1043-1053. `unittest test_evidence test_prompt_review test_skill_evals`: Ran 148 tests, OK, exit 0.

### Prompt review cycle

- Where: `scripts/prompt_review.py` (`due_key` 80-86, `target_role` 97-101, `publish` 793-850, `run` 859-912, `review` 915-1013, `main` 1018-1046)
- States: due pending, locked, lock busy, source changed, proposed, frozen, approved, rejected, promoted, failed
- Transitions:
  - due pending -> locked: skill-sync lock taken. Enforced at `scripts/prompt_review.py:879`.
  - locked -> lock busy: RuntimeError raised. Enforced at `scripts/prompt_review.py:883`.
  - locked -> failed: outer handler writes review_failed and re-raises `from None`. Enforced at `scripts/prompt_review.py:907-912`.
  - locked -> source changed: SourceChanged keeps the due pending. Enforced at `scripts/prompt_review.py:911`.
  - approved -> promoted: push, then the finish is written as promoted. Enforced at `scripts/prompt_review.py:841` and `scripts/prompt_review.py:1013`.
  - publish -> cleanup: worktree removed with --force in finally. Enforced at `scripts/prompt_review.py:849-850`.
  - main -> caller: only RuntimeError is caught. Enforced at `scripts/prompt_review.py:1044`.
  - --due parse: the due_key call sits before the try, so a naive due raises. Enforced at `scripts/prompt_review.py:863` and `scripts/prompt_review.py:86`.
- Gaps:
  - G1 The failure cause is lost: `run` re-raises RuntimeError `from None`, and the status keeps only the class name. Verdict: confirmed. Evidence: PR-c: "__cause__ = None", "context suppressed = True", "failure_class = review_failed"; failure file content "failure_class":"RuntimeError". Enforced at `scripts/prompt_review.py:912`. Task: new (P-9).
  - G2 Lock busy refuses with the cause lost: no lock name in status, no completion marker. Verdict: confirmed. Evidence: PR-g: "lock named in status = False", "completion marker written = False"; control without the lock: "outcome = promoted". Enforced at `scripts/prompt_review.py:883`. Task: new (P-9). The monitor side is dotfiles-357.
  - G3 A crash after the push and before the promoted write leaves the attempt pending. Verdict: confirmed. Evidence: PR-a (see Prompt review attempt ledger G1). Task: new (P-7).
  - G4 A naive `--due` raises a traceback before any status write. Verdict: confirmed. Evidence: PR-f: "exit = 1 | last stderr line = ValueError: Due requires timezone"; "status file unchanged = True". Enforced at `scripts/prompt_review.py:86` and `scripts/prompt_review.py:863`. Task: new (P-12).
  - G5 SIGKILL during the push leaves a registered worktree and a temp dir. Verdict: confirmed. Evidence: PR-e: "child exit code = 9"; "registered prompt-review worktrees = 1 | leftover temp dirs = 1"; main and origin unchanged. Enforced at `scripts/prompt_review.py:805` and `scripts/prompt_review.py:849-850`. Task: new (P-11).
  - G6 `target_role` jumps by +3 from 2026-11-09. Verdict: by design. Evidence: comment at `scripts/prompt_review.py:98-99`; test `tests/test_prompt_review.py:1016` (`test_rotation_keeps_past_weekly_targets_and_resumes_after_daily_period`); unittest exit 0, OK. Task: none.
- Tests: `tests/test_prompt_review.py` (pins at 183, 193, 225, 341, 358). Not pinned: failure cause, orphan pending attempt, worktree after a kill.

### Prompt review attempt ledger

- Where: `scripts/prompt_review.py` (`MAX_ATTEMPT_EVENTS` 28, `ATTEMPT_REASONS` 32, `validate_attempt_ledger` 575, `attempt_events` 633, `append_attempt` 651, `freeze_attempt` 691, `finish_attempt` 709)
- States: none, pending, terminal, orphan pending, ledger ok, ledger full, ledger broken
- Transitions:
  - none -> pending: attempt frozen before approval. Enforced at `scripts/prompt_review.py:691`; cap check at `scripts/prompt_review.py:694`; caller at `scripts/prompt_review.py:963`.
  - pending -> terminal: finish written (promoted, rejected or failed). Enforced at `scripts/prompt_review.py:709` (callers at 968, 980, 990, 1000, 1013).
  - pending -> orphan pending: crash between steps. No code path concludes it. Enforced at none.
  - ledger -> full: 1024 events; every new freeze is refused. Enforced at `scripts/prompt_review.py:638`, `scripts/prompt_review.py:657` and `scripts/prompt_review.py:694`.
  - ledger -> broken: two terminal events for one attempt. Enforced at `scripts/prompt_review.py:619`.
- Gaps:
  - G1 A crash between the push and the promoted write leaves the attempt pending for good. Verdict: confirmed. Evidence: PR-a: "PR-a after interruption: status success = False | events = 1"; "PR-a after promoted rerun: outcome = promoted | events = 3 | pending = 2 | pending without terminal (orphans) = 1". Task: new (P-7, same as Prompt review cycle G3).
  - G2 At 1024 events the ledger refuses new attempts, and no archival path exists. Verdict: confirmed (latent). Evidence: PR-b: "pending attempts frozen = 1023", "refusal = Prompt attempt ledger requires explicit archival"; the next review raised "Prompt review failed; due remains pending". Enforced at `scripts/prompt_review.py:694`. Task: new (P-8).
  - G3 `finish_attempt` checks, then writes, with no lock. Two terminal events make the ledger unreadable. Verdict: confirmed for the consequence; the concurrent trigger was not reproduced. Evidence: PR-d: "PR-d files on disk = 3", "ledger readable = no | Broken prompt attempt conclusion". Enforced at `scripts/prompt_review.py:619`. Task: new (P-10).
- Tests: `tests/test_prompt_review.py:341` (interrupted candidate) and `:358` (cap refusal). Not pinned: orphan pending attempt, double terminal event.

### Prompt bundle approval

- Where: `scripts/prompt_runtime.py` (`PROMPT_PATHS` 18, `render` 66, `bundle_hash` 106, `copy_bundle` 116, `load` 130)
- States: legacy, approved, unapproved, mismatch, manifest missing or unsafe, broken symlink
- Transitions:
  - bundle present and manifest hash equal -> approved. Enforced at `scripts/prompt_runtime.py:148`.
  - manifest hash differs -> mismatch error. Enforced at `scripts/prompt_runtime.py:148`.
  - bundle present, no approval hash -> unapproved error. Enforced at `scripts/prompt_runtime.py:151`.
  - manifest without a hash -> legacy: source root used. Enforced at `scripts/prompt_runtime.py:130`.
  - manifest missing or unsafe -> error. Enforced at `scripts/prompt_runtime.py:141`.
  - render reads `maintenance-prompt.md` from the configured root, outside the bundle. Enforced at `scripts/prompt_runtime.py:73`.
- Gaps:
  - G1 `maintenance-prompt.md` is in neither `PROMPT_PATHS` nor `bundle_hash`, yet `render` reads it from the live root. Editing it changes the rendered prompt while the approved hash still matches. Verdict: confirmed. Evidence: P1: "approved promptsSha256 still matches = True", "rendered text changed = True", exit 0. Enforced at `scripts/prompt_runtime.py:73`. Task: new (P-13). Owner should confirm the fix (design).
  - G2 `copy_bundle` writes into the destination in place; a partial copy blocks a re-copy. Verdict: unverified (reading only). Evidence: `scripts/prompt_runtime.py:116-123`. Task: new (unverified).
- Tests: `tests/test_prompt_runtime.py` (181 lines, read in full). It pins legacy fallback (34-39), tamper and missing bundle (98-109), unapproved bundle (129-133), and the protected maintenance render order (41-47). No test checks that the maintenance file is hashed.

### Weekly review attempt

- Where: `scripts/jobs.py` (`review_learning_cycle` 334, active file 346, read 357, superseded 381-382, worktree add 389, attempt saves 396, 403 and 421, ff merge 467, validated 476-478, report 483, cleanup 485-489, `retire_attempts` 497, glob 508)
- States: none, running, validated, merged, published, superseded, retired, orphan work dir, active file corrupt
- Transitions:
  - none -> running: worktree added (389), attempt.json saved (396), active record saved (421).
  - running -> validated: attempt.json status validated. Enforced at `scripts/jobs.py:476-478`.
  - validated -> merged: fast-forward merge to main. Enforced at `scripts/jobs.py:467`.
  - merged -> published: report written and published. Enforced at `scripts/jobs.py:483`.
  - running -> superseded: next run marks the old attempt. Enforced at `scripts/jobs.py:381-382`.
  - finished -> retired: glob matches attempt.json only. Enforced at `scripts/jobs.py:508`.
  - none -> orphan work dir: kill between worktree add and attempt save. Enforced at none.
  - active file corrupt -> refused: JSON read fails on every run. Enforced at `scripts/jobs.py:357`.
- Gaps:
  - G1 A kill after the fast-forward merge (467) and before the attempt finishes: main advances, the active record says running, and the next run starts a new review. Verdict: confirmed. Evidence: J-2: "J-2 main advanced by the killed run: True", "J-2 active status: running", "J-2 review calls on the next run: 1", "J-2 killed run candidate is still on main: True". Task: new (P-25).
  - G2 A kill between worktree add (389) and attempt.json save (396) leaves an orphan work dir that retirement never sees. Verdict: confirmed. Evidence: J-c: "J-c work dirs after kill: 1", "J-c folder has attempt.json: [False]", "J-c orphan work dir still exists after clean run: [True]". Task: new (P-26).
  - G3 A truncated active-attempt.json refuses every run tried. Verdict: confirmed. Evidence: J-b: "J-b run 1 refused: JSONDecodeError", "J-b run 2 refused: JSONDecodeError". Read at `scripts/jobs.py:357`. Task: new (P-27).
- Tests: `tests/test_jobs.py` (LearningTransactionTests at 1015 onward; tests at 1043-1220). No test covers a kill at 389-396 or 467-478. The rest of `tests/test_jobs.py` was not read.

### Skill evaluation run

- Where: `scripts/skill_evals.py` (`TOOLS` 42, `load_cases` 77, `run_process` 146, `run_case` 266, `main` 322)
- States: planned, validated, output created, case running, case scored, case timed out, summary written, failed
- Transitions:
  - planned -> validated: cases loaded. Enforced at `scripts/skill_evals.py:77`.
  - case running -> scored: process returns; result.json written. Enforced at `scripts/skill_evals.py:318`.
  - case running -> timed out: process group killed. Enforced at `scripts/skill_evals.py:153-162`.
  - all cases done -> summary written. Enforced at `scripts/skill_evals.py:361`.
  - case error outside (OSError, ValueError, JSONDecodeError) -> escapes main, no summary. Enforced at `scripts/skill_evals.py:364`.
- Gaps:
  - G1 A case error of another type ends the run with no summary.json. Verdict: confirmed. Evidence: S1: "run_process invocations started = 3 | completed without error = 2 | cases = 30 | result.json files = 2", "summary.json exists = False", and the RuntimeError escapes main. Enforced at `scripts/skill_evals.py:364`. Task: new (P-14).
  - G2 A normal exit does not kill descendants of the case process. Verdict: confirmed (low impact: the real CLI tools are Read and Skill only, `scripts/skill_evals.py:42`). Evidence: S2: "normal exit: code = 0 | timed out = False | descendant alive after return = True"; timeout path "descendant alive after return = False". Killing happens only at `scripts/skill_evals.py:156`. Task: new (P-15).
  - G3 No total cost cap; only per-case timeouts and job bounds (`scripts/skill_evals.py:347-348`). Verdict: unverified (reading only). Task: new (unverified; design question for the owner).
- Tests: `tests/test_skill_evals.py` pins the timeout kill at 359-368. No test covers G1 or G2.

### Activation trace

- Where: `scripts/activation_trace.py` (`node_read_observations` 692, `state.clear` 711, truncation check 713-714, `score_trace` 765, `score_claude_trace` 1142, forbidden check 1095-1097, covered check 802 and 1198-1199, result handling 1218-1220, unanswered tools 1300-1302)
- States per target: not observed, partial, complete, forbidden, unverified. Per trace: completed, failed.
- Transitions:
  - not observed -> partial: read intervals recorded. Enforced at `scripts/activation_trace.py:692`.
  - partial -> complete: covered equals length. Enforced at `scripts/activation_trace.py:802` and `scripts/activation_trace.py:1198-1199`.
  - any -> forbidden: a forbidden read observed. Enforced at `scripts/activation_trace.py:1095-1097`.
  - any -> unverified: tool call never answered. Enforced at `scripts/activation_trace.py:1300-1302`.
  - result events -> verdict: `completed` is set from each result; `failed` is sticky. Enforced at `scripts/activation_trace.py:1218-1220`.
  - parse failure clears node state. Enforced at `scripts/activation_trace.py:711`.
- Gaps:
  - G1 The final verdict depends on event order. Verdict: refuted. Evidence: AO-1 (`probes/act/order_probe.py`): "success-then-failure passed=False completed=False"; "failure-then-success passed=False completed=False"; "success-only passed=True completed=True"; exit 0. Both orders give the same verdict. Task: none.
  - G2 Truncated node output yields no observations and clears the node state. Verdict: unverified (reading only). Evidence: `scripts/activation_trace.py:711` and `:713-714`. Task: new (unverified).
- Tests: `tests/test_activation_trace.py` tests cited at 811 and 1085 (cited lines read). No test covers the event-order case.

### read_guidance envelope

- Where: `scripts/read_guidance.py` (`guidance_path` 18, `request` 43, `read` 62, `observed` 79, `main` 98)
- States: request, accepted, refused, read, observed, mismatch
- Transitions:
  - request -> accepted: path under the agent-skills root or the codex-skills root. Enforced at `scripts/read_guidance.py:52`.
  - request -> refused: any other root. Enforced at `scripts/read_guidance.py:53`.
  - read -> error: raises on out-of-range read. Enforced at `scripts/read_guidance.py:65-70`.
  - observed -> error: envelope check fails. Enforced at `scripts/read_guidance.py:81-94`.
- Gaps:
  - G1 The reader still accepts the codex-skills root, although the workflow was renamed to agent-skills (commit `aa04dd8`). Verdict: confirmed. Evidence: RG-1: "G2 codex-skills path -> ('rust/SKILL.md', 0)", exit 0. `tests/test_read_guidance.py` has no codex-skills case (grep count 0). Enforced at `scripts/read_guidance.py:52`. Task: new (P-29; recommend removal, the owner has no Codex subscription).
  - G2 Continuation and envelope-mismatch paths. Verdict: unverified (reading only). Task: new (unverified).
- Tests: `tests/test_read_guidance.py` (cited lines read). No codex-skills case.

### validate_skill

- Where: `scripts/validate_skill.py` (PEP 723 header line 3, `FRONTMATTER` 15, `problem` 20-74, `read_text` 25, `main` 77)
- States: read, decoded, frontmatter parsed, valid, invalid
- Transitions:
  - file -> decoded: `read_text()` with the default encoding. Enforced at `scripts/validate_skill.py:25`.
  - decoded -> invalid: frontmatter regex fails, as it does when a BOM precedes `---`. Enforced at `scripts/validate_skill.py:15` and `:20-74`.
  - decoded -> valid: checks pass; CRLF accepted. Enforced at `scripts/validate_skill.py:20-74`.
- Gaps:
  - G1 A non-UTF-8 SKILL.md ends with a traceback and no validation message. Verdict: confirmed. Evidence: VS-1: "UnicodeDecodeError: 'utf-8' codec can't decode byte 0xff in position 37", exit 1. Enforced at `scripts/validate_skill.py:25`. Task: new (P-30).
  - G2 A UTF-8 BOM gives "SKILL.md must start with YAML frontmatter between --- lines", which misleads. Verdict: confirmed. Evidence: VS-2: BOM plus the valid rust skill gives that message, exit 1; the control copy gives "Skill is valid.", exit 0. Enforced at `scripts/validate_skill.py:15`. Task: new (P-30).
  - G3 CRLF line endings. Verdict: refuted. Evidence: VS-3: CRLF copy of the rust skill gives "Skill is valid.", exit 0. Task: none.
- Tests: `tests/test_validate_skill.py` (cited lines read). No encoding, BOM or CRLF case. Run it with `uv run <script>` (the PEP 723 header declares pyyaml).

### License bundle

- Where: `scripts/bundle_rust_licenses.py` (`bundle` 9, missing-evidence raise 34, unsafe-notice raise 39, append 40, `main` 44)
- States: package read, evidence found, notice read, bundled, evidence missing, notice unsafe
- Transitions:
  - package -> evidence missing: raise. Enforced at `scripts/bundle_rust_licenses.py:34`.
  - notice -> unsafe: raise for a symlink outside the root or a file over 1 MiB. Enforced at `scripts/bundle_rust_licenses.py:39`.
  - notice -> bundled: section appended. Enforced at `scripts/bundle_rust_licenses.py:40`.
- Gaps:
  - G1 The unsafe-notice branch raises, and no test covers it. Verdict: confirmed (untested branch; the code raises as designed). Evidence: LB-1: "U1-symlink-outside-root raised ValueError: Unsafe dependency notice: dep", "U2-notice-over-1MiB raised ValueError", "U3-control-normal returned 43 chars"; exit 0. Task: new (P-31).
- Tests: `tests/test_rust_license_bundle.py` (cited lines read). It covers the missing-evidence branch only.

### frontend_avoid proposal

- Where: `scripts/frontend_avoid.py` (`BRANCH_PREFIX` 25, `GH_TIMEOUT` 30, `remove_orphans` 187, `create` 196, `propose` 213, state read 225, state write 254, `main` 259); caller `scripts/jobs.py:710-711`
- States: none, branch created, draft PR open, recorded, failed, orphan branch
- Transitions:
  - none -> branch created: branch name built to the second. Enforced at `scripts/frontend_avoid.py:197`.
  - branch created -> failed: any create error; branch deleted when no PR exists. Enforced at `scripts/frontend_avoid.py:204` and `scripts/frontend_avoid.py:208-209`.
  - draft PR open -> recorded: state written with `capture.atomic`. Enforced at `scripts/frontend_avoid.py:254`.
  - orphan branch -> removed. Enforced at `scripts/frontend_avoid.py:187`.
- Gaps:
  - G1 Two runs in the same second pick the same branch name. The second create fails, its cleanup deletes the first run's branch, and both runs fail. Verdict: confirmed. Evidence: FA-1: "R run A outcome = {'error': 'GitHub request failed: DELETE git'}", "R run B outcome = {'error': 'GitHub request failed: POST git'}", "R branches left = []", "pulls opened = 0". Control (single run): "pulls = 1". Enforced at `scripts/frontend_avoid.py:197` and `scripts/frontend_avoid.py:204-209`. Task: new (P-28).
  - G2 The state file is read with no lock (225) and written at 254, so two runs can overwrite each other's handled and proposed sets. Verdict: unverified (reading only). Task: new (unverified).
  - G3 A kill between PR creation and the state write at `scripts/frontend_avoid.py:254`. Verdict: unverified (not probed). Task: new (unverified).
- Tests: `tests/test_frontend_avoid.py` (cited lines read; pins at 305, 315, 328 among others). No concurrency case.
