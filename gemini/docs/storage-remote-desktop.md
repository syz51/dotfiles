# Storage, Remote Hosts, Vault, Desktop & Notebook Reference

These rules are part of the global instructions (`~/.gemini/config/GEMINI.md`, Storage, Remote Hosts, Vault & Desktop section) and have the same force. Read this file (and `~/.config/local/fleet-and-storage.md` when present) before using `storagectl`, running Pro T3 threads or cross-Mac reads, SSHing to remote hosts or Vault, or using the `desktop` or `gemini-notebook` MCP servers.

## Shared Storage (`storagectl`)

- Keep shared/cross-machine files on shared storage via `storagectl`, not only locally (`dests`, `put`, `get`, `ls`, `find`, `fetch <url> <dest>:<path>/`, `run --to <dest>:<path> -- <command>`). Check `~/.config/local/fleet-and-storage.md` (if present) for your private destination catalog, quotas, and host-specific rules.
- Destinations: `cloud` (durable object storage) when data must not depend on a Mac being awake; `pro` for large data (offline while asleep); `air` only for active work, never archives. Kept finished work goes to `cloud:archive/<repo>/` (large data to `pro`), never `air`. Project non-disclosure rules against external services do not forbid these (user's own storage); machine/third-party restrictions still apply, and credentials stay out. Check `~/.config/local/fleet-and-storage.md` (when present) for remote VPS pool limits and root-shell rules.
- Offload commands (remote VPS pools: large downloads/cloud transfers; `pro`: large data/CPU) via `storagectl run --on <machine> --to <dest>:<path> [--stage <path>] -- <cmd>` (detached `storage-runner`, uploads `$STORAGE_OUT` + logs to `--to` even on failure; track via `status|logs|cancel <id>`, `jobs --on <machine>`; stage <=1 GiB; never run workloads as root on remote VPS hosts; check `~/.config/local/fleet-and-storage.md` for per-host limits). Report friction via Feedback `about` `storage` (machine, command, error, workaround).

## Pro T3 Delegation & Cross-Mac Reads

- Run a Pro T3 thread from the Air (while Pro is awake): check `t3_environment_links`, call `delegate_task` with Pro's `environmentId` on `antigravity` (`gemini-4-neon`, no `isolation: "worktree"`), and pass data via `storagectl`.
- Cross-Mac thread reads use `t3_thread_list`/`t3_thread_read` with `environmentId` (Air→Pro `full-access`, Pro→Air `read-only`).
- Check Pro's `~/.config` commit read-only via `git -C ~/.config log -1` over SSH (Pro host in `~/.ssh/config.d/`) or in a Pro T3 thread (`storagectl run --on pro` runs as `storage-runner` and cannot read it). Host-specific providers and reach live in `~/.config/local/fleet-and-storage.md` when present.

## Remote Hosts & Vault

- Remote VPS and peer Mac SSH host aliases live in `~/.ssh/config.d/` (never hardcode hostnames or IPs in public dotfiles).
- For host roles, Vault operator access, and private KV paths, read `~/.config/local/fleet-and-storage.md` (if present).

## Desktop MCP

- Desktop (`desktop` MCP server, lazy-loaded, `~/.config/claude/marketplace/computer-use/server/desktop.js`): call `request_access` (auto-approved except `DIALOG_APPS` such as terminals, agent apps, editors, and System Settings which prompt, and finance/health/gov/password apps which refuse), respect the single-session lock, and `release` when done (`~/.config/claude/marketplace/computer-use/README.md`).

## Gemini Notebook MCP & `gnotebook`

- Gemini Notebook (`gemini-notebook` MCP server, lazy-loaded, Google ADC): use MCP tools for metadata or single text/URL adds; use `~/.local/bin/gnotebook` for file/dir/code bundling, `.md` fallback, secret filtering, rate pacing, and dedupe (no delete API yet).
- `~/.local/bin/gnotebook-monitor` tracks public API/MCP/roadmap changes. Refresh expired ADC per `~/.config/gemini/docs/gemini-notebook-mcp.md`.
