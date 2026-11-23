/**
 * `node diff.mjs <beforeDir> <afterDir> <outDir> [--tolerance 48]`: compares two walk runs shot by shot (same file names).
 * Writes `<name>.diff.png` (the after shot, dimmed, changed pixels red) for every shot that changed, and `diff.json`:
 * per shot the changed share and the boxes of changed areas, biggest first. Shots of different sizes are compared over
 * their shared top-left region; a shot that fails to decode is reported as an error and the run goes on. A pixel is
 * changed when the summed RGB difference exceeds the tolerance, so anti-aliasing noise stays out.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './png.mjs';

const CELL = 16;

/** Changed-pixel mask plus boxes of 16px cells joined when they touch. Pure, for the test. */
export function diffImages(a, b, width, height, tolerance = 48) {
    const cols = Math.ceil(width / CELL);
    const rows = Math.ceil(height / CELL);
    const cells = new Uint8Array(cols * rows);
    const mask = new Uint8Array(width * height);
    let changed = 0;
    for (let i = 0; i < width * height; i++) {
        const o = i * 4;
        if (Math.abs(a[o] - b[o]) + Math.abs(a[o + 1] - b[o + 1]) + Math.abs(a[o + 2] - b[o + 2]) <= tolerance) continue;
        mask[i] = 1;
        changed++;
        cells[Math.floor(i / width / CELL) * cols + Math.floor((i % width) / CELL)] = 1;
    }
    const boxes = [];
    const seen = new Uint8Array(cells.length);
    for (let c = 0; c < cells.length; c++) {
        if (!cells[c] || seen[c]) continue;
        let [x0, y0, x1, y1] = [c % cols, Math.floor(c / cols), c % cols, Math.floor(c / cols)];
        const stack = [c];
        seen[c] = 1;
        while (stack.length) {
            const k = stack.pop();
            const x = k % cols;
            const y = Math.floor(k / cols);
            [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
            for (const [dx, dy] of [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1],
            ]) {
                const nx = x + dx;
                const ny = y + dy;
                const n = ny * cols + nx;
                if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && cells[n] && !seen[n]) {
                    seen[n] = 1;
                    stack.push(n);
                }
            }
        }
        boxes.push({ x: x0 * CELL, y: y0 * CELL, w: Math.min(width, (x1 + 1) * CELL) - x0 * CELL, h: Math.min(height, (y1 + 1) * CELL) - y0 * CELL });
    }
    boxes.sort((p, q) => q.w * q.h - p.w * p.h);
    return { changed, share: changed / (width * height), boxes, mask };
}

function crop(img, w, h) {
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) out.set(img.data.subarray(y * img.width * 4, y * img.width * 4 + w * 4), y * w * 4);
    return out;
}

// argv and the module URL can differ in drive-letter case on Windows, so compare case-insensitively.
const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase();

if (isMain) {
    const args = process.argv.slice(2);
    const tIdx = args.indexOf('--tolerance');
    const tolerance = tIdx >= 0 ? Number(args.splice(tIdx, 2)[1]) : 48;
    const [beforeDir, afterDir, outDir] = args;
    if (!beforeDir || !afterDir || !outDir) {
        console.error('usage: node diff.mjs <beforeDir> <afterDir> <outDir> [--tolerance 48]');
        process.exit(2);
    }
    const same = (p, q) => (process.platform === 'win32' ? resolve(p).toLowerCase() === resolve(q).toLowerCase() : resolve(p) === resolve(q));
    if (same(outDir, afterDir) || same(outDir, beforeDir)) {
        console.error('diff.mjs: outDir must be a separate folder, not the before or after folder');
        process.exit(2);
    }
    if (existsSync(outDir) && readdirSync(outDir).some((f) => f === 'diff.json' || f.endsWith('.diff.png'))) {
        console.error(`diff.mjs: ${outDir} already holds a diff.json or .diff.png from an earlier run; use a new or empty folder`);
        process.exit(2);
    }
    mkdirSync(outDir, { recursive: true });
    const report = [];
    for (const name of readdirSync(afterDir).filter((f) => f.endsWith('.png') && !f.endsWith('.diff.png'))) {
        if (!existsSync(join(beforeDir, name))) {
            report.push({ name, status: 'new' });
            continue;
        }
        try {
            const a = decodePng(readFileSync(join(beforeDir, name)));
            const b = decodePng(readFileSync(join(afterDir, name)));
            const resized = a.width !== b.width || a.height !== b.height;
            // A taller full-page shot must not hide a real change, so the shared top-left region is still compared.
            const w = Math.min(a.width, b.width);
            const h = Math.min(a.height, b.height);
            const pa = resized ? crop(a, w, h) : a.data;
            const pb = resized ? crop(b, w, h) : b.data;
            const d = diffImages(pa, pb, w, h, tolerance);
            const sizes = resized ? { before: [a.width, a.height], after: [b.width, b.height] } : {};
            if (d.changed) {
                const out = new Uint8Array(w * h * 4);
                for (let i = 0; i < w * h; i++) {
                    const o = i * 4;
                    const hit = d.mask[i];
                    out[o] = hit ? 230 : 255 - (255 - pb[o]) * 0.35;
                    out[o + 1] = hit ? 30 : 255 - (255 - pb[o + 1]) * 0.35;
                    out[o + 2] = hit ? 60 : 255 - (255 - pb[o + 2]) * 0.35;
                    out[o + 3] = 255;
                }
                writeFileSync(join(outDir, name.replace(/\.png$/, '.diff.png')), encodePng({ width: w, height: h, data: out }));
            }
            if (d.changed || resized) report.push({ name, status: resized ? 'size' : 'changed', ...sizes, share: Number(d.share.toFixed(4)), boxes: d.boxes.slice(0, 12) });
        } catch (err) {
            report.push({ name, status: 'error', error: err.message });
        }
    }
    for (const name of readdirSync(beforeDir).filter((f) => f.endsWith('.png') && !existsSync(join(afterDir, f)))) report.push({ name, status: 'gone' });
    report.sort((p, q) => (q.share || 0) - (p.share || 0));
    writeFileSync(join(outDir, 'diff.json'), JSON.stringify(report, null, 1));
    const n = (s) => report.filter((r) => r.status === s).length;
    console.log(`walk-diff: ${n('changed')} changed, ${n('size')} resized, ${n('new')} new, ${n('gone')} gone, ${n('error')} failed -> ${join(outDir, 'diff.json')}`);
}
