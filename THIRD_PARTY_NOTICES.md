# Third-party notices

The root [MIT license](LICENSE) covers original contributions by SUN Yizhe.
Third-party code and assets retain their upstream terms. License copies are
linked below so they accompany this repository without duplicating their text here.

## mpv assets

`mpv/scripts/uosc/` and `mpv/fonts/` come from
[uosc 5.13.0](https://github.com/tomasklaen/uosc/tree/5.13.0), under
[LGPL-2.1](mpv/LICENSES/uosc-LGPL-2.1.txt). The main script, both fonts, and all
three ziggy binaries match the official
[release archive](https://github.com/tomasklaen/uosc/releases/download/5.13.0/uosc.zip)
byte for byte. Corresponding ziggy source and build scripts are in that tagged
repository's `src/ziggy/` and `tools/`; the binaries were not rebuilt locally.

| Bundled font | Matching upstream content | License |
| --- | --- | --- |
| `mpv/fonts/uosc_icons.otf` | [Google Material Icons Round at `1c57576`](https://github.com/google/material-design-icons/blob/1c575764826fa5752ddc2bdc6b31ef7cc3233371/font/MaterialIconsRound-Regular.otf), byte-identical | [Apache-2.0](mpv/LICENSES/material-icons-Apache-2.0.txt) |
| `mpv/fonts/uosc_textures.ttf` | [uosc at `cabe84d`](https://github.com/tomasklaen/uosc/blob/cabe84daf9f974b7cd9cb6f4bbb57f1b0c43e93b/fonts/uosc_textures.ttf), byte-identical | [LGPL-2.1](mpv/LICENSES/uosc-LGPL-2.1.txt) |

The icon font retains its embedded `Copyright 2019 Google LLC. All Rights Reserved.`
notice. Its exact bytes first appeared in uosc at
[`386953b`](https://github.com/tomasklaen/uosc/commit/386953b78e8f4c021faa7aed2708a3dcb2cc8dc1).

The bundled ziggy executables embed these components, verified with `go version -m`:

| Component | Version | License |
| --- | --- | --- |
| Go | 1.23.1 | [BSD-3-Clause](mpv/LICENSES/golang-BSD-3-Clause.txt) |
| `github.com/atotto/clipboard` | v0.1.4 | [BSD-3-Clause](mpv/LICENSES/clipboard-BSD-3-Clause.txt) |
| `github.com/pkg/browser` | v0.0.0-20240102092130-5ac0b6a4141c | [BSD-2-Clause](mpv/LICENSES/browser-BSD-2-Clause.txt) |
| `golang.org/x/sys` (Windows binary) | v0.28.0 | [BSD-3-Clause](mpv/LICENSES/x-sys-BSD-3-Clause.txt) |

`mpv/scripts/thumbfast.lua` matches
[po5/thumbfast at `9deb073`](https://github.com/po5/thumbfast/blob/9deb0733c4e36938cf90e42ddfb7a19a8b2f4641/thumbfast.lua)
after formatting and whitespace normalization; it is not byte-identical. It
retains its MPL-2.0 source notice, with the complete
[license text](mpv/LICENSES/thumbfast-MPL-2.0.txt) included.

## Television patch

`explore/patches/television-0.15.9-initial-batch.patch` includes context and
adaptations from [Television 0.15.9](https://github.com/alexpasmantier/television/tree/0.15.9).
Its upstream copyright and [MIT license](LICENSES/television-MIT.txt) are included.
The installer downloads upstream source; that source is not otherwise vendored here.

## Neovim configuration

The bootstrap and default configuration are adapted from the
[LazyVim starter](https://github.com/LazyVim/starter). The initial local
`nvim/lua/config/lazy.lua` matches the
[starter file at `cb6349c`](https://github.com/LazyVim/starter/blob/cb6349c8ae922d1c5745574f4d17b44f2731d451/lua/config/lazy.lua)
except for a commented-out `tutor` entry; the current file has later customizations.
The starter and [lazy.nvim](https://github.com/folke/lazy.nvim) share the
[Apache-2.0 license text](LICENSES/Apache-2.0.txt), included once. Downloaded
Neovim plugins retain their own licenses and are not vendored here.

Matching revisions identify upstream content, not necessarily the exact commit
used when copying it: the same file can be present in multiple repository commits.
