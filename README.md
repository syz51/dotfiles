# Dotfiles

Personal configuration for a macOS development environment, stored in `~/.config`.
This repository tracks selected settings and scripts; many local application
directories, credentials, and runtime files are excluded by `.gitignore`.

## Contents

| Path                     | Purpose                                                                          |
| ------------------------ | -------------------------------------------------------------------------------- |
| `ghostty/`               | Ghostty settings, themes, and a TUIOS session launcher with tests.               |
| `tuios/`                 | TUIOS appearance, dock, sidebar, startup settings, and themes.                   |
| `nvim/`                  | LazyVim-based Neovim configuration, language tooling, custom scripts, and tests. |
| `mpv/`                   | Playback settings, uosc controls, thumbfast thumbnails, and bundled assets.      |
| `codex/`                 | Agent instructions, example configuration, hooks, and keybindings.               |
| `claude/`                | Claude Code instructions and settings.                                           |
| `git/ignore`             | Shared Git ignore patterns.                                                      |
| `AGENTS.md`, `CLAUDE.md` | Repository instructions for coding agents.                                       |

## Setup

Back up existing configuration before copying files into `~/.config`. Install
the applications you intend to use, then copy or symlink their directories from
this checkout. There is no installation script or complete dependency manifest.

The terminal setup assumes macOS, zsh, and Homebrew under `/opt/homebrew`.
Before using it on another account or machine, update these paths:

- `ghostty/config` invokes `/Users/roy/.config/ghostty/tuios-launcher.sh`.
- `ghostty/tuios-launcher.sh` invokes `/opt/homebrew/bin/python3` and the launcher
  under `/Users/roy/.config/ghostty/`.
- `ghostty/tuios-launcher.py` expects a TUIOS wrapper at
  `/Users/roy/.local/bin/tuios`. That wrapper is outside this repository; provide
  it locally or point the launcher at your TUIOS executable.

Neovim bootstraps lazy.nvim and installs the configured plugins on first launch,
which requires Git and network access. Language-specific features may require
additional tools; inspect `nvim/lazyvim.json` and `nvim/lua/plugins/` for the
enabled integrations.

`codex/config.example.toml` is a reference configuration. Review and adapt it
before creating a local `codex/config.toml`, which is intentionally ignored.
Review agent settings and hooks before enabling them on a new machine.

To use the shared Git ignore file, configure its location explicitly:

```sh
git config --global core.excludesFile "$HOME/.config/git/ignore"
```

## Terminal workflow

Ghostty launches TUIOS automatically. The launcher reuses the most recently active
detached session, creates a session when all existing sessions are attached, and
attempts to restore saved sessions when the daemon is stopped. A file lock
serializes session selection and attachment across simultaneous launches.

Ghostty and TUIOS use Catppuccin Frappe. TUIOS starts tiled in terminal mode, with
the dock at the top and the sidebar on the left. The leader key is `Ctrl+Space`;
follow it with `s` for the session switcher or uppercase `S` for scrollback.

## Development checks

Run checks relevant to the files you change. From the repository root:

```sh
# Launcher tests; their fake TUIOS executable also requires Homebrew Python.
uv run --python /opt/homebrew/bin/python3 ghostty/test-tuios-launcher.py

# Bun package-version parsing tests.
bun test nvim/tests/bun-outdated.test.js
```

Neovim tests include invocation instructions in their source files. For example:

```sh
cd nvim
nvim --headless -u NONE -i NONE -l tests/ghostty-docs.lua
```

Some integration tests require additional applications, such as Tectonic for
LaTeX compilation. After testing, remove temporary files, session transcripts,
and directories created by the tests.

## Local state

Keep credentials, session data, caches, and machine-specific settings out of
commits. Review `git status` and staged changes before committing; `.gitignore`
does not protect files that Git already tracks.
