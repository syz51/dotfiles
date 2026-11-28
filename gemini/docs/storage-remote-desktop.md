# Storage, Remote Hosts, Vault, Desktop & Notebook Reference

These rules are part of the global instructions (`~/.gemini/config/GEMINI.md`, Storage, Remote Hosts, Vault & Desktop section) and have the same force. Read this file (and `~/.config/local/fleet-and-storage.md` when present) before using `storagectl`, running Pro T3 threads or cross-Mac reads, SSHing to remote hosts or Vault, or using the `desktop` or `gemini-notebook` MCP servers.

## Shared Storage (`storagectl`)

- Keep shared/cross-machine files on shared storage via `storagectl`, not only locally (`dests`, `put`, `get`, `ls`, `find`, `fetch <url> <dest>:<path>/`, `run --to <dest>:<path> -- <command>`). Check `~/.config/local/fleet-and-storage.md` (if present) for your private destination catalog, quotas, and host-specific rules.
- Egress-free routing by default: `cloud:` (`vps-storage-shared`, COS Tokyo) charges paid public outbound egress from Macs (¥0.46-0.75/GB), whereas Tailscale pools (`pro:`, `sai:`, `svps:`) are ¥0/GB and `sai` reaches COS Tokyo over Tencent's free internal endpoint (`169.254.0.47`, ¥0/GB).
  - **Active/temp/cross-Mac files → free Tailscale first:** Use `pro:` (large data, offline while asleep) or `sai:` (12 GiB, always up) for Mac-to-Mac transfers, working datasets, and scratch/tmp staging; use `air:` only for active work in progress, never archives. Never put disposable `tmp/` prefixes into versioned `cloud:` (deleted objects remain billed for 30 days as noncurrent versions).
  - **`cloud:` is write-once, rarely-read:** Reserve `cloud:archive/<repo>/` for durable cold archives (large data still goes to `pro:`) and small always-reachable handoffs when data must not depend on a Mac being awake. Always pack multi-file archives into `.tar.zst` + manifest before uploading to `cloud:archive/<repo>/` (avoid tens of thousands of loose objects), and verify checksums locally or via `storagectl run --on sai` — never by downloading GBs back to a Mac.
  - Project non-disclosure rules against external services do not forbid these (user's own storage); machine/third-party restrictions still apply, and credentials stay out. Check `~/.config/local/fleet-and-storage.md` (when present) for remote VPS pool limits and root-shell rules.
- Offload commands (`sai` / remote VPS pools: COS-heavy bulk reads, verification, repacking over free internal `169.254.0.47`, and large downloads; `pro`: large data/CPU) via `storagectl run --on <machine> --to <dest>:<path> [--stage <path>] -- <cmd>` (e.g., `storagectl run --on sai` for `cloud:` reads/checks/repacks at ¥0/GB; detached `storage-runner`, uploads `$STORAGE_OUT` + logs to `--to` even on failure; track via `status|logs|cancel <id>`, `jobs --on <machine>`; stage <=1 GiB; never run workloads as root on remote VPS hosts; check `~/.config/local/fleet-and-storage.md` for per-host limits).
- Restic verification: Run `restic check --read-data` against Pro's local replica (`~/Library/Application Support/Sai Storage/replicas/...`, ¥0/GB) rather than against COS from a Mac; run metadata-only `restic check` against COS.
- Report friction via Feedback `about` `storage` (machine, command, error, workaround).

## Pro T3 Delegation & Cross-Mac Reads

- Run a Pro T3 thread from the Air (while Pro is awake): check `t3_environment_links`, call `delegate_task` with Pro's `environmentId` on `antigravity` (`gemini-4-neon`, no `isolation: "worktree"`), and pass data via `storagectl`.
- Cross-Mac thread reads/sends use `t3_thread_list`/`t3_thread_read`/`t3_thread_send` with `environmentId`, and cross-Mac delegation uses `delegate_task` with `target.environmentId` (both Air→Pro and Pro→Air are `full-access`).
- Check Pro's `~/.config` commit read-only via `git -C ~/.config log -1` over SSH (Pro host in `~/.ssh/config.d/`) or in a Pro T3 thread (`storagectl run --on pro` runs as `storage-runner` and cannot read it). Host-specific providers and reach live in `~/.config/local/fleet-and-storage.md` when present.

## Remote Hosts & Vault

- Remote VPS and peer Mac SSH host aliases live in `~/.ssh/config.d/` (never hardcode hostnames or IPs in public dotfiles).
- For host roles, Vault operator access, and private KV paths, read `~/.config/local/fleet-and-storage.md` (if present).

## Desktop MCP

- Desktop (`desktop` MCP server, lazy-loaded): runs `~/.local/bin/desktop mcp` (`agent-desktop` Rust client talking to `/Applications/AgentDesktop.app` `desktopd`; falls back to `~/.config/claude/marketplace/computer-use/server/desktop.js` on machines without `agent-desktop`). Machine-local credentials and fleet config live in gitignored `~/.config/agent-desktop/` (`token`, `fleet.toml`, opt-in `policy.toml`); never commit them to public dotfiles. Prefer `snapshot`/`find` (Accessibility tree `@eN` refs) + batched `act` with `focus_mode: "background"` or `"auto"`, and call `session_end` when finished (`release` on the legacy `desktop.js` fallback).
- Browser & screenshot hygiene: navigate via address-bar `@eN` refs instead of shell `open <url>` (avoids tab sprawl); if a Chromium/Electron `snapshot` returns chrome-only nodes without `webarea`, retry `snapshot` once before falling back to `screenshot`; keep multi-step `screenshot` loops out of large (`>100k`-token) threads (compact or isolate in a lean context — Antigravity offloads MCP images to disk for 2 turns/shot and retains ~1.6k image tokens/shot permanently).
- Report friction, bugs, or missing capabilities in `desktop`/`desktopd` via Feedback `about` `agent-desktop` (host, tool/command, error or latency, workaround) so triage routes improvements to the `agent-desktop` board.

## Gemini Notebook MCP & `gnotebook`

- Gemini Notebook (`gemini-notebook` MCP server, lazy-loaded, Google ADC): use MCP tools for metadata or single text/URL adds; use `~/.local/bin/gnotebook` for file/dir/code bundling, `.md` fallback, secret filtering, rate pacing, and dedupe (no delete API yet).
- `~/.local/bin/gnotebook-monitor` tracks public API/MCP/roadmap changes. Refresh expired ADC per `~/.config/gemini/docs/gemini-notebook-mcp.md`.
