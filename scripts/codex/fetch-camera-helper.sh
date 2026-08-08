#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_repo_root

readonly version="1.9.14"
readonly expected_sha256="32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6"
readonly destination="${ORCA_REPO_ROOT}/resources/camera/linux-x64/go2rtc"
readonly url="https://github.com/AlexxIT/go2rtc/releases/download/v${version}/go2rtc_linux_amd64"

mkdir -p "$(dirname "${destination}")"
if [[ -f "${destination}" ]] && [[ "$(sha256sum "${destination}" | awk '{print $1}')" == "${expected_sha256}" ]]; then
    chmod 755 "${destination}"
    printf 'go2rtc_version=%s\ngo2rtc_sha256=%s\n' "${version}" "${expected_sha256}"
    exit 0
fi

temporary=$(mktemp "${destination}.download.XXXXXX")
trap 'rm -f -- "${temporary}"' EXIT
curl --fail --location --retry 3 --output "${temporary}" "${url}"
actual_sha256=$(sha256sum "${temporary}" | awk '{print $1}')
if [[ "${actual_sha256}" != "${expected_sha256}" ]]; then
    echo "Refusing camera helper with unexpected SHA-256: ${actual_sha256}" >&2
    exit 2
fi

chmod 755 "${temporary}"
mv "${temporary}" "${destination}"
trap - EXIT
printf 'go2rtc_version=%s\ngo2rtc_sha256=%s\n' "${version}" "${expected_sha256}"
