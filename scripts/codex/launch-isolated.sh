#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_repo_root

appimage=$(find_appimage)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
data_dir="${ORCA_AUTOMATION_ROOT}/isolated-${stamp}"
orca_config_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/OrcaSlicer"
mkdir -p "${ORCA_AUTOMATION_ROOT}"
if [[ -d "${orca_config_dir}" ]]; then
    cp -a "${orca_config_dir}" "${data_dir}"
else
    mkdir -p "${data_dir}"
fi

chmod u+x "${appimage}"
# The Codex desktop environment cannot mount FUSE filesystems. AppImage's
# official extraction fallback executes the same packaged tree without a mount.
unit="orcaslicer-isolated-${stamp,,}"
unit=${unit//[^a-z0-9_-]/-}
systemd-run --user --unit="${unit}" --collect --property=Type=exec \
    --setenv=APPIMAGE_EXTRACT_AND_RUN=1 \
    --setenv="DISPLAY=${DISPLAY:-:1}" \
    --setenv="WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-wayland-1}" \
    --setenv="XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" \
    "${appimage}" --datadir "${data_dir}" "${@:1}"
pid=$(systemctl --user show "${unit}.service" --property=MainPID --value)
printf 'unit=%s.service\npid=%s\ndatadir=%s\nappimage=%s\n' "${unit}" "${pid}" "${data_dir}" "${appimage}"
