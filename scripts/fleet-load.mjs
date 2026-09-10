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

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(n); return i === -1 ? d : (args[i + 1] ?? true); };
const has = (n) => args.includes(n);

const sh = (cmd, a) => { try { return execFileSync(cmd, a, { encoding: 'utf8', maxBuffer: 32e6 }); } catch { return ''; } };
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
const HOSTS = /^(claude|Claude|electron|Code)(\.exe)?$/;
function classify(p) {
  const cmd = p.CommandLine || '';
  if (!HOSTS.test(p.Name || '')) {
    if (/vite|esbuild/.test(cmd)) return 'toolchain: vite';
    if (/tsc|vue-tsc/.test(cmd)) return 'toolchain: typecheck';
    if (/vitest|jest/.test(cmd)) return 'toolchain: tests';
    if (/firebase|emulator|java/.test(cmd)) return 'toolchain: emulator';
    if (/^node/.test(p.Name || '')) return 'node, other';
    return null;
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

// --clear N: say nothing, and exit 0 only when free memory is above N GB. This is what a worker refused
// for memory backgrounds, so the shell decides when it may claim again and no model has to poll.
if (has('--clear')) {
  const want = Number(flag('--clear', 4));
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
