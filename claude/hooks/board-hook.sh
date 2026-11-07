#!/bin/sh
# One work-board hook for Claude Code or Codex: board-hook.sh <event> <claude|codex>.
# Runs the installed `board` (github.com/syz51/agent-board). Without it, or with
# AGENT_BOARD_HOOKS=off (test, benchmark and nested `claude -p` sessions), it behaves as if
# the hook were absent.
board="$HOME/.cargo/bin/board"
skip() {
  # Codex rejects empty output from a Stop hook.
  if [ "$1" = stop ] && [ "$2" = codex ]; then printf '{}\n'; fi
  exit 0
}
if [ "${AGENT_BOARD_HOOKS:-}" = off ] || [ ! -x "$board" ]; then skip "$@"; fi
# The board never blocks through its exit code. A board that fails, such as an older one
# that rejects an event it does not know with exit 2 (which blocks a PreToolUse call),
# counts as absent.
"$board" hook "$1" --runtime "$2" 2>/dev/null || skip "$@"
