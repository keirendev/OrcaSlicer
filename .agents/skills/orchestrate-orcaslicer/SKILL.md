---
name: orchestrate-orcaslicer
description: Build, diagnose, test, package, launch, slice with, upload from, install, or roll back this OrcaSlicer checkout, including Creality K1 camera and printer operations. Use for OrcaSlicer development and local printer workflows in this repository. Require a fresh explicit confirmation before starting every physical print.
---

# Orchestrate OrcaSlicer

Use the project-local `orcaslicer` MCP tools for structured operations. Use the scripts under `scripts/codex/` when the MCP server is unavailable or when inspecting their exact implementation.

## Workflow

1. Call `orca_environment_status` before builds, installation, or printer writes.
2. Call `orca_profiles` before slicing or printing; resolve an explicit machine/process/filament selection rather than guessing.
3. Diagnose the K1 with `orca_device_status` and `k1_camera_probe`. Keep every endpoint on the configured LAN host.
4. Build with `orca_build`, then launch with `orca_launch_isolated` and verify the Device tab before packaging.
5. Package and install with `orca_package` and `orca_install_custom`. Confirm that a rollback artifact and configuration backup exist first.
6. Slice with `orca_slice`. Review warnings, file hash, time, and filament estimates before upload.
7. Upload with `orca_upload_gcode`. Call `orca_prepare_print` to create a short-lived confirmation record.
8. Start only after the user explicitly confirms the displayed job ID, printer, filename, and SHA-256. Pass the exact confirmation phrase to `orca_start_print`.
9. Use `orca_rollback` if installed-device, slicing, or camera acceptance checks fail.

Read [references/operations.md](references/operations.md) before installation, rollback, upload, or print-start operations.

## Safety

- Never start a print as a test.
- Never bypass the job expiry, SHA-256, printer identity, or confirmation phrase checks.
- Never send an arbitrary command or URL through these tools.
- Never modify printer firmware, root the printer, use Creality cloud signaling, or add public STUN/TURN.
- Never put this skill or its MCP configuration in global Codex directories.

Run `scripts/verify.sh` after changing this skill or the MCP server.
