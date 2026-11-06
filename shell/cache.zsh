# Cache the static output of shell initialization commands.
#
#   _shell_cache [-f FILE]... [-e PATTERN]... [-x NAME]... NAME -- COMMAND [ARG]...
#
# Returns 0 with REPLY set to a private cache file holding COMMAND's output. The
# cache is regenerated when the resolved executable, the ARGs, the metadata of any
# FILE (or whether it exists), or the exported variables whose names match a
# PATTERN, other than the NAMEs given with -x, change. Without a usable cache it
# returns 1 with REPLY set to freshly generated output, or empty when generation
# failed. Callers source or eval REPLY themselves, at top level, so the output's
# options and variables apply exactly as with eval "$(COMMAND)".
_shell_cache_live() {
  print -u2 -- "shell cache: cache unavailable; generating ${1:t} directly"
  REPLY=$("$@") || REPLY=
  return 1
}

_shell_cache() {
  emulate -L zsh
  local name executable resolved item cache_dir cache_file signature cached_signature tmp code
  local -a files patterns excludes
  local -aU names
  local -A metadata
  REPLY=
  while [[ $1 == -[fex] ]] && (( $# >= 2 )); do
    case $1 in
      (-f) files+=("$2") ;;
      (-e) patterns+=("$2") ;;
      (-x) excludes+=("$2") ;;
    esac
    shift 2
  done
  name=$1
  [[ $2 == -- ]] || { print -u2 -- "shell cache: usage: _shell_cache [options] NAME -- COMMAND"; return 1 }
  shift 2
  if [[ $1 == */* ]]; then
    [[ -x $1 ]] && executable=$1
  else
    executable=${commands[$1]}
  fi
  if [[ -z $executable ]]; then
    print -u2 -- "shell cache: ${1:t} is unavailable"
    return 1
  fi
  shift

  resolved=${executable:A}
  # Load only zstat: the module's stat builtin would shadow /usr/bin/stat.
  zmodload -F zsh/stat b:zstat 2>/dev/null || { _shell_cache_live "$executable" "$@"; return }
  zstat -H metadata -- "$resolved" 2>/dev/null || { _shell_cache_live "$executable" "$@"; return }
  signature="# shell-cache $name $executable $resolved $metadata[device] $metadata[inode] $metadata[size] $metadata[mtime] $metadata[ctime]"
  for item in "$@"; do
    signature+=" arg:${(qqqq)item}"
  done
  for item in "${files[@]}"; do
    if zstat -H metadata -- "$item" 2>/dev/null; then
      signature+=" file:${(qqqq)item}:$metadata[device]:$metadata[inode]:$metadata[size]:$metadata[mtime]:$metadata[ctime]"
    else
      signature+=" file:${(qqqq)item}:missing"
    fi
  done
  for item in "${patterns[@]}"; do
    names+=(${(k)parameters[(I)$~item]})
  done
  for item in ${(o)names:|excludes}; do
    [[ ${parameters[$item]} == *export* ]] && signature+=" env:$item=${(qqqq)${(P)item}}"
  done

  cache_dir=${XDG_CACHE_HOME:-$HOME/.cache}/shell-cache
  if [[ ! -e $cache_dir && ! -L $cache_dir ]]; then
    (umask 077; command mkdir -p -m 700 -- "$cache_dir") 2>/dev/null || { _shell_cache_live "$executable" "$@"; return }
  fi
  zstat -H metadata -- "$cache_dir" 2>/dev/null || { _shell_cache_live "$executable" "$@"; return }
  if [[ -L $cache_dir || ! -d $cache_dir ]] || (( metadata[uid] != EUID || (metadata[mode] & 8#77) != 0 )); then
    print -u2 -- "shell cache: refusing insecure cache directory: $cache_dir"
    _shell_cache_live "$executable" "$@"
    return
  fi
  cache_file=$cache_dir/$name
  if [[ -e $cache_file || -L $cache_file ]]; then
    zstat -H metadata -- "$cache_file" 2>/dev/null || { _shell_cache_live "$executable" "$@"; return }
    if [[ -L $cache_file || ! -f $cache_file ]] || (( metadata[uid] != EUID || (metadata[mode] & 8#77) != 0 )); then
      print -u2 -- "shell cache: refusing insecure cache file: $cache_file"
      _shell_cache_live "$executable" "$@"
      return
    fi
    # An empty or truncated file has no signature line, so it is regenerated.
    IFS= read -r cached_signature < "$cache_file" || cached_signature=
  fi
  if [[ $cached_signature != "$signature" ]]; then
    if ! code=$("$executable" "$@"); then
      print -u2 -- "shell cache: $name generation failed; retaining any previous cache"
      [[ -f $cache_file ]] && { REPLY=$cache_file; return 0 }
      return 1
    fi
    # mktemp creates a private file. Never replace a working cache on failure.
    tmp=$(command mktemp "$cache_dir/.$name.XXXXXXXX") || { REPLY=$code; return 1 }
    if ! { print -r -- "$signature"; print -r -- "$code"; } > "$tmp"; then
      command rm -f -- "$tmp"
      print -u2 -- "shell cache: $name cache update failed; using generated output directly"
      REPLY=$code
      return 1
    fi
    if ! /bin/zsh -n "$tmp"; then
      command rm -f -- "$tmp"
      print -u2 -- "shell cache: $name generated invalid syntax; retaining any previous cache"
      [[ -f $cache_file ]] && { REPLY=$cache_file; return 0 }
      return 1
    fi
    if ! command mv -f -- "$tmp" "$cache_file"; then
      command rm -f -- "$tmp"
      print -u2 -- "shell cache: $name cache update failed; using generated output directly"
      REPLY=$code
      return 1
    fi
  fi
  REPLY=$cache_file
}
