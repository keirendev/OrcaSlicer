(function () {
    "use strict";

    if (window.top !== window || window.__orcaCrealityWebUiBootstrapInstalled)
        return;
    window.__orcaCrealityWebUiBootstrapInstalled = true;

    const NativeWebSocket = window.WebSocket;
    const nativeOnMessage = Object.getOwnPropertyDescriptor(NativeWebSocket.prototype, "onmessage");
    const originalOnMessage = Symbol("orcaOriginalOnMessage");
    const wrappedOnMessage = Symbol("orcaWrappedOnMessage");
    const wrappedListeners = new WeakMap();
    const crealityEnglishText = new Map([
        ["探测点矩阵", "Probe point matrix"],
        ["参考平面", "Reference plane"]
    ]);

    function translateEnglishText(value) {
        let translated = String(value);
        crealityEnglishText.forEach(function (english, chinese) {
            translated = translated.split(chinese).join(english);
        });
        return translated;
    }

    function normalizeEnglishContent(root) {
        if (!root)
            return;
        if (root.nodeType === Node.TEXT_NODE) {
            const translated = translateEnglishText(root.nodeValue || "");
            if (translated !== root.nodeValue)
                root.nodeValue = translated;
            return;
        }
        if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE)
            return;
        if (root.nodeType === Node.ELEMENT_NODE && /^(SCRIPT|STYLE|TEXTAREA)$/i.test(root.tagName))
            return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let textNode;
        while ((textNode = walker.nextNode())) {
            if (textNode.parentElement && /^(SCRIPT|STYLE|TEXTAREA)$/i.test(textNode.parentElement.tagName))
                continue;
            const translated = translateEnglishText(textNode.nodeValue || "");
            if (translated !== textNode.nodeValue)
                textNode.nodeValue = translated;
        }
    }

    function installEnglishNormalizer() {
        if (!document.documentElement || window.__orcaCrealityEnglishObserver)
            return;
        document.documentElement.lang = "en";
        normalizeEnglishContent(document.documentElement);
        const observer = new MutationObserver(function (records) {
            records.forEach(function (record) {
                if (record.type === "characterData")
                    normalizeEnglishContent(record.target);
                else
                    record.addedNodes.forEach(normalizeEnglishContent);
            });
        });
        observer.observe(document.documentElement, {childList: true, subtree: true, characterData: true});
        window.__orcaCrealityEnglishObserver = observer;
    }

    if (document.documentElement)
        installEnglishNormalizer();
    else
        document.addEventListener("DOMContentLoaded", installEnglishNormalizer, {once: true});

    function finiteCoordinate(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= -100 && parsed <= 1000 ? parsed : null;
    }

    function strictMeshValue(value) {
        if (typeof value === "number")
            return Number.isFinite(value) && Math.abs(value) <= 5 ? value : null;
        if (typeof value !== "string")
            return null;
        const match = value.match(/[-+]?(?:\d+\.\d+|\.\d+)/);
        if (!match)
            return null;
        const parsed = Number(match[0]);
        return Number.isFinite(parsed) && Math.abs(parsed) <= 5 ? parsed : null;
    }

    function meshValues(value) {
        if (typeof value === "number")
            return Number.isFinite(value) && Math.abs(value) <= 5 ? [value] : [];
        if (typeof value !== "string")
            return [];
        return Array.from(value.matchAll(/[-+]?(?:\d+\.\d+|\.\d+)/g)).map(function (match) {
            return Number(match[0]);
        }).filter(function (parsed) {
            return Number.isFinite(parsed) && Math.abs(parsed) <= 5;
        });
    }

    function decimalDigits(value) {
        return Math.abs(value).toFixed(6).replace(".", "");
    }

    function repairPoints(points) {
        if (!Array.isArray(points))
            return {points: points, repaired: 0};

        const output = points.map(function (point) {
            return point && typeof point === "object" ? Object.assign({}, point) : point;
        });
        const coordinatesAreValid = output.every(function (point) {
            return point && typeof point === "object" &&
                finiteCoordinate(point.x) !== null && finiteCoordinate(point.y) !== null;
        });
        const flattenedValues = output.flatMap(function (point) {
            return point && typeof point === "object" ? meshValues(point.z) : [];
        });
        const hasSerializedRowMarkers = output.some(function (point) {
            if (!point || typeof point !== "object")
                return true;
            return typeof point.z !== "number" &&
                (typeof point.z !== "string" || !/^\s*[-+]?(?:\d+\.\d+|\.\d+)\s*$/.test(point.z));
        });

        // K1 firmware sometimes concatenates the first value of the next saved
        // mesh row into the previous point, then emits progressively truncated
        // duplicates at the end. Reconstruct the original row-major stream
        // before associating values with the supplied coordinates.
        if (coordinatesAreValid && hasSerializedRowMarkers && flattenedValues.length >= output.length) {
            let repaired = 0;
            output.forEach(function (point, index) {
                const assigned = flattenedValues[index];
                const rawValues = meshValues(point.z);
                const isPlain = typeof point.z === "number" ||
                    (typeof point.z === "string" && /^\s*[-+]?(?:\d+\.\d+|\.\d+)\s*$/.test(point.z));
                if (!isPlain || rawValues.length !== 1 || rawValues[0] !== assigned)
                    repaired += 1;
                point.z = assigned.toFixed(6);
            });
            return {points: output, repaired: repaired};
        }
        const valid = [];
        const invalid = [];

        output.forEach(function (point, index) {
            if (!point || typeof point !== "object")
                return;
            const x = finiteCoordinate(point.x);
            const y = finiteCoordinate(point.y);
            const z = strictMeshValue(point.z);
            if (x === null || y === null) {
                invalid.push({index: index, x: x, y: y, raw: point.z});
            } else if (z === null) {
                invalid.push({index: index, x: x, y: y, raw: point.z});
            } else {
                point.z = z.toFixed(6);
                valid.push({index: index, x: x, y: y, z: z});
            }
        });

        invalid.forEach(function (entry) {
            const point = output[entry.index];
            if (!point || entry.x === null || entry.y === null || valid.length === 0)
                return;

            let replacement = null;
            if (typeof entry.raw === "string" && /^\d{3,6}$/.test(entry.raw.trim())) {
                const suffix = entry.raw.trim();
                const sameRow = valid.filter(function (candidate) {
                    return Math.abs(candidate.y - entry.y) < 0.001 && decimalDigits(candidate.z).endsWith(suffix);
                });
                const distinct = Array.from(new Set(sameRow.map(function (candidate) { return candidate.z; })));
                if (distinct.length === 1)
                    replacement = distinct[0];
            }

            if (replacement === null) {
                const nearest = valid.map(function (candidate) {
                    const dx = candidate.x - entry.x;
                    const dy = candidate.y - entry.y;
                    return {z: candidate.z, distance2: dx * dx + dy * dy};
                }).sort(function (left, right) { return left.distance2 - right.distance2; }).slice(0, 4);
                let weighted = 0;
                let weights = 0;
                nearest.forEach(function (candidate) {
                    const weight = 1 / Math.max(candidate.distance2, 1);
                    weighted += candidate.z * weight;
                    weights += weight;
                });
                if (weights > 0)
                    replacement = weighted / weights;
            }

            if (replacement !== null && Number.isFinite(replacement)) {
                point.z = replacement.toFixed(6);
                valid.push({index: entry.index, x: entry.x, y: entry.y, z: replacement});
            }
        });

        return {points: output, repaired: invalid.length};
    }

    function sanitizeMessageData(data) {
        if (typeof data !== "string" || data.indexOf("probedMatrix") === -1)
            return data;
        let message;
        try { message = JSON.parse(data); } catch (error) { return data; }
        if (!message || !message.probedMatrix || !Array.isArray(message.probedMatrix.val))
            return data;
        const result = repairPoints(message.probedMatrix.val);
        if (result.repaired === 0)
            return data;
        message.probedMatrix.val = result.points;
        message.probedMatrix.num = result.points.length;
        console.info("[Orca K1] Repaired " + result.repaired + " malformed bed-mesh samples from the printer WebUI feed");
        return JSON.stringify(message);
    }

    function sanitizedEvent(event) {
        const data = sanitizeMessageData(event.data);
        if (data === event.data)
            return event;
        return new MessageEvent("message", {
            data: data,
            origin: event.origin,
            lastEventId: event.lastEventId,
            source: event.source,
            ports: event.ports
        });
    }

    function isPrinterSocket(url) {
        try {
            const parsed = new URL(String(url), location.href);
            return (parsed.protocol === "ws:" || parsed.protocol === "wss:") &&
                parsed.hostname === location.hostname && parsed.port === "9999";
        } catch (error) {
            return false;
        }
    }

    class SanitizedWebSocket extends NativeWebSocket {
        constructor(url, protocols) {
            if (protocols === undefined)
                super(url);
            else
                super(url, protocols);
            this.__orcaSanitizeBedMesh = isPrinterSocket(url);
            this.__orcaListenerWrappers = new Map();
        }

        set onmessage(listener) {
            this[originalOnMessage] = listener;
            let wrapped = listener;
            if (this.__orcaSanitizeBedMesh && typeof listener === "function") {
                wrapped = function (event) { return listener.call(this, sanitizedEvent(event)); };
            }
            this[wrappedOnMessage] = wrapped;
            if (nativeOnMessage && nativeOnMessage.set)
                nativeOnMessage.set.call(this, wrapped);
        }

        get onmessage() {
            return this[originalOnMessage] || null;
        }

        addEventListener(type, listener, options) {
            if (type !== "message" || !this.__orcaSanitizeBedMesh || !listener)
                return super.addEventListener(type, listener, options);
            let wrapped = this.__orcaListenerWrappers.get(listener);
            if (!wrapped) {
                wrapped = typeof listener === "function" ?
                    function (event) { return listener.call(this, sanitizedEvent(event)); } :
                    function (event) { return listener.handleEvent(sanitizedEvent(event)); };
                this.__orcaListenerWrappers.set(listener, wrapped);
            }
            return super.addEventListener(type, wrapped, options);
        }

        removeEventListener(type, listener, options) {
            const wrapped = type === "message" && this.__orcaListenerWrappers ?
                this.__orcaListenerWrappers.get(listener) : null;
            return super.removeEventListener(type, wrapped || listener, options);
        }
    }

    window.WebSocket = SanitizedWebSocket;
    window.__orcaCrealityBedMeshSanitizer = {
        repairPoints: repairPoints,
        sanitizeMessageData: sanitizeMessageData
    };
    window.__orcaCrealityEnglishNormalizer = {
        normalize: normalizeEnglishContent,
        translate: translateEnglishText
    };
}());
