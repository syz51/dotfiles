1. Every board hook runs `claude/hooks/board-hook.sh <event> <claude|codex>`, which execs `~/.cargo/bin/board hook`.
2. Claude Code registers it in `claude/settings.json`; Codex in `codex/hooks.json`.
3. `AGENT_BOARD_HOOKS=off` makes the script exit without calling the board (as does a missing `board` binary).
4. `childEnv` in `claude/tests/lib/process.js` sets `AGENT_BOARD_HOOKS: "off"` for every child session it builds.
5. For a skipped Codex Stop event it prints `{}`, because Codex rejects empty output from a Stop hook.
