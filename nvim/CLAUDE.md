# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

LazyVim-based Neovim config using lazy.nvim plugin manager. Plugin specs in `lua/plugins/*.lua` auto-loaded by lazy.nvim. Config in `lua/config/` (options, keymaps, autocmds).

Entry: `init.lua` → `lua/config/lazy.lua` bootstraps lazy.nvim & loads plugin specs

## Plugin Structure

Each file in `lua/plugins/` returns plugin spec(s):

- Language-specific: `python.lua` (venv-selector), `js.lua` (package-info), `markdown.lua`
- LSP/tooling: `lsp.lua` (lspconfig servers), `mason.lua` (tool installer), `conform.lua` (formatters), `lint.lua` (linters)
- Editor: `treesitter.lua`, `theme.lua`, `tmux.lua`

Mason ensures tools installed via `ensure_installed` list in `mason.lua`

## Language Support

- **Python**: `.venv` venv via venv-selector (`<leader>cvs` select, `<leader>cvc` cached)
- **JS/TS**: pnpm package manager, package-info shows outdated deps (`<leader>ns` force refresh)
- **Markdown**: prettier + markdownlint-cli2 + markdown-toc (auto-formats on save if `

<!-- toc -->

- [Platform Support](#platform-support)
- [Custom Keymaps](#custom-keymaps)

<!-- tocstop -->

` comment exists).

nvim-lint linters by filetype in `lint.lua`. Markdownlint diagnostics trigger markdownlint-cli2 formatter.

## Platform Support

Windows: uses pwsh with UTF8 encoding, custom shell config in `options.lua`

## Custom Keymaps

- `<C-a>`: select all
- `<C-s>`: save (all modes)
