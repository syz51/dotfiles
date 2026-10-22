#!/bin/sh
# Build the pinned Explore-only Television; never replace the system tv.
set -eu
version=0.15.9
sha256=5f46cbe7b14e1d6e3958f436b1d6ed8af86e9914d7d2aee5a9379e8e1772072d
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dest=${EXPLORE_TELEVISION_DEST:-$HOME/.local/opt/explore-television}
build_root=${EXPLORE_TELEVISION_BUILD_ROOT:-${TMPDIR:-/tmp}}
for dependency in curl tar shasum patch cargo rustc; do
  command -v "$dependency" >/dev/null || { echo "install-television: $dependency is required" >&2; exit 1; }
done
# Pin selection to an already installed toolchain, avoiding upstream's automatic
# rust-toolchain.toml download. Plain cargo/rustc installations ignore this env.
if command -v rustup >/dev/null; then
  RUSTUP_TOOLCHAIN=${EXPLORE_TELEVISION_TOOLCHAIN:-${RUSTUP_TOOLCHAIN:-stable}}
  export RUSTUP_TOOLCHAIN
  rustup which --toolchain "$RUSTUP_TOOLCHAIN" cargo >/dev/null
  rustup which --toolchain "$RUSTUP_TOOLCHAIN" rustc >/dev/null
fi
work=$(mktemp -d "$build_root/explore-television.XXXXXXXX")
pending=
cleanup() {
  [ -z "$pending" ] || rm -f -- "$pending"
  rm -rf -- "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
curl -fL --retry 3 "https://codeload.github.com/alexpasmantier/television/tar.gz/refs/tags/$version" -o "$work/source.tar.gz"
printf '%s  %s\n' "$sha256" "$work/source.tar.gz" | shasum -a 256 -c -
tar -xzf "$work/source.tar.gz" -C "$work"
source_dir=$work/television-$version
patch --batch --fuzz=0 -d "$source_dir" -p1 < "$root/patches/television-0.15.9-initial-batch.patch"
export CARGO_TARGET_DIR=$work/target TMPDIR=$work
(
  cd "$source_dir"
  cargo build --locked --release --bin tv
)
mkdir -p "$dest"
pending=$(mktemp "$dest/.tv.XXXXXXXX")
cp "$CARGO_TARGET_DIR/release/tv" "$pending"
chmod 755 "$pending"
"$pending" --version
mv -f -- "$pending" "$dest/tv"
pending=
printf 'Installed Explore Television %s at %s/tv\n' "$version" "$dest"
