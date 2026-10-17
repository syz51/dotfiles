#!/bin/sh
# Prefer Homebrew Python; Macs without it use the system interpreter.
exec /bin/zsh -lic 'python=/opt/homebrew/bin/python3; [ -x "$python" ] || python=/usr/bin/python3; exec "$python" "$HOME/.config/ghostty/tuios-launcher.py"'
