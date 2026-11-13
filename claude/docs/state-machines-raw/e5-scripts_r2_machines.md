# Round 2 machines: shell, scripts and tool configuration

Checkout HEAD 3525a13, read only. Repository paths are relative to the checkout root.
Evidence paths are relative to the scratch folder `e5-scripts`; `r2/logs` holds round 2 logs.
Probe IDs (P1 to P27) match `probes-2.md`.

Count: 23 entries. Each entry is a machine new in round 2, or a round 1 machine whose verdict or gap changed (whole entry repeated).

Round 1 entries that still hold (checked against today's lines; not repeated):
- config-sync M2 checkout sync: `config-sync/config_sync.py:204-259`. Still holds.
- config-sync M3 report: `config-sync/config_sync.py:262-281`. Still holds.
- config-sync M4 fetch grace: `config-sync/config_sync.py:55`, `:300-305`. Still holds.
- config-sync M6 state files: `config-sync/config_sync.py:104-122`. Still holds.
- disk-alert D1 alert level: `disk-alert/disk_space_alert.py:72`, `:156-181`. Still holds.
- disk-alert D2 state file: `disk-alert/disk_space_alert.py:188`, `:213`. Still holds.

---

### explore socket discovery

- Where: `explore/bin/explore-dispatch` (115-169; 127-132; 147-152); `explore/tests/test_explore.py` (344-346; 403-411)
- States: nvim server listed, socket name read, socket checked, server answering, not found
- Transitions:
  - process snapshot -> socket name: `ps` lists nvim servers; `lsof -a -p PID -U -Fn` gives names. Enforced at `explore/bin/explore-dispatch:127-132`, `:147-150`.
  - socket name -> rejected: name fails the socket test. Enforced at `explore/bin/explore-dispatch:152`.
  - socket name -> answering: RPC to the server pid. Enforced at `explore/bin/explore-dispatch:115-169`.
  - no answering server -> not found: caller falls back. Enforced at `explore/bin/explore-key:51-61`.
- Gaps:
  - G1 `lsof` truncates unix socket names to 103 bytes on this macOS. The short name fails `[[ -S ]]`, so the live server is missed. Verdict: confirmed. Evidence: `r2/logs/explore-tui-diag4-r2.txt`: `DBG candidate=... len=103`; `DBG servers=... found_pid=` (empty); `explore_socket 0 fn_rc=1`. Headless test with the skip guard removed: `r2/logs/explore-headless-noguard-r2.txt` line 11 `AssertionError: b'' != ...`; line 16 `FAILED (failures=1)`. Task: new (M; P9).
- Tests: no truncated-name case in `explore/tests/test_explore.py`. Suite logs `r2/logs/suite-explore.txt`, `suite-explore-rep1.txt`, `suite-explore-rep2.txt`: `Ran 15 tests`, `FAILED (errors=1, skipped=1)` in all three.

### explore key open or new window

- Where: `explore/bin/explore-key` (51-61; open at 57; new window at 61); `explore/bin/explore-dispatch` (197-226, `explore_nvim_open`)
- States: socket found, open accepted, open rejected, new window opened
- Transitions:
  - socket found -> open accepted: `explore_nvim_open` returns 0. Enforced at `explore/bin/explore-key:57`.
  - open rejected (any non-zero rc) -> new window. Enforced at `explore/bin/explore-key:61`.
- Gaps:
  - G1 An open that times out can still apply in the editor. The caller then opens a second window. Verdict: confirmed (round 1 run; not rerun in round 2). Evidence: round 1 `explore-probes/double-open/out-delay.txt`: rc 0; 2.48 s; editor applied 0.39 s after return; one new window. Task: dotfiles-444 item 4 (corrected lines: `explore-key` 57 and 61; not about 55).
- Tests: none found for the double-open case.

### explore JSON read

- Where: `explore/bin/explore-dispatch` (5-7)
- States: running, done, hung
- Transitions:
  - running -> done: `nvim -l` exits. Enforced at `explore/bin/explore-dispatch:5-7`.
  - running -> hung: no time limit applies. Enforced at `explore/bin/explore-dispatch:5-7`.
- Gaps:
  - G1 `nvim -l` has no time limit. A hung process blocks the caller. Verdict: confirmed. Evidence: `r2/logs/vp-explore-r2.txt` line 3: `g hung nvim: rc=None timed_out_after_5s=True`; line 4 control: `rc=0 ... stdout='["ok"]'`. Task: new (S; P7).
- Tests: none for this call in `explore/tests/test_explore.py` (read in full this round).

### explore action scope write

- Where: `explore/bin/explore-action` (24-25; 54-56; 61; 110)
- States: scope absent, scope current, scope empty during write, scope new
- Transitions:
  - scope current -> new: `print -r -- ... > "$session/scope"` truncates, then writes. Enforced at `explore/bin/explore-action:25`, `:61`.
  - result -> file: temp file, then `mv`. Enforced at `explore/bin/explore-action:54-56`.
  - multi-item move -> partial: a failure stops after some items. Enforced at `explore/bin/explore-action:110`.
- Gaps:
  - G1 The scope file is empty between open and write. Verdict: confirmed (narrow). Evidence: `r2/logs/vp-explore-r2.txt` line 5: `f writer: rc=0 size_between_open_and_write=0 final=<scratch>/new`. Task: new (S; P8).
  - G2 A multi-item move can stop after some items. Verdict: unverified. The message at `explore/bin/explore-action:110` says earlier items may have completed. No test found; no run this round.
  - Observed, no verdict: an empty scope makes `explore-src` exit 1 with no output (`r2/logs/vp-explore-r2.txt` line 6).
- Tests: none found for the scope file.

### explore installer for television

- Where: `explore/install-television.sh` (3; 39; 43)
- States: patch step, build step, done
- Transitions:
  - patch fails -> exit before build. Enforced at `explore/install-television.sh:3` (`set -eu`), `:39`.
  - patch done -> build. Enforced at `explore/install-television.sh:43`.
- Gaps:
  - G1 An unreadable patch leaves a partial build. Verdict: refuted. Evidence: `r2/logs/tuios-r2.txt` lines 14-16: `h unreadable patch: rc=1`; `h cargo calls: ['cargo --version']; build (cargo build) ran: False`; `h dest exists: False`.
- Tests: none found for the installer.

### tuios install-fork

- Where: `tuios/install-fork.sh` (42-60); `tuios/tests/test_install_fork.py` (4 tests; grep only this round)
- States: building, staged, installed, backed up, verified
- Transitions:
  - staged -> installed: `mv -f` over the destination. Enforced at `tuios/install-fork.sh:48`.
  - regular file -> backup: `mv "$link" "$link.bak"`. Enforced at `tuios/install-fork.sh:55`.
  - linked -> verified: `"$link" --version | head -n 1`. Enforced at `tuios/install-fork.sh:60`.
- Gaps:
  - G1 Two installs share the staged name `tuios.new`. One fails at the `mv`. Verdict: confirmed. Evidence: `r2/logs/tuios-r2.txt` line 2: `i[dest-present] run A: rc=1 stderr='mv: rename ... tuios.new'`; line 3: run B rc 0. Task: new (M; P11).
  - G2 The pipe to `head` hides the install's exit status. Verdict: confirmed. Evidence: `r2/logs/tuios-r2.txt` line 9: `j install with broken fork: rc=0`; line 10: `j the same binary run directly: rc=1 stderr='fork crashed'`. Task: new (S; P12).
  - G3 An older `.bak` file is overwritten. Verdict: confirmed. Evidence: `r2/logs/tuios-r2.txt` line 13: `k older backup overwritten: True`. Task: new (S; P13).
- Tests: `r2/logs/suite-tuios-install-fork.txt`: `Ran 4 tests`, `OK`. No concurrency, backup or masked-status case found by grep. File not read in full this round.

### ghostty launcher

- Where: `ghostty/tuios-launcher.py` (14; 30; 32; 46; 49-51; 79); `ghostty/test-tuios-launcher.py` (138-198)
- States: waiting for lock, listing sessions, listing clients, attaching, failed, done
- Transitions:
  - waiting -> listing: `flock(LOCK_EX)` with no time limit. Enforced at `ghostty/tuios-launcher.py:30`.
  - listing -> failed: the `ls` read has a 2 s timeout; `TimeoutExpired` ends the run through the handler at `:79` with exit 1. Enforced at `ghostty/tuios-launcher.py:14`, `:32`, `:79`.
  - list-clients errors -> tolerated. Enforced at `ghostty/tuios-launcher.py:49-51`.
- Gaps:
  - G1 A hung first `ls` ends the launcher with exit 1 after 2 s. There is no retry. Verdict: confirmed. Evidence: `r2/logs/launcher-hang-r2.txt` line 1: `first: rc=1 done_at=2.0s ... timed out after 2 seconds`; line 2: second run the same. Task: dotfiles-425. Note: the dotfiles-444 note says this timeout is refuted; this run contradicts it.
  - G2 The lock wait has no time limit. Verdict: by design. Test `ghostty/test-tuios-launcher.py:138-157` pins the wait. Run: `r2/logs/suite-ghostty-tuios-launcher.txt`: `Ran 9 tests`, `OK`.
  - G3 list-clients errors are tolerated. Verdict: by design. Comment at `ghostty/tuios-launcher.py:51`: "The client may still be starting the daemon." Run: same suite, OK.
  - G4 `TimeoutExpired` from the launcher's `ls` may go unhandled. Verdict: refuted. The run shows the exception reaches the handler at `:79` and prints a message, with no traceback (`r2/logs/launcher-hang-r2.txt` line 1).
- Tests: `ghostty/test-tuios-launcher.py` 138-157 (lock wait), 159-173 (attach), 175-187 (bad listing; failed client releases lock), 189-198 (deadline; lock release).

### shell vp launcher

- Where: `shell/bin/vp` (16); `shell/test-vp-launcher.py`
- States: caller vp, project vp, found, not found
- Transitions: `ps` args -> word split -> path match. Enforced at `shell/bin/vp:16`.
- Gaps:
  - G1 A project path with a space splits in the word loop. The wrapper exits 127. Verdict: confirmed. Evidence: `r2/logs/vp-explore-r2.txt` line 1: `e control: rc=0 stdout='CALLER-VP ran: from-wrapper'`; line 2: `e spaced: rc=127 stdout='' stderr='vp: no node_modules/.bin/vp in ...'`. Task: new (S; P6). `shell/bin/vp` changed on 2026-11-12 (commits c6b6e77, 01ada73).
- Tests: `shell/test-vp-launcher.py`: grep for "space" finds nothing. Run: `r2/logs/suite-shell-vp-launcher.txt`: `Ran 4 tests`, `OK`.

### probe-ghostty-metrics restore

- Where: `tuios/bin/probe-ghostty-metrics.py` (89; 93; 95-105; 126); `tuios/tests/test_ghostty_metrics_probe.py` (grep only: 4 matches for restore or tcsetattr)
- States: raw mode, query sent, reply read, restored, reported
- Transitions:
  - query error -> finally restore -> error report. Enforced at `tuios/bin/probe-ghostty-metrics.py:93`, `:95-105`, `:126`.
- Gaps:
  - G1 A failed restore replaces the original error. Verdict: confirmed (low). Evidence: `r2/logs/ghostty-restore-r2.txt` line 1 control: `Timed out waiting for the cell-pixel response (2 seconds).`; line 2: `query-fails-restore-fails ... "injected restore failure"`. Task: new (S; P16).
  - G2 Late or malformed reply bytes stay queued as shell input. Verdict: unverified. Round 1 observation only (probe `probe_metrics_leftover.py`); its output was not found this round.

### config-sync live-suite lock

- Where: `config-sync/config_sync.py` (MAX_HOLD 66; `holds()` 135-153); `config-sync/tests/test_config_sync.py` (436-522)
- States: absent, held (live pid, age under MAX_HOLD), stale, removed
- Transitions:
  - held -> stale: pid dead, unparsable, zero, negative or huge; or age >= MAX_HOLD. Enforced at `config-sync/config_sync.py:135-153`.
  - stale -> removed: unlink. Enforced at `config-sync/config_sync.py:150`.
- Gaps:
  - G10 A lock renewed after `holds()` reads it is still unlinked. Verdict: confirmed (narrow). Evidence: `r2/logs/cs-r2.txt` line 2: `g10 control ... held = ['live-suite-80894-probe.lock (pid 80894)']`; line 3: `renewal landed before unlink: pid alive = True | mtime age s = 0.0`; line 4: `g10 race: held = [] | lock exists = False`. Task: new (S; P17).
  - G12 A live run older than MAX_HOLD loses its lock. Verdict: by design. `config-sync/config_sync.py:66` and the stale-lock test at `config-sync/tests/test_config_sync.py:506-522`. Run: `r2/logs/suite-config-sync.txt`: `Ran 42 tests`, `OK`.
- Tests: `config-sync/tests/test_config_sync.py` 436-522 (held; lock during fetch; released; unreadable entry stale; stale removed).

### config-sync settings restore

- Where: `config-sync/config_sync.py` (`restore_reformat` 183-201; restore branch 223-233; text-mode `git show` at 224); `config-sync/tests/test_config_sync.py` (235-312)
- States: committed, reformatted, restored, kept and reported
- Transitions:
  - reformatted -> restored: same JSON and no write since the read. Enforced at `config-sync/config_sync.py:185-198`.
  - write before the check at 196 -> kept and reported. Enforced at `config-sync/config_sync.py:196-197`.
  - write between the check at 196 and the replace at 198 -> overwritten. Enforced at `config-sync/config_sync.py:196-198`.
  - committed text read in text mode. Enforced at `config-sync/config_sync.py:224`.
- Gaps:
  - G7 A session write between the check at 196 and the replace at 198 is overwritten. Verdict: confirmed (round 1 run; the lines still hold today). Evidence: round 1 `out-p4-p9.txt` lines 17-19 (case P8: settings.json after check; kept: False). The test at `config-sync/tests/test_config_sync.py:287-303` fires its write at the read on line 196 and never reaches this window. Task: new (S; P21).
  - G11 A CRLF committed file is restored as LF. The file then differs from HEAD, and the next pull fails. Verdict: confirmed (latent: the committed file is LF today). Evidence: `r2/logs/cs-r2.txt` line 9: `crlf run 1 ... worktree bytes equal HEAD blob = False | git status = 'M claude/settings.json'`; line 11: `crlf run 2 ... pulled = False problems = ['pull-failed']`. Task: new (S; P18).
  - G13 Non-UTF-8 bytes raise `UnicodeDecodeError` in check and sync. `state.json` is not written. Verdict: confirmed (narrow). Evidence: `r2/logs/cs-r2.txt` lines 13-14. The read at `config-sync/config_sync.py:185` sits outside any try. Task: new (S; P19).
- Tests: `test_config_sync.py` 235-312 pins the restore, the kept write (287) and the failed restore (305). None pins the G7 window, G11 or G13.

### config-sync launch agent install

- Where: `config-sync/config_sync.py` (`run_install` 348-367: plist write 359; bootout 361, rc ignored; bootstrap 362; return 1 at 363-365); `config-sync/tests/test_config_sync.py` (537-558)
- States: plist absent, plist written, unloaded, loaded
- Transitions: plist written -> bootout -> bootstrap. Failed bootstrap -> exit 1. Enforced at `config-sync/config_sync.py:359-365`.
- Gaps:
  - G14 A failed bootstrap leaves the plist and an unloaded agent. Verdict: confirmed. Evidence: `r2/logs/cs-r2.txt` line 1: `launchctl bootstrap failed: Bootstrap failed: 5: Input/output error`; line 15: `g14 install exit = 1 | calls = ['launchctl bootout', 'launchctl bootstrap']`; line 16: `plist written before bootout = True | plist exists after = True`. Task: new (S; P20). Same shape as disk-alert DA-G9.
- Tests: `test_config_sync.py` 537-558 pins the plist fields and dry run only. No failure case.

### disk-alert episode thread

- Where: `disk-alert/disk_space_alert.py` (`notify` 768; `started_thread_id` 798; `deliver` 810: send 822-827, start 832-839; `check` 845: recovery 860-866, thread id and pending 881-883); `disk-alert/tests/test_disk_space_alert.py` (123-215)
- States: no thread, thread, pending retry, reset (fresh state)
- Transitions:
  - thread -> same thread: send returns 0. Enforced at `disk-alert/disk_space_alert.py:822-827`.
  - send fails or times out -> new thread: start runs. Enforced at `disk-alert/disk_space_alert.py:822-827`, `:832-839`.
  - start with no id, or a timeout -> thread id dropped. Enforced at `disk-alert/disk_space_alert.py:836-839`, `:881`.
  - failed recovery notify -> reset. Enforced at `disk-alert/disk_space_alert.py:860-866`.
- Gaps:
  - DA-G1 A send that times out (rc 124) starts a second thread. Verdict: confirmed (round 1 run). Evidence: round 1 `out-disk-alert.txt` lines 1-3: `[["thread", "send"], 124, "timed out after 1 seconds"]`, then `[["thread", "start"], 0, ""]`. Control lines 4-5: fast send, no start. The test at `disk-alert/tests/test_disk_space_alert.py:150` pins the fallback for a missing thread (by design), not for a timeout. Task: new (S; P22).
  - DA-G1b The send error is dropped from the record. Verdict: confirmed (round 1 run). Evidence: same run, `out-disk-alert.txt` lines 1-3; the record's `t3_error` is null (`notes-disk-alert.md`). Task: new (S; P22, same fix as DA-G1).
  - DA-G2 A start that prints no id, or times out, leaves no thread id. The next episode starts a second thread. Verdict: confirmed (round 1 run). Evidence: `out-disk-alert.txt` lines 6-9: `later_calls: ["start", "notify"]`, `later_thread: "mcp:new-2"`. Pinned only as "not retried": `test_disk_space_alert.py:193`, `:204`. Task: new (S; P22).
  - DA-G7 A failed recovery notify resets the state. The error appears only in events. Verdict: confirmed (low; round 1 run). Evidence: `out-disk-alert-g7.txt` line 1: `"notify_error": "osascript exit 1: refused"`; `"state_after": {"level": "ok", "pending": false, "thread_id": null}`. Task: new (S; P26).
- Tests: `test_disk_space_alert.py:150` (missing thread falls back), `:168` (failed send and start keeps the thread), `:193`, `:204` (start outcomes), `:215` (recovery). Not pinned: DA-G1, DA-G1b, DA-G2 (after a failed send), DA-G7.

### disk-alert sweeps

- Where: `disk-alert/disk_space_alert.py` (`running_processes` 280-290; `sweep_sessions` 456, lines 476-477 and 481; `build_lock_files` 560; `take_build_locks` 573; `removable` 593; `sweep_targets` 610, lines 630-631 and 638-641; `sweep` 666; `run_sweep` 948); `disk-alert/tests/test_disk_space_alert.py` (304-404 sessions; 473 time limit; 617-781 targets)
- States: folder idle, folder in use, folder removed; build lock listed, held, released; process snapshot read or unreadable
- Transitions:
  - idle -> removed: the scan says idle; the recheck reads only `<session>.jsonl`. Enforced at `disk-alert/disk_space_alert.py:481`.
  - listed -> locked: lock files are listed before the locks are taken. Enforced at `disk-alert/disk_space_alert.py:630-631`.
  - unreadable snapshot -> step ends. Enforced at `disk-alert/disk_space_alert.py:476-477`, `:288`.
  - removable error -> skipped. Enforced at `disk-alert/disk_space_alert.py:638-641`.
  - sweeper -> sweeper: no lock between runs. Enforced at `disk-alert/disk_space_alert.py:948`.
- Gaps:
  - DA-G3 A scratch-folder or subagent-transcript write during the process check is missed. The folder is removed. Verdict: confirmed (round 1 run). Evidence: round 1 `out-disk-alert.txt` lines 10-11: `scratch-write {"folder_exists": false ...}`, `subagent-write {"folder_exists": false ...}`; control line 12: `folder_exists: true`. Task: dotfiles-437 (holds it; session registered after the snapshot).
  - DA-G4 Two sweepers can run at once. The second removes the folder; the first exits 1. Verdict: confirmed (round 1 run). Evidence: round 1 `out-disk-alert.txt` line 13: `nested-session {"events": ["swept", "swept"], "first_exit": 1 ...}`. Task: new (S; P23).
  - DA-G5 An unreadable process list ends the sessions step with no event. The targets step then returns with no record. Verdict: confirmed (round 1 run). Evidence: `out-disk-alert.txt` lines 16-18: sessions `{"events": ["escalated"], "folder_exists": true}`; targets `{"swept": [], "target_built": true}`; control with ps readable: swept. Task: new (S; P27).
  - DA-G6 A `removable()` OSError is skipped with no record. Verdict: confirmed by mock; the real trigger is a race only. Evidence: `out-disk-alert.txt` lines 19-20: `removable-raises {"failures": [], "swept": []}`; control unpatched: swept. Task: new (S; P27).
  - DA-G8 A build starts after the lock listing and before the lock is taken. The sweep then removes the release folder. Verdict: confirmed (round 1 run). Evidence: round 1 `out-disk-alert-g8.txt` lines 1-2: control `release_lock_left: true`; race `release_folder_left: false`, `swept` includes the release folder. Task: dotfiles-437 (holds it).
- Tests: targets and sessions pinned at 304-404 and 617-781 (idle removed 304; running kept 337; time limit 473; held build lock 655; unreadable registry 710). Not pinned: DA-G3, DA-G4, DA-G5 (no event), DA-G6.

### disk-alert LaunchAgent install

- Where: `disk-alert/disk_space_alert.py` (`plist_path` 993; `launch_agent` 997; `run_install` 1031: plist 1044; bootout 1046; bootstrap 1047; return 1 at 1048-1050); `disk-alert/tests/test_disk_space_alert.py` (853-873)
- States: plist absent, plist written, unloaded, loaded
- Transitions: plist written -> bootout (rc ignored) -> bootstrap. Failed bootstrap -> exit 1. Enforced at `disk-alert/disk_space_alert.py:1044-1050`.
- Gaps:
  - DA-G9 A failed bootstrap leaves the plist and an unloaded agent. Verdict: confirmed (round 1 run). Evidence: round 1 `out-disk-alert-g9.txt` line 1: calls `bootout` then `bootstrap`; `"exit": 1, "plist_written": true`. Task: new (S; P24). Same shape as config-sync G14.
- Tests: `test_disk_space_alert.py:853` (dry run prints the plist) and `:873` (rejects inverted thresholds). No bootstrap-failure case.

### vimtex tectonic build on save

- Where: `nvim/lua/config/autocmds.lua` (26-29; 42-66; 55-63); `nvim/lua/config/options.lua` (31); `nvim/tests/vimtex.lua` (50-73)
- States: idle, queued, waiting, building
- Transitions:
  - idle -> queued: save of a tectonic buffer. Enforced at `nvim/lua/config/autocmds.lua:26-29`.
  - queued -> waiting: compiler running; retry in 200 ms. Enforced at `nvim/lua/config/autocmds.lua:55-56`.
  - waiting -> building: compiler idle; start. Enforced at `nvim/lua/config/autocmds.lua:58-63`.
- Gaps:
  - G1 Number 0 from `is_running()` counts as true in Lua at line 55. Verdict: refuted for the installed plugin. Real idle `is_running()` returns a Lua boolean false. Evidence: `r2/logs/vimtex-real-r2.txt` line 2: `P2 real vimtex idle is_running ...: out=boolean false tectonic`. Lua check: `r2/logs/nvim-r2b.txt` lines 1-2: `0 truthy`; `v:false falsy`. Latent risk at line 55 remains. Task: new (S; P2).
  - G2 A cold TeX cache makes the save test fail. The cold build takes 100.4 s; the test waits 45 s. Verdict: confirmed. Evidence: `r2/logs/vimtex-repo-test-r2-rep1.txt` line 17: `tests/vimtex.lua:57: Expected 2 successful builds, got 1`; `r2/logs/tectonic-cold-r2.txt` line 1: `elapsed_s=100.4 pdf=True`. Warm cache: `r2/logs/vimtex-final-r2.txt` rc 0. Task: new (S; P1).
- Tests: `nvim/tests/vimtex.lua` (first save starts one build; rapid saves queue one follow-up). Passes warm; fails cold.

### vimtex Skim protect

- Where: `nvim/autoload/config/vimtex.vim` (9-19); `nvim/scripts/protect-skim-notes.js` (13-15); `nvim/tests/protect-skim-notes.test.js`
- States: no PDF, annotated (refused), converted, protected; osascript running
- Transitions:
  - call -> osascript runs the script. Enforced at `nvim/autoload/config/vimtex.vim:9-19`.
  - annotated PDF -> refused. Enforced at `nvim/scripts/protect-skim-notes.js:13-15`.
- Gaps:
  - G1 `system()` waits for osascript with no time limit. Verdict: confirmed. Evidence: `r2/logs/nvim-r2.txt` line 2: `B hung osascript: timed_out_after_8s=True result_written=False osa_started=True`; line 3 control: `rc=0 ... result_written=True`. Task: new (S; P3).
  - G2 The refusal has no test. Removing it keeps the suite at 4 passes. Verdict: confirmed. Evidence: `r2/logs/nvim-r2b.txt` line 6: shipped rc 1 with `The PDF has embedded annotations...`; line 7: refusal lines removed, rc 0; lines 8-9: `bun test` 4 pass shipped and mutated. Task: new (S; P4).
  - G3 The Skim-running branch of the script. Verdict: unverified. Needs Skim.app and the screen (only-me).

### bun-outdated

- Where: `nvim/scripts/bun-outdated.js` (25-26); `nvim/tests/bun-outdated.test.js`
- States: rows read, names mapped, dependency entries
- Transitions: row -> dependency entry; a later row overwrites an earlier one. Enforced at `nvim/scripts/bun-outdated.js:25-26`.
- Gaps:
  - G1 Two workspace rows for one package keep only the last row. Verdict: confirmed. Evidence: `r2/logs/nvim-r2.txt` line 1: `stdout='{"left-pad":{"current":"1.0.0","wanted":"1.0.0","latest":"1.3.0"}}'`. The 1.1.0 row is missing. Task: new (S; P5).
- Tests: `r2/logs/suite-nvim-bun-outdated.txt`: 4 pass. No duplicate-row case.

### dashboard harness data folder

- Where: `nvim/tests/dashboard.py` (68; 72-83)
- States: harness start, run loop, exit
- Transitions: start -> run loop. Enforced at `nvim/tests/dashboard.py:68`. Data folder from HOME; no `XDG_DATA_HOME` in the argv. Enforced at `nvim/tests/dashboard.py:72-83`.
- Gaps:
  - G1 The harness data folder follows HOME when HOME is inherited. Verdict: confirmed (low). Evidence: `r2/logs/nvim-r2.txt` line 6: `D harness env, HOME inherited: rc=0 data_dir=` HOME-based data folder; line 7: fake HOME gives the data folder under the fake home. Task: new (S; P25).
  - G2 `run_loop(None, ...)` has no time limit (`nvim/tests/dashboard.py:68`). Verdict: unverified. Needs pynvim in the scratch environment; not started this round.

### lazy bootstrap prompt

- Where: `nvim/lua/config/lazy.lua` (9-12)
- States: clone ok, clone failed, waiting for key, exit
- Transitions: failed clone -> prompt -> key read -> `os.exit(1)`. Enforced at `nvim/lua/config/lazy.lua:9-12`.
- Gaps:
  - G1 The prompt waits with no time limit. Verdict: by design. Prompt text at `nvim/lua/config/lazy.lua:9`: "Press any key to exit...". Run: `r2/logs/nvim-r2b.txt` line 5: `still waiting after 3 s=True`.
- Tests: none.

### untracked file cache

- Where: `git/shared.gitconfig` (9)
- States: cache off, cache on and current, cache stale
- Transitions: restored directory mtime -> git should rescan. Enforced by git, not by this file.
- Gaps:
  - G1 An mtime-only restore hides new untracked files. Verdict: refuted (APFS). Evidence: `r2/logs/untracked-cache-r2.txt` line 5: `A cache on, dir mtime restored to 2020: rc=0 new.txt listed=True`. `r2/logs/untracked-ctime-r2.txt`: ctime moves to now after the restore.
- Tests: none.

### cargo test harness

- Where: `cargo/tests/test_cargo_config.py` (63)
- States: RUSTUP_HOME from environment, RUSTUP_HOME from the home folder
- Transitions: environment unset -> home folder default. Enforced at `cargo/tests/test_cargo_config.py:63`.
- Gaps:
  - G1 Tests depend on the real HOME when RUSTUP_HOME is unset. A fake HOME without RUSTUP_HOME fails 4 of 5. Verdict: confirmed. Evidence: `r2/logs/cargo-fakehome.txt`: `Ran 5 tests`, `FAILED (failures=4)`. `r2/logs/cargo-fakehome-rustuphome.txt`: `OK`. `r2/logs/cargo-realhome.txt`: `OK`. Task: new (S; P14).
- Tests: `cargo/tests/test_cargo_config.py` (105 lines; line 63 read this round, rest from round 1).

### explore test socket guard

- Where: `explore/tests/test_explore.py` (344-346 guard; 403-411 TUI test)
- States: short TMPDIR (run), long TMPDIR (skip)
- Transitions: path over 100 bytes -> `skipTest`. Enforced at `explore/tests/test_explore.py:345-346`.
- Gaps:
  - G1 The guard's premise does not reproduce. nvim bound a 180-byte absolute path and answered RPC. Verdict: refuted (premise). Evidence: `r2/logs/listen-len-r2.txt` lines 3-6: `bytes=180`, `socket_file_seen=True`, `rpc rc=0 out=2`. The cause of the bind success was not checked. Task: new (S; P10).
  - G2 The TUI test has no guard and fails on the `lsof` truncation. Verdict: confirmed (same cause as the explore socket discovery G1). Evidence: suite errors=1 in three runs (`r2/logs/suite-explore*.txt`). Task: P9 (same task).
