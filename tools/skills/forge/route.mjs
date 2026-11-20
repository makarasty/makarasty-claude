#!/usr/bin/env node
// route.mjs - which skill does the model call first for a plain request? Runs each case as one headless `claude -p`
// with the arm's plugin dirs in one shared empty folder, reads the first Skill call from the stream, and scores it
// against the case's gold skill (or "none"). A run has only Skill, Read, Grep and Glob and no MCP server, so it
// changes nothing and messages no other chat; it runs with no host-chat ids, so a plugin's hooks treat it as its own chat.
//
//   node route.mjs <arms.json> <cases.json> [--out runs.jsonl] [--par 6] [--model sonnet] [--only A,B] [--budget 0.3]
//   node route.mjs --selftest
//
// arms.json: { "A": { "plugins": ["C:/path/plugin"], "env": { "MAKARASTY_SKILL_ROUTER": "off" } }, "B": { ... } }
// cases.json: [ { "id": "commit-ru-1", "text": "закоммить", "gold": "makarasty-tools:commit", "lang": "ru" } ]
// route-cases.json beside this file: 192 phrases written from each skill's purpose (3 EN, 3 RU per skill), 60
// near-miss negatives and 7 regression cases [M80]. A row says `hinted` when the skill router's hint reached the
// model, so an arm meant to have the router shows whether it ran. A run that never reached the model is printed and
// left out of --out, so a rerun with the same --out retries it. About $0.07 a run on Sonnet: the listing rides in the
// first user message, so no run reads another's cache.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const lines = (s) => String(s).split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

// The first skill the stream calls, or none; whether the model answered at all; whether the router's hint reached it.
export function read(stream) {
    let got = 'none', answered = false, cost = 0;
    for (const j of lines(stream)) {
        if (j.type === 'assistant') {
            answered = true;
            for (const b of j.message?.content ?? []) if (got === 'none' && b.type === 'tool_use' && b.name === 'Skill') got = String(b.input?.skill ?? '');
        }
        if (j.type === 'result') cost = j.total_cost_usd ?? 0;
    }
    return { got, answered, cost, hinted: String(stream).includes('Automatic hint from the makarasty-tools skill router') };
}

// An allow-list, not a deny-list: a run with ListAgents and SendMessage once told two live chats to stop their agents.
export const argsFor = (model, plugins, budget) => ['-p', '--model', model, '--output-format', 'stream-json', '--verbose', '--max-turns', '2',
    '--setting-sources', 'project', '--no-session-persistence', '--max-budget-usd', String(budget), ...plugins.flatMap((d) => ['--plugin-dir', d]),
    '--tools', 'Skill,Read,Grep,Glob', '--strict-mcp-config'];

export function summarize(rows) {
    const by = {};
    for (const r of rows) (by[r.arm] ??= []).push(r);
    return Object.entries(by).map(([arm, rs]) => {
        const pos = rs.filter((r) => r.gold !== 'none'), neg = rs.filter((r) => r.gold === 'none');
        return { arm, runs: rs.length, top1: pos.length ? +(100 * pos.filter((r) => r.got === r.gold).length / pos.length).toFixed(1) : null,
            wrongSkill: pos.filter((r) => r.got !== 'none' && r.got !== r.gold).length, falseTrig: `${neg.filter((r) => r.got !== 'none').length}/${neg.length}`,
            hinted: rs.filter((r) => r.hinted).length, p50ms: rs.map((r) => r.ms).sort((a, b) => a - b)[rs.length >> 1] ?? 0, cost: +rs.reduce((s, r) => s + r.cost, 0).toFixed(2) };
    });
}

// One argument for cmd.exe: quoted, inner quotes escaped (an npm-installed claude.cmd needs a shell).
const winArg = (a) => `"${String(a).replace(/"/g, '\\"')}"`;

function selftest() {
    const tool = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
    const r = read([tool('Glob', {}), tool('Skill', { skill: 'x:commit' }), tool('Skill', { skill: 'x:ship' }), '{"type":"result","total_cost_usd":0.07}'].join('\n'));
    assert.deepEqual([r.got, r.answered, r.cost, r.hinted], ['x:commit', true, 0.07, false], 'first Skill call wins');
    assert.deepEqual([read('not json\n' + tool('Read', {})).got, read('').answered], ['none', false], 'no Skill call is none; no assistant line is no answer');
    assert.equal(read('{"type":"user","content":"Automatic hint from the makarasty-tools skill router (a small"}').hinted, true, 'hint seen');
    const a = argsFor('sonnet', ['C:/p'], 0.3);
    assert.equal(a[a.indexOf('--tools') + 1], 'Skill,Read,Grep,Glob', 'only four tools');
    assert.ok(a.includes('--strict-mcp-config') && !a.includes('--disallowedTools'), 'no MCP, no deny-list');
    const s = summarize([{ arm: 'A', gold: 'x:c', got: 'x:c', ms: 1, cost: 0.1 }, { arm: 'A', gold: 'x:c', got: 'x:s', ms: 3, cost: 0.1, hinted: true }, { arm: 'A', gold: 'none', got: 'x:c', ms: 2, cost: 0 }]);
    assert.deepEqual([s[0].top1, s[0].wrongSkill, s[0].falseTrig, s[0].hinted, s[0].p50ms], [50, 1, '1/1', 1, 2], 'summary');
    console.log('route.mjs selftest done');
}

async function main(argv) {
    if (argv[0] === '--selftest') return selftest();
    const flag = (n, d) => { const i = argv.indexOf(n); return i < 0 ? d : argv[i + 1]; };
    if (argv.length < 2 || argv[0].startsWith('--')) { console.error('usage: node route.mjs <arms.json> <cases.json> [--out f] [--par 6] [--model sonnet] [--only A,B] [--budget 0.3]'); process.exit(2); }
    const only = flag('--only', '') ? flag('--only', '').split(',') : null;
    const arms = Object.entries(JSON.parse(readFileSync(argv[0], 'utf8').replace(/^\uFEFF/, ''))).filter(([k]) => !only || only.includes(k));
    const cases = JSON.parse(readFileSync(argv[1], 'utf8').replace(/^\uFEFF/, ''));
    const out = resolve(flag('--out', join(tmpdir(), `route-${Date.now()}.jsonl`)));
    const par = Number(flag('--par', 6)), model = flag('--model', 'sonnet'), budget = flag('--budget', '0.3');
    const done = () => (existsSync(out) ? lines(readFileSync(out, 'utf8')) : []);
    const seen = new Set(done().map((j) => `${j.arm}|${j.id}`));
    const jobs = cases.flatMap((c) => arms.filter(([arm]) => !seen.has(`${arm}|${c.id}`)).map(([arm, a]) => ({ c, arm, a })));
    // One folder for every run: the cwd sits in the system prompt, so a folder per run would miss even the system's cache.
    const cwd = mkdtempSync(join(tmpdir(), 'route-'));
    const one = ({ c, arm, a }) => new Promise((res) => {
        const args = argsFor(model, a.plugins ?? [], budget);
        // No host-chat ids: a plugin hook that reads them would act on the chat that launched this script.
        const env = { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_HOST_SESSION_ID: '', CLAUDE_CODE_ACCOUNT_UUID: '', ...(a.env ?? {}) };
        const t0 = Date.now();
        const start = (shell) => spawn(shell ? 'claude.cmd' : 'claude', shell ? args.map(winArg) : args, { cwd, env, windowsHide: true, shell });
        let buf = '', tried = false;
        const run = (p) => {
            p.stdout.on('data', (d) => { buf += d; });
            p.stdin.on('error', () => {});
            const kill = setTimeout(() => p.kill(), 180000);
            let broke = false;
            p.on('error', (err) => {
                clearTimeout(kill);
                broke = true;
                if (err.code === 'ENOENT' && process.platform === 'win32' && !tried) { tried = true; run(start(true)); }
                else res({ arm, id: c.id, error: err.message });
            });
            p.on('close', (code) => {
                clearTimeout(kill);
                if (broke) return; // the spawn failed: the error handler answers or retries
                const r = read(buf);
                if (!r.answered) return res({ arm, id: c.id, error: `no model reply (exit ${code})` });
                const row = { arm, id: c.id, gold: c.gold, lang: c.lang, got: r.got, hinted: r.hinted, cost: r.cost, ms: Date.now() - t0 };
                appendFileSync(out, JSON.stringify(row) + '\n');
                res(row);
            });
            p.stdin.end(c.text);
        };
        run(start(false));
    });
    let i = 0, failed = 0;
    await Promise.all(Array.from({ length: par }, async () => { while (i < jobs.length) { const r = await one(jobs[i++]); if (r.error) failed++; console.error(r.error ? `[${r.arm}] ${r.id} ERROR ${r.error}` : `[${r.arm}] ${r.id} ${r.gold} -> ${r.got}${r.hinted ? ' (hinted)' : ''}`); } }));
    console.table(summarize(done()));
    console.log(`runs: ${out}${failed ? `; ${failed} runs failed and were left out: run again with the same --out` : ''}`);
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) await main(process.argv.slice(2));
