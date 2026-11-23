# Skills Catalog

Single canonical directory for global skills on every Mac (Air and Pro): **`~/.gemini/config/skills/`**.

Antigravity discovers global skills from `~/.gemini/config/skills/<name>/SKILL.md` and project-scoped skills automatically from `<repo>/.agents/skills/<name>/SKILL.md`.

## Global Skills (12 total — `~/.gemini/config/skills/`)

| Skill | Canonical Path | Source / Owner | Use When | Helper Script / Command |
| --- | --- | --- | --- | --- |
| `frontend-ui` | `~/.gemini/config/skills/frontend-ui` | `syz51/agent-skills` (`current/skills/frontend-ui`) | Building, styling, polishing, or reviewing web UI (React, Next.js, Vue, Nuxt, Vite, CSS). Load before language skills; also check `~/.config/claude/frontend-avoid.md`. | `uv run --script ~/.local/share/agent-skills/repository/scripts/read_guidance.py` |
| `typescript` | `~/.gemini/config/skills/typescript` | `syz51/agent-skills` (`current/skills/typescript`) | TypeScript implementation, review, debugging, migration, or `tsconfig`/tooling changes. | `read_guidance.py` |
| `rust` | `~/.gemini/config/skills/rust` | `syz51/agent-skills` (`current/skills/rust`) | `.rs` code, Cargo/toolchain configuration, compiler errors, linting, or Rust compatibility work. | `read_guidance.py` |
| `tauri` | `~/.gemini/config/skills/tauri` | `syz51/agent-skills` (`current/skills/tauri`) | Tauri desktop/mobile app work (frontend + Rust integration). Use alongside `frontend-ui`. | `read_guidance.py` |
| `content-research-writer` | `~/.gemini/config/skills/content-research-writer` | `syz51/agent-skills` (`current/skills/content-research-writer`) | Research-backed articles, reports, tutorials, newsletters, and editorial review. | `read_guidance.py` |
| `find-skills` | `~/.gemini/config/skills/find-skills` | `syz51/agent-skills` (`current/skills/find-skills`) | Discovering or recommending installable agent skills. | `read_guidance.py` |
| `cheat-sheets` | `~/.gemini/config/skills/cheat-sheets` | `syz51/dotfiles` (`~/.config/claude/skills/cheat-sheets`) | Quick overview of an unfamiliar/legacy tool or notation table (ASCII, LaTeX, regex, math). | `bun ~/.config/claude/skills/cheat-sheets/scripts/cheatsheets.ts` |
| `diff-review` | `~/.gemini/config/skills/diff-review` | `syz51/dotfiles` (`~/.config/claude/skills/diff-review`) | Structured read-only git diff review returning typed JSON findings (`origin/main...<SHA>`). | — |
| `full-stop` | `~/.gemini/config/skills/full-stop` | `syz51/dotfiles` (`~/.config/claude/skills/full-stop`) | Finishing work and holding its PR as a draft for the owner's merge ("full stop"). | `gh pr create --draft` |
| `headless-browser` | `~/.gemini/config/skills/headless-browser` | `syz51/dotfiles` (`~/.config/claude/skills/headless-browser`) | Headless Chromium screenshots, scripted clicks/typing, and console/network error checks. | `bun ~/.config/claude/skills/headless-browser/scripts/browse.ts` |
| `ui-climb` | `~/.gemini/config/skills/ui-climb` | `syz51/dotfiles` (`~/.config/claude/skills/ui-climb`) | Hill-climbing a web UI against reference products with a Gemini 4 Neon judge council (`ui-climb.json`). | `bun ~/.config/claude/factory/cli.js ui` |
| `work-stages` | `~/.gemini/config/skills/work-stages` | `syz51/dotfiles` (`~/.config/claude/skills/work-stages`) | Structuring non-trivial work into stages (`explore`, `research`, `design`, `plan`, `build`, `verify`) with clear exit evidence and board records. | — |

## Project-Scoped Skills (auto-discovered inside their workspaces)

| Skill | Workspace Path | Repository | Purpose |
| --- | --- | --- | --- |
| `research-factory` | `.agents/skills/research-factory` | `guwen`, `masters` (source: `syz51/research-factory`) | Research archive session workflow (`lab brief`, `papers`, `claimcheck`, `lab check --new-only`). |
| `solid-2-site` | `.agents/skills/solid-2-site` | `syz51/riemann` | Solid 2.0 site conventions and checks for the Riemann repo. |
| `contribution-triage` | `.agents/skills/contribution-triage` | `syz51/t3code` | Triaging external issues and PRs in T3 Code. |
| `test-t3-app` | `.agents/skills/test-t3-app` | `syz51/t3code` | Integrated web/desktop testing in T3 Code using the `Replay (dev)` provider. |
| `test-t3-mobile` | `.agents/skills/test-t3-mobile` | `syz51/t3code` | Integrated mobile testing in T3 Code using cached native dev clients (`vp run mobile:install`). |
| `tuios` | `skills/tuios/SKILL.md` (embedded via `tuios --skill`) | `syz51/tuios` | Driving panes, sessions, fleets, and MCP inside a running TUIOS daemon. |

## Optional / Standalone Skills (not globally exposed)

| Skill | Location | Notes |
| --- | --- | --- |
| `design-taste-frontend` | `~/Documents/ChatGPT/taste-skill/skills/taste-skill/SKILL.md` (Air only) | Standalone clone of `Leonxlnx/taste-skill` (tasteskill v2). Kept out of `~/.gemini/config/skills/` intentionally so it does not compete with `frontend-ui`; read directly by path when requested. |

## Built-in Antigravity Skills

Bundled by Antigravity itself (mounted automatically, not stored in `~/.gemini/config/skills/`):

- `agy-customizations`: Antigravity rules, skills, plugins, hooks, and MCP customization reference.
- `antigravity-guide`: Antigravity CLI (`agy`), IDE, SDK, and configuration guide.
- `run-workflow`: Dynamic Python multi-agent workflow orchestration via `run_workflow`.
- `swarm_pane` / `swarm_monitor`: Swarm coordinator/monitor skills (only for active `/swarm` sessions).

## Exposure & Sync Health

- **Dotfiles skills (6)** and `~/.gemini/config/{GEMINI.md,SKILLS_CATALOG.md,hooks.json,mcp_config.json}` are verified every 30 minutes by `config-sync` (`~/.config/config-sync/config_sync.py check`).
- **Managed skills (6)** are deployed atomically to `~/.local/share/agent-skills/current/skills/` by the hourly `com.syz51.agent-skills.sync` LaunchAgent on each Mac.
- To repair or bootstrap all 12 global symlinks on a Mac:

```sh
mkdir -p ~/.gemini/config/skills
for s in GEMINI.md SKILLS_CATALOG.md hooks.json mcp_config.json; do
  ln -sfn ~/.config/gemini/$s ~/.gemini/config/$s
done
for s in cheat-sheets diff-review full-stop headless-browser ui-climb work-stages; do
  ln -sfn ~/.config/claude/skills/$s ~/.gemini/config/skills/$s
done
for s in content-research-writer find-skills frontend-ui rust tauri typescript; do
  ln -sfn ~/.local/share/agent-skills/current/skills/$s ~/.gemini/config/skills/$s
done
```
