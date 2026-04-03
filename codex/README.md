# Codex Backup

Snapshot of the durable local Codex configuration copied from `~/.codex`.

Included:

- `config.toml`
- `AGENTS.md`
- `agents/`
- `rules/`
- `skills/`

Excluded on purpose:

- auth/session credentials
- history, logs, sqlite state
- archived sessions
- transient runtime files
- generated virtualenvs and bytecode caches inside backed-up skills
- bundled system skills under `~/.codex/skills/.system`
- external skill roots such as `~/.agents/skills`

Source paths:

- `/Users/roy/.codex/config.toml`
- `/Users/roy/.codex/AGENTS.md`
- `/Users/roy/.codex/agents/`
- `/Users/roy/.codex/rules/`
- `/Users/roy/.codex/skills/`
