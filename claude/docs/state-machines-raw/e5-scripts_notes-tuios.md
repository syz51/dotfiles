# tuios notes (scratch only)

## dock-machine.py (tuios/bin/dock-machine.py, 197 lines, read in full)
- states: unknown (host ?), local label, remote prompt label, ssh active (ssh <host>), ssh unknown (ssh ?)
- active_ssh loop: 32 passes, 118 result; depth >32 -> None -> local claim (probe_dock_machine.py depth=40: laptop)
- focused_window timeout 0.3 per recv (66); trickle 67 bytes at 0.05 s -> 3.73 s (probe)
- main: window read (187), ps snapshot (188), ps -p lookup (190) are separate reads; ssh exit between 188 and 190 -> host ? (probe race)
- tests: tuios/tests/test_dock_machine.py 17 tests, OK; test_dock_clock.py 2 tests; probe output tuios-probes/dock/out-probe-dock-machine.txt

## config.toml [dock.custom.clock] (lines 207-221)
- push loop: date read, print, sleep 60-s; clock real /bin/date matches mock format (probe_clock_real_date.py, rc 1, delay 53 at 07 s)
- unverified: laptop sleep/wake staleness (cannot suspend the Mac)
- component failure hides cell (doc lines 111-113); engine is outside repo

## probe-ghostty-metrics.py (141 lines, read in full)
- states: idle, env-checked, raw, query sent, reading reply, parsed/error, restored, JSON out
- late or malformed reply bytes stay queued as shell input (probe_metrics_leftover.py: RIVATE_KEYSTROKE; ESC[6;40;20t)
- SIGKILL/SIGSTOP not handled (epilog 115-117 documents it) -> by design
- restore failure may mask original error (lines 100-103, 126-128): unverified

## nocturne.json (37 lines, read in full)
- git grep: no reference in tuios/ or install scripts; only nvim tests refer to a Nocturne user theme (nvim/tests/ghostty-completion.lua:45,136,140). Hygiene; unverified how tuios loads it.

## tuios/config.toml (245 lines, read in full)
- tuios validates on save; error keeps old settings (lines 8-10); no repo test loads the whole file with the fork loader (only tomllib in test_dock_machine.py:161)

## probes run
- out-probe-metrics-leftover.txt: success_control exit 0 ok leftover b''; malformed exit 1 error leftover b'RIVATE_KEYSTROKE'; late exit 1 error leftover b'\x1b[6;40;20t'
- hung twice: first query loop had no deadline/EOF check; second: no master drain before release (test_ghostty_metrics_probe.py:109-112). Fixed; not a finding.
