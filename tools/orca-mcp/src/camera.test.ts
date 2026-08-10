import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { join } from "node:path";
import { repoRoot } from "./operations.js";

const script = await readFile(join(repoRoot, "resources", "web", "k1_camera_webrtc.js"), "utf8");
const playerHtml = await readFile(join(repoRoot, "resources", "web", "k1_camera_proxy", "camera.html"), "utf8");
const playerScript = await readFile(join(repoRoot, "resources", "web", "k1_camera_proxy", "camera.js"), "utf8");
const retimeScript = await readFile(join(repoRoot, "resources", "web", "k1_camera_proxy", "fmp4_retime.js"), "utf8");
const webUiBootstrap = await readFile(join(repoRoot, "resources", "web", "k1_webui_bootstrap.js"), "utf8");
const handlerSource = await readFile(join(repoRoot, "src", "slic3r", "GUI", "PrinterWebViewHandler.cpp"), "utf8");
const nativePreviewUrl = "http://127.0.0.1:19840/camera.html";

function page(legacyWorks: boolean) {
  const dom = new JSDOM("<div class='comp-CameraShow'><div class='content'><img class='camera-image'></div></div>", {
    runScripts: "dangerously",
    url: "http://192.168.50.42/"
  });
  const { window } = dom;
  Object.defineProperty(window, "__orcaCrealityCameraTestDelay", { value: 0, configurable: true });
  Object.defineProperty(window, "__orcaCrealityCameraTestRetryDelay", { value: 0, configurable: true });
  const image = window.document.querySelector("img")!;
  Object.defineProperty(image, "complete", { value: true });
  Object.defineProperty(image, "naturalWidth", { value: legacyWorks ? 640 : 0 });
  return dom;
}

interface BridgeRequest { id: string; method: string }

function installBridge(dom: JSDOM, messages: BridgeRequest[], respond: (request: BridgeRequest, attempt: number) => void) {
  Object.defineProperty(dom.window, "orcaCamera", { value: {
    postMessage(payload: string) {
      const request = JSON.parse(payload) as BridgeRequest;
      messages.push(request);
      respond(request, messages.length);
    }
  }});
}

function ready(dom: JSDOM, id: string, url = nativePreviewUrl) {
  dom.window.dispatchEvent(new dom.window.CustomEvent("orca:creality-camera-ready", {
    detail: { id, ok: true, url }
  }));
}

function cameraMessage(dom: JSDOM, type: string, message?: string) {
  const frame = dom.window.document.querySelector("iframe[data-orca-webrtc-video]") as HTMLIFrameElement;
  assert.ok(frame);
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
    data: { source: "orca-k1-camera", type, message },
    origin: "http://127.0.0.1:19840",
    source: frame.contentWindow
  }));
}

test("camera bridge leaves a working legacy camera untouched", async () => {
  const dom = page(true);
  const messages: BridgeRequest[] = [];
  installBridge(dom, messages, () => {});
  dom.window.eval(script);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(messages.length, 0);
  assert.ok(dom.window.document.querySelector("img.camera-image"));
  (dom.window as unknown as { __orcaCrealityCamera: { stop(): void } }).__orcaCrealityCamera.stop();
  dom.window.close();
});

test("camera bridge replaces a failed legacy camera with a loopback preview", async () => {
  const dom = page(false);
  const messages: BridgeRequest[] = [];
  installBridge(dom, messages, request => setTimeout(() => ready(dom, request.id), 0));

  dom.window.eval(script);
  dom.window.eval(script);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(messages[0]?.method, "creality_camera_start");
  assert.equal(messages.length, 1, "repeated Device load must not create a second bridge");
  const frame = dom.window.document.querySelector("iframe[data-orca-webrtc-video]") as HTMLIFrameElement;
  assert.ok(frame);
  assert.equal(frame.src, nativePreviewUrl);
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-same-origin");
  cameraMessage(dom, "playing");
  assert.equal(dom.window.document.querySelector("[data-orca-webrtc-status]"), null);
  assert.equal(script.includes("stun:"), false);
  (dom.window as unknown as { __orcaCrealityCamera: { stop(): void } }).__orcaCrealityCamera.stop();
  dom.window.close();
});

test("camera bridge accepts a C++-injected loopback endpoint without browser IPC", async () => {
  const dom = page(false);
  const messages: BridgeRequest[] = [];
  installBridge(dom, messages, () => {});
  Object.defineProperty(dom.window, "__orcaCrealityCameraBridge", {
    value: { ok: true, url: nativePreviewUrl }
  });
  dom.window.eval(script);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(messages.length, 0);
  assert.equal((dom.window.document.querySelector("iframe[data-orca-webrtc-video]") as HTMLIFrameElement).src,
    nativePreviewUrl);
  (dom.window as unknown as { __orcaCrealityCamera: { stop(): void } }).__orcaCrealityCamera.stop();
  dom.window.close();
});

test("camera bridge ignores stale responses and correlates the active request", async () => {
  const dom = page(false);
  const messages: BridgeRequest[] = [];
  installBridge(dom, messages, request => setTimeout(() => {
    ready(dom, "stale-request", "http://127.0.0.1:1111/camera.html");
    ready(dom, request.id);
  }, 0));
  dom.window.eval(script);
  await new Promise(resolve => setTimeout(resolve, 40));
  const frame = dom.window.document.querySelector("iframe[data-orca-webrtc-video]") as HTMLIFrameElement;
  assert.equal(frame.src, nativePreviewUrl);
  (dom.window as unknown as { __orcaCrealityCamera: { stop(): void } }).__orcaCrealityCamera.stop();
  dom.window.close();
});

test("camera bridge rejects non-loopback helper URLs", async () => {
  const dom = page(false);
  Object.defineProperty(dom.window, "__orcaCrealityCameraTestRetryDelay", { value: 60_000 });
  const messages: BridgeRequest[] = [];
  installBridge(dom, messages, request => setTimeout(() => ready(dom, request.id, "http://example.com/camera.html"), 0));
  dom.window.eval(script);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(dom.window.document.querySelector("iframe[data-orca-webrtc-video]"), null);
  assert.match(dom.window.document.querySelector("[data-orca-webrtc-status]")?.textContent || "", /unsafe URL/i);
  (dom.window as unknown as { __orcaCrealityCamera: { stop(): void } }).__orcaCrealityCamera.stop();
  dom.window.close();
});

test("camera bridge times out without accepting a late response", async () => {
  const dom = page(false);
  Object.defineProperty(dom.window, "__orcaCrealityCameraTestSignalingTimeout", { value: 5 });
  Object.defineProperty(dom.window, "__orcaCrealityCameraTestRetryDelay", { value: 60_000 });
  const messages: BridgeRequest[] = [];
  installBridge(dom, messages, () => {});
  dom.window.eval(script);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(dom.window.document.querySelector("[data-orca-webrtc-status]")?.textContent || "", /timed out/i);
  ready(dom, messages[0]!.id);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(dom.window.document.querySelector("iframe[data-orca-webrtc-video]"), null);
  (dom.window as unknown as { __orcaCrealityCamera: { stop(): void } }).__orcaCrealityCamera.stop();
  dom.window.close();
});

test("camera bridge reconnects after proxy failure and tears down on navigation", async () => {
  const dom = page(false);
  const messages: BridgeRequest[] = [];
  installBridge(dom, messages, request => setTimeout(() => ready(dom, request.id), 0));
  dom.window.eval(script);
  await new Promise(resolve => setTimeout(resolve, 40));
  cameraMessage(dom, "error", "decoder failed");
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(messages.length, 2);
  assert.ok(dom.window.document.querySelector("iframe[data-orca-webrtc-video]"));
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  assert.equal(dom.window.document.querySelector("iframe[data-orca-webrtc-video]"), null);
  dom.window.close();
});

test("camera bridge tolerates a missing camera DOM", async () => {
  const missing = new JSDOM("<div></div>", { runScripts: "dangerously", url: "http://192.168.50.42/" });
  Object.defineProperty(missing.window, "__orcaCrealityCameraTestDelay", { value: 0 });
  const messages: BridgeRequest[] = [];
  installBridge(missing, messages, () => {});
  missing.window.eval(script);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(messages.length, 0);
  missing.window.dispatchEvent(new missing.window.Event("pagehide"));
  assert.doesNotThrow(() => (missing.window as unknown as { __orcaCrealityCamera: { considerCamera(): void } }).__orcaCrealityCamera.considerCamera());
  missing.window.close();
});

test("camera helper passes native H.264 to the dedicated low-latency player without transcoding", () => {
  assert.match(handlerSource, /modules: \[api, ws, rtsp, webrtc, mp4\]/);
  assert.match(handlerSource, /static_dir:/);
  assert.match(handlerSource, /allow_paths: \[\\\"\/\\\", \\\"\/api\/ws\\\"\]/);
  assert.match(handlerSource, /k1_source: \\\"video=h264\\\"/);
  assert.match(handlerSource, /\/camera\.html/);
  assert.doesNotMatch(handlerSource, /ffmpeg:k1_source|frame\.jpeg|raw=-r|k1_orca/);
});

test("camera helper is reaped on navigation and terminated if OrcaSlicer exits", () => {
  assert.match(handlerSource, /PR_SET_PDEATHSIG, SIGTERM/);
  assert.match(handlerSource, /getppid\(\) != parent_pid/);
  assert.match(handlerSource, /::kill\(pid, SIGTERM\)/);
  assert.match(handlerSource, /m_helper_process->terminate\(process_error\)/);
  assert.match(handlerSource, /m_helper_process->running\(process_error\)/);
  assert.doesNotMatch(handlerSource, /wxKILL_CHILDREN|wxExecute\(/);
});

test("dedicated player is video-only and holds a bounded live-edge latency at normal speed", () => {
  const player = new JSDOM(playerHtml).window.document.querySelector("video") as HTMLVideoElement;
  assert.ok(player);
  assert.equal(player.controls, false);
  assert.equal(player.autoplay, true);
  assert.equal(player.hasAttribute("muted"), true);
  assert.match(playerScript, /video\.muted = true/);
  assert.equal(player.hasAttribute("playsinline"), true);
  assert.doesNotMatch(playerHtml, /Live Broadcast|>MSE<|fullscreen|settings|volume/i);
  assert.match(playerScript, /targetLatencySeconds = 0\.16/);
  assert.match(playerScript, /maximumLatencySeconds = 0\.28/);
  assert.match(playerScript, /video\.currentTime = desiredTime/);
  assert.match(playerScript, /video\.playbackRate = 1/);
  assert.match(playerScript, /sourceBuffer\.mode = "segments"/);
  assert.match(playerScript, /retimer\.rewrite\(event\.data\)/);
  assert.doesNotMatch(playerScript, /playbackRate\s*=\s*(?:gap|latency)/);
});

test("fMP4 retimer replaces corrupt K1 sample durations with a continuous 15 fps timeline", () => {
  const dom = new JSDOM("<div></div>", { runScripts: "dangerously" });
  dom.window.eval(retimeScript);
  const Retime = (dom.window as unknown as {
    OrcaK1Fmp4Retime: new (timescale: number, fps: number) => { rewrite(data: ArrayBuffer): ArrayBuffer }
  }).OrcaK1Fmp4Retime;
  const retimer = new Retime(90000, 15);

  function fragment(duration: number, decodeTime: number): ArrayBuffer {
    const data = new dom.window.ArrayBuffer(100);
    const view = new dom.window.DataView(data);
    const type = (offset: number, value: string) => {
      for (let index = 0; index < 4; index++)
        view.setUint8(offset + 4 + index, value.charCodeAt(index));
    };
    view.setUint32(0, 100); type(0, "moof");
    view.setUint32(8, 16); type(8, "mfhd");
    view.setUint32(24, 76); type(24, "traf");
    view.setUint32(32, 28); type(32, "tfhd");
    view.setUint8(41, 0x02); view.setUint8(43, 0x38);
    view.setUint32(44, 1); view.setUint32(48, duration); view.setUint32(52, 1234); view.setUint32(56, 0);
    view.setUint32(60, 20); type(60, "tfdt");
    view.setUint8(68, 1); view.setUint32(72, 0); view.setUint32(76, decodeTime);
    view.setUint32(80, 20); type(80, "trun");
    view.setUint8(91, 1); view.setUint32(92, 1); view.setUint32(96, 108);
    return data as unknown as ArrayBuffer;
  }

  const first = fragment(91, 123456);
  const second = fragment(77011, 123547);
  retimer.rewrite(first);
  retimer.rewrite(second);
  const firstView = new dom.window.DataView(first as unknown as globalThis.ArrayBuffer);
  const secondView = new dom.window.DataView(second as unknown as globalThis.ArrayBuffer);
  assert.equal(firstView.getUint32(48), 6000);
  assert.equal(firstView.getUint32(76), 0);
  assert.equal(secondView.getUint32(48), 6000);
  assert.equal(secondView.getUint32(76), 6000);
  dom.window.close();
});

test("bed-mesh sanitizer repairs the malformed K1 payload without changing coordinates", () => {
  const dom = new JSDOM("<div></div>", { runScripts: "dangerously", url: "http://192.168.50.42/" });
  dom.window.eval(webUiBootstrap);
  const sanitizer = (dom.window as unknown as {
    __orcaCrealityBedMeshSanitizer: { sanitizeMessageData(data: string): string }
  }).__orcaCrealityBedMeshSanitizer;
  assert.ok(sanitizer);

  const payload = {
    probedMatrix: {
      num: 8,
      val: [
        { x: "5.000000", y: "5.000000", z: "*# \t0.479687" },
        { x: "63.000000", y: "5.000000", z: "0.109219\n#*# \t0.457719" },
        { x: "5.000000", y: "295.000000", z: "0.019594" },
        { x: "63.000000", y: "295.000000", z: ".019594" },
        { x: "121.000000", y: "295.000000", z: "019594" },
        { x: "179.000000", y: "295.000000", z: "19594" },
        { x: "237.000000", y: "295.000000", z: "9594" },
        { x: "295.000000", y: "295.000000", z: "594" }
      ]
    }
  };
  const repaired = JSON.parse(sanitizer.sanitizeMessageData(JSON.stringify(payload))) as typeof payload;
  assert.deepEqual(repaired.probedMatrix.val.map(point => point.x), payload.probedMatrix.val.map(point => point.x));
  assert.deepEqual(repaired.probedMatrix.val.slice(2).map(point => point.z), [
    "0.019594", "0.019594", "0.019594", "0.019594", "0.019594", "0.019594"
  ]);
  assert.ok(repaired.probedMatrix.val.every(point => Math.abs(Number(point.z)) <= 5));
  dom.window.close();
});

test("bed-mesh sanitizer reconstructs values concatenated across saved mesh rows", () => {
  const dom = new JSDOM("<div></div>", { runScripts: "dangerously", url: "http://192.168.50.42/" });
  dom.window.eval(webUiBootstrap);
  const sanitizer = (dom.window as unknown as {
    __orcaCrealityBedMeshSanitizer: { sanitizeMessageData(data: string): string }
  }).__orcaCrealityBedMeshSanitizer;
  const values = [
    "*# \\t0.479687", "0.355656", "0.268344", "0.181656", "0.094969", "0.109219\n#*# \\t0.457719",
    "0.337594", "0.252000", "0.185562", "0.170793", "0.120469\n#*# \\t0.422469", "0.333594"
  ];
  const payload = {
    probedMatrix: {
      num: values.length,
      val: values.map((z, index) => ({ x: String((index % 6) * 58 + 5), y: String(Math.floor(index / 6) * 58 + 5), z }))
    }
  };
  const repaired = JSON.parse(sanitizer.sanitizeMessageData(JSON.stringify(payload))) as typeof payload;
  assert.deepEqual(repaired.probedMatrix.val.map(point => point.z), [
    "0.479687", "0.355656", "0.268344", "0.181656", "0.094969", "0.109219",
    "0.457719", "0.337594", "0.252000", "0.185562", "0.170793", "0.120469"
  ]);
  dom.window.close();
});

test("bed-mesh guard is installed at document start and scoped to the printer websocket", () => {
  assert.match(handlerSource, /k1_webui_bootstrap\.js/);
  assert.match(handlerSource, /wxWEBVIEW_INJECT_AT_DOCUMENT_START/);
  assert.match(webUiBootstrap, /parsed\.hostname === location\.hostname && parsed\.port === \"9999\"/);
  assert.doesNotMatch(webUiBootstrap, /\.send\s*\(/);
});

test("Creality bed-mesh chart labels are normalized to English", async () => {
  const dom = new JSDOM("<div id='app'></div>", {
    runScripts: "dangerously",
    url: "http://192.168.50.42/"
  });
  dom.window.eval(webUiBootstrap);
  const tooltip = dom.window.document.createElement("div");
  tooltip.textContent = "探测点矩阵 - x: 237.000000";
  dom.window.document.querySelector("#app")!.appendChild(tooltip);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(tooltip.textContent, "Probe point matrix - x: 237.000000");

  tooltip.textContent = "参考平面";
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(tooltip.textContent, "Reference plane");
  assert.equal(dom.window.document.documentElement.lang, "en");
  dom.window.close();
});
