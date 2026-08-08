#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_repo_root

package=${1:-"${ORCA_PACKAGE_ROOT}/orca-slicer-k1-camera-2.4.2.k1webrtc3-1-x86_64.pkg.tar.zst"}
orca_config_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/OrcaSlicer"
rollback="${XDG_CACHE_HOME:-${HOME}/.cache}/paru/clone/orca-slicer-bin/orca-slicer-bin-2.4.2-1-x86_64.pkg.tar.zst"
package=$(realpath -e -- "${package}" 2>/dev/null || true)
package_root=$(realpath -m -- "${ORCA_PACKAGE_ROOT}")
if [[ ! -f "${package}" || "${package}" != "${package_root}"/* || "$(basename "${package}")" != orca-slicer-k1-camera-*.pkg.tar.zst ]]; then
    echo "Refusing to install an unexpected package: ${package}" >&2
    exit 2
fi
if [[ ! -f "${rollback}" ]]; then
    echo "Rollback package is missing: ${rollback}" >&2
    exit 2
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir="${ORCA_BACKUP_ROOT}/${stamp}"
mkdir -p "${backup_dir}"
cp -a "${orca_config_dir}" "${backup_dir}/OrcaSlicer.config"
(
    cd "${backup_dir}/OrcaSlicer.config"
    find . -type f -print0 | sort -z | xargs -0 sha256sum
) >"${backup_dir}/config-files.sha256"
sha256sum "${rollback}" >"${backup_dir}/rollback.sha256"
sha256sum "${package}" >"${backup_dir}/custom-package.sha256"

# pacman deliberately defaults package-conflict questions to "no", even with
# --noconfirm. This exact package is expected to replace orca-slicer-bin; feed
# affirmative answers to the conflict and final transaction prompts only after
# the package and rollback artifacts have passed the checks above.
printf 'y\ny\n' | sudo pacman -U --confirm "${package}"
pacman -Q orca-slicer-k1-camera
printf 'backup=%s\n' "${backup_dir}"
