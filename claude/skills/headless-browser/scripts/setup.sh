#!/bin/sh
# Install the pinned Playwright package and its headless Chromium.
# Safe to run again; it only downloads what is missing.
set -eu
cd "$(dirname "$0")/.."
bun install --frozen-lockfile
bunx playwright install chromium-headless-shell
