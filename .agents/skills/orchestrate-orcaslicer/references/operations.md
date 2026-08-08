# Operational contract

## Installation and rollback

- Build from commit `8500fcdccaa10b5099ac20d252af3a7c560046f1` plus the reviewed local patch.
- Test the AppImage with a copied `--datadir` before packaging.
- Accept only `orca-slicer-k1-camera-2.4.2.k1webrtc1-1-x86_64.pkg.tar.zst` from `.local/orca-packages`.
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
