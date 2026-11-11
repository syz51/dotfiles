# Shared interactive zsh setup; source it where .zshrc used eval "$(atuin init zsh)".
source "${${(%):-%N}:A:h}/cache.zsh"

# Drop repeated PATH and fpath entries. The first occurrence wins, as in lookup.
typeset -U path fpath

# In Claude Code's Bash tool an unmatched glob, as in `grep -r --include=*.md`, reaches
# the command as written, as in bash, instead of failing the whole command line. The
# tool's shell snapshot records the option.
# The same snapshot keeps two other interactive conveniences out of agent commands:
# EQUALS, which turns a separator such as `echo ====` into a failed command lookup
# that aborts the rest of the line, and the aliases defined so far, such as Oh My
# Zsh's `g` and `gg`, which break helper functions of the same name. Source this file
# after the plugins that define aliases. Terminals keep both.
if [[ -n $CLAUDECODE ]]; then
  setopt no_nomatch no_equals
  unalias -m '*'
fi

# Atuin's init script is static for a given binary, configuration and ATUIN_*
# settings, so it is cached; the variables excluded here are ones the script
# itself maintains. The output is sourced or evaluated at top level, as before.
if () {
  emulate -L zsh -o extended_glob
  local file text section
  local -a args
  # Watch every place Atuin may read its config from.
  for file in ${ATUIN_CONFIG_DIR:+$ATUIN_CONFIG_DIR/config.toml} \
      "${ATUIN_HOME:-$HOME/.atuin}/config.toml" \
      "${XDG_CONFIG_HOME:-$HOME/.config}/atuin/config.toml"; do
    args+=(-f "$file")
    [[ -r $file ]] || continue
    # With dotfiles enabled, init also prints aliases and variables from Atuin's
    # synced store, which the cache cannot track, so generate it live. The
    # substring test keeps the slower patterns off configs that never mention it.
    text=$'\n'$(<$file)
    [[ $text == *dotfiles* ]] || continue
    section=
    if [[ $text == *$'\n'[[:blank:]]#'[dotfiles]'* ]]; then
      section=${text#*$'\n'[[:blank:]]#'[dotfiles]'}
      section=${section%%$'\n'[[:blank:]]#'['*}
    fi
    if [[ $section == *$'\n'[[:blank:]]#enabled[[:blank:]]#=[[:blank:]]#true* ||
          $text == *$'\n'[[:blank:]]#dotfiles[[:blank:]]#(.|=[[:blank:]]#\{*)[[:blank:]]#enabled[[:blank:]]#=[[:blank:]]#true* ]]; then
      REPLY=$(atuin init zsh)
      return 1
    fi
  done
  if [[ ${ATUIN_DOTFILES__ENABLED:l} == true ]]; then
    REPLY=$(atuin init zsh)
    return 1
  fi
  _shell_cache "${args[@]}" \
    -e 'ATUIN_*' -x ATUIN_SESSION -x ATUIN_SHLVL -x ATUIN_HISTORY_ID \
    -x ATUIN_TMUX_POPUP -x ATUIN_TMUX_POPUP_WIDTH -x ATUIN_TMUX_POPUP_HEIGHT \
    -x ATUIN_PTY_PROXY_ACTIVE \
    atuin-init.zsh -- atuin init zsh
}; then
  source "$REPLY"
else
  eval "$REPLY"
fi
