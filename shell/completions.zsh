# Cache only static completion definitions; dynamic shell initialization stays live.
_shell_completion_live() {
  local executable=$1 code
  shift
  print -u2 -- "shell completions: cache unavailable; generating ${executable:t} directly"
  code=$("$executable" "$@") || return
  eval "$code"
}

_shell_cached_completion() {
  emulate -L zsh
  local name=$1 executable=${commands[$1]} resolved cache_dir cache_file signature cached_signature tmp code
  local -A metadata
  shift
  if [[ -z $executable ]]; then
    print -u2 -- "shell completions: $name is unavailable"
    return 1
  fi
  resolved=${executable:A}
  zmodload zsh/stat || { _shell_completion_live "$executable" "$@"; return; }
  zstat -H metadata -- "$resolved" || { _shell_completion_live "$executable" "$@"; return; }
  signature="# shell-completion $executable $resolved $metadata[device] $metadata[inode] $metadata[size] $metadata[mtime] $metadata[ctime]"
  cache_dir=${XDG_CACHE_HOME:-$HOME/.cache}/shell-completions
  if [[ ! -e $cache_dir && ! -L $cache_dir ]]; then
    (umask 077; command mkdir -p -m 700 -- "$cache_dir") || { _shell_completion_live "$executable" "$@"; return; }
  fi
  zstat -H metadata -- "$cache_dir" || { _shell_completion_live "$executable" "$@"; return; }
  if [[ -L $cache_dir || ! -d $cache_dir ]] || (( metadata[uid] != EUID || (metadata[mode] & 8#77) != 0 )); then
    print -u2 -- "shell completions: refusing insecure cache directory: $cache_dir"
    _shell_completion_live "$executable" "$@"
    return
  fi
  cache_file=$cache_dir/$name.zsh
  if [[ -e $cache_file || -L $cache_file ]]; then
    zstat -H metadata -- "$cache_file" || { _shell_completion_live "$executable" "$@"; return; }
    if [[ -L $cache_file || ! -f $cache_file ]] || (( metadata[uid] != EUID || (metadata[mode] & 8#77) != 0 )); then
      print -u2 -- "shell completions: refusing insecure cache file: $cache_file"
      _shell_completion_live "$executable" "$@"
      return
    fi
    IFS= read -r cached_signature < "$cache_file" || { _shell_completion_live "$executable" "$@"; return; }
  fi
  if [[ $cached_signature != $signature ]]; then
    if ! code=$("$executable" "$@"); then
      print -u2 -- "shell completions: $name generation failed; retaining any previous cache"
      [[ -f $cache_file ]] && source "$cache_file"
      return 1
    fi
    tmp=$(command mktemp "$cache_dir/.$name.XXXXXXXX") || { eval "$code"; return; }
    # mktemp creates a private file. Never replace a working cache on failure.
    if ! { print -r -- "$signature"; print -r -- "$code"; } > "$tmp"; then
      command rm -f -- "$tmp"
      print -u2 -- "shell completions: $name cache update failed; using generated definitions directly"
      eval "$code"
      return
    fi
    if ! /bin/zsh -n "$tmp"; then
      command rm -f -- "$tmp"
      print -u2 -- "shell completions: $name generated invalid syntax; retaining any previous cache"
      [[ -f $cache_file ]] && source "$cache_file"
      return 1
    fi
    if ! command mv -f -- "$tmp" "$cache_file"; then
      command rm -f -- "$tmp"
      print -u2 -- "shell completions: $name cache update failed; using generated definitions directly"
      eval "$code"
      return
    fi
  fi
  source "$cache_file" || _shell_completion_live "$executable" "$@"
}

_shell_cached_completion uv generate-shell-completion zsh
_shell_cached_completion uvx --generate-shell-completion zsh
unfunction _shell_cached_completion _shell_completion_live
