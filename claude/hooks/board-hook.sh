#!/bin/sh
# One work-board hook for Claude Code, Codex or Antigravity:
#   board-hook.sh <event> <claude|codex|antigravity>
# Runs the installed `board` (github.com/syz51/agent-board). Without it, or with
# AGENT_BOARD_HOOKS=off (test, benchmark and nested headless sessions), it behaves as if
# the hook were absent.
board="$HOME/.cargo/bin/board"
runtime="$2"
fallback_output() {
  if [ "$runtime" = antigravity ]; then
    case "$1" in
      pre-tool-use | stop) printf '{"decision":"allow"}\n' ;;
      *) printf '{}\n' ;;
    esac
  elif [ "$1" = stop ] && [ "$runtime" = codex ]; then
    printf '{}\n'
  fi
}
if [ "${AGENT_BOARD_HOOKS:-}" = off ] || [ ! -x "$board" ]; then
  fallback_output "$1"
  exit 0
fi
if [ "$runtime" = antigravity ]; then
  out=$("$board" hook "$1" --runtime "$runtime" 2>/dev/null)
  status=$?
  if [ "$status" -ne 0 ] || [ -z "$out" ]; then
    fallback_output "$1"
    exit 0
  fi
  printf '%s\n' "$out"
  exit 0
fi
case "$1" in
  pre-tool-use | post-tool-use-failure)
    # A board older than agent-board#8 rejects these events with exit 2, which blocks the
    # tool call. Report that as a failed hook instead, which never blocks.
    "$board" hook "$1" --runtime "$runtime"
    status=$?
    if [ "$status" -eq 2 ]; then exit 1; fi
    exit "$status"
    ;;
esac
exec "$board" hook "$1" --runtime "$runtime"
