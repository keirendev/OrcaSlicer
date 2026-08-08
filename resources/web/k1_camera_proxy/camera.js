(function () {
    "use strict";

    const video = document.querySelector("video");
    const status = document.querySelector("#status");
    const targetLatencySeconds = 0.16;
    const maximumLatencySeconds = 0.28;
    const retainedBufferSeconds = 1.50;
    const reconnectDelayMs = 1000;
    const stallTimeoutMs = 3500;
    const maximumQueueBytes = 8 * 1024 * 1024;

    let generation = 0;
    let stopped = false;
    let reconnectTimer = null;
    let watchdogTimer = null;
    let telemetryTimer = null;
    let socket = null;
    let mediaSource = null;
    let sourceBuffer = null;
    let mediaObjectUrl = "";
    let queue = [];
    let queueBytes = 0;
    let sourceOpen = false;
    let mseRequested = false;
    let started = false;
    let lastBinaryAt = 0;
    let nextPruneAt = 0;
    let reportedPlaying = false;
    let retimer = null;

    function report(type, detail) {
        if (window.parent !== window) {
            window.parent.postMessage(
                Object.assign({source: "orca-k1-camera", type: type}, detail || {}),
                location.origin
            );
        }
    }

    function showStatus(message, failed) {
        status.textContent = message;
        status.style.color = failed ? "#ff8a80" : "#ddd";
        status.style.display = "flex";
    }

    function hideStatus() {
        status.style.display = "none";
    }

    function bufferedRange() {
        if (!sourceBuffer || !sourceBuffer.buffered || sourceBuffer.buffered.length === 0)
            return null;
        const index = sourceBuffer.buffered.length - 1;
        return {
            start: sourceBuffer.buffered.start(index),
            end: sourceBuffer.buffered.end(index)
        };
    }

    function keepAtLiveEdge() {
        const range = bufferedRange();
        if (!range)
            return;

        const desiredTime = Math.max(range.start, range.end - targetLatencySeconds);
        const latency = range.end - video.currentTime;
        if (!started || video.currentTime < range.start || latency > maximumLatencySeconds) {
            video.currentTime = desiredTime;
            started = true;
        }

        // Never slow the camera down to build a multi-second MSE buffer. The
        // stock go2rtc viewer varies playbackRate with buffer depth, which is
        // visibly uneven with the K1's ~15 fps RTP timing.
        if (video.playbackRate !== 1)
            video.playbackRate = 1;
        if (video.paused)
            video.play().catch(function () {});
    }

    function pump() {
        if (!sourceBuffer || sourceBuffer.updating)
            return;

        keepAtLiveEdge();

        if (queue.length > 0) {
            const next = queue.shift();
            queueBytes -= next.byteLength;
            try {
                sourceBuffer.appendBuffer(next);
            } catch (error) {
                reconnect("Camera decoder lost the live stream. Reconnecting…");
            }
            return;
        }

        const now = performance.now();
        const range = bufferedRange();
        if (range && now >= nextPruneAt && range.end - range.start > retainedBufferSeconds) {
            nextPruneAt = now + 1000;
            try {
                sourceBuffer.remove(range.start, range.end - retainedBufferSeconds);
            } catch (error) {
                // A later update cycle can retry pruning. Playback remains live.
            }
        }
    }

    function requestMse(activeGeneration) {
        if (activeGeneration !== generation || mseRequested || !sourceOpen || !socket || socket.readyState !== WebSocket.OPEN)
            return;
        mseRequested = true;
        socket.send(JSON.stringify({
            type: "mse",
            value: "avc1.42E01F,avc1.640029,avc1.64002A,avc1.640033"
        }));
    }

    function beginTelemetry(activeGeneration) {
        clearInterval(telemetryTimer);
        telemetryTimer = setInterval(function () {
            if (activeGeneration !== generation)
                return;
            const range = bufferedRange();
            const quality = typeof video.getVideoPlaybackQuality === "function" ? video.getVideoPlaybackQuality() : null;
            report("telemetry", {
                width: video.videoWidth,
                height: video.videoHeight,
                latencyMs: range ? Math.max(0, Math.round((range.end - video.currentTime) * 1000)) : null,
                droppedFrames: quality ? quality.droppedVideoFrames : null,
                totalFrames: quality ? quality.totalVideoFrames : null
            });
        }, 2000);
    }

    function cleanup() {
        clearTimeout(reconnectTimer);
        clearInterval(watchdogTimer);
        clearInterval(telemetryTimer);
        reconnectTimer = null;
        watchdogTimer = null;
        telemetryTimer = null;

        if (socket) {
            socket.onopen = null;
            socket.onmessage = null;
            socket.onerror = null;
            socket.onclose = null;
            socket.close();
            socket = null;
        }

        if (sourceBuffer) {
            sourceBuffer.removeEventListener("updateend", pump);
            sourceBuffer = null;
        }
        if (mediaSource && mediaSource.readyState === "open") {
            try { mediaSource.endOfStream(); } catch (error) {}
        }
        mediaSource = null;
        if (mediaObjectUrl) {
            URL.revokeObjectURL(mediaObjectUrl);
            mediaObjectUrl = "";
        }
        video.removeAttribute("src");
        video.load();

        queue = [];
        queueBytes = 0;
        sourceOpen = false;
        mseRequested = false;
        started = false;
        lastBinaryAt = 0;
        nextPruneAt = 0;
        reportedPlaying = false;
        retimer = null;
    }

    function reconnect(message) {
        if (stopped)
            return;
        const nextGeneration = ++generation;
        cleanup();
        showStatus(message || "Camera disconnected. Reconnecting…", true);
        report("disconnected", {message: status.textContent});
        reconnectTimer = setTimeout(function () {
            if (!stopped && nextGeneration === generation)
                connect();
        }, reconnectDelayMs);
    }

    function connect() {
        if (stopped || !("MediaSource" in window)) {
            if (!("MediaSource" in window)) {
                showStatus("This WebView cannot decode the K1 live stream.", true);
                report("error", {message: status.textContent});
            }
            return;
        }

        cleanup();
        const activeGeneration = ++generation;
        showStatus("Connecting to K1 camera…", false);

        if (typeof window.OrcaK1Fmp4Retime !== "function") {
            showStatus("The K1 camera timing repair module is unavailable.", true);
            report("error", {message: status.textContent});
            return;
        }
        retimer = new window.OrcaK1Fmp4Retime(90000, 15);

        mediaSource = new MediaSource();
        mediaObjectUrl = URL.createObjectURL(mediaSource);
        video.controls = false;
        video.muted = true;
        video.playsInline = true;
        video.disablePictureInPicture = true;
        video.src = mediaObjectUrl;
        video.play().catch(function () {});

        mediaSource.addEventListener("sourceopen", function () {
            if (activeGeneration !== generation)
                return;
            sourceOpen = true;
            requestMse(activeGeneration);
        }, {once: true});

        const scheme = location.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(scheme + "//" + location.host + "/api/ws?src=k1_source");
        socket.binaryType = "arraybuffer";
        socket.onopen = function () {
            if (activeGeneration === generation)
                requestMse(activeGeneration);
        };
        socket.onmessage = function (event) {
            if (activeGeneration !== generation)
                return;

            if (typeof event.data === "string") {
                let message;
                try { message = JSON.parse(event.data); } catch (error) { return; }
                if (message.type === "error") {
                    reconnect("K1 camera stream unavailable. Reconnecting…");
                    return;
                }
                if (message.type !== "mse" || sourceBuffer)
                    return;
                if (typeof message.value !== "string" || !/^video\/mp4;\s*codecs=/i.test(message.value) ||
                    !MediaSource.isTypeSupported(message.value)) {
                    reconnect("K1 camera codec is not supported by this WebView.");
                    return;
                }
                try {
                    sourceBuffer = mediaSource.addSourceBuffer(message.value);
                    sourceBuffer.mode = "segments";
                    sourceBuffer.addEventListener("updateend", pump);
                } catch (error) {
                    reconnect("Unable to initialize the K1 camera decoder.");
                }
                return;
            }

            if (!(event.data instanceof ArrayBuffer) || !sourceBuffer)
                return;
            lastBinaryAt = performance.now();
            // The K1 emits alternating ~1 ms and ~700 ms sample durations even
            // though frames arrive at a steady 15 fps. Rewrite only the fMP4
            // timing boxes; encoded H.264 bytes stay untouched/full quality.
            const fragment = retimer.rewrite(event.data);
            queue.push(fragment);
            queueBytes += fragment.byteLength;
            if (queueBytes > maximumQueueBytes) {
                reconnect("Camera fell behind the live stream. Reconnecting…");
                return;
            }
            pump();
        };
        socket.onerror = function () {
            if (activeGeneration === generation)
                reconnect("Camera connection failed. Reconnecting…");
        };
        socket.onclose = function () {
            if (activeGeneration === generation)
                reconnect("Camera disconnected. Reconnecting…");
        };

        watchdogTimer = setInterval(function () {
            if (activeGeneration !== generation)
                return;
            if (lastBinaryAt > 0 && performance.now() - lastBinaryAt > stallTimeoutMs)
                reconnect("Camera stream stalled. Reconnecting…");
            else
                keepAtLiveEdge();
        }, 250);
        beginTelemetry(activeGeneration);
    }

    video.addEventListener("playing", function () {
        hideStatus();
        if (!reportedPlaying) {
            reportedPlaying = true;
            report("playing", {
                width: video.videoWidth,
                height: video.videoHeight,
                transport: "mse-low-latency",
                targetLatencyMs: Math.round(targetLatencySeconds * 1000)
            });
        }
    });
    video.addEventListener("loadeddata", keepAtLiveEdge);
    video.addEventListener("error", function () {
        reconnect("Camera decoder failed. Reconnecting…");
    });
    window.addEventListener("pagehide", function () {
        stopped = true;
        generation++;
        cleanup();
    }, {once: true});

    connect();
}());
