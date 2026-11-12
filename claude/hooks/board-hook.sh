#!/bin/sh
# One work-board hook for Claude Code or Codex: board-hook.sh <event> <claude|codex>.
# Runs the installed `board` (github.com/syz51/agent-board). Without it, or with
# AGENT_BOARD_HOOKS=off (test, benchmark and nested `claude -p` sessions), it behaves as if
# the hook were absent.
board="$HOME/.cargo/bin/board"
runtime="$2"
if [ "${AGENT_BOARD_HOOKS:-}" = off ] || [ ! -x "$board" ]; then
  # Codex rejects empty output from a Stop hook.
  if [ "$1" = stop ] && [ "$runtime" = codex ]; then printf '{}\n'; fi
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
