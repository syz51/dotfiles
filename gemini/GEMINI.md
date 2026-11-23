# Local Setup & Tooling Pointers

## Skills
All 13 global skills are exposed in `~/.gemini/config/skills/` and cataloged (with project-scoped and built-in skills) in `~/.gemini/config/SKILLS_CATALOG.md`.

Load the matching skill before starting relevant work:
- `frontend-ui`: frontend/UI work or tooling (TSX, Vue, CSS). Also read `~/.config/claude/frontend-avoid.md` for declined UI patterns.
- `design-taste-frontend`: anti-slop art direction (tasteskill v2) for landing pages, marketing/editorial sites, portfolios, or bespoke visual direction (run its `.mjs` scripts with `bun`).
- `typescript`: TypeScript implementation, review, debugging, migration, or tooling.
- `rust`: Rust or Cargo/toolchain work.
- `tauri`: Tauri desktop app work.
- `content-research-writer`: research-backed writing and editorial review.
- `find-skills`: discovering or installing additional skills.
- `headless-browser`: Playwright/Bun headless browser inspection (`~/.config/claude/skills/headless-browser/scripts/browse.ts`).
- `cheat-sheets`: fetching developer cheat sheets from cheat-sheets.org into `~/.cache/cheat-sheets`.
- `ui-climb`: hill-climbing web UI design with screenshot gates and Gemini 4 Neon judge council (`bun ~/.config/claude/factory/cli.js ui`).
- `diff-review`: structured git diff review returning typed JSON findings.
- `full-stop`: finishing a change while holding its PR as a draft for owner merge when asked for "full stop".
- `work-stages`: structured stages (`explore`, `research`, `design`, `plan`, `build`, `verify`) for non-trivial tasks.

When both `frontend-ui` and a language skill apply, load `frontend-ui` first.

## Work Board (`agent-board`)
- The `board` MCP server (and `~/.cargo/bin/board` CLI) connects to the shared work board at `https://sai.tail183c69.ts.net`.
- When working in a repository that has a board, check `board status` / board MCP tools; setup registry is in `~/.config/setups.toml` for `board feedback --about <id>`.

## Storage, Remote Hosts & Vault
- Shared storage across machines (`air`, `pro`, `sai`, `svps`, `cloud`) is managed with `storagectl` (`storagectl dests`, `put`, `get`, `ls`, `run --on sai|pro`). Docs: `~/.config/claude/reference/storage.md` and `~/Documents/vps/docs/storage/README.md`.
- Remote VPS hosts reachable via SSH (`~/.ssh/config.d/vps.conf`): `sai` (agent-board server, storage pool, CI runners, Supabase) and `svps` (HashiCorp Vault, Dokploy, storage pool).
- Vault operator access uses the client cert in `~/.local/share/vps-infra/secrets/vault-operator/` over SSH forward to `svps` (see `~/Documents/vps/docs/vault.md#operator-access`).

## Runtime & Desktop Tools
- Hooks enforce `uv run` for Python and `bun` / `bunx` / `vp` for JS/TS (`node` is allowed only in repos listed in `~/.config/claude/hooks/node-repos.json`).
- Headless Gemini 4 Neon calls (for factory, skill reviews, UI judges) reuse T3's Antigravity OAuth login via `~/.local/bin/agy-run`.
- The `desktop` MCP server provides macOS screenshots, mouse, and keyboard control (with per-app approval and sensitive-app blocks; see `~/.config/claude/marketplace/computer-use/README.md`).
