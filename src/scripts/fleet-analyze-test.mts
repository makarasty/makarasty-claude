#!/usr/bin/env node
// fleet-analyze-test.mts - builds a tiny run and its transcripts in a temp dir and checks what
// fleet-analyze.mjs reads out of them. Every expected number below is worked out by hand in the comments,
// so a change to the split or the pricing shows up as a named failure rather than a different report.
//
//   node scripts/fleet-analyze-test.mjs       prints "N passed, M failed", exit 0 only when M is 0

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
  pauses: { source: string; paused_min: number };
  context: { carry_over: { share: number; tokens: number }; subagent_start: { by_type: Record<string, { n: number; median: number }> } };
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

const script = join(dirname(resolve(process.argv[1] ?? '.')), 'fleet-analyze.mjs');
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
  const subUsd = ((s1Out + 50) * 10 + 9000 * 0.1 + 30000 * 2.5) / 1e6;
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
  check('--prices override', r2.tokens.workers_subagents.cost, (9000 * 0.1 + 30000 * 2.5) / 1e6, 1e-9);
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

// ---- a 600-minute pause is paused, not an outage. Run p1, chip 05: task t1 12:00:00-22:00:20 waits in its
// wake loop from 12:00:10 to 22:00:10, which prints `resumed`; task t2 22:00:30-22:01:00 has one turn.
const P = 'eeeeeeee-0000-4000-8000-000000000005';
const prun = join(root, '.fleet', 'p1');
mkdirSync(join(prun, 'chips'), { recursive: true });
writeFileSync(join(prun, 'chips', P), '05\n');
for (const [id, from, to] of [['t1', '12:00:00', '22:00:20'], ['t2', '22:00:30', '22:01:00']] as const) {
  mkdirSync(join(prun, 'tasks', 'claimed', id), { recursive: true });
  mkdirSync(join(prun, 'tasks', 'done'), { recursive: true });
  writeFileSync(join(prun, 'tasks', 'claimed', id, 'owner'), `chip 05\nclaimed ${at(from)}\n`);
  writeFileSync(join(prun, 'tasks', 'done', id), '');
  utimesSync(join(prun, 'tasks', 'done', id), sec(to), sec(to));
}
mkdirSync(join(projects, P, 'subagents'), { recursive: true });
writeFileSync(join(projects, `${P}.jsonl`), jsonl([
  user('12:00:00', 'work task t1'),
  asst('12:00:10', 'p1', OPUS, { cache_read_input_tokens: 10000 }, tool('tw', 'Bash', { command: 'until [ ! -e PAUSED ]; do sleep 30; done; echo resumed' })),
  result('22:00:10', 'tw', 'resumed\n'), // the wake loop's last line: resume evidence for the notes fallback
  asst('22:00:20', 'p2', OPUS, { cache_read_input_tokens: 10000 }, { type: 'text', text: 'done' }, 'end_turn'),
  // t2's first turn reads 30k, 20k more than t1's first: carry-over 20k x 1 turn of 50k cache read = 40%
  asst('22:00:40', 'p3', OPUS, { cache_read_input_tokens: 30000 }, { type: 'text', text: 't2' }, 'end_turn'),
]));
// One fleet coder whose first prompt is 40k.
writeFileSync(join(projects, P, 'subagents', 'agent-c.jsonl'), jsonl([
  user('22:00:31', 'fix t2'),
  asst('22:00:35', 'c1', SONNET, { input_tokens: 5, cache_read_input_tokens: 30000, cache_creation_input_tokens: 9995 }, { type: 'text', text: 'ok' }, 'end_turn'),
]));
writeFileSync(join(projects, P, 'subagents', 'agent-c.meta.json'), JSON.stringify({ agentType: 'makarasty:fleet-coder' }));
const runP = (): Report | null => {
  const x = spawnSync(process.execPath, [script, prun, '--json'], { encoding: 'utf8', env, maxBuffer: 64e6 });
  try { return JSON.parse(x.stdout) as Report; } catch { console.log(`FAIL pause run: ${x.stderr}`); failed++; return null; }
};
writeFileSync(join(prun, 'pauses.log'), `paused ${at('12:00:10')} operator asked\nresumed ${at('22:00:10')}\n`);
let rp = runP();
if (rp) {
  check('pauses.log: outage', rp.time.buckets_min['outages >45m'], 0);
  check('pauses.log: paused 600 min', rp.time.buckets_min['paused'], 600);
  check('pauses.log: source', rp.pauses.source, 'pauses.log');
  check('carry-over share', [rp.context.carry_over.tokens, rp.context.carry_over.share], [20000, 0.4]);
  check('fleet coder first-turn context', rp.context.subagent_start.by_type['makarasty:fleet-coder'], { n: 1, median: 40000 });
}
// No log: the chip's ack in its notes, paired with the wake loop's `resumed`, gives the same window.
rmSync(join(prun, 'pauses.log'));
writeFileSync(join(prun, '05.notes.md'), `stopped (paused ${at('12:00:10')}): before t1 step 2\n`);
rp = runP();
if (rp) check('notes fallback: outage 0, paused 600', [rp.time.buckets_min['outages >45m'], rp.time.buckets_min['paused'], rp.pauses.source], [0, 600, 'notes']);
// Two acks before one resume cannot be paired without a guess: no window, the stretch stays an outage.
writeFileSync(join(prun, '05.notes.md'), `stopped (paused ${at('12:00:10')}): a\nstopped (paused ${at('13:00:00')}): b\n`);
rp = runP();
if (rp) check('ambiguous notes: no pause, an outage', [rp.time.buckets_min['paused'], rp.time.buckets_min['outages >45m'] > 590], [0, true]);

// ---- a relaunched run: `coordinator` names only the last coordinator. Two earlier ones are found by their
// `<run> --take-over` text, one in the project folder, one in a worktree's folder (with a subagent); a chat
// that only mentions the run is not a coordinator (a quote in text is not a call, nor is a call for another run).
const K1 = 'f1111111-0000-4000-8000-000000000011', K2 = 'f2222222-0000-4000-8000-000000000012';
const K3 = 'f3333333-0000-4000-8000-000000000013', DECOY = 'f4444444-0000-4000-8000-000000000014';
const rrun = join(root, '.fleet', 'rel');
mkdirSync(join(rrun, 'chips'), { recursive: true });
writeFileSync(join(rrun, 'chips', P), '05\n'); // a worker with a transcript, so there is something to analyze
writeFileSync(join(rrun, 'coordinator'), K3 + '\n');
const wt = `${projects}--claude-worktrees-wt`;
// With `cmd` the coordinator ran it in a Bash call (what makes a coordinator); `text` alone is only said or quoted.
const coordRows = (text: string, id: string, cmd?: string): string => jsonl([
  user('09:00:00', text),
  asst('09:00:30', id, OPUS, { input_tokens: 100, output_tokens: 1000 }, cmd ? tool('t' + id, 'Bash', { command: cmd }) : { type: 'text', text: 'ok' }, 'end_turn'),
]);
writeFileSync(join(projects, `${K1}.jsonl`), coordRows('relaunch', 'k1', `sh fleet.sh resume ${rrun} --take-over`));
mkdirSync(join(wt, K2, 'subagents'), { recursive: true });
writeFileSync(join(wt, `${K2}.jsonl`), coordRows('relaunch', 'k2', `sh fleet.sh resume "${rrun}" --take-over`)); // quoted: a Windows path is JSON-escaped in the transcript
writeFileSync(join(wt, K2, 'subagents', 'agent-k.jsonl'), jsonl([
  user('09:01:00', 'review'),
  asst('09:01:10', 'ks', SONNET, { output_tokens: 50 }, { type: 'text', text: 'ok' }, 'end_turn'),
]));
writeFileSync(join(wt, `${K3}.jsonl`), coordRows('the latest coordinator, named by the coordinator file', 'k3'));
writeFileSync(join(projects, `${DECOY}.jsonl`), coordRows(`please look at ${rrun} --take-over`, 'k4'));
writeFileSync(join(projects, 'f5555555-0000-4000-8000-000000000015.jsonl'), coordRows('relaunch', 'k5', `sh fleet.sh resume ${rrun}2 --take-over`)); // another run's name
const xr = spawnSync(process.execPath, [script, rrun, '--json'], { encoding: 'utf8', env, maxBuffer: 64e6 });
try {
  const rr = JSON.parse(xr.stdout) as Report & { coordinator_sessions: number };
  check('relaunched run: three coordinator sessions', rr.coordinator_sessions, 3);
  check('relaunched run: coordinator tokens', [rr.tokens.coordinator.msgs, rr.tokens.coordinator.out], [4, 3 * 1000 + 50]);
  check('relaunched run: coordinator $', rr.tokens.coordinator.cost, (3 * (100 * 4 + 1000 * 20) + 50 * 10) / 1e6, 1e-9);
} catch { console.log(`FAIL relaunched run: ${xr.stderr}`); failed++; }

// ---- a transcript too big to hold as one string is scanned line by line, not skipped
const brun = join(root, '.fleet', 'big');
mkdirSync(join(brun, 'chips'), { recursive: true });
writeFileSync(join(brun, 'chips', P), '05\n');
writeFileSync(join(brun, 'coordinator'), 'f6666666-0000-4000-8000-000000000016\n');
const pad = `{"type":"x","pad":"${'x'.repeat(1e6)}"}\n`;
const KB = 'f7777777-0000-4000-8000-000000000017';
writeFileSync(join(projects, `${KB}.jsonl`), coordRows('relaunch', 'kb', `sh fleet.sh resume ${brun} --take-over`) + pad.repeat(66));
const br = spawnSync(process.execPath, [script, brun, '--json'], { encoding: 'utf8', env, maxBuffer: 64e6 });
try { check('a transcript over 64 MB is still searched for its take-over line', (JSON.parse(br.stdout) as { coordinator_sessions: number }).coordinator_sessions, 1); }
catch { console.log(`FAIL big transcript: ${br.stderr}`); failed++; }
rmSync(join(projects, `${KB}.jsonl`));

// ---- a coordinator file that names no session says so
const nrun = join(root, '.fleet', 'note');
mkdirSync(join(nrun, 'chips'), { recursive: true });
writeFileSync(join(nrun, 'chips', P), '05\n');
writeFileSync(join(nrun, 'coordinator'), 'not-a-session\n');
const nr = spawnSync(process.execPath, [script, nrun], { encoding: 'utf8', env });
check('a coordinator file naming no session is noted', nr.stdout.includes('note: the coordinator file names "not-a-session"'), true);

// ---- a fork of a coordinator repeats its records (same uuids and message ids), take-over call included; a chat
// quoting the command is no coordinator either. One source, one fork, one quoter: one coordinator session, counted once.
const SRC = 'a9999999-0000-4000-8000-000000000019', FRK = 'b9999999-0000-4000-8000-000000000020', QUO = 'c9999999-0000-4000-8000-000000000021';
const frun = join(root, '.fleet', 'fork');
mkdirSync(join(frun, 'chips'), { recursive: true });
writeFileSync(join(frun, 'chips', P), '05\n');
const withUuid = (text: string, id: string, cmd: string): string => jsonl([
  { ...user('09:00:00', text), uuid: 'u-' + id + '-1' },
  { ...asst('09:00:30', id, OPUS, { input_tokens: 100, output_tokens: 1000 }, tool('t' + id, 'Bash', { command: cmd }), 'end_turn'), uuid: 'u-' + id + '-2' },
]);
const takeOver = `sh fleet.sh resume ${frun} --take-over`;
const srcText = withUuid('relaunch', 'fs', takeOver);
writeFileSync(join(projects, `${SRC}.jsonl`), srcText);
writeFileSync(join(projects, `${FRK}.jsonl`), srcText + jsonl([{ ...user('09:05:00', 'judge this'), uuid: 'u-fork-own' }]));
writeFileSync(join(projects, `${QUO}.jsonl`), jsonl([
  user('09:00:00', `the old coordinator ran ${takeOver}`),
  result('09:00:10', 'tq', takeOver),
  asst('09:00:30', 'fq', OPUS, { input_tokens: 100, output_tokens: 1000 }, { type: 'text', text: takeOver }, 'end_turn'),
]));
const fr = spawnSync(process.execPath, [script, frun, '--json'], { encoding: 'utf8', env, maxBuffer: 64e6 });
try {
  const f = JSON.parse(fr.stdout) as Report & { coordinator_sessions: number };
  check('fork + quote: one coordinator session', f.coordinator_sessions, 1);
  check('fork + quote: cost counted once', [f.tokens.coordinator.msgs, f.tokens.coordinator.cost], [1, (100 * 4 + 1000 * 20) / 1e6], 1e-9);
} catch { console.log(`FAIL fork run: ${fr.stderr}`); failed++; }

// ---- a one-chat run: no worker chats, the coordinator's subagents are the workers. Two subagents (a fleet-coder on
// Opus, a fleet-reviewer on Sonnet); the reviewer has a grandchild (a fleet-coder on Sonnet) one level down.
const OC = 'f8888888-0000-4000-8000-000000000018';
const orun = join(root, '.fleet', 'one');
mkdirSync(join(orun, 'chips'), { recursive: true });
writeFileSync(join(orun, 'coordinator'), OC + '\n');
mkdirSync(join(orun, 'tasks', 'claimed', 'o1'), { recursive: true });
mkdirSync(join(orun, 'tasks', 'done'), { recursive: true });
writeFileSync(join(orun, 'tasks', 'claimed', 'o1', 'owner'), `chip 09\nclaimed ${at('09:00:00')}\n`);
writeFileSync(join(orun, 'tasks', 'done', 'o1'), '');
utimesSync(join(orun, 'tasks', 'done', 'o1'), sec('09:10:00'), sec('09:10:00'));
const subDir = join(projects, OC, 'subagents');
mkdirSync(join(subDir, 'agent-y', 'subagents'), { recursive: true });
const oneMsg = (id: string, model: string, out: number): string => jsonl([
  user('09:01:00', 'go'),
  asst('09:01:30', id, model, { output_tokens: out }, { type: 'text', text: 'ok' }, 'end_turn'),
]);
writeFileSync(join(projects, `${OC}.jsonl`), coordRows('coordinate', 'oc'));
writeFileSync(join(subDir, 'agent-x.jsonl'), oneMsg('ox', OPUS, 100));
writeFileSync(join(subDir, 'agent-x.meta.json'), JSON.stringify({ agentType: 'makarasty:fleet-coder' }));
writeFileSync(join(subDir, 'agent-y.jsonl'), oneMsg('oy', SONNET, 200));
writeFileSync(join(subDir, 'agent-y.meta.json'), JSON.stringify({ agentType: 'makarasty:fleet-reviewer' }));
writeFileSync(join(subDir, 'agent-y', 'subagents', 'agent-z.jsonl'), oneMsg('oz', SONNET, 300));
writeFileSync(join(subDir, 'agent-y', 'subagents', 'agent-z.meta.json'), JSON.stringify({ agentType: 'makarasty:fleet-coder' }));
const orr = spawnSync(process.execPath, [script, orun, '--json'], { encoding: 'utf8', env, maxBuffer: 64e6 });
try {
  const o = JSON.parse(orr.stdout) as Report & { one_chat: boolean; coordinator_subagents: { count: number; by_type_model: { type: string; model: string; agents: number; cost: number }[] } };
  const oc = o.coordinator_subagents;
  check('one-chat: mode and subagent count', [o.one_chat, oc.count], [true, 3]);
  check('one-chat: workers are the subagents', [o.tokens.workers_subagents.msgs, o.tokens.workers_subagents.out, o.tokens.workers_parent.msgs], [3, 600, 0]);
  check('one-chat: worker $', o.tokens.workers_subagents.cost, (100 * 20 + 200 * 10 + 300 * 10) / 1e6, 1e-9);
  check('one-chat: coordinator is only its own turns', [o.tokens.coordinator.msgs, o.tokens.coordinator.cost], [1, (100 * 4 + 1000 * 20) / 1e6]);
  const row = (t: string, m: string) => oc.by_type_model.find((g) => g.type === t && g.model === m);
  check('one-chat: fleet-coder on Opus', [row('makarasty:fleet-coder', OPUS)?.agents, row('makarasty:fleet-coder', OPUS)?.cost], [1, 100 * 20 / 1e6]);
  check('one-chat: grandchild fleet-coder on Sonnet', [row('makarasty:fleet-coder', SONNET)?.agents, row('makarasty:fleet-coder', SONNET)?.cost], [1, 300 * 10 / 1e6]);
  check('one-chat: fleet-reviewer on Sonnet', [row('makarasty:fleet-reviewer', SONNET)?.agents, row('makarasty:fleet-reviewer', SONNET)?.cost], [1, 200 * 10 / 1e6]);
  check('one-chat: total $', o.cost.total_usd, (100 * 4 + 1000 * 20 + 100 * 20 + 200 * 10 + 300 * 10) / 1e6, 1e-9);
} catch { console.log(`FAIL one-chat run: ${orr.stderr}`); failed++; }

rmSync(tmp, { recursive: true, force: true });
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
