#!/bin/sh
# One work-board hook for Claude Code or Codex: board-hook.sh <event> <claude|codex>.
# Runs the installed `board` (github.com/syz51/agent-board). Without it, or with
# AGENT_BOARD_HOOKS=off (test, benchmark and nested `claude -p` sessions), it behaves as if
# the hook were absent.
board="$HOME/.cargo/bin/board"
if [ "${AGENT_BOARD_HOOKS:-}" = off ] || [ ! -x "$board" ]; then
  # Codex rejects empty output from a Stop hook.
  if [ "$1" = stop ] && [ "$2" = codex ]; then printf '{}\n'; fi
  exit 0
fi
exec "$board" hook "$1" --runtime "$2"
