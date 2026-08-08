---
name: orchestrate-orcaslicer
description: Build, diagnose, test, package, launch, slice with, upload from, install, or roll back this OrcaSlicer checkout, including Creality K1 camera and printer operations. Use for OrcaSlicer development and local printer workflows in this repository. Require a fresh explicit confirmation before starting every physical print.
---

# Orchestrate OrcaSlicer

Use the project-local `orcaslicer` MCP tools for structured operations. Use the scripts under `scripts/codex/` when the MCP server is unavailable or when inspecting their exact implementation.

## Workflow

1. Call `orca_environment_status` before builds, installation, or printer writes.
2. For the visible application, call `orca_live_plate_state` first and pass its `stateToken` to every live mutation. Re-inspect after possible manual interaction; never retry a state conflict with a guessed token.
3. Use `orca_live_clear_plate`, `orca_live_import_stl`, and `orca_live_save_project` to update the active window without desktop controls. Verify the returned object source, dimensions, plate assignment, and transform.
4. Call `orca_profiles` before slicing or printing; resolve an explicit machine/process/filament selection rather than guessing.
5. Diagnose the K1 with `orca_device_status` and `k1_camera_probe`. Keep every endpoint on the configured LAN host.
6. Build with `orca_build`, then launch with `orca_launch_isolated` and verify the Device tab before packaging.
7. Package and install with `orca_package` and `orca_install_custom`. Confirm that a rollback artifact and configuration backup exist first.
8. Slice with `orca_slice`, or slice the active plate in the visible application. Review warnings, file hash, time, and filament estimates before upload.
9. For a visible sliced plate, call `orca_live_prepare_print`. Start only after the user explicitly confirms the displayed job ID, printer, filename, SHA-256, and exact `START LIVE <job-id>` phrase; then call `orca_live_start_print`.
10. For a headless G-code job, use `orca_upload_gcode` and `orca_prepare_print`, then require the exact `START <job-id>` phrase for `orca_start_print`.
11. Use `orca_rollback` if installed-device, slicing, or camera acceptance checks fail.

Read [references/operations.md](references/operations.md) before installation, rollback, upload, or print-start operations.

## Safety

- Never start a print as a test.
- Never bypass the job expiry, SHA-256, printer identity, or confirmation phrase checks.
- Never send an arbitrary command or URL through these tools.
- Never modify printer firmware, root the printer, use Creality cloud signaling, or add public STUN/TURN.
- Never put this skill or its MCP configuration in global Codex directories.

Run `scripts/verify.sh` after changing this skill or the MCP server.
