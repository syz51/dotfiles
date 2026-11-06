# Shared interactive zsh setup; source it where .zshrc used eval "$(atuin init zsh)".
source "${${(%):-%N}:A:h}/cache.zsh"

# Drop repeated PATH and fpath entries. The first occurrence wins, as in lookup.
typeset -U path fpath

# Atuin's init script is static for a given binary, configuration and ATUIN_*
# settings; the variables excluded here are ones the script itself maintains.
if _shell_cache \
  -f "${ATUIN_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/atuin}/config.toml" \
  -e 'ATUIN_*' -x ATUIN_SESSION -x ATUIN_SHLVL -x ATUIN_HISTORY_ID \
  -x ATUIN_TMUX_POPUP -x ATUIN_TMUX_POPUP_WIDTH -x ATUIN_TMUX_POPUP_HEIGHT \
  -x ATUIN_PTY_PROXY_ACTIVE \
  atuin-init.zsh -- atuin init zsh; then
  source "$REPLY"
else
  eval "$REPLY"
fi
