#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
rollback="${XDG_CACHE_HOME:-${HOME}/.cache}/paru/clone/orca-slicer-bin/orca-slicer-bin-2.4.2-1-x86_64.pkg.tar.zst"
if [[ ! -f "${rollback}" ]]; then
    echo "Rollback package is missing: ${rollback}" >&2
    exit 2
fi
printf 'y\ny\n' | sudo pacman -U --confirm "${rollback}"
pacman -Q orca-slicer-bin
