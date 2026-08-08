#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "${repo_root}"
node --check resources/web/k1_camera_webrtc.js
node --check resources/web/k1_camera_proxy/camera.js
node --check resources/web/k1_camera_proxy/fmp4_retime.js
node --check resources/web/k1_webui_bootstrap.js
"${repo_root}/scripts/codex/fetch-camera-helper.sh"
test "$(sha256sum resources/camera/linux-x64/go2rtc | awk '{print $1}')" = "32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6"
npm test --prefix tools/orca-mcp
skill_validator="${CODEX_HOME:-${HOME}/.codex}/skills/.system/skill-creator/scripts/quick_validate.py"
if [[ ! -f "${skill_validator}" ]]; then
    echo "Official Codex skill validator is missing: ${skill_validator}" >&2
    exit 2
fi
python3 "${skill_validator}" .agents/skills/orchestrate-orcaslicer
CODEX_HOME="${repo_root}/.codex" codex mcp list | grep -q '^orcaslicer[[:space:]]'
git diff --check
