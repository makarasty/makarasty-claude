#!/usr/bin/env node
// proof.mjs - before/after screenshots of UI work as a numbered HTML report, without the images entering
// the model's context. The browser pane renders the page to PNG with html-to-image and POSTs it to a tiny
// local receiver; only a small JSON line comes back to the model.
//
//   node proof.mjs serve <dir> [--port 0]        receiver on 127.0.0.1; prints PORT=<n>, writes <dir>/.port ("<port> <token>")
//   node proof.mjs snippet <dir> <name> [css-selector]   one JS expression for the pane's javascript_tool
//   node proof.mjs block <dir> --title "..." [--what ".."] [--files a,b] [--before n] [--after n]
//                              [--viewport WxH] [--theme light|dark] [--note ".."] [--id N]
//   node proof.mjs report <dir> [--title ".."] [--out <dir>/report.html] [--inline]
//   node proof.mjs stop <dir>
//   node proof.mjs --selftest
//
// Cache of the html-to-image build: %LOCALAPPDATA%\makarasty\cache (Windows), $XDG_CACHE_HOME or
// ~/.cache/makarasty elsewhere; PROOF_CACHE overrides it (used by the selftest).
//
// shortcut: blocks.jsonl is rewritten whole on an update, so two chats editing one dir at once can lose
// a write; use one dir per chat.
import http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, relative, dirname, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, mkdtempSync, readdirSync, copyFileSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import assert from 'node:assert/strict';

const LIB_VERSION = '1.11.11';
const LIB_URL = `https://cdn.jsdelivr.net/npm/html-to-image@${LIB_VERSION}/dist/html-to-image.js`;
const LIB_SHA = '0181b9a4ea3351540751b2e72b6baecb5c2297093fcb0bd2af94fc531cb0fbda'; // sha256 of the 1.11.11 UMD build
const MAX_BODY = 25 * 1024 * 1024;
const MAX_FILES = 300, MAX_DIR_BYTES = 500 * 1024 * 1024; // per <dir>
const MAX_INLINE = 15 * 1024 * 1024;
const IDLE_MS = 2 * 60 * 60 * 1000;
const NAME_RE = /^[A-Za-z0-9][\w.-]{0,80}$/;
const RESERVED_RE = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i; // Windows device names
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function cacheDir() {
    if (process.env.PROOF_CACHE) return process.env.PROOF_CACHE;
    if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'makarasty', 'cache');
    return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'makarasty');
}

const sha = b => createHash('sha256').update(b).digest('hex');
let libPromise;
export function getLib(want = LIB_SHA, url = LIB_URL) {
    const file = join(cacheDir(), `html-to-image-${LIB_VERSION}.js`);
    if (existsSync(file)) {
        const b = readFileSync(file);
        if (sha(b) === want) return Promise.resolve(b);
        rmSync(file, { force: true });
        return Promise.reject(new Error('cached html-to-image failed its sha256 check; cache deleted'));
    }
    libPromise ??= (async () => {
        const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw new Error(`download ${url}: HTTP ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (sha(buf) !== want) throw new Error('downloaded html-to-image failed its sha256 check; not cached');
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, buf);
        renameSync(tmp, file);
        return buf;
    })().finally(() => { libPromise = undefined; });
    return libPromise;
}

export function decodePng(body) {
    let buf = body;
    const s = body.subarray(0, 64).toString('latin1');
    if (s.startsWith('data:')) {
        const m = /^data:image\/png;base64,/.exec(s);
        if (!m) throw new Error('only data:image/png;base64 is accepted');
        buf = Buffer.from(body.toString('latin1', m[0].length), 'base64');
    }
    if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('body is not a PNG');
    return { buf, w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

export function startServer(dir, port = 0, { libSha = LIB_SHA, libUrl = LIB_URL, maxFiles = MAX_FILES, maxBytes = MAX_DIR_BYTES, idleMs = IDLE_MS } = {}) {
    dir = resolve(dir);
    mkdirSync(dir, { recursive: true });
    let last = Date.now();
    const token = randomBytes(16).toString('hex');
    const tokenOk = t => { const a = Buffer.from(String(t ?? '')), b = Buffer.from(token); return a.length === b.length && timingSafeEqual(a, b); };
    // CORS stays * on purpose: any page may reach us, but /shot, /lib.js and /ping need the token that only
    // the snippet (made from <dir>/.port) carries, and the Host check stops DNS rebinding.
    const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type', // no custom headers: a web page cannot call /stop
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
    };
    const send = (res, code, obj, type = 'application/json') => {
        res.writeHead(code, { ...cors, 'Content-Type': type });
        res.end(typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj));
    };
    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://127.0.0.1');
            const p = server.address()?.port;
            if (![`127.0.0.1:${p}`, `localhost:${p}`].includes(String(req.headers.host).toLowerCase())) return send(res, 403, { ok: false, error: 'bad host' });
            if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
            if (req.method === 'POST' && url.pathname === '/stop') {
                if (req.headers['x-proof'] !== 'stop') return send(res, 403, { ok: false, error: 'forbidden' });
                send(res, 200, { ok: true });
                return setTimeout(() => close(), 20);
            }
            if (!tokenOk(url.searchParams.get('t'))) return send(res, 403, { ok: false, error: 'token required' });
            if (req.method === 'GET' && url.pathname === '/ping') return send(res, 200, { ok: true });
            if (req.method === 'GET' && url.pathname === '/lib.js') {
                try { return send(res, 200, await getLib(libSha, libUrl), 'application/javascript'); }
                catch (e) { return send(res, 502, { ok: false, error: String(e.message) }); }
            }
            if (req.method === 'POST' && url.pathname === '/shot') {
                const name = url.searchParams.get('name') ?? '';
                if (!NAME_RE.test(name) || RESERVED_RE.test(name)) return send(res, 400, { ok: false, error: 'bad name' });
                const file = resolve(dir, `${name}.png`);
                if (dirname(file) !== dir) return send(res, 400, { ok: false, error: 'bad name' });
                const chunks = [];
                let size = 0;
                for await (const c of req) {
                    size += c.length;
                    if (size > MAX_BODY) { send(res, 413, { ok: false, error: 'body over 25 MB' }); return req.destroy(); }
                    chunks.push(c);
                }
                let png;
                try { png = decodePng(Buffer.concat(chunks)); } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
                let n = 0, b = 0;
                for (const f of readdirSync(dir)) if (f.endsWith('.png') && f !== `${name}.png`) { n++; b += statSync(join(dir, f)).size; }
                if (n >= maxFiles || b + png.buf.length > maxBytes) return send(res, 413, { ok: false, error: `dir is full (${maxFiles} files / ${maxBytes >> 20} MB)` });
                const tmp = `${file}.${process.pid}.tmp`;
                writeFileSync(tmp, png.buf);
                renameSync(tmp, file);
                last = Date.now(); // only a valid shot keeps the receiver alive
                return send(res, 200, { ok: true, bytes: png.buf.length, w: png.w, h: png.h });
            }
            send(res, 404, { ok: false, error: 'not found' });
        } catch (e) { send(res, 500, { ok: false, error: String(e.message) }); }
    });
    const portFile = join(dir, '.port');
    const close = () => { clearInterval(idle); rmSync(portFile, { force: true }); server.close(); server.closeAllConnections?.(); };
    const idle = setInterval(() => { if (Date.now() - last > idleMs) close(); }, Math.min(60000, idleMs));
    idle.unref();
    return new Promise((ok, no) => {
        server.once('error', no);
        server.listen(port, '127.0.0.1', () => {
            const p = server.address().port;
            writeFileSync(portFile, `${p} ${token}`);
            ok({ port: p, token, close, server });
        });
    });
}

// .port is "<port> <token>"; the old format was the bare port (token '').
export const readPortFile = dir => { try { const [p, t = ''] = readFileSync(join(resolve(dir), '.port'), 'utf8').trim().split(/\s+/); return { port: Number(p) || 0, token: t }; } catch { return { port: 0, token: '' }; } };
const readPort = dir => readPortFile(dir).port;

async function alive(port, token = '') {
    if (!port) return false;
    try { return (await fetch(`http://127.0.0.1:${port}/ping?t=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}

export function snippet(port, name, selector, token = '') {
    if (!NAME_RE.test(name)) throw new Error(`bad name: ${name}`);
    const P = JSON.stringify(`http://127.0.0.1:${port}`), N = JSON.stringify(name), S = JSON.stringify(selector || null), T = JSON.stringify(token);
    // No selector: document.body clipped to the visible viewport (width/height = inner size, style transform
    // undoes the scroll). With a selector: that element whole, however tall it is.
    return `(async()=>{const P=${P},N=${N},S=${S},T=${T};const W=(p,m)=>Promise.race([p,new Promise((_,no)=>setTimeout(()=>no(new Error(m)),20000))]);try{` +
        `if(!window.htmlToImage){await new Promise((ok,no)=>{const s=document.createElement('script');s.src=P+'/lib.js?t='+encodeURIComponent(T);s.onload=ok;s.onerror=()=>no(new Error('lib.js blocked or unreachable (CSP?)'));document.head.appendChild(s);setTimeout(()=>no(new Error('lib.js load timeout 10s')),10000)})}` +
        `const el=S?document.querySelector(S):document.body;if(!el)throw new Error('no element for '+S);` +
        `let bg='#ffffff';for(let e=el;e;e=e.parentElement){const c=getComputedStyle(e).backgroundColor;if(c&&c!=='transparent'&&c!=='rgba(0, 0, 0, 0)'){bg=c;break}}` +
        `const o={pixelRatio:Math.min(devicePixelRatio||1,2),cacheBust:true,backgroundColor:bg};` +
        `if(!S){o.width=innerWidth;o.height=innerHeight;o.style={transform:'translate('+(-scrollX)+'px,'+(-scrollY)+'px)',transformOrigin:'top left'}}` +
        `const d=await W(htmlToImage.toPng(el,o),'toPng timeout 20s');` +
        `const j=await W(fetch(P+'/shot?name='+encodeURIComponent(N)+'&t='+encodeURIComponent(T),{method:'POST',body:d}).then(r=>r.json()),'upload timeout 20s');` +
        `if(!j.ok)throw new Error(j.error||'receiver refused');` +
        `return JSON.stringify({ok:true,name:N,w:j.w,h:j.h,bytes:j.bytes})` +
        `}catch(e){return JSON.stringify({ok:false,error:String(e&&e.message||e).slice(0,200)})}})()`;
}

// ---- blocks ----
const blocksFile = dir => join(resolve(dir), 'blocks.jsonl');
export function readBlocks(dir) {
    const f = blocksFile(dir);
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)).sort((a, b) => a.id - b.id);
}

export function upsertBlock(dir, o) {
    mkdirSync(resolve(dir), { recursive: true });
    const blocks = readBlocks(dir);
    const fields = { title: o.title, what: o.what, files: o.files === undefined ? undefined : String(o.files).split(',').map(s => s.trim()).filter(Boolean), before: o.before, after: o.after, viewport: o.viewport, theme: o.theme, note: o.note };
    if (fields.viewport !== undefined && !/^\d{2,5}x\d{2,5}$/.test(fields.viewport)) throw new Error('--viewport must look like 1280x720');
    if (fields.theme !== undefined && !['light', 'dark'].includes(fields.theme)) throw new Error('--theme must be light or dark');
    for (const k of ['before', 'after']) if (fields[k] !== undefined && !NAME_RE.test(fields[k])) throw new Error(`--${k} is not a valid image name`);
    for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];
    let b;
    if (o.id !== undefined) {
        b = blocks.find(x => x.id === Number(o.id));
        if (!b) throw new Error(`no block ${o.id}`);
        Object.assign(b, fields);
    } else {
        if (!fields.title) throw new Error('--title is required for a new block');
        b = { id: Math.max(0, ...blocks.map(x => x.id)) + 1, ...fields };
        blocks.push(b);
    }
    writeFileSync(blocksFile(dir), blocks.map(x => JSON.stringify(x)).join('\n') + '\n');
    return b;
}

// ---- report ----
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CSS = `:root{--bg:#f6f7f9;--card:#fff;--fg:#1b1f24;--mut:#5c6670;--line:#d8dde3;--acc:#2b6cb0;--chip:#e9edf2}
@media(prefers-color-scheme:dark){:root{--bg:#14171a;--card:#1d2227;--fg:#e8ebee;--mut:#9aa4ae;--line:#323a42;--acc:#7ab4f0;--chip:#2a3138}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px 64px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1280px;margin:0 auto}h1{font-size:26px;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 24px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin:0 0 20px}
.num{font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--acc)}
h2{font-size:21px;margin:2px 0 8px}.chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.chip{background:var(--chip);color:var(--mut);border-radius:999px;padding:2px 10px;font-size:12px}
.what{margin:6px 0}.files{color:var(--mut);font-size:13px;word-break:break-all}.files code{background:var(--chip);padding:1px 5px;border-radius:4px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}@media(max-width:700px){.pair{grid-template-columns:1fr}}
figure{margin:0;min-width:0}figcaption{font-size:12px;font-weight:600;color:var(--mut);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}
img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:6px;cursor:zoom-in;background:#fff}
.none{border:1px dashed var(--line);border-radius:6px;padding:14px;color:var(--mut)}.note{margin-top:12px;padding:8px 12px;border-left:3px solid var(--acc);background:var(--chip)}
#zoom{position:fixed;inset:0;background:rgba(0,0,0,.85);display:none;overflow:auto;cursor:zoom-out;z-index:9}#zoom.on{display:block}#zoom img{width:auto;max-width:none;margin:0 auto;border:0;border-radius:0;cursor:zoom-out}`;

const JS = `document.addEventListener('click',function(e){var z=document.getElementById('zoom');if(e.target.matches&&e.target.matches('figure img')){z.firstChild.src=e.target.src;z.className='on'}else if(z.className){z.className='';z.firstChild.removeAttribute('src')}});document.addEventListener('keydown',function(e){if(e.key==='Escape'){var z=document.getElementById('zoom');z.className='';z.firstChild.removeAttribute('src')}});`;

export function buildReport(dir, { title = 'Отчёт по UI', out, inline = false, maxInline = MAX_INLINE } = {}) {
    dir = resolve(dir);
    out = resolve(out || join(dir, 'report.html'));
    const warn = [];
    const rel = relative(dir, dirname(out));
    const outside = rel.startsWith('..') || isAbsolute(rel); // another folder or drive: relative links would break
    const img = (name, label, alt) => {
        if (!name) return null;
        const f = join(dir, `${name}.png`);
        if (!existsSync(f)) { warn.push(`image missing: ${name}.png`); return `<figure><figcaption>${esc(label)}</figcaption><div class="none">Файл ${esc(name)}.png не найден.</div></figure>`; }
        let src;
        if (inline) src = `data:image/png;base64,${readFileSync(f).toString('base64')}`;
        else if (outside) { mkdirSync(dirname(out), { recursive: true }); copyFileSync(f, join(dirname(out), `${name}.png`)); src = encodeURIComponent(`${name}.png`); }
        else src = relative(dirname(out), f).split(sep).map(encodeURIComponent).join('/');
        return `<figure><figcaption>${esc(label)}</figcaption><img src="${esc(src)}" alt="${esc(alt)}" loading="lazy"></figure>`;
    };
    const sections = readBlocks(dir).map(b => {
        const pair = [img(b.before, 'Как было', `Блок ${b.id}: как было`), img(b.after, 'Как стало', `Блок ${b.id}: как стало`)].filter(Boolean);
        const chips = [b.viewport && `viewport ${b.viewport}`, b.theme && `тема: ${b.theme}`].filter(Boolean).map(c => `<span class="chip">${esc(c)}</span>`).join('');
        return `<section id="b${b.id}"><div class="num">Блок ${b.id}</div><h2>${esc(b.title)}</h2>` +
            (chips ? `<div class="chips">${chips}</div>` : '') +
            (b.what ? `<p class="what">${esc(b.what)}</p>` : '') +
            (b.files?.length ? `<div class="files">${b.files.map(f => `<code>${esc(f)}</code>`).join(' ')}</div>` : '') +
            (pair.length ? `<div class="pair">${pair.join('')}</div>` : `<div class="none">Снимка нет${b.note ? ': причина в примечании ниже' : ' (причина не записана)'}.</div>`) +
            (b.note ? `<div class="note">${esc(b.note)}</div>` : '') + `</section>`;
    });
    const html = `<!doctype html>\n<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title><style>${CSS}</style></head><body><main><h1>${esc(title)}</h1><p class="sub">Блоков: ${sections.length}. Скажите «блок N переделай» - переделаю один блок.</p>${sections.join('\n')}</main><div id="zoom"><img alt=""></div><script>${JS}</script></body></html>\n`;
    const bytes = Buffer.byteLength(html);
    if (inline && bytes > maxInline) { // too big for an Artifact: write the linked variant instead
        const r = buildReport(dir, { title, out, inline: false, maxInline });
        r.warn.unshift(`inline report would be ${(bytes / 1048576).toFixed(1)} MB, over ${maxInline / 1048576} MB: wrote the linked variant (PNGs beside it) instead`);
        r.linked = true;
        return r;
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html);
    return { out, bytes, blocks: sections.length, warn };
}

// ---- cli ----
export function parseArgs(argv) {
    const pos = [], flags = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--inline') flags.inline = true;
        else if (a.startsWith('--')) { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); flags[a.slice(2)] = argv[++i]; }
        else pos.push(a);
    }
    return { pos, flags };
}

async function stopServer(dir) {
    const { port, token } = readPortFile(dir);
    if (!port) return false;
    try { await fetch(`http://127.0.0.1:${port}/stop`, { method: 'POST', headers: { 'X-Proof': 'stop' }, signal: AbortSignal.timeout(3000) }); } catch { /* already gone */ }
    for (let i = 0; i < 20 && await alive(port, token); i++) await new Promise(r => setTimeout(r, 100));
    rmSync(join(resolve(dir), '.port'), { force: true });
    return true;
}

async function selftest() {
    const root = mkdtempSync(join(tmpdir(), 'proof-selftest-'));
    const dir = join(root, 'out');
    process.env.PROOF_CACHE = join(root, 'cache');
    mkdirSync(process.env.PROOF_CACHE, { recursive: true });
    writeFileSync(join(process.env.PROOF_CACHE, `html-to-image-${LIB_VERSION}.js`), 'window.htmlToImage={};');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const FAKE = 'window.htmlToImage={};';
    const srv = await startServer(dir, 0, { libSha: sha(FAKE) });
    const T = srv.token;
    try {
        const base = `http://127.0.0.1:${srv.port}`;
        assert.equal(readPort(dir), srv.port, '.port written');
        assert.deepEqual(readPortFile(dir), { port: srv.port, token: T }, '.port is "<port> <token>"');
        assert.match(T, /^[0-9a-f]{32}$/, 'token is 16 random bytes in hex');
        assert.deepEqual(readPortFile(join(root, 'nothing')), { port: 0, token: '' }, 'missing .port reads as none');
        mkdirSync(join(root, 'oldfmt')); writeFileSync(join(root, 'oldfmt', '.port'), '4242\n');
        assert.deepEqual(readPortFile(join(root, 'oldfmt')), { port: 4242, token: '' }, 'old bare-port format still read');
        const post = (name, body) => fetch(`${base}/shot?name=${encodeURIComponent(name)}&t=${T}`, { method: 'POST', body });
        let r = await post('01-before', 'data:image/png;base64,' + png.toString('base64'));
        let j = await r.json();
        assert.deepEqual([r.status, j.ok, j.bytes, j.w, j.h], [200, true, png.length, 1, 1], 'data url saved');
        assert.ok(readFileSync(join(dir, '01-before.png')).equals(png), 'file bytes match');
        r = await post('01-after', png);
        assert.equal(r.status, 200, 'raw PNG accepted');
        assert.equal((await post('../x', png)).status, 400, 'traversal name rejected');
        assert.equal((await post('a/b', png)).status, 400, 'slash name rejected');
        assert.equal((await post('nul', png)).status, 400, 'device name rejected');
        assert.equal((await post('notpng', 'hello')).status, 400, 'non-PNG rejected');
        assert.equal(existsSync(join(root, 'x.png')), false, 'nothing written outside dir');
        const big = Buffer.concat([png, Buffer.alloc(MAX_BODY)]);
        let bigStatus;
        try { bigStatus = (await post('big', big)).status; } catch { bigStatus = 413; } // the server may reset the socket mid-upload
        assert.equal(bigStatus, 413, 'oversize body rejected');
        assert.equal(existsSync(join(dir, 'big.png')), false, 'oversize not written');
        const pre = await fetch(`${base}/shot?name=a`, { method: 'OPTIONS' });
        assert.equal(pre.status, 204, 'preflight answered');
        assert.equal(pre.headers.get('access-control-allow-private-network'), 'true', 'PNA header');
        assert.equal(pre.headers.get('access-control-allow-origin'), '*', 'CORS header');
        assert.equal(await (await fetch(`${base}/lib.js?t=${T}`)).text(), FAKE, 'lib.js from cache');
        assert.equal((await fetch(`${base}/stop`, { method: 'POST' })).status, 403, 'stop needs the header');
        assert.equal(await alive(srv.port, T), true, 'still alive after refused stop');

        // P1: token, Host, caps, atomic write, idle
        const rawGet = (path, host) => new Promise((ok, no) => { const q = http.request({ host: '127.0.0.1', port: srv.port, path, method: 'GET', headers: host ? { Host: host } : {} }, r => { r.resume(); ok(r.statusCode); }); q.on('error', no); q.end(); });
        assert.equal((await fetch(`${base}/shot?name=nt`, { method: 'POST', body: png })).status, 403, '/shot without token refused');
        assert.equal((await fetch(`${base}/shot?name=nt&t=${'0'.repeat(32)}`, { method: 'POST', body: png })).status, 403, '/shot with wrong token refused');
        assert.equal((await fetch(`${base}/shot?name=nt&t=x`, { method: 'POST', body: png })).status, 403, '/shot with short token refused');
        assert.equal(existsSync(join(dir, 'nt.png')), false, 'refused shot not written');
        assert.equal((await fetch(`${base}/lib.js`)).status, 403, '/lib.js without token refused');
        assert.equal((await fetch(`${base}/ping`)).status, 403, '/ping without token reveals nothing');
        assert.equal((await fetch(`${base}/ping?t=${T}`)).status, 200, '/ping with token ok');
        assert.equal(await rawGet(`/ping?t=${T}`, `localhost:${srv.port}`), 200, 'Host localhost:<port> accepted');
        assert.equal(await rawGet(`/ping?t=${T}`, 'evil.example:' + srv.port), 403, 'foreign Host refused (DNS rebinding)');
        assert.equal(await rawGet(`/ping?t=${T}`, '127.0.0.1'), 403, 'Host without the port refused');
        assert.deepEqual(readdirSync(dir).filter(f => f.endsWith('.tmp')), [], 'no temp file left after writes');
        const shotTo = (s, name) => fetch(`http://127.0.0.1:${s.port}/shot?name=${name}&t=${s.token}`, { method: 'POST', body: png }).then(r => r.status);
        const s2 = await startServer(join(root, 'caps'), 0, { maxFiles: 2 });
        try {
            assert.deepEqual([await shotTo(s2, 'a'), await shotTo(s2, 'b')], [200, 200], 'under the file cap');
            assert.equal(await shotTo(s2, 'c'), 413, 'file cap refuses a third image');
            assert.equal(await shotTo(s2, 'a'), 200, 'overwriting an existing name is not counted twice');
        } finally { s2.close(); }
        const s3 = await startServer(join(root, 'bytes'), 0, { maxBytes: png.length * 2 - 1 });
        try {
            assert.deepEqual([await shotTo(s3, 'a'), await shotTo(s3, 'b')], [200, 413], 'byte cap refuses the image that would pass it');
        } finally { s3.close(); }
        const s4 = await startServer(join(root, 'idle'), 0, { idleMs: 400 });
        let st4 = 0;
        for (let i = 0; i < 25 && st4 !== 'down'; i++) { // unauthenticated pings must not keep it alive
            await new Promise(r => setTimeout(r, 100));
            st4 = await fetch(`http://127.0.0.1:${s4.port}/ping`).then(r => r.status, () => 'down');
        }
        assert.equal(st4, 'down', 'only a valid shot refreshes the idle timer');
        s4.close();

        // P2: pinned library hash
        const cacheFile = join(process.env.PROOF_CACHE, `html-to-image-${LIB_VERSION}.js`);
        writeFileSync(cacheFile, 'window.evil=1');
        r = await fetch(`${base}/lib.js?t=${T}`);
        assert.equal(r.status, 502, 'tampered cache answered 502');
        assert.equal(existsSync(cacheFile), false, 'tampered cache deleted');
        const evil = http.createServer((q, a) => { a.end('window.evil=2'); }).listen(0, '127.0.0.1');
        await new Promise(r => evil.once('listening', r));
        const s5 = await startServer(join(root, 'dl'), 0, { libSha: sha(FAKE), libUrl: `http://127.0.0.1:${evil.address().port}/x.js` });
        try {
            r = await fetch(`http://127.0.0.1:${s5.port}/lib.js?t=${s5.token}`);
            assert.equal(r.status, 502, 'download with the wrong hash answered 502');
            assert.equal(existsSync(cacheFile), false, 'bad download not cached');
        } finally { s5.close(); evil.close(); evil.closeAllConnections?.(); }
        writeFileSync(cacheFile, FAKE);
        assert.equal(LIB_SHA, '0181b9a4ea3351540751b2e72b6baecb5c2297093fcb0bd2af94fc531cb0fbda', 'pinned hash constant');

        const sn = snippet(srv.port, '01-before', '#app', T);
        new Function(`return ${sn}`); // parses as one expression
        assert.ok(sn.includes(`127.0.0.1:${srv.port}`) && sn.includes('"#app"'), 'snippet carries port and selector');
        assert.ok(sn.includes(`"${T}"`) && sn.includes("'&t='") && sn.includes("'/lib.js?t='"), 'snippet carries the token');
        // P4: a toPng that never settles still yields JSON (the 20 s timer is shortened to 10 ms here)
        const stub = (f, ms) => setTimeout(f, ms === 20000 ? 10 : ms);
        const run = new Function('setTimeout', 'window', 'document', 'htmlToImage', 'getComputedStyle', 'devicePixelRatio', 'innerWidth', 'innerHeight', 'scrollX', 'scrollY', `return ${snippet(srv.port, 'h', null, T)}`);
        const out = await Promise.race([run(stub, { htmlToImage: true }, { body: { parentElement: null } }, { toPng: () => new Promise(() => {}) }, () => ({ backgroundColor: 'transparent' }), 1, 100, 100, 0, 0), new Promise(r => setTimeout(() => r('HUNG'), 3000))]);
        assert.ok(String(out).includes('"ok":false') && String(out).includes('toPng timeout'), 'hung toPng gives a JSON error, got ' + out);
        assert.throws(() => snippet(1, '../x'), /bad name/, 'snippet rejects bad name');

        const b1 = upsertBlock(dir, { title: 'Кнопка <script>alert(1)</script>', what: 'padding', files: 'a.vue, b.css', before: '01-before', after: '01-after', viewport: '1280x720', theme: 'dark' });
        const b2 = upsertBlock(dir, { title: 'Второй', note: 'CSP blocked the script' });
        assert.deepEqual([b1.id, b2.id], [1, 2], 'ids count up');
        const b2u = upsertBlock(dir, { id: 2, title: 'Второй (переделан)' });
        assert.equal(b2u.note, 'CSP blocked the script', 'update keeps fields it was not given');
        assert.equal(readBlocks(dir).length, 2, 'update does not add a block');
        assert.throws(() => upsertBlock(dir, { id: 9, title: 'x' }), /no block 9/, 'unknown id');

        const plain = buildReport(dir, { title: 'T <b>x</b>' });
        let html = readFileSync(plain.out, 'utf8');
        assert.ok(html.includes('Блок 1') && html.includes('Блок 2'), 'both blocks');
        assert.ok(/<img src="01-before\.png"/.test(html), 'relative img');
        assert.ok(!html.includes('<script>alert(1)'), 'title escaped');
        assert.ok(html.includes('&lt;script&gt;alert(1)') && html.includes('T &lt;b&gt;x&lt;/b&gt;'), 'escaped text present');
        assert.ok(html.includes('Снимка нет'), 'imageless block says why');
        const inl = buildReport(dir, { inline: true, out: join(dir, 'inline.html') });
        html = readFileSync(inl.out, 'utf8');
        assert.ok(html.includes('src="data:image/png;base64,'), 'inline data uri');
        assert.equal(inl.warn.length, 0, 'no warnings for a tiny report');
        const big2 = buildReport(dir, { inline: true, out: join(dir, 'big.html'), maxInline: 100 });
        html = readFileSync(big2.out, 'utf8');
        assert.ok(big2.linked && big2.warn.some(w => w.includes('linked variant')), 'oversize inline says it fell back');
        assert.ok(!html.includes('data:image/png') && /<img src="01-before\.png"/.test(html), 'oversize inline wrote the linked variant');
        const ext = buildReport(dir, { out: join(root, 'ext', 'r.html') });
        html = readFileSync(ext.out, 'utf8');
        assert.ok(readFileSync(join(root, 'ext', '01-before.png')).equals(png), 'PNG copied next to an --out outside <dir>');
        assert.ok(/<img src="01-before\.png"/.test(html), 'out-of-dir report links the copied PNG');
        const sub = buildReport(dir, { out: join(dir, 'sub', 'r.html') });
        assert.ok(readFileSync(sub.out, 'utf8').includes('src="../01-before.png"') && !existsSync(join(dir, 'sub', '01-before.png')), '--out inside <dir> keeps the relative link');
    } finally {
        assert.equal(await stopServer(dir), true, 'stop finds the port');
        assert.equal(await alive(srv.port, T), false, 'server is down');
        assert.equal(existsSync(join(dir, '.port')), false, '.port removed');
        rmSync(root, { recursive: true, force: true });
    }
    console.log('proof.mjs selftest done');
}

async function main(argv) {
    if (argv[0] === '--selftest') return selftest();
    const [cmd, ...rest] = argv;
    const { pos, flags } = parseArgs(rest);
    const need = (n, what) => { if (!pos[n]) throw new Error(`usage: proof.mjs ${cmd} ${what}`); return pos[n]; };
    switch (cmd) {
        case 'serve': {
            const dir = need(0, '<dir> [--port 0]');
            const { port: old, token } = readPortFile(dir);
            if (await alive(old, token)) { console.log(`PORT=${old}`); return; }
            const { port } = await startServer(dir, Number(flags.port ?? 0));
            console.log(`PORT=${port}`);
            return 'stay';
        }
        case 'snippet': {
            const dir = need(0, '<dir> <name> [css-selector]'), name = need(1, '<dir> <name> [css-selector]');
            const { port, token } = readPortFile(dir);
            if (!await alive(port, token)) throw new Error(`no receiver running for ${dir}; run: proof.mjs serve ${dir}`);
            console.log(snippet(port, name, pos[2], token));
            return;
        }
        case 'block': {
            const b = upsertBlock(need(0, '<dir> --title "..." [...]'), flags);
            console.log(JSON.stringify(b));
            return;
        }
        case 'report': {
            const r = buildReport(need(0, '<dir> [--title ..] [--out file] [--inline]'), { title: flags.title, out: flags.out, inline: !!flags.inline });
            for (const w of r.warn) console.error(`warning: ${w}`);
            console.log(`${r.out} (${r.blocks} blocks, ${(r.bytes / 1024).toFixed(0)} KB${r.linked ? ', linked, not inline' : ''})`);
            return;
        }
        case 'stop': {
            console.log(await stopServer(need(0, '<dir>')) ? 'stopped' : 'nothing running');
            return;
        }
        default:
            console.error('usage: node proof.mjs serve|snippet|block|report|stop <dir> ... | --selftest');
            process.exit(2);
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).then(stay => { if (stay !== 'stay') process.exit(0); }, e => { console.error(e.stack?.includes('AssertionError') ? e.stack : `error: ${e.message}`); process.exit(1); });
}
