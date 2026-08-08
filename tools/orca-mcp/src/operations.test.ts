import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cameraSignalingUrl, JobRecord, startLivePrint, startPrint, summarizeGcode, trustedLanHostname,
  validateJobAuthorization, validateJobState, validateLiveJobSource
} from "./operations.js";

const job: JobRecord = {
  version: 1,
  id: "00000000-0000-4000-8000-000000000000",
  createdAt: "2026-08-08T00:00:00.000Z",
  expiresAt: "2026-08-08T00:10:00.000Z",
  gcodePath: "/managed/job.gcode",
  sha256: "a".repeat(64),
  bytes: 123,
  mtimeMs: 456,
  uploadName: "job.gcode",
  printerProfile: "K1 Max",
  printerHost: "http://192.168.50.42",
  printerIdentity: { model: "K1 Max", mac: "00:11:22:33:44:55" },
  estimatedTime: "1h 2m",
  filament: "12.3 m",
  warnings: []
};

test("LAN printer validation accepts private and local hosts", () => {
  assert.equal(trustedLanHostname("http://192.168.50.42"), "192.168.50.42");
  assert.equal(trustedLanHostname("k1-max.local"), "k1-max.local");
  assert.equal(cameraSignalingUrl("192.168.50.42"), "http://192.168.50.42:8000/call/webrtc_local");
});

test("LAN printer validation rejects public and credentialed hosts", () => {
  assert.throws(() => trustedLanHostname("https://example.com"));
  assert.throws(() => trustedLanHostname("http://user:secret@192.168.50.42"));
  assert.throws(() => trustedLanHostname("8.8.8.8"));
});

test("print start refuses missing per-job confirmation before any printer access", async () => {
  await assert.rejects(startPrint("00000000-0000-4000-8000-000000000000", "0".repeat(64), "yes"),
    /fresh exact START/);
});

test("live print start requires its distinct exact confirmation before any live or printer access", async () => {
  await assert.rejects(startLivePrint("00000000-0000-4000-8000-000000000000", "0".repeat(64),
    "START 00000000-0000-4000-8000-000000000000"), /fresh exact START LIVE/);
});

test("prepared print authorization is checksum-bound and expires", () => {
  assert.doesNotThrow(() => validateJobAuthorization(job, job.id, job.sha256, Date.parse("2026-08-08T00:05:00.000Z")));
  assert.throws(() => validateJobAuthorization(job, job.id, "b".repeat(64), Date.parse("2026-08-08T00:05:00.000Z")), /SHA-256/);
  assert.throws(() => validateJobAuthorization(job, job.id, job.sha256, Date.parse("2026-08-08T00:11:00.000Z")), /expired/);
});

test("prepared print state detects changed files, host, and printer identity", () => {
  const current = {
    bytes: job.bytes, mtimeMs: job.mtimeMs, sha256: job.sha256,
    printerHost: job.printerHost, printerIdentity: { ...job.printerIdentity }
  };
  assert.doesNotThrow(() => validateJobState(job, current));
  assert.throws(() => validateJobState(job, { ...current, sha256: "b".repeat(64) }), /G-code changed/);
  assert.throws(() => validateJobState(job, { ...current, printerHost: "http://192.168.50.43" }), /printer changed/);
  assert.throws(() => validateJobState(job, { ...current, printerIdentity: { ...current.printerIdentity, mac: "00:11:22:33:44:66" } }), /identity changed/);
});

test("live print authorization is bound to the visible slice and its original G-code", () => {
  const liveJob: JobRecord = {
    ...job,
    source: {
      kind: "live_session",
      sessionId: "00000000-0000-4000-8000-000000000001",
      stateToken: "c".repeat(64),
      plateIndex: 0,
      projectName: "live-project",
      gcodePath: "/managed/live.gcode",
      gcodeSha256: "d".repeat(64)
    }
  };
  const state = {
    sessionId: liveJob.source?.sessionId,
    stateToken: liveJob.source?.stateToken,
    activePlateIndex: 0,
    plates: [{ index: 0, slice: { gcodePath: "/managed/live.gcode" } }]
  };
  assert.doesNotThrow(() => validateLiveJobSource(liveJob, state, "d".repeat(64)));
  assert.throws(() => validateLiveJobSource(liveJob, state, "e".repeat(64)), /G-code changed/);
  assert.throws(() => validateLiveJobSource(liveJob,
    { ...state, activePlateIndex: 1 }, "d".repeat(64)), /plate or sliced artifact changed/);
});

test("G-code summaries include estimates written at the end of large files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orca-gcode-summary-"));
  const path = join(directory, "test.gcode");
  try {
    await writeFile(path, `${"G1 X0 Y0\n".repeat(250_000)}; filament used [mm] = 3860.47\n; estimated printing time (normal mode) = 33m 16s\n`);
    const summary = await summarizeGcode(path);
    assert.equal(summary.filament, "3860.47");
    assert.equal(summary.estimatedTime, "33m 16s");
    assert.match(summary.sha256, /^[0-9a-f]{64}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
