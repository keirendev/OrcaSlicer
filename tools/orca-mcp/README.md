# OrcaSlicer project MCP server

This repository-local MCP server controls the checked-out OrcaSlicer build and its configured LAN printers. Its `orca_live_*` tools communicate with the visible, already-running application through a private authenticated request queue under the OrcaSlicer data directory. Requests execute on the wxWidgets GUI thread, so successful mutations are immediately visible and never use mouse, keyboard, accessibility, screenshot, or window automation.

## Live plate workflow

The application must be a build containing `LiveAutomation` and must have completed startup. An older official build cannot be retrofitted while it is running; restart once into the MCP-enabled build. After that, the MCP server discovers the normal user-data session automatically. If there is no normal MCP-enabled session, it also accepts exactly one running project-local `orca_launch_isolated` session; multiple isolated sessions are rejected as ambiguous. Set `ORCA_DATA_DIR` when an operator deliberately needs to select a custom data directory.

1. Call `orca_live_plate_state`. Record its `stateToken` and inspect `project`, `activePlateIndex`, `plates`, and `objects`.
2. Call `orca_live_clear_plate` with that token and `scope` set to `current_plate` or `all_models`. Use the returned state's new token.
3. Call `orca_live_import_stl` with an absolute `.stl` path and the new token. The result reports the source SHA-256 plus OrcaSlicer's actual object identity, mesh bounds, per-instance world bounds, plate assignment, and transform.
4. Re-read with `orca_live_plate_state` whenever the user may have interacted with OrcaSlicer. A stale token is rejected instead of overwriting newer manual work.
5. Optionally call `orca_live_save_project` with an absolute `.3mf` path. Existing files require `overwrite: true`.

The current plate's slice block reports whether a valid G-code artifact exists. Live state is the primary contract; the server does not claim to inspect an unmodified OrcaSlicer process or emulate its GUI in a headless manifest.

## Live print safety

`orca_live_prepare_print` requires a current state token and an already-valid slice in the active window. It copies the exact G-code into a managed immutable snapshot, uploads it without starting, probes the configured LAN printer, and creates a ten-minute record bound to:

- original live G-code path and SHA-256, plus the snapshot's SHA-256, byte size, and modification time;
- printer profile, LAN host, model/MAC identity, and remote filename;
- live OrcaSlicer session, state token, active plate, and project name.

Show the returned record to the user and obtain fresh approval for that exact job. Only `orca_live_start_print` can start it, and only with the exact job ID, SHA-256, and `START LIVE <job-id>` phrase. Any live plate change, expired record, file change, printer change, or identity change refuses the start and consumes the record. Import, clear, save, slice, upload, and prepare operations cannot start a physical print.

## Development

```bash
npm ci --prefix tools/orca-mcp
npm test --prefix tools/orca-mcp
./.agents/skills/orchestrate-orcaslicer/scripts/verify.sh
```

The stdio launcher rebuilds TypeScript when sources are newer than `dist/server.js`:

```bash
./tools/orca-mcp/bin/orca-mcp
```
