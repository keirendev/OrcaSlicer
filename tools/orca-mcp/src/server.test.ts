import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("project MCP server exposes the bounded OrcaSlicer tool contract", async () => {
  const serverPath = join(dirname(fileURLToPath(import.meta.url)), "server.js");
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
  const client = new Client({ name: "orcaslicer-contract-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    const result = await client.listTools();
    const names = result.tools.map(tool => tool.name).sort();
    assert.deepEqual(names, [
      "k1_camera_probe", "orca_build", "orca_device_status", "orca_environment_status",
      "orca_install_custom", "orca_launch_isolated", "orca_open_project", "orca_package",
      "orca_prepare_print", "orca_profiles", "orca_rollback", "orca_slice",
      "orca_start_print", "orca_upload_gcode"
    ].sort());
    assert.equal(result.tools.find(tool => tool.name === "orca_environment_status")?.annotations?.readOnlyHint, true);
    assert.equal(result.tools.find(tool => tool.name === "orca_start_print")?.annotations?.destructiveHint, true);
    for (const name of ["orca_build", "orca_slice", "orca_launch_isolated"])
      assert.equal(result.tools.find(tool => tool.name === name)?.annotations?.openWorldHint, false);
    for (const name of ["orca_upload_gcode", "orca_install_custom", "orca_rollback"])
      assert.equal(result.tools.find(tool => tool.name === name)?.annotations?.readOnlyHint, false);
    for (const tool of result.tools)
      assert.ok(tool.inputSchema && tool.inputSchema.type === "object", `${tool.name} must expose an object input schema`);

    const badPath = await client.callTool({ name: "orca_open_project", arguments: { projectPath: "/etc/passwd" } });
    assert.equal(badPath.isError, true, "unsupported explicit paths must be rejected");
    const badProfile = await client.callTool({ name: "orca_device_status", arguments: { profile: "definitely-not-a-profile" } });
    assert.equal(badProfile.isError, true, "ambiguous or missing printer profiles must be rejected");

    const config = await readFile(join(dirname(fileURLToPath(import.meta.url)), "../../../.codex/config.toml"), "utf8");
    assert.match(config, /default_tools_approval_mode\s*=\s*"writes"/);
    for (const name of ["orca_upload_gcode", "orca_install_custom", "orca_rollback", "orca_start_print"])
      assert.match(config, new RegExp(`\\[mcp_servers\\.orcaslicer\\.tools\\.${name}\\][\\s\\S]*?approval_mode\\s*=\\s*"prompt"`));
  } finally {
    await client.close();
  }
});
