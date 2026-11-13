# Notes after reading jobs.py (all) and sync.py (all); HEAD 7e772d6
jobs.py candidates:
- J1 weekly retry: weekly_due stays true until completed_due moves; failed weekly (review/prompt_review error) re-runs every hour all week (launchd StartInterval 3600 on weekly plist). Check via harness execute(args, now).
- J2 update_checkout: rev-parse/rev-list failures inside try at 106-121 mapped to merge_failed (CalledProcessError branch line 115). Mislabel, CHECKOUT_BLOCKED alert.
- J3 status phase 'running' persists after kill (line 197, 619); skip_sync skips running (175). Monitor must handle.
- J4 save_status / skip_sync take blocking flock on sync-status.lock (146-147, 171) no timeout (short holders).
- J5 weekly lock busy returns 0 silently (593-594), no status.
- J6 stage(defer=True) backlog counts as errors -> success False (line 648), skip collect/review.
- J7 sync non-deferred upload failure (incl. push deferred / fetch unavailable) raises, skipping deploy (line 679, 707).
- J8 review_learning_cycle: crash between ff-merge (467) and save validated (478) leaves attempt 'running' though main has candidate -> next run marks superseded (line 379). Verify.
- J9 review(): env.pop('CLAUDE_CODE_PROMPT_CACHE_TTL') no default (286) KeyError if child_env did not set it - check claude_cli.child_env.
- J10 main() catches OSError/ValueError/KeyError only (779); RuntimeError from outside stage would traceback.
- J11 retire_attempts git worktree prune only in weekly path.
sync.py candidates:
- S1 collect/clean: leftover untracked/staged files from failed collect (lines 285-304) make clean() (48) refuse forever -> no exit. Probe.
- S2 git() helper no timeout (38); fetch/push unbounded except outer step timeout.
- S3 main lock flock blocking LOCK_EX (848) no timeout.
- S4 note_records parsed repeatedly: collect 268, 272 per host, verification_records 241 full parse per host (293). cat-file spawn per blob (218, 232, 252, 525, 739).
- S5 validate spawns uv run per skill (348); skills_hash reads all files; validate called in publish (472), deploy child verify (708), review_learning_cycle (462).
- S6 publication_scope: git ls-tree spawn per changed skill file (411), sources.json show (421-422).
- S7 deploy: journal retained for after-None reviews forever (812-816, 755-765) by design per comments.
- S8 worktree() crash leaves registration + skill-sync tmp; no prune outside weekly path.
- S9 publish: commit then push failure leaves local ahead commit; self-heals on retry (by design?).
- S10 open_files lsof full scan (582) timeout 120.
- S11 upload: remote_ref fallback to origin/main (77) if inbox branch missing.
# capture.py (read fully; Read tool line numbers can be off by one vs grep -n; verify citations with grep)
- C1 capture-state.json corrupt -> json.loads (capture.py ~1724) ValueError -> main() catch (~1897) -> failure_reason -> 'invalid model JSON' label (misleading); every run fails. Probe.
- C2 deferred entry for vanished transcript: 'unavailable' (~1768) counted in errors (~1773) and pending forever; no expiry. Probe.
- C3 failure backoff: retry_at = clock + min(24, 2^(attempts-1)) hours (~1819), no max attempts; retries daily forever (by design? check README).
- C4 rate limit record per backend (rate-limit.json / rate-limit-api.json); cleared only on success (~1616); wait check (~1583); RateLimited turns no backoff (~1803-1813).
- C5 API fallback record api-fallback.json: since carried over from previous record even if key differs (197-200); clear on success (1574); active_api_fallback checks key + retry (167-174).
- C6 capture.lock LOCK_NB busy -> return 75 with no status write (~1910). Status phase 'running' written under lock (1884); not updated on crash.
- C7 atomic() no directory fsync (1408-1426); jobs.save() no fsync at all (jobs.py 138-141). Unverified (power loss).
- C8 ScanCache: identity includes SOURCE_SHA256 + module bytes (1004-1009); per-file entries json.dumps; turns deep-copied per file json.loads(json.dumps(found)) (1055) -> hot path O(files x turns).
- C9 notes re-read and regex-redacted every run (1735-1738), all notes in memory; hot path.
- C10 crash between note write (1836) and processed save (1843): recovered by content hash dedupe (1827) -> idempotent (by design, comment 1826).
- C11 model_response/backend_response: 2 attempts, retry only timeout/connection on attempt 1 (1598, 1636); MAX_TURNS 200, CYCLE_TIMEOUT 900, MODEL_TIMEOUT 240 (~41-43).
- C12 main(): __main__ registers faulthandler then raise SystemExit(main()) at line 1920.
