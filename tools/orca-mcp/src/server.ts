import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  buildAppImage, cameraProbe, deviceStatus, environmentStatus, installCustom, launchIsolated,
  listProfiles, openProject, packageArch, preparePrint, rollback, sliceModel, startPrint, uploadGcode
} from "./operations.js";

const server = new McpServer({ name: "orcaslicer-project", version: "0.1.0" }, {
  instructions: "Operate only this OrcaSlicer checkout and configured LAN printers. Never accept arbitrary commands or URLs. A physical print requires orca_prepare_print followed by fresh user approval and exact job ID, SHA-256, and START phrase."
});

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const workspaceWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const externalWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

function response(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function guarded<T extends Record<string, unknown>>(fn: (input: T) => Promise<unknown>) {
  return async (input: T) => {
    try { return response(await fn(input)); }
    catch (error) { return { ...response({ error: error instanceof Error ? error.message : String(error) }), isError: true }; }
  };
}

server.registerTool("orca_environment_status", { description: "Inspect source, installed package, and rollback readiness.", inputSchema: {}, annotations: readOnly }, guarded(async () => environmentStatus()));
server.registerTool("orca_profiles", {
  description: "List OrcaSlicer machine, process, or filament profiles.",
  inputSchema: { kind: z.enum(["machine", "process", "filament"]).optional(), query: z.string().max(120).optional() }, annotations: readOnly
}, guarded(async input => listProfiles(input.kind, input.query)));
server.registerTool("orca_device_status", {
  description: "Probe the configured Creality LAN printer without changing it.",
  inputSchema: { profile: z.string().max(300).optional() }, annotations: readOnly
}, guarded(async input => deviceStatus(input.profile)));
server.registerTool("k1_camera_probe", {
  description: "Probe K1 WebUI, WebRTC, legacy camera, and control ports on the configured LAN host.",
  inputSchema: { profile: z.string().max(300).optional() }, annotations: readOnly
}, guarded(async input => cameraProbe(input.profile)));
server.registerTool("orca_build", { description: "Build and test the Linux AppImage in Podman.", inputSchema: {}, annotations: workspaceWrite }, guarded(async () => buildAppImage()));
server.registerTool("orca_package", { description: "Package the tested AppImage as the local Arch package.", inputSchema: {}, annotations: workspaceWrite }, guarded(async () => packageArch()));
server.registerTool("orca_launch_isolated", {
  description: "Launch the AppImage with a copied isolated OrcaSlicer data directory.",
  inputSchema: { projectPath: z.string().max(4096).optional() }, annotations: workspaceWrite
}, guarded(async input => launchIsolated(input.projectPath)));
server.registerTool("orca_open_project", {
  description: "Open an explicit supported model, project, or G-code file in OrcaSlicer.",
  inputSchema: { projectPath: z.string().max(4096) }, annotations: workspaceWrite
}, guarded(async input => openProject(input.projectPath)));
server.registerTool("orca_slice", {
  description: "Slice a model with explicit machine, process, and filament profiles into a managed job directory.",
  inputSchema: {
    inputPath: z.string().max(4096), machineProfile: z.string().max(4096), processProfile: z.string().max(4096),
    filamentProfiles: z.array(z.string().max(4096)).min(1).max(16), plate: z.number().int().min(0).default(0)
  }, annotations: workspaceWrite
}, guarded(async input => sliceModel(input.inputPath, input.machineProfile, input.processProfile, input.filamentProfiles, input.plate)));
server.registerTool("orca_upload_gcode", {
  description: "Upload an explicit G-code file to the configured Creality printer without starting it.",
  inputSchema: { gcodePath: z.string().max(4096), profile: z.string().max(300).optional(), remoteName: z.string().max(255).optional() }, annotations: externalWrite
}, guarded(async input => uploadGcode(input.gcodePath, input.profile, input.remoteName)));
server.registerTool("orca_prepare_print", {
  description: "Create a ten-minute, checksum-bound confirmation record for an uploaded G-code file.",
  inputSchema: { gcodePath: z.string().max(4096), profile: z.string().max(300).optional(), uploadName: z.string().max(255).optional() }, annotations: workspaceWrite
}, guarded(async input => preparePrint(input.gcodePath, input.profile, input.uploadName)));
server.registerTool("orca_start_print", {
  description: "Start one prepared print. Requires fresh user approval and the exact job ID, SHA-256, and START phrase.",
  inputSchema: { jobId: z.string().uuid(), expectedSha256: z.string().regex(/^[0-9a-f]{64}$/i), confirmation: z.string().max(80) }, annotations: destructive
}, guarded(async input => startPrint(input.jobId, input.expectedSha256, input.confirmation)));
server.registerTool("orca_install_custom", {
  description: "Back up OrcaSlicer configuration and replace the installed package with the local custom package.",
  inputSchema: { packagePath: z.string().max(4096).optional() }, annotations: destructive
}, guarded(async input => installCustom(input.packagePath)));
server.registerTool("orca_rollback", { description: "Restore the preserved official OrcaSlicer 2.4.2 package.", inputSchema: {}, annotations: destructive }, guarded(async () => rollback()));

await server.connect(new StdioServerTransport());
