# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Personal dotfiles/configuration directory (`~/.config`) containing configurations for:

- **nvim**: LazyVim-based Neovim setup
- **tmux**: TPM-managed tmux with Catppuccin theme
- **kitty**: Terminal emulator config
- **yazi**: File manager with zoxide integration
- **gh**: GitHub CLI configuration
- **helix**: Text editor config

Each major tool has its own CLAUDE.md with detailed guidance:

- `nvim/CLAUDE.md`: LazyVim architecture, plugin structure, language support
- `tmux/CLAUDE.md`: TPM plugin management, Catppuccin theming, status modules

## Architecture

Standard XDG Base Directory layout. Each tool directory is self-contained with its own config files.

### Neovim (nvim/)

- LazyVim-based config using lazy.nvim plugin manager
- Entry: `init.lua` → `lua/config/lazy.lua` bootstraps lazy.nvim
- Plugins auto-loaded from `lua/plugins/*.lua`
- Language support: Python (.venv via venv-selector), JS/TS (pnpm), Markdown
- LSP/tooling: Mason, lspconfig, conform (formatters), nvim-lint (linters)

### Tmux (tmux/)

- Main config: `tmux.conf`
- Plugin manager: TPM (Tmux Plugin Manager) at `plugins/tpm/`
- Theme: Catppuccin Frappe (manually installed, not via TPM)
- Plugins: tmux-sensible, vim-tmux-navigator, tmux-yank, tmux-sessionx

### Kitty (kitty/)

- Main config: `kitty.conf`
- Theme: Catppuccin Frappe via `current-theme.conf`
- Font: JetBrainsMono Nerd Font, 16pt
- Editor: `/usr/local/bin/nvim`
- Custom keybind: `cmd+l` sends `clear\r`

### Yazi (yazi/)

- Main config: `yazi.toml`
- Init script: `init.lua` (sets up zoxide plugin)
- Theme: `theme.toml` (Catppuccin Frappe)
- File openers: VS Code (edit), macOS default (open), Finder reveal

### GitHub CLI (gh/)

- Config: `gh/config.yml`
- Git protocol: HTTPS
- Alias: `co` → `pr checkout`

## Common Tasks

### Reload configs

```bash
# tmux
tmux source ~/.config/tmux/tmux.conf

# kitty (inside kitty)
# Changes auto-reload on save

# nvim
# Restart nvim or :source $MYVIMRC
```

### Plugin management

**Tmux (inside tmux session):**

```bash
# Install: prefix + I
# Update: prefix + U
# Uninstall: prefix + alt + u
```

**Neovim:**

```bash
# Open lazy.nvim UI
nvim → :Lazy

# Update all plugins
:Lazy update

# Install new plugins (auto-installs on startup if added to lua/plugins/)
```

**Mason (Neovim LSP/tools):**

```bash
# Open Mason UI
:Mason

# Tools auto-install via ensure_installed in lua/plugins/mason.lua
```

## Platform Notes

- **macOS**: Primary platform. kitty uses macOS-specific keybinds and window settings
- **Windows**: nvim/lua/config/options.lua has pwsh shell config with UTF8 encoding

## Theme

All tools use **Catppuccin Frappe** for consistency:

- nvim: via theme.lua plugin spec
- tmux: manually installed at plugins/catppuccin/tmux/
- kitty: current-theme.conf
- yazi: theme.toml

## File Locations

Config files use standard locations:

- Main configs in tool root: `tmux/tmux.conf`, `kitty/kitty.conf`, `yazi/yazi.toml`
- Neovim uses lua/: `lua/config/`, `lua/plugins/`
- Plugins/extensions: `tmux/plugins/`, lazy-lock tracked in `nvim/lazy-lock.json`
