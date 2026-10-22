#!/bin/sh
# Build the TUIOS fork (syz51/tuios, branch feat/popup-dim) and install it for
# tuios/bin/tuios. Run it again to update. Restart the daemon afterwards with
# `tuios kill-server` and open a new Ghostty window.
set -eu

repo=https://github.com/syz51/tuios.git
branch=feat/popup-dim
src="${XDG_CACHE_HOME:-$HOME/.cache}/tuios-fork"
dest="$HOME/.local/opt/tuios-fork"
config="${XDG_CONFIG_HOME:-$HOME/.config}"

command -v git >/dev/null || { echo "install-fork: git is required" >&2; exit 1; }
if ! command -v go >/dev/null; then
  command -v brew >/dev/null || { echo "install-fork: Go is required (brew install go)" >&2; exit 1; }
  brew install go
fi

if [ -d "$src/.git" ]; then
  git -C "$src" fetch --quiet origin "$branch"
  git -C "$src" checkout --quiet --detach FETCH_HEAD
else
  git clone --quiet --branch "$branch" "$repo" "$src"
fi

rev=$(git -C "$src" rev-parse HEAD)
short=$(printf '%.12s' "$rev")
mkdir -p "$dest"
(
  cd "$src"
  go build -trimpath \
    -ldflags "-s -w -X main.version=dev+$short -X main.commit=$rev -X main.builtBy=install-fork -X main.date=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    -o "$dest/tuios.new" ./cmd/tuios
)
mv -f "$dest/tuios.new" "$dest/tuios"

# Point ~/.local/bin/tuios, which the Ghostty launcher runs, at the wrapper.
mkdir -p "$HOME/.local/bin"
link="$HOME/.local/bin/tuios"
wrapper="$config/tuios/bin/tuios"
if [ -e "$link" ] && [ ! -L "$link" ]; then
  mv "$link" "$link.bak"
  echo "install-fork: kept the previous $link as $link.bak"
fi
ln -sfn "$wrapper" "$link"

"$link" --version | head -n 1
echo "install-fork: restart with 'tuios kill-server', then open a new Ghostty window."
