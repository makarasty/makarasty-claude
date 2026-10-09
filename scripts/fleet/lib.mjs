// lib.mts - what every fleet command shares: the readers, the run and its constants, claims, sessions.
// Part of fleet.mjs; see src/scripts/fleet.mts.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
export const RUN_FORMAT = 1;
// scripts/, where this module's parent fleet.mjs sits beside fleet.sh and fleet-load.mjs.
export const HERE = resolve(import.meta.dirname, '..');
// ---- small readers ---------------------------------------------------------------------------------------
// Synchronous writes: process.stdout is asynchronous on a POSIX pipe, and process.exit would cut it short.
// A reader that closed early (`| head -1`) ends the writer quietly, as SIGPIPE ended the sh: 141.
function write(fd, s) {
    try {
        if (typeof s === 'string')
            writeSync(fd, s);
        else
            writeSync(fd, s);
    }
    catch (e) {
        if (e.code === 'EPIPE')
            process.exit(141);
        throw e;
    }
}
export const out = (s) => { write(1, s); };
export const err = (s) => { write(2, s); };
export function isDir(p) { try {
    return statSync(p).isDirectory();
}
catch {
    return false;
} }
export function isFile(p) { try {
    return statSync(p).isFile();
}
catch {
    return false;
} }
export function read(p) { try {
    return readFileSync(p, 'utf8');
}
catch {
    return '';
} }
// What `head -1 <file>` prints, without its newline.
// Git Bash, the shell fleet.sh runs under, differs from node in two ways every reader here meets: its sed,
// grep and awk read a CRLF line as if it ended at the LF (a lone CR stays), and `$(...)` cuts trailing
// CRLF pairs as well as newlines.
export const lf = (s) => s.split('\r\n').join('\n');
export const sub = (s) => s.replace(/(\r?\n)+$/, '');
// Git Bash converts a path argument (/c/x, /tmp/x) for a native program, but a path read from a file
// reaches node unconverted: ask cygpath, as the shell would have. Use it where such a path goes to git or
// the filesystem; print the path as the file spells it, as the shell did.
export function nativePath(p) {
    if (process.platform !== 'win32' || !p.startsWith('/'))
        return p;
    const r = spawnSync('cygpath', ['-m', p], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 && r.stdout ? r.stdout.replace(/\n+$/, '') : p;
}
// `cksum`'s number: the POSIX CRC-32 (MSB first, the length folded in, complemented).
export function cksum(s) {
    const b = new TextEncoder().encode(s);
    let crc = 0;
    const step = (byte) => {
        crc ^= byte << 24;
        for (let i = 0; i < 8; i++)
            crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    };
    for (const x of b)
        step(x);
    for (let n = b.length; n > 0; n = Math.floor(n / 256))
        step(n & 0xff);
    return (~crc) >>> 0;
}
// The reverse, for a path the shell would have printed in its own spelling (C:\Users\x -> /c/Users/x).
export function shellPath(p) {
    const r = spawnSync('cygpath', ['-u', p], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 && r.stdout ? r.stdout.replace(/\n+$/, '') : p;
}
// `$(head -1 <file>)`
export function firstLine(p) { const t = read(p), i = t.indexOf('\n'); return sub(i < 0 ? t : t.slice(0, i + 1)); }
// A shell glob `<dir>/*` (or `<dir>/*/` with suffix '/'): names not starting with a dot, sorted as LC_ALL=C
// sorts the matched strings - with the suffix, so `t-a-r2/` comes before `t-a/` ('-' < '/').
export function names(dir, suffix = '') {
    try {
        return readdirSync(dir).filter((n) => !n.startsWith('.'))
            .sort((a, b) => { const x = a + suffix, y = b + suffix; return x < y ? -1 : x > y ? 1 : 0; });
    }
    catch {
        return [];
    }
}
// `sed -n 's/<re>/\1/p' file | head -1`: the first group of the first line that matches, or ''.
// [[:space:]] is spelled [ \t\v\f\r]: JS \s also matches spaces sed does not.
export function field(text, re) {
    for (const line of lf(text).split('\n')) {
        const m = re.exec(line);
        if (m)
            return m[1] ?? '';
    }
    return '';
}
export const NEEDS = /^needs:[ \t\v\f\r]*([a-z]+)/;
// `[^\n]*`, not `.*`: a JS `.` stops at \r, so `(.*)$` never matches a CRLF line, where sed's `.*` takes it.
export const AFTER = /^after:[ \t\v\f\r]*([^\n]*)$/;
export const BUDGET = /^budget:[ \t\v\f\r]*([0-9]+)/;
export const HANDBACK_OF = /^handback-of:[ \t\v\f\r]*([^\n]*)$/;
// What a task's frontmatter says the operator still owes, or ''. Only the frontmatter: a body line
// beginning `operator:` is prose.
export function operatorOwed(text) {
    const lines = lf(text).split('\n');
    if (!/^---/.test(lines[0] ?? ''))
        return '';
    for (let i = 1; i < lines.length; i++) {
        const l = lines[i] ?? '';
        if (/^---/.test(l))
            return '';
        if (/^operator:/.test(l)) {
            const v = l.replace(/^operator:[ \t]*/, '').replace(/[ \t\r]+$/, '');
            return /^(none|no|-|n.a|nothing|false|done)?$/.test(v.toLowerCase()) ? '' : v;
        }
    }
    return '';
}
// `date -Iseconds`: local time with its offset, 2026-10-08T21:30:00+03:00.
export function now() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const off = -d.getTimezoneOffset();
    const a = Math.abs(off);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
        `${off < 0 ? '-' : '+'}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}
export const slashes = (p) => p.split('\\').join('/');
export const configDir = () => slashes(process.env.CLAUDE_CONFIG_DIR || `${process.env.HOME || ''}/.claude`);
// `${N:?msg}` in sh: a missing argument ends the script with 1 and the shell's own message (which also names
// the line; this does not).
export function need(c, v, n, msg) {
    if (v)
        return v;
    err(`${c.sh}: ${n}: ${msg}\n`);
    process.exit(1);
}
// calibration.json beside the plugin, read the way fleet.sh's sed reads it: a bare key holding a bare
// number, anchored at both ends, so a provenance sentence never becomes a constant.
// ponytail: only the copy beside this script, which is where the plugin ships it; fleet.sh also asks the
// install record, for a fleet.sh copied away from its plugin.
export function readCalibration() {
    const m = new Map();
    const re = /^[ \t\v\f\r]*"([A-Za-z_][A-Za-z0-9_]*)"[ \t\v\f\r]*:[ \t\v\f\r]*([0-9][0-9.]*)[ \t\v\f\r]*,?[ \t\v\f\r]*$/;
    for (const line of read(`${HERE}/../calibration.json`).split('\n')) {
        const r = re.exec(line);
        if (r)
            m.set(r[1] ?? '', r[2] ?? '');
    }
    return m;
}
export function cal(c, key, def) {
    const v = c.cal.get(key) ?? '';
    return /^[0-9.]+$/.test(v) ? v : def;
}
// A whole number of at least 1, or the default with a warning: a decimal reaching arithmetic after the
// claim was made once left a claim standing whose task never printed.
export function calint(c, key, def) {
    const v = cal(c, key, String(def));
    if (/^[0-9]+$/.test(v) && Number(v) >= 1)
        return Number(v);
    err(`calibration: ${key} = ${v} is not a whole number of at least 1, using ${def}\n`);
    return def;
}
export function context(sh, run) {
    if (!isDir(run) && !/^(\/|[A-Za-z]:)/.test(run)) {
        // A worker stands in a worktree, where `.fleet/` is gitignored: look in the main checkout.
        const g = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
        const cm = g.status === 0 ? (g.stdout || '').trim() : '';
        if (cm && isDir(`${dirname(cm)}/${run}`))
            run = `${dirname(cm)}/${run}`;
    }
    if (!isDir(run)) {
        err(`no such run directory: ${run}\n`);
        process.exit(2);
    }
    const c = { sh, run, absrun: slashes(resolve(run)), cal: readCalibration() };
    const have = firstLine(`${run}/RUN_FORMAT`).replace(/[^0-9]/g, '');
    if (have && Number(have) > RUN_FORMAT) {
        err(`REFUSED: this run is format ${have} and this fleet.sh reads format ${RUN_FORMAT}\n`);
        err('  Update the plugin rather than reading it with the wrong shape.\n');
        process.exit(2);
    }
    return c;
}
export function pluginVersion() {
    return field(read(`${HERE}/../.claude-plugin/plugin.json`), /^[ \t\v\f\r]*"version"[ \t\v\f\r]*:[ \t\v\f\r]*"([^"]*)"/) || 'unknown';
}
// The memory census: FLEET_LOAD when it names a file (a test's census), else the one beside this script.
// Absolute, because the wait is backgrounded by a worker standing in a worktree.
export function loadScript() {
    const l = process.env.FLEET_LOAD || '';
    if (l && existsSync(l))
        return slashes(resolve(l));
    return existsSync(`${HERE}/fleet-load.mjs`) ? slashes(`${HERE}/fleet-load.mjs`) : '';
}
// ---- the queue -------------------------------------------------------------------------------------------
export const live = (id) => !id.includes('.dead-') && !id.includes('.released-');
// The open claims of one chip.
export function claimsOf(c, chip) {
    return names(`${c.run}/tasks/claimed`, '/').filter((i) => live(i) && isDir(`${c.run}/tasks/claimed/${i}`) && !existsSync(`${c.run}/tasks/done/${i}`) &&
        lf(read(`${c.run}/tasks/claimed/${i}/owner`)).split('\n').includes(`chip ${chip}`));
}
// The verify task somebody is holding, if any. The lane is one worker wide across the fleet.
export function verifyHeld(c) {
    for (const i of names(`${c.run}/tasks/claimed`, '/')) {
        if (!live(i) || !isDir(`${c.run}/tasks/claimed/${i}`) || existsSync(`${c.run}/tasks/done/${i}`))
            continue;
        if (field(read(`${c.run}/tasks/ready/${i}.md`), NEEDS) === 'verify')
            return i;
    }
    return '';
}
// Lanes the queue holds open work for and no chip was offered for, one line each.
export function laneGaps(c) {
    const need = [];
    for (const n of names(`${c.run}/tasks/ready`)) {
        if (!n.endsWith('.md'))
            continue;
        const id = n.slice(0, -3);
        if (existsSync(`${c.run}/tasks/done/${id}`) || isDir(`${c.run}/tasks/claimed/${id}`))
            continue;
        need.push(field(read(`${c.run}/tasks/ready/${n}`), NEEDS) || 'repo');
    }
    if (!need.length)
        return [];
    // A chip whose worker finished is not a worker any more.
    let have = ' ';
    for (const nn of names(`${c.run}/offered`)) {
        if (['done', 'blocked', 'retired'].some((m) => existsSync(`${c.run}/${nn}.${m}`)))
            continue;
        have += `${read(`${c.run}/offered/${nn}`).split('\n').join(' ')} `;
    }
    const lines = [];
    for (const l of [...new Set(need)].sort()) {
        const n = need.filter((x) => x === l).length;
        if (l === 'pane' || l === 'repo') {
            if (!have.includes(` ${l} `))
                lines.push(`  lane ${l}: ${n} task(s) ready, no chip offered (fleet.sh chips <run> <NN>-<NN> ${l})`);
        }
        else if (l === 'verify') {
            if (!have.includes(' repo ') && !have.includes(' verify '))
                lines.push(`  lane verify: ${n} task(s) ready, no repo or verify chip offered`);
        }
        else {
            lines.push(`  needs: ${l} on ${n} task(s) is not a lane, so no worker will ever claim them: change it to pane, repo or verify`);
        }
    }
    return lines;
}
// ---- sessions --------------------------------------------------------------------------------------------
// Who this session is, so the hooks can tell a worker from any other chat. Never the coordinator.
export function registerChip(c, chip) {
    const sid = process.env.CLAUDE_CODE_SESSION_ID || '';
    if (!sid)
        return;
    if (firstLine(`${c.run}/coordinator`).split('\r').join('') === sid)
        return;
    try {
        mkdirSync(`${c.run}/chips`, { recursive: true });
        writeFileSync(`${c.run}/chips/${sid}`, chip);
    }
    catch { /* `|| true` */ }
    try {
        mkdirSync(`${configDir()}/makarasty/fleet-sessions`, { recursive: true });
        writeFileSync(`${configDir()}/makarasty/fleet-sessions/${sid}`, `${c.absrun}\n`);
    }
    catch { /* the context hook's record is a courtesy */ }
}
// ` || [ ! -e <session record> ]`: a loop a worker backgrounds stops once its chat has ended.
export function chatGone() {
    const sid = process.env.CLAUDE_CODE_SESSION_ID || '';
    if (!sid)
        return '';
    const dir = `${configDir()}/sessions`;
    const f = names(dir).find((n) => n.endsWith('.json') && read(`${dir}/${n}`).includes(`"sessionId":"${sid}"`));
    return f ? ` || [ ! -e "${dir}/${f}" ]` : '';
}
export function wakeLoop(c, chip) {
    const ps = calint(c, 'clock_poll_seconds', 30);
    const r = c.absrun;
    return `  until [ ! -e "${r}/PAUSED" ] || [ -e "${r}/${chip}.retired" ] || [ -e "${r}/FINISHED" ]${chatGone()}; do sleep ${ps}; done; ` +
        `if [ -e "${r}/${chip}.retired" ]; then echo retired; elif [ -e "${r}/FINISHED" ]; then echo run-finished; ` +
        `elif [ -e "${r}/PAUSED" ]; then echo chat-gone; else echo resumed; fi\n`;
}
// Questions and pane walks a chip filed that nobody has answered.
export function openAsks(c, chip) {
    let o = '';
    for (const b of names(`${c.run}/ask`)) {
        if (b.startsWith(`${chip}-`) && b.endsWith('.md') && !existsSync(`${c.run}/answers/${b}`))
            o += ` ask/${b}`;
    }
    for (const w of names(`${c.run}/pane/requests`))
        if (w.startsWith(`${chip}-`))
            o += ` pane/requests/${w}`;
    return o;
}
// `| sed 's/^/  /'`: every line indented, an unterminated last line included.
export function indent(text) {
    if (!text)
        return '';
    const lines = text.split('\n');
    const closed = lines[lines.length - 1] === '';
    if (closed)
        lines.pop();
    return lines.map((l) => `  ${l}`).join('\n') + (closed ? '\n' : '');
}
// ---- workers and their sessions --------------------------------------------------------------------------
// `$(cat <file>)`: the content with its trailing newlines cut, or the fallback when it cannot be read.
export function cat(p, fallback = '') {
    try {
        return sub(readFileSync(p, 'utf8'));
    }
    catch {
        return fallback;
    }
}
export const noCr = (s) => s.split('\r').join('');
export function mtimeMs(p) { try {
    return statSync(p).mtimeMs;
}
catch {
    return NaN;
} }
// `[ a -nt b ]`: a exists and is newer, or b does not exist.
export function newer(a, b) {
    const x = mtimeMs(a), y = mtimeMs(b);
    return !Number.isNaN(x) && (Number.isNaN(y) || x > y);
}
// `[ -n "$(find <p> -mmin +<n>)" ]`
export function olderThanMin(p, n) {
    const m = mtimeMs(p);
    return !Number.isNaN(m) && Date.now() - m > n * 60000;
}
export const chipFinished = (c, chip) => ['done', 'blocked', 'retired'].some((m) => existsSync(`${c.run}/${chip}.${m}`));
// `grep -lx <chip> <run>/chips/*`: some session registered as this chip.
export function started(c, chip) {
    return names(`${c.run}/chips`).some((n) => isFile(`${c.run}/chips/${n}`) && lf(read(`${c.run}/chips/${n}`)).split('\n').includes(chip));
}
// The plugin version a worker recorded at its last claim: `sed -n 's/.* plugin \([^ ]*\)$/\1/p' | tr -d '\r'`.
export function recordedVersion(c, chip) {
    const v = [];
    for (const l of read(`${c.run}/chips/${chip}.model`).split('\n')) {
        const m = /^.* plugin ([^ ]*)$/.exec(l);
        if (m)
            v.push(m[1] ?? '');
    }
    return noCr(v.join('\n')).replace(/\n+$/, '');
}
export const versionReadable = (v) => /^[0-9.]+$/.test(v);
// true when a sorts before b as a version, numerically field by field (1.5.9 < 1.5.10).
export function versionOlder(a, b) {
    if (a === b)
        return false;
    const x = a ? a.split('.') : [], y = b ? b.split('.') : [];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const p = Number(x[i]) || 0, q = Number(y[i]) || 0;
        if (p !== q)
            return p < q;
    }
    return false;
}
// The version the host has installed, which is what a chat started after a restart runs.
export function installedVersion() {
    try {
        const rec = JSON.parse(readFileSync(`${homedir()}/.claude/plugins/installed_plugins.json`, 'utf8'));
        const p = rec.plugins['makarasty@makarasty']?.[0]?.installPath ?? '';
        return String(JSON.parse(readFileSync(`${p}/.claude-plugin/plugin.json`, 'utf8')).version) || pluginVersion();
    }
    catch {
        return pluginVersion();
    }
}
// Chips with something in hand, sorted: an open claim, or a registered brief worker that has not finished.
export function claimHolders(c) {
    const h = new Set();
    for (const i of names(`${c.run}/tasks/claimed`, '/')) {
        if (!live(i) || !isDir(`${c.run}/tasks/claimed/${i}`) || existsSync(`${c.run}/tasks/done/${i}`))
            continue;
        const o = noCr(field(read(`${c.run}/tasks/claimed/${i}/owner`), /^chip ([^\n]*)$/));
        if (o)
            h.add(o);
    }
    for (const n of names(`${c.run}/chips`)) {
        if (n.includes('.') || !isFile(`${c.run}/chips/${n}`))
            continue;
        const chip = noCr(firstLine(`${c.run}/chips/${n}`));
        if (chip && existsSync(`${c.run}/brief-${chip}.md`) && !chipFinished(c, chip))
            h.add(chip);
    }
    return [...h].sort();
}
// Each worker chip with the newest session that registered as it: a reopened chip has two, and the old
// one's transcript stops growing.
export function workerSessions(c) {
    const dir = `${c.run}/chips`;
    const files = names(dir).map((n) => [n, mtimeMs(`${dir}/${n}`)])
        .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
    const seen = new Set();
    const ws = [];
    for (const [n] of files) {
        if (n.includes('.') || !isFile(`${dir}/${n}`))
            continue;
        const chip = noCr(firstLine(`${dir}/${n}`));
        if (!chip || seen.has(chip))
            continue;
        seen.add(chip);
        ws.push([chip, n]);
    }
    return ws;
}
// A session's context in thousands of tokens, read from the tail of its transcript, or ''.
export function sessionCtx(sid) {
    if (!sid)
        return '';
    const base = `${configDir()}/projects`;
    const d = names(base).find((p) => existsSync(`${base}/${p}/${sid}.jsonl`));
    if (d === undefined)
        return '';
    try {
        // Only the tail: a long session's transcript runs to tens of megabytes.
        const fd = openSync(`${base}/${d}/${sid}.jsonl`, 'r');
        const size = fstatSync(fd).size, len = Math.min(size, 4 * 1024 * 1024);
        const b = new Uint8Array(len);
        readSync(fd, b, 0, len, size - len);
        closeSync(fd);
        const lines = new TextDecoder().decode(b).split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            const l = lines[i] ?? '';
            if (!l.includes('"usage"') && !l.includes('compact_boundary'))
                continue;
            let o;
            try {
                o = JSON.parse(l);
            }
            catch {
                continue;
            }
            if (o.subtype === 'compact_boundary')
                return String(Math.round((o.compactMetadata?.postTokens || 0) / 1000));
            if (o.type !== 'assistant' || o.isSidechain)
                continue;
            const u = o.message?.usage || {};
            const n = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
            if (n)
                return String(Math.round(n / 1000));
        }
    }
    catch { /* no reading is an empty one */ }
    return '';
}
export const coordinatorSid = (c) => noCr(firstLine(`${c.run}/coordinator`));
export const coordCtx = (c) => existsSync(`${c.run}/coordinator`) ? sessionCtx(coordinatorSid(c)) : '';
// `[ "$a" -gt "$b" ]` on a file's content: an unreadable number makes the test false, as it does in sh.
export const gt = (a, b) => /^\s*-?[0-9]+\s*$/.test(b) && a > Number(b);
export const STOP_WHAT_YOU_STARTED = 'First stop what you started: TaskStop your background shells, Monitors and servers, preview_stop your preview servers, tabs_close every tab, the last one too: this chat is not reused.';
