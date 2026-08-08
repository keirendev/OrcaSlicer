# Operational contract

## Installation and rollback

- Build from commit `8500fcdccaa10b5099ac20d252af3a7c560046f1` plus the reviewed local patch.
- Test the AppImage with a copied `--datadir` before packaging.
- Accept only `orca-slicer-k1-camera-2.4.2.k1webrtc3-1-x86_64.pkg.tar.zst` from `.local/orca-packages`.
- Preserve `${XDG_CONFIG_HOME:-$HOME/.config}/OrcaSlicer` and verify the cached `orca-slicer-bin-2.4.2-1` package checksum before installation.
- Verify the package, desktop launcher, Device view, camera, and a normal slice after installation. Roll back on failure.

## Printer targeting

- Resolve the printer from an Orca user machine profile with `host_type` equal to `crealityprint`.
- Allow only RFC1918, link-local, loopback, or `.local` hosts.
- Do not accept a caller-provided signaling URL. Derive the K1 camera endpoint as `http://<trusted-host>:8000/call/webrtc_local`.

## Print confirmation

`orca_prepare_print` records the exact local G-code path, SHA-256, size, modification time, configured printer, stable printer model/MAC identity, upload name, and ten-minute expiry. It returns a confirmation phrase of the form `START <job-id>`.

Before `orca_start_print`:

1. Show the complete record to the user.
2. Receive fresh, unambiguous approval for that job.
3. Pass the exact job ID, SHA-256, and confirmation phrase.
4. Let the server re-read and re-hash the file and re-probe the same printer.

Never reuse a job record or confirmation after a failed or successful start.

### Live-session print confirmation

`orca_live_prepare_print` accepts only the active visible plate's valid sliced G-code. In addition to the checks above, its record is bound to the live application session ID, opaque state token, active plate index, project name, original G-code path, and original G-code SHA-256. `orca_live_start_print` re-inspects the application and re-hashes both the original live artifact and its managed snapshot immediately before the printer write. It refuses if any bound live state changed. Its confirmation phrase is `START LIVE <job-id>`.

Preparing uploads the immutable managed G-code snapshot but cannot start it. Never call the live start tool without fresh user approval for the exact record, and never translate ordinary requests such as import, arrange, slice, save, or upload into permission to start hardware.
