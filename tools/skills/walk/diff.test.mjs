import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { diffImages } from './diff.mjs';
import { decodePng, encodePng } from './png.mjs';

const img = (w, h, paint = () => [255, 255, 255]) => {
    const d = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const [r, g, b] = paint(x, y);
            d.set([r, g, b, 255], (y * w + x) * 4);
        }
    return d;
};

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'latin1');
    Buffer.from(body).copy(out, 8);
    out.writeUInt32BE(crc32 ? crc32(out.subarray(4, 8 + body.length)) : 0, 8 + body.length);
    return out;
};

/** A PNG built byte by byte; `rows` are [filterType, ...filteredBytes] so the test picks the filters itself. */
const buildPng = ({ width, height, colorType, rows, depth = 8, interlace = 0, extra = [] }) => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = depth;
    ihdr[9] = colorType;
    ihdr[12] = interlace;
    const raw = Buffer.from(rows.flat());
    // Two IDAT chunks, to prove concatenation.
    const z = deflateSync(raw);
    const half = Math.ceil(z.length / 2);
    return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), ...extra, chunk('IDAT', z.subarray(0, half)), chunk('IDAT', z.subarray(half)), chunk('IEND', Buffer.alloc(0))]);
};

describe('diffImages', () => {
    it('ignores differences under the tolerance (anti-aliasing) and finds none', () => {
        const a = img(64, 64);
        const b = img(64, 64, () => [250, 250, 250]);
        const d = diffImages(a, b, 64, 64, 48);
        assert.equal(d.changed, 0);
        assert.deepEqual(d.boxes, []);
    });

    it('joins touching changed cells into one box and keeps separate areas apart, biggest first', () => {
        const a = img(96, 64);
        const b = img(96, 64, (x, y) => ((x < 30 && y < 10) || (x > 80 && y > 50) ? [0, 0, 0] : [255, 255, 255]));
        const d = diffImages(a, b, 96, 64, 48);
        assert.deepEqual(d.boxes, [
            { x: 0, y: 0, w: 32, h: 16 },
            { x: 80, y: 48, w: 16, h: 16 },
        ]);
        assert.equal(d.changed, 30 * 10 + 15 * 13);
    });
});

describe('png codec', () => {
    it('round trips RGBA through encode and decode', () => {
        const data = new Uint8Array(5 * 3 * 4).map((_, i) => (i * 37) % 256);
        const out = decodePng(encodePng({ width: 5, height: 3, data }));
        assert.equal(out.width, 5);
        assert.equal(out.height, 3);
        assert.deepEqual(Array.from(out.data), Array.from(data));
    });

    it('decodes RGB with every filter type (None, Sub, Up, Average, Paeth) over split IDAT chunks', () => {
        const png = buildPng({
            width: 2,
            height: 5,
            colorType: 2,
            rows: [
                [0, 10, 20, 30, 40, 50, 60],
                [1, 1, 1, 1, 2, 2, 2],
                [2, 5, 5, 5, 5, 5, 5],
                [3, 4, 4, 4, 4, 4, 4],
                [4, 1, 1, 1, 1, 1, 1],
            ],
        });
        const expected = [
            [10, 20, 30, 40, 50, 60],
            [1, 1, 1, 3, 3, 3],
            [6, 6, 6, 8, 8, 8],
            [7, 7, 7, 11, 11, 11],
            [8, 8, 8, 12, 12, 12],
        ];
        const { width, height, data } = decodePng(png);
        assert.deepEqual([width, height], [2, 5]);
        const rgba = expected.flatMap((r) => [r[0], r[1], r[2], 255, r[3], r[4], r[5], 255]);
        assert.deepEqual(Array.from(data), rgba);
    });

    it('decodes grey, grey+alpha, RGBA and palette with tRNS', () => {
        const grey = decodePng(buildPng({ width: 2, height: 1, colorType: 0, rows: [[0, 100, 200]] }));
        assert.deepEqual(Array.from(grey.data), [100, 100, 100, 255, 200, 200, 200, 255]);

        const greyAlpha = decodePng(buildPng({ width: 2, height: 1, colorType: 4, rows: [[1, 100, 128, 100, 127]] }));
        assert.deepEqual(Array.from(greyAlpha.data), [100, 100, 100, 128, 200, 200, 200, 255]);

        const rgba = decodePng(buildPng({ width: 1, height: 2, colorType: 6, rows: [[0, 1, 2, 3, 4], [2, 1, 1, 1, 1]] }));
        assert.deepEqual(Array.from(rgba.data), [1, 2, 3, 4, 2, 3, 4, 5]);

        const palette = decodePng(
            buildPng({
                width: 2,
                height: 1,
                colorType: 3,
                rows: [[0, 0, 1]],
                extra: [chunk('PLTE', [255, 0, 0, 0, 255, 0]), chunk('tRNS', [128])],
            }),
        );
        assert.deepEqual(Array.from(palette.data), [255, 0, 0, 128, 0, 255, 0, 255]);
    });

    it('throws a clear error for a bad signature, 16-bit depth and interlace', () => {
        assert.throws(() => decodePng(Buffer.from('definitely not a png file')), /bad signature/);
        assert.throws(() => decodePng(buildPng({ width: 1, height: 1, colorType: 0, depth: 16, rows: [[0, 0, 0]] })), /bit depth 16/);
        assert.throws(() => decodePng(buildPng({ width: 1, height: 1, colorType: 0, interlace: 1, rows: [[0, 0]] })), /interlaced/);
    });

    const pngjsPath = process.env.WALK_TEST_PNGJS ?? '';
    it('agrees with pngjs in both directions', { skip: !pngjsPath || !existsSync(pngjsPath) }, () => {
        const { PNG } = createRequire(import.meta.url)(pngjsPath);
        const data = new Uint8Array(17 * 9 * 4).map((_, i) => (i * 91 + (i >> 3)) % 256);
        const theirs = PNG.sync.write(Object.assign(new PNG({ width: 17, height: 9 }), { data: Buffer.from(data) }));
        assert.deepEqual(Array.from(decodePng(theirs).data), Array.from(data));
        const back = PNG.sync.read(Buffer.from(encodePng({ width: 17, height: 9, data })));
        assert.deepEqual(Array.from(back.data), Array.from(data));
    });
});

describe('diff.mjs CLI', () => {
    it('writes diff.json and a .diff.png for changed shots and prints one summary line', () => {
        const root = mkdtempSync(join(tmpdir(), 'walk-diff-'));
        try {
            const [before, after, out] = ['before', 'after', 'out'].map((n) => join(root, n));
            mkdirSync(before);
            mkdirSync(after);
            const png = (w, h, paint) => encodePng({ width: w, height: h, data: img(w, h, paint) });
            const block = (x, y) => (x < 20 && y < 20 ? [0, 0, 0] : [255, 255, 255]);
            writeFileSync(join(before, 'home.png'), png(40, 40));
            writeFileSync(join(after, 'home.png'), png(40, 40, block));
            writeFileSync(join(before, 'same.png'), png(16, 16));
            writeFileSync(join(after, 'same.png'), png(16, 16));
            writeFileSync(join(before, 'size.png'), png(16, 16));
            writeFileSync(join(after, 'size.png'), png(16, 32));
            writeFileSync(join(after, 'fresh.png'), png(16, 16));
            writeFileSync(join(before, 'old.png'), png(16, 16));

            const run = spawnSync(process.execPath, [fileURLToPath(new URL('./diff.mjs', import.meta.url)), before, after, out, '--tolerance', '48'], { encoding: 'utf8' });
            assert.equal(run.status, 0, run.stderr);
            assert.match(run.stdout, /walk-diff: 1 changed, 1 resized, 1 new, 1 gone, 0 failed -> /);
            assert.equal(run.stdout.trim().split('\n').length, 1);

            const report = JSON.parse(readFileSync(join(out, 'diff.json'), 'utf8'));
            const by = Object.fromEntries(report.map((r) => [r.name, r]));
            assert.equal(by['home.png'].status, 'changed');
            assert.equal(by['home.png'].share, 0.25);
            assert.deepEqual(by['home.png'].boxes, [{ x: 0, y: 0, w: 32, h: 32 }]);
            assert.deepEqual(by['size.png'], { name: 'size.png', status: 'size', before: [16, 16], after: [16, 32], share: 0, boxes: [] });
            assert.equal(by['fresh.png'].status, 'new');
            assert.equal(by['old.png'].status, 'gone');
            assert.equal(by['same.png'], undefined);

            assert.ok(existsSync(join(out, 'home.diff.png')));
            const d = decodePng(readFileSync(join(out, 'home.diff.png')));
            assert.deepEqual([d.width, d.height], [40, 40]);
            assert.deepEqual(Array.from(d.data.subarray(0, 4)), [230, 30, 60, 255]);
            assert.deepEqual(Array.from(d.data.subarray(39 * 4, 39 * 4 + 4)), [255, 255, 255, 255]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    const cli = fileURLToPath(new URL('./diff.mjs', import.meta.url));
    const withDirs = (fn) => {
        const root = mkdtempSync(join(tmpdir(), 'walk-diff-'));
        try {
            const [before, after, out] = ['before', 'after', 'out'].map((n) => join(root, n));
            mkdirSync(before);
            mkdirSync(after);
            fn({ before, after, out });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    };
    const png = (w, h, paint) => encodePng({ width: w, height: h, data: img(w, h, paint) });

    it('records a broken shot as an error, keeps going and still writes diff.json', () => {
        withDirs(({ before, after, out }) => {
            const good = png(16, 16);
            writeFileSync(join(before, 'a-bad.png'), good);
            writeFileSync(join(after, 'a-bad.png'), good.subarray(0, good.length - 30));
            writeFileSync(join(before, 'b-deep.png'), buildPng({ width: 1, height: 1, colorType: 0, depth: 16, rows: [[0, 0, 0]] }));
            writeFileSync(join(after, 'b-deep.png'), good);
            writeFileSync(join(before, 'c-ok.png'), png(16, 16));
            writeFileSync(join(after, 'c-ok.png'), png(16, 16, () => [0, 0, 0]));

            const run = spawnSync(process.execPath, [cli, before, after, out], { encoding: 'utf8' });
            assert.equal(run.status, 0, run.stderr);
            assert.match(run.stdout, /1 changed, 0 resized, 0 new, 0 gone, 2 failed/);
            const by = Object.fromEntries(JSON.parse(readFileSync(join(out, 'diff.json'), 'utf8')).map((r) => [r.name, r]));
            assert.equal(by['a-bad.png'].status, 'error');
            assert.ok(by['a-bad.png'].error.length > 0);
            assert.equal(by['b-deep.png'].status, 'error');
            assert.match(by['b-deep.png'].error, /bit depth 16/);
            assert.equal(by['c-ok.png'].status, 'changed');
        });
    });

    it('refuses an outDir that is the before or after folder, or that holds an earlier diff', () => {
        withDirs(({ before, after, out }) => {
            const run = (dir) => spawnSync(process.execPath, [cli, before, after, dir], { encoding: 'utf8' });
            for (const dir of [after, before]) {
                const r = run(dir);
                assert.equal(r.status, 2);
                assert.match(r.stderr, /separate folder/);
            }
            mkdirSync(out);
            writeFileSync(join(out, 'old.diff.png'), png(2, 2));
            const stale = run(out);
            assert.equal(stale.status, 2);
            assert.match(stale.stderr, /earlier run/);
            assert.ok(!existsSync(join(out, 'diff.json')));
            rmSync(join(out, 'old.diff.png'));
            writeFileSync(join(out, 'diff.json'), '[]');
            assert.equal(run(out).status, 2);
        });
    });

    it('compares the shared top-left region when sizes differ and reports sizes with the changed share', () => {
        withDirs(({ before, after, out }) => {
            writeFileSync(join(before, 'tall.png'), png(32, 32));
            writeFileSync(join(after, 'tall.png'), png(32, 64, (x, y) => (x < 16 && y < 16 ? [0, 0, 0] : [255, 255, 255])));
            const run = spawnSync(process.execPath, [cli, before, after, out], { encoding: 'utf8' });
            assert.equal(run.status, 0, run.stderr);
            assert.match(run.stdout, /0 changed, 1 resized/);
            const [entry] = JSON.parse(readFileSync(join(out, 'diff.json'), 'utf8'));
            assert.deepEqual(entry, { name: 'tall.png', status: 'size', before: [32, 32], after: [32, 64], share: 0.25, boxes: [{ x: 0, y: 0, w: 16, h: 16 }] });
            const d = decodePng(readFileSync(join(out, 'tall.diff.png')));
            assert.deepEqual([d.width, d.height], [32, 32]);
        });
    });

    it('prints usage and exits 2 without arguments', () => {
        const run = spawnSync(process.execPath, [fileURLToPath(new URL('./diff.mjs', import.meta.url))], { encoding: 'utf8' });
        assert.equal(run.status, 2);
        assert.match(run.stderr, /usage: node diff\.mjs/);
    });
});
