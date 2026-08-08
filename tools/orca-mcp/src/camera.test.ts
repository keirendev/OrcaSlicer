import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { join } from "node:path";
import { repoRoot } from "./operations.js";

const script = await readFile(join(repoRoot, "resources", "web", "k1_camera_webrtc.js"), "utf8");
const handlerSource = await readFile(join(repoRoot, "src", "slic3r", "GUI", "PrinterWebViewHandler.cpp"), "utf8");
const nativePreviewUrl = "http://127.0.0.1:19840/stream.html?src=k1_source&mode=mse&background=true";

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

test("camera helper passes native H.264 through MSE without MJPEG polling or transcoding", () => {
  assert.match(handlerSource, /modules: \[api, ws, rtsp, webrtc, mp4\]/);
  assert.match(handlerSource, /allow_paths: \[\\\"\/\\\", \\\"\/api\/ws\\\"\]/);
  assert.match(handlerSource, /k1_source: \\\"video=h264\\\"/);
  assert.match(handlerSource, /stream\.html\?src=k1_source&mode=mse&background=true/);
  assert.doesNotMatch(handlerSource, /ffmpeg:k1_source|frame\.jpeg|raw=-r|k1_orca/);
});
