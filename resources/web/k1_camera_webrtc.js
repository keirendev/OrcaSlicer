(function () {
    "use strict";

    if (window.__orcaCrealityCameraInstalled)
        return;
    window.__orcaCrealityCameraInstalled = true;

    const state = {
        observer: null,
        retryTimer: null,
        requestId: null,
        frame: null,
        stopped: false,
        starting: false
    };
    const legacyWaitMs = Number.isFinite(window.__orcaCrealityCameraTestDelay) ? window.__orcaCrealityCameraTestDelay : 3000;
    const retryWaitMs = Number.isFinite(window.__orcaCrealityCameraTestRetryDelay) ? window.__orcaCrealityCameraTestRetryDelay : 3000;
    const bridgeTimeoutMs = Number.isFinite(window.__orcaCrealityCameraTestSignalingTimeout) ? window.__orcaCrealityCameraTestSignalingTimeout : 12000;

    function cameraContainer() {
        return document.querySelector(".comp-CameraShow .content");
    }

    function legacyCameraWorks(container) {
        const image = container && container.querySelector("img.camera-image");
        return Boolean(image && image.complete && image.naturalWidth > 0);
    }

    function setStatus(container, message, failed) {
        let status = container.querySelector("[data-orca-webrtc-status]");
        if (!status) {
            status = document.createElement("div");
            status.dataset.orcaWebrtcStatus = "true";
            status.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center;background:#111;color:#ddd;font:13px sans-serif;z-index:2";
            container.appendChild(status);
        }
        status.textContent = message;
        status.style.color = failed ? "#ff8a80" : "#ddd";
    }

    function closeFrame() {
        if (state.frame) {
            state.frame.remove();
            state.frame = null;
        }
        state.starting = false;
        state.requestId = null;
    }

    function scheduleRetry(container, message) {
        closeFrame();
        if (state.stopped || !document.documentElement.contains(container))
            return;
        setStatus(container, message || "Camera disconnected. Reconnecting…", true);
        clearTimeout(state.retryTimer);
        state.retryTimer = setTimeout(function () { startCamera(container); }, retryWaitMs);
    }

    function requestBridge() {
        const direct = window.__orcaCrealityCameraBridge;
        if (direct && typeof direct === "object") {
            if (direct.ok)
                return Promise.resolve(direct.url);
            return Promise.reject(new Error(direct.error || "Camera bridge failed"));
        }

        if (!window.orcaCamera || typeof window.orcaCamera.postMessage !== "function")
            return Promise.reject(new Error("OrcaSlicer camera bridge is unavailable"));

        const id = "k1-camera-" + Date.now() + "-" + Math.random().toString(16).slice(2);
        state.requestId = id;
        return new Promise(function (resolve, reject) {
            const timeout = setTimeout(function () {
                window.removeEventListener("orca:creality-camera-ready", receive);
                reject(new Error("Camera bridge timed out"));
            }, bridgeTimeoutMs);
            const receive = function (event) {
                const detail = event.detail || {};
                if (detail.id !== id)
                    return;
                clearTimeout(timeout);
                window.removeEventListener("orca:creality-camera-ready", receive);
                if (!detail.ok)
                    reject(new Error(detail.error || "Camera bridge failed"));
                else
                    resolve(detail.url);
            };
            window.addEventListener("orca:creality-camera-ready", receive);
            window.orcaCamera.postMessage(JSON.stringify({method: "creality_camera_start", id: id}));
        });
    }

    async function startCamera(container) {
        if (state.stopped || state.starting || state.frame || !document.documentElement.contains(container))
            return;
        state.starting = true;

        try {
            container.style.position = "relative";
            container.innerHTML = "";
            setStatus(container, "Connecting to K1 camera…", false);
            const url = await requestBridge();
            if (state.stopped || !document.documentElement.contains(container))
                return;
            const parsed = new URL(url);
            if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1")
                throw new Error("Camera bridge returned an unsafe URL");

            const frame = document.createElement("iframe");
            frame.dataset.orcaWebrtcVideo = "true";
            frame.title = "K1 camera preview";
            frame.allow = "autoplay";
            frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
            frame.style.cssText = "width:100%;height:100%;min-height:220px;display:block;border:0;background:#000";
            frame.src = parsed.href;
            state.frame = frame;
            frame.addEventListener("load", function () {
                if (state.frame !== frame)
                    return;
                const status = container.querySelector("[data-orca-webrtc-status]");
                if (status)
                    status.remove();
                state.starting = false;
            }, {once:true});
            container.insertBefore(frame, container.firstChild);

            const message = function (event) {
                if (!state.frame || event.source !== state.frame.contentWindow || event.origin !== parsed.origin)
                    return;
                const detail = event.data || {};
                if (detail.source !== "orca-k1-camera")
                    return;
                if (detail.type === "playing") {
                    const status = container.querySelector("[data-orca-webrtc-status]");
                    if (status)
                        status.remove();
                    state.starting = false;
                } else if (detail.type === "error") {
                    window.removeEventListener("message", message);
                    scheduleRetry(container, detail.message);
                }
            };
            window.addEventListener("message", message);
            frame.addEventListener("error", function () {
                window.removeEventListener("message", message);
                scheduleRetry(container, "Camera bridge page failed to load");
            }, {once:true});
        } catch (error) {
            scheduleRetry(container, error && error.message ? error.message : "Unable to connect to the K1 camera");
        }
    }

    function considerCamera() {
        if (state.stopped)
            return;
        const container = cameraContainer();
        if (!container || container.dataset.orcaWebrtcChecked)
            return;
        container.dataset.orcaWebrtcChecked = "true";
        setTimeout(function () {
            if (!state.stopped && document.documentElement.contains(container) && !legacyCameraWorks(container))
                startCamera(container);
        }, legacyWaitMs);
    }

    function stop() {
        state.stopped = true;
        clearTimeout(state.retryTimer);
        if (state.observer)
            state.observer.disconnect();
        closeFrame();
    }

    state.observer = new MutationObserver(considerCamera);
    state.observer.observe(document.documentElement, {childList:true, subtree:true});
    window.addEventListener("pagehide", stop, {once:true});
    window.addEventListener("beforeunload", stop, {once:true});
    window.__orcaCrealityCamera = {considerCamera: considerCamera, stop: stop};
    considerCamera();
}());
