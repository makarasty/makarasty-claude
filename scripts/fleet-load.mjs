#!/usr/bin/env node
// fleet-load.mjs - what the machine is actually carrying, and what a fleet costs on it.
//
// A fleet's sizing rules are all derived from numbers nobody re-measures: how much a session costs, how
// much a displayed browser pane costs, how much headroom is left. This prints those numbers, and with
// --watch it records them while a run is happening, so a claim about memory is a measurement rather than
// a memory of one.
//
//   node fleet-load.mjs                     one census, human readable
//   node fleet-load.mjs --json              the same, as one JSON object, `tight` included
//   node fleet-load.mjs --clear <GB>        exit 0 when free memory is above <GB>, 1 otherwise. Silent.
//   node fleet-load.mjs --leftovers [--kill]  toolchain processes whose parent is gone, and shells a closed
//                                           chat left running; --kill ends the idle orphaned test and typecheck
//                                           runs and those shells with everything under them, nothing else
//   node fleet-load.mjs --watch 30          sample every 30s until Ctrl-C
//   node fleet-load.mjs --watch 30 --out load.csv    ... and append each sample to a CSV
//
// Measured on the host this was written for, 2026-08-31: an agent session with no browser pane is about
// 330 MB resident; opening one pane on a local single page application adds one renderer process at
// 344 MB, and closing the tab returns all of it within seconds [M21].
//
// That last clause used to end "so on that box RAM is not what caps a fleet", and 2026-09-10 took it back
// [M34]: 344 MB is what a light page costs, and one tab holding 150,000 DOM nodes measured 2,061 MB. A
// reload returns none of it. So this file is no longer only a report - `fleet.sh next` refuses to hand out
// a task when `--clear` says the machine is under its floor, and the hook that refuses a full test suite
// asks it what is already running.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(n); return i === -1 ? d : (args[i + 1] ?? true); };
const has = (n) => args.includes(n);

const sh = (cmd, a) => { try { return execFileSync(cmd, a, { encoding: 'utf8', maxBuffer: 32e6, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// A census that throws is worse than one that is missing a column: every caller has a fallback, so the
// throw becomes a default nobody notices. Parse defensively and say what was lost.
function parse(text, fallback) {
  if (!text || !text.trim()) return fallback;
  // Strip the control characters JSON forbids inside a string, keeping the ones its grammar uses between
  // tokens. Doing it unconditionally costs one pass and removes a whole class of failure.
  const clean = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
  try { return JSON.parse(clean); } catch (e) {
    console.error(`fleet-load: could not read the process list (${e.message}); the numbers below count only what parsed`);
    return fallback;
  }
}

function windows() {
  const ps = (s) => sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', s]);
  const os = parse(ps(
    '$o=Get-CimInstance Win32_OperatingSystem; ' +
    '$pf=(Get-CimInstance Win32_PageFileUsage | Measure-Object CurrentUsage -Sum).Sum; ' +
    '@{freeKB=$o.FreePhysicalMemory;totalKB=$o.TotalVisibleMemorySize;' +
    'commitKB=($o.TotalVirtualMemorySize-$o.FreeVirtualMemory);limitKB=$o.TotalVirtualMemorySize;' +
    'pagedKB=($pf*1024)} | ConvertTo-Json -Compress'
  ), {});
  const procs = parse(ps(
    'Get-CimInstance Win32_Process | Select-Object Name,ProcessId,WorkingSetSize,CommandLine | ' +
    'ConvertTo-Json -Compress -Depth 3'
  ), []);
  return { os, procs };
}

function posix() {
  // Linux and macOS: enough for the same three questions, without pretending the fields are identical.
  const total = Number(sh('sh', ['-c', "sysctl -n hw.memsize 2>/dev/null || awk '/MemTotal/{print $2*1024}' /proc/meminfo"]).trim() || 0);
  const free = Number(sh('sh', ['-c', "awk '/MemAvailable/{print $2*1024}' /proc/meminfo 2>/dev/null || vm_stat | awk '/free/{gsub(/\\./,\"\",$3); print $3*4096; exit}'"]).trim() || 0);
  const ps = sh('sh', ['-c', 'ps -eo pid=,rss=,comm=,args= 2>/dev/null']);
  const procs = ps.split('\n').filter(Boolean).map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    return m ? { ProcessId: +m[1], WorkingSetSize: +m[2] * 1024, Name: m[3], CommandLine: m[4] } : null;
  }).filter(Boolean);
  return { os: { freeKB: free / 1024, totalKB: total / 1024, commitKB: null, limitKB: null }, procs };
}

// Which process is which. The agent host is the only one that needs classifying by argument: one OS
// process per session, one renderer per displayed browser pane, and the rest is the app's own scaffolding.
//
// A host can be installed under a renamed copy (`Claude-dev2.exe` on the box this was measured on), so the
// name is a prefix. Toolchains are read only off node processes and only as whole path segments: a
// Chromium renderer's command line carries feature strings like "Android emulator is disabled", and
// `--tsconfig` is not `tsc` - either one used to put a 600 MB pane or a dev server into the wrong row, and a
// phantom typecheck row makes the memory hook refuse a full run on a machine with room for it.
const HOSTS = /^(claude[\w-]*|electron|code)(\.exe)?$/i;
const seg = (names) => new RegExp(`(^|[\\\\/\\s"'])(${names})(\\.(c|m)?js|\\.cmd)?(?=[\\\\/\\s"']|$)`);
const VITE = seg('vite|esbuild'), TSC = seg('tsc|vue-tsc'), TESTS = seg('vitest|jest|jest-worker'), EMU = /firebase|emulators?:/;
function classify(p) {
  const cmd = p.CommandLine || '';
  const name = p.Name || '';
  if (!HOSTS.test(name)) {
    if (/^esbuild(\.exe)?$/i.test(name)) return 'toolchain: vite';
    if (/^(java|javaw|qemu[\w-]*|emulator[\w-]*)(\.exe)?$/i.test(name)) return 'toolchain: emulator';
    if (!/^node(\.exe)?$/i.test(name)) return null;
    if (VITE.test(cmd)) return 'toolchain: vite';
    // A language server or a watcher is resident, not a run: `tsc --lsp` sat under the typecheck row on
    // the box this was measured on and would have refused every full run for as long as the editor was open.
    if ((TSC.test(cmd) || TESTS.test(cmd)) && /["\s]--(lsp|watch\w*)\b(?!["=]?false)/.test(cmd)) return 'toolchain: resident';
    if (TSC.test(cmd)) return 'toolchain: typecheck';
    if (TESTS.test(cmd)) return 'toolchain: tests';
    if (EMU.test(cmd)) return 'toolchain: emulator';
    return 'node, other';
  }
  const t = cmd.match(/--type=([a-zA-Z-]+)/);
  if (!t) return 'agent session';           // no --type: one per chat session
  if (t[1] === 'renderer') return 'browser pane or window';
  if (t[1] === 'gpu-process') return 'app: gpu';
  return 'app: ' + t[1];
}

function census() {
  const { os, procs } = process.platform === 'win32' ? windows() : posix();
  const groups = {};
  for (const p of Array.isArray(procs) ? procs : [procs]) {
    const k = classify(p);
    if (!k) continue;
    groups[k] = groups[k] || { n: 0, bytes: 0, max: 0 };
    groups[k].n++; groups[k].bytes += p.WorkingSetSize || 0;
    groups[k].max = Math.max(groups[k].max, p.WorkingSetSize || 0);
  }
  return {
    when: new Date().toISOString(),
    totalGB: round((os.totalKB || 0) / 1048576),
    freeGB: round((os.freeKB || 0) / 1048576),
    commitGB: os.commitKB == null ? null : round(os.commitKB / 1048576),
    commitLimitGB: os.limitKB == null ? null : round(os.limitKB / 1048576),
    pagedGB: os.pagedKB == null ? null : round(os.pagedKB / 1048576),
    sessions: groups['agent session']?.n || 0,
    panes: groups['browser pane or window']?.n || 0,
    // Commit above physical is ordinary on Windows and says nothing on its own: it counts reserved address
    // space, most of which is never touched. What decides whether the next worker is paged from disk is
    // free physical memory, with page file usage as the corroborating reading.
    //
    // The two thresholds are deliberately different. Refusing below 2 GB and releasing only above 4 is
    // hysteresis, and without it every worker held on one reading claims again on the next, all at once,
    // on the same 2.1 GB - which is the moment the machine dies rather than the moment it recovers.
    tight: (os.freeKB || 0) / 1048576 < 2
      || (os.pagedKB != null && os.pagedKB / 1048576 > 4 && (os.freeKB || 0) / 1048576 < 4),
    clearGB: 4,
    groups: Object.fromEntries(Object.entries(groups)
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .map(([k, v]) => [k, { n: v.n, totalMB: Math.round(v.bytes / 1048576), maxMB: Math.round(v.max / 1048576) }])),
  };
}

function render(c) {
  const tight = c.tight;
  const lines = [
    `machine   ${c.totalGB} GB physical, ${c.freeGB} GB free` +
      (c.commitGB != null ? `, commit ${c.commitGB} GB of ${c.commitLimitGB} GB` : '') +
      (c.pagedGB != null ? `, page file ${c.pagedGB} GB` : ''),
    tight ? '  WARNING: memory is tight - the next worker is likely paged from disk, and every speed'
          + '\n  number still in flight is measuring a paging machine rather than the application.' : '',
    `fleet     ${c.sessions} agent sessions, ${c.panes} renderer processes (windows plus displayed panes)`,
    '',
    'class                        n   total MB   largest MB',
  ].filter(Boolean);
  for (const [k, v] of Object.entries(c.groups)) {
    lines.push(`${k.padEnd(28)}${String(v.n).padStart(2)}   ${String(v.totalMB).padStart(8)}   ${String(v.maxMB).padStart(10)}`);
  }
  return lines.join('\n');
}

// --leftovers [--kill]: toolchain processes nobody is waiting for, machine-wide. A test run or a typecheck
// whose parent is gone - the chat or shell that started it closed - holds its memory until it ends, and a
// hung one never ends: on 2026-10-06 a build run's box ran out of memory with such runs behind it, and
// nothing said whose they were. An orphan here is a process whose parent no longer exists (on POSIX: was
// reparented to 1), or whose parent pid now belongs to a process younger than it (pid reuse on Windows). A
// process with a live parent is somebody's and is never listed. --kill ends only an orphaned one-shot run
// (tests, typecheck) at least two minutes old whose whole tree used no CPU over a five-second second look:
// a run somebody detached on purpose (`start /b`, nohup) is still working and is left alone, and so is
// every orphaned dev server, watcher or emulator, since a launcher that exits at once (a .vbs) orphans the
// operator's own services.
function snapshot() {
  // A test hands in its own process table, so the listing is checked without touching a real process.
  if (process.env.FLEET_PROCS_JSON) return JSON.parse(fs.readFileSync(process.env.FLEET_PROCS_JSON, 'utf8'));
  if (process.platform === 'win32') {
    const out = sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object Name,ProcessId,ParentProcessId,WorkingSetSize,CommandLine,' +
      '@{n="Cpu";e={[int64]($_.UserModeTime + $_.KernelModeTime)}},' +
      '@{n="Created";e={[int64](($_.CreationDate.ToUniversalTime()) - [datetime]"1970-01-01").TotalMilliseconds}} | ' +
      'ConvertTo-Json -Compress -Depth 3']);
    const procs = parse(out, []);
    return Array.isArray(procs) ? procs : [procs];
  }
  const now = Date.now();
  const secs = (t) => t.split(/[-:]/).map(Number).reverse().reduce((s, v, i) => s + v * [1, 60, 3600, 86400][i], 0);
  return sh('sh', ['-c', 'ps -eo pid=,ppid=,etimes=,rss=,time=,comm=,args= 2>/dev/null']).split('\n').filter(Boolean).map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    return m ? { ProcessId: +m[1], ParentProcessId: +m[2], Created: now - m[3] * 1000, WorkingSetSize: +m[4] * 1024, Cpu: secs(m[5]), Name: m[6].split('/').pop(), CommandLine: m[7] } : null;
  }).filter(Boolean);
}

// A shell a Claude Code chat started carries the chat's shell snapshot or its temp folder in its command
// line. Once that chat has closed, the shell and everything under it - a wake loop, `python -m http.server`,
// a `find` over the disk, a dev server - belongs to nobody: 2026-10-08, a closed chat's wake loop had run
// for seven hours and another's http.server for five, and the toolchain rule above saw neither.
const SHELLS = /^(bash|sh|zsh|cmd|powershell|pwsh)(\.exe)?$/i;
const CHAT_SHELL = /[\\/]\.claude[\\/]shell-snapshots[\\/]snapshot-|__claudeCodeScrip|[\\/]Temp[\\/]claude[\\/][^\\/]+[\\/][0-9a-f]{8}-[0-9a-f-]{27}[\\/]/i;
// The chats alive now: Claude Code keeps one `sessions/<pid>.json` per running session and removes it when
// the session ends. One whose pid is no longer in the snapshot crashed, and does not count as alive.
function liveSessions(byPid) {
  const dir = (process.env.CLAUDE_CONFIG_DIR || (process.env.HOME || process.env.USERPROFILE || '') + '/.claude') + '/sessions';
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return null; }
  const ids = [];
  for (const f of names) {
    try { const s = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')); if (s.sessionId && byPid.has(s.pid)) ids.push({ id: s.sessionId, pid: s.pid, started: s.startedAt || 0 }); } catch { /* a file being rewritten */ }
  }
  return ids;
}

// Pids holding a listening TCP socket: a tree that holds one is serving something, whatever its command
// line says (`npm run dev` names no port; nodemon and `tsx watch` hide the server a level down). Asked only
// when a chat shell is about to be listed, since it costs one PowerShell call (0.56 s measured).
function listeningPids() {
  if (process.env.FLEET_LISTEN_PIDS != null) return new Set(process.env.FLEET_LISTEN_PIDS.split(',').filter(Boolean).map(Number));
  let out = '';
  if (process.platform === 'win32') {
    out = sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique']);
    return new Set(out.split(/\s+/).filter(Boolean).map(Number));
  }
  out = sh('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fp']);
  if (out) return new Set(out.split('\n').filter((l) => l.startsWith('p')).map((l) => Number(l.slice(1))));
  out = sh('ss', ['-ltnpH']);
  return new Set([...out.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])));
}

function leftovers(procs) {
  const byPid = new Map(procs.map((p) => [p.ProcessId, p]));
  const live = liveSessions(byPid);
  let listening = null;
  // A Bash tool shell names its chat's shell snapshot, `snapshot-bash-<ms>-<rand>.sh`, which the chat's process
  // writes at its first Bash call (1-2 s before that call's own line in the transcript, 2026-10-08), so a
  // detached `cmd &` whose parent link Git Bash broke still says whose it is. The snapshot each live session
  // uses is read off the shells it has running now: after an app restart every chat starts within the same
  // minute or two, and a time test alone also covered the shells of chats that did not come back
  // (2026-10-08: four hidden that way). The time test is the fallback for a live session with no shell now.
  const SNAP = /snapshot-[a-z]+-(\d{12,14})-[a-z0-9]+\.sh/i;
  const liveSnaps = new Set(); const snapKnown = new Set();
  if (live) for (const s of live) for (const q of procs) {
    // A child is younger than its parent: an older process naming this pid as parent had a parent that died
    // and whose pid the live chat reused.
    const sp = byPid.get(s.pid);
    if (q.ParentProcessId !== s.pid || (q.Created && sp && sp.Created && q.Created < sp.Created)) continue;
    const m = (q.CommandLine || '').match(SNAP);
    if (m) { liveSnaps.add(m[0]); snapKnown.add(s.id); }
  }
  const ownedByLive = (cmd) => {
    if (live.some((s) => cmd.includes(s.id))) return true;
    const m = cmd.match(SNAP);
    if (!m) return false;
    if (liveSnaps.has(m[0])) return true;
    // A process writes its snapshot at its first Bash call, which can be hours after it started, and never
    // before. So for a live session with no shell running now, any snapshot from after its start is its own:
    // at worst an ended chat's shell is missed, never a live chat's ended.
    return live.some((s) => !snapKnown.has(s.id) && s.started && +m[1] >= s.started - 5000);
  };
  const keep = (process.env.FLEET_KEEP_PORTS || '').split(',').filter((p) => /^\d+$/.test(p));
  const servesKept = (all) => keep.length > 0 && all.some((q) => new RegExp(`(:|--port[ =]|\\s)(${keep.join('|')})\\b`).test(q.CommandLine || ''));
  const orphan = (p) => {
    if (process.platform !== 'win32') return p.ParentProcessId === 1;
    const parent = byPid.get(p.ParentProcessId);
    return !parent || (parent.Created && p.Created && parent.Created > p.Created);
  };
  // A child is created after its parent: a pid reused by an older process is not one, and without this
  // check a reused pid made the walk loop for ever.
  const kids = (p) => procs.filter((q) => q.ParentProcessId === p.ProcessId && q.ProcessId !== p.ProcessId
    && (!q.Created || !p.Created || q.Created >= p.Created));
  const tree = (p, seen = new Set()) => {
    if (seen.has(p.ProcessId)) return [];
    seen.add(p.ProcessId);
    return [p, ...kids(p).flatMap((q) => tree(q, seen))];
  };
  const found = [];
  for (const p of procs) {
    const cmd = p.CommandLine || '';
    const mins = p.Created ? Math.round((Date.now() - p.Created) / 60000) : null;
    // Ten minutes, and only with the live sessions known: Git Bash breaks the parent link of a live chat's
    // own background scripts, so an unknown session list must not turn them into leftovers.
    if (live && SHELLS.test(p.Name || '') && orphan(p) && CHAT_SHELL.test(cmd) && mins != null && mins >= 10
      && !ownedByLive(cmd)) {
      const all = tree(p);
      if (servesKept(all)) continue;
      // A dev server, an emulator or an http.server under it may be what the operator is looking at: listed,
      // never ended unasked (2026-10-08: a closed chat's http.server still served the run's mockups).
      if (!listening) listening = listeningPids();
      const serves = all.some((q) => { const k = classify(q); return listening.has(q.ProcessId) || k === 'toolchain: vite' || k === 'toolchain: emulator'
        || /http\.server|\bserve\b|--port[ =]\d|\b(npm|pnpm|yarn|bun)(\.cmd)?\b.*\brun\s+(dev|start|serve|preview|watch)\b|nodemon|tsx\s+watch|--watch\b|react-scripts\s+start|\b(next|astro|nuxt|remix)\s+dev\b|webpack-dev-server|\bvite\b/i.test(q.CommandLine || ''); });
      const what = all.slice(1).map((q) => (q.Name || '').replace(/\.exe$/i, '')).filter((n) => !/^(bash|sh|conhost)$/i.test(n));
      found.push({ pid: p.ProcessId, class: 'shell whose chat process ended' + (what.length ? ': ' + [...new Set(what)].join(', ') : ''),
        mb: Math.round(all.reduce((s, q) => s + (q.WorkingSetSize || 0), 0) / 1048576), minutes: mins, oneShot: false, chatShell: !serves, serves,
        cmd: (cmd.match(/\.fleet[\\/][\w.-]+/) || [''])[0] || cmd.slice(0, 160),
        tree: all.map((q) => ({ pid: q.ProcessId, created: q.Created, cpu: q.Cpu })) });
      continue;
    }
    const k = classify(p);
    if (!k || !k.startsWith('toolchain:') || !orphan(p)) continue;
    const all = tree(p);
    found.push({ pid: p.ProcessId, class: k, mb: Math.round(all.reduce((s, q) => s + (q.WorkingSetSize || 0), 0) / 1048576),
      minutes: mins, oneShot: k === 'toolchain: tests' || k === 'toolchain: typecheck', cmd: (p.CommandLine || p.Name || '').slice(0, 160),
      tree: all.map((q) => ({ pid: q.ProcessId, created: q.Created, cpu: q.Cpu })) });
  }
  return found.sort((a, b) => b.mb - a.mb);
}

if (has('--leftovers')) {
  const found = leftovers(snapshot());
  const kill = has('--kill');
  if (!found.length) { console.log('no orphaned toolchain process and no shell left by an ended chat process on this machine'); process.exit(0); }
  // The second look: a tree whose CPU time moved is still running for somebody.
  let later = null;
  if (kill && found.some((f) => f.oneShot && f.minutes >= 2)) {
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},5000)']);
    later = new Map(snapshot().map((p) => [p.ProcessId, p]));
  }
  const idle = (f) => later && f.tree.every((t) => { const q = later.get(t.pid); return !q || (q.Created === t.created && q.Cpu === t.cpu); });
  let freed = 0;
  for (const f of found) {
    const candidate = f.chatShell || (f.oneShot && f.minutes != null && f.minutes >= 2);
    let tag = f.chatShell ? 'CLOSED CHAT' : f.serves ? 'CLOSED CHAT SERVING, left alone (ask the operator)' : !candidate ? 'orphaned, left alone (may be the operator\'s service)' : 'ORPHANED RUN';
    // --pid a,b: end only the pids the operator chose, whatever else is listed.
    const only = String(flag('--pid', '') || '').split(',').filter(Boolean).map(Number);
    if (kill && only.length && !only.includes(f.pid)) { console.log(`not chosen  pid ${f.pid}  ${f.class}`); continue; }
    if (kill && candidate) {
      // A closed chat's shell is ended busy or not: nobody reads what it does.
      if (!f.chatShell && !idle(f)) tag = 'ORPHANED RUN, still using CPU: left alone';
      else {
        // The pids this walk checked, children first; never taskkill /T, which walks pids without the
        // creation-time check above.
        // A parent shell often exits by itself once its child is gone, so "not found" is a success too.
        const gone = (pid) => !sh('tasklist', ['/FI', `PID eq ${pid}`, '/NH']).includes(` ${pid} `);
        const ok = f.tree.slice().reverse().every((t) => process.platform === 'win32'
          ? sh('taskkill', ['/PID', String(t.pid), '/F']) !== '' || gone(t.pid)
          : (() => { try { process.kill(t.pid, 'SIGTERM'); return true; } catch (e) { return e.code === 'ESRCH'; } })());
        tag = ok ? 'KILLED' : 'KILL FAILED';
        if (ok) freed += f.mb;
      }
    }
    // A serving tree is ended by hand, children first: give its pids in that order.
    const order = f.serves ? `  pids leaves first: ${f.tree.slice().reverse().map((t) => t.pid).join(' ')}` : '';
    console.log(`${tag}  pid ${f.pid}  ${f.class}  ${f.mb} MB  ${f.minutes ?? '?'} min  ${f.cmd}${order}`);
  }
  if (kill) console.log(`freed about ${freed} MB`);
  else if (found.some((f) => f.oneShot || f.chatShell)) console.log('--kill ends ORPHANED RUN lines (one-shot runs at least two minutes old whose tree used no CPU over five seconds) and CLOSED CHAT lines, each with everything under it');
  process.exit(0);
}

// --clear N: say nothing, and exit 0 only when free memory is above N GB. This is what a worker refused
// for memory backgrounds, so the shell decides when it may claim again and no model has to poll.
if (has('--clear')) {
  const want = Number(flag('--clear', 4));
  // Free memory above the line needs no census: it cannot call the box tight there, and the census is the
  // 0.8 s every `next` paid (measured 2026-10-08). os.freemem() read within 0.3 GB of the census.
  if (os.freemem() / 2 ** 30 > want) process.exit(0);
  const c = census();
  process.exit(c.freeGB > want ? 0 : 1);
}

const interval = Number(flag('--watch', 0));
const out = flag('--out', null);

if (!interval) {
  const c = census();
  console.log(has('--json') ? JSON.stringify(c) : render(c));
} else {
  if (out && !fs.existsSync(out)) fs.writeFileSync(out, 'when,totalGB,freeGB,commitGB,sessions,panes\n');
  console.error(`sampling every ${interval}s${out ? ` into ${out}` : ''}, Ctrl-C to stop`);
  const tick = () => {
    const c = census();
    const row = `${c.when},${c.totalGB},${c.freeGB},${c.commitGB},${c.sessions},${c.panes}`;
    if (out) fs.appendFileSync(out, row + '\n');
    console.log(has('--json') ? JSON.stringify(c) : row);
  };
  tick();
  setInterval(tick, interval * 1000);
}
