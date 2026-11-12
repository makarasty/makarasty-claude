#!/usr/bin/env node
// residents.mjs - long-running dev processes (tsc --watch, tsc --lsp, vite and other dev servers, headless browsers of
// automation, heavy.mjs wrappers) and whose they are. READ ONLY: it lists and judges, it never ends anything. Ending
// one is the operator's yes, then `taskkill /PID <n> /F` leaves first (cleanup SKILL.md step 4).
//
//   node residents.mjs [--all] [--json] [--idle <min>] [--sample <sec>]    list CANDIDATE and ASK (--all adds KEEP)
//   node residents.mjs --selftest
//
// The census in fleet-load.mjs --leftovers lists only orphans (parent gone). The desktop app keeps a finished chat's
// processes alive, so a watcher with a LIVE parent is the usual leak, and nothing named its owner. Here: the owner
// is found by the parent chain up to a `claude` chat pid (sessions/<pid>.json, state from ../lib/live.mjs) or to a
// terminal/IDE (the operator's). A process is a CANDIDATE only when all of these hold: it is old enough, its chat
// ended (or idle at least IDLE_MIN), its whole tree used no CPU in the sample window, and nothing is connected to
// its port. A terminal's or an unknown owner is ASK; a live chat, CPU use, a connection or a live chat in the same
// repo is KEEP. The thresholds are a decision, not a fit: [M69] has the first real numbers.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { chats } from '../lib/live.mjs';

const MB = 1 << 20, EPOCH = 11644473600000;
export const LIMITS = {
    idleMin: Number(process.env.MAKARASTY_RESIDENT_IDLE_MIN || 120), // same 120 min as machine.mjs "ask the owner to close it if it is done"
    ageMin: 10,        // SKILL.md: nothing under ten minutes is a leftover
    cpuMs: 50,         // tree CPU over the sample window; an idle watcher and a Node heap tick sit far below it [M69]
    sampleSec: 3,
    minMb: 20,         // as machine.mjs: a 0-14 MB leftover (a Brave storage stub, a 13 MB node) is noise next to what it costs to read
};

// ---- classes: what counts as a resident. First match wins; browsers and wrappers are matched by name and flags. ----
const PROG = (n) => new RegExp(`(^|[\\\\/\\s"'])(${n})(\\.exe|\\.js|\\.mjs|\\.cmd)?(?=["'\\s]|$)`, 'i');
const TSC = PROG('tsc|tsgo|vue-tsc'), VITE = PROG('vite');
const WATCH = /(^|\s)(--watch|-w)(\s|$)/;
const DEVCMD = /nodemon|tsx\s+watch|webpack-dev-server|\b(next|astro|nuxt|remix)\s+dev\b|react-scripts\s+start|\b(npm|pnpm|yarn|bun)(\.cmd)?\b.*\brun\s+(dev|start|serve|preview|watch)\b|dev-server|node(\.exe)?["']?\s+--watch\b/i;
const BROWSER = /^(brave|chrome|chromium|msedge|headless_shell)(\.exe)?$/i, AUTOMATION = /playwright|puppeteer_dev_chrome_profile|--headless|--remote-debugging-pipe/i;

export function classOf(p, listens = false) {
    const cmd = p.cmd ?? '', name = p.name ?? '';
    if (BROWSER.test(name)) return AUTOMATION.test(cmd) ? 'automation browser' : null; // the operator's own Brave is never listed
    if (/[\\/]heavy\.mjs/i.test(cmd)) return 'heavy.mjs wrapper'; // names the test run it wraps, so before the one-shot test below
    if (/vitest|jest/i.test(cmd) && !WATCH.test(cmd)) return null; // a one-shot run is the census's
    if (TSC.test(cmd) && /(^|\s)--lsp(\s|$)/.test(cmd)) return 'tsc --lsp';
    if (TSC.test(cmd) && WATCH.test(cmd)) return 'tsc --watch';
    if (VITE.test(cmd) || DEVCMD.test(cmd)) return 'dev server';
    if (listens && /^(node|bun)(\.exe)?$/i.test(name)) return 'dev server';
    return null;
}

// ---- owners ---------------------------------------------------------------------------------------------------
const TERMINAL = /^(cmd|powershell|pwsh|bash|sh|zsh|windowsterminal|openconsole|wt|code|cursor|explorer|conhost|mintty|alacritty|wezterm)(\.exe)?$/i;
const CHATSHELL = /[\\/]\.claude[\\/]shell-snapshots[\\/]snapshot-|[\\/]Temp[\\/]claude[\\/][^\\/]+[\\/][0-9a-f]{8}-[0-9a-f-]{27}[\\/]/i;

// The nearest ancestor that is a chat's claude process, else a terminal/IDE, else unknown. A parent counts only if it
// was created before its child (pids are reused), the same test the census makes. A session id in a command line is a chat's too.
export function ownerOf(p, byPid, chatByPid, chatList) {
    let q = p;
    for (let i = 0; i < 40; i++) {
        const par = byPid.get(q.ppid);
        if (!par || par === q || (par.created && q.created && par.created > q.created)) break;
        const c = chatByPid.get(par.pid);
        if (c) return { kind: 'chat', chat: c };
        q = par;
    }
    const byId = chatList.find(c => c.id && (p.cmd ?? '').includes(c.id));
    if (byId) return { kind: 'chat', chat: byId };
    for (let a = byPid.get(p.ppid), i = 0; a && i < 40; i++) {
        if (TERMINAL.test(a.name ?? '')) return { kind: 'terminal', name: a.name, pid: a.pid };
        const next = byPid.get(a.ppid);
        if (!next || (next.created && a.created && next.created > a.created)) break;
        a = next;
    }
    return { kind: 'unknown' };
}

// ---- the pure part: a snapshot in, rows out ---------------------------------------------------------------------
// snap: { procs: [{pid, ppid, name, cmd, created (ms), cpu (100 ns), priv, ws}], tcp: [{pid, state, lp}] }
// later: Map pid -> cpu (100 ns) from the second sample. chatList: live.mjs chats().
export function analyse(snap, later, chatList, now = Date.now(), lim = LIMITS) {
    const procs = snap.procs, byPid = new Map(procs.map(p => [p.pid, p]));
    const chatByPid = new Map(chatList.filter(c => c.state !== 'dead' && c.pid).map(c => [c.pid, c]));
    const listen = new Map(), est = new Map(); // pid -> ports ; local port -> established count
    for (const t of snap.tcp) {
        if (t.state === 'Listen') listen.set(t.pid, [...(listen.get(t.pid) ?? []), t.lp]);
        else if (t.state === 'Established') est.set(`${t.pid}:${t.lp}`, (est.get(`${t.pid}:${t.lp}`) ?? 0) + 1);
    }
    const kids = new Map();
    for (const p of procs) if (p.ppid !== p.pid) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
    const tree = (p, seen = new Set()) => {
        if (seen.has(p.pid)) return [];
        seen.add(p.pid);
        return [p, ...(kids.get(p.pid) ?? []).filter(k => !k.created || !p.created || k.created >= p.created).flatMap(k => tree(k, seen))];
    };
    const kindOf = new Map(procs.map(p => [p.pid, classOf(p, listen.has(p.pid))]));
    const rows = [];
    for (const p of procs) {
        const kind = kindOf.get(p.pid);
        if (!kind) continue;
        const par = byPid.get(p.ppid);
        if (par && kindOf.get(par.pid) === kind && !(par.created && p.created && par.created > p.created)) continue; // not the root of its kind
        const all = tree(p), pids = new Set(all.map(x => x.pid));
        const ports = [...new Set(all.flatMap(x => listen.get(x.pid) ?? []))];
        const conns = all.reduce((s, x) => s + (listen.get(x.pid) ?? []).reduce((n, lp) => n + (est.get(`${x.pid}:${lp}`) ?? 0), 0), 0);
        const cpuMs = all.reduce((s, x) => s + Math.max(0, ((later.get(x.pid) ?? x.cpu) - x.cpu) / 1e4), 0); // a pid gone in the window adds nothing
        const owner = ownerOf(p, byPid, chatByPid, chatList);
        const ageMin = p.created ? (now - p.created) / 60000 : null;
        const row = { pid: p.pid, kind, mb: Math.round(all.reduce((s, x) => s + (x.priv ?? x.ws ?? 0), 0) / MB), commitMb: Math.round(all.reduce((s, x) => s + (x.commit ?? 0), 0) / MB),
            has: [...new Set(all.map(x => kindOf.get(x.pid)).filter(k => k && k !== kind))], ageMin: ageMin == null ? null : Math.round(ageMin),
            ports, conns, cpuMs: Math.round(cpuMs), owner: owner.kind === 'chat' ? { kind: 'chat', id: owner.chat.id, title: owner.chat.title, state: owner.chat.state, idleMin: owner.chat.idleMin == null ? null : Math.round(owner.chat.idleMin), root: owner.chat.root } : owner,
            cmd: (p.cmd ?? p.name ?? '').slice(0, 140), pids: all.map(x => x.pid).reverse() /* leaves first */, verdict: 'KEEP', why: [] };
        const w = row.why;
        if (ageMin != null && ageMin < lim.ageMin) w.push(`started ${Math.round(ageMin)} min ago, under ${lim.ageMin}`);
        if (row.cpuMs > lim.cpuMs) w.push(`working: ${row.cpuMs} ms of CPU in the ${lim.sampleSec} s sample`);
        if (conns) w.push(`${conns} connection(s) on its port ${ports.join(',')}: somebody is using it`);
        const o = row.owner;
        if (o.kind === 'chat') {
            const done = o.state === 'ended' || (o.state === 'idle' && o.idleMin >= lim.idleMin);
            if (!done) w.push(o.state === 'idle' ? `owner chat idle ${o.idleMin} min, under ${lim.idleMin}` : 'owner chat is live');
            else { // another chat working in the same repo may use it
                const mate = chatList.find(c => c.id !== o.id && c.root && c.root === o.root && (c.state === 'live' || (c.state === 'idle' && c.idleMin < lim.idleMin)));
                if (mate) { row.verdict = w.length ? 'KEEP' : 'ASK'; w.push(`chat ${mate.id.slice(0, 8)} works in the same repo`); }
                else if (!w.length) row.verdict = 'CANDIDATE';
                if (row.verdict === 'CANDIDATE') w.push(`owner chat ${o.state === 'ended' ? 'ended' : `idle ${o.idleMin} min`}; no CPU, ${ports.length ? `port ${ports.join(',')} has no connection` : 'no port'}`);
            }
        } else if (!w.length) {
            row.verdict = 'ASK';
            w.push(o.kind === 'terminal' ? `started from a terminal or IDE (${o.name} pid ${o.pid}): the operator's` : 'owner not found (parent gone or link broken)');
        }
        rows.push(row);
    }
    // a resident inside another resident's tree (a `bun run dev` that runs tsc --watch) is that row's, not a second one
    const inner = new Set(rows.filter(r => rows.some(o => o !== r && o.pids.includes(r.pid) && o.pids.length > r.pids.length)).map(r => r.pid));
    return rows.filter(r => !inner.has(r.pid)).sort((a, b) => ['CANDIDATE', 'ASK', 'KEEP'].indexOf(a.verdict) - ['CANDIDATE', 'ASK', 'KEEP'].indexOf(b.verdict) || b.mb - a.mb);
}

// ---- the machine ------------------------------------------------------------------------------------------------
const PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$pf = @{}; Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | % { $pf[[int]$_.IDProcess] = [long]$_.WorkingSetPrivate }
$p = Get-CimInstance Win32_Process | % { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name; cmd = $_.CommandLine; start = $(if ($_.CreationDate) { [string]$_.CreationDate.ToFileTimeUtc() } else { '' }); cpu = [long]($_.UserModeTime + $_.KernelModeTime); ws = [long]$_.WorkingSetSize; commit = [long]$_.PrivatePageCount; priv = $pf[[int]$_.ProcessId] } }
$t = Get-NetTCPConnection -ErrorAction SilentlyContinue | ? { $_.State -in 'Listen', 'Established' } | % { [pscustomobject]@{ pid = [int]$_.OwningProcess; state = [string]$_.State; lp = [int]$_.LocalPort } }
[pscustomobject]@{ procs = @($p); tcp = @($t) } | ConvertTo-Json -Depth 3 -Compress`;
const PS_CPU = String.raw`Get-CimInstance Win32_Process | % { "$($_.ProcessId) $([long]($_.UserModeTime + $_.KernelModeTime))" }`;
const ps = s => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(s, 'utf16le').toString('base64')], { encoding: 'utf8', maxBuffer: 256 << 20, timeout: 120e3 });
const list = x => [].concat(x ?? []).filter(Boolean);

export function snapshot() {
    if (process.platform !== 'win32') throw new Error('residents.mjs reads the Windows process table only in this version');
    const r = ps(PS);
    let j;
    try { j = JSON.parse(r.stdout); } catch { throw new Error(`the process list could not be read (powershell exit ${r.status}); nothing was judged`); }
    const procs = list(j.procs).map(p => ({ ...p, created: Number(p.start) > 0 ? Number(p.start) / 1e4 - EPOCH : 0 }));
    if (!procs.length) throw new Error('the process list came back empty; nothing was judged');
    return { procs, tcp: list(j.tcp) };
}

export function sample() {
    const m = new Map();
    for (const l of (ps(PS_CPU).stdout ?? '').split(/\r?\n/)) { const x = /^(\d+) (\d+)$/.exec(l.trim()); if (x) m.set(+x[1], +x[2]); }
    return m;
}

// The whole read: one snapshot, a pause, a second CPU sample, the chats' states. Nothing is ended.
export function scan(lim = LIMITS) {
    const snap = snapshot();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, lim.sampleSec * 1000);
    const later = sample();
    const chatList = chats({ procs: snap.procs.map(p => ({ pid: p.pid, start: p.start })) });
    return analyse(snap, later, chatList, Date.now(), lim);
}

export const line = r => {
    const o = r.owner, who = o.kind === 'chat' ? `chat ${o.id.slice(0, 8)}${o.title ? ` "${o.title}"` : ''} (${o.state}${o.idleMin != null ? `, idle ${o.idleMin} min` : ''})` : o.kind === 'terminal' ? `terminal ${o.name} ${o.pid}` : 'owner unknown';
    return [`${r.verdict.padEnd(9)} pid ${r.pid}  ${r.kind}  ${r.mb} MB (commit ${r.commitMb} MB)  ${r.ageMin ?? '?'} min  cpu ${r.cpuMs} ms  ${r.ports.length ? `port ${r.ports.join(',')} conns ${r.conns}` : 'no port'}  owner: ${who}`,
        `          ${r.cmd}${r.has.length ? `  [runs: ${r.has.join(', ')}]` : ''}`, `          ${r.why.join('; ')}`, ...(r.verdict === 'KEEP' ? [] : [`          pids leaves first: ${r.pids.join(' ')}`])].join('\n');
};

// ---- selftest ---------------------------------------------------------------------------------------------------
function selftest() {
    const now = 1e12, min = m => now - m * 60000;
    const P = (pid, ppid, name, cmd, age, priv = 10) => ({ pid, ppid, name, cmd, created: min(age), cpu: 1e7, priv: priv * MB });
    const procs = [
        P(1, 0, 'claude.exe', 'claude', 500), P(2, 0, 'claude.exe', 'claude', 500), P(3, 0, 'claude.exe', 'claude', 500), P(4, 0, 'claude.exe', 'claude', 500),
        P(10, 1, 'node.exe', 'node tsc.js --watch --noCheck', 90, 5), P(11, 10, 'tsc.exe', 'C:\\x\\@typescript\\typescript-win32-x64\\lib\\tsc.exe --watch --noCheck', 90, 2000), // ended chat's watcher
        P(12, 1, 'tsc.exe', 'C:\\x\\tsc.exe --lsp --stdio', 90, 70),                       // ended chat's lsp
        P(13, 2, 'node.exe', 'node C:\\r\\node_modules\\vite\\bin\\vite.js', 300, 500),      // chat 2 is live
        P(14, 3, 'node.exe', 'node C:\\r\\node_modules\\vite\\bin\\vite.js --port 5180', 300, 450), // idle 200 min, but a browser is connected
        P(15, 3, 'node.exe', 'node dev-server.cjs', 300, 220),                              // idle chat, no connection, shares repo with live chat 2? (root differs: see chats)
        P(16, 4, 'node.exe', 'node .review/tools/heavy.mjs "bunx vitest run"', 300, 15),                  // chat 4 idle 40 min: under the limit
        P(20, 0, 'cmd.exe', 'cmd', 600), P(21, 20, 'node.exe', 'node tsc.js --watch', 90, 5), P(22, 21, 'tsc.exe', 'tsc.exe --watch --noCheck', 90, 2000), // a terminal's
        P(23, 1, 'node.exe', 'node dev-server.cjs', 5, 100),                                // young
        P(24, 1, 'node.exe', 'node dev-server.cjs', 90, 100),                               // working (cpu moves)
        P(25, 999, 'node.exe', 'node vite.js', 90, 100),                                    // parent gone
        P(26, 1, 'node.exe', 'node vitest run', 90, 100),                                   // a one-shot run is not a resident
        P(27, 1, 'brave.exe', 'brave.exe --headless --user-data-dir=C:\\Temp\\playwright_chromiumdev_profile-x', 90, 100), P(28, 27, 'brave.exe', 'brave.exe --headless --type=renderer playwright_chromiumdev_profile-x', 90, 100),
        P(29, 1, 'brave.exe', 'brave.exe', 90, 900),                                         // the operator's own browser
        P(30, 3, 'node.exe', 'node other.js', 300, 100),                                     // listens, owner done: still a dev server
        P(31, 5, 'node.exe', 'node vite.js', 300, 100),                                      // under a chat whose root another live chat shares
    ];
    procs.push(P(5, 0, 'claude.exe', 'claude', 500));
    const chatList = [
        { id: 'aaaaaaaa-1', pid: 1, state: 'ended', idleMin: 300, root: 'C:\\r1', title: 'ended one' },
        { id: 'bbbbbbbb-2', pid: 2, state: 'live', idleMin: 2, root: 'C:\\r2', title: 'live one' },
        { id: 'cccccccc-3', pid: 3, state: 'idle', idleMin: 200, root: 'C:\\r3', title: 'idle old' },
        { id: 'dddddddd-4', pid: 4, state: 'idle', idleMin: 40, root: 'C:\\r4', title: 'idle recent' },
        { id: 'eeeeeeee-5', pid: 5, state: 'idle', idleMin: 200, root: 'C:\\r2', title: 'idle, repo shared with the live chat' },
    ];
    const tcp = [{ pid: 14, state: 'Listen', lp: 5180 }, { pid: 14, state: 'Established', lp: 5180 }, { pid: 15, state: 'Listen', lp: 5001 }, { pid: 30, state: 'Listen', lp: 7000 }, { pid: 15, state: 'Established', lp: 55555 }];
    const later = new Map(procs.map(p => [p.pid, p.cpu])); later.set(24, procs.find(p => p.pid === 24).cpu + 5e6); // 500 ms
    const rows = analyse({ procs, tcp }, later, chatList, now);
    const by = Object.fromEntries(rows.map(r => [r.pid, r]));
    const v = (pid) => by[pid]?.verdict;
    assert.equal(v(10), 'CANDIDATE', 'the wrapper of an ended chat\'s tsc --watch is the root, and its tree holds the native tsc');
    assert.equal(by[10].mb, 2005, 'the tree is summed: 5 + 2000 MB');
    assert.deepEqual(by[10].pids, [11, 10], 'leaves first');
    assert.equal(by[11], undefined, 'the native child is not a second row');
    assert.equal(v(12), 'CANDIDATE'); assert.equal(by[12].kind, 'tsc --lsp');
    assert.equal(v(13), 'KEEP'); assert.match(by[13].why[0], /live/);
    assert.equal(v(14), 'KEEP'); assert.match(by[14].why.join(), /connection/);
    assert.equal(v(15), 'CANDIDATE', 'a port with no connection on it (55555 is a client socket, not its port) and a done owner');
    assert.equal(v(16), 'KEEP'); assert.match(by[16].why[0], /idle 40 min/);
    assert.equal(v(21), 'ASK'); assert.match(by[21].why[0], /terminal/); assert.equal(by[21].kind, 'tsc --watch');
    assert.equal(v(23), 'KEEP'); assert.match(by[23].why[0], /started 5 min/);
    assert.equal(v(24), 'KEEP'); assert.match(by[24].why.join(), /working/);
    assert.equal(v(25), 'ASK', 'parent gone: unknown owner is asked, never a candidate');
    assert.equal(by[26], undefined, 'a one-shot vitest run is not listed');
    assert.equal(v(27), 'CANDIDATE'); assert.equal(by[27].kind, 'automation browser'); assert.equal(by[28], undefined, 'renderers are in the root\'s tree');
    assert.equal(by[29], undefined, 'the operator\'s own browser is never listed');
    assert.equal(v(30), 'CANDIDATE'); assert.equal(by[30].kind, 'dev server');
    assert.equal(v(31), 'ASK', 'another live chat works in the same repo');
    // a watcher inside a dev server's tree is that row's, not a second row counting the same memory
    const nest = analyse({ procs: [P(1, 0, 'claude.exe', 'claude', 500), P(50, 1, 'cmd.exe', 'cmd /k "bun run dev"', 90, 1), P(51, 50, 'tsc.exe', 'tsc.exe --watch', 90, 1000)], tcp: [] }, new Map(), chatList.slice(0, 1), now);
    assert.equal(nest.length, 1); assert.equal(nest[0].pid, 50); assert.deepEqual(nest[0].has, ['tsc --watch']); assert.equal(nest[0].mb, 1001);
    // pid reuse: a "parent" created after its child is no parent
    const reuse = analyse({ procs: [P(1, 0, 'claude.exe', 'claude', 10), P(40, 1, 'node.exe', 'node vite.js', 90)], tcp: [] }, new Map(), [{ id: 'f-1', pid: 1, state: 'ended', idleMin: 1, root: 'C:\\x' }], now);
    assert.equal(reuse[0].owner.kind, 'unknown', 'a chat pid created after the process is a reused pid');
    // a session id in the command line names the chat when the parent link broke (Git Bash)
    const viaId = analyse({ procs: [P(41, 999, 'node.exe', 'node C:\\Temp\\claude\\x\\f-1\\vite.js --watch', 90)], tcp: [] }, new Map(), [{ id: 'f-1', pid: 7, state: 'ended', idleMin: 1, root: 'C:\\x' }], now);
    assert.equal(viaId[0].owner.kind, 'chat');
    assert.equal(classOf({ name: 'node.exe', cmd: 'node vitest.js' }), null); assert.equal(classOf({ name: 'node.exe', cmd: 'node C:\\x\\vitest watch --watch' }) , null, 'vitest is the census\'s, even watching');
    console.log('residents.mjs selftest: ok');
}

// ---- main -------------------------------------------------------------------------------------------------------
const real = p => { try { return realpathSync.native(p).toLowerCase(); } catch { return resolve(p).toLowerCase(); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
    const a = process.argv.slice(2), flag = (n, d) => { const i = a.indexOf(n); return i < 0 ? d : Number(a[i + 1]); };
    try {
        if (a.includes('--selftest')) selftest();
        else {
            const lim = { ...LIMITS, idleMin: flag('--idle', LIMITS.idleMin), sampleSec: flag('--sample', LIMITS.sampleSec) };
            const rows = scan(lim), shown = a.includes('--all') ? rows : rows.filter(r => r.verdict !== 'KEEP' && r.mb >= lim.minMb);
            if (a.includes('--json')) console.log(JSON.stringify(shown, null, 1));
            else {
                const n = v => rows.filter(r => r.verdict === v);
                console.log(`${rows.length} residents: ${n('CANDIDATE').length} candidate (${n('CANDIDATE').reduce((s, r) => s + r.mb, 0)} MB), ${n('ASK').length} ask (${n('ASK').reduce((s, r) => s + r.mb, 0)} MB), ${n('KEEP').length} keep (${n('KEEP').reduce((s, r) => s + r.mb, 0)} MB); sample ${lim.sampleSec} s, chat idle limit ${lim.idleMin} min. Nothing was ended.`);
                for (const r of shown) console.log('\n' + line(r));
            }
        }
    } catch (e) { console.error(process.env.DEBUG_STACK ? e.stack : e.message); process.exitCode = 1; }
}
