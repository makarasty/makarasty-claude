#!/usr/bin/env node
// scrub.mjs - censors pasted secrets (API keys, tokens, passwords, private keys) in the Claude Code transcripts on
// this machine, in place, with same-length runs of '*'. Default is a dry run that prints counts, never a value.
//
//   node scrub.mjs [--apply] [--root <config dir>] [--min-age 10m] [--json]
//   node scrub.mjs --selftest
//
// Scope (each when it exists), under --root or ${CLAUDE_CONFIG_DIR:-~/.claude}: projects/**/*.jsonl (subagents too),
// projects/**/tool-results/*, history.jsonl, paste-cache/**, file-history/**, todos/**, makarasty/handoff/**, debug/**, shell-snapshots/**; plus the Desktop app session folders
// (claude-code-sessions/**/*.json, local-agent-mode-sessions/**) of every %LOCALAPPDATA%\Claude-Profiles\* profile
// and of the default Desktop data dir. Reported, never touched: settings*.json*, .claude.json, ~/.codex, ~/.gemini,
// ~/.copilot, ~/.config/github-copilot.
//
// Files are read as latin1, so one char is one byte: a replacement keeps every byte offset, the file size and any
// invalid UTF-8 exactly, and '*' never needs JSON escaping. Safety for --apply, per file: a .jsonl line is changed only
// when it parses before and after and the parsed values differ only where a char became '*' (a hit that fails this is
// left and counted); the copy goes to <file>.scrub-tmp (exclusive create: an existing one means another run or a
// crash, the file is left), is fsynced, must have the original size and line count, and replaces the original by
// rename only when the original's mtime and size did not change meanwhile. The original mtime is restored. No backup
// is made, since the point is to remove the secrets.
//
// shortcut: a non-.jsonl file over 64 MB is streamed by line, so a PEM block split over raw lines there is missed; read
// it whole if such files appear.
import { createReadStream, readdirSync, statSync, openSync, readSync, closeSync, writeSync, fsyncSync, fstatSync, renameSync,
    utimesSync, chmodSync, unlinkSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX = 512 * 1024 * 1024, WHOLE = 64 * 1024 * 1024;
const WIN = process.platform === 'win32';
// guards the selftest turns off one at a time to see its assertions go red
const BROKEN = new Set();
const on = g => !BROKEN.has(g);

const SP = String.raw`[ \t]*`;
const Q = String.raw`(?:\\{0,3}["'])?`; // a quote, also JSON-escaped once or twice
const VAL = String.raw`[^\x00-\x20\x7f-\xff"'\\,;]`; // printable ASCII without quotes, backslash, comma, semicolon
const RU = ['пароль', 'Пароль', 'ПАРОЛЬ'].map(w => Buffer.from(w).toString('latin1')).join('|'); // as read in latin1
// [kind, regex, options]; earlier rows win an overlap, so the generic ones come last.
// keep: chars left visible (a known prefix); group: only that group is the secret; left/right: boundary checks.
const PATTERNS = [
    ['anthropic', /sk-ant-[A-Za-z0-9_-]{20,}/g, { keep: 4, left: 1 }],
    ['openai', /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, { keep: 4, left: 1, digit: 1 }],
    ['github', /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,}/g, { keep: 4, left: 1 }],
    ['slack', /xox[abposr]-[A-Za-z0-9-]{10,}/g, { keep: 4, left: 1, digit: 1 }],
    ['aws', /(?:AKIA|ASIA)[0-9A-Z]{16}/g, { keep: 4, left: 1, right: 1 }],
    ['aws', new RegExp(String.raw`aws_secret_access_key${SP}${Q}${SP}[=:]${SP}${Q}(${VAL}{8,})`, 'gid'), { group: 1 }],
    ['google', /AIza[0-9A-Za-z_-]{35}/g, { keep: 4, left: 1, right: 1 }],
    ['telegram', /\d{8,10}:[A-Za-z0-9_-]{35}/g, { left: 1, right: 1 }],
    ['stripe', /(?:sk_(?:live|test)|rk_live)_\w{16,}/g, { keep: 4, left: 1 }],
    ['jwt', /eyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/g, { keep: 4, left: 1 }],
    ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----([\s\S]*?)-----END [A-Z ]*PRIVATE KEY-----/gd, { group: 1, pem: 1 }],
    ['bearer', /\b[Bb]earer[ \t]+([A-Za-z0-9._~+/=-]{20,})/gd, { group: 1, digit: 1 }],
    ['url-password', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:"'\\]+:([^\x00-\x20\x7f-\xff/@"'\\]+)@/gid, { group: 1, words: 1 }],
    ['keyword', new RegExp(String.raw`(?:password|passwd|pwd|${RU}|secret|api[_-]?key|x-api-key|token)${SP}${Q}${SP}[:=]${SP}${Q}(${VAL}{6,})`, 'gid'), { group: 1, code: 1, words: 1 }],
];
export const KINDS = [...new Set(PATTERNS.map(p => p[0]))];
const PLACE = /\*\*\*|\.\.\.|@@|xxx|changeme|example|process\.env|os\.environ|placeholder|redacted|your[_-]/i;
const WORDS = new Set(['password', 'pass', 'passwd', 'pwd', 'pw', 'secret', 'token', 'apikey', 'api_key']);
const ESC = /\\+(?:u[0-9A-Fa-f]{4}|[nrtbf"/])?|[A-Za-z0-9+/=]/g; // a PEM body: escapes stay, base64 chars go
const ESC_ONLY = /\\+(?:u[0-9A-Fa-f]{4}|[nrtbf"/])?/g;

const okLeft = (s, i) => !on('boundary') || i === 0 || !/[A-Za-z0-9+/_-]/.test(s[i - 1])
    || /\\(?:[nrt]|u[0-9A-Fa-f]{4})$/.test(s.slice(Math.max(0, i - 6), i)); // after a JSON escape like \n
const okRight = (s, i) => !on('boundary') || i >= s.length || !/[A-Za-z0-9_-]/.test(s[i]);

function placeholder(v, o) {
    if (!on('placeholder')) return false;
    if (o.pem) return v.replace(ESC_ONLY, '').replace(/[^A-Za-z0-9+/]/g, '').length < 32;
    if (PLACE.test(v) || /^[$<{%[*]/.test(v) || !/[A-Za-z0-9]/.test(v)) return true;
    if (o.digit && !/\d/.test(v)) return true;
    if (o.words && WORDS.has(v.toLowerCase())) return true;
    if (o.code) { // code, not a value: a type, a call, a generic, a member, a template, a version, a path or a URL
        if (/^(?:[(`^:]|\+\+|--|!+[A-Za-z_$])|^(?:[~.]?\/|[A-Za-z]:|[a-z]+:\/\/)/i.test(v)) return true;
        const id = /^[A-Za-z_$][\w$-]*/.exec(v)?.[0];
        if (id) {
            const rest = v.slice(id.length);
            if (/^[\])}!?|`.]*$/.test(rest)) return !/\d/.test(id);
            if (/^(?:[(<[?:)=]|\.[A-Za-z_$])/.test(rest)) return true;
        }
    }
    return false;
}

// Secret spans in one latin1 string, sorted, without overlaps.
export function findHits(s) {
    const hits = [];
    for (const [kind, re, o] of PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(s))) {
            const [st, en] = o.group ? m.indices[o.group] : [m.index, m.index + m[0].length];
            if ((o.left && !okLeft(s, m.index)) || (o.right && !okRight(s, en))) { re.lastIndex = m.index + 1; continue; }
            if (placeholder(s.slice(st, en), o) || hits.some(h => st < h.end && en > h.start)) continue;
            hits.push({ kind, start: st, end: en, keep: o.keep ?? 0, pem: !!o.pem });
        }
    }
    return hits.sort((a, b) => a.start - b.start);
}

export function maskWith(s, hits) {
    let out = '', at = 0;
    for (const h of hits) {
        const v = s.slice(h.start, h.end), k = Math.min(h.keep, v.length);
        out += s.slice(at, h.start) + (h.pem
            ? (on('escapes') ? v.replace(ESC, m => (m.length > 1 || m === '\\' ? m : '*')) : v.replace(/\S/g, '*'))
            : v.slice(0, k) + '*'.repeat(v.length - k));
        at = h.end;
    }
    return out + s.slice(at);
}
export const scrubText = s => maskWith(s, findHits(s));

const parse = s => { try { return { ok: true, v: JSON.parse(Buffer.from(s, 'latin1').toString('utf8')) }; } catch { return { ok: false }; } };
// a and b are the same JSON except strings where b has '*' in place of a char
export function same(a, b) {
    if (typeof a === 'string') {
        if (typeof b !== 'string' || a.length !== b.length) return false;
        for (let i = 0; a !== b && i < a.length; i++) if (a[i] !== b[i] && b[i] !== '*') return false;
        return true;
    }
    if (a === null || typeof a !== 'object') return Object.is(a, b);
    if (b === null || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k, i) => same(k, kb[i]) && same(a[k], b[kb[i]]));
}

// The masked unit and the hits used. JSON units keep only hits that leave the parsed value intact but for '*'.
function fix(s, hits, json) {
    if (!json) return { out: maskWith(s, hits), used: hits };
    const a = parse(s);
    if (!a.ok) return { out: s, used: [], unparsed: true };
    const ok = hs => { const o = maskWith(s, hs); if (!on('json')) return o; const b = parse(o); return b.ok && same(a.v, b.v) ? o : null; };
    const all = ok(hits);
    if (all != null) return { out: all, used: hits };
    const used = [];
    for (const h of hits) if (ok([...used, h]) != null) used.push(h);
    return { out: maskWith(s, used), used };
}

async function eachLine(p, fn) {
    const rs = createReadStream(p, { encoding: 'latin1', highWaterMark: 1 << 20 });
    let parts = [];
    for await (const chunk of rs) {
        let i = 0, j;
        while ((j = chunk.indexOf('\n', i)) >= 0) {
            let line = chunk.slice(i, j);
            if (parts.length) { parts.push(line); line = parts.join(''); parts = []; }
            fn(line, true);
            i = j + 1;
        }
        if (i < chunk.length) parts.push(chunk.slice(i));
    }
    if (parts.length) fn(parts.join(''), false);
}

// One pass over a file. With f, counts hits into f; with put, writes every unit, masked where it can be.
async function pass(p, mode, f, put) {
    let nl = 0, line = 0, used = 0;
    const unit = (s, json, hadNl, lineAt) => {
        const hits = findHits(s);
        let out = s;
        if (hits.length) {
            const r = fix(s, hits, json);
            out = r.out; used += r.used.length;
            if (f) {
                for (const h of hits) f.kinds[h.kind] = (f.kinds[h.kind] ?? 0) + 1;
                f.left += hits.length - r.used.length;
                for (const h of r.used.slice(0, Math.max(0, 3 - f.samples.length))) {
                    f.samples.push(`${h.kind} L${lineAt(h)}${h.keep ? ' ' + s.slice(h.start, h.start + 4) + '…' : ''}`);
                }
            }
        }
        put?.(out, hadNl);
    };
    if (mode === 'whole') {
        const s = readFileSync(p, 'latin1');
        for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) nl++;
        const json = p.endsWith('.json') && parse(s).ok;
        unit(s, json, false, h => { let n = 1; for (let i = s.indexOf('\n'); i >= 0 && i < h.start; i = s.indexOf('\n', i + 1)) n++; return n; });
    } else {
        await eachLine(p, (s, hadNl) => { line++; if (hadNl) nl++; unit(s, mode === 'lines', hadNl, () => line); });
    }
    return { nl, used };
}

function writer(fd, mangle) {
    let buf = [], len = 0, nl = 0;
    const flush = () => {
        if (!buf.length) return;
        const s = buf.join(''); buf = []; len = 0;
        for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) nl++;
        let off = 0; const b = Buffer.from(s, 'latin1');
        while (off < b.length) off += writeSync(fd, b, off, b.length - off);
    };
    return {
        put(s, hadNl) { s = mangle ? mangle(s) : s; buf.push(s); len += s.length; if (hadNl) { buf.push('\n'); len++; } if (len > 1 << 23) flush(); },
        flush, get nl() { return nl; },
    };
}

const isBinary = p => { const b = Buffer.alloc(8192); const fd = openSync(p, 'r'); try { return b.subarray(0, readSync(fd, b, 0, 8192, 0)).includes(0); } finally { closeSync(fd); } };

function* walk(dir, test = () => true) {
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { // symlinks and junctions are not followed
        const p = join(dir, e.name);
        if (e.isDirectory()) yield* walk(p, test);
        else if (e.isFile() && test(e.name)) yield p;
    }
}
const desktopRoots = (home, env) => {
    const r = [];
    if (env.LOCALAPPDATA) { const base = join(env.LOCALAPPDATA, 'Claude-Profiles'); try { for (const e of readdirSync(base, { withFileTypes: true })) if (e.isDirectory()) r.push(join(base, e.name)); } catch {} }
    if (env.APPDATA) r.push(join(env.APPDATA, 'Claude'));
    r.push(join(home, 'Library', 'Application Support', 'Claude'), join(home, '.config', 'Claude'));
    return r;
};
function* scope(cfg, home, env) {
    for (const p of walk(join(cfg, 'projects'), n => /\.jsonl(\.scrub-tmp)?$/.test(n))) yield [/[\\/]subagents[\\/]/.test(p) ? 'subagents' : 'projects', p];
    // Large tool outputs a transcript points at live beside it as text files: an .env cat lands there too.
    for (const p of walk(join(cfg, 'projects'), n => /\.(txt|md|json|log)(\.scrub-tmp)?$/.test(n))) if (/[\\/]tool-results[\\/]/.test(p)) yield ['tool-results', p];
    for (const n of ['history.jsonl', 'history.jsonl.scrub-tmp']) if (existsSync(join(cfg, n))) yield ['history', join(cfg, n)];
    for (const [loc, d] of [['paste-cache', 'paste-cache'], ['file-history', 'file-history'], ['todos', 'todos'], ['handoff', join('makarasty', 'handoff')], ['debug', 'debug'], ['shell-snapshots', 'shell-snapshots']]) {
        for (const p of walk(join(cfg, d))) yield [loc, p];
    }
    for (const r of desktopRoots(home, env)) {
        for (const p of walk(join(r, 'claude-code-sessions'), n => /\.json(\.scrub-tmp)?$/.test(n))) yield ['desktop', p];
        for (const p of walk(join(r, 'local-agent-mode-sessions'))) yield ['desktop-agent', p];
    }
}
function* elsewhere(cfg, home) {
    for (const p of new Set([join(home, '.claude.json'), join(cfg, '.claude.json')])) if (existsSync(p)) yield ['.claude.json', p];
    let top = []; try { top = readdirSync(cfg); } catch {}
    for (const n of top) if (/^settings.*\.json/.test(n) && statSync(join(cfg, n)).isFile()) yield ['settings', join(cfg, n)];
    for (const d of ['.codex', '.gemini', '.copilot', join('.config', 'github-copilot')]) for (const p of walk(join(home, d))) yield [d, p];
}

async function processFile(R, loc, p, { apply, minAgeMs, now, hook, report }) {
    let st; try { st = statSync(p); } catch { return; }
    if (p.endsWith('.scrub-tmp')) { R.tmpLeft.push(p); return; }
    if (!report && on('live') && now - st.mtimeMs < minAgeMs) { R.live.push(p); return; }
    if (st.size > MAX) { R.big.push(p); return; }
    R.scanned++; R.bytes += st.size;
    const L = ((report ? R.elsewhereLoc : R.byLoc)[loc] ??= { scanned: 0, files: 0, kinds: {} }); L.scanned++;
    if (!st.size) return;
    try { if (on('binary') && isBinary(p)) { R.binary++; return; } } catch (e) { (report ? R.unreadable : R.failed).push(`${p}: ${e.code ?? e.message}`); return; }
    const mode = p.endsWith('.jsonl') ? 'lines' : st.size <= WHOLE ? 'whole' : 'text-lines';
    const f = { file: p, loc, kinds: {}, samples: [], left: 0, status: apply && !report ? null : 'would-scrub' };
    let r; try { r = await pass(p, mode, f, null); } catch (e) { (report ? R.unreadable : R.failed).push(`${p}: ${e.code ?? e.message}`); return; }
    if (!Object.keys(f.kinds).length) return;
    (report ? R.elsewhere : R.files).push(f);
    L.files++;
    for (const [k, n] of Object.entries(f.kinds)) { L.kinds[k] = (L.kinds[k] ?? 0) + n; if (!report) R.totals[k] = (R.totals[k] ?? 0) + n; }
    if (!report) R.left += f.left;
    if (report) { delete f.samples; return; }
    if (!r.used) f.status = 'left';
    if (f.status) return;
    const tmp = p + '.scrub-tmp';
    let fd = null, ours = false;
    try {
        try { fd = openSync(tmp, on('excl') ? 'wx' : 'w'); ours = true; } catch (e) { if (e.code === 'EEXIST') { f.status = 'busy'; R.busy.push(p); return; } throw e; }
        const w = writer(fd, hook.mangle);
        const r2 = await pass(p, mode, null, w.put);
        w.flush(); fsyncSync(fd);
        const size = fstatSync(fd).size; closeSync(fd); fd = null;
        if (on('size') && (size !== st.size || w.nl !== r2.nl)) { f.status = `failed: copy has ${size} bytes and ${w.nl} newlines, the original ${st.size} and ${r2.nl}`; R.failed.push(`${p}: ${f.status}`); return; }
        hook.beforeRename?.(p);
        const now2 = statSync(p);
        if (on('mtime') && (now2.mtimeMs !== st.mtimeMs || now2.size !== st.size)) { f.status = 'changed-during-scrub'; R.changed.push(p); return; }
        if (!WIN) chmodSync(tmp, st.mode & 0o7777);
        renameSync(tmp, p); ours = false;
        if (on('utimes')) utimesSync(p, st.atime, st.mtime);
        f.status = 'scrubbed'; R.scrubbed++; R.done += r2.used;
    } catch (e) {
        f.status = `failed: ${e.code ?? e.message}`; R.failed.push(`${p}: ${f.status}`);
    } finally {
        if (fd != null) try { closeSync(fd); } catch {}
        if (ours) try { unlinkSync(tmp); } catch {}
    }
}

export async function run({ cfg, home = homedir(), env = process.env, apply = false, minAgeMs = 600000, hook = {} }) {
    const t0 = Date.now();
    const R = { mode: apply ? 'apply' : 'dry-run', cfg, minAgeMs, scanned: 0, bytes: 0, totals: {}, byLoc: {}, files: [], left: 0,
        scrubbed: 0, done: 0, live: [], big: [], busy: [], changed: [], failed: [], binary: 0, tmpLeft: [], elsewhere: [], elsewhereLoc: {}, unreadable: [] };
    const o = { apply, minAgeMs, now: Date.now(), hook };
    for (const [loc, p] of scope(cfg, home, env)) await processFile(R, loc, p, o);
    const before = { scanned: R.scanned, bytes: R.bytes };
    for (const [loc, p] of elsewhere(cfg, home)) await processFile(R, loc, p, { ...o, apply: false, report: true });
    R.elsewhereScanned = R.scanned - before.scanned; R.elsewhereBytes = R.bytes - before.bytes;
    Object.assign(R, before);
    R.ms = Date.now() - t0;
    R.maxRssMB = Math.round(process.resourceUsage().maxRSS / 1024);
    return R;
}

export function render(R, home = homedir()) {
    const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
    const kinds = o => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
    const h = home.replace(/[\\/]+$/, ''), tilde = p => (p.toLowerCase().startsWith(h.toLowerCase()) ? '~' + p.slice(h.length) : p);
    const gb = b => (b / 2 ** 30).toFixed(2) + ' GB';
    const L = [`# scrub ${R.mode}: ${R.scanned} files (${gb(R.bytes)}) in ${(R.ms / 1000).toFixed(1)} s, peak RSS ${R.maxRssMB} MB, min-age ${Math.round(R.minAgeMs / 1000)} s`];
    L.push(R.mode === 'dry-run' ? `found ${sum(R.totals)} secret(s) in ${R.files.length} file(s); nothing written`
        : `found ${sum(R.totals)} secret(s) in ${R.files.length} file(s); scrubbed ${R.done} in ${R.scrubbed} file(s)`);
    L.push(`by kind: ${kinds(R.totals)}`);
    const locs = Object.entries(R.byLoc);
    L.push(`by location: ${locs.filter(([, v]) => v.files).map(([l, v]) => `${l} ${sum(v.kinds)} in ${v.files} file(s)`).join('; ') || 'none'} (files scanned: ${locs.map(([l, v]) => `${l} ${v.scanned}`).join(', ')})`);
    if (R.left) L.push(`left in place: ${R.left} (a line that is not valid JSON, or a change that would alter JSON beyond the secret)`);
    if (R.files.length) { L.push('', '## files'); for (const f of R.files) L.push(`- ${tilde(f.file)}: ${kinds(f.kinds)}${f.left ? `; ${f.left} left` : ''} [${f.status}]${f.samples.length ? ' ' + f.samples.join(', ') : ''}`); }
    if (R.live.length) { L.push('', `## skipped-live: ${R.live.length} file(s) modified in the last ${Math.round(R.minAgeMs / 60000)} min, not read; the next run covers them`); for (const p of R.live) L.push(`- ${tilde(p)}`); }
    const other = [[R.big, 'over 512 MB, not read'], [R.busy, 'busy: a .scrub-tmp beside it exists (another run, or a crash; delete it when no scrub runs)'],
        [R.changed, 'changed-during-scrub, left as it was'], [R.failed, 'failed'], [R.tmpLeft, "leftover .scrub-tmp"], [R.unreadable, "elsewhere, could not be read"]];
    for (const [list, what] of other) if (list.length) { L.push('', `## ${what}: ${list.length}`); for (const p of list) L.push(`- ${tilde(p)}`); }
    if (R.binary) L.push('', `binary files skipped: ${R.binary}`);
    L.push('', `## elsewhere, not touched (${R.elsewhereScanned} files, ${gb(R.elsewhereBytes)}): ${R.elsewhere.length ? '' : 'none found'}`);
    for (const f of R.elsewhere) L.push(`- ${tilde(f.file)}: ${kinds(f.kinds)}`);
    return L.join('\n');
}

export function parseAge(s) {
    const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(String(s ?? ''));
    return m ? Number(m[1]) * { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] ?? 'm'] : null;
}

// ---------------------------------------------------------------- selftest
const X = (seed, n) => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
// [kind, before, the part that must vanish, after]; every value is split after its prefix so this file never matches itself
const KEYS = [
    ['anthropic', 'use sk-ant-', 'api03-' + X('Q1w2E3r4T5', 30), ' now'],
    ['openai', 'key=sk-proj-', X('Zx9Yw8Vu7T', 28), ''],
    ['github', 'push ghp_', X('a1B2c3D4e5', 36), ''],
    ['github', 'pat github_pat_', '11' + X('AbCdE0fGhI', 30), ''],
    ['slack', 'slack xoxb-', '1234567890-' + X('abcDEFghiJ', 12), ''],
    ['aws', 'id AKIA', X('Q2W3E4R5T6', 16), ' ok'],
    ['aws', 'aws_secret_access_key = ', X('wJalrXUtnF7', 40), ''],
    ['google', 'maps AIza', X('SyD4f5G6h7', 35), ''],
    ['telegram', 'bot ', '123456789:' + X('AAHd8f7G6h', 35), ' end'],
    ['stripe', 'pay sk_', 'live_' + X('4eC39HqLyj', 24), ''],
    ['jwt', 'jwt eyJ', 'hbGciOiJIUzI1NiJ9.eyJ' + X('zdWIiOiIx', 20) + '.' + X('dozjgNryP4', 30), ''],
    ['bearer', 'Authorization: Bearer ', X('abcDEF1234', 26), ''],
    ['url-password', 'db postgres://admin:', 'S3cr3tPass9', '@db.local:5432/app'],
    ['keyword', 'password: ', 'Hunter2Secret!', ''],
    ['keyword', 'config {"api_key": "', 'Zq8Wm2Lp5Rt7Yx', '"}'],
    ['private-key', '-----BEGIN RSA ' + 'PRIVATE KEY-----\n', [X('MIIEowIBAA', 64), X('KCAQEAu1Sz', 64), X('t4Lp0Qw9Zx', 20)].join('\n'), '\n-----END RSA ' + 'PRIVATE KEY-----'],
];
const k = kind => KEYS.find(x => x[0] === kind);
const txt = e => e[1] + e[2] + e[3];
const U = content => JSON.stringify({ type: 'user', message: { role: 'user', content } });

function build(root) {
    const cfg = join(root, 'cfg'), home = join(root, 'home'), lad = join(root, 'lad');
    const F = {};
    const put = (name, rel, content) => { const p = join(root, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, content, 'latin1'); F[name] = p; };
    const gl = 'key AIza' + X('SyD4f5G6h7', 35);
    const image = 'iVBORw0KGgoAAAANSUhEUgAA' + 'xAIza' + X('SyD4f5G6h7', 35) + 'yAKIA' + X('Q2W3E4R5T6', 16) + 'zghp_' + X('a1B2c3D4e5', 36) + 'qsk-ant-' + X('abc1', 30) + 'AAAA';
    const places = ['password: changeme123', 'api_key=${API_KEY}', 'token: <your-token>', 'Bearer ${TOKEN}', 'postgres://user:password@localhost/db',
        'password: string', 'token: process.env.TOKEN', 'secret = os.environ["SECRET"]', '-----BEGIN ' + 'PRIVATE KEY-----\n...\n-----END ' + 'PRIVATE KEY-----',
        'password: ********', 'AKIA' + 'IOSFODNN7EXAMPLE', 'pwd: /home/me/project', 'sk-' + 'x'.repeat(24), '"max_tokens": 4096',
        'apiKey = Deno.env.get("K")', 'f(token: string): void', 'token = (await getToken())', 'password: z.string().min(8)', 'token = `${a}`',
        'token = ++n', 'token: "^1.2.3"', 'token = getToken(1).value', 'secret = Map<string>()', 'token = @@TOKEN@@', 'token: "--color-primary"', 'password = !isAdmin', 'token = !!user?.token','api_key=abc-def-...'].join('\n');
    const neg = {
        image: JSON.stringify({ type: 'user', message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }] } }),
        places: U(places), plain: U('risk-assessment-framework-for-teams-and-more and 123456789 words'),
        number: '{"type":"progress","output_token":123456789,"note":"' + gl + '"}', cut: '{"type":"user","message":{"content":"' + gl + ' and',
    };
    put('s1', 'cfg/projects/p/s1.jsonl', KEYS.map(e => U(txt(e))).join('\n') + '\n');
    put('s2', 'cfg/projects/p/s2.jsonl', Object.values(neg).join('\n') + '\n');
    put('crlf', 'cfg/projects/p/crlf.jsonl', U(txt(k('slack'))) + '\r\n' + U(txt(k('anthropic'))));
    put('sub', 'cfg/projects/p/s1/subagents/agent-a.jsonl', U(txt(k('anthropic'))) + '\n');
    put('hist', 'cfg/history.jsonl', JSON.stringify({ display: txt(k('anthropic')) }) + '\n');
    put('paste', 'cfg/paste-cache/abc.txt', 'notes\n' + txt(k('private-key')) + '\nand ' + txt(k('github')) + '\n');
    put('fh', 'cfg/file-history/s/abc@v1', 'const k = "' + txt(k('google')) + '";\n');
    put('bin', 'cfg/file-history/s/bin@v1', '\0\x01' + txt(k('google')));
    put('todo', 'cfg/todos/t.json', JSON.stringify([{ content: 'rotate ' + txt(k('slack')), status: 'pending' }]));
    put('handoff', 'cfg/makarasty/handoff/h.md', '# handoff\ntoken=ab12cd34ef56\n');
    put('desk', 'lad/Claude-Profiles/dev/claude-code-sessions/a/b/local_1.json', JSON.stringify({ title: 't', note: txt(k('google')) }, null, 2));
    put('busy', 'cfg/projects/p/busy.jsonl', U(txt(k('github'))) + '\n');
    put('busyTmp', 'cfg/projects/p/busy.jsonl.scrub-tmp', 'OTHER');
    put('live', 'cfg/projects/p/live.jsonl', U(txt(k('github'))) + '\n');
    put('cj', 'home/.claude.json', JSON.stringify({ k: txt(k('anthropic')) }));
    put('codex', 'home/.codex/history.jsonl', U(txt(k('github'))) + '\n');
    const old = new Date(Date.now() - 864e5);
    for (const [n, p] of Object.entries(F)) if (n !== 'live') utimesSync(p, old, old);
    return { cfg, home, env: { LOCALAPPDATA: lad }, F, neg };
}

const nls = s => s.split('\n').length;
const eq = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const EXPECT = { anthropic: 4, openai: 1, github: 4, slack: 3, aws: 2, google: 5, telegram: 1, stripe: 1, jwt: 1, bearer: 1, 'url-password': 1, keyword: 4, 'private-key': 2 };

// Every assertion of the selftest; returns the failed ones instead of throwing, so a broken guard can be shown red.
async function scenario() {
    const bad = [], ok = (c, m) => { if (!c) bad.push(m); };
    const root = mkdtempSync(join(tmpdir(), 'scrub-st-'));
    try {
        const B = build(root), { F } = B;
        const snap = Object.fromEntries(Object.entries(F).map(([n, p]) => [n, { s: readFileSync(p, 'latin1'), m: statSync(p).mtimeMs }]));
        const dry = await run({ ...B });
        ok(eq(dry.totals, EXPECT), 'dry-run totals ' + JSON.stringify(dry.totals));
        ok(dry.left === 2, 'dry-run left ' + dry.left);
        ok(dry.live.length === 1 && dry.live[0] === F.live, 'live file reported as skipped-live');
        ok(dry.elsewhere.length === 2 && dry.elsewhereLoc['.claude.json']?.kinds.anthropic === 1 && dry.elsewhereLoc['.codex']?.kinds.github === 1, 'elsewhere counted');
        ok(dry.binary === 1, 'binary skipped');
        const shown = JSON.stringify(dry) + render(dry, B.home);
        for (const e of KEYS) ok(!shown.includes(e[2].slice(0, 6)), 'dry run printed a value of ' + e[0]);
        ok(/github L1 ghp_…/.test(shown) && /keyword L2(?! )/.test(shown), 'samples: prefix and line, no value');
        for (const [n, p] of Object.entries(F)) ok(readFileSync(p, 'latin1') === snap[n].s, 'dry run changed ' + n);

        const ap = await run({ ...B, apply: true });
        ok(ap.scrubbed === 10 && ap.failed.length === 0, `scrubbed ${ap.scrubbed}, failed ${ap.failed.join('; ')}`);
        ok(ap.busy.length === 1 && readFileSync(F.busyTmp, 'latin1') === 'OTHER' && readFileSync(F.busy, 'latin1') === snap.busy.s, 'busy file and its .scrub-tmp left as they were');
        for (const n of ['live', 'bin', 'cj', 'codex']) ok(readFileSync(F[n], 'latin1') === snap[n].s, n + ' must not change');
        for (const n of ['s1', 's2', 'crlf', 'sub', 'hist', 'paste', 'fh', 'todo', 'handoff', 'desk']) {
            const s = readFileSync(F[n], 'latin1'), o = snap[n].s;
            ok(s !== o, n + ' unchanged');
            ok(s.length === o.length && nls(s) === nls(o), n + ' size or line count changed');
            ok(Math.abs(statSync(F[n]).mtimeMs - snap[n].m) < 2, n + ' mtime not kept');
            if (n.match(/^(s1|s2|crlf|sub|hist)$/)) o.split('\n').forEach((l, i) => { if (parse(l).ok) ok(parse(s.split('\n')[i]).ok, `${n} line ${i + 1} no longer parses`); });
            if (n !== 's2') for (const e of KEYS) ok(!s.includes(e[2].slice(0, 12)), `${n}: ${e[0]} still there`); // s2 holds look-alikes on purpose
        }
        const s1 = readFileSync(F.s1, 'latin1');
        ok(s1.includes('ghp_****') && s1.includes('AIza****') && s1.includes('push ') && s1.includes('@db.local:5432/app') && s1.includes('admin:***********@'), 'prefix and context kept');
        ok(parse(s1.split('\n')[KEYS.length - 1]).v?.message.content.split('\n').length === 5, 'private key keeps its line breaks');
        const s2 = readFileSync(F.s2, 'latin1').split('\n');
        ok(s2[0] === B.neg.image, 'base64 look-alike changed'); ok(s2[1] === B.neg.places, 'placeholder changed'); ok(s2[2] === B.neg.plain, 'plain text changed');
        ok(s2[3].includes(':123456789,') && !s2[3].includes('SyD4f5'), 'number kept, key in the same line scrubbed'); ok(s2[4] === B.neg.cut, 'unparsed line changed');
        ok(readFileSync(F.crlf, 'latin1').includes('\r\n') && !readFileSync(F.crlf, 'latin1').endsWith('\n'), 'CRLF and missing final newline kept');
        const tmps = [...walk(root, x => x.endsWith('.scrub-tmp'))];
        ok(tmps.length === 1 && tmps[0] === F.busyTmp, '.scrub-tmp left: ' + tmps.length);

        const again = await run({ ...B });
        ok(eq(again.totals, { github: 1, google: 1, keyword: 1 }) && again.left === 2, 'rerun finds only busy and left ones: ' + JSON.stringify(again.totals));

        // a writer appends while we scrub; a copy that comes out short
        writeFileSync(F.hist, snap.hist.s, 'latin1'); utimesSync(F.hist, new Date(snap.hist.m), new Date(snap.hist.m));
        const r1 = await run({ ...B, apply: true, hook: { beforeRename: p => { if (p === F.hist) appendFileSync(p, '{"x":1}\n'); } } });
        ok(r1.changed.includes(F.hist) && readFileSync(F.hist, 'latin1') === snap.hist.s + '{"x":1}\n', 'append during scrub must win');
        writeFileSync(F.sub, snap.sub.s, 'latin1'); utimesSync(F.sub, new Date(snap.sub.m), new Date(snap.sub.m));
        const r2 = await run({ ...B, apply: true, hook: { mangle: s => s.slice(0, -1) } });
        ok(r2.failed.some(x => x.startsWith(F.sub)) && readFileSync(F.sub, 'latin1') === snap.sub.s, 'short copy must not replace the file');
        ok([...walk(root, x => x.endsWith('.scrub-tmp'))].length === 1, 'no .scrub-tmp after failures');
    } catch (e) { bad.push('threw: ' + (e.stack || e)); } finally { rmSync(root, { recursive: true, force: true }); }
    return bad;
}

async function selftest() {
    let fail = 0;
    const green = await scenario();
    if (green.length) { fail++; console.log('FAIL\n- ' + green.join('\n- ')); } else console.log('ok: all assertions');
    for (const g of ['boundary', 'placeholder', 'live', 'binary', 'json', 'escapes', 'size', 'mtime', 'utimes', 'excl']) {
        BROKEN.add(g);
        const red = await scenario();
        BROKEN.delete(g);
        if (red.length) console.log(`ok: guard ${g} broken -> red (${red[0].slice(0, 80)})`); else { fail++; console.log(`FAIL: guard ${g} broken, still green`); }
    }
    for (const [a, code] of [[['--min-age', 'soon'], 2], [['--bogus'], 2]]) {
        const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...a], { encoding: 'utf8' });
        if (r.status !== code) { fail++; console.log(`FAIL: ${a.join(' ')} exit ${r.status}`); }
    }
    for (const [v, ms] of [['10m', 6e5], ['0', 0], ['30s', 3e4], ['2h', 72e5], ['5', 3e5], ['x', null]]) if (parseAge(v) !== ms) { fail++; console.log('FAIL: parseAge ' + v); }
    console.log(fail ? `scrub.mjs selftest FAILED (${fail})` : 'scrub.mjs selftest done');
    process.exitCode = fail ? 1 : 0;
}

async function main(argv) {
    if (argv[0] === '--selftest') return selftest();
    const known = new Set(['--apply', '--json', '--root', '--min-age']);
    for (let i = 0; i < argv.length; i++) {
        if (!known.has(argv[i])) { console.error(`unknown argument ${argv[i]}\nusage: node scrub.mjs [--apply] [--root <dir>] [--min-age 10m] [--json] | --selftest`); process.exit(2); }
        if (argv[i] === '--root' || argv[i] === '--min-age') i++;
    }
    const flag = n => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1]; };
    const minAgeMs = flag('--min-age') === undefined ? 6e5 : parseAge(flag('--min-age'));
    if (minAgeMs == null) { console.error(`--min-age needs a duration like 10m, 30s, 2h; got "${flag('--min-age') ?? ''}"`); process.exit(2); }
    if (argv.includes('--root') && !flag('--root')) { console.error('--root needs a directory'); process.exit(2); }
    const cfg = resolve(flag('--root') ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'));
    const R = await run({ cfg, apply: argv.includes('--apply'), minAgeMs });
    console.log(argv.includes('--json') ? JSON.stringify(R, null, 1) : render(R));
    if (R.failed.length && R.mode === 'apply') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).catch(e => { console.error(e.stack || e); process.exit(1); });
}
