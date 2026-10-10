// lib.mts - what every fleet command shares: the readers, the run and its constants, claims, sessions.
// Part of fleet.mjs; see src/scripts/fleet.mts.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { homedir, uptime } from 'node:os';
export const RUN_FORMAT = 1;
// scripts/, where this module's parent fleet.mjs sits beside fleet.sh and fleet-load.mjs.
export const HERE = resolve(import.meta.dirname, '..');
// ---- small readers ---------------------------------------------------------------------------------------
// Synchronous writes: process.stdout is asynchronous on a POSIX pipe, and process.exit would cut it short.
// A reader that closed early (`| head -1`) silences the rest of the output and the command exits 141, as
// SIGPIPE ended the sh, but only once its work is done: stopping at a print left a handback half made (the
// new task filed, the old claim still open) and a lock held by a process that was gone.
let pipeGone = false;
export const pipeClosed = () => pipeGone;
function write(fd, s) {
    if (pipeGone)
        return;
    try {
        if (typeof s === 'string')
            writeSync(fd, s);
        else
            writeSync(fd, s);
    }
    catch (e) {
        if (e.code === 'EPIPE') {
            pipeGone = true;
            return;
        }
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
// Work in a tree that a commit has not saved, whatever the repository's config hides from a plain
// `git status`: untracked files under status.showUntrackedFiles=no, submodules, and files marked
// assume-unchanged (`ls-files -v` lowercase) or skip-worktree (`S`), whose edits git status never shows:
// such a file counts when its content is not the index's. A skip-worktree file missing from disk is a
// sparse checkout's, not work. Fail safe: a git that does not answer counts as work.
export function unsaved(dir) {
    const g = (a, input) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], maxBuffer: 1 << 28 });
    const s = g(['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']);
    if (s.status !== 0 || (s.stdout || '') !== '')
        return true;
    const l = g(['ls-files', '-v', '-s', '-z']);
    if (l.status !== 0)
        return true;
    const want = [], paths = [];
    for (const e of (l.stdout || '').split('\0')) {
        const m = /^([a-zS]) [0-7]+ ([0-9a-f]+) [0-9]+\t(.*)$/s.exec(e);
        if (!m)
            continue;
        if (!existsSync(`${dir}/${m[3]}`)) {
            if (m[1] === 'S' || m[1] === 's')
                continue;
            return true;
        }
        want.push(m[2] ?? '');
        paths.push(m[3] ?? '');
    }
    if (!paths.length)
        return false;
    const h = g(['hash-object', '--stdin-paths'], `${paths.join('\n')}\n`);
    return h.status !== 0 || (h.stdout || '').split('\n').slice(0, want.length).some((x, i) => x !== want[i]);
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
// mkdir as a lock, the same atomicity a claim has: true when taken. The holder writes its pid inside. A lock
// whose holder is dead (killed mid-command), or older than staleMs, was left behind and is taken over: a
// retry used to be told CLAIM LOST or BUSY for minutes over a lock nobody held. `who` names the holder: a
// lock with the same name is the caller's own (a finish retried by its chip), whatever its pid became since.
// Retried: on Windows a lock cannot be removed while another process reads its pid file, and a takeover
// that gave up there left six callers all refused (measured once in 945 self-test checks).
const LOCK_RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 20 };
export function takeLock(p, staleMs, who = '') {
    const mine = () => { try {
        writeFileSync(`${p}/pid`, `${process.pid}\n${who}\n`);
    }
    catch { /* the age still frees it */ } return true; };
    try {
        mkdirSync(p);
        return mine();
    }
    catch { /* held, or its parent is gone */ }
    if (!takeable(p, staleMs, who))
        return false;
    // Two takers of one dead lock both removed it and both made it again. Only the holder of `<lock>.take`
    // removes it, after reading it again.
    // ponytail: a taker killed inside these few lines leaves `.take` for 10 s; a pid in it if that is ever seen.
    const t = `${p}.take`, gone = LOCK_RM;
    try {
        mkdirSync(t);
    }
    catch {
        const tm = mtimeMs(t);
        if (Number.isNaN(tm) || Date.now() - tm < 10_000)
            return false;
        try {
            rmSync(t, gone);
            mkdirSync(t);
        }
        catch {
            return false;
        }
    }
    try {
        try {
            mkdirSync(p);
            return mine();
        }
        catch { /* still there */ }
        if (!takeable(p, staleMs, who))
            return false;
        rmSync(p, gone);
        mkdirSync(p);
        return mine();
    }
    catch {
        return false;
    }
    finally {
        try {
            rmSync(t, gone);
        }
        catch { /* gone */ }
    }
}
function takeable(p, staleMs, who) {
    const m = mtimeMs(p);
    if (Number.isNaN(m))
        return false;
    const [ps = '', w = ''] = read(`${p}/pid`).split('\n');
    const pid = Number(ps.trim());
    // Its own name, once past what a live holder takes (a finish holds it seconds): a killed holder whose pid
    // another process took since. Younger, the holder may be the same chip's finish still running.
    if (who && w === who && Date.now() - m >= 60_000)
        return true;
    return Date.now() - m >= staleMs || (pid > 0 && pid !== process.pid && !alive(pid));
}
export function dropLock(p) { try {
    rmSync(p, LOCK_RM);
}
catch { /* gone with its claim */ } }
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === 'EPERM';
    }
}
// The lock a claim is closed under: `finish` holds it from its owner check to its done marker, and whatever
// releases a claim (handback, sweep, recover) takes it before the rename. Without it a finish and a handback
// at the same moment both won: the task got its done marker and was filed again under a new id.
export const CLOSING_STALE_MS = 10 * 60 * 1000;
export const closing = (claimDir) => `${claimDir}/.closing`;
// The ready task a handback filed for claim <id>, or '': handback files the new task before it closes the
// old claim, so one killed in between leaves both. Only `handback` run again closes such a claim.
export function refiledAs(run, id) {
    const f = names(`${run}/tasks/ready`).find((n) => n.endsWith('.md') && lf(read(`${run}/tasks/ready/${n}`)).split('\n').includes(`handback-of: ${id}`));
    return f ? f.slice(0, -3) : '';
}
// For a releaser: take the claim's closing lock, then look for the done marker again, since a finish that
// held the lock while the releaser read the claims has written it by now. 'ok' leaves the lock held.
export function lockToRelease(run, id) {
    const d = `${run}/tasks/claimed/${id}`;
    if (!takeLock(closing(d), CLOSING_STALE_MS))
        return 'closing';
    if (existsSync(`${run}/tasks/done/${id}`)) {
        dropLock(closing(d));
        return 'done';
    }
    return 'ok';
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
    for (const line of lf(text).replace(/^﻿/, '').split('\n')) {
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
// A JSON value as text, never through its own toString: `{"toString":1}` made String() throw.
export function asText(v) {
    if (typeof v === 'string')
        return v;
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'number' || typeof v === 'boolean')
        return String(v);
    try {
        return JSON.stringify(v) ?? '';
    }
    catch {
        return '';
    }
}
// A task's frontmatter: the lines between a first `---` line and the next, a BOM before it ignored; null
// when the file has none.
export function frontmatter(text) {
    const ls = lf(text).replace(/^﻿/, '').split('\n');
    if (!/^---/.test(ls[0] ?? ''))
        return null;
    const fm = [];
    for (let i = 1; i < ls.length; i++) {
        const l = ls[i] ?? '';
        if (/^---/.test(l))
            break;
        fm.push(l);
    }
    return fm;
}
// A YAML value as a person writes it by hand: inside one pair of quotes as written (`"fix #1"` is fix),
// otherwise with a ` # comment` cut off. A value that starts with `#` is kept: `operator: #12 approve` is
// owed, and cutting it to nothing would hand the task out.
export function yamlValue(v) {
    const t = v.replace(/^[ \t]+/, '');
    const q = /^(["'])(.*?)\1([ \t]+#.*)?[ \t\r]*$/.exec(t);
    if (q)
        return q[2] ?? '';
    return t.replace(/[ \t]#.*$/, '').replace(/[ \t\r]+$/, '');
}
// Every value of a frontmatter key, read however a person spelled it: any case, blanks around the colon,
// quotes around the value. A task filed by hand as `Kind: fix` or `operator : approve` means what it says,
// and reading only the exact spelling let such a fix past the proof gate.
export function fmValues(fm, key) {
    const re = new RegExp(`^([ \\t]*)${key}[ \\t]*:[ \\t]*(.*?)[ \\t\\r]*$`, 'i');
    // Top-level lines first: an indented `operator: none` under some other key read first let a task past
    // the operator line below it.
    const ms = fm.flatMap((l) => { const m = re.exec(l); return m ? [m] : []; });
    return [...ms.filter((m) => !m[1]), ...ms.filter((m) => m[1])].map((m) => yamlValue(m[2] ?? ''));
}
// What a task's frontmatter says the operator still owes, or ''. Only the frontmatter: a body line
// beginning `operator:` is prose.
// Top-level lines only, any case: an indented `operator:` belongs to some other key (a `notes: |` block),
// and `cleared` removes exactly the lines read here.
export function operatorOwed(text) {
    const v = fmValues((frontmatter(text) ?? []).filter((l) => !/^[ \t]/.test(l)), 'operator')[0] ?? '';
    return /^(none|no|-|n.a|nothing|false|done)?$/.test(v.toLowerCase()) ? '' : v;
}
// The kind of a task, lowercased: `fix` and `root` need a proof before their done marker.
export function taskKind(text) {
    return ((fmValues(frontmatter(text) ?? lf(text).split('\n'), 'kind')[0] ?? '').split(/[ \t]+/)[0] ?? '').toLowerCase();
}
// The ids a task waits for: every `after:` line of its frontmatter (handback rewrites them all, so all of
// them count), commas or blanks between ids. A file with no frontmatter: its first `after:` line, as before.
export function afterIds(text) {
    const fm = frontmatter(text);
    if (!fm)
        return field(text, AFTER).split(/[ \t,\r]+/).filter(Boolean);
    // A YAML list under an empty `after:` (`  - base`), written by hand past `file`, holds the task too.
    const ids = [];
    let inList = false;
    for (const l of fm) {
        const k = /^[ \t]*([A-Za-z_-]+)[ \t]*:[ \t]*(.*?)[ \t\r]*$/.exec(l);
        if (k) {
            inList = (k[1] ?? '').toLowerCase() === 'after';
            if (inList)
                ids.push(...yamlValue(k[2] ?? '').split(/[ \t,\r]+/));
            continue;
        }
        const item = /^[ \t]*-[ \t]+(.*?)[ \t\r]*$/.exec(l);
        if (inList && item)
            ids.push(...yamlValue(item[1] ?? '').split(/[ \t,]+/));
    }
    return ids.filter(Boolean);
}
// A task file written whole or not at all: written in place, a kill between the truncate and the write
// left an empty task that `next` handed out with no `after:` and no body.
// The temporary name is a dotfile, which no listing of ready/ or done/ counts if a kill leaves it behind.
export function writeWhole(p, s) {
    const t = `${dirname(p)}/.${p.slice(dirname(p).length + 1)}.tmp-${process.pid}`;
    writeFileSync(t, s);
    renameSync(t, p);
}
// A task's budget in minutes, read where `file` checks it: the frontmatter (a file with none, its first
// `budget:` line). Outside 1-999999 it is the default 25: 0 fired the clock at once, and a number past the
// shell's integers never fired it.
export function budgetOf(text) {
    const fm = frontmatter(text);
    const v = /^[0-9]+/.exec((fm ? fmValues(fm, 'budget')[0] ?? '' : field(text, BUDGET)).trim())?.[0] ?? '';
    return /^0*[1-9][0-9]{0,5}$/.test(v) ? Number(v) : 25;
}
// The task's text with `id` swapped for `nw` wherever afterIds reads it, written back in the one spelling
// (`after: x y`, list items kept as items). Only the frontmatter: an `After:` line in the body is prose.
export function renameAfter(text, id, nw) {
    const ls = lf(text).replace(/^﻿/, '').split('\n');
    const swap0 = (v) => v.split(/[ \t,\r]+/).filter(Boolean).map((p) => (p === id ? nw : p)).join(' ');
    if (!/^(﻿)?---/.test(ls[0] ?? '')) {
        // No frontmatter: afterIds reads the first `after:` line, so that is the one renamed.
        const i = ls.findIndex((l) => AFTER.test(l));
        if (i >= 0)
            ls[i] = `after: ${swap0((ls[i] ?? '').replace(/^after:/, ''))}`;
        return ls.join('\n');
    }
    const swap = (v) => yamlValue(v).split(/[ \t,\r]+/).filter(Boolean).map((p) => (p === id ? nw : p)).join(' ');
    let inList = false;
    for (let i = 1; i < ls.length; i++) {
        const l = ls[i] ?? '';
        if (/^---/.test(l))
            break;
        const k = /^[ \t]*([A-Za-z_-]+)[ \t]*:[ \t]*(.*?)[ \t\r]*$/.exec(l);
        if (k) {
            inList = (k[1] ?? '').toLowerCase() === 'after';
            if (inList)
                ls[i] = `after:${swap(k[2] ?? '') ? ` ${swap(k[2] ?? '')}` : ''}`;
            continue;
        }
        const item = /^([ \t]*-[ \t]+)(.*?)[ \t\r]*$/.exec(l);
        if (inList && item)
            ls[i] = `${item[1]}${swap(item[2] ?? '')}`;
    }
    return ls.join('\n');
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
// The host's rule, which the hooks and retro/analyze use too: CLAUDE_CONFIG_DIR, else the OS home (USERPROFILE
// on Windows, never a $HOME Git Bash was given), so pause markers and the hooks reading them agree.
export const configDir = () => slashes(process.env.CLAUDE_CONFIG_DIR || `${homedir()}/.claude`).replace(/([^:/])\/+$/, '$1'); // `C:/` and `/` keep theirs
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
// ponytail: only the copy beside this script, which is where the plugin ships it; a fleet.sh copied away
// from its plugin refuses to run at all.
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
    // A number, not any run of digits and dots: `1.2.3` reached Number() as NaN, and every gate passed.
    return /^[0-9]+(\.[0-9]+)?$/.test(v) ? v : def;
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
    run = nativePath(run); // fleet.sh turns Git Bash's argument conversion off; a POSIX run path comes as typed
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
    // In the case on disk, as `pwd -W` gave it: the pause marker is named by a checksum of this path, so two
    // spellings of one run (c:/users vs C:/Users) must not make two markers.
    let abs = resolve(run);
    if (process.platform === 'win32') {
        try {
            abs = realpathSync.native(abs);
        }
        catch { /* keep the resolved one */ }
    }
    const c = { sh, run, absrun: slashes(abs), cal: readCalibration() };
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
// The pane walks one host claimed and has not served yet.
export function walksOf(c, chip) {
    return names(`${c.run}/pane/running`).filter((w) => !existsSync(`${c.run}/pane/results/${w}.json`) &&
        noCr(field(read(`${c.run}/pane/running/${w}/owner`), /^host ([^\n]*)$/)) === chip);
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
        if (!n.endsWith(".md") || !isFile(`${c.run}/tasks/ready/${n}`))
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
    // Written once, not on every call: its time is when the session took the chip, which chipTakenBy orders by.
    try {
        mkdirSync(`${c.run}/chips`, { recursive: true });
        if (firstLine(`${c.run}/chips/${sid}`).split('\r').join('') !== chip)
            writeFileSync(`${c.run}/chips/${sid}`, chip);
    }
    catch { /* `|| true` */ }
    try {
        mkdirSync(`${configDir()}/makarasty/fleet-sessions`, { recursive: true });
        writeFileSync(`${configDir()}/makarasty/fleet-sessions/${sid}`, `${c.absrun}\n`);
    }
    catch { /* the context hook's record is a courtesy */ }
}
// Another live session already registered as <chip>, or '': a chip offered twice and clicked twice ran two
// sessions as one chip, and both worked its task. Live means its record is in the config's sessions/.
export function chipTakenBy(c, chip) {
    const sid = process.env.CLAUDE_CODE_SESSION_ID || '';
    // The coordinator acts on its workers' chips; registerChip skips it for the same reason.
    if (!sid || firstLine(`${c.run}/coordinator`).split('\r').join('') === sid)
        return '';
    // Two sessions whose first calls overlapped both passed this and both registered, and then each refused
    // the other for good: once registered, only a session that took the chip earlier counts (ties by id).
    const reg = (s) => mtimeMs(`${c.run}/chips/${s}`);
    const mine = firstLine(`${c.run}/chips/${sid}`).split('\r').join('') === chip ? reg(sid) : NaN;
    const others = names(`${c.run}/chips`).filter((s) => s !== sid && !s.includes('.') && firstLine(`${c.run}/chips/${s}`).split('\r').join('') === chip)
        .filter((s) => Number.isNaN(mine) || reg(s) < mine || (reg(s) === mine && s < sid));
    if (!others.length)
        return '';
    // A record a killed session left behind names a pid that is gone: that chip is free to start again.
    const dir = `${configDir()}/sessions`;
    const recs = names(dir).filter((n) => n.endsWith('.json')).map((n) => read(`${dir}/${n}`));
    return others.find((s) => recs.some((t) => t.includes(`"sessionId":"${s}"`) && recordLive(t))) ?? '';
}
// A session record whose process is the one that wrote it. Its pid alone is not enough: after a crash or a
// reboot the record stays and the pid goes to some other process. Started before this boot is dead; on
// Windows the process's own start time is compared with the record's procStart (a FILETIME). Asked only
// when two sessions claim one chip, so the PowerShell call is rare. Unanswerable counts as live.
function recordLive(t) {
    const p = Number(/"pid"\s*:\s*(\d+)/.exec(t)?.[1]);
    if (!(p > 0))
        return true;
    if (!alive(p))
        return false;
    const started = Number(/"startedAt"\s*:\s*(\d+)/.exec(t)?.[1]);
    if (started > 0 && started < Date.now() - uptime() * 1000 - 60_000)
        return false;
    const ps = /"procStart"\s*:\s*"(\d+)"/.exec(t)?.[1];
    if (process.platform !== 'win32' || !ps)
        return true;
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${p} -ErrorAction SilentlyContinue).StartTime.ToFileTimeUtc()`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 });
    const real = (r.stdout || '').trim();
    if (r.status !== 0 || !/^\d+$/.test(real))
        return true;
    const d = BigInt(real) - BigInt(ps);
    return (d < 0n ? -d : d) < 20000000n; // two seconds, in 100 ns ticks
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
    // A served walk keeps its request file; its result is what says it was answered.
    for (const w of names(`${c.run}/pane/requests`)) {
        if (w.startsWith(`${chip}-`) && !existsSync(`${c.run}/pane/results/${w.replace(/\.md$/, '')}.json`))
            o += ` pane/requests/${w}`;
    }
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
        const rec = JSON.parse(readFileSync(`${configDir()}/plugins/installed_plugins.json`, 'utf8'));
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
    // A pane host in the middle of a walk is mid-work too.
    for (const w of names(`${c.run}/pane/running`)) {
        if (existsSync(`${c.run}/pane/results/${w}.json`))
            continue;
        const o = noCr(field(read(`${c.run}/pane/running/${w}/owner`), /^host ([^\n]*)$/));
        if (o && !chipFinished(c, o))
            h.add(o);
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
