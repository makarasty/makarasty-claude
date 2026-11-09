// Which Claude chats are live. Pid alone lies: the desktop app keeps a finished chat's claude.exe alive, and a pid can
// be reused. A chat is live when its pid runs with the recorded start time, it has not ended (the SessionEnd hook
// writes <cfg>/makarasty/ended/<sessionId>) and its last transcript EVENT is under MAKARASTY_LIVE_IDLE_MIN (30)
// minutes old. The event time is the `timestamp` of the last JSONL record, never the file mtime (a copy resets mtimes) [M55].
// Self-check: node live.mjs --selftest
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ls = d => { try { return readdirSync(d); } catch { return []; } };
const lst = p => { try { return statSync(p); } catch { return null; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function readTail(file, bytes, fromEnd) {
    let fd;
    try {
        fd = openSync(file, 'r');
        const size = fstatSync(fd).size;
        const len = Math.min(size, bytes), buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, fromEnd ? size - len : 0);
        return buf.toString('utf8');
    } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
}

// ms of the last record that carries a `timestamp`, or null.
export function lastEvent(file) {
    const lines = readTail(file, 65536, true).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const t = Date.parse(JSON.parse(lines[i]).timestamp);
            if (t > 0) return t;
        } catch { /* a cut first line or a record without a timestamp */ }
    }
    return null;
}

function titleOf(file) {
    // 256 KB: hooks, attachments and skill listings come before the first prompt
    for (const l of readTail(file, 262144, false).split('\n')) {
        try {
            const r = JSON.parse(l), c = r.message?.content;
            if (r.type !== 'user' || r.isMeta) continue;
            const s = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join(' ') : '';
            if (s.trim() && !s.trimStart().startsWith('<')) return s.replace(/\s+/g, ' ').trim().slice(0, 50);
        } catch { /* a cut last line */ }
    }
    return '';
}

export function chats({ procs, now = Date.now() } = {}) {
    const cfgs = [...new Set([process.env.CLAUDE_CONFIG_DIR, join(homedir(), '.claude')].filter(Boolean).map(d => resolve(d)))];
    const byPid = new Map((procs ?? []).map(p => [+p.pid, p]));
    const limit = Number(process.env.MAKARASTY_LIVE_IDLE_MIN || 30);
    const out = [];
    for (const cfg of cfgs) {
        const dir = join(cfg, 'sessions');
        let transcripts = null; // sessionId -> path, read once per config dir
        const transcript = id => {
            if (!transcripts) {
                transcripts = new Map();
                for (const p of ls(join(cfg, 'projects'))) for (const n of ls(join(cfg, 'projects', p))) if (n.endsWith('.jsonl')) transcripts.set(n.slice(0, -6), join(cfg, 'projects', p, n));
            }
            return transcripts.get(id);
        };
        for (const n of ls(dir)) {
            if (!n.endsWith('.json')) continue;
            const f = join(dir, n);
            let j = null;
            for (let i = 0; i < 3 && !j; i++) {
                try { j = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { if (e.code === 'ENOENT') break; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
            }
            if (!j) { // torn: a chat rewriting it holds everything; a file broken for 10 minutes is a crash's leftover
                const pid = parseInt(n, 10);
                if (pid > 0 && alive(pid) && now - (lst(f)?.mtimeMs ?? 0) < 600e3) out.push({ id: '', pid, cwd: '', root: '', state: 'live', idleMin: null, title: '', unknown: true });
                continue;
            }
            if (!j.pid) continue;
            const pid = +j.pid, p = byPid.get(pid), id = String(j.sessionId ?? '');
            let root = j.cwd ?? '';
            for (let d = root; d && dirname(d) !== d; d = dirname(d)) if (lst(join(d, '.git'))) { root = d; break; }
            // Start times are compared only when both parse to a positive number: a snapshot's '' (no CreationDate) is no time.
            const ps = Number(p?.start), js = Number(j.procStart);
            const run = ps > 0 && js > 0 ? Math.abs(ps - js) < 2e7 : alive(pid);
            const c = { id, pid, cwd: j.cwd ?? '', root, state: 'dead', idleMin: null, title: '' };
            out.push(c);
            if (!run) continue;
            const t = id ? transcript(id) : null;
            let e = null;
            if (t) { c.title = titleOf(t); e = lastEvent(t); if (e != null) c.idleMin = (now - e) / 60000; }
            // An ended marker older than the transcript's last event is stale: the chat was resumed under the same id.
            const mk = id ? join(cfg, 'makarasty', 'ended', id) : '';
            let ended = mk && existsSync(mk);
            if (ended && e != null) {
                let at = NaN;
                try { at = Date.parse(readFileSync(mk, 'utf8').trim()); } catch { /* not a file */ }
                if (!(at > 0)) at = lst(mk)?.mtimeMs ?? 0;
                if (at < e) ended = false;
            }
            c.state = ended ? 'ended' : c.idleMin != null && c.idleMin >= limit ? 'idle' : 'live';
        }
    }
    return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--selftest')) {
    const { default: assert } = await import('node:assert/strict');
    const cfg = mkdtempSync(join(tmpdir(), 'live-selftest-'));
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg; process.env.USERPROFILE = process.env.HOME = cfg; // hermetic: the home config is the same temp folder
    try {
        const now = Date.now(), iso = m => new Date(now - m * 60000).toISOString();
        mkdirSync(join(cfg, 'sessions'), { recursive: true });
        mkdirSync(join(cfg, 'projects', 'p'), { recursive: true });
        mkdirSync(join(cfg, 'makarasty', 'ended'), { recursive: true });
        const sess = (pid, sessionId, extra = {}) => writeFileSync(join(cfg, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: cfg, ...extra }));
        const tr = (id, recs) => writeFileSync(join(cfg, 'projects', 'p', `${id}.jsonl`), recs.map(r => JSON.stringify(r)).join('\n') + '\n');
        const user = (text, m) => ({ type: 'user', message: { content: text }, timestamp: iso(m) });
        const P = process.pid, DEAD = 2147483000;
        sess(P, 'live1'); tr('live1', [{ type: 'user', message: { content: '<ide>x' }, timestamp: iso(500) }, user('hello\nworld title', 400), { type: 'assistant', timestamp: iso(2) }, { type: 'summary' }]);
        sess(P + 1e6, 'idle1'); tr('idle1', [user('old', 300)]); // pid P+1e6 is not running: so give idle its own live pid below
        sess(DEAD, 'dead1'); tr('dead1', [user('x', 1)]);
        sess(P + 2e6, 'end1'); tr('end1', [user('x', 1)]);
        sess(P + 3e6, 'none1');
        writeFileSync(join(cfg, 'makarasty', 'ended', 'end1'), 'x');
        writeFileSync(join(cfg, 'sessions', `${P + 4e6}.json`), '{ torn');
        // a snapshot makes the fake pids "run" with a matching start; one entry disagrees on the start time
        const procs = [P + 1e6, P + 2e6, P + 3e6].map(pid => ({ pid, start: '1000' })).concat([{ pid: P, start: '5' }]);
        sess(P + 1e6, 'idle1', { procStart: '1000' }); sess(P + 2e6, 'end1', { procStart: '1000' }); sess(P + 3e6, 'none1', { procStart: '1000' });
        sess(P, 'live1', { procStart: '5' });
        sess(P + 5e6, 'reuse1', { procStart: '999999999' }); procs.push({ pid: P + 5e6, start: '1000' }); tr('reuse1', [user('x', 1)]);
        // mtime is ignored: a fresh file whose last timestamp is old is idle
        const by = Object.fromEntries(chats({ procs, now }).map(c => [c.id || `unknown${c.pid}`, c]));
        assert.equal(by.live1.state, 'live'); assert.ok(by.live1.idleMin >= 1.9 && by.live1.idleMin < 3);
        assert.equal(by.live1.title, 'hello world title');
        assert.equal(by.idle1.state, 'idle'); assert.ok(by.idle1.idleMin >= 299);
        assert.equal(by.dead1.state, 'dead');
        assert.equal(by.end1.state, 'ended');
        assert.equal(by.none1.state, 'live'); assert.equal(by.none1.idleMin, null);
        assert.equal(by.reuse1.state, 'dead');
        assert.equal(by[`unknown${P + 4e6}`], undefined); // torn file, pid not running: skipped
        // torn file of a running pid: unknown and live
        rmSync(join(cfg, 'sessions', `${P + 4e6}.json`)); writeFileSync(join(cfg, 'sessions', `${P}.json`), '{ torn');
        const u = chats({ now }).find(c => c.unknown);
        assert.ok(u && u.state === 'live' && u.id === '' && u.pid === P);
        // an old mtime on a file with a new timestamp stays live
        sess(P, 'live1'); const old = new Date(now - 9e8); utimesSync(join(cfg, 'projects', 'p', 'live1.jsonl'), old, old);
        assert.equal(chats({ now }).find(c => c.id === 'live1').state, 'live');
        assert.ok(Math.abs(lastEvent(join(cfg, 'projects', 'p', 'idle1.jsonl')) - (now - 300 * 60000)) < 1000);
        assert.equal(lastEvent(join(cfg, 'nothing.jsonl')), null);
        // a snapshot start of '' (no CreationDate) is no time: fall back to the pid, never read a running chat as dead
        sess(P, 'live1', { procStart: '5' });
        assert.equal(chats({ procs: [{ pid: P, start: '' }], now }).find(c => c.id === 'live1').state, 'live');
        assert.equal(chats({ procs: [{ pid: P, start: '999999999' }], now }).find(c => c.id === 'live1').state, 'dead', 'a real mismatch is still dead');
        // an ended marker older than the last transcript event is stale (resumed chat); a newer one stands. ISO content, else mtime
        const mk = join(cfg, 'makarasty', 'ended', 'live1'), st = () => chats({ now }).find(c => c.id === 'live1').state;
        sess(P, 'live1');
        writeFileSync(mk, iso(10)); assert.equal(st(), 'live', 'marker older than the last event');
        writeFileSync(mk, new Date(now + 60000).toISOString()); assert.equal(st(), 'ended', 'marker newer than the last event');
        writeFileSync(mk, 'x'); assert.equal(st(), 'ended', 'no time inside: mtime (now) is newer');
        const past = new Date(now - 60 * 60000); utimesSync(mk, past, past); assert.equal(st(), 'live', 'no time inside, old mtime');
        rmSync(mk);
        console.log('live.mjs selftest: ok');
    } finally {
        if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
        rmSync(cfg, { recursive: true, force: true });
    }
}
