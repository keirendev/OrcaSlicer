#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_repo_root
"${ORCA_REPO_ROOT}/scripts/codex/fetch-camera-helper.sh"

appimage=$(find_appimage)
mkdir -p "${ORCA_PACKAGE_ROOT}" "${ORCA_LOCAL_ROOT}"
work_dir=$(mktemp -d "${ORCA_LOCAL_ROOT}/orca-package.XXXXXX")
trap 'rm -rf -- "${work_dir}"' EXIT

extract_dir="${work_dir}/extract"
pkgroot="${work_dir}/pkgroot"
mkdir -p "${extract_dir}" "${pkgroot}/opt/orca-slicer" "${pkgroot}/usr/bin" \
    "${pkgroot}/usr/share/applications" "${pkgroot}/usr/share/icons/hicolor/192x192/apps" \
    "${pkgroot}/usr/share/doc/orca-slicer-k1-camera"

chmod u+x "${appimage}"
(
    cd "${extract_dir}"
    "${appimage}" --appimage-extract >/dev/null
)
cp -a "${extract_dir}/squashfs-root/." "${pkgroot}/opt/orca-slicer/"
ln -s /opt/orca-slicer/AppRun "${pkgroot}/usr/bin/orca-slicer"

desktop=$(find "${pkgroot}/opt/orca-slicer" -maxdepth 2 -type f -name '*.desktop' | head -n 1 || true)
if [[ -n "${desktop}" ]]; then
    cp "${desktop}" "${pkgroot}/usr/share/applications/orca-slicer.desktop"
    sed -i -E 's|^Exec=.*|Exec=/usr/bin/orca-slicer %F|' "${pkgroot}/usr/share/applications/orca-slicer.desktop"
fi
icon=$(find "${pkgroot}/opt/orca-slicer" -maxdepth 3 -type f \( -iname '*192*.png' -o -iname 'OrcaSlicer.png' \) | head -n 1 || true)
if [[ -n "${icon}" ]]; then
    cp "${icon}" "${pkgroot}/usr/share/icons/hicolor/192x192/apps/orca-slicer.png"
fi

source_commit=$(git rev-parse HEAD)
source_branch=$(git branch --show-current)
patch_sha256=$(git diff --binary | sha256sum | awk '{print $1}')
source_tree_sha256=$(
    git ls-files --cached --others --exclude-standard -z |
        sort -z |
        xargs -0 sha256sum |
        sha256sum |
        awk '{print $1}'
)
cat >"${pkgroot}/usr/share/doc/orca-slicer-k1-camera/build-metadata.json" <<EOF
{
  "package": "orca-slicer-k1-camera",
  "version": "2.4.2.k1webrtc1-1",
  "upstream_base": "8500fcdccaa10b5099ac20d252af3a7c560046f1",
  "source_commit": "${source_commit}",
  "source_branch": "${source_branch}",
  "tracked_diff_sha256": "${patch_sha256}",
  "source_tree_sha256": "${source_tree_sha256}",
  "camera_helper": "go2rtc 1.9.14",
  "camera_helper_sha256": "32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6"
}
EOF

build_date=$(date +%s)
installed_size=$(du -sb "${pkgroot}" | awk '{print $1}')
cat >"${pkgroot}/.PKGINFO" <<EOF
pkgname = orca-slicer-k1-camera
pkgbase = orca-slicer-k1-camera
pkgver = 2.4.2.k1webrtc1-1
pkgdesc = OrcaSlicer 2.4.2 with Creality K1 LAN WebRTC camera support
url = https://github.com/keirendev/OrcaSlicer
builddate = ${build_date}
packager = OrcaSlicer local Codex build
size = ${installed_size}
arch = x86_64
license = AGPL-3.0-only
license = MIT
depend = webkit2gtk-4.1
depend = glu
depend = cairo
depend = gtk3
depend = gstreamer
depend = gst-plugins-good
depend = gst-plugins-bad
depend = gst-libav
depend = ffmpeg
depend = wayland
depend = mesa-utils
depend = libmspack
depend = libice
depend = libsm
provides = orca-slicer=2.4.2
conflict = orca-slicer
EOF

package="${ORCA_PACKAGE_ROOT}/orca-slicer-k1-camera-2.4.2.k1webrtc1-1-x86_64.pkg.tar.zst"
(
    cd "${pkgroot}"
    fakeroot -- bash -c '
        set -euo pipefail
        package_contents() {
            find . -mindepth 1 -printf "%P\0" | LC_ALL=C sort -z
        }
        package_contents | LANG=C bsdtar -cnf - --format=mtree \
            --options="!all,use-set,type,uid,gid,mode,time,size,sha256,link" \
            --null --files-from - --exclude .MTREE | gzip -c -f -n >.MTREE
        package_contents | LANG=C bsdtar --no-fflags --no-read-sparse -cnf - \
            --null --files-from - | zstd -q -c >"$1"
    ' bash "${package}"
)
sha256sum "${package}"
pacman -Qip "${package}"
