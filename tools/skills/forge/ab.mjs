#!/usr/bin/env node
// ab.mjs - does a tool, or one line of it, change what a model does? Runs every prompt in every arm with
// headless `claude -p`, each run in a fresh empty folder with no user settings, plugins, CLAUDE.md or memory,
// and scores the final reply against the prompt's own regexes. Pass `--model` as the model that will use
// the tool; the default `sonnet` is an alias.
//
//   node ab.mjs <cases.json> [--runs 2] [--model sonnet] [--budget 0.5] [--out <dir>] [--dry]
//   node ab.mjs --selftest
//
// cases.json:
//   { "arms": { "A": [], "B": ["--plugin-dir", "C:/path/to/plugin"] },
//     "prompts": [ { "id": "ru-commit", "text": "закоммить от меня", "expect": "commit", "forbid": "push" } ] }
// An arm is the extra `claude` arguments it adds: a plugin dir, `--append-system-prompt-file` with a draft
// line, a copy of the skill with one line deleted (the ablation). `expect` and `forbid` are case-insensitive
// regexes over the reply; leave both out to only compare cost and length. `--budget` caps each run in USD.
// Results: <out>/runs.jsonl (one line per run, the reply included) and a summary per arm on stdout.
//
// shortcut: scores the final reply only, not the tool calls; when the behaviour is a tool call, put the
// call in the prompt's question ("which command would you run?") or use `claude plugin eval` (Linux/WSL).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

export function score(reply, p, error) {
    const t = String(reply ?? '');
    const ok = !error && (!p.expect || new RegExp(p.expect, 'i').test(t)) && !(p.forbid && new RegExp(p.forbid, 'i').test(t));
    return { pass: ok, words: t.split(/\s+/).filter(Boolean).length };
}

export function summarize(rows) {
    const by = {};
    for (const r of rows) (by[r.arm] ??= []).push(r);
    const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
    return Object.entries(by).map(([arm, rs]) => ({
        arm, runs: rs.length, pass: rs.filter(r => r.pass).length, errors: rs.filter(r => r.error).length,
        cost: +mean(rs.map(r => r.cost)).toFixed(4), words: Math.round(mean(rs.map(r => r.words))),
        outTokens: Math.round(mean(rs.map(r => r.outTokens))),
    }));
}

function selftest() {
    const p = { expect: 'коммит|commit', forbid: 'push' };
    assert.equal(score('Сделаю коммит', p).pass, true, 'expect matches, any case');
    assert.equal(score('commit and push', p).pass, false, 'forbid wins');
    assert.equal(score('nothing', p).pass, false, 'expect missing fails');
    assert.deepEqual(score(undefined, {}), { pass: true, words: 0 }, 'no regex passes');
    assert.equal(score(undefined, {}, 'budget hit').pass, false, 'a run that errored never passes');
    const s = summarize([{ arm: 'A', pass: true, cost: 0.1, words: 10, outTokens: 5 }, { arm: 'A', pass: false, cost: 0.3, words: 20, outTokens: 15, error: 'x' }]);
    assert.deepEqual([s[0].pass, s[0].errors, s[0].cost, s[0].words], [1, 1, 0.2, 15], 'summary means');
    assert.equal(winArg('say "hi"'), '"say \\"hi\\""', 'one quoted cmd argument');
    console.log('ab.mjs selftest done');
}

function main(argv) {
    if (argv[0] === '--selftest') return selftest();
    const flag = (n, d) => { const i = argv.indexOf(n); return i < 0 ? d : argv[i + 1]; };
    if (!argv[0] || argv[0].startsWith('--')) { console.error('usage: node ab.mjs <cases.json> [--runs 2] [--model sonnet] [--budget 0.5] [--out dir] [--dry]'); process.exit(2); }
    const cases = JSON.parse(readFileSync(argv[0], 'utf8'));
    const runs = Number(flag('--runs', 2)), model = flag('--model', 'sonnet'), budget = flag('--budget', '0.5');
    const out = resolve(flag('--out', join(tmpdir(), `ab-${Date.now()}`)));
    const dry = argv.includes('--dry');
    if (!(runs >= 1)) { console.error(`--runs must be a number from 1`); process.exit(2); }
    for (const p of cases.prompts) for (const k of ['expect', 'forbid']) if (p[k]) new RegExp(p[k], 'i'); // a bad regex fails here, before any paid run
    mkdirSync(out, { recursive: true });
    const rows = [];
    for (const p of cases.prompts) for (const [arm, extra] of Object.entries(cases.arms)) for (let i = 0; i < runs; i++) {
        const args = ['-p', '--model', model, '--output-format', 'json', '--setting-sources', 'project', '--no-session-persistence', '--max-budget-usd', String(budget), ...extra];
        if (dry) { console.log(`[${arm}] ${p.id}#${i}: claude ${args.join(' ')}  <<< ${p.text.slice(0, 60)}`); continue; }
        const cwd = mkdtempSync(join(tmpdir(), 'ab-run-')); // empty: no project settings, no CLAUDE.md
        // --setting-sources still loads ~/.claude/CLAUDE.md and writes a memory folder per run; both off.
        const env = { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
        const opts = { cwd, env, input: p.text, encoding: 'utf8', timeout: 600000, maxBuffer: 64 << 20 };
        let r = spawnSync('claude', args, opts);
        // An npm install is claude.cmd, which only a shell resolves on Windows.
        if (r.error?.code === 'ENOENT' && process.platform === 'win32') r = spawnSync('claude.cmd', args.map(winArg), { ...opts, shell: true });
        rmSync(cwd, { recursive: true, force: true });
        let j = {};
        try { j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))); } catch { }
        const error = j.is_error || r.status !== 0 || j.result === undefined ? (r.error?.message || String(r.stderr ?? '').trim().split('\n').pop() || 'no result') : undefined;
        const s = score(j.result, p, error);
        const row = { arm, id: p.id, i, ...s, cost: j.total_cost_usd ?? 0, outTokens: j.usage?.output_tokens ?? 0, ms: j.duration_ms ?? 0, error, reply: j.result };
        rows.push(row);
        appendFileSync(join(out, 'runs.jsonl'), JSON.stringify(row) + '\n');
        console.error(`[${arm}] ${p.id}#${i} ${s.pass ? 'pass' : 'FAIL'} ${s.words}w $${row.cost.toFixed(4)}${row.error ? ' ERROR ' + row.error : ''}`);
    }
    if (dry) return;
    console.table(summarize(rows));
    console.log(`runs: ${join(out, 'runs.jsonl')}`);
}

// One argument for cmd.exe: quoted, inner quotes escaped.
export const winArg = a => `"${String(a).replace(/"/g, '\\"')}"`;

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) main(process.argv.slice(2));
