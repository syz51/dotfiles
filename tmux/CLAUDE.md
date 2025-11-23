# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Personal tmux configuration using TPM (Tmux Plugin Manager) with Catppuccin theme.

## Structure

- `tmux.conf`: Main configuration file
- `plugins/`: Plugin directory managed by TPM
  - `tpm/`: Tmux Plugin Manager
  - `tmux-sensible/`: Sensible tmux defaults
  - `catppuccin/tmux/`: Catppuccin theme plugin (manually installed)

## Configuration Management

### Reload tmux config

```bash
tmux source ~/.config/tmux/tmux.conf
```

### Plugin management (TPM)

```bash
# Install plugins (inside tmux): prefix + I
# Update plugins (inside tmux): prefix + U
# Uninstall plugins (inside tmux): prefix + alt + u
```

### Catppuccin theme

- Manually installed at `~/.config/tmux/plugins/catppuccin/tmux/`
- Loaded directly via `run ~/.config/tmux/plugins/catppuccin/tmux/catppuccin.tmux`
- Current flavor: `frappe`
- Available flavors: `latte`, `frappe`, `macchiato`, `mocha`

### Status modules

Available status modules in `plugins/catppuccin/tmux/status/`:

- application, battery, clima, cpu, date_time, directory, gitmux, host, kube, load, pomodoro_plus, session, uptime, user, weather

To add status modules, use format:

```bash
set -g status-right "#{E:@catppuccin_status_application}"
set -ag status-right "#{E:@catppuccin_status_cpu}"
```

## Architecture

- TPM manages plugins listed in `tmux.conf` via `set -g @plugin` directives
- Catppuccin is run manually (not via TPM) to avoid naming conflicts
- Theme files are sourced in order: options → main theme → status modules
- Status line is customized by setting `status-left` and `status-right` with module variables

## Key configuration details

- Mouse enabled
- Prefix: `^b` (Ctrl+b)
- Status position: top
- 256-color support with RGB enabled
- Window status style: rounded
