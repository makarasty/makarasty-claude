#!/usr/bin/env node
// tune-selftest.mjs - the parts of tune.mjs a wrong line would silently skew: prices, verdicts, linking,
// blame ranges, the sealed draw, confound check, scoring and the run-to-run diff. `node tune-selftest.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parsePrices, findAnalyze, priceOf, costOf, verdict, keyOf, linkTasks, parseU0, parseLog, rng, selectCandidates,
  checkArms, parseArms, tally, parseRoleTable, diffTables, median, CORRECTION_RE,
  resolveModel, planEstimate, sealMap, cloneDestProblem,
} from './tune.mjs';

const SRC = `const PRICES = {
  'claude-big-5': { in: 5, out: 25, cr: 0.5, w5m: 6.25, w1h: 10 },
  'claude-big-5-5': { in: 4, out: 20, cr: 0.2, w5m: 5, w1h: 8 }, // comment
};
const other = { 'x': { in: 1, out: 1, cr: 1, w5m: 1, w1h: 1 } };`;

test('prices: parsed from the table only, longest prefix wins, unknown model stays unpriced', () => {
  const p = parsePrices(SRC);
  assert.deepEqual(Object.keys(p), ['claude-big-5', 'claude-big-5-5']);
  assert.equal(priceOf(p, 'claude-big-5-5-20261101').in, 4);
  assert.equal(priceOf(p, 'claude-big-5').in, 5);
  assert.equal(costOf(p, { model: 'claude-new-1', in: 1e6, out: 0, cr: 0, c5: 0, c1: 0 }), null);
  const c = costOf(p, { model: 'claude-big-5-5', in: 1e6, out: 1e6, cr: 1e6, c5: 1e6, c1: 1e6 });
  assert.equal(c, 4 + 20 + 0.2 + 5 + 8);
  assert.equal(costOf(p, { model: 'claude-big-5-5', in: 1e6, out: 0, cr: 0, c5: 0, c1: 0, fast: true }), 8);
});

test('prices: the real fleet-analyze table parses', (t) => {
  const f = findAnalyze();
  if (!f) return t.skip('fleet-analyze.mjs not found');
  const p = parsePrices(fs.readFileSync(f, 'utf8'));
  assert.ok(p && Object.keys(p).length >= 3, 'PRICES table not parsed: its line format changed');
  for (const v of Object.values(p)) assert.ok(v.out > v.in && v.in > 0);
});

test('verdict and task key', () => {
  assert.deepEqual(verdict('Verdict: PASS\nno findings'), { n: 0, pass: true });
  assert.deepEqual(verdict('Findings:\n1. a.ts:3 null deref\n2. b.ts:9 race\n- **c** missing check'), { n: 3, pass: false });
  assert.equal(keyOf('Fix task-12b in queue'), '12');
  assert.equal(keyOf('coder t7 retry'), 't7');
  assert.equal(keyOf('just words'), null);
});

test('linkTasks: fix round joins its task, review attaches by key or files', () => {
  const ev = [
    { kind: 'C', ts: 1, key: 't1', efiles: ['src/a.ts', 'src/b.ts'], pfiles: [] },
    { kind: 'R', ts: 2, key: null, efiles: [], pfiles: ['src/a.ts'] },
    { kind: 'C', ts: 3, key: null, efiles: ['src/a.ts', 'src/b.ts'], pfiles: [] },
    { kind: 'R', ts: 4, key: 't1', efiles: [], pfiles: [] },
    { kind: 'C', ts: 5, key: 't2', efiles: ['lib/z.ts'], pfiles: [] },
  ];
  const t = linkTasks(ev);
  assert.equal(t.length, 2);
  assert.equal(t[0].coders.length, 2);
  assert.equal(t[0].reviews.length, 2);
  assert.equal(t[1].reviews.length, 0);
});

test('parseU0 keeps changed old ranges, skips pure inserts and new files', () => {
  const d = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -10,2 +10,3 @@', '@@ -20,0 +22,1 @@', '@@ -30 +31 @@',
    '--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1,5 @@'].join('\n');
  assert.deepEqual(parseU0(d), [{ file: 'x.ts', start: 10, count: 2 }, { file: 'x.ts', start: 30, count: 1 }]);
});

test('parseLog drops lockfiles and build output from size', () => {
  const log = ['@@aaa\tppp\t100\tfix: crash', '', '10\t5\tsrc/a.ts', '900\t0\tpackage-lock.json', '-\t-\timg.png', '3\t0\tdist/x.js'].join('\n');
  const [c] = parseLog(log);
  assert.equal(c.size, 15);
  assert.deepEqual(c.files, ['src/a.ts']);
  assert.equal(c.ts, 100000);
});

test('selectCandidates: quotas, fill from others, same seed same pick', () => {
  const mk = (cat, k) => Array.from({ length: k }, (_, i) => ({ sha: `${cat}${i}`, category: cat }));
  const cands = [...mk('fix', 2), ...mk('multi', 10), ...mk('control', 10)];
  const a = selectCandidates(cands, 10, rng('s1'));
  const count = (c) => a.filter((x) => x.category === c).length;
  assert.equal(a.length, 10);
  assert.equal(count('fix'), 2);
  assert.equal(count('multi') + count('control'), 8);
  assert.ok(count('multi') >= 3);
  assert.deepEqual(a.map((x) => x.sha), selectCandidates(cands, 10, rng('s1')).map((x) => x.sha));
  assert.deepEqual(a.map((x) => x.id), ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10']);
});

test('checkArms flags model+effort confound unless bridged', () => {
  assert.equal(checkArms(parseArms('sonnet:medium,opus:high')).length, 1);
  assert.equal(checkArms(parseArms('sonnet:medium,opus:high,opus:medium')).length, 0);
  assert.equal(checkArms(parseArms('opus:high,opus:medium,sonnet:high')).length, 0);
});

test('tally: weighted real, false, known bugs only on diffs that have one', () => {
  const answers = { items: [{ id: '01', known_bug: null }, { id: '02', known_bug: { file_line: 'a:1' } }] };
  const judges = {
    '01': { defects: [{ real: 'REAL', severity: 'high', found_by: ['A'] }, { real: 'FALSE', severity: 'low', found_by: ['B'] }], known_bug: { caught_by: ['A'] } },
    '02': { defects: [{ real: 'REAL', severity: 'low', found_by: ['A', 'B'] }, { real: 'UNSURE', found_by: ['B'] }], known_bug: { caught_by: ['B'] } },
  };
  const t = tally(judges, answers);
  assert.deepEqual(t.A, { real: 2, weighted: 4, false: 0, unsure: 0, known: 0, knownOf: 1 });
  assert.deepEqual(t.B, { real: 1, weighted: 1, false: 1, unsure: 1, known: 1, knownOf: 1 });
});

test('role table diff and small helpers', () => {
  const now = parseRoleTable('| role | model | effort | evidence |\n|---|---|---|---|\n| main chat | opus | high | x |\n| coder | sonnet | high | y |\n| judge | opus | high | z |');
  const was = parseRoleTable('| role | model | effort | evidence |\n|---|---|---|---|\n| main chat | opus | high | x |\n| coder | opus | high | y |\n| scout | haiku | low | w |');
  assert.deepEqual(diffTables(now, was), ['~ coder: opus high -> sonnet high', '+ judge: opus high', '- scout: was haiku low']);
  assert.equal(median([3, 1, 2, 10]), 2.5);
  assert.ok(CORRECTION_RE.test('ты уверен? перепроверь'));
  assert.ok(!CORRECTION_RE.test('не торопись'));
});

const P2 = {
  'claude-small-4-5': { in: 1, out: 5, cr: 0.1, w5m: 1.25, w1h: 2 },
  'claude-small-5-5': { in: 0.1, out: 0.5, cr: 0.01, w5m: 0.125, w1h: 0.2 },
  'claude-big-5-5': { in: 4, out: 20, cr: 0.2, w5m: 5, w1h: 8 },
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tune-test-'));

test('resolveModel: exact id first, else the newest matching key', () => {
  assert.equal(resolveModel(P2, 'small'), 'claude-small-5-5');
  assert.equal(resolveModel(P2, 'claude-small-4-5'), 'claude-small-4-5');
  assert.equal(resolveModel(P2, 'nothing'), null);
});

test('planEstimate: an unpriced arm or judge is reported, never summed as $0', () => {
  const ok = planEstimate(P2, [], parseArms('big:high,small:high'), parseArms('big:high')[0], 10, 0);
  assert.deepEqual(ok.unpriced, []);
  assert.ok(ok.total > 0);
  const hist = [{ key: 'makarasty:fleet-reviewer|small-5-5-20261001|high', n: 5, medianUsd: 0.07 }];
  assert.match(planEstimate(P2, hist, parseArms('small:high,big:high'), parseArms('big:high')[0], 1, 0).lines[1], /history small-5-5/);
  assert.deepEqual(planEstimate(P2, [], parseArms('newmodel:high,big:high'), parseArms('big:high')[0], 10, 0).unpriced, ['newmodel:high']);
  assert.deepEqual(planEstimate(P2, [], parseArms('small:high,big:high'), parseArms('ghost:high')[0], 10, 0).unpriced, ['judge ghost:high']);
});

test('sealMap: a second plan refuses; --force-new-run moves the old map and reviews aside', () => {
  const run = tmp();
  try {
    const arms = parseArms('big:high,small:high');
    const m1 = sealMap(run, arms, false, 's1');
    fs.mkdirSync(path.join(run, 'blind', '01-' + Object.keys(m1)[0]), { recursive: true });
    fs.mkdirSync(path.join(run, 'blind', '01'), { recursive: true });
    assert.throws(() => sealMap(run, arms, false, 's2'), /planned already/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(run, 'review', 'sealed', 'map.json'), 'utf8')), m1);
    sealMap(run, arms, true, 's2');
    assert.deepEqual(fs.readdirSync(path.join(run, 'blind')), ['01']); // the per-diff template stays, reviewer folders go
    const old = fs.readdirSync(run).find((d) => d.startsWith('old-'));
    assert.ok(fs.existsSync(path.join(run, old, 'map.json')));
  } finally { fs.rmSync(run, { recursive: true, force: true }); }
});

test('cloneDestProblem: inside the source repo, through a junction, existing, missing parent', (t) => {
  const base = tmp();
  const repo = path.join(base, 'repo'), target = path.join(base, 'elsewhere'), link = path.join(base, 'link');
  fs.mkdirSync(repo); fs.mkdirSync(target);
  try {
    assert.match(cloneDestProblem(repo, path.join(repo, 'bench')), /inside the source repo/);
    assert.match(cloneDestProblem(repo, repo), /exists/);
    assert.match(cloneDestProblem(repo, path.join(base, 'no', 'x')), /parent folder missing/);
    assert.equal(cloneDestProblem(repo, path.join(base, 'clone')), null);
    try { fs.symlinkSync(target, link, 'junction'); } catch { t.diagnostic('no junction support here; junction case skipped'); return; }
    assert.match(cloneDestProblem(repo, path.join(link, 'clone')), /junction or symlink/);
  } finally {
    if (fs.existsSync(link)) fs.unlinkSync(link); // the link only, never what it points to
    fs.rmSync(base, { recursive: true, force: true });
  }
});
