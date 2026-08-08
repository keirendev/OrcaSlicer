import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import net from "node:net";
import WebSocket from "ws";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const configRoot = join(homedir(), ".config", "OrcaSlicer");
const userProfileRoot = join(configRoot, "user", "default");
const systemProfileRoot = join(configRoot, "system");
const automationRoot = join(repoRoot, ".local", "orca-automation");
const jobsRoot = join(automationRoot, "print-jobs");
const packageRoot = join(repoRoot, ".local", "orca-packages");
const rollbackPackage = join(homedir(), ".cache", "paru", "clone", "orca-slicer-bin", "orca-slicer-bin-2.4.2-1-x86_64.pkg.tar.zst");

export type ProfileKind = "machine" | "process" | "filament";

export interface PrinterProfile {
  name: string;
  path: string;
  host: string;
  hostname: string;
  apiKey?: string;
}

export interface GcodeSummary {
  path: string;
  sha256: string;
  bytes: number;
  estimatedTime?: string;
  filament?: string;
  warnings: string[];
}

export interface JobRecord {
  version: 1;
  id: string;
  createdAt: string;
  expiresAt: string;
  gcodePath: string;
  sha256: string;
  bytes: number;
  mtimeMs: number;
  uploadName: string;
  printerProfile: string;
  printerHost: string;
  printerIdentity: { model?: string; mac?: string };
  estimatedTime?: string;
  filament?: string;
  warnings: string[];
}

export function validateJobAuthorization(record: JobRecord, jobId: string, expectedSha256: string, nowMs: number): void {
  if (record.id !== jobId || nowMs > Date.parse(record.expiresAt))
    throw new Error("Print confirmation is expired or invalid");
  if (record.sha256 !== expectedSha256)
    throw new Error("Confirmed SHA-256 does not match the prepared job");
}

export function validateJobState(record: JobRecord, current: {
  bytes: number;
  mtimeMs: number;
  sha256: string;
  printerHost: string;
  printerIdentity: { model?: string; mac?: string };
}): void {
  if (current.bytes !== record.bytes || current.mtimeMs !== record.mtimeMs || current.sha256 !== record.sha256)
    throw new Error("G-code changed after print preparation");
  if (current.printerHost !== record.printerHost)
    throw new Error("Configured printer changed after print preparation");
  if ((record.printerIdentity.mac && current.printerIdentity.mac !== record.printerIdentity.mac) ||
      (record.printerIdentity.model && current.printerIdentity.model !== record.printerIdentity.model))
    throw new Error("Printer identity changed after print preparation");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function trustedLanHostname(value: string): string {
  const withScheme = /^[a-z]+:\/\//i.test(value) ? value : `http://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("Printer host is not a valid URL or hostname");
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error("Printer host must be an unauthenticated HTTP LAN URL");

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(host);
  if (family === 4) {
    const octets = host.split(".").map(Number);
    const allowed = octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254);
    if (!allowed)
      throw new Error("Printer host is not a private IPv4 address");
  } else if (family === 6) {
    if (!(host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb")))
      throw new Error("Printer host is not a private IPv6 address");
  } else if (!/^[a-z0-9.-]+\.local$/.test(host)) {
    throw new Error("Printer hostname must be a private IP address or end in .local");
  }
  return host;
}

function baseHttpUrl(host: string): string {
  const hostname = trustedLanHostname(host);
  return `http://${hostname.includes(":") ? `[${hostname}]` : hostname}`;
}

export function cameraSignalingUrl(host: string): string {
  return `${baseHttpUrl(host)}:8000/call/webrtc_local`;
}

async function allFiles(root: string, suffix = ".json"): Promise<string[]> {
  if (!(await exists(root)))
    return [];
  const output: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory())
        await walk(path);
      else if (entry.isFile() && entry.name.endsWith(suffix))
        output.push(path);
    }
  };
  await walk(root);
  return output;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

export async function listProfiles(kind?: ProfileKind, query?: string): Promise<Array<Record<string, unknown>>> {
  const kinds: ProfileKind[] = kind ? [kind] : ["machine", "process", "filament"];
  const lowered = query?.toLowerCase();
  const result: Array<Record<string, unknown>> = [];
  for (const current of kinds) {
    const roots = [join(userProfileRoot, current), join(systemProfileRoot)];
    const seen = new Set<string>();
    for (const root of roots) {
      for (const path of await allFiles(root)) {
        if (!path.includes(`/${current}/`))
          continue;
        let data: Record<string, unknown>;
        try { data = await readJson(path); } catch { continue; }
        const name = typeof data.name === "string" ? data.name : basename(path, ".json");
        if (lowered && !name.toLowerCase().includes(lowered))
          continue;
        const key = `${current}:${name}`;
        if (seen.has(key))
          continue;
        seen.add(key);
        result.push({ kind: current, name, path, user: path.startsWith(userProfileRoot) });
        if (result.length >= 250)
          return result;
      }
    }
  }
  return result;
}

async function findProfile(kind: ProfileKind, nameOrPath: string): Promise<string> {
  const explicit = resolve(nameOrPath);
  if (await exists(explicit)) {
    const allowedRoots = [resolve(configRoot), resolve(repoRoot)];
    if (!allowedRoots.some(root => explicit === root || explicit.startsWith(`${root}/`)))
      throw new Error(`Profile path is outside OrcaSlicer-managed roots: ${explicit}`);
    return explicit;
  }

  const profiles = await listProfiles(kind, nameOrPath);
  const exact = profiles.filter(profile => profile.name === nameOrPath || basename(String(profile.path), ".json") === nameOrPath);
  if (exact.length !== 1)
    throw new Error(`Expected one exact ${kind} profile named '${nameOrPath}', found ${exact.length}`);
  return String(exact[0].path);
}

export async function resolvePrinter(profileName?: string): Promise<PrinterProfile> {
  const paths = await allFiles(join(userProfileRoot, "machine"));
  const candidates: PrinterProfile[] = [];
  for (const path of paths) {
    let data: Record<string, unknown>;
    try { data = await readJson(path); } catch { continue; }
    if (data.host_type !== "crealityprint" || typeof data.print_host !== "string")
      continue;
    const name = typeof data.name === "string" ? data.name : basename(path, ".json");
    if (profileName && profileName !== name && profileName !== path)
      continue;
    candidates.push({
      name,
      path,
      host: data.print_host,
      hostname: trustedLanHostname(data.print_host),
      apiKey: typeof data.printhost_apikey === "string" ? data.printhost_apikey : undefined
    });
  }
  if (candidates.length !== 1)
    throw new Error(`Expected one configured Creality Print user profile${profileName ? ` named '${profileName}'` : ""}, found ${candidates.length}`);
  return candidates[0];
}

interface CommandResult { stdout: string; stderr: string; code: number }

async function run(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, shell: false, env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      resolvePromise({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 });
    });
  });
}

async function runRequired(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  const result = await run(command, args, timeoutMs);
  if (result.code !== 0)
    throw new Error(result.stderr || result.stdout || `${command} exited with ${result.code}`);
  return result;
}

async function runScript(name: string, args: string[] = [], timeoutMs = 30_000): Promise<CommandResult> {
  return await runRequired(join(repoRoot, "scripts", "codex", name), args, timeoutMs);
}

async function executable(): Promise<string> {
  const configured = process.env.ORCA_APPIMAGE;
  if (configured && await exists(configured))
    return configured;
  const installed = "/usr/bin/orca-slicer";
  if (await exists(installed))
    return installed;
  throw new Error("No OrcaSlicer executable is available");
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

export async function summarizeGcode(path: string): Promise<GcodeSummary> {
  const file = resolve(path);
  if (!(await exists(file)) || ![".gcode", ".gco"].includes(extname(file).toLowerCase()))
    throw new Error("G-code path must identify an existing .gcode or .gco file");
  const details = await stat(file);
  const edgeBytes = 2_000_000;
  const handle = await open(file, "r");
  let sample: string;
  try {
    const headSize = Math.min(details.size, edgeBytes);
    const tailSize = Math.min(Math.max(0, details.size - headSize), edgeBytes);
    const head = Buffer.alloc(headSize);
    const tail = Buffer.alloc(tailSize);
    await handle.read(head, 0, headSize, 0);
    if (tailSize > 0)
      await handle.read(tail, 0, tailSize, details.size - tailSize);
    sample = `${head.toString("utf8")}\n${tail.toString("utf8")}`;
  } finally {
    await handle.close();
  }
  const time = sample.match(/^;\s*estimated printing time[^=]*=\s*(.+)$/mi)?.[1]?.trim();
  const filament = sample.match(/^;\s*(?:total )?filament used[^=]*=\s*(.+)$/mi)?.[1]?.trim();
  const warnings = [...sample.matchAll(/^;\s*(?:WARNING|warn)[: ]+(.+)$/gmi)].map(match => match[1].trim()).slice(0, 20);
  return { path: file, sha256: await sha256(file), bytes: details.size, estimatedTime: time, filament, warnings };
}

export async function environmentStatus(): Promise<Record<string, unknown>> {
  const [head, status, installedCustom, installedStable] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], 5_000),
    run("git", ["status", "--short", "--branch"], 5_000),
    run("pacman", ["-Q", "orca-slicer-k1-camera"], 5_000),
    run("pacman", ["-Q", "orca-slicer-bin"], 5_000)
  ]);
  return {
    repoRoot,
    commit: head.stdout,
    gitStatus: status.stdout,
    installedPackage: installedCustom.code === 0 ? installedCustom.stdout : (installedStable.code === 0 ? installedStable.stdout : null),
    rollbackPackage,
    rollbackAvailable: await exists(rollbackPackage),
    packageDirectory: packageRoot,
    globalCodexModified: false
  };
}

async function probePort(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return await new Promise(resolvePromise => {
    const socket = net.createConnection({ host, port });
    const finish = (value: boolean) => { socket.destroy(); resolvePromise(value); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function printerInfo(printer: PrinterProfile): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${baseHttpUrl(printer.host)}/info`, {
      headers: printer.apiKey ? { Authorization: `Bearer ${printer.apiKey}` } : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* preserve text */ }
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function identityFromInfo(info: Record<string, unknown>): { model?: string; mac?: string } {
  const body = info.body;
  if (!body || typeof body !== "object")
    return {};
  const record = body as Record<string, unknown>;
  return {
    model: typeof record.model === "string" ? record.model : undefined,
    mac: typeof record.mac === "string" ? record.mac.toLowerCase() : undefined
  };
}

export async function deviceStatus(profile?: string): Promise<Record<string, unknown>> {
  const printer = await resolvePrinter(profile);
  return { printer: { name: printer.name, host: printer.host }, info: await printerInfo(printer) };
}

export async function cameraProbe(profile?: string): Promise<Record<string, unknown>> {
  const printer = await resolvePrinter(profile);
  const ports = await Promise.all([80, 8000, 8080, 9999].map(async port => [port, await probePort(printer.hostname, port)] as const));
  return {
    printer: { name: printer.name, host: printer.host },
    signalingUrl: cameraSignalingUrl(printer.host),
    ports: Object.fromEntries(ports.map(([port, open]) => [String(port), open ? "open" : "closed"])),
    info: await printerInfo(printer),
    cloudUsed: false,
    publicIceServersUsed: false
  };
}

export async function buildAppImage(): Promise<Record<string, unknown>> {
  const command = await runScript("build-local-appimage.sh", [], 4 * 60 * 60 * 1000);
  const artifact = command.stdout.match(/^([0-9a-f]{64})\s+(.+\.AppImage)$/m);
  if (!artifact)
    throw new Error("Build completed without a checksummed AppImage artifact");
  return { artifactPath: resolve(artifact[2]), sha256: artifact[1], upstreamBase: "8500fcdccaa10b5099ac20d252af3a7c560046f1",
    warnings: command.stderr ? [command.stderr] : [], command };
}

export async function packageArch(): Promise<Record<string, unknown>> {
  const command = await runScript("package-arch.sh", [], 20 * 60 * 1000);
  const artifact = command.stdout.match(/^([0-9a-f]{64})\s+(.+\.pkg\.tar\.zst)$/m);
  if (!artifact)
    throw new Error("Packaging completed without a checksummed package artifact");
  return { artifactPath: resolve(artifact[2]), sha256: artifact[1], packageName: "orca-slicer-k1-camera",
    version: "2.4.2.k1webrtc3-1", warnings: command.stderr ? [command.stderr] : [], command };
}

export async function installCustom(packagePath?: string): Promise<Record<string, unknown>> {
  const command = await runScript("install-custom.sh", packagePath ? [resolve(packagePath)] : [], 10 * 60 * 1000);
  return { installedPackage: command.stdout.split("\n").find(line => line.startsWith("orca-slicer-k1-camera ")) ?? null,
    backupPath: command.stdout.match(/^backup=(.+)$/m)?.[1] ?? null, command };
}

export async function rollback(): Promise<Record<string, unknown>> {
  const command = await runScript("rollback.sh", [], 10 * 60 * 1000);
  return { restoredPackage: command.stdout.split("\n").find(line => line.startsWith("orca-slicer-bin ")) ?? null,
    rollbackPackage, sha256: await sha256(rollbackPackage), command };
}

export async function launchIsolated(projectPath?: string): Promise<Record<string, unknown>> {
  const args: string[] = [];
  if (projectPath) {
    const path = resolve(projectPath);
    if (!(await exists(path)))
      throw new Error(`Project does not exist: ${path}`);
    args.push(path);
  }
  const command = await runScript("launch-isolated.sh", args, 60_000);
  const fields = Object.fromEntries(command.stdout.split("\n").map(line => line.split(/=(.*)/s).slice(0, 2)).filter(pair => pair.length === 2));
  return { pid: Number(fields.pid), dataDirectory: fields.datadir, artifactPath: fields.appimage, projectPath: projectPath ? resolve(projectPath) : null, command };
}

export async function openProject(projectPath: string): Promise<Record<string, unknown>> {
  const path = resolve(projectPath);
  if (!(await exists(path)) || ![".3mf", ".stl", ".obj", ".step", ".stp", ".gcode"].includes(extname(path).toLowerCase()))
    throw new Error("Project path is missing or has an unsupported OrcaSlicer extension");
  const binary = await executable();
  const child = spawn(binary, [path], { cwd: repoRoot, detached: true, stdio: "ignore", shell: false });
  child.unref();
  return { opened: path, executable: binary, pid: child.pid };
}

export async function sliceModel(inputPath: string, machineProfile: string, processProfile: string,
                                 filamentProfiles: string[], plate = 0): Promise<Record<string, unknown>> {
  const input = resolve(inputPath);
  if (!(await exists(input)) || ![".3mf", ".stl", ".obj", ".step", ".stp"].includes(extname(input).toLowerCase()))
    throw new Error("Input model is missing or unsupported");
  if (!Number.isInteger(plate) || plate < 0)
    throw new Error("Plate must be a non-negative integer");

  const [machine, process, ...filaments] = await Promise.all([
    findProfile("machine", machineProfile),
    findProfile("process", processProfile),
    ...filamentProfiles.map(profile => findProfile("filament", profile))
  ]);
  const outputDir = join(automationRoot, "slices", `${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(outputDir, { recursive: true });
  const binary = await executable();
  const args = [
    "--slice", String(plate),
    "--outputdir", outputDir,
    "--load-settings", `${machine};${process}`,
    "--load-filaments", filaments.join(";"),
    input
  ];
  const result = await runRequired(binary, args, 60 * 60 * 1000);
  const outputs = (await allFiles(outputDir, ".gcode"));
  const summaries = await Promise.all(outputs.map(summarizeGcode));
  return { ...result, input, outputDir, command: { executable: binary, args }, outputs: summaries };
}

export async function uploadGcode(gcodePath: string, profile?: string, remoteName?: string): Promise<Record<string, unknown>> {
  const printer = await resolvePrinter(profile);
  const summary = await summarizeGcode(gcodePath);
  const name = (remoteName || basename(summary.path)).replace(/\s+/g, "_");
  if (!/^[A-Za-z0-9._-]+$/.test(name))
    throw new Error("Remote filename may contain only letters, digits, dot, underscore, and hyphen");

  const form = new FormData();
  const fileData = await readFile(summary.path);
  const fileBytes = new Uint8Array(fileData.byteLength);
  fileBytes.set(fileData);
  // Match CrealityPrint::upload for K1-family printers.
  form.append("path", "");
  form.append("file", new Blob([fileBytes.buffer]), name);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);
  try {
    const response = await fetch(`${baseHttpUrl(printer.host)}/upload/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: printer.apiKey ? { Authorization: `Bearer ${printer.apiKey}` } : undefined,
      body: form,
      signal: controller.signal
    });
    const responseBody = await response.text();
    if (!response.ok)
      throw new Error(`Upload failed with HTTP ${response.status}: ${responseBody.slice(0, 500)}`);
    return { printer: { name: printer.name, host: printer.host }, uploadName: name, responseStatus: response.status, summary };
  } finally {
    clearTimeout(timer);
  }
}

export async function preparePrint(gcodePath: string, profile?: string, uploadName?: string): Promise<Record<string, unknown>> {
  const printer = await resolvePrinter(profile);
  const summary = await summarizeGcode(gcodePath);
  const details = await stat(summary.path);
  const name = (uploadName || basename(summary.path)).replace(/\s+/g, "_");
  if (!/^[A-Za-z0-9._-]+$/.test(name))
    throw new Error("Upload filename is invalid");
  const info = await printerInfo(printer);
  if (info.ok !== true)
    throw new Error("Printer is not reachable; refusing to prepare a print confirmation");
  const printerIdentity = identityFromInfo(info);
  if (!printerIdentity.model && !printerIdentity.mac)
    throw new Error("Printer did not return a stable model or MAC identity");

  const id = randomUUID();
  const created = new Date();
  const expires = new Date(created.getTime() + 10 * 60 * 1000);
  const record: JobRecord = {
    version: 1,
    id,
    createdAt: created.toISOString(),
    expiresAt: expires.toISOString(),
    gcodePath: summary.path,
    sha256: summary.sha256,
    bytes: summary.bytes,
    mtimeMs: details.mtimeMs,
    uploadName: name,
    printerProfile: printer.name,
    printerHost: printer.host,
    printerIdentity,
    estimatedTime: summary.estimatedTime,
    filament: summary.filament,
    warnings: summary.warnings
  };
  await mkdir(jobsRoot, { recursive: true });
  await writeFile(join(jobsRoot, `${id}.json`), JSON.stringify(record, null, 2), { mode: 0o600, flag: "wx" });
  return { ...record, confirmationPhrase: `START ${id}` };
}

async function sendStartPrint(host: string, uploadName: string): Promise<void> {
  const hostname = trustedLanHostname(host);
  await new Promise<void>((resolvePromise, reject) => {
    const socket = new WebSocket(`ws://${hostname.includes(":") ? `[${hostname}]` : hostname}:9999/`);
    let sent = false;
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Printer start command timed out"));
    }, 10_000);
    const finish = () => { clearTimeout(timer); resolvePromise(); };
    socket.once("open", () => {
      sent = true;
      socket.send(JSON.stringify({
        method: "set",
        params: { opGcodeFile: `printprt:/usr/data/printer_data/gcodes/${uploadName}` }
      }), error => {
        if (error) { clearTimeout(timer); reject(error); }
        else setTimeout(finish, 1000);
      });
    });
    socket.once("message", finish);
    socket.once("close", () => { if (sent) finish(); else { clearTimeout(timer); reject(new Error("Printer closed before the start command was sent")); } });
    socket.once("error", error => { clearTimeout(timer); reject(error); });
  });
}

export async function startPrint(jobId: string, expectedSha256: string, confirmation: string): Promise<Record<string, unknown>> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId) || confirmation !== `START ${jobId}`)
    throw new Error("A fresh exact START <job-id> confirmation is required");
  const jobPath = join(jobsRoot, `${jobId}.json`);
  const claimedPath = join(jobsRoot, `${jobId}.starting`);
  await rename(jobPath, claimedPath);
  let record: JobRecord;
  try {
    record = JSON.parse(await readFile(claimedPath, "utf8")) as JobRecord;
    validateJobAuthorization(record, jobId, expectedSha256, Date.now());
    const details = await stat(record.gcodePath);
    const currentSha256 = await sha256(record.gcodePath);
    const printer = await resolvePrinter(record.printerProfile);
    const info = await printerInfo(printer);
    if (info.ok !== true)
      throw new Error("Printer is not reachable and ready for a confirmed start");
    const currentIdentity = identityFromInfo(info);
    validateJobState(record, {
      bytes: details.size,
      mtimeMs: details.mtimeMs,
      sha256: currentSha256,
      printerHost: printer.host,
      printerIdentity: currentIdentity
    });
    await sendStartPrint(printer.host, record.uploadName);
    return { started: true, jobId, sha256: record.sha256, uploadName: record.uploadName,
      printer: { name: printer.name, host: printer.host, identity: currentIdentity } };
  } finally {
    await unlink(claimedPath).catch(() => undefined);
  }
}
