#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_repo_root

cd "${ORCA_REPO_ROOT}"
if ! command -v podman >/dev/null 2>&1; then
    echo "Podman is required for the reproducible Linux build." >&2
    exit 2
fi

export ORCA_CONTAINER_CLI=podman
"${ORCA_REPO_ROOT}/scripts/codex/fetch-camera-helper.sh"
# A clean checkout has no prebuilt Boost/wxWidgets dependency prefix. Include
# the dependency phase; CMake keeps subsequent runs incremental.
./build_linux.sh -g -distrlL

appimage=$(find_appimage)
sha256sum "${appimage}"
git rev-parse HEAD
