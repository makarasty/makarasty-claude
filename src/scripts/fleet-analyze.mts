#!/usr/bin/env node
// fleet-analyze.mts - how a fleet run spent its wall clock and its tokens, read from the session transcripts.
//
// The three questions an operator asks after a run - "how did the fleet work", "why was it slow", "where
// did the tokens go" - used to cost a chat dozens of model turns of ad-hoc parsing, and every answer was a
// different script. This is that parsing done once, in the shell, for free: it splits every task's wall
// time into model, tests, other tools, browser, waits and outages, counts the turn habits that M36 found
// make workers slow, and prices the tokens per worker, per subagent and per task.
//
//   node fleet-analyze.mjs <run-dir>                         plain-text report, under ~40 lines
//   node fleet-analyze.mjs <run-dir> --json                  the full structure
//   node fleet-analyze.mjs <run-dir> --projects <dir>        transcripts somewhere other than the default
//   node fleet-analyze.mjs <run-dir> --prices <file.json>    override the list-price table
//
// Compiled to scripts/fleet-analyze.mjs by `npm run build --prefix src`; plain JavaScript, no dependencies.
//
// Inputs: chips/<session-id> names each worker session's chip, `coordinator` names the coordinator's
// session, tasks/claimed/<id>/owner holds `chip NN` and `claimed <iso time>`, and the mtime of
// tasks/done/<id> is when that task finished. A run with briefs instead of a queue has no claims; each
// worker then counts as one task, from its first transcript line to its NN.done / .blocked / .retired.
// Transcripts are <projects>/<session-id>.jsonl plus every .jsonl under <projects>/<session-id>/
// (subagents, workflow agents). Projects dir default: ${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<slug>,
// where the slug is the project root (the run dir's grandparent) with every non-alphanumeric character
// replaced by '-'; a session not found there is searched for in every project folder.
//
// How a task's time is split (ported from the 2026-10-08 speed analysis behind M36): the gap before an
// assistant line is model time (over five minutes it is a stall), the gap before a tool result is that
// tool's time, a background test run counts from its launch to its notification, and a gap that ends in a
// plain user line is a wait, named by what woke the session. Overlapping work - parent and subagents at
// once - is shared fractionally, so the parts sum to the wall clock. An idle stretch longer than 45 minutes
// is an outage, not a wait. Only tasks that did not overlap another task of the same chip enter the split.
//
// HOST SPECIFIC, like fleet-retro.mjs: it assumes Claude Code's transcript layout. Assistant lines repeat
// one message across several lines (one per content block), so usage is deduplicated by message.id.
// Subagent transcripts often keep only the usage from the start of the stream (stop_reason null), whose
// output_tokens is a few tokens; for those messages output is estimated from the text and tool input the
// message carried (chars / 4), still a lower bound because thinking is not in the transcript.

import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------------------------- types

interface Usage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_creation?: { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown } | null;
  speed?: unknown;
}
interface ToolInput { command?: unknown; file_path?: unknown; offset?: unknown; limit?: unknown }
interface Block {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: ToolInput | null;
  tool_use_id?: unknown;
  content?: unknown;
}
interface Line {
  type?: unknown;
  timestamp?: unknown;
  uuid?: unknown;
  operation?: unknown;
  content?: unknown;
  message?: { id?: unknown; model?: unknown; stop_reason?: unknown; usage?: Usage | null; content?: unknown } | null;
}
interface SubMeta { description?: unknown; agentType?: unknown; model?: unknown }

type Tag = 'parent' | 'sub';
type Iv = [start: number, end: number, kind: string, real: boolean, tag: Tag];
interface Tok { in: number; out: number; outRecorded: number; cr: number; cw: number; c5: number; c1h: number }
interface ToolRec {
  id: string; ts: number; name: string; kind: string; cmd: string; fp: string; off: number; lim: number;
  dur: number | null; bgdur: number | null;
}
interface Msg {
  id: string; ts: number; end: number; model: string; tools: ToolRec[]; u: Tok; stop: string | null;
  chars: number; fast: boolean; cost: number;
}
interface Transcript {
  file: string; tag: Tag; iv: Iv[]; msgs: Msg[]; tools: ToolRec[]; first: number | null; last: number | null;
  badLines: number; meta: SubMeta;
}
interface Session { sid: string; parent: Transcript; subs: Transcript[] }
interface Task {
  id: string; chip: string; start: number; end: number; done: boolean; kind: string; needs: string; budget: number;
}
interface Price { in: number; out: number; cr: number; w5m: number; w1h: number }

// ---------------------------------------------------------------------------------------------- prices

// List prices in $ per million tokens, from the claude-api skill's model table (cached 2026-10-06). Cache
// writes are priced at the documented 1.25x (5 minute) and 2x (1 hour) of input. ESTIMATES: what the
// tokens would cost on the API at list price, not what a subscription is billed. Override with --prices,
// a JSON object of the same shape keyed by model-id prefix.
const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { in: 4, out: 20, cr: 0.2, w5m: 5, w1h: 8 },
  'claude-sonnet-5-5': { in: 2, out: 10, cr: 0.2, w5m: 2.5, w1h: 4 },
  'claude-haiku-4-5': { in: 1, out: 5, cr: 0.1, w5m: 1.25, w1h: 2 },
  'claude-fable-5-1': { in: 10, out: 50, cr: 0.25, w5m: 12.5, w1h: 20 },
  // older and smaller models that earlier runs used; same table, cache read at 0.1x where none is listed
  'claude-fable-5': { in: 10, out: 50, cr: 1, w5m: 12.5, w1h: 20 },
  'claude-opus-5': { in: 5, out: 25, cr: 0.5, w5m: 6.25, w1h: 10 },
  'claude-opus-4': { in: 5, out: 25, cr: 0.5, w5m: 6.25, w1h: 10 },
  'claude-sonnet-5': { in: 2, out: 10, cr: 0.2, w5m: 2.5, w1h: 4 },
  'claude-sonnet-4': { in: 3, out: 15, cr: 0.3, w5m: 3.75, w1h: 6 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cr: 0.01, w5m: 0.125, w1h: 0.2 }, // the under-100K-prompt tier
};
const FALLBACK_MODEL = 'claude-opus-5-5';
const unpriced = new Set<string>();

function priceOf(model: string): Price {
  let best = '';
  for (const k of Object.keys(PRICES)) if (model.startsWith(k) && k.length > best.length) best = k;
  if (!best) { unpriced.add(model); best = FALLBACK_MODEL; }
  return PRICES[best] ?? { in: 0, out: 0, cr: 0, w5m: 0, w1h: 0 };
}

function costOf(m: Msg): number {
  const p = priceOf(m.model);
  const u = m.u;
  const usd = (u.in * p.in + u.out * p.out + u.cr * p.cr + u.c5 * p.w5m + u.c1h * p.w1h) / 1e6;
  return m.fast ? usd * 2 : usd; // fast mode is listed at twice the standard rate
}

// ---------------------------------------------------------------------------------------------- tool kinds

const WAIT_RE = /\bsleep \d|\buntil \[|\buntil \(|Start-Sleep|for i in \$\(seq/;
const FLEET_RE = /fleet\.sh|fleet-gate|"\$f" |\$f |\bsh "\$\{?f/;
const TEST_RE = /vitest|run test\b|test:changed|test:full|test-scope|playwright|\bjest\b|npm (--prefix \S+ )?test\b/;
const TYPE_RE = /\btsc\b|typecheck|vue-tsc/;
const GITW_RE = /\bgit\b[^|;&]*\b(commit|merge|rebase|cherry-pick)\b/;
const BUILD_RE = /run (build|dev)\b|\bvite\b|npx vite|http\.server|serve\b/;
const GIT_RE = /(^|[;&|(]\s*)git\b/;
const MEM_RE = /Get-CimInstance|freemem|Get-Process/;
const READ_RE = /^(sed -n|cat|grep|rg|head|tail|ls|find|wc|awk|nl|diff|file|stat|echo|printf|test|\[)\b/;
const EDIT_RE = /sed -i|cat >|> "?\S+\.(ts|vue|js|mjs|md|json)|tee /;
const PREFIX_RE = /^(cd\s+("[^"]*"|\S+)\s*(&&|;)\s*|[A-Za-z_]+=("[^"]*"|\S*)\s*;?\s*)/;

function stripPrefix(cmd: string): string {
  let c = cmd.trim();
  for (;;) {
    const m = PREFIX_RE.exec(c);
    if (!m || !m[0]) return c;
    c = c.slice(m[0].length);
  }
}

function bashKind(cmd: string): string {
  if ((WAIT_RE.test(cmd) || /clock|clk\d/.test(cmd)) && !TEST_RE.test(cmd)) return 'wait';
  if (/fleet\.sh"?\s+(paused|clock)/.test(cmd)) return 'wait';
  if (TEST_RE.test(cmd)) return 'tests';
  if (TYPE_RE.test(cmd)) return 'typecheck';
  if (FLEET_RE.test(cmd)) return 'fleet.sh';
  if (GITW_RE.test(cmd)) return 'git-commit/merge';
  if (BUILD_RE.test(cmd)) return 'build/serve';
  const s = stripPrefix(cmd);
  if (GIT_RE.test(s) || cmd.trimStart().startsWith('git')) return 'git';
  if (MEM_RE.test(cmd)) return 'ram-check';
  if (EDIT_RE.test(cmd)) return 'bash-edit';
  if (READ_RE.test(s)) return 'bash-read';
  return 'bash-other';
}

function toolKind(name: string, cmd: string): string {
  if (name === 'Bash' || name === 'PowerShell') return bashKind(cmd);
  if (name === 'Read' || name === 'Grep' || name === 'Glob') return 'read';
  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') return 'edit';
  if (name.includes('Browser') || name.includes('claude-in-chrome')) return 'browser';
  if (name === 'Agent' || name === 'Task') return 'agent-spawn';
  if (name === 'Monitor' || name === 'TaskOutput') return 'wait';
  if (name === 'AskUserQuestion') return 'ask-operator';
  return 'meta'; // ToolSearch, Skill, SendMessage, TaskStop, ...
}

const READONLY = new Set(['read', 'bash-read', 'git', 'ram-check']);
const NONREAL = new Set(['wait', 'agent-spawn-sync', 'ask-operator']);
const BG_REAL = new Set(['tests', 'typecheck', 'git-commit/merge']); // clocks, wake loops, servers are not work
const STALL = 300;
const OUTAGE = 45 * 60;
const MISS_GAP = 300;
const MISS_MIN = 20000;
const PRIO = ['ask-operator', 'model-stall', 'idle:coordinator', 'idle:operator', 'idle:wait-subagent',
  'agent-spawn-sync', 'idle', 'wait', 'bg:'];

// ---------------------------------------------------------------------------------------------- parsing

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const TASK_ID_RE = /<task-id>([^<]+)<\/task-id>/g;

function wakeReason(text: string, bg: Map<string, [number, string]>): string {
  if (text.includes('Stop hook feedback')) return 'idle:stop-hook';
  if (text.includes('<task-notification>')) {
    const kinds = [...text.matchAll(TASK_ID_RE)].map((m) => m[1] ?? '').filter((i) => !i.startsWith('__'))
      .map((i) => bg.get(i)?.[1] ?? 'agent');
    if (kinds.includes('agent')) return 'idle:wait-subagent';
    if (kinds.includes('wait')) return 'idle:wake-loop/clock';
    return 'idle:bg-' + (kinds[0] ?? 'other');
  }
  if (text.includes('agent-message') && text.includes('Subagent hand-back')) return 'idle:wait-subagent';
  if (text.includes('cross-session-message') || text.includes('Another Claude session')) return 'idle:coordinator-msg';
  return 'idle:operator/prompt';
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[]).map((b) => (b && typeof b === 'object' ? str(b.text) : '')).join(' ');
}

async function parse(file: string, tag: Tag, meta: SubMeta = {}): Promise<Transcript> {
  const iv: Iv[] = [];
  const msgs = new Map<string, Msg>();
  const tools: ToolRec[] = [];
  const seenTool = new Set<string>();
  const pending = new Map<string, ToolRec>();
  const bg = new Map<string, [number, string]>();
  const bgRec = new Map<string, ToolRec>();
  const enq = new Map<string, number[]>();
  let prev: number | null = null;
  let first: number | null = null;
  let last: number | null = null;
  let badLines = 0;

  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const raw of rl) {
    if (!raw) continue;
    let o: Line;
    try { o = JSON.parse(raw) as Line; } catch { badLines++; continue; }
    if (!o || typeof o !== 'object') continue;
    const now = Date.parse(str(o.timestamp)) / 1000;
    if (!Number.isFinite(now)) continue;
    const type = o.type;
    if (type === 'queue-operation') {
      if (o.operation === 'enqueue') {
        for (const m of String(o.content ?? '').matchAll(TASK_ID_RE)) {
          const id = m[1] ?? '';
          const list = enq.get(id) ?? [];
          list.push(now);
          enq.set(id, list);
        }
      }
      continue;
    }
    if (type !== 'assistant' && type !== 'user') continue;
    const m = o.message && typeof o.message === 'object' ? o.message : {};
    first ??= now;
    last = now;

    if (type === 'assistant') {
      const id = str(m.id) || str(o.uuid) || `line-${now}`;
      const model = str(m.model);
      let d = msgs.get(id);
      if (!d) {
        d = { id, ts: now, end: now, model, tools: [], stop: null, chars: 0, fast: false, cost: 0,
          u: { in: 0, out: 0, outRecorded: 0, cr: 0, cw: 0, c5: 0, c1h: 0 } };
        msgs.set(id, d);
      }
      d.end = now;
      const u = m.usage && typeof m.usage === 'object' ? m.usage : {};
      const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : {};
      // One message spans several lines; take the largest value each field reached rather than adding.
      d.u.in = Math.max(d.u.in, num(u.input_tokens));
      d.u.outRecorded = Math.max(d.u.outRecorded, num(u.output_tokens));
      d.u.cr = Math.max(d.u.cr, num(u.cache_read_input_tokens));
      d.u.cw = Math.max(d.u.cw, num(u.cache_creation_input_tokens));
      d.u.c5 = Math.max(d.u.c5, num(cc.ephemeral_5m_input_tokens));
      d.u.c1h = Math.max(d.u.c1h, num(cc.ephemeral_1h_input_tokens));
      if (u.speed === 'fast') d.fast = true;
      if (typeof m.stop_reason === 'string') d.stop = m.stop_reason;
      if (prev !== null && now > prev) {
        const lab = now - prev < STALL && model !== '<synthetic>' ? 'model' : 'model-stall>5min';
        iv.push([prev, now, lab, lab === 'model', tag]);
      }
      for (const b of Array.isArray(m.content) ? (m.content as Block[]) : []) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') d.chars += str(b.text).length;
        else if (b.type === 'tool_use') {
          const tid = str(b.id);
          if (!tid || seenTool.has(tid)) continue;
          seenTool.add(tid);
          const inp: ToolInput = b.input && typeof b.input === 'object' ? b.input : {};
          d.chars += JSON.stringify(inp).length;
          const name = str(b.name);
          const cmd = str(inp.command);
          const rec: ToolRec = { id: tid, ts: now, name, kind: toolKind(name, cmd), cmd, fp: str(inp.file_path),
            off: num(inp.offset), lim: num(inp.limit), dur: null, bgdur: null };
          pending.set(tid, rec);
          tools.push(rec);
          d.tools.push(rec);
        }
      }
      prev = now;
      continue;
    }

    // user line: tool results, or something that woke the session
    const c = m.content;
    const results = Array.isArray(c) ? (c as Block[]).filter((b) => b && typeof b === 'object' && b.type === 'tool_result') : [];
    if (results.length) {
      const ks: string[] = [];
      for (const b of results) {
        const tid = str(b.tool_use_id);
        const rec = pending.get(tid);
        pending.delete(tid);
        let k = rec ? rec.kind : 'meta';
        if (rec) {
          const txt = blockText(b.content);
          rec.dur = now - rec.ts;
          const bgm = /running in background with ID: (\w+)/.exec(txt);
          if (bgm && bgm[1]) { bg.set(bgm[1], [now, k]); bgRec.set(bgm[1], rec); }
          if (rec.name === 'Agent' || rec.name === 'Task') {
            k = txt.includes('Async agent launched') || (txt.includes('agentId') && rec.dur < 5) ? 'agent-spawn' : 'agent-spawn-sync';
          }
        }
        ks.push(k);
      }
      if (prev !== null) {
        const span = (now - prev) / ks.length;
        ks.forEach((k, j) => iv.push([prev! + j * span, prev! + (j + 1) * span, k, !NONREAL.has(k), tag]));
      }
    } else if (prev !== null) {
      iv.push([prev, now, wakeReason(blockText(c), bg), false, tag]);
    }
    prev = now;
  }

  // A background shell ends when its notification is queued, not when its launch call returned.
  for (const [id, [start, k]] of bg) {
    const end = (enq.get(id) ?? []).find((t) => t > start);
    const rec = bgRec.get(id);
    if (end === undefined || !rec) continue;
    rec.bgdur = end - start;
    iv.push([start, end, 'bg:' + k, BG_REAL.has(k), tag]);
  }

  const list = [...msgs.values()].filter((x) => x.model !== '<synthetic>').sort((a, b) => a.ts - b.ts);
  for (const x of list) {
    const u = x.u;
    // Without the TTL breakdown, a cache write is counted at the cheaper 5 minute rate.
    if (u.c5 + u.c1h < u.cw) u.c5 += u.cw - u.c5 - u.c1h;
    u.out = x.stop === null ? Math.max(u.outRecorded, Math.round(x.chars / 4)) : u.outRecorded;
    x.cost = costOf(x);
  }
  return { file, tag, iv, msgs: list, tools, first, last, badLines, meta };
}

// ---------------------------------------------------------------------------------------------- run dir

function nativePath(p: string): string {
  // Git Bash hands node /c/Users/...; on Windows node would read that as C:\c\Users.
  const m = process.platform === 'win32' ? /^\/([a-zA-Z])(\/.*)?$/.exec(p) : null;
  return m ? `${m[1]}:${m[2] ?? '/'}` : p;
}

function readText(p: string): string {
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
}

function listDir(p: string): string[] {
  try { return readdirSync(p); } catch { return []; }
}

function mtime(p: string): number | null {
  try { return statSync(p).mtimeMs / 1000; } catch { return null; }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function readChips(run: string): Map<string, string> {
  const chips = new Map<string, string>();
  for (const f of listDir(join(run, 'chips'))) {
    if (!SID_RE.test(f)) continue;
    const chip = readText(join(run, 'chips', f)).split(/\r?\n/)[0]?.trim() ?? '';
    if (chip) chips.set(f, chip);
  }
  return chips;
}

function frontMatter(file: string): Record<string, string> {
  const fm: Record<string, string> = {};
  const parts = readText(file).split(/^---\s*$/m);
  for (const l of (parts[1] ?? '').split(/\r?\n/)) {
    const i = l.indexOf(':');
    if (i > 0) fm[l.slice(0, i).trim()] = l.slice(i + 1).replace(/#.*$/, '').trim();
  }
  return fm;
}

function readTasks(run: string): Task[] {
  const tasks: Task[] = [];
  const claimed = join(run, 'tasks', 'claimed');
  for (const id of listDir(claimed)) {
    if (id.includes('.') || !isDir(join(claimed, id))) continue;
    const own = readText(join(claimed, id, 'owner'));
    const chip = /chip (\S+)/.exec(own)?.[1];
    const cl = /claimed (\S+)/.exec(own)?.[1];
    if (!chip || !cl || chip.startsWith('planner')) continue;
    const start = Date.parse(cl) / 1000;
    if (!Number.isFinite(start)) continue;
    const doneAt = mtime(join(run, 'tasks', 'done', id));
    const fm = frontMatter(join(run, 'tasks', 'ready', `${id}.md`));
    tasks.push({ id, chip, start, end: doneAt ?? Date.now() / 1000, done: doneAt !== null,
      kind: fm.kind ?? '?', needs: fm.needs ?? '?', budget: Number(fm.budget) || 0 });
  }
  return tasks;
}

function projectsRoot(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}

function locateSessions(sids: string[], primary: string): Map<string, string> {
  const found = new Map<string, string>();
  const missing: string[] = [];
  for (const sid of sids) {
    if (existsSync(join(primary, `${sid}.jsonl`))) found.set(sid, primary); else missing.push(sid);
  }
  if (missing.length) {
    const root = projectsRoot();
    for (const d of listDir(root)) {
      for (const sid of missing) {
        if (!found.has(sid) && existsSync(join(root, d, `${sid}.jsonl`))) found.set(sid, join(root, d));
      }
    }
  }
  return found;
}

function walkJsonl(dir: string, out: string[] = []): string[] {
  let entries: Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'tool-results') walkJsonl(p, out); } else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function readMeta(jsonl: string): SubMeta {
  try { return JSON.parse(readFileSync(jsonl.replace(/\.jsonl$/, '.meta.json'), 'utf8')) as SubMeta; } catch { return {}; }
}

async function loadSession(sid: string, dir: string): Promise<Session> {
  const subFiles = walkJsonl(join(dir, sid));
  const [parent, ...subs] = await Promise.all([
    parse(join(dir, `${sid}.jsonl`), 'parent'),
    ...subFiles.map((f) => parse(f, 'sub', readMeta(f))),
  ]);
  return { sid, parent: parent!, subs: subs.filter((s) => s.msgs.length > 0) };
}

// ---------------------------------------------------------------------------------------------- analysis

const add = (m: Map<string, number>, k: string, v: number): void => { m.set(k, (m.get(k) ?? 0) + v); };

function sweep(ivs: Iv[], a: number, b: number): { res: Map<string, number>; where: Map<string, number> } {
  const use: Iv[] = [];
  const ev: [number, boolean, number][] = [];
  for (const iv of ivs) {
    const [s, e, k, real, tag] = iv;
    if (!(e > a && s < b && e > s) || (!real && tag !== 'parent')) continue;
    const x: Iv = [Math.max(s, a), Math.min(e, b), k, real, tag];
    ev.push([x[0], true, use.length], [x[1], false, use.length]);
    use.push(x);
  }
  ev.sort((p, q) => p[0] - q[0]);
  const res = new Map<string, number>();
  const where = new Map<string, number>();
  const realOn = new Map<number, Iv>();
  const idleOn = new Map<number, Iv>();
  let idleRun: [number, string][] = [];
  const flush = (): void => {
    const total = idleRun.reduce((t, [d]) => t + d, 0);
    for (const [d, lab] of idleRun) { add(res, total > OUTAGE ? 'outage(idle run>45m)' : lab, d); add(where, 'idle', d); }
    idleRun = [];
  };
  const seg = (x: number, y: number): void => {
    if (y <= x) return;
    if (realOn.size) {
      flush();
      const share = (y - x) / realOn.size;
      for (const v of realOn.values()) {
        add(res, v[2].startsWith('bg:') ? v[2].slice(3) : v[2], share);
        add(where, v[4], share);
      }
      return;
    }
    const cov = [...idleOn.values()].map((v) => v[2]);
    let lab = 'idle:no-record';
    for (const p of PRIO) {
      const hit = cov.find((k) => k.startsWith(p));
      if (hit) { lab = hit.startsWith('idle') ? hit : 'idle:' + hit; break; }
    }
    idleRun.push([y - x, lab]);
  };
  let cur = a;
  for (let i = 0; i < ev.length;) {
    const t = ev[i]![0];
    seg(cur, t);
    cur = Math.max(cur, t);
    for (; i < ev.length && ev[i]![0] === t; i++) {
      const [, start, idx] = ev[i]!;
      const x = use[idx]!;
      const on = x[3] ? realOn : idleOn;
      if (start) on.set(idx, x); else on.delete(idx);
    }
  }
  seg(cur, b);
  flush();
  return { res, where };
}

function bucket(k: string): string {
  if (k === 'model') return 'model';
  if (k === 'tests' || k === 'typecheck') return 'tests/typecheck';
  if (k === 'browser') return 'browser';
  if (k.startsWith('outage')) return 'outages >45m';
  if (k === 'idle:ask-operator' || k === 'idle:operator/prompt') return 'waits on operator';
  if (k.startsWith('idle')) return 'other waits';
  return 'other tools';
}
const BUCKETS = ['model', 'tests/typecheck', 'other tools', 'browser', 'waits on operator', 'other waits', 'outages >45m'];

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.min(lo + 1, s.length - 1);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}

function emptyTok(): Tok & { cost: number; msgs: number } {
  return { in: 0, out: 0, outRecorded: 0, cr: 0, cw: 0, c5: 0, c1h: 0, cost: 0, msgs: 0 };
}
function addTok(t: Tok & { cost: number; msgs: number }, m: Msg): void {
  t.in += m.u.in; t.out += m.u.out; t.outRecorded += m.u.outRecorded; t.cr += m.u.cr; t.cw += m.u.cw;
  t.c5 += m.u.c5; t.c1h += m.u.c1h; t.cost += m.cost; t.msgs++;
}

const SED_RE = /sed -n\s+['"]?(\d+)(?:,(\d+))?p['"]?\s+['"]?([^\s'"|;]+\.[A-Za-z0-9]+)/;
const CAT_RE = /^(?:cat(?: -n)?|head(?: -n)?(?: -?(\d+))?)\s+['"]?([^\s'"|;]+\.[A-Za-z0-9]+)/;

// Which lines of which file a read covered. Paging through a file is not re-reading it, so a read counts
// as a re-read only when its range overlaps one this transcript already read.
function readSpan(x: ToolRec): [file: string, from: number, to: number] | null {
  const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
  if (x.name === 'Read' && x.fp) {
    const from = Math.max(1, x.off || 1);
    return [norm(x.fp), from, from + (x.lim || 2000) - 1];
  }
  if (x.kind !== 'bash-read') return null;
  const s = stripPrefix(x.cmd);
  const sed = SED_RE.exec(s);
  if (sed) { const a = Number(sed[1]); return [norm(sed[3] ?? ''), a, sed[2] ? Number(sed[2]) : a]; }
  const cat = CAT_RE.exec(s);
  if (cat) return [norm(cat[2] ?? ''), 1, s.startsWith('head') ? Number(cat[1] ?? 10) : Infinity];
  return null;
}

// Turn habits of one transcript (M36): one-tool turns, read-only turns that could have been batched with
// the one before, long streaks of single reads, re-reads of a file range already read, repeated tests.
function habits(t: Transcript) {
  let turns = 0, oneTool = 0, mergeable = 0, streaks = 0, streakTurns = 0, run = 0, single = 0;
  for (const m of t.msgs) {
    turns++;
    if (m.tools.length === 1) oneTool++;
    const ro = m.tools.length === 1 && READONLY.has(m.tools[0]!.kind);
    run = ro ? run + 1 : 0;
    if (run >= 2) mergeable++;
    const sr = m.tools.length === 1 && (m.tools[0]!.kind === 'read' || m.tools[0]!.kind === 'bash-read');
    if (sr) single++;
    else { if (single >= 8) { streaks++; streakTurns += single; } single = 0; }
  }
  if (single >= 8) { streaks++; streakTurns += single; }
  const seen = new Map<string, [number, number][]>();
  const testSeen = new Set<string>();
  let reads = 0, rereads = 0, sameFile = 0, repTests = 0, repTestSec = 0;
  for (const x of t.tools) {
    const span = readSpan(x);
    if (span) {
      const [file, a, b] = span;
      const prior = seen.get(file) ?? [];
      reads++;
      if (prior.length) sameFile++;
      if (prior.some(([pa, pb]) => a <= pb && pa <= b)) rereads++;
      prior.push([a, b]);
      seen.set(file, prior);
    }
    if (x.kind === 'tests' || x.kind === 'typecheck') {
      const k = stripPrefix(x.cmd).replace(/\s+/g, ' ');
      if (testSeen.has(k)) { repTests++; repTestSec += x.bgdur ?? x.dur ?? 0; }
      testSeen.add(k);
    }
  }
  return { turns, oneTool, mergeable, streaks, streakTurns, reads, rereads, sameFile, repTests, repTestSec };
}

// Cache rewrites after idle: a message that wrote a large prefix after more than five minutes of silence in
// its own transcript. What it cost over a cache read of the same tokens is the price of the gap.
function cacheMisses(t: Transcript) {
  const out: { at: number; gapMin: number; tokens: number; extra: number; tag: Tag }[] = [];
  let prevEnd: number | null = null;
  for (const m of t.msgs) {
    if (prevEnd !== null && m.ts - prevEnd > MISS_GAP && m.u.cw >= MISS_MIN) {
      const p = priceOf(m.model);
      const extra = (m.u.c5 * (p.w5m - p.cr) + m.u.c1h * (p.w1h - p.cr)) / 1e6;
      out.push({ at: m.ts, gapMin: (m.ts - prevEnd) / 60, tokens: m.u.cw, extra, tag: t.tag });
    }
    prevEnd = m.end;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- main

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (n: string): string | null => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1] ?? null; };
  const valued = new Set(['--projects', '--prices']);
  const runArg = args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1] ?? ''));
  if (!runArg) {
    console.error('usage: node fleet-analyze.mjs <run-dir> [--projects <dir>] [--json] [--prices <file>]');
    process.exit(2);
  }
  const run = resolve(nativePath(runArg));
  if (!isDir(run)) { console.error(`fleet-analyze: no run directory at ${run}`); process.exit(2); }
  const pricesFile = flag('--prices');
  if (pricesFile) {
    try {
      const extra = JSON.parse(readFileSync(nativePath(pricesFile), 'utf8')) as Record<string, Partial<Price>>;
      for (const [k, v] of Object.entries(extra)) PRICES[k] = { ...(PRICES[k] ?? { in: 0, out: 0, cr: 0, w5m: 0, w1h: 0 }), ...v };
    } catch (e) { console.error(`fleet-analyze: could not read --prices ${pricesFile}: ${(e as Error).message}`); process.exit(2); }
  }
  const projectRoot = resolve(run, '..', '..');
  const projArg = flag('--projects');
  const primary = projArg ? resolve(nativePath(projArg)) : join(projectsRoot(), projectRoot.replace(/[^A-Za-z0-9]/g, '-'));

  const chips = readChips(run);
  const coord = readText(join(run, 'coordinator')).split(/\r?\n/)[0]?.trim() ?? '';
  const sids = [...chips.keys()];
  if (SID_RE.test(coord) && !chips.has(coord)) sids.push(coord);
  const where = locateSessions(sids, primary);
  const missing = sids.filter((s) => !where.has(s));
  const sessions = new Map<string, Session>();
  await Promise.all([...where].map(async ([sid, dir]) => { sessions.set(sid, await loadSession(sid, dir)); }));

  // chip -> its sessions (a relaunched or compacted worker can have several)
  const byChip = new Map<string, Session[]>();
  for (const [sid, chip] of [...chips].sort((a, b) => a[1].localeCompare(b[1]))) {
    const s = sessions.get(sid);
    if (s) byChip.set(chip, [...(byChip.get(chip) ?? []), s]);
  }

  let tasks = readTasks(run);
  const briefMode = tasks.length === 0;
  if (briefMode) {
    for (const [chip, ss] of byChip) {
      const firsts = ss.map((s) => s.parent.first).filter((x): x is number => x !== null);
      const lasts = ss.flatMap((s) => [s.parent.last, ...s.subs.map((x) => x.last)]).filter((x): x is number => x !== null);
      if (!firsts.length) continue;
      const marker = ['done', 'blocked', 'retired'].map((m) => mtime(join(run, `${chip}.${m}`))).find((x) => x !== null) ?? null;
      tasks.push({ id: `brief-${chip}`, chip, start: Math.min(...firsts), end: marker ?? Math.max(...lasts), done: marker !== null,
        kind: 'brief', needs: '?', budget: 0 });
    }
  }
  tasks = tasks.sort((a, b) => a.start - b.start);
  if (!tasks.length && !byChip.size) {
    console.error(`fleet-analyze: nothing to analyze in ${run}: no chips/<session-id> with a transcript and no claimed tasks` +
      (missing.length ? ` (${missing.length} session ids had no transcript under ${primary})` : ''));
    process.exit(1);
  }
  const done = tasks.filter((t) => t.done);

  // ---- per chip: intervals, task splits, tokens, habits
  const taskRows: Record<string, unknown>[] = [];
  const total = new Map<string, number>();
  const totalWhere = new Map<string, number>();
  const workers: Record<string, unknown>[] = [];
  const workerTok = emptyTok(), parentTok = emptyTok(), subTok = emptyTok();
  const hab = { turns: 0, oneTool: 0, mergeable: 0, streaks: 0, streakTurns: 0, reads: 0, rereads: 0, sameFile: 0, repTests: 0, repTestSec: 0 };
  const misses: ReturnType<typeof cacheMisses> = [];
  const subRows: { chip: string; desc: string; model: string; min: number; firstEditMin: number | null; cost: number }[] = [];
  const models = new Map<string, number>();
  let badLines = 0;
  const taskTok = new Map<string, ReturnType<typeof emptyTok>>();

  for (const [chip, ss] of byChip) {
    const ivs: Iv[] = [];
    const ptok = emptyTok(), stok = emptyTok();
    const chipMsgs: Msg[] = [];
    let nsub = 0;
    for (const s of ss) {
      for (const t of [s.parent, ...s.subs]) {
        badLines += t.badLines;
        ivs.push(...t.iv);
        const h = habits(t);
        for (const k of Object.keys(hab) as (keyof typeof hab)[]) hab[k] += h[k];
        misses.push(...cacheMisses(t));
        for (const m of t.msgs) {
          addTok(t.tag === 'parent' ? ptok : stok, m);
          addTok(t.tag === 'parent' ? parentTok : subTok, m);
          addTok(workerTok, m);
          add(models, m.model, 1);
          chipMsgs.push(m);
        }
        if (t.tag === 'sub') {
          nsub++;
          const start = t.iv.length ? Math.min(...t.iv.map((x) => x[0])) : (t.first ?? 0);
          const firstEdit = t.tools.find((x) => x.kind === 'edit' || x.kind === 'bash-edit');
          subRows.push({ chip, desc: str(t.meta.description) || basename(t.file), model: str(t.meta.model),
            min: ((t.last ?? start) - start) / 60, firstEditMin: firstEdit ? (firstEdit.ts - start) / 60 : null,
            cost: t.msgs.reduce((c, m) => c + m.cost, 0) });
        }
      }
    }
    const ctasks = tasks.filter((t) => t.chip === chip);
    // Each message goes to at most one task: the latest-claimed task whose window holds it.
    for (const m of chipMsgs) {
      let owner: Task | null = null;
      for (const t of ctasks) if (t.start <= m.ts && m.ts <= t.end) owner = t;
      if (owner) { const tt = taskTok.get(owner.id) ?? emptyTok(); addTok(tt, m); taskTok.set(owner.id, tt); }
    }
    for (const t of ctasks) {
      const { res, where: w } = sweep(ivs, t.start, t.end);
      const overlaps = ctasks.filter((o) => o !== t && o.start < t.end && o.end > t.start).map((o) => o.id);
      if (t.done && !overlaps.length) { for (const [k, v] of res) add(total, k, v); for (const [k, v] of w) add(totalWhere, k, v); }
      const buckets = new Map<string, number>();
      for (const [k, v] of res) add(buckets, bucket(k), v);
      const tk = taskTok.get(t.id) ?? emptyTok();
      taskRows.push({ id: t.id, chip, done: t.done, kind: t.kind, needs: t.needs, budget: t.budget,
        start: new Date(t.start * 1000).toISOString(), min: (t.end - t.start) / 60,
        buckets_min: Object.fromEntries([...buckets].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +(v / 60).toFixed(1)])),
        split_min: Object.fromEntries([...res].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +(v / 60).toFixed(1)])),
        where_min: Object.fromEntries([...w].map(([k, v]) => [k, +(v / 60).toFixed(1)])),
        overlaps, tokens: tk, cost: +tk.cost.toFixed(2) });
    }
    workers.push({ chip, sessions: ss.map((s) => s.sid), tasks_done: ctasks.filter((t) => t.done).length,
      tasks_open: ctasks.filter((t) => !t.done).length, subagents: nsub, parent: ptok, subs: stok,
      cost: +(ptok.cost + stok.cost).toFixed(2) });
  }

  // ---- coordinator
  const coordSession = sessions.get(coord);
  const coordTok = emptyTok();
  if (coordSession) for (const t of [coordSession.parent, ...coordSession.subs]) for (const m of t.msgs) { addTok(coordTok, m); add(models, m.model, 1); }

  // ---- span
  const allT = [...byChip.values()].flat().flatMap((s) => [s.parent.first, s.parent.last]).filter((x): x is number => x !== null);
  const spanA = Math.min(...tasks.map((t) => t.start), ...allT);
  const spanB = Math.max(...tasks.map((t) => t.end), ...allT);

  const totalSec = [...total.values()].reduce((a, b) => a + b, 0);
  const bucketsTotal = new Map<string, number>();
  for (const [k, v] of total) add(bucketsTotal, bucket(k), v);
  const share = (b: string): number => (totalSec ? (bucketsTotal.get(b) ?? 0) / totalSec : 0);
  const mins = done.map((t) => (t.end - t.start) / 60);
  const firstEdits = subRows.map((s) => s.firstEditMin).filter((x): x is number => x !== null);
  const missTok = misses.reduce((a, m) => a + m.tokens, 0);
  const missUsd = misses.reduce((a, m) => a + m.extra, 0);
  const totalUsd = workerTok.cost + coordTok.cost;
  const perTask = done.length ? workerTok.cost / done.length : 0;

  // ---- recommendations: only where a number crosses a line, biggest first
  const recs: [number, string][] = [];
  const m1 = (b: string): string => `${((bucketsTotal.get(b) ?? 0) / 60).toFixed(0)} min (${(share(b) * 100).toFixed(0)}%)`;
  if (share('outages >45m') >= 0.1) recs.push([share('outages >45m'), `Idle stretches over 45 min took ${m1('outages >45m')} of task time: nothing was recorded then, so find what stopped the workers (crash, restart, blind pane; M35) before blaming speed.`]);
  if (share('waits on operator') >= 0.05) recs.push([share('waits on operator'), `Workers waited on the operator ${m1('waits on operator')}: settle the open questions in the brief or a decisions file before launch.`]);
  if (share('tests/typecheck') >= 0.15) recs.push([share('tests/typecheck'), `Tests and typecheck took ${m1('tests/typecheck')}; ${hab.repTests} identical runs were repeated: scope runs to the changed files and keep one full run per task.`]);
  const mergeShare = hab.turns ? hab.mergeable / hab.turns : 0;
  if (hab.turns && hab.oneTool / hab.turns >= 0.8 && mergeShare >= 0.1) recs.push([mergeShare * share('model'), `${(hab.oneTool / hab.turns * 100).toFixed(0)}% of turns call exactly one tool and ${hab.mergeable} read-only turns followed another: batch independent reads into one turn (fleet-run, "Read in batches"; M36).`]);
  const reShare = hab.reads ? hab.rereads / hab.reads : 0;
  if (reShare >= 0.15) recs.push([reShare * 0.2, `${(reShare * 100).toFixed(0)}% of file reads re-read a range the same chat had read: hand subagents the file map the parent already has (M36).`]);
  if (totalUsd && missUsd / totalUsd >= 0.03) recs.push([missUsd / totalUsd, `${misses.length} cache rewrites after more than 5 min idle cost ~$${missUsd.toFixed(0)} (${(missUsd / totalUsd * 100).toFixed(0)}% of spend): a chat left idle past its cache TTL re-pays its whole prefix.`]);
  const fe = pct(firstEdits, 0.5);
  if (firstEdits.length >= 3 && fe >= 4) recs.push([0.05, `Subagents made their first edit after a median ${fe.toFixed(1)} min: pass them the files and line numbers already found instead of a bare goal (M36).`]);
  recs.sort((a, b) => b[0] - a[0]);

  const report = {
    run: basename(run), run_dir: run, projects_dir: primary, brief_mode: briefMode,
    span: { start: new Date(spanA * 1000).toISOString(), end: new Date(spanB * 1000).toISOString(), hours: (spanB - spanA) / 3600 },
    workers_seen: byChip.size, coordinator: coord || null, coordinator_found: !!coordSession,
    missing_transcripts: missing.map((s) => ({ sid: s, chip: chips.get(s) ?? 'coordinator' })), bad_lines: badLines,
    tasks: { claimed: tasks.length, done: done.length, median_min: pct(mins, 0.5), p90_min: pct(mins, 0.9) },
    time: { total_min: totalSec / 60, buckets_min: Object.fromEntries(BUCKETS.map((b) => [b, +((bucketsTotal.get(b) ?? 0) / 60).toFixed(1)])),
      split_min: Object.fromEntries([...total].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +(v / 60).toFixed(1)])),
      by_actor_min: Object.fromEntries([...totalWhere].map(([k, v]) => [k, +(v / 60).toFixed(1)])) },
    habits: { ...hab, one_tool_share: hab.turns ? hab.oneTool / hab.turns : 0, reread_share: reShare },
    subagents: { count: subRows.length, median_min: pct(subRows.map((s) => s.min), 0.5), p90_min: pct(subRows.map((s) => s.min), 0.9),
      median_first_edit_min: firstEdits.length ? fe : null, list: subRows },
    cache_misses: { count: misses.length, tokens: missTok, extra_usd: missUsd, list: misses.map((m) => ({ ...m, at: new Date(m.at * 1000).toISOString() })) },
    tokens: { workers: workerTok, workers_parent: parentTok, workers_subagents: subTok, coordinator: coordTok },
    cost: { total_usd: totalUsd, workers_usd: workerTok.cost, coordinator_usd: coordTok.cost, per_done_task_usd: perTask },
    models: Object.fromEntries(models),
    per_worker: workers, per_task: taskRows,
    prices: { table: PRICES, note: 'list-price estimates, $ per million tokens; cache writes 1.25x (5m) / 2x (1h) input', unpriced_as_opus_5_5: [...unpriced] },
    recommendations: recs.slice(0, 5).map((r) => r[1]),
  };

  if (args.includes('--json')) { process.stdout.write(JSON.stringify(report, null, 1) + '\n'); return; }

  // ---- the human report
  const L: string[] = [];
  const f0 = (x: number): string => Math.round(x).toLocaleString('en-US');
  const usd = (x: number): string => `$${x >= 100 ? f0(x) : x.toFixed(2)}`;
  const Mt = (x: number): string => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : `${(x / 1e3).toFixed(0)}k`);
  const clock = (t: number): string => {
    const d = new Date(t * 1000);
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  L.push(`fleet-analyze ${report.run}: ${byChip.size} workers, span ${clock(spanA)} -> ${clock(spanB)} (${report.span.hours.toFixed(1)} h)`);
  if (missing.length) L.push(`  no transcript for ${missing.map((s) => `${chips.get(s) ?? 'coordinator'} (${s.slice(0, 8)})`).join(', ')}`);
  L.push(`tasks done ${done.length} of ${tasks.length}${briefMode ? ' (briefs: one per worker)' : ''}; median ${pct(mins, 0.5).toFixed(1)} min, p90 ${pct(mins, 0.9).toFixed(1)}`);
  L.push(`where task time went (${f0(totalSec / 60)} min over done tasks that did not overlap):`);
  const bl = BUCKETS.map((b) => `${b} ${f0((bucketsTotal.get(b) ?? 0) / 60)} (${(share(b) * 100).toFixed(0)}%)`);
  L.push(`  ${bl.slice(0, 4).join(' | ')}`);
  L.push(`  ${bl.slice(4).join(' | ')}`);
  L.push(`turns ${f0(hab.turns)}: one tool call ${(report.habits.one_tool_share * 100).toFixed(0)}%, read-only turns after another ${f0(hab.mergeable)}, streaks of 8+ single reads ${hab.streaks} (${f0(hab.streakTurns)} turns)`);
  L.push(`re-reads ${f0(hab.rereads)} of ${f0(hab.reads)} file reads (${(reShare * 100).toFixed(0)}%) overlap lines already read; ${f0(hab.sameFile)} reopen a file already read`);
  L.push(`subagents ${subRows.length}: median ${report.subagents.median_min.toFixed(1)} min, first edit after median ${firstEdits.length ? fe.toFixed(1) : '-'} min; identical test/typecheck re-runs ${hab.repTests} (${(hab.repTestSec / 60).toFixed(1)} min)`);
  L.push(`cache rewrites after >5 min idle: ${misses.length}, ${Mt(missTok)} tokens, ~${usd(missUsd)} over a cache read`);
  L.push(`tokens (workers): cache read ${Mt(workerTok.cr)}, cache write ${Mt(workerTok.cw)}, input ${Mt(workerTok.in)}, output ${Mt(workerTok.out)}`);
  L.push(`cost, list-price estimate: total ${usd(totalUsd)} = workers ${usd(workerTok.cost)} (parents ${usd(parentTok.cost)}, subagents ${usd(subTok.cost)}) + coordinator ${usd(coordTok.cost)}${coordSession ? '' : ' (not found)'}`);
  L.push(`  per done task ${usd(perTask)} (worker spend / tasks done)`);
  const wsorted = [...workers].sort((a, b) => Number(b.cost) - Number(a.cost));
  const wl = wsorted.slice(0, 8).map((w) => {
    const p = w.parent as ReturnType<typeof emptyTok>, s = w.subs as ReturnType<typeof emptyTok>;
    return `${String(w.chip)} ${usd(Number(w.cost))} (${usd(p.cost)}+${usd(s.cost)} sub, ${String(w.tasks_done)} done)`;
  });
  for (let i = 0; i < wl.length; i += 4) L.push(`  ${i ? '' : 'per worker: '}${wl.slice(i, i + 4).join('; ')}`);
  if (workers.length > 8) L.push(`  ... ${workers.length - 8} more in --json`);
  L.push('slowest tasks:');
  for (const t of [...taskRows].filter((t) => t.done).sort((a, b) => Number(b.min) - Number(a.min)).slice(0, 5)) {
    const [top, v] = Object.entries(t.buckets_min as Record<string, number>)[0] ?? ['-', 0];
    L.push(`  ${String(t.chip)} ${String(t.id).slice(0, 44).padEnd(44)} ${Number(t.min).toFixed(1).padStart(6)} min, most ${top} ${v} min`);
  }
  if (report.recommendations.length) { L.push('recommendations:'); for (const r of report.recommendations) L.push(`  - ${r}`); }
  const assume = [`prices are list-price estimates (Opus 5.5 $4/$20, cache read $0.20, writes 1.25x/2x input)`];
  if (unpriced.size) assume.push(`unknown models priced as Opus 5.5: ${[...unpriced].join(', ')}`);
  if (badLines) assume.push(`${badLines} unreadable lines skipped`);
  L.push(`note: ${assume.join('; ')}; subagent output tokens partly estimated (chars/4)`);
  process.stdout.write(L.join('\n') + '\n');
}

main().catch((e: unknown) => { console.error(`fleet-analyze: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); process.exit(1); });
