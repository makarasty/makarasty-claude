#!/usr/bin/env node
// machine.mjs - the whole-machine scan behind /makarasty-tools:cleanup. A catalog of places where junk collects
// (rules.json beside this file, then ~/.claude/makarasty/cleanup-rules.json on top: a rule with the same id
// replaces the shipped one, {"id": ..., "off": true} switches it off) is measured read only; only the ids the person
// picked are acted on, after a fresh look.
//
//   node machine.mjs scan [--json] [--rules <file>]
//   node machine.mjs apply <id ...> [--json] [--rules <file>]   delete, recycle, vendor clean, or open an uninstaller
//   node machine.mjs admin <id ...> [--rules <file>]            writes a .bat for the person to run elevated; runs nothing
//   node machine.mjs --selftest
//
// --rules <file> is read in place of ~/.claude/makarasty/cleanup-rules.json (the shipped rules.json always loads).
//
// Safety, per path, at the moment of acting (the scan may be an hour old): a process running from the path or naming
// it in its command line holds it, and so do the rule's own apps; a live Claude session (pid alive and, where the
// process list has it, start time equal to the session's procStart, since pids get reused) holds its cwd and its
// scratch folder; the newest touch inside (modified or created, files and folders) must still be older than the
// rule's minAgeHours, and a date in the future counts as new. One apply runs at a time (a lock file). Links are never followed: sizes skip them, deletes unlink them. A drive root, the home folder
// or anything above it, and the known top folders themselves are refused. "recycle" goes to the Recycle Bin only when
// the item holds no link and fits the bin's free room, and is reported as recycled only when the bin grew by it.
// Every outcome is measured after the act and appended to ~/.claude/makarasty/cleanup-log.jsonl.
import { readdirSync, lstatSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync,
    rmdirSync, chmodSync, existsSync, renameSync, symlinkSync, utimesSync, statfsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, basename, resolve, sep, isAbsolute } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const WIN = process.platform === 'win32';
const HOUR = 3600e3, DAY = 24 * HOUR, MB = 1 << 20, GB = 1 << 30;
const HERE = dirname(fileURLToPath(import.meta.url));
const TIERS = ['safe', 'close-app', 'admin', 'owner'], METHODS = ['delete', 'vendor', 'recycle', 'uninstall', 'none'];
const state = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'makarasty');
const norm = p => { const r = resolve(p); return WIN ? r.toLowerCase() : r; };
const inside = (p, root) => { const a = norm(p), b = norm(root); return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep); };
const lst = p => { try { return lstatSync(p); } catch { return null; } };
const ls = d => { try { return readdirSync(d); } catch { return []; } };
const read = f => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const gb = b => b == null ? '? GB' : b >= GB / 10 ? `${(b / GB).toFixed(2)} GB` : `${Math.round(b / MB)} MB`; // 3 MB, not 0.00 GB
const ago = (t, now = Date.now()) => !t ? '-' : now - t < DAY ? `${Math.max(0, Math.round((now - t) / HOUR))}h` : `${Math.round((now - t) / DAY)}d`;
const day = t => new Date(t).toISOString().slice(0, 10);

// ---- paths ----------------------------------------------------------------------------------------------------

// The long form of the longest existing prefix of p. shortcut: realpath also resolves a junction on that prefix, so
// such a path comes back as its target; only 8.3 paths take this route, upgrade if one runs through a junction.
const longName = p => {
    for (let d = p; dirname(d) !== d; d = dirname(d)) {
        if (!lst(d)) continue;
        try { const r = realpathSync.native(d); return r.toLowerCase() === d.toLowerCase() ? p : r + p.slice(d.length); } catch { return p; }
    }
    return p;
};
const glob = s => new RegExp('^' + s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');

// %VAR%, a leading ~, and * inside one path segment. An unknown or empty %VAR% makes the pattern match nothing, so
// does a pattern that is not absolute. A * never enters a link: `Local\Application Data` is a junction back to Local.
export function expand(pattern) {
    const p = pattern.replace(/^~(?=[\\/]|$)/, homedir()).replace(/%([^%\\/]+)%/g, (m, k) => process.env[k] || m);
    if (/%[^%\\/]+%/.test(p) || !/^([A-Za-z]:[\\/]|\/)/.test(p)) return [];
    // An 8.3 name (C:\Users\JOHNSM~1, often in %TEMP%) would never match a process's long path: take the long form.
    const segs = (/~\d/.test(p) ? longName(p) : p).split(/[\\/]+/);
    let out = [segs[0] + sep];
    for (const s of segs.slice(1)) {
        if (!s) continue;
        if (!s.includes('*')) { out = out.map(b => join(b, s)); continue; }
        const re = glob(s);
        out = out.flatMap(b => ls(b).filter(n => re.test(n)).map(n => join(b, n)).filter(f => !lst(f)?.isSymbolicLink()));
    }
    return out.filter(lst);
}

// Size, newest touch and links of a path, without following links. "Newest" takes every file's and folder's
// modified and created time: an unzip or a copy keeps old modified dates but is created now, and an empty
// folder a tool just made has no file to date it. A rule over files a tool rewrites in place keeping their
// modified date (scrub does, on transcripts and handoffs) sets ageBy: "modified".
export function measure(p, now = Date.now(), birth = true) {
    const r = { bytes: 0, newest: 0, files: 0, links: 0, denied: 0, partial: false };
    // modified and created time; a future date reads as now: young. shortcut: a folder moved in keeps both, so it
    // reads as old (ctime would catch it, but any attribute change resets ctime and no test can set it back).
    const seen = st => { r.newest = Math.max(r.newest, Math.min(Math.max(st.mtimeMs, birth ? st.birthtimeMs || 0 : 0), now)); };
    const s = lst(p);
    if (!s) return r;
    if (s.isSymbolicLink()) { r.links = 1; return r; }
    seen(s);
    if (!s.isDirectory()) { r.bytes = s.size; r.files = 1; return r; }
    const stack = [p];
    let n = 0;
    while (stack.length) {
        const d = stack.pop();
        let ents;
        try { ents = readdirSync(d, { withFileTypes: true }); } catch { r.denied++; continue; }
        for (const e of ents) {
            if (++n > 3e6) { r.partial = true; return r; }
            const f = join(d, e.name);
            if (e.isSymbolicLink()) { r.links++; continue; }
            try {
                const st = lstatSync(f);
                seen(st);
                if (e.isDirectory()) stack.push(f); else { r.bytes += st.size; r.files++; }
            } catch { r.denied++; }
        }
    }
    return r;
}

// Deletes p for good, unlinking links instead of entering them and carrying on past files in use (rd /s does the
// same; a Node rmSync stops at the first locked file). Returns how many entries it could not remove.
export function wipe(p) {
    let left = 0;
    const rm = (f, isDir, isLink) => {
        try {
            if (isLink) { try { unlinkSync(f); } catch { rmdirSync(f); } return; }
            if (isDir) {
                for (const e of readdirSync(f, { withFileTypes: true })) rm(join(f, e.name), e.isDirectory(), e.isSymbolicLink());
                rmdirSync(f);
                return;
            }
            try { unlinkSync(f); } catch (e) { if (e.code !== 'EPERM') throw e; chmodSync(f, 0o666); unlinkSync(f); }
        } catch { left++; }
    };
    const s = lst(p);
    if (s) rm(p, s.isDirectory(), s.isSymbolicLink());
    return left;
}

// The person's known folders where Windows keeps them (OneDrive\Desktop, a Documents moved to D:), from gather().
const KNOWN = [];
// Local fixed and removable drive letters from gather(): a dead mapped network drive can hang statfs for minutes.
const VOLS = [];

// A drive root, the home folder or above it, and the known top folders themselves are never acted on, nor
// anything inside the key and system folders.
export function forbidden(p) {
    const k = norm(p), h = norm(homedir());
    if (dirname(k) === k || h === k || h.startsWith(k + sep)) return true;
    const top = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music', 'OneDrive', '.claude', 'AppData',
        join('AppData', 'Local'), join('AppData', 'Roaming'), join('AppData', 'Local', 'Temp')].map(n => join(homedir(), n));
    const env = ['LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'SystemRoot'].map(v => process.env[v]);
    if ([...top, ...env, ...KNOWN].some(t => t && k === norm(t))) return true;
    const deep = [join(homedir(), '.ssh'), join(homedir(), '.gnupg'), process.env.SystemRoot && join(process.env.SystemRoot, 'System32')];
    return deep.some(t => t && inside(k, t));
}

// ---- the machine ----------------------------------------------------------------------------------------------

const PS = String.raw`
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { 'CONSTRAINED'; exit }
$ErrorActionPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.Encoding]::UTF8
$norecycle = [int](Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer' | ? { $_.NoRecycleFiles -eq 1 } | Select -First 1 | % { 1 })
$p = Get-CimInstance Win32_Process | % { [pscustomobject]@{ pid = [int]$_.ProcessId; name = $_.Name; exe = $_.ExecutablePath; cmd = $_.CommandLine; start = $(if ($_.CreationDate) { [string]$_.CreationDate.ToFileTimeUtc() } else { '' }) } }
$u = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' |
  ? { $_.DisplayName -and ($_.EstimatedSize -or $_.InstallLocation) -and -not $_.SystemComponent -and $_.UninstallString } |
  % { [pscustomobject]@{ key = ($_.PSPath -replace '^.*::', ''); name = $_.DisplayName; kb = [long]$_.EstimatedSize; loc = $_.InstallLocation; date = $_.InstallDate; un = $_.UninstallString } }
$v = Get-CimInstance Win32_Volume | ? DriveLetter | % { $g = $_.DeviceID -replace '^.*Volume(\{[^}]+\}).*$', '$1'; $k = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\$g"; [pscustomobject]@{ drive = $_.DriveLetter; maxMB = $k.MaxCapacity; nuke = $(if ($norecycle) { 1 } else { $k.NukeOnDelete }); local = $_.DriveType -in 2, 3 } }
$kf = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders').PSObject.Properties | ? { $_.Name -notlike 'PS*' -and $_.Value -match '^[A-Za-z]:\\' } | % { $_.Value }
[pscustomobject]@{ procs = @($p); known = @($kf); uninstall = @($u); volumes = @($v); sid = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value; steam = (Get-ItemProperty 'HKCU:\Software\Valve\Steam').SteamPath } | ConvertTo-Json -Depth 4 -Compress`;

// Command lines lowercased with backslashes; a Git Bash path (/c/Users/...) is read as C:\Users\... so a bash loop
// that names a folder holds it too.
const prep = procs => procs.map(q => ({ ...q, k: q.exe ? norm(q.exe) : '',
    c: WIN ? (q.cmd ?? '').replace(/(^|[\s"'=:;,(])\/([a-z])\//gi, '$1$2:/').toLowerCase().replaceAll('/', '\\') : q.cmd ?? '' }));

export function gather() {
    const ctx = { now: Date.now(), procs: [], uninstall: [], volumes: [], sid: '', steam: '' };
    if (WIN) {
        const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PS, 'utf16le').toString('base64')],
            { encoding: 'utf8', maxBuffer: 256 << 20, timeout: 180e3 });
        // Constrained Language Mode (AppLocker, WDAC) garbles non-ASCII paths and blocks the SID: holds would go blind.
        if ((r.stdout ?? '').trim() === 'CONSTRAINED') throw new Error('PowerShell runs in Constrained Language Mode here, so running programs cannot be read reliably; nothing was scanned');
        let j;
        try { j = JSON.parse(r.stdout); } catch { throw new Error(`the process list could not be read (powershell exit ${r.status}${r.error ? ', ' + r.error.code : ''}); nothing was scanned`); }
        const list = x => [].concat(x ?? []).filter(Boolean); // @($null) comes back as [null]
        Object.assign(ctx, { procs: list(j.procs), uninstall: list(j.uninstall), volumes: list(j.volumes), sid: j.sid ?? '', steam: j.steam ?? '' });
        KNOWN.splice(0, KNOWN.length, ...list(j.known));
        VOLS.splice(0, VOLS.length, ...ctx.volumes.filter(v => v.local).map(v => v.drive));
    } else {
        const r = spawnSync('ps', ['-axo', 'pid=,comm=,args='], { encoding: 'utf8', maxBuffer: 64 << 20 });
        ctx.procs = (r.stdout ?? '').split('\n').map(l => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(l)).filter(Boolean)
            .map(m => ({ pid: +m[1], name: basename(m[2]), exe: m[2].startsWith('/') ? m[2] : '', cmd: m[3] }));
    }
    if (!ctx.procs.length) throw new Error('the process list came back empty; nothing was scanned');
    ctx.procs = prep(ctx.procs);
    ctx.sessions = sessions(ctx);
    return ctx;
}

// Claude Code sessions from <config>/sessions/*.json (CLAUDE_CONFIG_DIR and ~/.claude both). Live: the pid runs
// and, when the snapshot has it, started at procStart. A pid missing from the snapshot but alive now counts as live
// (a chat opened since). A file that will not read is a live chat of unknown id and folder, so the rules that
// need ids hold everything: chats rewrite these files all the time, and a torn read must not drop a chat.
export function sessions(ctx) {
    const dirs = [...new Set([join(state(), '..', 'sessions'), join(homedir(), '.claude', 'sessions')].map(d => resolve(d)))];
    const byPid = new Map(ctx.procs.map(p => [+p.pid, p]));
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
    const out = [];
    for (const f of dirs.flatMap(d => ls(d).map(n => join(d, n)))) {
        if (!f.endsWith('.json')) continue;
        let j = null;
        for (let i = 0; i < 3 && !j; i++) {
            try { j = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { if (e.code === 'ENOENT') break; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
        }
        if (!j) { if (Date.now() - (lst(f)?.mtimeMs ?? 0) < 600e3) out.push({ id: '', pid: 0, cwd: '', live: true }); continue; } // a file broken for 10 minutes is a crash's leftover, not a chat writing it
        if (!j.pid) continue;
        const p = byPid.get(+j.pid);
        const live = p ? (!j.procStart || !p.start || Math.abs(Number(p.start) - Number(j.procStart)) < 2e7) : alive(+j.pid);
        // root: the repo around the cwd, so a chat opened in <repo>\frontend still holds <repo>\node_modules
        let root = j.cwd ?? '';
        for (let d = root; d && dirname(d) !== d; d = dirname(d)) if (lst(join(d, '.git'))) { root = d; break; }
        out.push({ id: String(j.sessionId ?? ''), pid: +j.pid, cwd: j.cwd ?? '', root, live });
    }
    return out;
}

// Why p must not be touched now, or null.
export function holdOf(p, ctx) {
    for (const s of ctx.sessions) {
        if (!s.live) continue;
        if (s.id && norm(p).includes(s.id.toLowerCase())) return `live chat ${s.id.slice(0, 8)} owns it`; // its scratch, also when resumed mid-apply
        const r = s.root || s.cwd;
        if (!r || inside(homedir(), r)) continue; // a chat started in home or a drive root holds no folder
        if (inside(p, r) || inside(r, p)) return `live chat ${s.id.slice(0, 8)} works in ${r}`;
    }
    const k = norm(p);
    for (const q of ctx.procs) {
        if (q.k && (q.k === k || q.k.startsWith(k + sep))) return `${q.name} (pid ${q.pid}) runs from it`;
        if (q.c.includes(k)) return `${q.name} (pid ${q.pid}) names it in its command line`;
    }
    return null;
}

// Folders holding the repos the sessions work in (the parent of each session's repo), and the repos one or two
// levels below them.
function projects(ctx) {
    const roots = new Map();
    for (const s of ctx.sessions) {
        if (!s.cwd) continue;
        let top = null;
        for (let d = s.cwd; ; d = dirname(d)) { if (lst(join(d, '.git'))) { top = d; break; } if (dirname(d) === d) break; }
        const r = top && dirname(top);
        // never Desktop, Documents or a drive root, nor a repo itself (a session in a submodule or nested repo)
        if (!r || /[\\/](\.claude|worktrees)([\\/]|$)/i.test(r) || inside(homedir(), r) || forbidden(r) || lst(join(r, '.git'))) continue;
        roots.set(norm(r), r);
    }
    const repos = [];
    for (const r of roots.values()) for (const a of ls(r)) {
        const p = join(r, a);
        if (!lst(p)?.isDirectory()) continue;
        if (lst(join(p, '.git'))) repos.push(p);
        else for (const b of ls(p)) if (lst(join(p, b, '.git'))?.isDirectory()) repos.push(join(p, b));
    }
    return { roots: [...roots.values()], repos };
}

const git = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 60e3, maxBuffer: 64 << 20 });

// ---- rule types: each returns candidate groups {slug?, title?, paths, ...} ---------------------------------------

const TYPES = {
    paths(r) {
        // within: the rule only holds where the place is where Windows puts it (a TEMP moved to D:\ or a RAM disk is not)
        const ps = r.paths.flatMap(expand).filter(p => !r.within || expand(r.within).some(w => inside(p, w)));
        if (r.children) {
            const skip = (r.exclude ?? []).map(glob);
            const kids = ps.flatMap(p => ls(p).filter(n => !skip.some(re => re.test(n))).map(n => join(p, n)));
            return r.each ? kids.map(k => ({ slug: basename(k), title: `${r.title}: ${basename(k)}`, paths: [k], app: r.heldByApp && basename(k) })) : [{ paths: kids, perPathAge: true }];
        }
        return r.each ? ps.map(p => ({ slug: basename(p), title: `${r.title}: ${basename(p)}`, paths: [p], app: r.heldByApp && basename(p) })) : ps.length ? [{ paths: ps }] : [];
    },
    // Versioned siblings: keeps the newest `keep` (or the ones named in `keepIn`) and any a process runs from.
    versions(r, ctx) {
        const re = new RegExp(r.match, 'i');
        const num = v => v.split(/\D+/).filter(Boolean).map(Number);
        const cmp = (a, b) => { const x = num(a.v), y = num(b.v); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? -1) - (y[i] ?? -1); if (d) return d; } return 0; };
        return r.parents.flatMap(expand).flatMap(parent => {
            if (r.requires && !lst(join(parent, r.requires))) return []; // e.g. Squirrel's Update.exe: only then is the newest app-x the one that runs
            const all = ls(parent).map(n => [n, re.exec(n)]).filter(x => x[1]).map(([n, m]) => ({ n, p: join(parent, n), v: m[1] ?? n }));
            if (all.length < 2) return [];
            let keep;
            if (r.keepIn) { const t = read(join(parent, r.keepIn)); keep = all.filter(x => t.includes(x.n)); }
            else keep = all.some(x => !num(x.v).length) ? [] : [...all].sort(cmp).slice(-(r.keep ?? 1)); // no number to sort by: no guess
            if (!keep.length) return [];
            const used = all.filter(x => !keep.includes(x) && /runs from it|names it/.test(holdOf(x.p, ctx) ?? '')); // a live chat's hold shows as held later
            const old = all.filter(x => !keep.includes(x) && !used.includes(x));
            return old.length ? [{ slug: basename(parent), title: `${r.title} (${basename(parent)})`, paths: old.map(x => x.p),
                evidence: [`keeps ${keep.map(x => x.n).join(', ')}${r.keepIn ? ` (named in ${r.keepIn})` : ' (newest)'}${used.length ? `, ${used.map(x => x.n).join(', ')} (in use)` : ''}`] }] : [];
        });
    },
    // Claude Code scratch of chats that are not live.
    scratch(r, ctx) {
        const live = ctx.sessions.filter(s => s.live).map(s => s.id.toLowerCase());
        if (live.some(id => !id)) return []; // a live session without an id could own any folder
        const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        // A handoff or hold note that names a chat's folder (a pasted screenshot it cites) keeps that folder.
        const notes = ['handoff', 'hold'].flatMap(d => ls(join(state(), d)).filter(n => n.endsWith('.md')).map(n => read(join(state(), d, n)))).join('\n').toLowerCase();
        const cited = d => notes.includes(basename(d).toLowerCase());
        const all = r.paths.flatMap(expand).filter(d => UUID.test(basename(d)) && !live.some(id => norm(d).includes(id)));
        const dirs = all.filter(d => !cited(d));
        return [{ paths: dirs, perPathAge: true, nonEmpty: true, evidence: [`${live.length} live sessions skipped`, ...(all.length > dirs.length ? [`${all.length - dirs.length} kept: a handoff or hold note cites them`] : [])] }];
    },
    // Gitignored build output in the session repos, one group per repo whose last commit is older than minAgeHours.
    builds(r, ctx, env) {
        const names = new Set(r.names); // case kept: tools write build/, dist/; a Dist/ is usually something a person made
        return env.repos.flatMap(repo => {
            const last = +git(repo, ['log', '-1', '--format=%ct']).stdout * 1000;
            if (!last || last > ctx.now - (r.minAgeHours ?? 0) * HOUR) return [];
            const g = git(repo, ['ls-files', '-o', '-i', '--exclude-standard', '--directory', '-z']);
            if (g.status !== 0) return [];
            const dirs = g.stdout.split('\0').filter(x => x.endsWith('/') && names.has(basename(x.slice(0, -1)))).map(x => join(repo, x.slice(0, -1)));
            return dirs.length ? [{ slug: basename(repo), title: `${r.title}: ${basename(repo)}`, paths: dirs, evidence: [`gitignored; last commit ${day(last)}`] }] : [];
        });
    },
    // Gradle wrapper versions nothing in the session repos pins, submodules included (a walk, not git ls-files).
    gradle(r, ctx, env) {
        if (!env.repos.length || ctx.sessions.some(s => s.live && !s.cwd)) return []; // a chat whose folder is unknown may pin any version
        const g = join(homedir(), '.gradle'), pins = new Set(), SKIP = new Set(['node_modules', '.git', 'build', '.gradle', 'dist', 'target']);
        const walk = (d, depth) => {
            for (const e of (() => { try { return readdirSync(d, { withFileTypes: true }); } catch { return []; } })()) {
                if (e.isDirectory() && depth < 5 && !SKIP.has(e.name)) walk(join(d, e.name), depth + 1);
                else if (e.name === 'gradle-wrapper.properties') { const m = /gradle-([^-/\\]+(?:-[a-z]+-?\d*)?)-(?:bin|all)\.zip/i.exec(read(join(d, e.name))); if (m) pins.add(m[1]); }
            }
        };
        for (const repo of env.repos) walk(repo, 0);
        const byVer = new Map(); // gradle-X-bin and gradle-X-all share caches/X and daemon/X: one group per version
        for (const n of ls(join(g, 'wrapper', 'dists'))) { const m = /^gradle-(.+)-(?:bin|all)$/.exec(n); if (m && !pins.has(m[1])) byVer.set(m[1], [...(byVer.get(m[1]) ?? []), join(g, 'wrapper', 'dists', n)]); }
        return [...byVer].map(([v, dists]) => ({
            slug: v, title: `${r.title} ${v}`, paths: [...dists, join(g, 'caches', v), join(g, 'daemon', v)], atomic: true,
            evidence: [`no gradle-wrapper.properties in ${env.repos.length} session repos pins it (pinned: ${[...pins].join(', ') || 'none'})`],
        }));
    },
    steam(r, ctx) {
        if (!ctx.steam) return [];
        const libs = new Map([[norm(ctx.steam), ctx.steam]]);
        for (const m of read(join(ctx.steam, 'steamapps', 'libraryfolders.vdf')).matchAll(/"path"\s+"([^"]+)"/g)) { const p = m[1].replace(/\\\\/g, '\\'); libs.set(norm(p), p); }
        return [...libs.values()].flatMap(lib => {
            const dirs = new Set();
            let torn = false;
            const games = ls(join(lib, 'steamapps')).filter(n => /^appmanifest_\d+\.acf$/.test(n)).map(n => {
                const t = read(join(lib, 'steamapps', n)), f = k => (new RegExp(`"${k}"\\s+"([^"]*)"`, 'i').exec(t) ?? [])[1];
                const played = +(f('LastPlayed') ?? 0) * 1000, dir = f('installdir');
                if (dir) dirs.add(dir.toLowerCase()); else torn = true;
                return dir && !/redistributable/i.test(f('name') ?? '') && +(f('SizeOnDisk') ?? 0) >= (r.minMB ?? 1024) * MB && {
                    slug: f('name') ?? n, title: `${f('name')} (Steam)`, paths: [join(lib, 'steamapps', 'common', dir)], preset: true,
                    bytes: +(f('SizeOnDisk') ?? 0), newest: played, evidence: [played ? `last played ${day(played)}` : 'never played'], uninstall: `steam://uninstall/${f('appid')}`,
                };
            }).filter(Boolean);
            // A folder in common/ that no manifest names, untouched for a week, is what an uninstall left behind. A manifest
            // that did not read could be its owner: then none is offered.
            const ghosts = torn ? [] : ls(join(lib, 'steamapps', 'common')).filter(d => !dirs.has(d.toLowerCase()) && lst(join(lib, 'steamapps', 'common', d))?.isDirectory())
                .map(d => ({ slug: `left-${d}`, title: `${d} (Steam folder no installed game owns)`, paths: [join(lib, 'steamapps', 'common', d)], method: 'recycle', minMB: 0, minAgeHours: 168,
                    evidence: ['no appmanifest names it'], lose: 'a game copied in by hand, or saves some games keep there; it goes to the Recycle Bin' }));
            return [...games, ...ghosts];
        });
    },
    // Installed programs from the uninstall keys. No size there: the install folder is measured. A key whose folder
    // or uninstaller is gone is a ghost: shown with what the registry claims, and never uninstalled.
    uninstall(r, ctx) {
        const min = (r.minMB ?? 1024) * MB, groups = new Map();
        for (const u of ctx.uninstall) { // Word, Excel and PowerPoint are one install that each key reports in full: one item
            if (/[\\/]Steam App \d+$/i.test(u.key)) continue;
            const loc = (u.loc ?? '').replace(/^"|"$/g, '').replace(/[\\/]+$/, ''), k = `${loc ? norm(loc) : u.name}|${u.kb}`;
            if (groups.has(k)) { const g = groups.get(k); if (!g.name.includes(u.name)) g.name += ` + ${u.name}`; } else groups.set(k, { ...u, loc });
        }
        return [...groups.values()].flatMap(u => {
            const loc = u.loc;
            const exe = (/^"([^"]+)"/.exec(u.un) ?? /^(\S+?\.exe)\b/i.exec(u.un) ?? [])[1];
            const ghost = loc ? !lst(loc) : Boolean(exe && isAbsolute(exe) && !lst(exe)); // rundll32.exe or cmd.exe is found on PATH, not gone
            const claim = u.kb * 1024, bytes = ghost ? null : claim || (loc && !forbidden(loc) ? measure(loc, ctx.now).bytes : 0);
            if (ghost ? claim < min : bytes < min) return [];
            const base = { slug: u.name, title: u.name, paths: !ghost && loc && !forbidden(loc) ? [loc] : [], preset: true, bytes, newest: 0 };
            return [ghost
                ? { ...base, method: 'none', evidence: [`ghost: ${loc || exe} is gone, only the uninstall entry is left (it claims ${gb(claim)})`], lose: `export the key first (reg export "${u.key}"), then remove the entry; nothing is on disk` }
                : { ...base, evidence: [u.date ? `installed ${u.date}` : 'install date unknown', ...(u.kb ? [] : ['size measured from its folder']), 'last use not readable without admin'],
                    uninstall: u.un.replace(/^msiexec(\.exe)?\s*\/I/i, 'MsiExec.exe /X') }];
        });
    },
    // Epic Games launcher installs; it has no uninstaller of its own per game.
    epic(r) {
        return expand('%ProgramData%\\Epic\\EpicGamesLauncher\\Data\\Manifests\\*.item').flatMap(f => {
            let j;
            try { j = JSON.parse(read(f)); } catch { return []; }
            const loc = (j.InstallLocation ?? '').replace(/\//g, sep);
            return loc && lst(loc) && +j.InstallSize >= (r.minMB ?? 1024) * MB
                ? [{ slug: j.DisplayName ?? j.AppName, title: `${j.DisplayName} (Epic)`, paths: [loc], preset: true, bytes: +j.InstallSize, newest: 0, evidence: ['last use not readable without admin'] }] : [];
        });
    },
    // Loose files in the folders holding the repos: logs, drafts and bundles that chats leave beside the repos.
    loose(r, ctx, env) {
        return env.roots.flatMap(root => {
            const files = ls(root).filter(n => !n.startsWith('.')).map(n => join(root, n)).filter(p => lst(p)?.isFile() && !/\.(lnk|ini)$/i.test(p));
            return files.length ? [{ slug: basename(root), title: `${r.title}: ${root}`, paths: files, perPathAge: true }] : [];
        });
    },
    bins(r, ctx) {
        return ctx.sid ? ctx.volumes.map(v => ({ slug: v.drive, title: `${r.title} ${v.drive}`, paths: [join(v.drive + sep, '$Recycle.Bin', ctx.sid)] })) : [];
    },
    command() { return [{ paths: [], preset: true, bytes: null }]; },
};

export function loadRules(extra) {
    // --rules stands in for the machine's own file: the way round a broken one while it is being fixed
    if (extra && !existsSync(extra)) throw new Error(`--rules ${extra}: no such file`);
    const files = [join(HERE, 'rules.json'), extra ?? join(state(), 'cleanup-rules.json')].filter(f => f && existsSync(f));
    const byId = new Map();
    for (const f of files) {
        let list;
        try { list = JSON.parse(read(f).replace(/^\uFEFF/, '')).rules; } catch (e) { throw new Error(`${f}: not JSON (${e.message})`); } // PowerShell 5.1 writes a BOM
        for (const r of list ?? []) {
            if (r.off) { if (byId.has(r.id)) byId.set(r.id, { ...byId.get(r.id), off: true }); continue; }
            const bad = !/^[a-z0-9-]+$/.test(r.id ?? '') ? 'id must be lowercase letters, digits and dashes' : !r.title ? 'no title'
                : !TIERS.includes(r.tier) ? `tier must be one of ${TIERS}` : !METHODS.includes(r.method) ? `method must be one of ${METHODS}`
                : !TYPES[r.type ?? 'paths'] ? `unknown type ${r.type}` : (r.type ?? 'paths') === 'paths' && !Array.isArray(r.paths) ? 'paths missing'
                : r.type === 'versions' && !(Array.isArray(r.parents) && r.match) ? 'versions needs parents and match' : '';
            if (bad) throw new Error(`${f}: rule ${r.id ?? '?'}: ${bad}`);
            byId.set(r.id, { ...r, shipped: f === files[0] && f === join(HERE, 'rules.json') }); // only shipped rules may put commands in the elevated .bat
        }
    }
    return [...byId.values()];
}

const hash = s => [...s].reduce((h, c) => (h * 31 + c.codePointAt(0)) >>> 0, 7).toString(36);
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || hash(s);

// The rule's own apps that are running: `running` regexes on the process name (or `cmd:` on its command line), and
// for a heldByApp folder the app it is named after (open-whispr-updater belongs to OpenWhispr.exe).
function running(r, procs) {
    const out = (r.running ?? []).flatMap(rx => {
        const onCmd = rx.startsWith('cmd:'), re = new RegExp(onCmd ? rx.slice(4) : rx, 'i');
        // not this script, nor the shell that started it with `apply pnpm-store` on its command line
        const q = procs.find(q => q.pid !== process.pid && !/machine\.mjs/i.test(q.cmd ?? '') && re.test(onCmd ? q.cmd ?? '' : q.name ?? ''));
        return q ? [`${q.name} (pid ${q.pid}) is running`] : [];
    });
    const a = r.app && r.app.replace(/-updater$/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    const q = a && procs.find(q => (q.name ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase().startsWith(a));
    return q ? [...out, `${q.name} (pid ${q.pid}) is running`] : out;
}

// Whether a vendor tool is on PATH, looked up from the Windows folder: cmd and `where` search the current folder
// first, and a repo may hold an npm.cmd.
const TOOLS = new Map();
const toolCwd = () => WIN ? process.env.SystemRoot || homedir() : homedir();
const hasTool = t => { if (!TOOLS.has(t)) TOOLS.set(t, spawnSync(WIN ? 'where' : 'which', [t], { stdio: 'ignore', cwd: toolCwd() }).status === 0); return TOOLS.get(t); };

// Measures every rule and returns the items, ranked within each tier by size.
export function evaluate(rules, ctx) {
    const items = [], claimed = [], omitted = { small: 0, young: 0 }, env = projects(ctx), ids = new Set(), heldOnly = [];
    for (const rule of rules) {
        if (rule.off || (rule.os && rule.os !== process.platform)) continue;
        let groups;
        try { groups = TYPES[rule.type ?? 'paths'](rule, ctx, env); } catch (e) { items.push({ id: rule.id, rule: rule.id, title: rule.title, tier: rule.tier, method: 'none', paths: [], parts: [], bytes: null, blockers: [`rule failed: ${e.message}`], held: [], evidence: [] }); continue; }
        for (const c of groups) {
            const minAge = (c.minAgeHours ?? rule.minAgeHours ?? 0) * HOUR, minBytes = (c.minMB ?? rule.minMB ?? 20) * MB;
            const acts = ['delete', 'recycle', 'vendor'].includes(c.method ?? rule.method);
            const held = [], parts = [];
            for (const p of c.paths.filter(lst)) {
                if (!c.preset && claimed.some(k => inside(p, k))) continue;
                const why = acts && forbidden(p) ? 'a top folder: never acted on' : holdOf(p, ctx);
                if (why && !c.preset) { held.push({ path: p, why }); continue; }
                if (c.preset) { parts.push({ path: p, bytes: 0, newest: 0, links: 0, held: why }); continue; }
                const m = measure(p, ctx.now, rule.ageBy !== "modified");
                if (c.nonEmpty && !m.files) continue;
                if (m.partial) { omitted.young++; continue; } // too big to walk whole: its newest date is unknown
                if (c.perPathAge && minAge && m.newest > ctx.now - minAge) { omitted.young++; continue; }
                parts.push({ path: p, ...m });
            }
            const bytes = c.preset ? c.bytes : parts.reduce((s, x) => s + x.bytes, 0);
            const newest = c.preset ? c.newest : Math.max(0, ...parts.map(x => x.newest));
            const denied = parts.some(x => x.denied) && !bytes;
            if (c.atomic && held.length) parts.length = 0; // gradle: its dists, caches and daemon go together or not at all
            if (!parts.length && !c.preset) {
                const hb = held.reduce((s, h) => s + measure(h.path, ctx.now).bytes, 0); // only what would have been worth listing
                if (held.length && hb >= minBytes) heldOnly.push({ rule: rule.id, title: c.title ?? rule.title, paths: held.length, bytes: hb, why: held[0].why });
                continue;
            }
            if (parts.length && !c.preset && !c.perPathAge && minAge && newest > ctx.now - minAge) { omitted.young++; continue; }
            if ((c.preset ? bytes != null : parts.length && !denied) && bytes < minBytes) { omitted.small++; continue; }
            const blockers = [...running({ running: rule.running, app: c.app }, ctx.procs), ...parts.filter(x => x.held).map(x => x.held)];
            if ((c.method ?? rule.method) === 'vendor' && rule.vendor && !hasTool(rule.vendor.split(' ')[0])) blockers.push(`${rule.vendor.split(' ')[0]} is not installed, so apply would do nothing`);
            // Same name twice (three Claude profiles, "Setup (1).exe" and "setup-1.exe"): every one of them gets a hash of
            // its path, so an id never moves to another path between scan and apply; it can only stop being found.
            let id = c.slug === undefined ? rule.id : `${rule.id}:${slug(c.slug)}`;
            if (c.slug !== undefined && groups.filter(g => g.slug !== undefined && slug(g.slug) === slug(c.slug)).length > 1 || ids.has(id)) id = `${id}-${hash(norm(c.paths[0] ?? c.title ?? ''))}`;
            ids.add(id);
            items.push({ id, rule: rule.id, title: c.title ?? rule.title, tier: rule.tier, method: c.method ?? rule.method, vendor: rule.vendor,
                paths: parts.map(x => x.path), parts, bytes: denied ? null : bytes, newest, held, blockers: [...new Set(blockers)],
                evidence: [...(c.evidence ?? []), ...(denied ? ['size not readable without admin'] : [])], lose: c.lose ?? rule.lose, explain: rule.explain,
                uninstall: c.uninstall, atomic: !!c.atomic, running: rule.running, app: c.app, scratch: rule.type === 'scratch', bat: rule.shipped ? rule.bat : undefined, birth: rule.ageBy !== "modified", minAgeHours: c.minAgeHours ?? rule.minAgeHours ?? 0 });
            if (!c.preset) claimed.push(...parts.map(x => x.path));
        }
    }
    items.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || (b.bytes ?? 0) - (a.bytes ?? 0));
    return { items, heldOnly, omitted, roots: env.roots, repos: env.repos.length, live: ctx.sessions.filter(s => s.live).length,
        hidden: WIN ? ctx.procs.filter(q => !q.exe && !q.cmd && q.pid > 4).length : 0 };
}

// ---- acting ---------------------------------------------------------------------------------------------------

const PS_RECYCLE = String.raw`$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; $p = $env:CLEANUP_PATH
if ([IO.Directory]::Exists($p)) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }`;

// Moves one measured part to the Recycle Bin, or says why not.
export function recycleOne(part, ctx) {
    if (!WIN) return { why: 'the Recycle Bin is Windows-only in this version' };
    const drive = part.path.slice(0, 2).toUpperCase(), v = ctx.volumes.find(x => (x.drive ?? '').toUpperCase() === drive);
    if (!v || !v.maxMB || +v.nuke === 1) return { why: `the Recycle Bin of ${drive} is off or unknown` };
    if (part.links) return { why: 'it holds a link (junction or symlink); move it by hand' };
    // A synced folder deletes in the cloud too, and an online-only file is not in the local bin to restore.
    const cloud = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'].map(v => process.env[v]).find(d => d && inside(part.path, d));
    if (cloud) return { why: `it is inside OneDrive (${cloud}); delete it there, where OneDrive keeps its own recycle bin` };
    const bin = join(drive + sep, '$Recycle.Bin', ctx.sid), used = measure(bin).bytes, room = v.maxMB * MB * 0.9 - used;
    if (part.bytes > room) return { why: `kept: it does not fit the Recycle Bin (${gb(Math.max(0, room))} free there), and Windows would delete it for good` };
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PS_RECYCLE, 'utf16le').toString('base64')],
        { encoding: 'utf8', timeout: 600e3, env: { ...process.env, CLEANUP_PATH: part.path } });
    const grew = measure(bin).bytes - used;
    if (lst(part.path)) return { why: `still there: ${(r.stderr || '').trim().split('\n')[0] || 'unknown'}` };
    return grew >= part.bytes * 0.9 ? { done: 'recycled' } : { done: 'deleted', warn: 'gone, but the Recycle Bin did not grow by it: it may not be restorable' };
}

const SILENT = /(^|\s)[/-]{1,2}(s|silent|verysilent|quiet|q|qn|qb|qr|passive)([!+=-]|\s|$)|--mode[= ](silent|unattended)/i;

// One apply at a time on this machine: two would credit each other's Recycle Bin growth and both pass its room check.
function lock() {
    const f = join(state(), 'cleanup-apply.lock');
    mkdirSync(state(), { recursive: true });
    for (let i = 0; i < 2; i++) {
        try { writeFileSync(f, String(process.pid), { flag: 'wx' }); return () => { if (+read(f) === process.pid) rmSync(f, { force: true }); }; } catch (e) { if (e.code !== 'EEXIST') throw e; }
        const pid = +read(f), young = Date.now() - (lst(f)?.mtimeMs ?? 0) < 60e3;
        // A stale lock is renamed away, not deleted: of two runs that rename it at once, only one succeeds.
        // shortcut: a slow run can still rename a lock another run wrote just after; fine for a person-started command.
        const drop = () => { try { renameSync(f, `${f}.${process.pid}.stale`); rmSync(`${f}.${process.pid}.stale`, { force: true }); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
        if (!(pid > 0)) { if (young) throw new Error(`another cleanup apply is starting (${f}); wait a minute`); drop(); continue; } // empty: a crash mid-write
        try { process.kill(pid, 0); throw new Error(`another cleanup apply runs (pid ${pid}); wait for it, or delete ${f} if none does`); } catch (e) { if (e.code !== 'ESRCH') throw e; drop(); }
    }
    throw new Error(`could not take ${f}`);
}

export function apply(ids, rules, ctx = gather()) {
    const unlock = lock();
    try { return applyLocked(ids, rules, ctx); } finally { unlock(); }
}

function applyLocked(ids, rules, ctx) {
    // Every rule, not only the picked ones: an earlier rule's claim on a path must hold here as it did in the scan.
    const { items } = evaluate(rules, ctx);
    const look = () => { if (!ctx.fixed) ctx.procs = prep(gather().procs); }; // ctx.fixed: the selftest's own process list
    look(); // the walk took a minute or more: look at the programs again before the first item
    const out = [], free0 = drives(), logf = join(state(), 'cleanup-log.jsonl');
    let seen = Date.now();
    const fresh = () => { if (Date.now() - seen > 60e3) { seen = Date.now(); look(); } }; // a program started during a long apply
    mkdirSync(state(), { recursive: true });
    for (const id of new Set(ids)) {
        if (out.length) appendFileSync(logf, JSON.stringify(out.at(-1)) + '\n'); // logged as it goes: a crash later keeps what was done
        const it = items.find(i => i.id === id);
        // after starts equal to before: an item skipped or held frees nothing, whichever `continue` it leaves by
        const row = { at: new Date().toISOString(), id, rule: it?.rule, method: it?.method, before: it?.bytes ?? 0, after: it?.bytes ?? 0, toBin: 0, outcome: 'skipped', notes: [] };
        out.push(row);
        try {
        if (!it) { row.notes.push('not found on a fresh scan: gone, now in use, too young or too small'); continue; }
        fresh();
        const busy = [...running(it, ctx.procs), ...it.blockers];
        if (busy.length) { row.notes.push(...new Set(busy)); continue; }
        if (it.tier === 'admin') { row.notes.push('admin item: use `admin` to write the .bat'); continue; }
        if (it.method === 'none') { row.notes.push(`yours to do: ${it.lose ?? it.title}`); continue; }
        if (it.method === 'uninstall') {
            row.after = row.before;
            if (!WIN) { row.notes.push(`run: ${it.uninstall}`); continue; }
            if (it.uninstall.startsWith('steam://')) spawn('cmd', ['/d', '/c', 'start', '""', it.uninstall], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
            else if (SILENT.test(it.uninstall)) { row.notes.push(`its uninstaller runs silently, so it was not started; run it yourself: ${it.uninstall}`); continue; }
            else spawn(it.uninstall, { shell: true, detached: true, stdio: 'ignore' }).unref();
            row.outcome = 'opened'; row.notes.push('confirm in its own window, then scan again');
            continue;
        }
        ctx.sessions = sessions(ctx); // a chat opened or resumed since the scan
        const why = p => forbidden(p.path) ? 'a top folder' : holdOf(p.path, ctx)
            ?? (it.scratch && ctx.sessions.some(s => s.live && !s.id) ? 'a session file did not read, so every scratch folder is held' : null)
            ?? (it.minAgeHours && measure(p.path, Date.now(), it.birth).newest > Date.now() - it.minAgeHours * HOUR ? 'written to since the scan' : null);
        if ((it.method === 'vendor' && it.vendor) || it.atomic) {
            const w = it.parts.map(why).find(Boolean);
            if (w && it.atomic) { row.notes.push(`kept all: ${w}`); row.after = row.before; continue; }
        }
        if (it.method === 'vendor' && it.vendor) {
            const w = it.parts.map(why).find(Boolean);
            if (w) { row.notes.push(`not cleaned: ${w}`); row.after = row.before; continue; }
            // Run from the Windows folder, like the lookup (hasTool).
            const cwd = toolCwd(), tool = it.vendor.split(' ')[0];
            if (hasTool(tool)) {
                // The tool decides what goes (pnpm store prune keeps what projects link to): its result is measured, never
                // followed by a delete of its own folder; a failed run deletes nothing either.
                const r = spawnSync(it.vendor, { shell: true, encoding: 'utf8', timeout: 600e3, cwd });
                row.notes.push(`${it.vendor}: exit ${r.status}${(r.stdout || r.stderr || '').trim() ? ' - ' + (r.stdout || r.stderr).trim().split('\n').pop() : ''}`);
                row.after = it.parts.reduce((s, p) => s + measure(p.path).bytes, 0);
                row.outcome = r.status === 0 ? (row.after < row.before ? 'deleted' : 'unchanged') : 'unchanged';
                continue;
            }
            // The label promised the tool's own clean (pnpm store prune keeps what projects link to): without the tool
            // nothing is done rather than a whole-folder delete nobody picked.
            row.notes.push(`${tool} is not installed here, so nothing was done; delete ${it.paths[0]} by hand if ${tool} is no longer used`);
            row.outcome = 'unchanged';
            continue;
        }
        let lost = 0;
        row.after = 0;
        for (const part of it.parts) {
            ctx.sessions = sessions(ctx);
            fresh();
            const w = why(part) ?? (running(it, ctx.procs)[0] ?? null);
            if (w) { row.notes.push(`kept ${part.path}: ${w}`); row.after += part.bytes; continue; }
            if (it.method === 'recycle') {
                const r = recycleOne(part, ctx);
                if (r.why) { row.notes.push(`kept ${part.path}: ${r.why}`); row.after += part.bytes; continue; }
                if (r.warn) { row.notes.push(`${part.path}: ${r.warn}`); lost++; } else row.toBin += part.bytes;
            } else if (lst(part.path)) wipe(part.path);
            row.after += measure(part.path).bytes;
        }
        const left = it.parts.filter(p => lst(p.path)).length;
        row.outcome = row.after === row.before && left === it.parts.length ? 'unchanged' : left ? 'partly left'
            : it.method === 'recycle' && !lost ? 'recycled' : 'deleted';
        if (left && row.outcome === 'partly left') row.notes.push(`${left} of ${it.parts.length} paths still there (files in use or kept)`);
        } catch (e) { // one item's failure stops neither the log nor the rest; what it did is measured, not assumed
            row.outcome = 'error'; row.notes.push(e.message);
            if (it) row.after = it.parts.reduce((s, p) => s + measure(p.path).bytes, 0);
        }
    }
    if (out.length) appendFileSync(logf, JSON.stringify(out.at(-1)) + '\n');
    // What went to the Recycle Bin still takes disk space until the bin is emptied: counted apart.
    return { rows: out, freed: out.reduce((s, r) => s + Math.max(0, r.before - r.after - r.toBin), 0), toBin: out.reduce((s, r) => s + r.toBin, 0), free: [free0, drives()] };
}

const drives = (total = false) => Object.fromEntries((WIN ? (VOLS.length ? VOLS : ['C:']).map(d => d + '\\') : ['/']).flatMap(d => {
    try { const s = statfsSync(d), free = s.bavail * s.bsize; return [[d.slice(0, 2), total ? { free, total: s.blocks * s.bsize } : free]]; } catch { return []; }
}));

// Writes the .bat for admin items; the person runs it elevated. English text: the console shows Cyrillic as ???.
export function admin(ids, rules, ctx = gather()) {
    const { items } = evaluate(rules, ctx);
    const esc = s => String(s).replace(/%/g, '%%').replace(/[&|<>^()]/g, '^$&'); // in a .bat a % is doubled, not careted
    const L = ['@echo off', 'chcp 65001 >nul', 'net session >nul 2>&1 || (echo Right-click this file and choose "Run as administrator". & pause & exit /b 1)'];
    const done = [], held = [];
    for (const id of ids) {
        const it = items.find(i => i.id === id && i.tier === 'admin');
        if (!it) continue;
        if (it.blockers.length) { held.push(`${id}: ${it.blockers[0]}`); continue; }
        done.push(id);
        L.push('echo.', `echo [${esc(id)}] ${esc(it.title)}${it.bytes ? ` - ${gb(it.bytes)}` : ''}`, ...(it.explain ? [`echo     ${esc(it.explain)}`] : []),
            ...(it.bat ?? it.paths.map(p => `${lst(p)?.isDirectory() ? 'rd /s /q' : 'del /f /q'} "${p.replace(/%/g, '%%')}"`)));
    }
    L.push('echo.', 'echo Done. You can close this window.', 'pause');
    const f = join(state(), 'cleanup-admin.bat');
    mkdirSync(state(), { recursive: true });
    writeFileSync(f, L.join('\r\n') + '\r\n');
    return { file: f, ids: done, held, missing: ids.filter(i => !done.includes(i) && !held.some(h => h.startsWith(i + ':'))) };
}

// ---- output ---------------------------------------------------------------------------------------------------

function show(s) {
    const w = Math.max(4, ...s.items.map(i => i.id.length)), L = [];
    const ok = s.items.filter(i => !i.blockers.length && i.paths.length + (i.uninstall || i.method === 'none' || i.bat ? 1 : 0));
    const total = ok.filter(i => i.tier === 'safe' || i.tier === 'close-app').reduce((a, i) => a + (i.bytes ?? 0), 0);
    const d = drives(true);
    L.push(`drives: ${Object.entries(d).map(([k, v]) => `${k} ${gb(v.free)} free of ${gb(v.total)} (${Math.round(100 - 100 * v.free / v.total)}% full)`).join(', ')}`);
    L.push(`${s.live} live chats, ${s.repos} repos under ${s.roots.join(', ') || 'no project folder'}; ready in safe and close-app: ${gb(total)}; omitted: ${s.omitted.small} small, ${s.omitted.young} recently used${s.hidden ? `; ${s.hidden} processes hide their path without admin, so a hold can miss them` : ''}`);
    for (const t of TIERS) {
        const list = s.items.filter(i => i.tier === t);
        if (!list.length) continue;
        L.push('', t);
        for (const i of list) {
            L.push(`  ${i.id.padEnd(w)} ${gb(i.bytes).padStart(9)} ${ago(i.newest).padStart(5)}  ${i.title}  [${i.method === 'vendor' ? i.vendor : i.method}]`);
            const pad = `  ${''.padEnd(w)}   `;
            if (i.paths.length <= 10) L.push(...i.paths.map(p => pad + p)); else L.push(`${pad}${i.paths.length} paths, e.g. ${i.paths[0]} (--json lists all)`);
            if (i.uninstall) L.push(`${pad}uninstaller: ${i.uninstall}`);
            for (const e of [...i.evidence, ...(i.lose ? [`lose: ${i.lose}`] : [])]) L.push(`  ${''.padEnd(w)}   ${e}`);
            for (const b of i.blockers) L.push(`  ${''.padEnd(w)}   HELD: ${b}`);
            if (i.held.length) L.push(`  ${''.padEnd(w)}   kept ${i.held.length} path(s): ${i.held[0].why}${i.held.length > 1 ? ', ...' : ''}`);
        }
    }
    if (s.heldOnly.length) L.push('', 'held, nothing to do now:', ...s.heldOnly.map(h => `  ${h.title} - ${gb(h.bytes)} in ${h.paths} path(s): ${h.why}`));
    return L;
}

// ---- selftest -------------------------------------------------------------------------------------------------

function selftest() {
    const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'cleanup-selftest-')));
    const saved = { ...process.env };
    try {
        const home = join(tmp, 'home'), local = join(tmp, 'local'), temp = join(tmp, 'temp'), outside = join(tmp, 'outside');
        Object.assign(process.env, { USERPROFILE: home, HOME: home, LOCALAPPDATA: local, TEMP: temp, CLAUDE_CONFIG_DIR: join(tmp, 'claude') });
        const old = Date.now() / 1000 - 3 * 86400;
        const put = (f, bytes = 1024, t = old) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, Buffer.alloc(bytes)); utimesSync(f, t, t); };
        const U = n => `0000000${n}-0000-0000-0000-000000000000`;
        put(join(temp, 'claude', 'C--p', U(1), 'a')); // live
        put(join(temp, 'claude', 'C--p', U(2), 'a'), 4096); // ended, old
        mkdirSync(join(temp, 'claude', 'C--p', U(3)), { recursive: true }); // ended, young (its file comes after the backdating)
        mkdirSync(join(temp, 'claude', 'C--p', U(4)), { recursive: true }); // empty
        for (const v of ['app-1.2.9', 'app-1.9.0', 'app-1.10.0']) put(join(local, 'App', v, 'App.exe'));
        put(join(local, 'Hash', 'bin', 'code'), 10); writeFileSync(join(local, 'Hash', 'bin', 'code'), 'VSCODE_PATH=..\\bbbbbbbbbb\\');
        for (const v of ['aaaaaaaaaa', 'bbbbbbbbbb']) put(join(local, 'Hash', v, 'x'));
        put(join(outside, 'keep.txt'), 5 * MB);
        put(join(local, 'cache', 'blob'), 2048);
        put(join(local, 'brave', 'Cache', 'f'));
        put(join(local, 'vend', 'f'));
        mkdirSync(join(local, 'fut'), { recursive: true });
        // measure() also reads creation times, which utimes cannot set: backdate every file and folder made so far.
        if (!WIN) { console.log('machine.mjs selftest: Windows only for now (it backdates creation times through PowerShell)'); return; }
        const bd = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
            `$t = (Get-Date).AddDays(-3); Get-ChildItem -LiteralPath $env:T -Recurse -Force | % { $_.CreationTime = $t; $_.LastWriteTime = $t }; Get-ChildItem -LiteralPath $env:T -Directory -Force | % { $_.CreationTime = $t; $_.LastWriteTime = $t }`],
            { encoding: 'utf8', env: { ...process.env, T: tmp } });
        assert.equal(bd.status, 0, `backdating failed: ${bd.stderr}`);
        symlinkSync(outside, join(local, 'cache', 'link'), 'junction');
        symlinkSync(join(local, 'brave'), join(local, 'Alias'), 'junction'); // like Local\Application Data
        for (const d of ['d1', 'd2']) put(join(local, d, 'same', 'f'));
        spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$t = (Get-Date).AddDays(-3); 'd1','d2' | % { Get-ChildItem -LiteralPath (Join-Path $env:L $_) -Recurse -Force | % { $_.CreationTime = $t; $_.LastWriteTime = $t } }`], { env: { ...process.env, L: local } });
        put(join(temp, 'claude', 'C--p', U(3), 'a'), 1024, Date.now() / 1000);
        put(join(local, 'fut', 'f'), 1024, 4102444800); // 2100-01-01
        mkdirSync(join(tmp, 'claude', 'sessions'), { recursive: true });
        writeFileSync(join(tmp, 'claude', 'sessions', '1.json'), JSON.stringify({ pid: process.pid, sessionId: U(1), cwd: join(home, 'proj') }));

        const ctx = { fixed: true, now: Date.now(), procs: prep([{ pid: 4242, name: 'App.exe', exe: join(local, 'App', 'app-1.2.9', 'App.exe'), cmd: '' }, { pid: 4243, name: 'brave.exe', exe: '', cmd: '' }]), uninstall: [], volumes: [], sid: '', steam: '' };
        ctx.sessions = sessions(ctx);
        assert.equal(ctx.sessions[0].live, true, 'own pid with no procStart is live');
        const rules = [
            { id: 't-scratch', title: 's', tier: 'safe', method: 'delete', type: 'scratch', paths: ['%TEMP%\\claude\\C--*\\*'], minAgeHours: 24, minMB: 0 },
            { id: 't-ver', title: 'v', tier: 'safe', method: 'delete', type: 'versions', parents: ['%LOCALAPPDATA%\\App'], match: '^app-(\\d.*)$', minMB: 0 },
            { id: 't-hash', title: 'h', tier: 'safe', method: 'delete', type: 'versions', parents: ['%LOCALAPPDATA%\\Hash'], match: '^([0-9a-f]{10})$', keepIn: 'bin\\code', minMB: 0 },
            { id: 't-cache', title: 'c', tier: 'safe', method: 'delete', paths: ['%LOCALAPPDATA%\\cach*'], minMB: 0 },
            { id: 't-fut', title: 'f', tier: 'safe', method: 'delete', paths: ['%LOCALAPPDATA%\\fut'], minAgeHours: 24, minMB: 0 },
            { id: 't-brave', title: 'b', tier: 'close-app', method: 'delete', paths: ['%LOCALAPPDATA%\\brave\\*'], running: ['^brave\\.exe$'], minMB: 0 },
            { id: 't-none', title: 'n', tier: 'safe', method: 'delete', paths: ['%NO_SUCH_VAR%\\x'] },
            { id: 't-alias', title: 'a', tier: 'safe', method: 'delete', paths: ['%LOCALAPPDATA%\\*\\Cache'], minMB: 0 },
            { id: 't-dup', title: 'd', tier: 'safe', method: 'delete', each: true, paths: ['%LOCALAPPDATA%\\d*\\same'], minMB: 0 },
            { id: 't-vendor', title: 'vd', tier: 'safe', method: 'vendor', vendor: 'node -e 0', paths: ['%LOCALAPPDATA%\\vend'], minMB: 0 },
            { id: 't-notool', title: 'nt', tier: 'safe', method: 'vendor', vendor: 'no-such-tool-x1 clean', paths: ['%LOCALAPPDATA%\\Hash\\bin'], minMB: 0 },
        ];
        const s = evaluate(rules, ctx), by = Object.fromEntries(s.items.map(i => [i.id, i]));
        assert.deepEqual(by['t-scratch'].paths, [join(temp, 'claude', 'C--p', U(2))], 'scratch: only the ended, old, non-empty chat');
        assert.deepEqual(by['t-ver:app'].paths, [join(local, 'App', 'app-1.9.0')], 'versions: 1.10.0 is newest by number, 1.2.9 is in use');
        assert.deepEqual(by['t-hash:hash'].paths, [join(local, 'Hash', 'aaaaaaaaaa')], 'versions: keepIn names the current build');
        assert.equal(by['t-cache'].bytes, 2048, 'size skips what a junction points at');
        assert.equal(by['t-cache'].parts[0].links, 1);
        assert.ok(!by['t-fut'] && s.omitted.young >= 2, 'a future-dated file reads as new');
        assert.match(by['t-brave'].blockers[0], /brave\.exe/);
        assert.ok(!Object.keys(by).some(k => k.startsWith('t-none')), 'an unknown variable matches nothing');
        assert.ok(forbidden(home) && forbidden(tmp) && forbidden(local) && !forbidden(join(local, 'cache')), 'top folders refused');
        assert.ok(forbidden(join(home, '.ssh', 'old')), 'nothing inside .ssh');
        assert.ok(!by['t-alias'], 'a * does not enter a junction: brave\\Cache is claimed by t-brave, Alias\\Cache is never seen');
        const dups = s.items.filter(i => i.rule === 't-dup').map(i => i.id);
        assert.ok(dups.length === 2 && dups.every(i => /^t-dup:same-[0-9a-z]+$/.test(i)) && dups[0] !== dups[1], `same name twice: both ids carry a path hash (${dups})`);
        assert.ok(expand('relative\\x').length === 0, 'a relative pattern matches nothing');
        assert.equal(TYPES.paths({ paths: ['%TEMP%'], within: '%LOCALAPPDATA%' }).length, 0, 'a TEMP outside LOCALAPPDATA (D:\\, a RAM disk) is not cleaned');
        put(join(local, 'unzipped', 'f'), 1024, old); // an unzip: old modified date, created now
        assert.ok(measure(join(local, 'unzipped', 'f')).newest > Date.now() - HOUR, 'a file created now is new whatever its modified date');
        writeFileSync(join(tmp, 'claude', 'sessions', '2.json'), '{"pid": 1, "sessio'); // torn mid-write
        const torn = { ...ctx, sessions: sessions(ctx) };
        assert.ok(!evaluate([rules[0]], torn).items.length, 'a session file that does not read holds every scratch folder');
        rmSync(join(tmp, 'claude', 'sessions', '2.json'));
        assert.equal(holdOf(join(home, 'proj', 'build'), ctx)?.startsWith('live chat'), true, 'a live chat holds its cwd');
        writeFileSync(join(tmp, 'bad.json'), JSON.stringify({ rules: [{ id: 'x', title: 'x', tier: 'maybe', method: 'delete', paths: [] }] }));
        assert.throws(() => loadRules(join(tmp, 'bad.json')), /tier must be/);
        // The shipped catalog: every pattern starts at ~, a %VAR% or a drive, and holds no control character (a \r or \v
        // a shell made of "\registry" or "\v3-cache"), and every running regex compiles.
        for (const r of loadRules()) {
            for (const p of [...(r.paths ?? []), ...(r.parents ?? [])]) assert.ok(/^(~[\\/]|%[^%]+%([\\/]|$)|[A-Za-z]:[\\/]|\/)/.test(p) && !/[\x00-\x1f]/.test(p), `rules.json ${r.id}: bad path ${JSON.stringify(p)}`);
            for (const x of r.running ?? []) new RegExp(x.replace(/^cmd:/, ''));
        }
        assert.ok(holdOf(join(local, 'cache'), { ...ctx, sessions: [], procs: prep([{ pid: 7, name: 'bash.exe', cmd: `bash /${local[0].toLowerCase()}/${local.slice(3).replaceAll('\\', '/')}/cache/watch.sh` }]) }), 'a Git Bash /c/... path holds its folder');
        mkdirSync(join(tmp, 'claude', 'makarasty', 'hold'), { recursive: true });
        writeFileSync(join(tmp, 'claude', 'makarasty', 'hold', 'n.md'), `see ${join(temp, 'claude', 'C--p', U(2), 'images', '1.png')}`);
        assert.ok(!evaluate([rules[0]], ctx).items.length, 'a scratch folder a hold note cites is kept');
        rmSync(join(tmp, 'claude', 'makarasty', 'hold', 'n.md'));
        assert.equal(running({ running: ['cmd:pnpm'] }, prep([{ pid: 9, name: 'bash.exe', cmd: 'bash -c "node machine.mjs apply pnpm-store"' }])).length, 0, 'the shell that runs apply is not a hold');
        writeFileSync(join(tmp, 'bom.json'), '\uFEFF{"rules": []}');
        assert.doesNotThrow(() => loadRules(join(tmp, 'bom.json')), 'a rules file PowerShell 5.1 wrote with a BOM loads');
        const un = TYPES.uninstall({ minMB: 0 }, { ...ctx, uninstall: [{ key: 'HKCU\\x\\ClickOnce', name: 'ClickOnce app', kb: 2048, loc: '', un: 'rundll32.exe dfshim.dll,ShArpMaintain x' }] });
        assert.ok(un.length === 1 && un[0].method !== 'none', 'rundll32.exe is on PATH, not a ghost');
        for (const s of ['MsiExec.exe /X{1} /qb-', 'x.exe --silent=true', 'x.exe --mode=unattended', 'unins000.exe /VERYSILENT']) assert.ok(SILENT.test(s), `silent: ${s}`);
        assert.ok(!SILENT.test('"C:\\Program Files\\App\\unins000.exe"') && !SILENT.test('MsiExec.exe /X{4391AF95}'), 'an interactive uninstaller is not silent');

        const a = apply(['t-scratch', 't-cache', 't-brave', 't-gone', 't-vendor', 't-notool'], rules, ctx);
        const o = Object.fromEntries(a.rows.map(r => [r.id, r]));
        assert.equal(o['t-scratch'].outcome, 'deleted');
        assert.ok(!existsSync(join(temp, 'claude', 'C--p', U(2))) && existsSync(join(temp, 'claude', 'C--p', U(1))), 'live scratch survives');
        assert.equal(o['t-cache'].outcome, 'deleted');
        assert.ok(existsSync(join(outside, 'keep.txt')), 'deleting a folder leaves the junction target intact');
        assert.equal(o['t-brave'].outcome, 'skipped');
        assert.ok(o['t-brave'].before > 0 && o['t-brave'].after === o['t-brave'].before, 'a held item frees nothing');
        assert.equal(o['t-gone'].outcome, 'skipped');
        assert.ok(o['t-vendor'].outcome === 'unchanged' && existsSync(join(local, 'vend', 'f')), 'a vendor clean that removed nothing is not followed by a delete');
        assert.ok(o['t-notool'].outcome === 'skipped' && /not installed/.test(o['t-notool'].notes.join()) && existsSync(join(local, 'Hash', 'bin', 'code')), 'a vendor rule whose tool is missing is held and deletes nothing');
        assert.equal(read(join(tmp, 'claude', 'makarasty', 'cleanup-log.jsonl')).trim().split('\n').length, 6, 'every outcome is logged');

        if (WIN) {
            const c2 = { ...ctx, volumes: [{ drive: tmp.slice(0, 2), maxMB: 1, nuke: 0 }], sid: 'S-1-selftest' };
            assert.match(recycleOne({ path: join(outside, 'keep.txt'), bytes: 5 * MB, links: 0 }, c2).why, /does not fit/);
            assert.match(recycleOne({ path: outside, bytes: 1, links: 1 }, c2).why, /holds a link/);
            process.env.OneDrive = outside;
            assert.match(recycleOne({ path: join(outside, 'keep.txt'), bytes: 1, links: 0 }, { ...c2, volumes: [{ ...c2.volumes[0], maxMB: 1e6 }] }).why, /OneDrive/, 'nothing inside OneDrive goes through the local bin');
            assert.match(recycleOne({ path: outside, bytes: 1, links: 0 }, { ...c2, volumes: [{ ...c2.volumes[0], nuke: 1 }] }).why, /off or unknown/);
        }
        console.log(`machine.mjs selftest done (${process.platform}, node ${process.version})`);
    } finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
        rmSync(tmp, { recursive: true, force: true });
    }
}

// ---- CLI ------------------------------------------------------------------------------------------------------

function main(argv) {
    if (argv[0] === '--selftest') return selftest();
    const take = (n, v) => { const i = argv.indexOf(n); if (i < 0) return undefined; const x = v ? argv[i + 1] : true; argv.splice(i, v ? 2 : 1); return x; };
    const json = take('--json'), extra = take('--rules', 1);
    const [cmd, ...ids] = argv;
    const say = (obj, lines) => console.log(json ? JSON.stringify(obj, null, 1) : lines().join('\n'));
    if (cmd === 'scan') { const s = evaluate(loadRules(extra), gather()); return say(s, () => show(s)); }
    if (cmd === 'apply' && ids.length) {
        const a = apply(ids, loadRules(extra));
        process.exitCode = a.rows.some(r => ['skipped', 'unchanged', 'error'].includes(r.outcome)) ? 1 : 0;
        return say(a, () => [...a.rows.map(r => `${r.outcome.padEnd(11)} ${r.id}  ${gb(Math.max(0, r.before - r.after))}${r.notes.length ? '  ' + r.notes.join('; ') : ''}`),
            `freed about ${gb(a.freed)}${a.toBin ? `, and ${gb(a.toBin)} went to the Recycle Bin (still on disk until it is emptied)` : ''}; free space ${Object.keys(a.free[0]).map(d => `${d} ${gb(a.free[0][d])} -> ${gb(a.free[1][d])}`).join(', ')}; log: ${join(state(), 'cleanup-log.jsonl')}`]);
    }
    if (cmd === 'admin' && ids.length) {
        const r = admin(ids, loadRules(extra));
        return say(r, () => [r.ids.length ? `wrote ${r.file} for ${r.ids.join(', ')}: right-click it, Run as administrator` : 'no admin item matched',
            ...r.held.map(h => `left out, held: ${h}`), ...(r.missing.length ? [`not admin items or not found: ${r.missing.join(', ')}`] : [])]);
    }
    console.error('usage: node machine.mjs scan | apply <id ...> | admin <id ...> | --selftest   [--json] [--rules <file>]');
    process.exitCode = 2;
}

// Real paths on both sides: a plugin cache reached through a junction or an 8.3 name must still run, not exit 0 silently.
const real = p => { try { return realpathSync.native(p).toLowerCase(); } catch { return resolve(p).toLowerCase(); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
    try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
