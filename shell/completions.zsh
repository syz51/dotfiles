# uv and uvx completions, generated once per executable and cached. Each is
# registered as an autoloaded function, so zsh reads its large definition on the
# first completion rather than at every startup. Requires compinit (compdef).
source "${${(%):-%N}:A:h}/cache.zsh"

if _shell_cache _uv -- uv generate-shell-completion zsh; then
  autoload -Uz -- "$REPLY" && compdef _uv uv
else
  eval "$REPLY"
fi
if _shell_cache _uvx -- uvx --generate-shell-completion zsh; then
  autoload -Uz -- "$REPLY" && compdef _uvx uvx
else
  eval "$REPLY"
fi
