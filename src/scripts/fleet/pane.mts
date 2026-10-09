// pane.mts - the pane broker: pane-ask, pane-next, pane-serve, pane-status. Part of fleet.mjs; see src/scripts/fleet.mts.

import { existsSync, mkdirSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command, Ctx } from './lib.mjs';
import { need, out, err, isDir, read, names, field, now, cal, mtimeMs } from './lib.mjs';

// `cat` of stdin: every byte, however the pipe hands them over.
function stdin(): Buffer {
  const parts: Buffer[] = [];
  const b = Buffer.alloc(65536);
  for (;;) {
    let n: number;
    try { n = readSync(0, b, 0, b.length, null); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN') continue;
      if (code === 'EOF') break;
      throw e;
    }
    if (n === 0) break;
    parts.push(Buffer.from(b.subarray(0, n)));
  }
  return Buffer.concat(parts);
}

// `grep -q "host $host\$"`: the host is a basic regular expression, unanchored at the start.
// ponytail: `.`, `*` and bracket expressions only; GNU's `\(` `\{` `\|` and [:classes:] read as literals.
function ownerMatches(text: string, host: string): boolean {
  const p = `host ${host}`;
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i] ?? '';
    if (ch === '\\' && i + 1 < p.length) { re += `\\${p[++i] ?? ''}`.replace(/^\\([A-Za-z0-9])$/, '$1'); continue; }
    if (ch === '.' || ch === '*') { re += ch; continue; }
    if (ch === '[') {
      let j = i + 1;
      if (p[j] === '^') j++;
      if (p[j] === ']') j++;
      while (j < p.length && p[j] !== ']') j++;
      if (j < p.length) { re += p.slice(i, j + 1).replace(/\\/g, '\\\\'); i = j; continue; }
      return false;   // an unclosed bracket: grep refuses the pattern, which reads as no match
    }
    re += ch.replace(/[$^+?(){}|/\]]/g, '\\$&');
  }
  let r: RegExp;
  try { r = new RegExp(`${re}$`, 's'); } catch { return false; }
  return text.split('\n').some((l) => r.test(l));
}

function paneDirs(run: string): void {
  for (const d of ['requests', 'results', 'running']) mkdirSync(`${run}/pane/${d}`, { recursive: true });
}

// A browser walk, filed as a file, for whichever session is holding a pane. The requester does not need
// a pane, does not wait, and claims a repo task while the answer is being produced.
function paneAsk(c: Ctx, chip: string): number {
  const run = c.run;
  paneDirs(run);
  let n = 1;
  while (existsSync(`${run}/pane/requests/${chip}-${n}.md`) || existsSync(`${run}/pane/results/${chip}-${n}.json`)) n++;
  writeFileSync(`${run}/pane/requests/${chip}-${n}.md`, stdin());
  out(`FILED ${c.absrun}/pane/requests/${chip}-${n}.md\n`);
  out(`READ  ${c.absrun}/pane/results/${chip}-${n}.json at your next task boundary\n`);
  return 0;
}

function paneNext(c: Ctx, host: string): number {
  const run = c.run;
  paneDirs(run);
  // Oldest first by the time it was filed. The glob's order is lexical, which put `07-10` before `07-2`
  // and every walk of chip 02 before any of chip 07, whatever waited longest.
  let order = '';
  try {
    const d = `${run}/pane/requests`;
    const r = readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => [statSync(join(d, f)).mtimeMs, f.slice(0, -3)] as const);
    r.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
    order = r.map((x) => x[1]).join(' ');
  } catch { order = ''; }
  if (!order) {
    for (const f of names(`${run}/pane/requests`)) if (f.endsWith('.md')) order += ` ${f.slice(0, -3)}`;
  }
  // ponytail: `for id in $order` also glob-expands each id; a walk id is <chip>-<n>, never a pattern.
  for (const id of order.split(/[ \t\n]+/).filter(Boolean)) {
    const f = `${run}/pane/requests/${id}.md`;
    if (!existsSync(f)) continue;
    if (existsSync(`${run}/pane/results/${id}.json`)) continue;
    try { mkdirSync(`${run}/pane/running/${id}`); } catch { continue; }   // mkdir is the claim's atomicity
    writeFileSync(`${run}/pane/running/${id}/owner`, `host ${host}\nclaimed ${now()}\n`);
    out(`WALK ${id}\n---\n`);
    // A `cat` that fails ends the script with 1 and leaves the claim standing.
    let body: Buffer;
    try { body = readFileSync(f); } catch (e) {
      err(`cat: ${f}: ${(e as NodeJS.ErrnoException).code === 'EISDIR' ? 'Is a directory' : 'Permission denied'}\n`);
      return 1;
    }
    out(body);
    return 0;
  }
  out('NO WALKS PENDING\n');
  return 3;
}

interface WalkResult { gate?: unknown; conditions?: unknown; observations?: unknown; served_at?: string; host?: string; claimed_at?: string }

function paneServe(c: Ctx, host: string, id: string): number {
  const run = c.run;
  if (!isDir(`${run}/pane/running/${id}`)) { err(`no claimed walk ${id}\n`); return 2; }
  const owner = `${run}/pane/running/${id}/owner`;
  if (!existsSync(owner) || !ownerMatches(read(owner), host)) { err(`WALK LOST ${id}\n`); return 4; }
  const gateMin = cal(c, 'frame_gate_min_fps', '60');
  const claimedAt = field(read(owner), /^claimed ([^\n]*)/);
  const input = stdin().toString('utf8');
  const res = `${run}/pane/results/${id}.json`;
  if (!isDir(`${run}/pane/results`)) { err(`${c.sh}: ${res}: No such file or directory\n`); return 1; }
  let o: WalkResult;
  try { o = JSON.parse(input) as WalkResult; } catch (e) {
    err(`REFUSED: not one JSON object: ${(e as Error).message}\n`);
    rmSync(res, { force: true });
    return 1;
  }
  const p: string[] = [];
  // The requester never saw the pane, so the result has to carry the proof the pane was real. This is
  // the one thing a session driving its own pane could never check about itself.
  const floor = Number(gateMin || 60);
  try {
    if (typeof o.gate !== 'number') p.push('gate: the frame count this walk was measured under, as a number');
    else if (o.gate < floor) p.push(`gate reads ${o.gate}, which is blind below ${floor}: do not serve a blind walk`);
    if (!o.conditions || !/\d/.test(String(o.conditions))) p.push('conditions naming viewport and zoom');
    if (!Array.isArray(o.observations)) p.push('observations: an array, empty is a real answer');
  } catch (e) {
    // `null` parses and then has no fields: the shell's node dies here with a stack trace.
    err(`${String(e)}\n`);
    rmSync(res, { force: true });
    return 1;
  }
  if (p.length) { err(`REFUSED: ${p.join('; ')}\n`); rmSync(res, { force: true }); return 1; }
  o.served_at = new Date().toISOString(); o.host = host;
  // The claim time travels into the result because the claim directory is about to be deleted, and
  // without it nobody can say afterwards how long a walk actually took.
  if (claimedAt) o.claimed_at = claimedAt;
  writeFileSync(res, `${JSON.stringify(o)}\n`);
  rmSync(`${run}/pane/running/${id}`, { recursive: true, force: true });
  out(`SERVED ${id} -> ${res}\n`);
  return 0;
}

function paneStatus(c: Ctx): number {
  const run = c.run;
  if (!isDir(`${run}/pane/requests`)) { out('no pane broker in this run\n'); return 0; }
  let pend = 0, oldest = 0;
  const nowsec = Math.floor(Date.now() / 1000);
  for (const n of names(`${run}/pane/requests`)) {
    if (!n.endsWith('.md') || !existsSync(`${run}/pane/requests/${n}`)) continue;
    if (existsSync(`${run}/pane/results/${n.slice(0, -3)}.json`)) continue;
    pend++;
    const m = mtimeMs(`${run}/pane/requests/${n}`);
    const t = Number.isNaN(m) ? nowsec : Math.floor(m / 1000);
    const age = Math.trunc((nowsec - t) / 60);
    if (age > oldest) oldest = age;
  }
  // ponytail: `ls results/*.json | wc -l` counts the names; a directory named *.json would list its contents.
  const served = names(`${run}/pane/results`).filter((n) => n.endsWith('.json')).length;
  let median = '';
  const d = `${run}/pane/results`;
  const mins: number[] = [];
  try {
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.json')) continue;
      const o = JSON.parse(readFileSync(join(d, f), 'utf8')) as { claimed_at?: string; served_at?: string };
      if (o.claimed_at && o.served_at) {
        const m = (Date.parse(o.served_at) - Date.parse(o.claimed_at)) / 60000;
        if (Number.isFinite(m) && m >= 0) mins.push(m);
      }
    }
  } catch { /* what was read so far stands, as it did */ }
  if (mins.length) { mins.sort((a, b) => a - b); median = String(Math.round(mins[Math.floor(mins.length / 2)] ?? 0)); }
  out(`pane walks: ${pend} pending, oldest waiting ${oldest}m, ${served} served${median ? `, median lease ${median}m` : ''}\n`);
  // One host is enough until a walk waits longer than a walk takes. Falls back to a flat twenty minutes
  // only while no walk has been served yet and there is no lease to compare against.
  let behind = median;
  if (!behind) {
    behind = '20';
    if (pend > 0) out('  no walk has been served yet, so this compares against a flat 20 minutes\n');
  }
  if (pend > 0 && oldest > Number(behind)) {
    out('  the pane lane is behind: the oldest walk has waited longer than a lease takes. Offer one more host chip\n');
  }
  return 0;
}

export const commands: Record<string, Command> = {
  'pane-ask': (c, a) => paneAsk(c, need(c, a[0], 3, 'chip id required')),
  'pane-next': (c, a) => paneNext(c, need(c, a[0], 3, 'host chip id required')),
  'pane-serve': (c, a) => paneServe(c, need(c, a[0], 3, 'host chip id required'), need(c, a[1], 4, 'walk id required')),
  'pane-status': (c) => paneStatus(c),
};
