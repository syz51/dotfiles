Probes for Round 2 of dotfiles-546 (agent-skills Rust exporter)

Scope: the scratch copy only. Set S to the scratch folder (it ends in r7a-skills-rust).
The probe scripts hardcode S. Each script clears its own folder first.
Setup: macOS, /usr/bin/git, uv. The copy is commit 73ce55a with message.rs reverted, built at $S/target/debug/agent-skills.
No live model, no paid API, no real remote. Claude and gitleaks are stubs. The target is a local bare repo.
Run one block at a time. Expected output is from the saved .out files; hashes change on each run, the pattern does not.

## P-A Export subject bound (T1)
Run: bash "$S/probes/run-probes.sh"   (block A; the script also runs C, E, B and G)
Expect in run-probes-3.out:
- A1 exit=0 calls=1 (67-byte subject)
- A2 exit=1 calls=1, then "Publication failed: Uninformative or invalid commit message" (105 bytes)
- A3 exit=1 calls_total=2 (same input again)
- A4 exit=0 calls_total=3 (100-byte control)
Count rules: message.rs:722 counts chars; message.rs:804-805 counts bytes (12-120); export.rs:1016-1017 counts bytes (12-100).
Proposal T1: Align the subject length rule.
- Problem: a 101-120 byte subject passes generation, then fails export after one generation call.
- Change: one rule at the boundary, with a test that a 101-120 byte subject fails before generation.
- Size: S.

## P-B Export push rejection (T2, T3)
Run: bash "$S/probes/push-reject.sh"   (an update hook rejects the push)
Expect in push-reject.out:
- PR0 baseline exit=0 calls=1 state=<hash>
- PR1 rejected push exit=1 calls=1 state=<same hash as PR0> stderr=Publication failed: Git operation failed: push
- PR2 next run exit=0 calls=2 state=<new hash>
Proposal T2: Keep git's stderr in push failures.
- Problem: git() (export.rs:212-227) drops stderr. The user sees only "Git operation failed: push".
- Change: return the last lines of git's stderr in the error.
- Size: S.
Proposal T3: Keep the generated message across a rejected push.
- Problem: each rejected push discards the message, so the next run calls the generator again (PR2 calls=2).
- Change: store the message for the candidate commit, or document the cost. The choice is yours; the cost is one generation call per retry.
- Size: M.

## P-C Export crash windows (T4)
Run: the C and E blocks of bash "$S/probes/run-probes.sh".
Expect in run-probes-3.out:
- C1 exit=137 calls=1 main=5dc0cf2 state_before=a647a35 state_after=a647a35 (crash after push, before state save)
- C2 next publish exit=0 calls_total=1 main=5dc0cf2 state=5dc0cf2 (no new call; state now equals main)
- E: "E killed; fetch_pid_seen=yes", then two lines ending in checkout/.git (SIGKILL during candidate fetch)
- E2 next publish exit=0 main=<hash> state=<same hash>
Residue count: run this right after run-probes.sh, before run-insteadof.sh (that script clears the same folder).
  find "$S/probes/run/tmp" -name .git -maxdepth 4 | wc -l
Expect at least 2 (E). The earlier run that also ran block G counted 3.
Proposal T4: Remove stale candidate checkouts.
- Problem: a killed run leaves its checkout in the temp folder (export.rs:832-837). Nothing removes old folders.
- Change: sweep stale checkouts at start, or create one folder per run and sweep by age.
- Size: S.

## P-D Export origin check under insteadOf (T5)
Run: bash "$S/probes/run-insteadof.sh"   (a global insteadOf rule rewrites the origin URL)
Expect in run-insteadof-3.out:
- I1 exit=1 calls=1 main= state=
- Publication failed: Public candidate changed during message generation
Proposal T5: Compare the origin URL after insteadOf rewriting, or use the configured target for the check.
- Problem: the check at export.rs:953-955 fails when a global rule rewrites the URL. This Mac has no such rule, so the failure is latent.
- Change: resolve the URL once, or compare against the configured target.
- Size: S.

## P-E Daily corrupt state and SIGKILL (T6, T9)
Run: the B and G blocks of bash "$S/probes/run-probes.sh".
Expect in run-probes-3.out:
- B1 exit=1 status_unchanged=yes calls=0, with stderr "Publication failed: invalid JSON configuration or local state." (main.rs:66-67)
- G status after SIGKILL: "success":null, with no finished_at
- G2 next daily exit=0 status "success":true
Proposal T6: Name the failing file in configuration and state parse errors.
- Problem: main.rs:66-67 prints one generic message for every serde_json error. Shared with the configuration gap (see machines-2.md, Configuration load G2).
- Change: include the file path and the field name in the message.
- Size: S.
Proposal T9: Mark an interrupted daily run.
- Problem: a SIGKILL leaves success null and no finished_at. Nothing shows that the run stopped.
- Change: write a finished_at or an "interrupted" outcome before the work, or flag a null success with no finished_at as stale.
- Size: S.

## P-F Daily overlap and deferral, and the second writer (by design; T8)
Run in $S/repo:
- cargo test --locked --test rust_daily overlapping_job_never_calls_publication
  Expect "1 passed; 0 failed; ... 8 filtered out" (daily-overlap.out). By design (rust_daily.rs:92).
- cargo test --locked --test rust_daily export_lock_defers_real_publication_without_completing_deadline
  Expect "1 passed; 0 failed; ... 8 filtered out" (daily-d5-cargo.out). By design (rust_daily.rs:108).
Run: bash "$S/probes/lock-probes.sh"
Expect in lock-probes.out:
- D5 daily exit=0 calls=0 status={... "success":null,"outcome":"deferred","reason":"publication_lock_held","finished_at":...}
- S4 holder killed, wait rc=137, then "flock acquired after holder death" and "S4 daily exit=0 ... "success":true" (refuted: the kernel releases the flock)
Second writer (refuted for the CLI path):
- Run: cd "$S/repo" && uv run --no-project python -m unittest tests/test_public_export_job.py
  Expect "Ran 3 tests" and "OK" (py-job-unittest.out).
- The entry probe ran the Python job script with a fake binary at probes/entry/agent-skills. Expect "fake rust got: daily daily --config <path>" (entry-daily.out) and no daily-status.json in the state folder.
- Open question: the exact command for the entry probe was not kept. Rebuild it from scripts/public_export_job.py main() (lines 45-46) and the fake binary.
Proposal T8: Remove or redirect the dead Python job path.
- Problem: scripts/public_export_job.py run() (19-42) still writes status, but main() passes daily to the Rust CLI (45-46). scripts/public_export.py execute() (248-306) is a second implementation, with a fixed commit message (302) and a git() that drops stderr (24-30). Its 25 tests cover only the Python copy, not the Rust path.
- Change: delete the Python copy, or make its tests call the Rust binary.
- Size: M.

## P-G Message fallback write failure (T10)
Run: bash "$S/probes/fallback-write.sh"
Expect in fallback-write.out:
- ro p1 exit=0 api=1 login=1 warnings=1 fallback_file=no
- ro p2 exit=0 api=2 login=2 warnings=1 fallback_file=no
- ro p3 exit=0 api=3 login=3 warnings=1 fallback_file=no
- writable control: rw p2 exit=0 api=1 login=2 warnings=0 fallback_file=yes
- stderr contains "could not record the Claude API fallback: Permission denied (os error 13)"
Proposal T10: Decide what a failed fallback write does.
- Problem: message.rs:310-312 logs a warning only. The API is called again on every run, so billing keeps failing and each run pays for a call.
- Change: stop, or skip the API for the run, or keep the record in memory for the run. This choice is a design decision for the owner.
- Size: M. Cost of each extra API request was not measured.

## P-H Message fallback record race (G2; dotfiles-344)
Scratch test: $S/probes/race/scratch_race.rs.txt, compiled in the copy as message::scratch_race.
Run: cargo test --locked --lib scratch_race (in $S/repo, with the scratch module in place)
Expect in race.out: "RACE writes=2000 write_errors=0 final_readable=true final_reason_ok=true"
Limit: the test checks that the file stays readable. It does not check for lost updates, so the lost-update gap stays unverified.

## P-I Suite and by-design checks
- cargo test --locked --no-fail-fast (in $S/repo). Log: cargo-test-2.log.
  Expect lib 35 passed; rust_daily 9 passed; rust_message 21 passed; rust_export 16 passed, 1 failed.
  The failure is committed_inventory_passes_the_publication_scanner (tests/rust_export.rs:320): "Source not a committed regular file: public/files/.github/workflows/ci.yml". Cause: the copy leaves out public/files. It must run in the live checkout, not run here.
- Configuration G1 (by design): cargo test --locked --lib gitleaks_path_is_absolute_or_a_program_name
  Expect "1 passed" (config.rs:177).
- State G3 (no test pins the refusal messages): grep -rn "trusted state\|disappeared" "$S/repo/tests" | wc -l
  Expect 0.
