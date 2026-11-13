# config-sync working notes (repo paths: config-sync/config_sync.py, config-sync/tests/test_config_sync.py)
Read in full: config_sync.py (411 lines), tests (578 lines). Suite: 42 tests OK (uv run --no-project --python 3.11 python -B -m unittest discover -s config-sync/tests, HOME=fake).
Probes: probe_config_sync.py (p1..p9), probe_p7b.py. Outputs: out-p1-p3.txt, out-p2-p3.txt, out-p4-p9.txt, out-p7.txt.

Machines:
M1 live-suite lock (locks/*.lock): absent, held (pid alive, age < 3h), stale (unreadable, not PID, 0/negative/huge PID, dead, age >= MAX_HOLD) -> removed. holds() 135-153; check skip 287-297; late check 211.
M2 checkout sync: states fetch-failed, off-main, dirty, diverged, pull-failed, restored, pulled, current; links checked after pull (252-258).
M3 report delivery: reported signature (state.reported) -> feedback | feedback-plain | notification. report() 270-281; check 311-319.
M4 fetch-failure timer: fetch_failing_since; 24h grace (FETCH_GRACE) line 55, 299-305.
M5 settings.json restore: restore_reformat 183-201; restore branch 223-233.
M6 state.json / events.jsonl persistence: load_state 104-109, save_state 112-116, append_event 119-122.

Verdicts (probes):
G1 (M6) corrupt state.json -> every check raises JSONDecodeError, no pull, no board call, file unchanged. CONFIRMED P1 (exit: raise; 2 attempts). No test (grep: no invalid-JSON test). by design? no doc. New.
G2 (M2) git status failing (rc 128, empty stdout) -> changed=[] -> dirty guard skipped -> pull over unreported dirty tree (untouched file). CONFIRMED P2 (dirty-untouched status_rc=128: HEAD_moved=True, board_calls=0, reported=[]). Touched file still refused by git merge (pull-failed reported). Line 217, 223, 237. New.
G3 (M1) lock appearing after late check (211) and before merge (243) does not stop the pull. CONFIRMED P3 (control skip; lock during merge: HEAD moved). Narrow window (ms). New; maybe needs suite-side protocol note.
G4 (M4) lock taken during a failed fetch: skipped path (289-297) drops outcome.fetch_failed; fetch_failing_since stays None; grace restarts. CONFIRMED P4 (run1 since=None; run2 since=+1h; report at +25h not +24h). New. Test line 449-464 pins head only.
G5 (M3) board and osascript fail: notification recorded as delivered (line 280 rc unchecked; 281 returns "notification"); state.reported set; no further report. CONFIRMED P5 (run2 calls=0). Test 382-387 uses a fake osascript rc 0. New.
G6 (M2/M3) non-git repo reported as "off-main: detached HEAD" (line 214 symbolic-ref fails -> ""; 236). CONFIRMED P6 (signature shows detached HEAD). fetch failure hidden until 24h. New.
G7 (M5) session write between the second read (196) and replace (198) is overwritten by the committed text. CONFIRMED P8 (session write kept: False). Test 287-303 covers only a write before the second read. New.
G8 (M6 / M3) two check processes share state.tmp (path.with_suffix(".tmp"), line 114). CONFIRMED mechanism P7b (one save_state raises FileNotFoundError; state.json keeps B). Real processes: P7 3 trials, no crash (not reproduced). Consequence: report filed at 314 before save at 319 -> next run re-files. New. Verdict: confirmed mechanism, narrow in practice.
G9 (M6) events.jsonl and launchd.log: no rotation; 124 bytes per skipped check (P9: 200 skips -> 24800 bytes). Low. New.
G10 (M1) holds() unlink (150) of a lock rewritten between read (141) and unlink: lock filename carries PID (SETUP.md:58), so practically impossible. UNVERIFIED (reading only).
G11 (M5) restore uses text=True git show: CRLF/encoding normalisation. UNVERIFIED, file is LF in repo (not probed).
G12 (M1) MAX_HOLD 3h: a live suite older than 3h without lock rewrite is treated stale and its lock removed (designed: line 64-65). By design, depends on suite rewriting lock per session (outside area, not read).
Side: tracked __pycache__ .pyc files: config-sync/__pycache__/config_sync.cpython-313.pyc and config-sync/tests/__pycache__/test_config_sync.cpython-313.pyc are in git ls-files (hygiene, not state machine).
Setup friction: board show does not accept --board (cost 1 step). Hook guard-runtimes blocked bare python3 (my error, used uv run after). macOS sed -i needs ''. `timeout` not on macOS.
Not yet: LaunchAgent plist reads; by-design tests run (test_failing_fetch_reports_only_after_a_day, same_problems_reported_once, stale 'old' lock).

LaunchAgent facts (read-only, paths masked):
- com.syz51.config-sync: StartInterval 1800, RunAtLoad true, ProgramArguments: uv run --no-project --python 3.11 python -B config_sync.py check. No launchd lock; the check has its own live-suite lock check only. Loaded; last exit 0 (launchctl print).
- com.syz51.dotfiles.pull: StartInterval 3600, RunAtLoad true, /usr/bin/git -C ~/.config pull --ff-only --quiet, GIT_TERMINAL_PROMPT=0. No lock check. Loaded (launchctl list). Still holds prior gap (dotfiles-438). No repo file names it (git grep -F 'syz51.dotfiles.pull' = 0).
- com.syz51.disk-space-alert: StartInterval 600, RunAtLoad true, check --low-gb 30 --critical-gb 20 --sweep-minutes 5. Env PATH only /usr/bin:/bin:/usr/sbin:/sbin.
- com.syz51.t3code.desktop: open -g -a T3 Code (Nightly); RunAtLoad true; no interval.
- Overlap: config-sync and dotfiles.pull both fast-forward ~/.config hourly or 30 min; both use git's index lock only.
