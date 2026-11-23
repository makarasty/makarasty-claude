/**
 * Minimal PNG codec on Node built-ins only: decodes 8-bit, non-interlaced PNGs (grey, RGB, palette, grey+alpha, RGBA)
 * to RGBA bytes, and encodes RGBA to a PNG. Enough for browser screenshots; anything else throws a clear error.
 */
import { crc32 as zlibCrc32, deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

let crcTable;
function crc32(buf) {
    if (zlibCrc32) return zlibCrc32(buf);
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c >>> 0;
        }
    }
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
}

export function decodePng(buf) {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
    if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('decodePng: not a PNG (bad signature)');
    let header = null;
    let palette = null;
    let trns = null;
    const idat = [];
    for (let pos = 8; pos + 8 <= buf.length; ) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('latin1', pos + 4, pos + 8);
        const body = buf.subarray(pos + 8, pos + 8 + len);
        if (body.length < len) throw new Error(`decodePng: truncated ${type} chunk`);
        pos += 12 + len;
        if (type === 'IHDR') {
            header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colorType: body[9], interlace: body[12] };
        } else if (type === 'PLTE') palette = body;
        else if (type === 'tRNS') trns = body;
        else if (type === 'IDAT') idat.push(body);
        else if (type === 'IEND') break;
    }
    if (!header) throw new Error('decodePng: IHDR chunk missing');
    const { width, height, depth, colorType, interlace } = header;
    if (depth !== 8) throw new Error(`decodePng: unsupported bit depth ${depth}, only 8 is supported`);
    if (interlace !== 0) throw new Error('decodePng: interlaced PNGs are not supported');
    const channels = CHANNELS[colorType];
    if (!channels) throw new Error(`decodePng: unsupported colour type ${colorType}`);
    if (colorType === 3 && !palette) throw new Error('decodePng: palette PNG without a PLTE chunk');

    const stride = width * channels;
    const raw = inflateSync(Buffer.concat(idat));
    if (raw.length < (stride + 1) * height) throw new Error('decodePng: image data is shorter than the header says');
    const px = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const src = y * (stride + 1) + 1;
        const row = y * stride;
        for (let x = 0; x < stride; x++) {
            const left = x >= channels ? px[row + x - channels] : 0;
            const up = y > 0 ? px[row - stride + x] : 0;
            const upLeft = y > 0 && x >= channels ? px[row - stride + x - channels] : 0;
            let add;
            if (filter === 0) add = 0;
            else if (filter === 1) add = left;
            else if (filter === 2) add = up;
            else if (filter === 3) add = (left + up) >> 1;
            else if (filter === 4) add = paeth(left, up, upLeft);
            else throw new Error(`decodePng: unknown filter type ${filter}`);
            px[row + x] = (raw[src + x] + add) & 0xff;
        }
    }

    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const o = i * 4;
        const s = i * channels;
        if (colorType === 6) data.set(px.subarray(s, s + 4), o);
        else if (colorType === 2) data.set([px[s], px[s + 1], px[s + 2], 255], o);
        else if (colorType === 0) data.set([px[s], px[s], px[s], 255], o);
        else if (colorType === 4) data.set([px[s], px[s], px[s], px[s + 1]], o);
        else {
            const p = px[s] * 3;
            data.set([palette[p] ?? 0, palette[p + 1] ?? 0, palette[p + 2] ?? 0, trns && px[s] < trns.length ? trns[px[s]] : 255], o);
        }
    }
    return { width, height, data };
}

function chunk(type, body) {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'latin1');
    body.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
}

export function encodePng({ width, height, data }) {
    const stride = width * 4;
    if (data.length < stride * height) throw new Error('encodePng: data is shorter than width * height * 4');
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0;
        raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
