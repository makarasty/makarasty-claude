// Does the wording of a coding instruction change code quality?  See README.md.
// node run.mjs run   --out smoke --models haiku --n 1 [--tasks a,b] [--arms x,y] [--conc 5]
// node run.mjs judge --out full  [--judge opus]
// node run.mjs report --out full
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS = { sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', opus: 'claude-opus-5-5' };
const TASKS = {
    ratelimiter: { fixture: 'ratelimiter', hidden: 'ratelimiter.test.mjs', hiddenN: 16, prompt: 'Implement src/token-bucket.js per README.md. Visible tests: npm test.' },
    cache: { fixture: 'cache', hidden: 'cache.test.mjs', hiddenN: 16, prompt: 'Implement src/lru-cache.js per README.md. Visible tests: npm test.' },
    emitter: { fixture: 'emitter', hidden: 'emitter.test.mjs', hiddenN: 17, prompt: 'Implement src/emitter.js per README.md. Visible tests: npm test.' },
    csv: { fixture: 'csv', hidden: 'csv.test.mjs', hiddenN: 18, prompt: 'Implement src/csv.js per README.md. Visible tests: npm test.' },
};
const ARMS = { neutral: null, negative: 'negative.txt', positive: 'positive.txt', positiveLong: 'positive-long.txt' };
// first = candidate "better" arm, second = reference
const COMPARISONS = [['positive', 'negative'], ['positive', 'neutral'], ['neutral', 'negative'], ['positiveLong', 'neutral']];

const opt = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const phase = process.argv[2], OUT = join(HERE, 'runs', opt('out', 'full'));
mkdirSync(OUT, { recursive: true });

// Variables the parent Claude session leaves in the environment would change the run (effort, session ids, host hooks).
const DROP = /^(CLAUDECODE|CLAUDE_EFFORT|CLAUDE_AGENT_SDK.*|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|HOST_SESSION_ID|MESSAGING_.*|DESKTOP_.*|ENTRYPOINT|SESSION_ATTENDED|EMIT_.*|REPORT_FINDINGS|TERMINAL_MCP_TOOLS|ENABLE_ASK_USER_QUESTION_TOOL|DISABLE_CRON|DISABLE_TERMINAL_TITLE|EAGER_FLUSH))$/;
const cleanEnv = () => {
    const e = {}; for (const [k, v] of Object.entries(process.env)) if (!DROP.test(k)) e[k] = v;
    return { ...e, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
};

function exec(cmd, args, { cwd, env, input, timeout }) {
    return new Promise(res => {
        const p = spawn(cmd, args, { cwd, env, windowsHide: true });
        let out = '', err = '', timedOut = false;
        const t = setTimeout(() => { timedOut = true; p.kill(); }, timeout);
        p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
        p.on('error', e => { clearTimeout(t); res({ out, err: e.message, code: -1, timedOut }); });
        p.on('close', code => { clearTimeout(t); res({ out, err, code, timedOut }); });
        p.stdin.end(input ?? '');
    });
}

function parseStream(text) {
    const tools = []; let fin = {}, init = null;
    for (const l of text.split('\n')) {
        let o; try { o = JSON.parse(l); } catch { continue; }
        if (o.type === 'system' && o.subtype === 'init') init = { model: o.model, tools: o.tools, plugins: o.plugins, skills: o.skills?.length, mcp: o.mcp_servers };
        if (o.type === 'assistant') for (const b of o.message?.content ?? []) if (b.type === 'tool_use') tools.push(b.name + ':' + String(b.input?.command ?? b.input?.file_path ?? b.input?.pattern ?? '').slice(0, 100));
        if (o.type === 'result') fin = o;
    }
    return { tools, init, reply: fin.result, cost: fin.total_cost_usd ?? 0, turns: fin.num_turns, apiMs: fin.duration_api_ms, usage: fin.usage, error: fin.is_error ? (fin.subtype || 'error') : fin.result === undefined ? 'no result' : undefined };
}

const tap = out => {
    const g = k => +(out.match(new RegExp(`^# ${k} (\\d+)`, 'm'))?.[1] ?? NaN);
    return { tests: g('tests'), pass: g('pass'), fail: g('fail') };
};

function srcFiles(cwd) {
    const d = join(cwd, 'src'), r = {};
    if (existsSync(d)) for (const f of readdirSync(d, { recursive: true })) { try { r[f] = readFileSync(join(d, f), 'utf8'); } catch { } }
    return r;
}
const loc = s => s.split('\n').filter(l => l.trim()).length;
const codeLoc = s => s.split('\n').filter(l => { const t = l.trim(); return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).length;

async function runOne(job) {
    const file = join(OUT, `${job.task}-${job.model}-${job.arm}-${job.i}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
    const T = TASKS[job.task], cwd = mkdtempSync(join(tmpdir(), 'bw-run-'));
    try {
        cpSync(join(HERE, 'fixtures', T.fixture), cwd, { recursive: true });
        const args = ['-p', '--model', MODELS[job.model], '--effort', 'medium', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project', '--no-session-persistence',
            '--permission-mode', 'acceptEdits', '--tools', 'Read,Edit,Write,Glob,Grep,Bash', '--allowedTools', 'Read,Edit,Write,Glob,Grep,Bash(node:*),Bash(npm:*)'];
        if (ARMS[job.arm]) args.push('--append-system-prompt-file', join(HERE, 'arms', ARMS[job.arm]));
        const t0 = Date.now();
        const r = await exec('claude', args, { cwd, env: cleanEnv(), input: T.prompt, timeout: 600000 });
        const ms = Date.now() - t0;
        const s = parseStream(r.out);
        if (r.timedOut) s.error = 'timeout'; else if (!s.error && r.code) s.error = `exit ${r.code}: ${r.err.trim().split('\n').pop()}`;
        const src = srcFiles(cwd);
        // Score on pristine tests: the agent may have edited the visible file.
        cpSync(join(HERE, 'fixtures', T.fixture, 'test', 'visible.test.mjs'), join(cwd, 'test', 'visible.test.mjs'));
        mkdirSync(join(cwd, 'hidden'), { recursive: true });
        cpSync(join(HERE, 'hidden', T.hidden), join(cwd, 'hidden', T.hidden));
        const nodeEnv = { ...process.env };
        const vis = await exec('node', ['--test', '--test-reporter=tap', 'test/visible.test.mjs'], { cwd, env: nodeEnv, timeout: 60000 });
        const hid = await exec('node', ['--test', '--test-reporter=tap', `hidden/${T.hidden}`], { cwd, env: nodeEnv, timeout: 60000 });
        const hv = tap(hid.out), vv = tap(vis.out);
        const text = Object.values(src).join('\n');
        const row = {
            ...job, ms, cost: s.cost, turns: s.turns, error: s.error, init: s.init, usage: s.usage, tools: s.tools, reply: s.reply,
            hiddenPass: Number.isNaN(hv.pass) ? 0 : hv.pass, hiddenN: T.hiddenN, hiddenTimedOut: hid.timedOut, visiblePass: Number.isNaN(vv.pass) ? 0 : vv.pass, visibleN: 3,
            loc: loc(text), codeLoc: codeLoc(text), bugSrc: (text.match(/bug/gi) ?? []).length, bugReply: (String(s.reply ?? '').match(/bug/gi) ?? []).length,
            extraTests: readdirSync(join(cwd, 'test')).filter(f => f !== 'visible.test.mjs').length, src,
        };
        writeFileSync(file, JSON.stringify(row, null, 1));
        console.error(`${job.task}/${job.model}/${job.arm}#${job.i} hidden ${row.hiddenPass}/${row.hiddenN} vis ${row.visiblePass}/3 loc ${row.loc} ${Math.round(ms / 1000)}s $${row.cost.toFixed(3)} ${s.error ?? ''}`);
        return row;
    } finally { rmSync(cwd, { recursive: true, force: true }); }
}

async function pool(jobs, n, fn) {
    const out = []; let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => { while (i < jobs.length) { const k = i++; out[k] = await fn(jobs[k]); } }));
    return out;
}
// Deterministic shuffle so arms are spread over time of day / load.
function shuffle(a) { let s = 12345; const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

const list = k => (opt(k, '') || '').split(',').filter(Boolean);
const models = list('models').length ? list('models') : ['sonnet', 'haiku'];
const tasks = list('tasks').length ? list('tasks') : Object.keys(TASKS);
const arms = list('arms').length ? list('arms') : Object.keys(ARMS);
const N = +opt('n', 5), CONC = +opt('conc', 5);

const loadRuns = () => readdirSync(OUT).filter(f => /^(ratelimiter|csv|cache|emitter)-.*\.json$/.test(f)).map(f => JSON.parse(readFileSync(join(OUT, f), 'utf8')));

// ---- judge ----------------------------------------------------------------------------------------------------
const JUDGE = (spec, x, y) => `You are a senior engineer choosing which of two implementations of the same module to merge. You do not know who wrote either.

The spec (README.md):
<<<
${spec}
>>>

Implementation X:
<<<
${x}
>>>

Implementation Y:
<<<
${y}
>>>

Judge as a careful reviewer would: does it follow the spec exactly (including edge cases), is it correct and robust, is it readable and maintainable, and is its size appropriate (needless abstraction, dead code and padding count against it; so do gaps in the spec). You cannot run the code; read it closely.
Answer with one line of JSON only: {"better":"X"|"Y"|"tie","why":"<20 words>"}`;
const srcText = r => Object.entries(r.src).map(([f, c]) => `// ---- ${f}\n${c}`).join('\n') || '(no source file written)';

async function judgeOne(a, b, spec, model) {
    const flip = Math.random() < 0.5, [x, y] = flip ? [b, a] : [a, b];
    const cwd = mkdtempSync(join(tmpdir(), 'bw-judge-'));
    try {
        const r = await exec('claude', ['-p', '--model', model, '--output-format', 'json', '--setting-sources', 'project', '--no-session-persistence', '--tools', ''],
            { cwd, env: cleanEnv(), input: JUDGE(spec, srcText(x), srcText(y)), timeout: 300000 });
        let o; try { o = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { }
        const m = String(o?.result ?? '').match(/"better"\s*:\s*"(X|Y|tie)"/i), b0 = m?.[1]?.toUpperCase();
        return { winner: !b0 ? 'error' : b0 === 'TIE' ? 'tie' : (b0 === 'X') !== flip ? 'first' : 'second', why: String(o?.result ?? '').match(/"why"\s*:\s*"([^"]*)"/)?.[1], cost: o?.total_cost_usd ?? 0 };
    } finally { rmSync(cwd, { recursive: true, force: true }); }
}

// ---- report ---------------------------------------------------------------------------------------------------
const stat = xs => { xs = xs.filter(x => Number.isFinite(x)); if (!xs.length) return { m: NaN, lo: NaN, hi: NaN, n: 0 }; return { m: xs.reduce((a, b) => a + b, 0) / xs.length, lo: Math.min(...xs), hi: Math.max(...xs), n: xs.length }; };
const f1 = (s, d = 1) => s.n ? `${s.m.toFixed(d)} (${s.lo.toFixed(d)}-${s.hi.toFixed(d)})` : '-';

function report() {
    const runs = loadRuns(), jf = join(OUT, 'judge.json'), J = existsSync(jf) ? JSON.parse(readFileSync(jf, 'utf8')) : [];
    const cells = [...new Set(runs.map(r => `${r.task}|${r.model}`))].sort();
    let md = '';
    md += '## Runs: hidden-test pass (mean, min-max), visible pass, LOC, time, cost\n\n| task | model | arm | n | hidden pass | hidden of | visible | LOC | code LOC | sec | $ / run | errors | extra test files | "bug" in src | "bug" in reply |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n';
    for (const c of cells) for (const arm of Object.keys(ARMS)) {
        const rs = runs.filter(r => `${r.task}|${r.model}` === c && r.arm === arm); if (!rs.length) continue;
        const [t, m] = c.split('|');
        md += `| ${t} | ${m} | ${arm} | ${rs.length} | ${f1(stat(rs.map(r => r.hiddenPass)))} | ${rs[0].hiddenN} | ${f1(stat(rs.map(r => r.visiblePass)))} | ${f1(stat(rs.map(r => r.loc)), 0)} | ${f1(stat(rs.map(r => r.codeLoc)), 0)} | ${f1(stat(rs.map(r => r.ms / 1000)), 0)} | ${f1(stat(rs.map(r => r.cost)), 3)} | ${rs.filter(r => r.error).length} | ${stat(rs.map(r => r.extraTests)).m.toFixed(1)} | ${stat(rs.map(r => r.bugSrc)).m.toFixed(2)} | ${stat(rs.map(r => r.bugReply)).m.toFixed(2)} |\n`;
    }
    md += '\n## All models pooled per task and arm (hidden pass as % of tests)\n\n| task | arm | n | hidden % mean (min-max) | LOC mean | "bug" in src mean |\n|---|---|---|---|---|---|\n';
    for (const t of Object.keys(TASKS)) for (const arm of Object.keys(ARMS)) {
        const rs = runs.filter(r => r.task === t && r.arm === arm); if (!rs.length) continue;
        md += `| ${t} | ${arm} | ${rs.length} | ${f1(stat(rs.map(r => 100 * r.hiddenPass / r.hiddenN)), 0)} | ${stat(rs.map(r => r.loc)).m.toFixed(0)} | ${stat(rs.map(r => r.bugSrc)).m.toFixed(2)} |\n`;
    }
    if (J.length) {
        md += '\n## Blind judge: wins of the first arm / second arm / ties (pairs = run i of one arm vs run i of the other, same task and model)\n\n| comparison | task | model | first wins | second wins | ties | errors |\n|---|---|---|---|---|---|---|\n';
        const keys = [...new Set(J.map(j => `${j.a}>${j.b}|${j.task}|${j.model}`))];
        const tot = {};
        for (const k of keys) {
            const [cmp, task, model] = k.split('|'), js = J.filter(j => `${j.a}>${j.b}|${j.task}|${j.model}` === k), c = w => js.filter(j => j.winner === w).length;
            md += `| ${cmp.replace('>', ' vs ')} | ${task} | ${model} | ${c('first')} | ${c('second')} | ${c('tie')} | ${c('error')} |\n`;
            const t = tot[cmp] ??= { first: 0, second: 0, tie: 0 }; for (const w of ['first', 'second', 'tie']) t[w] += c(w);
        }
        md += '\n### Judge totals\n\n| comparison | first wins | second wins | ties |\n|---|---|---|---|\n';
        for (const [cmp, t] of Object.entries(tot)) md += `| ${cmp.replace('>', ' vs ')} | ${t.first} | ${t.second} | ${t.tie} |\n`;
    }
    const runCost = runs.reduce((a, r) => a + r.cost, 0), judgeCost = J.reduce((a, j) => a + (j.cost || 0), 0);
    md += `\nRun cost $${runCost.toFixed(2)} (${runs.length} runs), judge cost $${judgeCost.toFixed(2)} (${J.length} calls), total $${(runCost + judgeCost).toFixed(2)}. Run errors: ${runs.filter(r => r.error).length}.\n`;
    writeFileSync(join(OUT, 'report.md'), md); console.log(md);
}

if (phase === 'run') {
    const jobs = [];
    for (const task of tasks) for (const model of models) for (const arm of arms) for (let i = 1; i <= N; i++) jobs.push({ task, model, arm, i });
    shuffle(jobs);
    console.error(`${jobs.length} runs, ${CONC} at a time -> ${OUT}`);
    await pool(jobs, CONC, runOne);
} else if (phase === 'judge') {
    const runs = loadRuns(), model = opt('judge', 'opus'), jf = join(OUT, 'judge.json');
    const J = existsSync(jf) ? JSON.parse(readFileSync(jf, 'utf8')) : [];
    const jobs = [];
    for (const [a, b] of COMPARISONS) for (const task of tasks) for (const m of models) for (let i = 1; i <= N; i++) {
        const ra = runs.find(r => r.task === task && r.model === m && r.arm === a && r.i === i), rb = runs.find(r => r.task === task && r.model === m && r.arm === b && r.i === i);
        if (ra && rb && !ra.error && !rb.error && !J.some(j => j.a === a && j.b === b && j.task === task && j.model === m && j.i === i)) jobs.push({ a, b, task, model: m, i, ra, rb });
    }
    console.error(`${jobs.length} judge calls`);
    await pool(jobs, CONC, async j => {
        const spec = readFileSync(join(HERE, 'fixtures', TASKS[j.task].fixture, 'README.md'), 'utf8');
        const r = await judgeOne(j.ra, j.rb, spec, model);
        J.push({ a: j.a, b: j.b, task: j.task, model: j.model, i: j.i, ...r });
        writeFileSync(jf, JSON.stringify(J, null, 1));
        console.error(`judge ${j.a} vs ${j.b} ${j.task}/${j.model}#${j.i}: ${r.winner} ${r.why ?? ''}`);
    });
} else if (phase === 'report') report();
else console.error('usage: node run.mjs run|judge|report --out NAME');
