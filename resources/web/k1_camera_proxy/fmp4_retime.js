(function () {
    "use strict";

    function boxType(view, offset) {
        return String.fromCharCode(
            view.getUint8(offset + 4), view.getUint8(offset + 5),
            view.getUint8(offset + 6), view.getUint8(offset + 7)
        );
    }

    function walkBoxes(view, start, end, visitor) {
        let offset = start;
        while (offset + 8 <= end) {
            let size = view.getUint32(offset);
            let header = 8;
            if (size === 1) {
                if (offset + 16 > end)
                    return;
                const high = view.getUint32(offset + 8);
                const low = view.getUint32(offset + 12);
                size = high * 0x100000000 + low;
                header = 16;
            } else if (size === 0) {
                size = end - offset;
            }
            if (size < header || offset + size > end)
                return;

            const type = boxType(view, offset);
            visitor(type, offset, size, header);
            if (type === "moov" || type === "trak" || type === "mdia" || type === "minf" ||
                type === "stbl" || type === "moof" || type === "traf") {
                walkBoxes(view, offset + header, offset + size, visitor);
            }
            offset += size;
        }
    }

    class OrcaK1Fmp4Retime {
        constructor(timescale, framesPerSecond) {
            this.timescale = timescale || 90000;
            this.framesPerSecond = framesPerSecond || 15;
            this.sampleDuration = Math.round(this.timescale / this.framesPerSecond);
            this.nextDecodeTime = 0;
        }

        reset() {
            this.nextDecodeTime = 0;
        }

        rewrite(arrayBuffer) {
            if (!arrayBuffer || typeof arrayBuffer.byteLength !== "number")
                return arrayBuffer;
            const view = new DataView(arrayBuffer);
            let durationOffset = null;
            let decodeTimeOffset = null;
            let decodeTimeVersion = 0;
            let sampleCount = 1;
            let foundMovieFragment = false;

            walkBoxes(view, 0, view.byteLength, function (type, offset) {
                if (type === "moof") {
                    foundMovieFragment = true;
                    return;
                }
                if (type === "tfhd") {
                    const flags = (view.getUint8(offset + 9) << 16) |
                        (view.getUint8(offset + 10) << 8) | view.getUint8(offset + 11);
                    let field = offset + 16;
                    if (flags & 0x000001) field += 8;
                    if (flags & 0x000002) field += 4;
                    if (flags & 0x000008) durationOffset = field;
                    return;
                }
                if (type === "tfdt") {
                    decodeTimeVersion = view.getUint8(offset + 8);
                    decodeTimeOffset = offset + 12;
                    return;
                }
                if (type === "trun")
                    sampleCount = Math.max(1, view.getUint32(offset + 12));
            });

            if (!foundMovieFragment || durationOffset === null || decodeTimeOffset === null)
                return arrayBuffer;

            view.setUint32(durationOffset, this.sampleDuration);
            if (decodeTimeVersion === 1) {
                view.setUint32(decodeTimeOffset, Math.floor(this.nextDecodeTime / 0x100000000));
                view.setUint32(decodeTimeOffset + 4, this.nextDecodeTime >>> 0);
            } else {
                view.setUint32(decodeTimeOffset, this.nextDecodeTime >>> 0);
            }
            this.nextDecodeTime += this.sampleDuration * sampleCount;
            return arrayBuffer;
        }
    }

    window.OrcaK1Fmp4Retime = OrcaK1Fmp4Retime;
}());
