#!/usr/bin/env node
// tune.mjs - data for re-choosing the model and effort of each role. Reads this machine's transcripts and git;
// spends no model turns. Every command has a hard timeout (--timeout <s>) and the transcript scans hold one lock,
// so two heavy scans never run at once.
//
//   node tune.mjs usage   [--days 7 | --from YYYY-MM-DD --to YYYY-MM-DD]   step 1: where tokens and $ went
//   node tune.mjs quality [--days 30] [--coder <re>] [--reviewer <re>]      step 2: coder models judged by their reviews
//   node tune.mjs pick    [--n 10] [--days 60] [--repos a,b]                step 3a: blind review set, markers fixed first
//   node tune.mjs plan    <run> --arms opus:high,opus:medium,sonnet:high [--judge opus:high] [--whole 0]
//   node tune.mjs cost    <run>                                             $ per benchmark subagent (tune-run=<id>)
//   node tune.mjs score   <run>                                             unseal and tabulate, objective columns first
//   node tune.mjs open    <repo> --since YYYY-MM-DD [--files a,b] [--grep word]   is a whole-task candidate still open
//   node tune.mjs clone   <repo> <sha> <dest>                               isolated clone for a whole-task arm
//   node tune.mjs diff    [new.md] [old.md]                                 role table against the previous run
//
// Output lands in ~/.claude/makarasty/tune/ (dated). Prices come from the PRICES table of the makarasty plugin's
// scripts/fleet-analyze.mjs, the one table; --prices <file.json> adds or overrides entries for a new model.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS = path.join(HOME, 'projects');
export const OUT_ROOT = process.env.TUNE_OUT || path.join(HOME, 'makarasty', 'tune');
const DAY = 864e5;

// ------------------------------------------------------------------------------------------------ args

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const positional = () => { const out = []; for (let i = 1; i < argv.length; i++) { if (argv[i].startsWith('--')) { i++; continue; } out.push(argv[i]); } return out; };
const today = () => new Date().toISOString().slice(0, 10);
function windowOf(defDays) {
  const from = flag('--from'), to = flag('--to');
  const t1 = to ? Date.parse(to) + DAY : Date.now();
  const t0 = from ? Date.parse(from) : t1 - Number(flag('--days', defDays)) * DAY;
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) die('bad --from/--to/--days');
  return { t0, t1 };
}
function die(msg, code = 2) { console.error(`tune: ${msg}`); process.exit(code); }

// ------------------------------------------------------------------------------------------------ guards

let lockHeld = false;
// Hard end of this run. Sync git calls cannot be interrupted by the timer, so each one gets at most the time left.
let HARD_END = Infinity, START = Date.now();
const LOCK = path.join(OUT_ROOT, 'scan.lock');
function guard(sec) {
  HARD_END = Date.now() + sec * 1000;
  const t = setTimeout(() => { console.error(`TIMED OUT tune ${argv[0]} after ${sec}s`); releaseLock(); process.exit(124); }, sec * 1000);
  t.unref();
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// A lock is stale when its scan is dead, or older than twice the scan's own time limit (a hard kill leaves the file and
// Windows reuses pids). Content is "pid start ttlMs", linked into place whole so a reader never sees it empty.
export function lockStale(txt, mtimeMs, now, isAlive = alive) {
  const [pid, start, ttl] = String(txt).trim().split(/\s+/).map(Number);
  if (!pid) return now - mtimeMs > 10000; // empty or garbage: a writer may be mid-write, so only an old one is stale
  if (now - (start || mtimeMs) > (ttl || 30 * 60000)) return true;
  return !isAlive(pid);
}
// Takes the lock file judged stale while its text was `txt`: renamed to a name of ours and read; if it is not what was judged,
// another scan linked its own lock in between, so it goes back (a link never overwrites) and nothing is stolen.
// shortcut: for that moment the owner's lock is missing; a third scan in that instant could take it.
export function stealLock(lock, txt) {
  const mine = `${lock}.${process.pid}.${Date.now()}.stale`;
  try { fs.renameSync(lock, mine); } catch (e) { if (e.code === 'ENOENT') return true; throw e; }
  let same = false;
  try { same = fs.readFileSync(mine, 'utf8') === txt; } catch {}
  if (!same) try { fs.linkSync(mine, lock); } catch {}
  fs.rmSync(mine, { force: true });
  return same;
}
function takeLock() {
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  const tmp = `${LOCK}.${process.pid}.tmp`;
  const ttl = HARD_END === Infinity ? 30 * 60000 : 2 * (HARD_END - Date.now());
  fs.writeFileSync(tmp, `${process.pid} ${Date.now()} ${Math.round(ttl)}`);
  try {
    for (let i = 0; i < 2; i++) {
      try { fs.linkSync(tmp, LOCK); lockHeld = true; process.on('exit', releaseLock); return; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let txt = '', m = 0;
        try { txt = fs.readFileSync(LOCK, 'utf8'); m = fs.statSync(LOCK).mtimeMs; } catch { continue; }
        if (!lockStale(txt, m, Date.now())) die(`another tune scan is running (pid ${Number(txt.trim().split(/\s+/)[0]) || '?'}); wait for it to finish`, 3);
        if (!stealLock(LOCK, txt)) die('another tune scan took the lock just now; wait for it to finish', 3); // stale lock of a dead or overdue scan
      }
    }
  } finally { fs.rmSync(tmp, { force: true }); }
  die('could not take the scan lock', 3);
}
function releaseLock() { if (lockHeld) { lockHeld = false; try { fs.rmSync(LOCK, { force: true }); } catch {} } }

const left = (ms) => Math.max(1000, Math.min(ms, HARD_END - Date.now()));
const git = (repo, args, timeout = 60000, encoding = 'utf8') =>
  execFileSync('git', ['-C', repo, ...args], { encoding, timeout: left(timeout), maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
// Soft end for loops that can stop with a partial result: 85% of the hard limit, the rest is for writing it out.
const softEnd = () => HARD_END === Infinity ? Infinity : START + (HARD_END - START) * 0.85;

// ------------------------------------------------------------------------------------------------ prices

export function parsePrices(src) {
  const start = src.indexOf('const PRICES');
  if (start < 0) return null;
  const block = src.slice(start, src.indexOf('\n};', start));
  const re = /'([\w.-]+)':\s*\{\s*in:\s*([\d.]+),\s*out:\s*([\d.]+),\s*cr:\s*([\d.]+),\s*w5m:\s*([\d.]+),\s*w1h:\s*([\d.]+)\s*\}/g;
  const p = {};
  for (const m of block.matchAll(re)) p[m[1]] = { in: +m[2], out: +m[3], cr: +m[4], w5m: +m[5], w1h: +m[6] };
  return Object.keys(p).length ? p : null;
}
const semverDesc = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((y[i] || 0) !== (x[i] || 0)) return (y[i] || 0) - (x[i] || 0); return 0; };
export function findAnalyze() {
  const c = [process.env.TUNE_FLEET_ANALYZE, path.resolve(SKILL_DIR, '../../../scripts/fleet-analyze.mjs')];
  const cache = path.join(HOME, 'plugins', 'cache', 'makarasty', 'makarasty');
  try { for (const v of fs.readdirSync(cache).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort(semverDesc)) c.push(path.join(cache, v, 'scripts', 'fleet-analyze.mjs')); } catch {}
  return c.find((f) => f && fs.existsSync(f));
}
export function loadPrices() {
  const src = findAnalyze();
  const prices = src ? parsePrices(fs.readFileSync(src, 'utf8')) ?? {} : {};
  const extra = flag('--prices');
  if (extra) Object.assign(prices, JSON.parse(fs.readFileSync(extra, 'utf8')));
  if (!Object.keys(prices).length) die('no price table: install the makarasty plugin or pass --prices <file.json>');
  return prices;
}
export function priceOf(prices, model) {
  let best = '';
  for (const k of Object.keys(prices)) if (model.startsWith(k) && k.length > best.length) best = k;
  return best ? prices[best] : null;
}
// null = unpriced model: shown with its tokens and listed, never priced as some other model.
export function costOf(prices, r) {
  const p = priceOf(prices, r.model);
  if (!p) return null;
  const usd = (r.in * p.in + r.out * p.out + r.cr * p.cr + r.c5 * p.w5m + r.c1 * p.w1h) / 1e6;
  return r.fast ? usd * 2 : usd; // fast mode is listed at twice the standard rate
}

// ------------------------------------------------------------------------------------------------ transcripts

function* jsonlFiles(dir, sinceMs) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'tool-results') yield* jsonlFiles(p, sinceMs); }
    else if (e.name.endsWith('.jsonl')) { try { if (fs.statSync(p).mtimeMs >= sinceMs) yield p; } catch {} }
  }
}
async function* records(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const l of rl) {
    if (!l || !(l.includes('"type":"assistant"') || l.includes('"type":"user"'))) continue;
    try { yield JSON.parse(l); } catch {}
  }
}
const isSubFile = (f) => f.split(path.sep).includes('subagents');
const readMeta = (f) => { try { return JSON.parse(fs.readFileSync(f.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { return {}; } };
export function usageOf(o) {
  const m = o.message;
  if (o.type !== 'assistant' || !m?.usage || !m.model || m.model === '<synthetic>') return null;
  const u = m.usage, cc = u.cache_creation ?? {};
  const c1 = cc.ephemeral_1h_input_tokens ?? 0;
  const c5 = cc.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - c1);
  return { key: `${m.id || o.uuid}|${o.requestId || ''}`, model: m.model, in: u.input_tokens || 0, out: u.output_tokens || 0,
    cr: u.cache_read_input_tokens || 0, c5, c1, fast: u.speed === 'fast', ts: Date.parse(o.timestamp) };
}
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
const short = (m) => m.replace(/^claude-/, '');
const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);
export const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const usd = (x) => x == null ? 'n/a' : `$${x.toFixed(2)}`;
const mtok = (x) => `${(x / 1e6).toFixed(1)}M`;
const group = (arr, fn) => { const g = new Map(); for (const r of arr) { const k = fn(r); if (!g.has(k)) g.set(k, []); g.get(k).push(r); } return g; };
function writeOut(name, data) {
  const dir = path.join(OUT_ROOT, today());
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1));
  return f;
}

// ------------------------------------------------------------------------------------------------ step 1: usage

async function cmdUsage() {
  takeLock();
  const prices = loadPrices();
  const { t0, t1 } = windowOf(7);
  const recs = new Map();
  let files = 0;
  for (const f of jsonlFiles(PROJECTS, t0)) {
    files++;
    const project = path.relative(PROJECTS, f).split(path.sep)[0];
    const sub = isSubFile(f);
    const meta = sub ? readMeta(f) : {};
    for await (const o of records(f)) {
      const r = usageOf(o);
      if (!r || !(r.ts >= t0 && r.ts < t1)) continue;
      const old = recs.get(r.key);
      if (old) { old.out = Math.max(old.out, r.out); continue; }
      r.side = sub || o.isSidechain === true;
      r.project = project; r.sid = o.sessionId; r.agent = sub ? f : o.sessionId;
      r.effort = (sub ? meta.effort : o.effort) || o.effort || 'default';
      r.role = r.side ? (meta.agentType || 'subagent') : 'main';
      recs.set(r.key, r);
    }
  }
  const all = [...recs.values()];
  const unpriced = new Set();
  for (const r of all) { r.usd = costOf(prices, r); if (r.usd == null) unpriced.add(r.model); r.ctx = r.in + r.cr + r.c5 + r.c1; }
  const tot = sum(all, (r) => r.usd);
  const byUsd = (a, b) => sum(b[1], (r) => r.usd) - sum(a[1], (r) => r.usd);
  const L = [`tune usage ${new Date(t0).toISOString().slice(0, 10)}..${new Date(t1 - 1).toISOString().slice(0, 10)}: ${files} files, ${all.length} calls, ${usd(tot)} API-equivalent`];
  if (unpriced.size) L.push(`UNPRICED (tokens shown, $ missing; add to PRICES in fleet-analyze or --prices): ${[...unpriced].join(', ')}`);
  L.push('', 'model | in | write 5m | write 1h | cache read | out | $ | share');
  for (const [m, a] of [...group(all, (r) => r.model)].sort(byUsd))
    L.push(`${short(m)} | ${mtok(sum(a, (r) => r.in))} | ${mtok(sum(a, (r) => r.c5))} | ${mtok(sum(a, (r) => r.c1))} | ${mtok(sum(a, (r) => r.cr))} | ${mtok(sum(a, (r) => r.out))} | ${usd(sum(a, (r) => r.usd))} | ${(sum(a, (r) => r.usd) / (tot || 1) * 100).toFixed(1)}%`);
  L.push('', 'role | model | effort | calls | sessions or agents | $ | median $ per session or agent');
  const roles = [...group(all, (r) => `${r.role}|${short(r.model)}|${r.effort}`)].sort(byUsd);
  for (const [k, a] of roles.slice(0, 30)) {
    const per = [...group(a, (r) => r.agent).values()];
    L.push(`${k.replace(/\|/g, ' | ')} | ${a.length} | ${per.length} | ${usd(sum(a, (r) => r.usd))} | ${usd(median(per.map((p) => sum(p, (r) => r.usd))))}`);
  }
  L.push('', 'main vs subagent: $');
  L.push(`main ${usd(sum(all.filter((r) => !r.side), (r) => r.usd))} | subagent ${usd(sum(all.filter((r) => r.side), (r) => r.usd))}`);
  L.push('', 'project (top 10) | $ | share');
  for (const [p, a] of [...group(all, (r) => r.project)].sort(byUsd).slice(0, 10)) L.push(`${p.slice(-50)} | ${usd(sum(a, (r) => r.usd))} | ${(sum(a, (r) => r.usd) / (tot || 1) * 100).toFixed(1)}%`);
  L.push('', 'main-call context | calls | $ | share');
  const main = all.filter((r) => !r.side);
  for (const [lo, hi, n] of [[0, 1e5, '<100k'], [1e5, 2e5, '100-200k'], [2e5, 4e5, '200-400k'], [4e5, 7e5, '400-700k'], [7e5, Infinity, '>700k']]) {
    const a = main.filter((r) => r.ctx >= lo && r.ctx < hi);
    L.push(`${n} | ${a.length} | ${usd(sum(a, (r) => r.usd))} | ${(sum(a, (r) => r.usd) / (tot || 1) * 100).toFixed(1)}%`);
  }
  L.push('', 'day | $ | main $');
  const day = (r) => new Date(r.ts).toISOString().slice(0, 10);
  for (const [d, a] of [...group(all, day)].sort()) L.push(`${d} | ${usd(sum(a, (r) => r.usd))} | ${usd(sum(a.filter((r) => !r.side), (r) => r.usd))}`);
  const text = L.join('\n');
  console.log(text);
  console.log(`\nwritten: ${writeOut('usage.md', text)}`);
}

// ------------------------------------------------------------------------------------------------ step 2: quality

export const keyOf = (d) => {
  if (!d) return null;
  const m = d.match(/\btask-([0-9a-z]+)/i) || d.match(/\b(t\d+[a-z]?)\b/i) || d.match(/\b(w\d+-p\d+)\b/i) || d.match(/\b(p\d+[a-z]?)\b/i);
  return m ? m[1].toLowerCase().replace(/(\d)[a-z]$/, '$1') : null;
};
// A review's verdict from its final text: findings counted as numbered or file:line bullets.
export function verdict(t) {
  if (!t) return { n: 0, pass: false };
  const none = /\b(no defects|found no defects|nothing found|no findings|0 defects|zero defects)\b/i.test(t.slice(0, 800));
  let n = 0;
  for (const l of t.split('\n')) if (/^\s*(\d+[.)]\s|[-*]\s+[`*]*[\w./:-]+\.[a-z]+:\d+|[-*]\s+\*\*)/.test(l)) n++;
  const pass = none || (/(verdict:?\s*\**\s*(pass|accept)|^\W*(pass|accept))/i.test(t.slice(0, 300)) && n <= 3);
  return { n: none ? 0 : n, pass };
}
export const normPath = (p) => p.replace(/\\/g, '/').split('/').filter(Boolean).slice(-3).join('/');
// Owner pushback in a main chat; an objective-ish signal that the model there got something wrong.
export const CORRECTION_RE = /не то(?![а-яё])|ты уверен|перепровер|неправильн|опять|не так(?![а-яё])|\bwrong\b|\bincorrect\b|are you sure/iu;
const SYS_RE = /^<(system-reminder|command-|local-command|task-notification|user-prompt-submit)|^\[Request interrupted|^Caveat:/;

async function slimFile(f, prices) {
  const sub = isSubFile(f);
  const rec = { f, sub, meta: sub ? readMeta(f) : {}, msgs: new Map(), spawns: [], efiles: new Set(), pfiles: [], users: [], final: '', cwd: '', sid: '', first: 0, last: 0 };
  let firstUser = true;
  for await (const o of records(f)) {
    const ts = Date.parse(o.timestamp);
    if (ts) { if (!rec.first) rec.first = ts; rec.last = ts; }
    if (!rec.sid && o.sessionId) rec.sid = o.sessionId;
    if (!rec.cwd && o.cwd) rec.cwd = o.cwd;
    if (o.type === 'assistant') {
      const u = usageOf(o);
      if (u) { const old = rec.msgs.get(u.key); if (old) old.out = Math.max(old.out, u.out); else rec.msgs.set(u.key, { ...u, effort: o.effort }); }
      for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
        if (b.type === 'text' && b.text) rec.final = b.text;
        if (b.type !== 'tool_use') continue;
        const i = b.input || {};
        if (b.name === 'SubagentHandback') rec.final = i.message || '';
        if (/^(Edit|Write|NotebookEdit)$/.test(b.name) && i.file_path) rec.efiles.add(normPath(i.file_path));
        if (b.name === 'Agent' || b.name === 'Task') rec.spawns.push({ ts, id: b.id, type: i.subagent_type || '', desc: i.description || '' });
      }
    } else if (o.type === 'user' && o.message && !o.isMeta) {
      const c = o.message.content;
      if (Array.isArray(c) && c.some((b) => b.type === 'tool_result')) continue;
      const t = textOf(c);
      if (firstUser && t) { firstUser = false; rec.pfiles = [...new Set((t.match(/[\w@.-]*(?:[\\/][\w@.[\]-]+)+\.[a-z]{1,5}\b/gi) || []).map(normPath))].slice(0, 200); }
      if (!sub && t && !SYS_RE.test(t.trim())) rec.users.push(t.slice(0, 300));
    }
  }
  const ms = [...rec.msgs.values()];
  const byModel = group(ms, (m) => m.model);
  rec.model = [...byModel].sort((a, b) => b[1].length - a[1].length)[0]?.[0] || '';
  rec.cost = sum(ms, (m) => costOf(prices, m));
  rec.turns = ms.length;
  rec.effort = (sub ? rec.meta.effort : null) || dominant(ms.map((m) => m.effort || 'default')) || 'default';
  rec.dominance = ms.length ? ms.filter((m) => m.model === rec.model).length / ms.length : 0;
  rec.final = rec.final.slice(0, 5000);
  delete rec.msgs;
  return rec;
}
const dominant = (a) => [...group(a, (x) => x)].sort((x, y) => y[1].length - x[1].length)[0]?.[0];
const inter = (a, b) => { const s = new Set(a); let c = 0; for (const x of b) if (s.has(x)) c++; return c; };

// Coder runs grouped into tasks, each task's reviews attached: same task key in the description, or edited-file overlap.
export function linkTasks(events) {
  const tasks = [];
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    if (e.kind === 'C') {
      let best = null, bs = 0;
      for (const t of tasks) {
        if (!t.reviews.length || t.reviews.at(-1).ts > e.ts) continue; // a fix round follows a review
        const ov = inter(e.efiles, t.efiles);
        const sc = (e.key && t.key === e.key ? 100 : 0) + ov * 3 + Math.min(inter(e.pfiles, t.efiles), 5);
        if (sc > bs && (sc >= 100 || ov >= 2 || (e.efiles.length && ov / e.efiles.length >= 0.5))) { bs = sc; best = t; }
      }
      if (best) { best.coders.push(e); e.efiles.forEach((x) => best.efiles.add(x)); }
      else tasks.push({ key: e.key, coders: [e], reviews: [], efiles: new Set(e.efiles) });
    } else {
      let best = null, bs = 0;
      for (const t of tasks) {
        if (t.coders.at(-1).ts > e.ts) continue;
        const sc = (e.key && t.key === e.key ? 100 : 0) + inter(e.pfiles, t.efiles) * 2;
        if (sc > bs) { bs = sc; best = t; }
      }
      if (best && bs >= 2) best.reviews.push(e);
    }
  }
  return tasks;
}

async function cmdQuality() {
  takeLock();
  const prices = loadPrices();
  const { t0 } = windowOf(30);
  const coderRe = new RegExp(flag('--coder', 'coder'), 'i'), reviewerRe = new RegExp(flag('--reviewer', 'review'), 'i');
  const mains = [], byTool = new Map();
  for (const f of jsonlFiles(PROJECTS, t0)) {
    const r = await slimFile(f, prices);
    if (r.sub) { if (r.meta.toolUseId) byTool.set(r.meta.toolUseId, r); }
    else mains.push(r);
  }
  const reviewed = [];
  const allTasks = [];
  for (const mn of mains) {
    const ev = [];
    for (const s of mn.spawns) {
      const sub = byTool.get(s.id);
      if (!sub) continue;
      const kind = coderRe.test(s.type) ? 'C' : reviewerRe.test(s.type) ? 'R' : null;
      if (kind) ev.push({ kind, ts: s.ts, key: keyOf(s.desc), desc: s.desc, efiles: [...sub.efiles], pfiles: sub.pfiles, sub });
    }
    for (const t of linkTasks(ev)) {
      allTasks.push({ cwd: mn.cwd, efiles: [...t.efiles], first: t.coders[0].ts, last: (t.reviews.at(-1) ?? t.coders.at(-1)).ts, nR: t.reviews.length, nC: t.coders.length, desc: t.coders[0].desc });
      if (!t.reviews.length) continue;
      const c0 = t.coders[0].sub, v = verdict(t.reviews[0].sub.final);
      reviewed.push({ arm: `${short(c0.model)}|${c0.effort}`, rev: `${short(t.reviews[0].sub.model)}|${t.reviews[0].sub.effort}`, n: v.n, fix: !v.pass,
        rounds: t.reviews.length, usd: sum(t.coders, (c) => c.sub.cost) + sum(t.reviews, (r) => r.sub.cost), files: c0.efiles.size });
    }
  }
  const L = [`tune quality, last ${flag('--days', 30)} days: ${mains.length} main chats, ${byTool.size} subagents, ${reviewed.length} reviewed coder tasks`];
  L.push('', 'coder model|effort | first reviewer | tasks | findings in first review (mean ± se) | fix needed | review rounds (mean) | median $ per task | median files');
  for (const [k, a] of [...group(reviewed, (r) => `${r.arm} | ${r.rev}`)].sort((x, y) => y[1].length - x[1].length)) {
    const ns = a.map((r) => r.n), mean = sum(ns, (x) => x) / ns.length;
    const se = ns.length > 1 ? Math.sqrt(sum(ns, (x) => (x - mean) ** 2) / (ns.length - 1) / ns.length) : 0;
    L.push(`${k} | ${a.length} | ${mean.toFixed(1)} ± ${se.toFixed(1)} | ${Math.round(a.filter((r) => r.fix).length / a.length * 100)}% | ${(sum(a, (r) => r.rounds) / a.length).toFixed(2)} | ${usd(median(a.map((r) => r.usd)))} | ${median(a.map((r) => r.files))}`);
  }
  L.push('', 'subagent role | model | effort | runs | median $ | median turns');
  const subs = [...byTool.values()];
  const roleRows = [];
  for (const [k, a] of [...group(subs, (s) => `${s.meta.agentType || 'subagent'}|${short(s.model)}|${s.effort}`)].sort((x, y) => y[1].length - x[1].length)) {
    roleRows.push({ key: k, n: a.length, medianUsd: median(a.map((s) => s.cost)) });
    L.push(`${k.replace(/\|/g, ' | ')} | ${a.length} | ${usd(median(a.map((s) => s.cost)))} | ${median(a.map((s) => s.turns))}`);
  }
  L.push('', 'main chat model | effort | chats | owner messages | corrections per 100 messages (chats with >=50 turns, one model+effort on >=80% of them)');
  const longMains = mains.filter((m) => m.turns >= 50 && m.dominance >= 0.8 && m.users.length >= 3);
  for (const [k, a] of group(longMains, (m) => `${short(m.model)} | ${m.effort}`)) {
    const msgs = sum(a, (m) => m.users.length), corr = sum(a, (m) => m.users.filter((u) => CORRECTION_RE.test(u)).length);
    L.push(`${k} | ${a.length} | ${msgs} | ${(corr / Math.max(1, msgs) * 100).toFixed(1)}`);
  }
  L.push('', 'Bias check: compare median files per task between arms; a model given the mechanical tasks looks better than it is.');
  const text = L.join('\n');
  console.log(text);
  writeOut('quality.json', { roleRows, tasks: allTasks.filter((t) => t.nR >= 2), repos: [...new Set(mains.map((m) => m.cwd).filter(Boolean))] });
  console.log(`\nwritten: ${writeOut('quality.md', text)}`);
}

// ------------------------------------------------------------------------------------------------ step 3a: pick

const FIX_RE = /\b(fix(e[sd])?|bug|hotfix|regression|broke|crash)\b|исправ|почин|баг/iu;
// Prose and data files: a later edit there is rarely a bug fix, so blame skips them.
const PROSE_RE = /\.(md|mdx|txt|rst|json|ya?ml|toml|csv|svg|png|jpe?g|gif|sha256)$/i;
const NOISE_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|composer\.lock)$|\.min\.|(^|\/)(dist|build|vendor|node_modules)\//;

// Old-side ranges each hunk of a `git diff -U0` changed or deleted: the lines whose origin `git blame` can name.
export function parseU0(diff) {
  const out = [];
  let file = null;
  for (const l of diff.split('\n')) {
    if (l.startsWith('--- ')) file = l === '--- /dev/null' ? null : l.slice(4).replace(/^a\//, '');
    const m = file && l.match(/^@@ -(\d+)(?:,(\d+))? \+/);
    if (m) { const count = m[2] === undefined ? 1 : +m[2]; if (count > 0) out.push({ file, start: +m[1], count }); }
  }
  return out;
}
export function parseLog(text) {
  const commits = [];
  let c = null;
  for (const l of text.split('\n')) {
    if (l.startsWith('@@')) {
      const [sha, parents, ct, ...subj] = l.slice(2).split('\t');
      c = { sha, parent: parents.split(' ')[0] || '', ts: +ct * 1000, subject: subj.join('\t'), files: [], size: 0 };
      commits.push(c);
    } else if (c && /^\d+\t\d+\t/.test(l)) {
      const [a, d, ...p] = l.split('\t'); const file = p.join('\t');
      if (!NOISE_RE.test(file)) { c.files.push(file); c.size += +a + +d; }
    }
  }
  return commits;
}
export function rng(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353), h = (h << 13) | (h >>> 19);
  return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
}
// Quotas fixed before any result: 40% later-fixed, 30% multi-round, the rest controls; a short category is filled from the others.
export function selectCandidates(cands, n, rand) {
  const shuffle = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const pools = { fix: shuffle(cands.filter((c) => c.category === 'fix')), multi: shuffle(cands.filter((c) => c.category === 'multi')), control: shuffle(cands.filter((c) => c.category === 'control')) };
  const want = { fix: Math.ceil(n * 0.4), multi: Math.ceil(n * 0.3) };
  want.control = Math.max(0, n - want.fix - want.multi);
  const picked = [];
  for (const k of ['fix', 'multi', 'control']) picked.push(...pools[k].splice(0, want[k]));
  for (const k of ['fix', 'multi', 'control']) while (picked.length < n && pools[k].length) picked.push(pools[k].shift());
  return shuffle(picked).slice(0, n).map((c, i) => ({ ...c, id: String(i + 1).padStart(2, '0') }));
}

function candidatesOf(repo, days, min, max, multiTasks, note) {
  const commits = parseLog(git(repo, ['log', '--no-merges', `--since=${days} days ago`, '--format=@@%H%x09%P%x09%ct%x09%s', '--numstat'], 120000));
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const known = new Map();
  // Later-fixed: a fix commit's changed lines blame back to an earlier commit of the window.
  for (const fx of commits.filter((c) => FIX_RE.test(c.subject) && c.parent).slice(0, 150)) {
    if (Date.now() > softEnd()) { note.push(`${path.basename(repo)}: blame scan cut at the time limit; some later-fixed commits count as controls`); break; }
    let hunks = [];
    try { hunks = parseU0(git(repo, ['diff', '-U0', '--no-color', fx.parent, fx.sha, '--', ...fx.files.slice(0, 40)])); } catch { continue; }
    for (const h of hunks.filter((x) => !PROSE_RE.test(x.file)).slice(0, 20)) {
      let out = '';
      try { out = git(repo, ['blame', '-l', '-s', '-L', `${h.start},+${h.count}`, fx.parent, '--', h.file], 20000); } catch { continue; }
      for (const sha of new Set((out.match(/^\^?[0-9a-f]{40}/gm) || []).map((s) => s.replace('^', '')))) {
        if (sha !== fx.sha && bySha.has(sha) && !known.has(sha)) known.set(sha, { file_line: `${h.file}:${h.start}`, fix_sha: fx.sha, fix_subject: fx.subject });
      }
    }
  }
  // Reverted commits count as later-fixed too.
  for (const m of git(repo, ['log', `--since=${days} days ago`, '--grep=This reverts commit', '--format=%H %b']).matchAll(/^([0-9a-f]{40}) [\s\S]*?This reverts commit ([0-9a-f]{40})/gm))
    if (bySha.has(m[2]) && !known.has(m[2])) known.set(m[2], { file_line: '(whole commit)', fix_sha: m[1], fix_subject: 'reverted' });
  const multi = new Set();
  for (const t of multiTasks) {
    const files = new Set(t.efiles);
    let best = null, bo = 0;
    for (const c of commits) if (c.ts >= t.first - 36e5 && c.ts <= t.last + DAY) { const ov = inter(c.files.map(normPath), files); if (ov > bo) { bo = ov; best = c; } }
    if (best) multi.add(best.sha);
  }
  return commits.filter((c) => c.parent && c.size >= min && c.size <= max).map((c) => ({
    repo, sha: c.sha, parent: c.parent, files: c.files, size: c.size, subject: c.subject,
    category: known.has(c.sha) ? 'fix' : multi.has(c.sha) ? 'multi' : 'control', known_bug: known.get(c.sha) ?? null }));
}
const topLevel = (dir) => { try { return path.resolve(git(dir, ['rev-parse', '--show-toplevel'], 10000).trim()); } catch { return null; } };

function render(tpl, vars) { return fs.readFileSync(path.join(SKILL_DIR, tpl), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`); }

async function cmdPick() {
  const n = Number(flag('--n', 10)), days = Number(flag('--days', 60));
  const qf = path.join(OUT_ROOT, today(), 'quality.json');
  const q = fs.existsSync(qf) ? JSON.parse(fs.readFileSync(qf, 'utf8')) : { tasks: [], repos: [] };
  if (!fs.existsSync(qf)) console.error('tune: no quality.json for today; multi-round markers skipped (run `quality` first)');
  const repoList = flag('--repos') ? flag('--repos').split(',') : q.repos;
  const repos = [...new Set(repoList.map(topLevel).filter(Boolean))];
  if (!repos.length) die('no git repos: pass --repos a,b or run `quality` first');
  const cands = [];
  const note = [];
  for (const r of repos) {
    if (Date.now() > softEnd()) { note.push(`time limit: repos not scanned: ${repos.slice(repos.indexOf(r)).map((x) => path.basename(x)).join(', ')}`); break; }
    const tasks = q.tasks.filter((t) => t.cwd && topLevel(t.cwd) === r);
    try { cands.push(...candidatesOf(r, days, Number(flag('--min', 30)), Number(flag('--max', 600)), tasks, note)); }
    catch (e) { console.error(`tune: skipped ${r}: ${e.message.split('\n')[0]}`); }
  }
  const run = `bench-${today()}`;
  const seed = flag('--seed', run);
  const picked = selectCandidates(cands, n, rng(seed));
  const dir = path.join(OUT_ROOT, run, 'review');
  if (fs.existsSync(path.join(dir, 'sealed'))) die(`${dir} exists; move it away or pass --seed and a fresh day`);
  fs.mkdirSync(path.join(dir, 'sealed'), { recursive: true });
  const blind = path.join(OUT_ROOT, run, 'blind');
  for (const c of picked) {
    const diff = git(c.repo, ['diff', '--no-color', c.parent, c.sha, '--', ...c.files]);
    const body = git(c.repo, ['log', '-1', '--format=%B', c.sha]).trim();
    // Judges get the repo and sha to check findings; reviewers get only the change and a snapshot, so they cannot see the later fix.
    fs.writeFileSync(path.join(dir, `${c.id}.diff`), diff);
    fs.writeFileSync(path.join(dir, `${c.id}.json`), JSON.stringify({ id: c.id, repo: c.repo, sha: c.sha, parent: c.parent, changed_lines: c.size, files: c.files.length, task: body }, null, 1));
    const b = path.join(blind, c.id);
    fs.mkdirSync(b, { recursive: true });
    fs.writeFileSync(path.join(b, 'change.diff'), diff);
    const tree = snapshot(c.repo, c.sha, c.files, path.join(b, 'tree'));
    fs.writeFileSync(path.join(b, 'change.json'), JSON.stringify({ id: c.id, changed_lines: c.size, files: c.files, tree, task: body }, null, 1));
  }
  fs.writeFileSync(path.join(dir, 'sealed', 'answers.json'), JSON.stringify({ seed, note, rule: 'quotas 40% later-fixed (blame of a later fix, or reverted), 30% multi-round review, rest controls; size within --min..--max changed lines, lockfiles and build output not counted',
    items: picked.map((c) => ({ id: c.id, repo: path.basename(c.repo), sha: c.sha, category: c.category, changed_lines: c.size, known_bug: c.known_bug })) }, null, 1));
  fs.writeFileSync(path.join(dir, 'judge-task.md'), render('judge-task.md', { DIR: dir, BLIND: blind }));
  const cat = group(picked, (c) => c.category);
  console.log(`picked ${picked.length} of ${cands.length} candidates from ${repos.length} repos: fix ${cat.get('fix')?.length || 0}, multi ${cat.get('multi')?.length || 0}, control ${cat.get('control')?.length || 0}`);
  for (const n of note) console.log(`PARTIAL: ${n}`);
  console.log(`run: ${path.join(OUT_ROOT, run)}  (categories are sealed in review/sealed/answers.json; do not read it before scoring)`);
}

// Files of the touched directories at the commit, written out with `git show`: enough context to review without the live repo.
// shortcut: capped at 300 files / 8 MB, then only the touched files; raise the caps if reviewers report missing context.
function snapshot(repo, sha, files, out) {
  const dirs = [...new Set(files.map((f) => path.posix.dirname(f)))];
  let list = dirs.includes('.') ? files : git(repo, ['ls-tree', '-r', '-l', sha, '--', ...dirs]).split('\n').filter(Boolean).map((l) => {
    const m = l.match(/^\S+ blob \S+\s+(\d+)\t(.+)$/); return m && { size: +m[1], path: m[2] };
  }).filter((x) => x && !NOISE_RE.test(x.path));
  let kind = 'touched directories';
  if (dirs.includes('.') || list.length > 300 || sum(list, (x) => x.size) > 8e6) { list = files.map((p) => ({ path: p })); kind = 'touched files only'; }
  for (const { path: p } of list) {
    let buf;
    try { buf = git(repo, ['show', `${sha}:${p}`], 20000, 'buffer'); } catch { continue; } // deleted by the commit
    fs.mkdirSync(path.join(out, path.dirname(p)), { recursive: true });
    fs.writeFileSync(path.join(out, p), buf);
  }
  return `${kind}, ${list.length} files, at the commit`;
}

// ------------------------------------------------------------------------------------------------ step 3b: plan, cost, score

// Arms that differ in model AND effort with no arm between them confound the two.
export function checkArms(arms) {
  const warn = [];
  for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) {
    const [a, b] = [arms[i], arms[j]];
    if (a.model === b.model || a.effort === b.effort) continue;
    const bridged = arms.some((c) => (c.model === a.model && c.effort === b.effort) || (c.model === b.model && c.effort === a.effort));
    if (!bridged) warn.push(`${a.model}:${a.effort} vs ${b.model}:${b.effort} differ in model and effort; add ${a.model}:${b.effort} or ${b.model}:${a.effort} to separate them`);
  }
  return warn;
}
export const parseArms = (s) => s.split(',').filter(Boolean).map((x) => { const [model, effort = 'default'] = x.split(':'); return { model, effort }; });
const FALLBACK_TOKENS = { in: 0, out: 8000, cr: 1e6, c5: 40000, c1: 0 }; // rough review-sized run when history has none

// A price-table key for an arm name: the exact id, else the newest key containing it (highest version numbers).
export function resolveModel(prices, name) {
  if (prices[name]) return name;
  const ver = (k) => (k.match(/\d+/g) || []).map(Number);
  const cmp = (a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((y[i] ?? -1) !== (x[i] ?? -1)) return (y[i] ?? -1) - (x[i] ?? -1); return 0; };
  return Object.keys(prices).filter((k) => k.includes(name)).sort(cmp)[0] ?? null;
}
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function estimate(prices, roleRows, rolePat, arm) {
  const model = resolveModel(prices, arm.model);
  const same = model ? new RegExp(`^${escRe(short(model))}(-\\d{8})?$`) : null; // a dated id counts as its model
  const hit = same ? roleRows.filter((r) => { const [role, m, e] = r.key.split('|'); return rolePat.test(role) && same.test(m) && e === arm.effort && r.n >= 3; }) : [];
  if (hit.length) return { usd: median(hit.map((r) => r.medianUsd)), from: `history ${short(model)}, ${sum(hit, (r) => r.n)} runs` };
  const c = model ? costOf(prices, { ...FALLBACK_TOKENS, model }) : null;
  return { usd: c, from: c == null ? 'UNPRICED' : `rough default for ${short(model)}, no history` };
}
// The cost table shown before consent. `unpriced` non-empty = the total is incomplete and must not be offered.
export function planEstimate(prices, roleRows, arms, judge, nDiffs, whole) {
  const lines = ['arm | per review | reviews $ | per whole task | whole $ | estimate from'];
  const unpriced = [];
  let total = 0;
  for (const a of arms) {
    const er = estimate(prices, roleRows, /review/i, a), ew = estimate(prices, roleRows, /coder/i, a);
    if (er.usd == null || (whole && ew.usd == null)) unpriced.push(`${a.model}:${a.effort}`);
    const rv = (er.usd ?? 0) * nDiffs, wh = (ew.usd ?? 0) * whole * 3; // a whole task runs about three review-sized coder rounds
    total += rv + wh;
    lines.push(`${a.model}:${a.effort} | ${usd(er.usd)} | ${usd(rv)} | ${whole ? usd((ew.usd ?? 0) * 3) : '-'} | ${whole ? usd(wh) : '-'} | ${er.from}`);
  }
  const ej = estimate(prices, roleRows, /review/i, judge);
  if (ej.usd == null) unpriced.push(`judge ${judge.model}:${judge.effort}`);
  const judges = (ej.usd ?? 0) * (nDiffs * arms.length / 3 + whole); // a judge sees about three reviewers' output per review-sized run
  total += judges;
  lines.push(`judges | ${usd(judges)}`);
  return { lines, total, unpriced };
}
// Codes per arm, written once per run: a second plan would reshuffle them and score would credit the wrong arm.
// forceNew moves the old map and the reviewer folders into old-<time>/ first, so nothing is scored against the new map.
export function sealMap(run, arms, forceNew, seed = `${run}|${Date.now()}`) {
  const mapFile = path.join(run, 'review', 'sealed', 'map.json');
  if (fs.existsSync(mapFile)) {
    if (!forceNew) throw new Error(`${mapFile} exists: this run is planned already. A new plan voids its reviews; pass --force-new-run to start over`);
    const old = path.join(run, `old-${Date.now()}`);
    fs.mkdirSync(old, { recursive: true });
    fs.renameSync(mapFile, path.join(old, 'map.json'));
    const blind = path.join(run, 'blind');
    for (const d of fs.existsSync(blind) ? fs.readdirSync(blind) : []) if (/-[A-Z]$/.test(d)) fs.renameSync(path.join(blind, d), path.join(old, d));
    const judge = path.join(run, 'review', 'judge');
    if (fs.existsSync(judge)) fs.renameSync(judge, path.join(old, 'judge'));
  }
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ'.split('');
  const r = rng(seed);
  for (let i = letters.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [letters[i], letters[j]] = [letters[j], letters[i]]; }
  const map = Object.fromEntries(arms.map((a, i) => [letters[i], a]));
  fs.mkdirSync(path.dirname(mapFile), { recursive: true });
  fs.writeFileSync(mapFile, JSON.stringify(map, null, 1), { flag: 'wx' });
  return map;
}

async function cmdPlan() {
  const [run] = positional();
  if (!run) die('plan <run dir>');
  const dir = path.resolve(run);
  const arms = parseArms(flag('--arms', ''));
  if (arms.length < 2) die('--arms needs two or more model:effort pairs');
  const judge = parseArms(flag('--judge', 'opus:high'))[0];
  const whole = Number(flag('--whole', 0));
  const prices = loadPrices();
  const qf = [...fs.readdirSync(OUT_ROOT)].filter((d) => /^\d{4}-\d\d-\d\d$/.test(d) && fs.existsSync(path.join(OUT_ROOT, d, 'quality.json'))).sort().at(-1);
  const roleRows = qf ? JSON.parse(fs.readFileSync(path.join(OUT_ROOT, qf, 'quality.json'), 'utf8')).roleRows : [];
  const ids = fs.readdirSync(path.join(dir, 'review')).filter((f) => /^\d+\.diff$/.test(f)).map((f) => f.slice(0, -5));
  const runId = path.basename(dir);
  const est = planEstimate(prices, roleRows, arms, judge, ids.length, whole);
  const L = [`plan ${runId}: ${ids.length} diffs x ${arms.length} arms${whole ? `, ${whole} whole tasks x ${arms.length} arms` : ''}, judge ${judge.model}:${judge.effort}`];
  for (const w of checkArms(arms)) L.push(`CONFOUND: ${w}`);
  L.push('', ...est.lines);
  if (est.unpriced.length) {
    console.log(L.join('\n'));
    die(`UNPRICED: ${est.unpriced.join(', ')}. The total would leave them out, so it is no consent figure; pass --prices <file.json> and plan again`, 4);
  }
  L.push(`TOTAL estimate ${usd(est.total)} API-equivalent (history medians; effort changes the spread, treat as +-50%)`);
  let map;
  try { map = sealMap(dir, arms, argv.includes('--force-new-run')); } catch (e) { die(e.message, 5); }
  // One folder per reviewer with only its inputs: no sealed answers, no other arm's output inside it.
  const blind = path.join(dir, 'blind');
  const prompts = [];
  for (const id of ids) for (const code of Object.keys(map)) {
    const d = path.join(blind, `${id}-${code}`);
    fs.cpSync(path.join(blind, id), d, { recursive: true });
    fs.writeFileSync(path.join(d, 'review-task.md'), render('review-task.md', { DIR: d }));
    prompts.push(d);
  }
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ runId, arms: arms.length, codes: Object.keys(map), judge, whole, nDiffs: ids.length, estimate: +est.total.toFixed(2), created: Date.now() }, null, 1));
  console.log(L.join('\n'));
  console.log(`\nreviewer prompt (one per folder blind/<NN>-<CODE>): Follow <folder>/review-task.md. tune-run=${runId} NN=<NN>, CODE=<CODE>`);
  console.log(`judge prompt: Follow ${path.join(dir, 'review', 'judge-task.md')} for diffs <NN list>. tune-run=${runId} JUDGE=<j1..>`);
  console.log(`codes per arm are in review/sealed/map.json; read it only to spawn reviewers, never pass it to a judge`);
}

async function cmdCost() {
  const [run] = positional();
  if (!run) die('cost <run dir>');
  const dir = path.resolve(run);
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  takeLock();
  const prices = loadPrices();
  const rows = [];
  for (const f of jsonlFiles(PROJECTS, plan.created - DAY)) {
    if (!isSubFile(f)) continue;
    let first = null;
    const msgs = new Map();
    for await (const o of records(f)) {
      if (first == null && o.type === 'user') { first = textOf(o.message?.content); if (!first.includes(`tune-run=${plan.runId}`)) break; }
      const u = usageOf(o);
      if (u) { const old = msgs.get(u.key); if (old) old.out = Math.max(old.out, u.out); else msgs.set(u.key, u); }
    }
    if (!first?.includes(`tune-run=${plan.runId}`)) continue;
    const m = first.match(/\b(NN|TASK)=([\w-]+),\s*CODE=([A-Z])/) || first.match(/\b(JUDGE)=([\w-]+)/);
    const ms = [...msgs.values()];
    rows.push({ kind: m?.[1] ?? '?', item: m?.[2] ?? '?', code: m?.[3] ?? '', model: short(ms[0]?.model ?? ''), calls: ms.length, usd: +sum(ms, (x) => costOf(prices, x)).toFixed(4) });
  }
  fs.writeFileSync(path.join(dir, 'cost.json'), JSON.stringify(rows, null, 1));
  for (const [k, a] of group(rows, (r) => `${r.kind} ${r.code}`)) console.log(`${k}: n=${a.length} total ${usd(sum(a, (r) => r.usd))}`);
}

const W = { high: 3, medium: 2, low: 1 };
// Per code: real findings (weighted), false, unsure and known bugs caught, from judge files and the sealed answers.
export function tally(judges, answers) {
  const t = {};
  const row = (c) => (t[c] ??= { real: 0, weighted: 0, false: 0, unsure: 0, known: 0, knownOf: 0 });
  const knownIds = new Set(answers.items.filter((i) => i.known_bug).map((i) => i.id));
  for (const [id, j] of Object.entries(judges)) {
    for (const d of j.defects ?? []) for (const c of d.found_by ?? []) {
      const r = row(c);
      if (d.real === 'REAL') { r.real++; r.weighted += W[d.severity] ?? 1; } else if (d.real === 'FALSE') r.false++; else r.unsure++;
    }
    if (knownIds.has(id)) for (const c of j.known_bug?.caught_by ?? []) row(c).known++;
  }
  for (const r of Object.values(t)) r.knownOf = knownIds.size;
  return t;
}

async function cmdScore() {
  const [run] = positional();
  if (!run) die('score <run dir>');
  const dir = path.resolve(run), rv = path.join(dir, 'review');
  const map = JSON.parse(fs.readFileSync(path.join(rv, 'sealed', 'map.json'), 'utf8'));
  const answers = JSON.parse(fs.readFileSync(path.join(rv, 'sealed', 'answers.json'), 'utf8'));
  const judges = {};
  for (const f of fs.existsSync(path.join(rv, 'judge')) ? fs.readdirSync(path.join(rv, 'judge')) : []) if (/^\d+\.json$/.test(f)) judges[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(rv, 'judge', f), 'utf8'));
  const cost = fs.existsSync(path.join(dir, 'cost.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'cost.json'), 'utf8')) : [];
  const t = tally(judges, answers);
  const L = [`score ${path.basename(dir)}: ${Object.keys(judges).length} judged diffs`, '', '| Arm | Known bugs caught | Real findings (weighted h3/m2/l1) | False | Unsure | $ reviews |', '|---|---|---|---|---|---|'];
  for (const [code, arm] of Object.entries(map)) {
    const r = t[code] ?? { real: 0, weighted: 0, false: 0, unsure: 0, known: 0 };
    L.push(`| ${arm.model}:${arm.effort} | ${r.known}/${answers.items.filter((i) => i.known_bug && judges[i.id]).length} | ${r.real} (${r.weighted}) | ${r.false} | ${r.unsure} | ${usd(sum(cost.filter((c) => c.kind === 'NN' && c.code === code), (c) => c.usd))} |`);
  }
  const wf = path.join(dir, 'whole', 'results.json');
  if (fs.existsSync(wf)) {
    const res = JSON.parse(fs.readFileSync(wf, 'utf8'));
    L.push('', '| Arm | Whole tasks | Tests pass | Judge score (mean /10) | $ |', '|---|---|---|---|---|');
    for (const [code, arm] of Object.entries(map)) {
      const a = res.filter((x) => x.code === code);
      L.push(`| ${arm.model}:${arm.effort} | ${a.length} | ${a.filter((x) => x.tests_pass).length} | ${a.length ? (sum(a, (x) => x.score) / a.length).toFixed(1) : '-'} | ${usd(sum(cost.filter((c) => c.kind === 'TASK' && c.code === code), (c) => c.usd))} |`);
    }
  }
  const per = answers.items.map((i) => `${i.id} ${i.category}${i.known_bug ? ` known ${i.known_bug.file_line}` : ''}: caught by ${(judges[i.id]?.known_bug?.caught_by ?? []).map((c) => map[c] ? `${map[c].model}:${map[c].effort}` : c).join(', ') || '-'}`);
  const jc = cost.filter((c) => c.kind === 'JUDGE');
  L.push('', `judges: ${jc.length} runs, ${usd(sum(jc, (c) => c.usd))}${cost.length ? '' : ' (no cost.json: run `cost` first)'}`, '', ...per);
  const text = L.join('\n');
  fs.writeFileSync(path.join(dir, 'score.md'), text);
  console.log(text);
}

// ------------------------------------------------------------------------------------------------ helpers for whole-task arms

async function cmdOpen() {
  const [repo] = positional();
  const since = flag('--since');
  if (!repo || !since) die('open <repo> --since YYYY-MM-DD [--files a,b] [--grep word]');
  const files = flag('--files') ? flag('--files').split(',') : [];
  const touched = files.length ? git(repo, ['log', `--since=${since}`, '--format=%h %ad %s', '--date=short', '--', ...files]).trim() : '';
  const named = flag('--grep') ? git(repo, ['log', `--since=${since}`, '-i', `--grep=${flag('--grep')}`, '--format=%h %ad %s', '--date=short']).trim() : '';
  console.log(touched || named ? `MAYBE DONE: commits since ${since}\n${[touched, named].filter(Boolean).join('\n')}` : `OPEN: no commit since ${since} touches those files or names it`);
  console.log('Then run the task\'s reproduction at HEAD: a passing reproduction drops the task.');
}

// Why a clone destination is unsafe, or null. A junction or symlink on the way would put the clone (and a later
// cleanup of it) somewhere else; a destination inside the source repo would nest a clone in the owner's checkout.
export function cloneDestProblem(repoTop, dest) {
  const abs = path.resolve(dest), parent = path.dirname(abs);
  const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (fs.existsSync(abs)) return `exists: ${abs}`;
  if (!fs.existsSync(parent)) return `parent folder missing: ${parent}`;
  const real = fs.realpathSync.native(parent);
  if (!same(path.resolve(real), parent)) return `parent folder resolves elsewhere (junction or symlink): ${parent} -> ${real}`;
  const top = path.resolve(fs.realpathSync.native(repoTop));
  const rel = path.relative(top, abs);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return `inside the source repo ${top}`;
  return null;
}

async function cmdClone() {
  const [repo, sha, dest] = positional();
  if (!repo || !sha || !dest) die('clone <repo> <sha> <dest>');
  const top = topLevel(repo);
  if (!top) die(`not a git repo: ${repo}`);
  const problem = cloneDestProblem(top, dest);
  if (problem) die(problem);
  const abs = path.resolve(dest);
  execFileSync('git', ['-c', 'core.longpaths=true', 'clone', '-q', top, abs], { timeout: left(600000), stdio: 'inherit' });
  try {
    git(abs, ['remote', 'remove', 'origin']);
    git(abs, ['checkout', '-q', '-b', 'tune-bench', sha]);
  } catch (e) {
    // A half-made clone still has origin pointing at the owner's repo: remove it rather than leave it for an agent to push from.
    fs.rmSync(abs, { recursive: true, force: true });
    die(`clone set-up failed, ${abs} removed: ${e.message.split('\n')[0]}`);
  }
  console.log(`ready: ${abs} at ${sha.slice(0, 10)}, no remote`);
}

// ------------------------------------------------------------------------------------------------ diff of role tables

export function parseRoleTable(md) {
  const rows = new Map();
  for (const l of md.split('\n')) {
    const c = l.split('|').map((x) => x.trim());
    if (c.length < 5 || !c[1] || /^(-+|role)$/i.test(c[1])) continue;
    rows.set(c[1], { model: c[2], effort: c[3] });
  }
  return rows;
}
export function diffTables(a, b) {
  const out = [];
  for (const [role, r] of a) { const o = b.get(role); if (!o) out.push(`+ ${role}: ${r.model} ${r.effort}`); else if (o.model !== r.model || o.effort !== r.effort) out.push(`~ ${role}: ${o.model} ${o.effort} -> ${r.model} ${r.effort}`); }
  for (const [role, o] of b) if (!a.has(role)) out.push(`- ${role}: was ${o.model} ${o.effort}`);
  return out;
}

async function cmdDiff() {
  let [a, b] = positional();
  if (!a || !b) {
    const runs = fs.existsSync(OUT_ROOT) ? fs.readdirSync(OUT_ROOT).filter((f) => /^\d{4}-\d\d-\d\d\.md$/.test(f)).sort() : [];
    a ??= runs.at(-1) && path.join(OUT_ROOT, runs.at(-1));
    b ??= runs.at(-2) && path.join(OUT_ROOT, runs.at(-2));
  }
  if (!a) die(`no role table in ${OUT_ROOT} yet`);
  if (!b) { console.log(`first run: ${a}; nothing to compare`); return; }
  const d = diffTables(parseRoleTable(fs.readFileSync(a, 'utf8')), parseRoleTable(fs.readFileSync(b, 'utf8')));
  console.log(`${path.basename(b)} -> ${path.basename(a)}: ${d.length ? `\n${d.join('\n')}` : 'no change'}`);
}

// ------------------------------------------------------------------------------------------------ main

const CMDS = { usage: [cmdUsage, 300], quality: [cmdQuality, 420], pick: [cmdPick, 540], plan: [cmdPlan, 60], cost: [cmdCost, 300], score: [cmdScore, 60], open: [cmdOpen, 60], clone: [cmdClone, 600], diff: [cmdDiff, 30] };
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const c = CMDS[argv[0]];
  if (!c) die(`usage: node tune.mjs ${Object.keys(CMDS).join('|')} ... (see the header of ${fileURLToPath(import.meta.url)})`);
  guard(Number(flag('--timeout', c[1])));
  c[0]().then(() => { releaseLock(); process.exit(0); }, (e) => { console.error(`tune ${argv[0]}: ${e.stack || e.message}`); releaseLock(); process.exit(1); });
}
