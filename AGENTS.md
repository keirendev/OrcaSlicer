# CLAUDE.md

OrcaSlicer — open-source C++17 3D slicer. wxWidgets GUI, CMake build system.

## Build Commands

```bash
# macOS
cmake --build build/arm64 --config RelWithDebInfo --target all --

# Linux
cmake --build build --config RelWithDebInfo --target all --

# Windows (replace %build_type% with Debug/Release/RelWithDebInfo)
cmake --build . --config %build_type% --target ALL_BUILD -- -m
```

## Testing

Catch2 framework. Tests in `tests/` directory.

```bash
cd build && ctest --output-on-failure           # all tests
ctest --test-dir ./tests/libslic3r              # individual suite
ctest --test-dir ./tests/fff_print
```

## Code Style

- C++17, selective C++20. PascalCase classes, snake_case functions/variables
- `#pragma once` for headers. Smart pointers and RAII preferred
- Parallelization via TBB — be mindful of shared state

## Key Entry Points

- App startup: `src/OrcaSlicer.cpp`
- Slicing pipeline: `src/libslic3r/Print.cpp`
- All print/printer/material settings: `src/libslic3r/PrintConfig.cpp`
- GUI: `src/slic3r/GUI/`
- Core algorithms: `src/libslic3r/` (GCode/, Fill/, Support/, Geometry/, Format/, Arachne/)
- Printer profiles: `resources/profiles/[manufacturer].json`

## Critical Constraints

- **Backward compatibility required** for .3mf project files and printer profiles
- **Cross-platform** — all changes must work on Windows, macOS, and Linux
- Profile/format changes need version migration handling
- Dependencies built separately in `deps/build/`, then linked to main app

## K1 Camera and Local Automation

- Keep K1 camera signaling LAN-only. Never introduce cloud credentials, public STUN/TURN, firmware changes, or printer rooting.
- Treat `resources/web/k1_camera_webrtc.js` and `CrealityWebRTC` as one protocol surface; run their focused checks after either changes.
- Use `./scripts/codex/build-local-appimage.sh` for the reproducible Linux build and test an AppImage with an isolated data directory before installation.
- Preserve the user's OrcaSlicer configuration and the cached official 2.4.2 package before replacing the system package.
- Codex may inspect, build, slice, and upload autonomously. Starting a physical print always requires a fresh explicit confirmation for the exact job ID and SHA-256.
- Do not add OrcaSlicer tooling to `~/.codex`, `~/.agents`, or a global marketplace. Repository integration belongs in `.agents/skills` and `.codex/config.toml`.
- Never push, publish a release, modify printer firmware, or start a validation print unless the user separately requests it.

## Code review focus areas

- Changes must not cause regressions in existing functionality, defaults, profiles, or project compatibility.
- Features gated by options must not affect existing behavior when those options are disabled.
- Changes should follow the existing code style and architecture. Architectural changes should be justified in code comments and the PR description.
- Add helper functions or utilities only when existing code cannot reasonably be reused. Avoid duplication.
- Keep code concise and clear. Manually simplify AI generated bloated codes before review.
- Include targeted tests or documented verification for behavior changes, especially in slicing logic, profiles, formats, and GUI defaults.
