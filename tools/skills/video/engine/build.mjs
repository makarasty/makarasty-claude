// Aligns the script words to whisper word timestamps, writes data.js (timing + caption chunks),
// subtitles.<lang>.srt, and stamps the duration into index.html. Run in the work folder.
// Usage: node build.mjs <take.words.json> <lang>  (env PROJ = the composition folder, NARR = the narration file)
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const proj = path.resolve(process.env.PROJ || 'hf');
const out = process.cwd();
const norm = (w) => w.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]/gu, '');

const lang = process.argv[3] || 'ru';
const segs = JSON.parse(fs.readFileSync(path.resolve(process.env.NARR || `narration.${lang}.json`), 'utf8').replace(/^﻿/, ''));
const heard = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8')).filter((w) => norm(w.w));

// script tokens; a pure-punctuation token ("—") only marks a break on the previous word
const toks = [];
segs.forEach((s, si) => s.text.split(/\s+/).forEach((raw) => {
  if (!norm(raw)) { if (toks.length) toks.at(-1).brk = true; return; }
  toks.push({ si, raw, n: norm(raw), brk: /[,.:;?!]$/.test(raw) });
}));

// global alignment (edit distance over tokens), fuzzy match on a shared 4-letter stem
const same = (a, b) => a === b || (a.length > 3 && b.length > 3 && a.slice(0, 4) === b.slice(0, 4));
const A = toks.length, B = heard.length, dp = [...Array(A + 1)].map(() => new Int32Array(B + 1));
for (let i = 0; i <= A; i++) dp[i][0] = i;
for (let j = 0; j <= B; j++) dp[0][j] = j;
for (let i = 1; i <= A; i++) for (let j = 1; j <= B; j++)
  dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (same(toks[i - 1].n, norm(heard[j - 1].w)) ? 0 : 1.5) | 0);
for (let i = A, j = B; i > 0 && j > 0;) {
  const m = same(toks[i - 1].n, norm(heard[j - 1].w));
  if (m && dp[i][j] === dp[i - 1][j - 1]) { toks[i - 1].s = heard[j - 1].s; toks[i - 1].e = heard[j - 1].e; i--; j--; }
  else if (dp[i][j] === dp[i - 1][j] + 1) i--;
  else if (dp[i][j] === dp[i][j - 1] + 1) j--;
  else { i--; j--; }
}
// unmatched words (numbers read as digits, misheard words) are interpolated between matched neighbours
const matched = toks.filter((t) => t.s !== undefined).length;
for (let i = 0; i < A; i++) if (toks[i].s === undefined) {
  let a = i - 1; while (a >= 0 && toks[a].s === undefined) a--;
  let b = i + 1; while (b < A && toks[b].s === undefined) b++;
  const t0 = a >= 0 ? toks[a].e : 0, t1 = b < A ? toks[b].s : t0 + 0.4 * (b - a);
  const k = (i - a) / (b - a), len = (t1 - t0) / (b - a - 1 || 1);
  toks[i].s = +(t0 + (t1 - t0) * k - len / 2).toFixed(3); toks[i].e = +(toks[i].s + len).toFixed(3);
}
for (let i = 1; i < A; i++) assert.ok(toks[i].s >= toks[i - 1].s - 0.01, `time goes back at ${toks[i].raw}`);

const show = (raw) => raw.replace(/[,.:;]+$/, '').replace(/^[«"]|[»"]$/g, '');
// beats: named key words per segment ("num": "восемьдесят") -> spoken time, so one composition serves every language
const segments = segs.map((seg, si) => {
  const w = toks.filter((t) => t.si === si);
  const beats = Object.fromEntries(Object.entries(seg.beats || {}).map(([name, stem]) => {
    const hit = w.find((t) => t.n.startsWith(norm(stem)));
    assert.ok(hit, `beat "${name}" (${stem}) not found in segment ${si + 1}`);
    return [name, hit.s];
  }));
  return { start: w[0].s, end: w.at(-1).e, beats, words: w.map((t) => ({ t: show(t.raw), s: t.s })) };
});

// caption groups for a calm voice: up to 4 words / 17 letters, break at punctuation and at audible pauses
const MAX_WORDS = 4, MAX_CHARS = 17, PAUSE = 0.35; // 17 letters = one line at 62px in the 552px caption box
const chunks = [];
segs.forEach((_, si) => {
  let cur = [];
  const flush = () => { if (cur.length) chunks.push({ si, words: cur }); cur = []; };
  toks.filter((t) => t.si === si).forEach((t) => {
    const len = cur.reduce((n, w) => n + w.t.length + 1, 0) + show(t.raw).length;
    if (cur.length && (cur.length >= MAX_WORDS || len > MAX_CHARS || t.s - cur.at(-1).e > PAUSE)) flush();
    cur.push({ t: show(t.raw), raw: t.raw, s: t.s, e: t.e });
    if (t.brk) flush();
  });
  flush();
});
// a one-word tail after a split reads as a flicker: fold it back when it fits
for (let i = chunks.length - 1; i > 0; i--) {
  const c = chunks[i], p = chunks[i - 1], txt = [...p.words, ...c.words].map((w) => w.t).join(' ');
  const sentenceEnd = /[.?!:…]$/.test(p.words.at(-1).raw); // never glue the start of a sentence to the end of the last one
  if (c.words.length === 1 && p.si === c.si && !sentenceEnd && txt.length <= MAX_CHARS + 2) { p.words.push(...c.words); chunks.splice(i, 1); }
}
chunks.forEach((c, i) => {
  const n = chunks[i + 1], last = c.words.at(-1).e;
  c.start = Math.max(0, c.words[0].s - 0.08);
  c.end = n ? Math.min(n.words[0].s - 0.1, last + 0.6) : last + 0.5;
});
for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i].start >= chunks[i - 1].end, `caption groups overlap at ${chunks[i].start}`);

const endCard = +(toks.at(-1).e + 0.7).toFixed(2), dur = +(endCard + 3.4).toFixed(2);
fs.writeFileSync(path.join(out, 'segments.json'), JSON.stringify(segments.map(({ start, end }) => ({ start, end }))));
fs.writeFileSync(path.join(out, 'timeline.json'), JSON.stringify({ starts: segments.map((s) => s.start), endCard, dur }));
fs.writeFileSync(path.join(proj, 'data.js'), `window.DATA = ${JSON.stringify({ lang, dur, endCard, segments, chunks })};\n`);

const ts = (x) => { const ms = Math.round(x * 1000), h = Math.floor(ms / 3.6e6), m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
fs.writeFileSync(path.join(out, `subtitles.${lang}.srt`), chunks.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.words.map((w) => w.t).join(' ')}\n`).join('\n'));

const html = path.join(proj, 'index.html');
fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace(/data-duration="[^"]*"/g, `data-duration="${dur}"`));
console.log(`words ${A}, matched ${matched} (${Math.round(100 * matched / A)}%), chunks ${chunks.length}, voice ends ${toks.at(-1).e}s, video ${dur}s`);
