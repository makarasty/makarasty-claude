#!/usr/bin/env node
// fleet-analyze-test.ts - builds a tiny run and its transcripts in a temp dir and checks what
// fleet-analyze.ts reads out of them. Every expected number below is worked out by hand in the comments,
// so a change to the split or the pricing shows up as a named failure rather than a different report.
//
//   node scripts/fleet-analyze-test.ts        prints "N passed, M failed", exit 0 only when M is 0

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

interface TokOut { in: number; out: number; cr: number; cw: number; c5: number; c1h: number; cost: number; msgs: number }
interface Report {
  tasks: { claimed: number; done: number; median_min: number };
  time: { total_min: number; buckets_min: Record<string, number>; split_min: Record<string, number> };
  habits: { turns: number; oneTool: number; mergeable: number; reads: number; rereads: number };
  subagents: { count: number; median_min: number; median_first_edit_min: number | null };
  cache_misses: { count: number; tokens: number; extra_usd: number };
  tokens: { workers_parent: TokOut; workers_subagents: TokOut; coordinator: TokOut };
  cost: { total_usd: number; per_done_task_usd: number };
  missing_transcripts: { sid: string; chip: string }[];
  bad_lines: number;
  per_task: { id: string; cost: number }[];
}

let passed = 0, failed = 0;
function check(name: string, got: unknown, want: unknown, tol = 1e-6): void {
  const ok = typeof got === 'number' && typeof want === 'number' ? Math.abs(got - want) <= tol : JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else { failed++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

const tmp = mkdtempSync(join(tmpdir(), 'fleet-analyze-'));
const root = join(tmp, 'proj_x');
const run = join(root, '.fleet', 'r1');
const cfg = join(tmp, 'cfg');
const projects = join(cfg, 'projects', root.replace(/[^A-Za-z0-9]/g, '-')); // the default the script derives
const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003', GONE = 'dddddddd-0000-4000-8000-000000000004';

const at = (hms: string): string => `2026-01-01T${hms}Z`;
const sec = (hms: string): number => Date.parse(at(hms)) / 1000;
type Obj = Record<string, unknown>;
const user = (hms: string, content: unknown): Obj => ({ type: 'user', timestamp: at(hms), message: { role: 'user', content } });
const result = (hms: string, id: string, text = 'ok'): Obj => user(hms, [{ type: 'tool_result', tool_use_id: id, content: text }]);
const asst = (hms: string, id: string, model: string, usage: Obj, block: Obj, stop: string | null = 'tool_use'): Obj =>
  ({ type: 'assistant', timestamp: at(hms), message: { id, model, stop_reason: stop, usage, content: [block] } });
const tool = (id: string, name: string, input: Obj): Obj => ({ type: 'tool_use', id, name, input });
const jsonl = (rows: Obj[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const OPUS = 'claude-opus-5-5', SONNET = 'claude-sonnet-5-5';

// ---- run dir: two workers (01 with a task, 02 without), a chip whose transcript is gone, a coordinator
mkdirSync(join(run, 'chips'), { recursive: true });
writeFileSync(join(run, 'chips', A), '01\n');
writeFileSync(join(run, 'chips', B), '02\n');
writeFileSync(join(run, 'chips', GONE), '03\n');
writeFileSync(join(run, 'chips', '01.model'), 'claude-opus-5-5 high plugin 0\n'); // not a session id: ignored
writeFileSync(join(run, 'coordinator'), C + '\n');
mkdirSync(join(run, 'tasks', 'claimed', 't01'), { recursive: true });
mkdirSync(join(run, 'tasks', 'done'), { recursive: true });
mkdirSync(join(run, 'tasks', 'ready'), { recursive: true });
writeFileSync(join(run, 'tasks', 'claimed', 't01', 'owner'), `chip 01\nclaimed ${at('10:00:00')}\n`);
writeFileSync(join(run, 'tasks', 'ready', 't01.md'), '---\ntask-id: t01\nkind: fix\nneeds: repo\nbudget: 30\n---\n# t01\n');
writeFileSync(join(run, 'tasks', 'done', 't01'), 'branch fleet/01/t01\n');
utimesSync(join(run, 'tasks', 'done', 't01'), sec('10:30:00'), sec('10:30:00'));

// ---- worker 01, parent. Task window 10:00:00-10:30:00 = 1800 s, split by hand:
//   model 10+8+9+10+5 = 42 s here plus 30+29 in the subagent; the full split is checked below.
mkdirSync(join(projects, A, 'subagents'), { recursive: true });
const m1usage = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 };
writeFileSync(join(projects, `${A}.jsonl`), jsonl([
  user('10:00:00', 'work task t01'),
  // m1 spans two lines with the same id: its usage must be counted once
  asst('10:00:10', 'm1', OPUS, m1usage, { type: 'thinking', thinking: '' }),
  asst('10:00:10', 'm1', OPUS, m1usage, tool('tu1', 'Read', { file_path: 'C:\\x\\a.ts' })),
  result('10:00:12', 'tu1'), // read 2 s
  asst('10:00:20', 'm2', OPUS, { output_tokens: 20, cache_read_input_tokens: 2000 }, tool('tu2', 'Read', { file_path: 'C:/x/a.ts' })),
  result('10:00:21', 'tu2'), // read 1 s; same file, same lines: one re-read
  asst('10:00:30', 'm3', OPUS, { output_tokens: 30, cache_read_input_tokens: 3000 }, tool('tu3', 'Bash', { command: 'npx vitest run a.test.ts' })),
  result('10:01:30', 'tu3'), // tests 60 s
  user('10:11:50', 'carry on'), // 620 s waiting on the operator
  // 11.5 min after m3 ended, a 50k write: one cache rewrite after idle
  asst('10:12:00', 'm4', OPUS, { output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 50000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 50000 } }, { type: 'text', text: 'spawned' }, 'end_turn'),
  user('10:14:05', '<task-notification><task-id>agent1</task-id></task-notification>'), // waiting on the subagent
  asst('10:14:10', 'm5', OPUS, { output_tokens: 10, cache_read_input_tokens: 4000 }, { type: 'text', text: 'done' }, 'end_turn'),
]));

// ---- worker 01, one subagent on Sonnet. s1 kept only its stream-start usage (stop_reason null, 3 output
// tokens), so its output is estimated from what it wrote; s2 has a write with no TTL breakdown (5 minute).
const editInput = { file_path: 'C:/x/b.ts', old_string: 'a', new_string: 'x'.repeat(400) };
const s1Out = Math.round(JSON.stringify(editInput).length / 4);
writeFileSync(join(projects, A, 'subagents', 'agent-1.jsonl'), jsonl([
  user('10:13:00', 'fix b.ts'),
  asst('10:13:30', 's1', SONNET, { output_tokens: 3, cache_read_input_tokens: 4000 }, tool('tu5', 'Edit', editInput), null),
  result('10:13:31', 'tu5'),
  asst('10:14:00', 's2', SONNET, { output_tokens: 50, cache_read_input_tokens: 5000, cache_creation_input_tokens: 30000 },
    { type: 'text', text: 'fixed' }, 'end_turn'),
]));
writeFileSync(join(projects, A, 'subagents', 'agent-1.meta.json'), JSON.stringify({ description: 'fix b', model: 'sonnet' }));
mkdirSync(join(projects, A, 'tool-results'), { recursive: true });
writeFileSync(join(projects, A, 'tool-results', 'x.jsonl'), 'not a transcript\n'); // must be skipped

// ---- worker 02: one message, then a torn last line
writeFileSync(join(projects, `${B}.jsonl`), jsonl([
  user('11:00:00', 'hello'),
  asst('11:00:05', 'b1', OPUS, { output_tokens: 10, cache_read_input_tokens: 500 }, { type: 'text', text: 'hi' }, 'end_turn'),
]) + '{"type":"assistant","timestamp":"2026-01-01T11:00:0');

// ---- coordinator, in another project folder: found by the search
mkdirSync(join(cfg, 'projects', 'elsewhere'), { recursive: true });
writeFileSync(join(cfg, 'projects', 'elsewhere', `${C}.jsonl`), jsonl([
  user('09:00:00', 'plan'),
  asst('09:00:30', 'c1', OPUS, { input_tokens: 100, output_tokens: 1000 }, { type: 'text', text: 'plan' }, 'end_turn'),
]));

const script = join(dirname(resolve(process.argv[1] ?? '.')), 'fleet-analyze.ts');
const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
const res = spawnSync(process.execPath, [script, run, '--json'], { encoding: 'utf8', env, maxBuffer: 64e6 });
if (res.status !== 0) { console.log(`FAIL fleet-analyze exited ${res.status}: ${res.stderr}`); failed++; }
let r: Report | null = null;
try { r = JSON.parse(res.stdout) as Report; } catch { console.log(`FAIL output is not JSON: ${res.stdout.slice(0, 300)}`); failed++; }

if (r) {
  check('tasks done', [r.tasks.done, r.tasks.claimed], [1, 1]);
  check('task minutes', r.tasks.median_min, 30);
  // Split of 1800 s: model 42 parent + 59 subagent = 101; read 3; tests 60; edit 1; operator 620;
  // waiting on the subagent 60 (12:00-13:00) + 5 (14:00-14:05) = 65; nothing recorded 950 (14:10-30:00).
  check('total minutes', r.time.total_min, 30, 1e-9);
  check('model', r.time.split_min['model'], +(101 / 60).toFixed(1));
  check('tests', r.time.split_min['tests'], 1);
  check('operator wait', r.time.buckets_min['waits on operator'], +(620 / 60).toFixed(1));
  check('other waits', r.time.buckets_min['other waits'], +(1015 / 60).toFixed(1));
  check('no outage', r.time.buckets_min['outages >45m'], 0);
  check('other tools', r.time.buckets_min['other tools'], +(4 / 60).toFixed(1));
  // turns: parent 5, subagent 2, worker 02 1; one tool call in m1, m2, m3, s1; m2 is a read after a read
  check('turns', [r.habits.turns, r.habits.oneTool, r.habits.mergeable], [8, 4, 1]);
  check('re-reads', [r.habits.reads, r.habits.rereads], [2, 1]);
  check('subagents', [r.subagents.count, r.subagents.median_min, r.subagents.median_first_edit_min], [1, 1, 0.5]);
  check('cache misses', [r.cache_misses.count, r.cache_misses.tokens], [1, 50000]);
  check('cache miss extra $', r.cache_misses.extra_usd, 50000 * (8 - 0.2) / 1e6);
  const p = r.tokens.workers_parent;
  check('parent tokens, m1 counted once', [p.msgs, p.in, p.out, p.cr, p.c1h], [6, 10, 370, 10500, 50000]);
  const s = r.tokens.workers_subagents;
  check('subagent tokens', [s.out, s.cr, s.c5, s.c1h], [s1Out + 50, 9000, 30000, 0]);
  const parentUsd = (10 * 4 + 370 * 20 + 10500 * 0.2 + 50000 * 8) / 1e6;
  const subUsd = ((s1Out + 50) * 10 + 9000 * 0.2 + 30000 * 2.5) / 1e6;
  const coordUsd = (100 * 4 + 1000 * 20) / 1e6;
  check('parent $', p.cost, parentUsd, 1e-9);
  check('subagent $ at Sonnet prices', s.cost, subUsd, 1e-9);
  check('coordinator found elsewhere', [r.tokens.coordinator.msgs, r.tokens.coordinator.cost], [1, coordUsd]);
  check('total $', r.cost.total_usd, parentUsd + subUsd + coordUsd, 1e-9);
  // the task window holds every message of worker 01; worker 02's message is outside any task
  const w02 = (10 * 20 + 500 * 0.2) / 1e6;
  check('task $', r.per_task[0]?.cost, +(parentUsd - w02 + subUsd).toFixed(2));
  check('missing transcript', r.missing_transcripts, [{ sid: GONE, chip: '03' }]);
  check('torn line skipped', r.bad_lines, 1);
}

// --prices overrides one field of one model and keeps the rest
const pf = join(tmp, 'prices.json');
writeFileSync(pf, JSON.stringify({ 'claude-sonnet-5-5': { out: 0 } }));
const res2 = spawnSync(process.execPath, [script, run, '--json', '--prices', pf], { encoding: 'utf8', env, maxBuffer: 64e6 });
try {
  const r2 = JSON.parse(res2.stdout) as Report;
  check('--prices override', r2.tokens.workers_subagents.cost, (9000 * 0.2 + 30000 * 2.5) / 1e6, 1e-9);
} catch { console.log(`FAIL --prices run: ${res2.stderr}`); failed++; }

// the human report prints and stays short
const res3 = spawnSync(process.execPath, [script, run], { encoding: 'utf8', env });
check('report exit', res3.status, 0);
check('report names the task count', res3.stdout.includes('tasks done 1 of 1'), true);
check('report under 40 lines', res3.stdout.trim().split('\n').length <= 40, true);

// a run with nothing in it fails with a message instead of a stack trace
const empty = join(root, '.fleet', 'empty');
mkdirSync(empty, { recursive: true });
const res4 = spawnSync(process.execPath, [script, empty], { encoding: 'utf8', env });
check('empty run exit', res4.status, 1);
check('empty run message', res4.stderr.includes('nothing to analyze'), true);

rmSync(tmp, { recursive: true, force: true });
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
