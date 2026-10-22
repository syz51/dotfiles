# Shell-owned handoff: only a ZLE prompt interprets the dispatcher's private key.
# Protocol: EXPLORE1\0(open|nvim)\0absolute-path\0... (no shell source/eval).
typeset -g _EXPLORE_ROOT=${${(%):-%N}:A:h}

explore-command() {
  emulate -L zsh
  local action=$1 item command='' directory='' physical_pwd=${PWD:A}
  shift
  [[ $action == open || $action == nvim ]] && (( $# )) || return 1
  for item in "$@"; do
    [[ $item == /* && $item != *$'\n'* && -e $item ]] || return 1
    if [[ -d $item ]]; then
      (( $# == 1 )) || return 1
      directory=$item
    fi
  done
  if [[ -n $directory ]]; then
    item=$directory
    [[ $item == "$PWD"/* ]] && item=${item#"$PWD"/}
    [[ $item == "$physical_pwd"/* ]] && item=${item#"$physical_pwd"/}
    [[ $item == "$PWD" || $item == "$physical_pwd" ]] && item=.
    command="cd -- ${(q)item}"
    [[ $action == nvim ]] && command+=' && nvim'
  else
    command='nvim --'
    for item in "$@"; do
      [[ $item == "$PWD"/* ]] && item=${item#"$PWD"/}
      [[ $item == "$physical_pwd"/* ]] && item=${item#"$physical_pwd"/}
      command+=" ${(q)item}"
    done
  fi
  print -r -- "$command"
}

_explore-ready-path() {
  REPLY=${EXPLORE_RUNTIME_DIR:-${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/explore-$UID}/zle-$$
}

_explore-line-init() {
  emulate -L zsh
  local REPLY
  _explore-ready-path
  [[ -n ${TUIOS_WINDOW_ID:-${TUIOS_PANE_ID:-}} ]] || return 0
  (umask 077
   mkdir -p -- "${REPLY:h}" || exit
   [[ -O ${REPLY:h} && ! -L ${REPLY:h} && ! -L $REPLY ]] || exit
   print -r -- "${TUIOS_WINDOW_ID:-$TUIOS_PANE_ID}" >| "$REPLY")
}

_explore-line-finish() {
  emulate -L zsh
  local REPLY
  _explore-ready-path
  rm -f -- "$REPLY"
}

explore-widget() {
  emulate -L zsh
  local pick command
  local -a fields
  pick=$("$_EXPLORE_ROOT/bin/explore-popup" "$PWD") || { zle redisplay; return 0; }
  fields=("${(@0)pick}")
  [[ ${fields[1]} == EXPLORE1 && ${#fields} -ge 3 ]] || { zle redisplay; return 0; }
  # A final NUL creates an empty field on some zsh versions.
  [[ ${fields[-1]} == '' ]] && fields[-1]=()
  command=$(explore-command "${fields[@]:1}") || { zle redisplay; return 0; }
  zle push-line
  BUFFER=$command
  zle accept-line
}

if [[ -o interactive ]]; then
  autoload -Uz add-zle-hook-widget add-zsh-hook
  add-zle-hook-widget line-init _explore-line-init
  add-zle-hook-widget line-finish _explore-line-finish
  add-zsh-hook preexec _explore-line-finish
  add-zsh-hook zshexit _explore-line-finish
  zle -N explore-widget
  bindkey $'\e[99~' explore-widget
  if (( $+commands[zoxide] )); then
    eval "$(zoxide init zsh)"
  fi
fi
