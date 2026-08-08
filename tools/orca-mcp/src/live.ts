import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const protocolVersion = 1;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface LiveSessionDescriptor {
  protocolVersion: number;
  pid: number;
  sessionId: string;
  token: string;
  sessionRoot: string;
  startedAtUnixMs: number;
}

export interface LiveCallOptions {
  automationRoot?: string;
  timeoutMs?: number;
}

export class LiveAutomationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "LiveAutomationError";
  }
}

function defaultDataRoot(): string {
  if (process.env.ORCA_DATA_DIR)
    return resolve(process.env.ORCA_DATA_DIR);
  if (platform() === "win32")
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "OrcaSlicer");
  if (platform() === "darwin")
    return join(homedir(), "Library", "Application Support", "OrcaSlicer");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "OrcaSlicer");
}

export function liveAutomationRoot(): string {
  return join(defaultDataRoot(), "automation");
}

function processIsRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function readLiveSession(rootPath: string): Promise<LiveSessionDescriptor> {
  const root = resolve(rootPath);
  const descriptorPath = join(root, "live-session.json");
  let descriptor: LiveSessionDescriptor;
  try {
    descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as LiveSessionDescriptor;
  } catch {
    throw new LiveAutomationError("live_session_unavailable",
      `No MCP-enabled OrcaSlicer live session is available at ${descriptorPath}`);
  }
  if (descriptor.protocolVersion !== protocolVersion ||
      typeof descriptor.sessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(descriptor.sessionId) ||
      typeof descriptor.token !== "string" || descriptor.token.length < 64 ||
      typeof descriptor.sessionRoot !== "string" || !processIsRunning(descriptor.pid)) {
    throw new LiveAutomationError("stale_live_session", "The OrcaSlicer live-session descriptor is invalid or stale");
  }
  const [canonicalRoot, canonicalSession] = await Promise.all([realpath(root), realpath(descriptor.sessionRoot)]);
  if (!isWithin(canonicalRoot, canonicalSession))
    throw new LiveAutomationError("invalid_live_session", "The OrcaSlicer live-session queue is outside its managed root");
  descriptor.sessionRoot = canonicalSession;
  return descriptor;
}

async function isolatedAutomationRoots(): Promise<string[]> {
  const root = join(repoRoot, ".local", "orca-automation");
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory() &&
      (entry.name.startsWith("isolated-") || entry.name.startsWith("live-demo.")))
      .map(entry => join(root, entry.name, "automation"));
  } catch {
    return [];
  }
}

export async function discoverLiveSession(options: LiveCallOptions = {}): Promise<LiveSessionDescriptor> {
  if (options.automationRoot)
    return await readLiveSession(options.automationRoot);

  const primaryRoot = liveAutomationRoot();
  if (process.env.ORCA_DATA_DIR)
    return await readLiveSession(primaryRoot);
  return await discoverLiveSessionFromRoots(primaryRoot, await isolatedAutomationRoots());
}

export async function discoverLiveSessionFromRoots(primaryRoot: string,
                                                   fallbackRoots: string[]): Promise<LiveSessionDescriptor> {
  try {
    return await readLiveSession(primaryRoot);
  } catch { /* try project-local isolated sessions */ }

  const sessions: LiveSessionDescriptor[] = [];
  for (const root of fallbackRoots) {
    try {
      sessions.push(await readLiveSession(root));
    } catch {
      // Stale isolated launch directories are expected and are ignored.
    }
  }
  if (sessions.length === 1)
    return sessions[0];
  if (sessions.length > 1)
    throw new LiveAutomationError("multiple_live_sessions",
      "Multiple MCP-enabled isolated OrcaSlicer sessions are running; set ORCA_DATA_DIR to select one");
  throw new LiveAutomationError("live_session_unavailable",
    `No MCP-enabled OrcaSlicer live session is available at ${join(primaryRoot, "live-session.json")}`);
}

async function wait(delayMs: number): Promise<void> {
  await new Promise(resolvePromise => setTimeout(resolvePromise, delayMs));
}

export async function liveCall(action: string, params: Record<string, unknown> = {},
                               options: LiveCallOptions = {}): Promise<unknown> {
  if (!/^[a-z_]{1,40}$/.test(action))
    throw new LiveAutomationError("invalid_action", "Live action names must contain only lowercase letters and underscores");
  const descriptor = await discoverLiveSession(options);
  const requestDirectory = join(descriptor.sessionRoot, "requests");
  const responseDirectory = join(descriptor.sessionRoot, "responses");
  await Promise.all([
    access(requestDirectory, fsConstants.W_OK),
    access(responseDirectory, fsConstants.R_OK)
  ]);

  const id = randomUUID();
  const requestPath = join(requestDirectory, `${id}.json`);
  const temporaryPath = join(requestDirectory, `.${id}.${randomUUID()}.tmp`);
  const responsePath = join(responseDirectory, `${id}.json`);
  const request = { protocolVersion, id, token: descriptor.token, action, params };
  await writeFile(temporaryPath, `${JSON.stringify(request)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporaryPath, requestPath);

  const timeoutMs = options.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      try {
        const info = await stat(responsePath);
        if (info.size > 1_000_000)
          throw new LiveAutomationError("invalid_response", "The OrcaSlicer live response exceeded 1 MiB");
        const response = JSON.parse(await readFile(responsePath, "utf8")) as {
          protocolVersion?: number;
          id?: string;
          ok?: boolean;
          result?: unknown;
          error?: { code?: string; message?: string };
        };
        if (response.protocolVersion !== protocolVersion || response.id !== id)
          throw new LiveAutomationError("invalid_response", "OrcaSlicer returned a mismatched live response");
        if (!response.ok)
          throw new LiveAutomationError(response.error?.code || "live_request_failed",
            response.error?.message || "The OrcaSlicer live request failed");
        return response.result;
      } catch (error) {
        if (error instanceof LiveAutomationError)
          throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT")
          throw error;
      }
      if (!processIsRunning(descriptor.pid))
        throw new LiveAutomationError("live_session_closed", "OrcaSlicer closed while processing the live request");
      await wait(50);
    }
    throw new LiveAutomationError("live_request_timeout", `OrcaSlicer did not answer '${action}' within ${timeoutMs} ms`);
  } finally {
    await rm(responsePath, { force: true }).catch(() => undefined);
    await rm(requestPath, { force: true }).catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function liveState(options: LiveCallOptions = {}): Promise<Record<string, unknown>> {
  return await liveCall("state", {}, options) as Record<string, unknown>;
}
