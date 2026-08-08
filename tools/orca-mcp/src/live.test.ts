import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverLiveSession, discoverLiveSessionFromRoots, liveCall, LiveAutomationError } from "./live.js";

test("live calls use the authenticated OrcaSlicer request queue", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "orca-live-mcp-"));
  const root = join(temporary, "automation");
  const sessionRoot = join(root, "live-test");
  const requests = join(sessionRoot, "requests");
  const responses = join(sessionRoot, "responses");
  await mkdir(requests, { recursive: true });
  await mkdir(responses, { recursive: true });
  await writeFile(join(root, "live-session.json"), JSON.stringify({
    protocolVersion: 1,
    pid: process.pid,
    sessionId: "00000000-0000-4000-8000-000000000001",
    token: "a".repeat(64),
    sessionRoot,
    startedAtUnixMs: Date.now()
  }));

  let handling = false;
  const poll = setInterval(async () => {
    if (handling)
      return;
    handling = true;
    try {
      for (const filename of await readdir(requests)) {
        if (!filename.endsWith(".json"))
          continue;
        const request = JSON.parse(await readFile(join(requests, filename), "utf8")) as {
          id: string; token: string; action: string;
        };
        assert.equal(request.token, "a".repeat(64));
        const response = request.action === "state"
          ? { protocolVersion: 1, id: request.id, ok: true, result: { stateToken: "b".repeat(64) } }
          : { protocolVersion: 1, id: request.id, ok: false, error: { code: "state_conflict", message: "changed" } };
        await writeFile(join(responses, filename), JSON.stringify(response), { flag: "wx" });
        await unlink(join(requests, filename));
      }
    } finally {
      handling = false;
    }
  }, 5);

  try {
    const descriptor = await discoverLiveSession({ automationRoot: root });
    assert.equal(descriptor.pid, process.pid);
    assert.deepEqual(await liveCall("state", {}, { automationRoot: root, timeoutMs: 2000 }),
      { stateToken: "b".repeat(64) });
    await assert.rejects(liveCall("clear", { expectedStateToken: "c".repeat(64) },
      { automationRoot: root, timeoutMs: 2000 }),
    (error: unknown) => error instanceof LiveAutomationError && error.code === "state_conflict");
  } finally {
    clearInterval(poll);
    await rm(temporary, { recursive: true, force: true });
  }
});

test("live discovery rejects a missing application session", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "orca-live-missing-"));
  try {
    await assert.rejects(discoverLiveSession({ automationRoot: temporary }),
      (error: unknown) => error instanceof LiveAutomationError && error.code === "live_session_unavailable");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("live discovery falls back to one running project-local isolated session", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "orca-live-fallback-"));
  const primary = join(temporary, "primary");
  const fallback = join(temporary, "isolated", "automation");
  const sessionRoot = join(fallback, "live-test");
  try {
    await mkdir(join(sessionRoot, "requests"), { recursive: true });
    await mkdir(join(sessionRoot, "responses"), { recursive: true });
    await writeFile(join(fallback, "live-session.json"), JSON.stringify({
      protocolVersion: 1,
      pid: process.pid,
      sessionId: "00000000-0000-4000-8000-000000000002",
      token: "f".repeat(64),
      sessionRoot,
      startedAtUnixMs: Date.now()
    }));
    const session = await discoverLiveSessionFromRoots(primary, [fallback]);
    assert.equal(session.sessionId, "00000000-0000-4000-8000-000000000002");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
