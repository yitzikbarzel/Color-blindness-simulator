'use strict';
// Minimal, dependency-free PNG codec for tests (8-bit RGB/RGBA, non-interlaced).
const zlib = require('zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
}

/** Decode a PNG buffer to { width, height, data: Uint8ClampedArray RGBA }. */
function decodePNG(buf) {
    if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG');
    let pos = 8, width, height, bitDepth, colorType, interlace;
    const idat = [];
    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('ascii', pos + 4, pos + 8);
        const body = buf.subarray(pos + 8, pos + 8 + len);
        if (type === 'IHDR') {
            width = body.readUInt32BE(0);
            height = body.readUInt32BE(4);
            bitDepth = body[8];
            colorType = body[9];
            interlace = body[12];
        } else if (type === 'IDAT') {
            idat.push(body);
        } else if (type === 'IEND') {
            break;
        }
        pos += 12 + len;
    }
    if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`Unsupported PNG (bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace})`);
    }
    const bpp = colorType === 6 ? 4 : 3;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * bpp;
    const pixels = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const src = y * (stride + 1) + 1;
        const dst = y * stride;
        for (let x = 0; x < stride; x++) {
            const v = raw[src + x];
            const a = x >= bpp ? pixels[dst + x - bpp] : 0;
            const b = y > 0 ? pixels[dst - stride + x] : 0;
            const c = x >= bpp && y > 0 ? pixels[dst - stride + x - bpp] : 0;
            let out;
            switch (filter) {
                case 0: out = v; break;
                case 1: out = v + a; break;
                case 2: out = v + b; break;
                case 3: out = v + ((a + b) >> 1); break;
                case 4: out = v + paeth(a, b, c); break;
                default: throw new Error('Bad PNG filter ' + filter);
            }
            pixels[dst + x] = out & 0xff;
        }
    }
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, j = 0; i < width * height; i++, j += bpp) {
        data[i * 4] = pixels[j];
        data[i * 4 + 1] = pixels[j + 1];
        data[i * 4 + 2] = pixels[j + 2];
        data[i * 4 + 3] = bpp === 4 ? pixels[j + 3] : 255;
    }
    return { width, height, data };
}

function chunk(type, body) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(tb));
    return Buffer.concat([len, tb, crc]);
}

/** Encode RGBA pixels as a PNG buffer. */
function encodePNG({ width, height, data }) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0;
        Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4)
            .copy(raw, y * (width * 4 + 1) + 1);
    }
    return Buffer.concat([
        SIGNATURE,
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

module.exports = { decodePNG, encodePNG };
