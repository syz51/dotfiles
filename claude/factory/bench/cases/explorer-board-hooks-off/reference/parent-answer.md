1. There is no shared script: each hook runs `$HOME/.cargo/bin/board hook <event> --runtime <claude|codex>` inline.
2. Claude Code registers the hooks in `claude/settings.json`; Codex in `codex/hooks.json`.
3. No environment variable turns them off; each command exits 0 when the `board` binary is not installed.
4. `childEnv` in `claude/tests/lib/process.js` only strips Claude Code's session variables; nothing keeps child sessions off the board.
5. A skipped hook writes nothing to standard output.
