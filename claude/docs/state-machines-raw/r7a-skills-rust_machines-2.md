Repository: agent-skills

Round 2 of the implicit state machine audit (dotfiles-546), Rust exporter area.
Live checkout at HEAD 7e772d6, clean when read. Probes ran only in the scratch copy.
Scratch paths below are relative to the scratch folder. Labels T1-T10 are proposals in probes-2.md; none is filed.
Machines in area: 10 (4 corrected, 5 new, 1 unchanged and not copied: Configuration load).

### Export run

- Where: `src/export.rs` (`execute_with_checks` 783-1007, `contained` 407-430), `src/message.rs`, `src/main.rs`
- States: idle, export lock held, cycle lock waiting, cycle lock held, candidate checkout, candidate checked, message generated, pushed, state saved, failed
- Transitions:
  - idle -> export lock held: nonblocking flock on the state folder lock. Enforced at `src/export.rs:791`, `src/export.rs:52-62`.
  - export lock held -> cycle lock held: shared wait, up to 300 s. Enforced at `src/export.rs:792-800`.
  - lock held -> candidate checkout: temp clone, then fetch origin. Enforced at `src/export.rs:832-837`.
  - candidate checkout -> candidate checked: prepare, secret scan, candidate tests, Rust checks. Enforced at `src/export.rs:838-896`.
  - candidate checked -> message generated: one generation call per changed file; origin check each time. Enforced at `src/export.rs:897-970`, `src/export.rs:953-955`.
  - message generated -> pushed: one push, no retry. Enforced at `src/export.rs:994`.
  - pushed -> state saved: write export state. Enforced at `src/export.rs:996-1004`.
  - any -> failed: error printed and exit code set. Enforced at `src/main.rs:65-72`.
- Gaps:
  - G1 Subjects of 101 to 120 bytes pass message validation, then fail at export after one generation call. Verdict: confirmed. Evidence: `bash probes/run-probes.sh` (ran to its DONE line), block A: "A2 exit=1 calls=1" with "Publication failed: Uninformative or invalid commit message"; "A3 same input again exit=1 calls_total=2"; "A4 exit=0 calls_total=3" (100 bytes). Bounds: `src/message.rs:722` counts characters (12-120); `src/message.rs:804-805` counts bytes (12-120); `src/export.rs:1016-1017` counts bytes (12-100); error at `src/export.rs:1033`. Task: new (T1).
  - G2 A crash after push and before the state save. Verdict: refuted. Evidence: block C: "C1 exit=137 calls=1 main=5dc0cf2 state_before=a647a35 state_after=a647a35" (state unchanged); "C2 next publish exit=0 calls_total=1 main=5dc0cf2 state=5dc0cf2" (main equals the pushed commit; no new call). Task: none.
  - G3 A global `insteadOf` rule rewrites the origin URL, so the origin check after generation fails. Verdict: confirmed (latent; this Mac has no such rule). Evidence: `bash probes/run-insteadof.sh` (ran to its DONE line): "I1 exit=1 calls=1 main= state=" and "Publication failed: Public candidate changed during message generation". Check at `src/export.rs:953-955`. Task: new (T5).
  - G4 A killed run leaves its candidate checkout in the temp folder. Verdict: confirmed (residue only; later runs exit 0). Evidence: blocks C, E and G kill runs; E block of run-probes-3.out lists two leftover checkouts (lines 28-29); an earlier find count of 3 was not re-run; "E2 next publish exit=0"; "G2 next daily exit=0". Temp folder at `src/export.rs:832-837`; no sweep of old folders. Task: new (T4).
  - G5 SIGTERM during `git merge-file` is not seen. Verdict: refuted (round 1 reading was wrong). Evidence: `src/export.rs:426` calls `command(c, Duration::from_secs(120))`, the polled helper at `src/export.rs:129-211`, not a direct git call. Probe `bash probes/g5-sigterm.sh`: "G5 merge-file reached: yes", "G5 SIGTERM exit=1 elapsed_s=0.025", "G5 merge-file process gone", stderr "Publication failed: Could not compare the public edit of skills/test.md: Publication cancelled". Task: none.
- Tests: `src/export.rs` unit tests (35 passed; `cargo test --locked --lib`, `cargo-test-2.log`). `tests/rust_export.rs`: 16 passed, 1 failed in the copy (`committed_inventory_passes_the_publication_scanner` needs `public/files`, which the copy leaves out).

### Export push

- Where: `src/export.rs:994`, `src/export.rs:212-227` (`git()`)
- States: ready to push, pushed, rejected
- Transitions:
  - ready to push -> pushed: remote accepts `HEAD:refs/heads/main`; state saved next. Enforced at `src/export.rs:994`, `src/export.rs:996-1004`.
  - ready to push -> rejected: git exits non-zero; error returned; state not saved. Enforced at `src/export.rs:212-227`, `src/export.rs:994`.
  - rejected -> ready to push: next run generates the message again. Enforced at `src/export.rs:897-970` (no stored message).
- Gaps:
  - G1 The rejection reason is lost. `git()` drops git's stderr and returns "Git operation failed: push". Verdict: confirmed. Evidence: `bash probes/push-reject.sh` (ran to its DONE line): "PR1 rejected push exit=1 calls=1 state=8203608 stderr=Publication failed: Git operation failed: push" (state equal to "PR0 baseline exit=0 calls=1 state=8203608"). Task: new (T2).
  - G2 Each rejected push discards the generated message, so the next run pays for generation again. Verdict: confirmed. Evidence: "PR2 next run exit=0 calls=2" (one more call than PR1). Task: new (T3).
- Tests: none. A grep of `tests/rust_export.rs` and `tests/rust_daily.rs` for "push" finds no test of a rejected push. The Python copy has one (`tests/test_public_export.py:255`), not the Rust path.

### Cycle lock wait

- Where: `src/export.rs:791-800`, `src/export.rs:52-79`
- States: waiting, held, cancelled
- Transitions:
  - export lock held -> waiting: `cycle_lock` is set in the configuration. Enforced at `src/export.rs:792`.
  - waiting -> held: lock taken within 300 s; polled every 50 ms. Enforced at `src/export.rs:62-79`.
  - waiting -> cancelled: cancellation flag set. Enforced at `src/export.rs:62-79`.
- Gaps: None found. The wait has a time limit and checks cancellation.
- Tests: `src/export.rs:1611` (`shared_lock_waits_for_release_and_times_out_when_held`), `src/export.rs:1630` (`shared_lock_wait_checks_cancellation`), `src/export.rs:1702` (`publication_continues_after_shared_cycle_lock_is_released`). All in the 35 lib tests that passed.

### Candidate checks and scan

- Where: `src/export.rs:627-632` (`candidate_check`, `rust_checks`), `src/export.rs:676-696` (`record`, `secret_scan`), `src/export.rs:856-896`
- States: pending, scan passed, tests passed, stage failed
- Transitions:
  - pending -> scan passed: gitleaks over the candidate; a missing or wrong binary stops publication. Enforced at `src/export.rs:696`, `src/export.rs:856-862`.
  - scan passed -> tests passed: Python candidate tests (`src/export.rs:863-893`), then Rust checks when `Cargo.toml` exists (`src/export.rs:894-896`).
  - any -> stage failed: log written, then stop before generation and push. Enforced at `src/export.rs:676`, `src/export.rs:897`, `src/export.rs:994`.
- Gaps: None found. Each failed stage stops before generation and push.
- Tests: `src/export.rs:1224` (`a_gitleaksignore_in_the_candidate_stops_publication`), `:1238` (`secret_scan_refuses_another_version_a_missing_binary_or_config`), `:1290` (`real_gitleaks_stops_a_planted_key_before_push`), `:1513` (`every_failed_rust_stage_blocks_generation_and_push`), `:1533` (`candidate_checks_never_inherit_the_live_opt_in`). All in the 35 lib tests that passed.

### Cancellation flag

- Where: `src/cancellation.rs:8-22`, `src/main.rs:50`; polls at `src/export.rs:129-211` (10 ms), `src/export.rs:62-79` (50 ms), `src/message.rs:912-923` and `src/message.rs:947-1004` (5 ms)
- States: not requested, requested
- Transitions:
  - not requested -> requested: SIGINT or SIGTERM. Enforced at `src/cancellation.rs:8-22`, installed at `src/main.rs:50`.
  - requested -> stopped: next poll returns an error and the child group is killed. Enforced at `src/export.rs:129-211`, `src/message.rs:912-923`, `src/message.rs:1001`.
- Gaps: None found. A second signal does not force an exit (`src/cancellation.rs:8-22`); every wait polls the flag, so this is not a gap. SIGTERM stopped `git merge-file` in 0.025 s (Export run G5).
- Tests: `tests/rust_daily.rs:184` (`termination_cancels_a_running_git_process`), passed in `cargo test --locked --test rust_daily` (9 passed). `src/export.rs:1630` (`shared_lock_wait_checks_cancellation`).

### Message child run

- Where: `src/message.rs:502-541` (`base_command`, `command`), `src/message.rs:612` (`parse_stream`), `src/message.rs:912-923` (`check`), `src/message.rs:947-1004` (`run`)
- States: spawned, running, finished, timed out, cancelled
- Transitions:
  - spawned -> running: isolated CLI call; environment cleared; `ANTHROPIC_API_KEY` set or removed. Enforced at `src/message.rs:502-541`, `src/message.rs:510`, `src/message.rs:513`.
  - running -> finished: output read and parsed. Enforced at `src/message.rs:947-1004`, `src/message.rs:612`.
  - running -> timed out or cancelled: checked at `src/message.rs:912-923`; the process group is killed on every exit at `src/message.rs:1001`.
- Gaps: None found.
- Tests: `tests/rust_message.rs:342` (`timeout_kills_the_cli`), `:260` (`stream_tolerates_trailing_events_and_requires_init`), `:277` (`error_results_fail`), `:299` (`malformed_or_schema_violating_output_fails`), `:332` (`oversized_output_fails`). `tests/rust_message.rs` has 21 passing tests in `cargo-test-2.log`.

### Daily deadline run (corrected)

- Where: `src/daily.rs:36-108`; `scripts/public_export_job.py:19-46` (not on the CLI path; see G4)
- States: not due, running, deferred (lock busy), success, failure, killed (no end write)
- Transitions:
  - not due -> running: `job.lock` taken; start status written with success null. Enforced at `src/daily.rs:55`, `src/daily.rs:63-64`.
  - unreadable state -> stop before the start status. Enforced at `src/daily.rs:58`.
  - running -> deferred: export lock busy; reason `publication_lock_held`; finished_at set; success null; exit 0. Enforced at `src/daily.rs:73-78`.
  - running -> failure: other error; success false; finished_at set. Enforced at `src/daily.rs:83-85`.
  - running -> success: success true with result; state file written. Enforced at `src/daily.rs:90-95`.
  - running -> killed: no end write; status stays success null. No code path writes it.
  - overlap: a second job is refused by `job.lock`. Enforced at `src/daily.rs:55`.
- Gaps:
  - G1 A corrupt daily state fails before the start status is written. The status keeps its old value, and the message is generic. Verdict: confirmed (still holds; round 1 probe B1 rerun). Evidence: `bash probes/run-probes.sh`, block B: "B1 exit=1 status_unchanged=yes calls=0"; stderr "Publication failed: invalid JSON configuration or local state." (`src/main.rs:66-67`). Task: new (T6, shared with Configuration load G2).
  - G2 SIGKILL during the run leaves `daily-status.json` with success null and no finished_at. The next run clears it. Verdict: confirmed (round 1 P-6 rerun). Evidence: block G: "G status after SIGKILL: {... \"success\":null}" with no finished_at; "G2 next daily exit=0 ... \"success\":true". Task: new (T9).
  - G3 An overlapping run while `job.lock` is held. Verdict: by design. Evidence: `tests/rust_daily.rs:92` (`overlapping_job_never_calls_publication`); `cargo test --locked --test rust_daily overlapping_job_never_calls_publication` exit 0, "1 passed; 8 filtered out". Task: none; dotfiles-358 holds the live check.
  - G4 Two writers of the daily status: `src/daily.rs` and `scripts/public_export_job.py`. Verdict: refuted for the CLI path. Evidence: `scripts/public_export_job.py:45-46` passes `daily` to `rust_cli`. Probe: the job script with a fake Rust binary printed "fake rust got: daily daily --config ..." and wrote no status file (state folder lists only candidate logs and export.lock). The LaunchAgent runs the Rust binary (plist read). The Python `run()` is dead on the CLI path but still tested: `uv run --no-project python -m unittest tests/test_public_export_job.py` gives "Ran 3 tests", "OK". Task: none for the two-writer gap; the dead copy is T8. dotfiles-527 reads the one live file.
  - G5 The deferred path writes success null with finished_at set. Verdict: by design. Evidence: test `tests/rust_daily.rs:108` (`export_lock_defers_real_publication_without_completing_deadline`), cargo exit 0, "1 passed". Probe D5 in `bash probes/lock-probes.sh`: "D5 daily exit=0 calls=0 status={... \"success\":null,\"outcome\":\"deferred\",\"reason\":\"publication_lock_held\",\"finished_at\":...}". A killed run (G2) has no finished_at, so the two states differ. Task: dotfiles-357 and dotfiles-358 hold the operational side.
- Tests: `tests/rust_daily.rs` (9 passed: deadline, unchanged skip, failed retry, corrupt state, overlap, export-lock deferral at 108, lock I/O at 141, CLI at 164, termination at 184). `tests/test_public_export_job.py` (3 passed, Python copy).

### State files and locks (corrected)

- Where: `src/export.rs:52-88` (`acquire`, `lock_file`, `save`), `src/export.rs:514`, `src/export.rs:518`, `src/daily.rs:55`
- States: lock free, lock held, trusted state absent, trusted state present, public main absent, public main present
- Transitions:
  - lock free -> held: flock taken; nonblocking for the job and export locks. Enforced at `src/export.rs:52-62`.
  - held -> free: lock dropped, or process death (the kernel releases the flock).
  - public main present, trusted state absent, content differs -> refused. Enforced at `src/export.rs:514`.
  - trusted state present, public main absent -> refused. Enforced at `src/export.rs:518`.
  - state write: temp file, then atomic rename. Enforced at `src/export.rs:81-88`.
- Gaps:
  - G1 Losing the trusted state refuses publication. The message names no recovery step, and the state file stays absent. Verdict: confirmed (still holds; round 1 run D1 repeated). Evidence: `bash probes/trusted-state.sh` (ran to its DONE line), "trust t1 exit=1 calls=0 state=no stderr=Publication failed: Existing public repository requires trusted state". Task: new (T7).
  - G2 Losing the public main ref refuses publication with "Public main disappeared". Verdict: confirmed (still holds; round 1 run D2 repeated). Evidence: same script, "main m1 exit=1 calls=0 state=yes stderr=Publication failed: Public main disappeared" (`src/export.rs:518`). Task: new (T7).
  - G3 No test pins either refusal message. Verdict: confirmed. Evidence: `grep -rn "trusted state\|disappeared" tests | wc -l` prints 0 (in the copy). Task: new (T7).
  - G4 A killed run releases its flock, so the next run is not blocked. Verdict: refuted. Evidence: `bash probes/lock-probes.sh` (ran to its DONE line): "S4 holder killed, wait rc=137", "flock acquired after holder death", "S4 probe rc=0", "S4 daily exit=0 status={... \"success\":true". Task: none.
- Tests: `tests/rust_daily.rs:108` and `:141` (lock tests). No test for the G1 and G2 refusal messages (G3).

### Message generation and fallback (corrected)

- Where: `src/message.rs` (`generate_message` 246-324, `api_auth` 370-400, `read_fallback` 414-433, `retry_at` 443-469, `record_fallback` 474-500, `validate` 749-821), `src/export.rs:1009-1033`
- States: API key tried, login used, valid fallback record present, fallback record absent, fallback record write failed
- Transitions:
  - API key call fails with billing or authentication -> fallback recorded, then login used. Enforced at `src/message.rs:301-313`, `src/message.rs:474-500`.
  - fallback record present for the same key, before its retry time -> login used with no API call. Enforced at `src/message.rs:370-397`.
  - retry time reached, or key file changed -> API tried again. Enforced at `src/message.rs:370-397`, `src/message.rs:443-469`.
  - API success -> record removed when it belongs to this key or there is none. Enforced at `src/message.rs:289-298`.
  - record write fails -> warning only; login used; no record kept. Enforced at `src/message.rs:310-312`.
  - generated text validated. Enforced at `src/message.rs:320`, then `src/export.rs:957` and `src/export.rs:1013-1017`.
- Gaps:
  - G1 The message side accepts subjects that the export side rejects (see Export run G1). Verdict: confirmed. Evidence: block A of `probes/run-probes.sh`: "A2 exit=1 calls=1" (105 bytes); "A4 exit=0" (100 bytes). Correction to round 1: `src/message.rs:722` counts characters, while `src/message.rs:804-805` counts bytes. Task: new (T1).
  - G2 Two writers of the fallback record can lose each other's update. Verdict: refuted for a torn or unreadable record; the lost update is unverified. Evidence: scratch race test (`probes/race/race.out`): "RACE writes=2000 write_errors=0 final_readable=true final_reason_ok=true" (`cargo test --locked --lib scratch_race` ("1 passed")). The test checks readability only, not lost updates. The read and write have no lock (`src/message.rs:478`, `src/message.rs:474-500`); the write is an atomic rename. A lost update changes the `since` and `retry_at` carry-over; dotfiles-344 holds it.
  - G3 A failed fallback record write only logs a warning, so every later run tries the API again. Verdict: confirmed. Evidence: `bash probes/fallback-write.sh` (ran to its DONE line). Read-only folder: "ro p1 exit=0 api=1 login=1 warnings=1 fallback_file=no", "ro p2 exit=0 api=2 login=2 warnings=1", "ro p3 exit=0 api=3 login=3 warnings=1". Writable control: "rw p2 exit=0 api=1 login=2 warnings=0 fallback_file=yes", "rw p3 exit=0 api=1 login=3". Stderr: "could not record the Claude API fallback: Permission denied (os error 13)". Cost of each extra API request not measured. Task: new (T10).
- Tests: `tests/rust_message.rs:520` (`api_key_bills_the_key_and_success_clears_the_fallback`), `:541` (`billing_falls_back_to_the_login_and_sticks_until_the_key_changes`), `:594` (`an_expired_or_foreign_record_retries_the_api`), `:617` (`authentication_falls_back_but_other_api_errors_do_not`), `:650` (`api_success_keeps_another_key_files_record`), `:670` (`billing_errors_are_classified`), `:720` (`an_exposed_key_file_is_refused_before_the_cli_runs`), `:741` (`key_configuration_is_validated`). No test pins a failed record write (G3).

### Configuration load (unchanged; not copied)

- Still holds. G2 (config or state parse error names no file) is confirmed again by block B of `probes/run-probes.sh` (T6). G1 (`gitleaks_path` bare name) is by design: `src/config.rs:177` (`gitleaks_path_is_absolute_or_a_program_name`) passed in the lib run.
