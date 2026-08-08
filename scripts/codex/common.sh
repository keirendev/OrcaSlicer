#!/usr/bin/env bash
set -euo pipefail

ORCA_REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ORCA_LOCAL_ROOT="${ORCA_REPO_ROOT}/.local"
ORCA_PACKAGE_ROOT="${ORCA_LOCAL_ROOT}/orca-packages"
ORCA_BACKUP_ROOT="${ORCA_LOCAL_ROOT}/orca-backups"
ORCA_AUTOMATION_ROOT="${ORCA_LOCAL_ROOT}/orca-automation"

find_appimage() {
    if [[ -n "${ORCA_APPIMAGE:-}" && -f "${ORCA_APPIMAGE}" ]]; then
        printf '%s\n' "${ORCA_APPIMAGE}"
        return
    fi

    local candidate
    candidate=$(find "${ORCA_REPO_ROOT}" -path '*/node_modules' -prune -o -type f -iname '*OrcaSlicer*.AppImage' -print 2>/dev/null | sort | tail -n 1)
    if [[ -z "${candidate}" ]]; then
        echo "No OrcaSlicer AppImage was found. Run scripts/codex/build-local-appimage.sh first." >&2
        return 1
    fi
    printf '%s\n' "${candidate}"
}

require_repo_root() {
    if [[ ! -f "${ORCA_REPO_ROOT}/build_linux.sh" || ! -d "${ORCA_REPO_ROOT}/.git" ]]; then
        echo "This command must run from the OrcaSlicer repository." >&2
        exit 2
    fi
}
