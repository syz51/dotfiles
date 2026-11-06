#!/usr/bin/env python3
"""Review shell startup changes by default; use --apply to install with backups."""

import argparse
import os
from pathlib import Path
import stat
import subprocess
import tempfile


def replace_exact(text: str, old: str, new: str, label: str) -> str:
    if text.count(old) == 1 and (not new or new not in text):
        return text.replace(old, new, 1)
    if new and text.count(new) == 1 and old not in text:
        return text
    raise ValueError(f"Unexpected or ambiguous {label}; refusing configuration drift")


OMZ_SOURCE = "source $ZSH/oh-my-zsh.sh\n"
COMPLETIONS = 'source "$HOME/.config/shell/completions.zsh"\n'
UV_EVALS = 'eval "$(uv generate-shell-completion zsh)"\neval "$(uvx --generate-shell-completion zsh)"\n'
FNM_OLD = "fnm env --use-on-cd --version-file-strategy=recursive"
FNM_NEW = "fnm env --shell zsh --use-on-cd --version-file-strategy=recursive"


def move_compinit(text: str) -> str:
    """Run compinit once, through Oh My Zsh, after adding ~/.zsh/functions."""
    old_source = OMZ_SOURCE
    new_source = "fpath=(~/.zsh/functions $fpath)\n" + old_source
    old_compinit = "\nfpath=(~/.zsh/functions $fpath)\nautoload -Uz compinit\ncompinit\n"
    early_autoload = "\nautoload -Uz compinit\n\n# fnm\n"
    if old_compinit not in text and early_autoload not in text:
        return text
    # Treat these two moves as one operation so a partial install is rejected.
    if text.count(old_compinit) != 1 or text.count(early_autoload) != 1 or text.count(old_source) != 1 or new_source in text:
        raise ValueError("Unexpected compinit blocks; refusing configuration drift")
    text = text.replace(old_compinit, "\n", 1)
    text = text.replace(early_autoload, "\n# fnm\n", 1)
    return text.replace(old_source, new_source, 1)


def install_completions(text: str) -> str:
    """Load the cached uv and uvx completions once Oh My Zsh has run compinit."""
    if UV_EVALS in text:
        return replace_exact(text, UV_EVALS, COMPLETIONS, "uv completion initialization")
    if text.count(COMPLETIONS) == 1 and "generate-shell-completion" not in text:
        return text
    if COMPLETIONS in text or "generate-shell-completion" in text or text.count(OMZ_SOURCE) != 1:
        raise ValueError("Unexpected uv completion initialization; refusing configuration drift")
    return text.replace(OMZ_SOURCE, OMZ_SOURCE + COMPLETIONS, 1)


def select_fnm_shell(text: str) -> str:
    """Name zsh explicitly wherever fnm's environment is generated without a shell."""
    lines = text.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if "fnm env" in line and "--shell" not in line:
            if line.count(FNM_OLD) != 1:
                raise ValueError("Unexpected fnm initialization; refusing configuration drift")
            lines[index] = line.replace(FNM_OLD, FNM_NEW)
    return "".join(lines)


def transform_zsh(text: str) -> str:
    text = select_fnm_shell(install_completions(move_compinit(text)))
    return replace_exact(
        text,
        'eval "$(atuin init zsh)"\n',
        'source "$HOME/.config/shell/interactive.zsh"\n',
        "Atuin initialization",
    )


def transform_bash(text: str) -> str:
    old = 'eval "$(atuin init bash)"\n'
    new = 'source "$HOME/.atuin/bin/env"\n' + old
    # The new block contains the old line by design.
    if text.count(new) == 1 and text.count(old) == 1:
        return text
    if text.count(old) != 1 or 'source "$HOME/.atuin/bin/env"' in text:
        raise ValueError("Unexpected Atuin initialization; refusing configuration drift")
    return text.replace(old, new, 1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-dir", type=Path, default=Path.home())
    parser.add_argument("--apply", action="store_true", help="write validated changes and private backups")
    args = parser.parse_args()
    changes = []
    for filename, transform, shell in (
        (".zshrc", transform_zsh, "/bin/zsh"),
        (".bashrc", transform_bash, "/bin/bash"),
    ):
        target = args.target_dir / filename
        info = target.lstat()
        if not stat.S_ISREG(info.st_mode):
            raise ValueError(f"Refusing non-regular or symlink target: {target}")
        original = target.read_bytes()
        proposed = transform(original.decode("utf-8")).encode("utf-8")
        with tempfile.TemporaryDirectory(prefix="shell-startup-check-") as temp_dir:
            candidate = Path(temp_dir) / filename
            candidate.write_bytes(proposed)
            result = subprocess.run([shell, "-n", str(candidate)], capture_output=True)
            if result.returncode:
                raise ValueError(f"Syntax validation failed for {filename}; no files changed")
        if proposed != original:
            changes.append((target, original, proposed, stat.S_IMODE(info.st_mode)))
    if not changes:
        print("Shell startup fixes are already installed; no changes needed.")
        return
    if not args.apply:
        print("Dry run: validated changes for " + ", ".join(item[0].name for item in changes) + ". Use --apply to install with private backups.")
        return
    # Validate every input and candidate before creating backups or changing files.
    for target, original, _, _ in changes:
        fd, backup = tempfile.mkstemp(prefix=target.name + ".startup-backup-", dir=target.parent)
        with os.fdopen(fd, "wb") as stream:
            stream.write(original)
        print(f"Private backup: {backup}")
    for target, _, proposed, mode in changes:
        fd, staged = tempfile.mkstemp(prefix=target.name + ".startup-new-", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(proposed)
                os.fchmod(stream.fileno(), mode)
            os.replace(staged, target)
        finally:
            if os.path.exists(staged):
                os.unlink(staged)
        print(f"Updated {target.name}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        raise SystemExit(str(error)) from error
