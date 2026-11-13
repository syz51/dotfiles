Repository: agent-skills

Checkout HEAD 7e772d6 (read only). Verdicts come from probes and tests run on a scratch copy. Probe commands are in `probes.md`. Line numbers are from `grep -n`.

### Weekly maintenance job

- Where: `scripts/jobs.py` (`update_checkout` :53, `weekly_due` :132, `save` :139, `save_status` :145, `skip_sync` :160, `review_learning_cycle` :334, `main` :768)
- States: idle, due, running, finished (success true or false), completed, checkout blocked, lock busy
- Transitions:
  - idle -> due: a Monday 09:00 Asia/Tokyo deadline passes after setup. Enforced at `scripts/jobs.py:132-135`.
  - due -> running: status is written with phase running. Enforced at `scripts/jobs.py:198`.
  - running -> checkout blocked: update_checkout returns a blocked state. Enforced at `scripts/jobs.py:109-122`.
  - running -> finished: phase becomes finished; success is no errors. Enforced at `scripts/jobs.py:738-740` and `:762`.
  - finished without errors -> completed: completed_due moves to the due time. Enforced at `scripts/jobs.py:733-736`.
  - finished with errors -> due: completed_due stays, so the next start sees the job due. Enforced at `scripts/jobs.py:133-135`.
- Gaps:
  - G1 A failed `rev-list` in update_checkout is reported as merge_failed. Verdict: confirmed. Evidence: `probes.md` J2; `uv run ... j2_update_checkout.py` exit=0; output `faulty (rev-list fails, no merge attempted) state = merge_failed`. Task: new.
  - G2 A failed weekly run stays due, so every hourly start retries it until the week ends. Verdict: unverified. Evidence: read only at `scripts/jobs.py:133-135` and `:733-736`; no probe built; no weekly retry rule found in README. Task: new.
  - G3 A kill leaves phase running. skip_sync then treats the job as busy. Verdict: unverified. Evidence: read only at `scripts/jobs.py:176` and `:198`; the monitor flags a running status older than 95 minutes at `scripts/monitor.py:142`. Task: new.
  - G4 A crash in review_learning_cycle can leave an attempt running after main already has its candidate. Verdict: unverified. Evidence: read only at `scripts/jobs.py:381` (superseded branch); no probe built. Task: new.
  - G5 save_status and skip_sync wait on blocking flock with no timeout. Verdict: unverified. Evidence: read only at `scripts/jobs.py:148` and `:172`; lock holders are short. Task: new.
- Tests: `tests/test_jobs.py` not read in full (1484 lines). Grep finds `completed_due` references there. Not run.

### Sync job

- Where: `scripts/sync.py` (`git` :38, `clean` :48, `worktree` :63, `collect` :263, `publish` :454, `open_files` :579, `deploy` :688, `main` :827, sync lock :848)
- States: idle, lock held, collected (staged files), clean, published, deploy journal (review-deploy.json)
- Transitions:
  - idle -> lock held: blocking exclusive flock. Enforced at `scripts/sync.py:848`.
  - collected: feedback and verification files are written and staged. Enforced at `scripts/sync.py:285-304`.
  - collected -> refused: clean() refuses any non-empty `git status --porcelain`. Enforced at `scripts/sync.py:48-49`.
  - deploy: journal entries record before and after; an after of None stays. Enforced at `scripts/sync.py:712-765`.
- Gaps:
  - G1 Files left by a failed collect make clean() refuse every later run until someone removes them. Verdict: unverified. Evidence: read only at `scripts/sync.py:48-49` and `:285-304`; no probe built. Task: new.
  - G2 The sync lock is a blocking flock with no timeout. Verdict: unverified. Evidence: read only at `scripts/sync.py:848`. Task: new, with the overall lock-timeout item.
  - G3 git() runs with no timeout, so a hung fetch or push waits until the outer step times out. Verdict: unverified. Evidence: read only at `scripts/sync.py:38-39`. Task: new.
  - G4 Deploy journal keeps after-None entries until a review exists. Verdict: unverified. Evidence: comments and code at `scripts/sync.py:712-765`; no test run. Task: new.
- Tests: `tests/test_sync.py` not read in full (1352 lines). Grep finds `test_deploy_updates_untouched_previous_reviews_and_is_idempotent` at line 979. Not run.

### Capture

- Where: `scripts/capture.py` (`redact` :291, `ScanCache` :993, `atomic` :1408, state load :1724, `failure_reason` :1675-1682, capture lock :1881, `return 75` :1912)
- States: idle, running, pending, deferred, processed, failed, rate limited, API fallback in effect
- Transitions:
  - idle -> running: capture lock taken. Enforced at `scripts/capture.py:1881`.
  - running -> busy exit: lock busy returns 75 with no status write. Enforced at `scripts/capture.py:1912`.
  - pending -> processed: note written, then processed recorded; a crash in between is deduped by content hash. Enforced at `scripts/capture.py:1826-1827`.
  - state load -> failed: a corrupt capture-state.json raises JSONDecodeError at `scripts/capture.py:1724`.
  - deferred -> unavailable: a source with no readable transcript is marked unavailable. Enforced at `scripts/capture.py:1753`.
- Gaps:
  - G1 A corrupt capture-state.json is reported as invalid model JSON. Verdict: confirmed. Evidence: `probes.md` C1; `uv run ... c1_corrupt_capture_state.py` exit=0; output `exception = JSONDecodeError | failure_reason label = invalid model JSON`. Task: new. Persistence across runs comes from reading only.
  - G2 A deferred entry for a vanished transcript stays pending with no expiry. Verdict: unverified. Evidence: read only at `scripts/capture.py:1753` and the deferred branch after it; no probe built. Task: new.
  - G3 A crashed run leaves the status at phase running, and a busy lock writes no status. Verdict: unverified. Evidence: read only at `scripts/capture.py:1881` and `:1912`. Task: new.
  - G4 atomic() does not fsync the directory (`scripts/capture.py:1408`); jobs.save() does not fsync at all (`scripts/jobs.py:139`). Verdict: unverified; power loss not tested. Task: new.
  - G5 The crash between note write and processed record is by design: the dedupe by content hash makes it idempotent. Verdict: by design. Evidence: `tests/test_capture.py:470` `CaptureTests.test_capture_dedupe_and_provenance`; `python -m unittest test_capture.CaptureTests.test_capture_dedupe_and_provenance` exit=0 (scratch copy). Task: none.
- Tests: `tests/test_capture.py` not read in full (1690 lines). `tests/test_claude_capture.py` not read in full (403 lines).

### Capture scan cache

- Where: `scripts/capture.py` `ScanCache` (:993), `capture-scan.json`, `evidence-scan.json`; README.md:47
- States: missing or unreadable progress, matching progress (resume), grown file (resume after last turn), changed or foreign progress (full rescan), unchanged file (no reread)
- Transitions:
  - missing, unreadable or foreign -> full rescan. Enforced by `tests/test_capture_incremental.py:275-287` and README.md:47.
  - grown with a matching prefix -> resume. Enforced by `tests/test_capture_incremental.py:177-200`.
  - unchanged -> no rewrite. Enforced by `tests/test_capture_incremental.py:321-332`.
- Gaps:
  - G1 Hot path: turns are copied per file, and notes are re-read every run. Verdict: unverified until the benchmark. Evidence: read only at `scripts/capture.py:1004-1009`, `:1055`, `:1735-1738`; benchmark: BENCH_PENDING. Task: new.
- Tests: `tests/test_capture_incremental.py` read in full. Run: `python -m unittest test_capture_incremental test_claude_cli` exit=0, 29 tests OK.

### Public export daily job (legacy Python path)

- Where: `scripts/public_export_job.py` (`latest_due` :13, `run` :18-41), `scripts/public_export.py` (`prepare` :170-186, `save` :226-231, `execute` :248, push :303). The live path is `src/daily.rs` and `src/export.rs`, which were not read in full.
- States: not due, started (success null), failed (success false), unchanged or published (success true)
- Transitions:
  - not due -> started: status written with success null. Enforced at `scripts/public_export_job.py:30`.
  - started -> failed: one of five exception types caught. Enforced at `scripts/public_export_job.py:34`.
  - started -> stuck: any other exception escapes with success still null. Enforced by the same branch (no catch-all).
  - pushed -> saved: push, then save; a failed save is recovered on the next run. Enforced at `scripts/public_export.py:176-183`.
- Gaps:
  - G1 An uncaught exception leaves success null and no finished_at. Verdict: confirmed (low; legacy path). Evidence: `probes.md` E2; `uv run ... e2_export_job_status.py` exit=0; output `raised KeyError` and `"success": null`. Task: new.
  - G2 Push then save window. Verdict: by design. Evidence: `tests/test_public_export.py:240-253` `ExportTests.test_recover_successful_push_with_old_or_missing_state`; run exit=0 on the scratch copy. Task: none.
  - G3 save() writes a temporary file, then os.replace, with no fsync (`scripts/public_export.py:226-231`). Verdict: unverified. Task: new, with G4 of the weekly job if filed together.
- Dotfiles-358 holds the 10:17 JST overlap gap. This audit adds no evidence for it; the overlap was not run.
- Tests: `tests/test_public_export_job.py` read in full (46 lines); no test covers an uncaught exception. `tests/test_public_export.py` read only at lines 225-294, not in full (348 lines).

### Exporter activation

- Where: `scripts/exporter_activate.py` (`job_lock` :133, `Agent.load` :175-180, `activate` :190-234, `restore` :211-220)
- States: unlocked, loaded, unloaded, build installed, switched, restored
- Transitions:
  - loaded -> unloaded: agent unloaded. Enforced at `scripts/exporter_activate.py:225`.
  - unloaded -> switched: current link and plist replaced. Enforced at `scripts/exporter_activate.py:227-228`.
  - switched -> loaded: agent loaded, up to 5 attempts. Enforced at `scripts/exporter_activate.py:231` and `:177`.
  - switched -> restored: OSError or a failed load restores the previous build and plist. Enforced at `scripts/exporter_activate.py:229-232`.
- Gaps:
  - G1 A process death between the unload (:225) and the load (:231) leaves the LaunchAgent unloaded. The restore branch does not run. Verdict: confirmed. Evidence: `probes.md` E1; `uv run ... e1_activate_crash_child.py` exit=137; launchctl calls are print and bootout only, with no bootstrap; plist hash 2950c0898850 unchanged. Task: new.
  - G2 The old plist and old link are read before the job lock (`scripts/exporter_activate.py:197` and `:209`, lock at `:222`). Verdict: unverified; no two-writer probe built. Task: new.
- Tests: `tests/test_exporter_activate.py` read in full (247 lines). Run exit=0: `ExporterActivationTests.test_running_export_blocks_activation` (lock blocks activation) and `test_failed_reload_restores_previous_build_and_plist`. No test kills the process.

### Upstream check

- Where: `scripts/upstream.py` (`entries` :50, `local_edits` :122, `check` :141, `refresh` :95, `main` :188)
- States per source: invalid, error, unchanged, changed, removed, baseline-unknown. Mirror: missing, partial, ready.
- Transitions:
  - mirror missing -> partial -> ready: clone into a .partial folder, then os.replace. Enforced at `scripts/upstream.py:103-109`.
  - any git error on HEAD:path -> removed. Enforced at `scripts/upstream.py:146-148`.
  - localEdits -> capped list. Enforced at `scripts/upstream.py:136-138`.
- Gaps:
  - G1 A top-level JSON list in sources.json stops the run with a traceback and no report. Verdict: confirmed. Evidence: `probes.md` U1; `sh u1_upstream_list.sh` exit=1; `AttributeError: 'list' object has no attribute 'get'` at `scripts/upstream.py` line 57. Task: new.
  - G2 Any git failure on HEAD:path is reported as removed. Verdict: confirmed. Evidence: `probes.md` U2; injected `Git command timed out` gives status removed; no injection gives changed. Task: new.
  - G3 localEdits stops at 400 files with no count or flag. Verdict: confirmed. Evidence: `probes.md` U3; 401 local-only files, 400 listed, no count key. Task: new.
  - G4 main() removes the patches folder with no lock; two runs can race. Verdict: unverified; no caller in scripts/ found. Task: new.
- Tests: `tests/test_upstream.py` read in full (292 lines). Missing path gives removed: `UpstreamChecks.test_removed_path_and_repository_root` run exit=0 (by design for a missing path only). No test for G1, G2 or G3.

### Claude call (CLI and API)

- Where: `scripts/claude_cli.py` (`structured_run` :112-154, `failure_class` :197-201), `scripts/claude_api.py` (`call` :116-176, stop reasons :158-160)
- States: startup, inference, completed, failed; failure categories
- Transitions:
  - completed with a dict structured_output -> validated output. Enforced at `scripts/claude_cli.py:147-148`.
  - completed without output -> no error text. Enforced at `scripts/claude_cli.py:141` and no `else` after `:148`.
  - stop reason other than end_turn -> refusal or output limit. Enforced at `scripts/claude_api.py:158-160`.
  - API fallback record kept for another key file. Enforced at `scripts/claude_api.py` fallback code; pinned by test.
- Gaps:
  - G1 A successful run without structured output gives phase completed, no output and an empty error, so the failure is classed as CLI or output. Verdict: confirmed. Evidence: `probes.md` CL1; `cl1_api_categories.py` exit=0; `phase = completed | output = None | error text = ''`. Task: new.
  - G2 pause_turn and stop_sequence are reported as output limit. Verdict: confirmed (low). Evidence: `probes.md` A1; output `'category': 'output limit'`. Task: new.
- Tests: `tests/test_claude_cli.py` read in full (162 lines); no case for G1. `tests/test_claude_api.py` not read in full (558 lines). Grep: `:149-151` pins refusal, max_tokens and invalid output, not pause_turn. Run exit=0: `ApiFallbackTests.test_api_success_keeps_another_key_files_record` (by design for the API fallback record).

### Monitor

- Where: `scripts/monitor.py` (thresholds :19-21, `health` :103, `evaluate` :215, `inspect` :378, `main` :417)
- States: waking (grace), unreachable (outage tracking), problems map, recovered
- Transitions:
  - checked more than 75 minutes ago -> waking with 15 minute grace. Enforced at `scripts/monitor.py:217-218`.
  - unreachable 15 minutes or more -> problem. Enforced at `scripts/monitor.py:248`.
  - running longer than 95 minutes -> problem. Enforced at `scripts/monitor.py:142`.
- Gaps: None found by reading. No probe run.
- Tests: `tests/test_monitor.py` not read in full (555 lines; 42 test definitions by grep). Grep finds grace and outage tests at `tests/test_monitor.py:40-48` and `:267-271`. Not run.

## Not read in full

- `tests/test_jobs.py` (1484), `tests/test_sync.py` (1352), `tests/test_capture.py` (1690), `tests/test_claude_api.py` (558), `tests/test_monitor.py` (555), `tests/test_claude_capture.py` (403), `tests/test_public_export.py` (348; lines 225-294 only). Reason: context budget in this run.
- `scripts/prompt_review.py` (out of area), `src/*.rs` (out of area; grep only), `README.md` (grep sections only), `maintenance-prompt.md`, `public/PLAN.md`, `.github/workflows/secrets.yml` (grep only).

## Baseline

- Offline suite: BASELINE_PENDING
