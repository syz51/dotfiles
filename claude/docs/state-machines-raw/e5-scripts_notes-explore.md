# explore notes (scratch)
## explore-dispatch (240 lines, read)
- explore_rpc 70-90: 40 ticks x zselect 5cs = 2 s bound; rc 124 on timeout; TERM the client (84-86) but server may still apply the RPC.
- explore_nvim_open 197-225: getpid RPC (204), then action RPC (223) returns 1 on timeout even when editor may have applied open.
- explore_nvim_socket 115-168: per candidate socket one 2 s RPC; no overall deadline (servers x candidates x 2 s).
- explore_json 5-7: nvim -l with no timeout.
- explore_foreground 42-66: two ps reads (48, 62) for one decision.
## explore-key (64 lines, read)
- 51-61: if nvim_open fails (any rc) -> explore_new_window (61). Possible double open after RPC timeout.
- 22-29: zle marker recheck then send-keys; check is immediately before send (TOCTOU small).
## explore-action (113 lines, read)
- 54-56 result written temp + mv (atomic). 24-25 and 61 scope written in place (print >) not atomic.
- 110-111 multi-item move: partial completion, message says earlier items may have completed (by design text).
## explore-popup (5 lines, read)
## explore probes (scratch: explore-probes/double-open)
- explore-key double open: ok mode rc 0 1.02 s, editor applied before return, 0 new-window; delay mode rc 0 2.48 s, editor applied 0.39 s after return, 1 new-window (run-mode.sh, out-ok.txt, out-delay.txt)
- explore_nvim_socket: 5 dead candidates + 1 live: rc 0, 10.86 s (candidates/out-probe-candidates.txt)
- zsh /etc/zshenv path_helper resets PATH; ZDOTDIR .zshenv used for fake PATH. Earlier slip: one real `tuios list-windows --json` ran with real HOME (rc 1, 'daemon not running'), no state change.
