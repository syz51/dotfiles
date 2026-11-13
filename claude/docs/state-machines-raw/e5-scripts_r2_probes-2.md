# Round 2 probes: rerunnable blocks for confirmed gaps

Set these first. `E5` is the scratch folder `e5-scripts`; `R` is `$E5/r2`. `uv` is the uv binary on PATH outside the restricted shell.
Rules for every block: fake HOME and scratch copies only. No real `tuios`, board, osascript, launchctl or live model.
Expected output lines are copied from the logs named in each block. Round 2 logs are in `$R/logs`; round 1 outputs are in `$E5`.
Probe IDs match `machines-2.md`. Each block ends with its proposed task (S, M or L).

---

## P1 vimtex save test fails on a cold tectonic cache (gap vimtex G2)

Commands:
    uv run --no-project --python 3.11 python -B "$R/probes/cold_tectonic_r2.py"
    uv run --no-project --python 3.11 python -B "$R/probes/vimtex_repo_r2.py"

Expected: cold build `elapsed_s=100.4 pdf=True` (value varies). Test output at cold cache: `tests/vimtex.lua:57: Expected 2 successful builds, got 1`, non-zero exit. Warm cache: pass (`$R/logs/vimtex-final-r2.txt`, rc 0).

Task: vimtex save test waits 45 s for a cold build of about 100 s. Size S.
- Problem: a cold tectonic cache fails `nvim/tests/vimtex.lua` (line 57).
- Evidence: `vimtex-repo-test-r2-rep1.txt` line 17; `tectonic-cold-r2.txt` line 1.
- Change: warm the cache in setup, or raise the wait above the cold build time, and report the cache state.

## P2 vimtex build-on-save: Lua truthiness of is_running (gap vimtex G1, latent)

Commands:
    uv run --no-project --python 3.11 python -B "$R/probes/nvim_r2b.py"
    uv run --no-project --python 3.11 python -B "$R/probes/vimtex_real_r2.py"

Expected: `T vim.fn.eval('0') in Lua: rc=0 -> '0 truthy'`; `T vim.fn.eval('v:false') in Lua: rc=0 -> 'false falsy'`; real plugin: `P2 real vimtex idle is_running ...: out=boolean false tectonic`.

Task: vimtex build-on-save tests `is_running()` with Lua truthiness. Size S.
- Problem: `nvim/lua/config/autocmds.lua:55` treats any non-nil value as true. A number 0 is truthy in Lua. The installed plugin returns a boolean, so this is latent.
- Change: compare with `== true`, or add a test that returns number 0 from the stub.

## P3 vimtex protect: osascript has no time limit (gap vimtex protect G1)

Command:
    uv run --no-project --python 3.11 python -B "$R/probes/nvim_r2.py"    (part B)

Expected: `B hung osascript: timed_out_after_8s=True result_written=False osa_started=True`; control `rc=0 ... result_written=True`.

Task: vimtex protect waits on osascript with no time limit. Size S.
- Problem: `nvim/autoload/config/vimtex.vim:9-19` calls `system()` with no time limit.
- Change: run osascript with a time limit and report the failure to the user.

## P4 protect-skim-notes refusal has no test (gap protect G2)

Command:
    uv run --no-project --python 3.11 python -B "$R/probes/nvim_r2b.py"    (part F, lines 6-9)

Expected: shipped script `rc=1`, stderr contains `The PDF has embedded annotations. Convert them to Skim notes and save before rebuilding.`; refusal removed `rc=0 stderr=''`; `bun test` `4 pass`, `0 fail` for shipped and mutated.

Task: protect-skim-notes refusal has no test. Size S.
- Change: add a test with an annotated PDF that expects the refusal.

## P5 bun-outdated keeps only the last workspace row (gap bun-outdated G1)

Command:
    uv run --no-project --python 3.11 python -B "$R/probes/nvim_r2.py"    (part A)

Expected: `stdout='{"left-pad":{"current":"1.0.0","wanted":"1.0.0","latest":"1.3.0"}}'`. The 1.1.0 row is missing.

Task: bun-outdated overwrites a package's earlier workspace row. Size S.
- Problem: `nvim/scripts/bun-outdated.js:25-26` assigns each row in turn.
- Change: keep all rows per package, or the newest; add a duplicate-row test.

## P6 vp word-splits ps args for a spaced project path (gap vp G1)

Command:
    uv run --no-project --python 3.11 python -B "$R/probes/vp_explore_r2.py" e

Expected: `e control: rc=0 stdout='CALLER-VP ran: from-wrapper'`; `e spaced: rc=127 stdout='' stderr='vp: no node_modules/.bin/vp in ...'`.

Task: shell vp fails for a project path with a space. Size S.
- Problem: `shell/bin/vp:16` uses `for word in $(ps -o args= -p "$pid")`.
- Change: parse the args without word splitting; add a spaced-path case to `shell/test-vp-launcher.py`.

## P7 explore_json runs nvim with no time limit (gap explore-dispatch G1)

Command:
    uv run --no-project --python 3.11 python -B "$R/probes/vp_explore_r2.py" g

Expected: `g hung nvim: rc=None timed_out_after_5s=True`; control `rc=0 timed_out=False stdout='["ok"]'`.

Task: explore_json has no time limit. Size S.
- Change: give `nvim -l` a limit like the one in `explore_rpc` (`explore/bin/explore-dispatch:70-90`).

## P8 explore-action writes the scope file in place (gap explore-action G1)

Command:
    uv run --no-project --python 3.11 python -B "$R/probes/vp_explore_r2.py" f

Expected: `f writer: rc=0 size_between_open_and_write=0 final=...`. Size is 0 between open and write.

Task: explore-action truncates the scope file before it writes. Size S.
- Problem: `explore/bin/explore-action:25` and `:61` use `print -r -- ... > "$session/scope"`.
- Change: write to a temp file in the same folder, then `mv`, as lines 54-56 already do.

## P9 explore socket discovery misses nvim sockets with long names (gap explore socket G1)

Command 1:
    uv run --no-project --python 3.11 python -B "$R/probes/explore_tui_diag_r2.py" <scratch folder> <checkout>/explore/bin

Expected: `DBG candidate=... len=103`; `DBG servers=... found_pid=` (empty); `explore_socket 0 fn_rc=1`.

Command 2 (headless run with the skip removed; reconstructed from the log name, verify the copy before use):
- Copy `explore/` into scratch.
- Delete the skip at `explore/tests/test_explore.py:345-346` in the copy only.
- Run: `uv run --no-project --python 3.11 python -B -m unittest discover -s <copy>/tests -k test_real_neovim_tui_client_server`

Expected: `AssertionError: b'' != ...`; `FAILED (failures=1)`; exit 1. Log: `$R/logs/explore-headless-noguard-r2.txt`.

Task: explore socket discovery drops nvim sockets whose names exceed 103 bytes. Size M.
- Problem: `lsof -a -p PID -U -Fn` truncates names on this macOS (`explore/bin/explore-dispatch:147-152`).
- Change: resolve the full socket path before `[[ -S ]]`; add a test with a long TMPDIR.

## P10 explore TUI test's length guard premise does not reproduce (gap explore test G1)

Command:
    uv run --no-project --python 3.11 python -B "$R/probes/listen_len_r2.py" <scratch folder>

Expected: `long-absolute: listen=... bytes=180`; `socket_file_seen=True exited_early=False`; `rpc rc=0 out=2`. Log: `$R/logs/listen-len-r2.txt`.

Task: explore TUI test skips on a long TMPDIR that nvim can use; the TUI test has no guard. Size S (after P9).
- Change: remove the 100-byte skip at `explore/tests/test_explore.py:345-346` once P9 is fixed.

## P11 install-fork concurrent runs race on tuios.new (gap install-fork G1)

Command:
    uv run --no-project --python 3.11 python -B "$R/probes/tuios_r2.py"    (labels i, h, j, k, l; each probe sets its own fake HOME and PATH)

Expected: `i[dest-present] run A: rc=1 stderr='mv: rename ... tuios.new'`; run B `rc=0`. Log: `$R/logs/tuios-r2.txt` lines 2-3.

Task: install-fork.sh stages every install under one name, `tuios.new`. Size M.
- Problem: `tuios/install-fork.sh:48`; two runs collide at the `mv`.
- Change: stage in a `mktemp` file in the destination folder; take a lock for the install.

## P12 install-fork hides the install's exit status (gap install-fork G2)

Command: as P11 (label j).

Expected: `j install with broken fork: rc=0`; `j the same binary run directly: rc=1 stderr='fork crashed'`. Log: `tuios-r2.txt` lines 9-10.

Task: install-fork.sh reports success after a broken install. Size S.
- Problem: `tuios/install-fork.sh:60` pipes `--version` into `head`.
- Change: capture the version output and its status before printing.

## P13 install-fork overwrites an older .bak (gap install-fork G3)

Command: as P11 (label k).

Expected: `k older backup overwritten: True`. Log: `tuios-r2.txt` lines 12-13.

Task: install-fork.sh replaces an existing backup file. Size S.
- Problem: `tuios/install-fork.sh:55` runs `mv "$link" "$link.bak"`.
- Change: pick a unique backup name, or stop when the name exists.

## P14 cargo config test depends on the real HOME (gap cargo G1)

Commands (copy `cargo/` to scratch first):
    HOME=<scratch>/fakehome uv run --no-project --python 3.11 python -B -m unittest discover -s <copy>/tests
    HOME=<scratch>/fakehome RUSTUP_HOME=<real rustup home> uv run --no-project --python 3.11 python -B -m unittest discover -s <copy>/tests

Expected: first run `Ran 5 tests`, `FAILED (failures=4)` (`$R/logs/cargo-fakehome.txt`); second run `OK` (`cargo-fakehome-rustuphome.txt`).

Task: cargo config test reads the real rustup home when RUSTUP_HOME is unset. Size S.
- Problem: `cargo/tests/test_cargo_config.py:63`.
- Change: set RUSTUP_HOME in the test, or skip with a reason when it is missing.

## P15 tracked bytecode in config-sync tests (hygiene, not a state machine)

Command (read only):
    git ls-files config-sync/tests | grep -c pyc

Expected: `1` (`config-sync/tests/__pycache__/test_config_sync.cpython-313.pyc`).

Task: remove tracked bytecode from config-sync tests and ignore it. Size S.

## P16 ghostty metrics probe: failed restore hides the query error (gap probe-ghostty-metrics G1)

Commands (copy `tuios/bin/probe-ghostty-metrics.py` to scratch as `<SRC>`; use the mode names in the log):
    uv run --no-project --python 3.11 python -B "$R/probes/ghostty_restore_r2.py" <SRC> control
    uv run --no-project --python 3.11 python -B "$R/probes/ghostty_restore_r2.py" <SRC> query-fails-restore-fails

Expected: control `Timed out waiting for the cell-pixel response (2 seconds).`; second run `child_exit 1 output {"status": "error", "error": "injected restore failure"}`. Log: `$R/logs/ghostty-restore-r2.txt`.

Task: probe-ghostty-metrics reports only the restore error when both fail. Size S (low).
- Problem: `tuios/bin/probe-ghostty-metrics.py:95-105` restores in `finally`; `:126` reports one error.
- Change: report both errors.

## P17 config-sync holds() unlinks a lock renewed after it was read (gap config-sync G10)

Command:
    uv run --no-project --python 3.11 python -B "$R/probes/cs_r2.py" g10

Expected: `renewal landed before unlink: pid alive = True | mtime age s = 0.0`; `g10 race: held = [] | lock exists = False`. Log: `$R/logs/cs-r2.txt` lines 2-4.

Task: config-sync removes a lock that a live run renewed after the read. Size S (narrow).
- Problem: `config-sync/config_sync.py:150` unlinks after `holds()` reads the file.
- Change: read the lock again before the unlink, and compare the pid.

## P18 config-sync restores a CRLF settings file as LF (gap config-sync G11, latent)

Command:
    uv run --no-project --python 3.11 python -B "$R/probes/cs_r2.py" g11

Expected: run 1 `worktree bytes equal HEAD blob = False | git status = 'M claude/settings.json'`; run 2 `pulled = False problems = ['pull-failed']`. Log: `cs-r2.txt` lines 9-12.

Task: config-sync restore reads and writes committed settings in text mode. Size S.
- Problem: `config-sync/config_sync.py:224` reads with text mode.
- Change: compare and write bytes.

## P19 config-sync reads a non-UTF-8 settings file outside any try (gap config-sync G13)

Command:
    uv run --no-project --python 3.11 python -B "$R/probes/cs_r2.py" g13

Expected: `UnicodeDecodeError` in check and in sync. Log: `cs-r2.txt` lines 13-14.

Task: config-sync fails on a non-UTF-8 settings file. Size S (narrow).
- Problem: `config-sync/config_sync.py:185`.
- Change: read bytes; report the decode error as a problem.

## P20 config-sync install leaves the plist after a failed bootstrap (gap config-sync G14)

Command:
    uv run --no-project --python 3.11 python -B "$R/probes/cs_r2.py" g14

Expected: `g14 install exit = 1 | calls = ['launchctl bootout', 'launchctl bootstrap']`; `plist written before bootout = True | plist exists after = True`. Log: `cs-r2.txt` lines 1, 15-16.

Task: config-sync install writes the plist before a bootstrap that can fail. Size S.
- Problem: `config-sync/config_sync.py:359-365`.
- Change: bootstrap first, or remove the plist when bootstrap fails.

## P21 config-sync restore: a write in the last window is lost (gap config-sync G7)

Command: round 1 `$E5/probe_config_sync.py`, case P8 only. Read its first lines for the arguments before a rerun; the form was not re-read this round.

Expected: round 1 `$E5/out-p4-p9.txt` lines 17-19: P8 `kept: False`.

Task: config-sync restore loses a session write between the check and the replace. Size S.
- Problem: `config-sync/config_sync.py:196-198`. `test_config_sync.py:287-303` covers the read, not this window.
- Change: re-check after the write, or hold the lock across the restore.

## P22 disk-alert: a send timeout starts a second thread; thread id and send error are lost (gap DA-G1, DA-G1b, DA-G2)

Command (round 1 probe; fake HOME and scratch only):
    HOME=<scratch>/fakehome PROBE_SCRATCH=<scratch> uv run --no-project --python 3.11 python -B "$E5/probe_disk_alert.py"

Expected: `out-disk-alert.txt` lines 1-3: `[["thread", "send"], 124, "timed out after 1 seconds"]`, then `[["thread", "start"], 0, ""]`. Lines 4-5 (control): no start. Lines 6-9: `later_thread: "mcp:new-2"`. Line 1 record: `t3_error` null.

Task: disk-alert starts a new thread after a send timeout, and drops the send error. Size S.
- Problem: `disk-alert/disk_space_alert.py:822-827`, `:832-839`, `:881`.
- Change: treat a timeout as unknown; do not start; keep the thread id; record the send error.

## P23 disk-alert: two sweepers can run at once (gap DA-G4)

Command: as P22.

Expected: `out-disk-alert.txt` line 13: `nested-session {"events": ["swept", "swept"], "first_exit": 1 ...}`.

Task: disk-alert sweeps overlap; the second removes the folder the first uses. Size S.
- Problem: `disk-alert/disk_space_alert.py:948` (`run_sweep`) takes no lock.
- Change: take a run lock at the start of the sweep, with a stale-lock rule.

## P24 disk-alert: a failed bootstrap leaves the plist (gap DA-G9)

Command:
    HOME=<scratch>/fakehome uv run --no-project --python 3.11 python -B "$E5/probe_disk_alert_g9.py"

Expected: `out-disk-alert-g9.txt` line 1: calls `bootout` then `bootstrap`; `"exit": 1, "plist_written": true`.

Task: disk-alert install leaves the plist after a failed bootstrap. Size S. Same change as P20.

## P25 dashboard harness data folder follows HOME (gap dashboard G1, low)

Command:
    uv run --no-project --python 3.11 python -B "$R/probes/nvim_r2.py"    (part D)

Expected: `D harness env, HOME inherited: rc=0 data_dir=` a folder under HOME; with a fake HOME, the folder is under the fake HOME. Log: `nvim-r2.txt` lines 6-7.

Task: nvim dashboard harness uses the HOME data folder. Size S.
- Change: set `XDG_DATA_HOME` in the harness argv (`nvim/tests/dashboard.py:72-83`).

## P26 disk-alert: a failed recovery notify resets the state (gap DA-G7, low)

Command:
    HOME=<scratch>/fakehome PROBE_SCRATCH=<scratch> uv run --no-project --python 3.11 python -B "$E5/probe_disk_alert_g7.py"

Expected: `out-disk-alert-g7.txt` line 1: `"notify_error": "osascript exit 1: refused"`; `"state_after": {"level": "ok", "pending": false, "thread_id": null}`.

Task: disk-alert clears its state when the recovery message fails. Size S.
- Problem: `disk-alert/disk_space_alert.py:860-866`.

## P27 disk-alert: unreadable process list and removable() errors skip with no record (gaps DA-G5, DA-G6)

Command: as P22.

Expected: `out-disk-alert.txt` lines 16-18: sessions `{"events": ["escalated"], "folder_exists": true}`; targets `{"swept": [], "target_built": true}`. Lines 19-20: `removable-raises {"failures": [], "swept": []}`.

Task: disk-alert skips sessions and targets on an unreadable process list or a removable() error, with no record. Size S.
- Problem: `disk-alert/disk_space_alert.py:476-477`, `:288`, `:638-641`.
- Change: write an event or a failure for each skip.

---

## Held evidence (no new task; add to the named task)

- DA-G3 (dotfiles-437): round 1 `$E5/probe_disk_alert.py` lines 10-12 (`scratch-write` and `subagent-write` removed; control kept).
- DA-G8 (dotfiles-437): round 1 `$E5/probe_disk_alert_g8.py`; `$E5/out-disk-alert-g8.txt` lines 1-2.
- explore key double open (dotfiles-444 item 4, corrected lines `explore/bin/explore-key:57`, `:61`): round 1 `$E5/explore-probes/double-open/run-mode.sh`; outputs `out-ok.txt`, `out-delay.txt`. Arguments not recorded this round.
- explore_nvim_socket candidate deadline (round 1): 5 dead and 1 live candidate took 10.86 s (round 1 `candidates/out-probe-candidates.txt`; not re-located this round).
