// Architecture-first vs direct implementation benchmark. See README.md.
//   node bench.mjs run   [--runs 5] [--jobs 5] [--arms a,b] [--out results] [--force]
//   node bench.mjs judge [--runs 5] [--jobs 5] [--out results] [--force]
//   node bench.mjs report [--out results]
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SONNET = 'claude-sonnet-5-5', OPUS = 'opus';
const REQUEST = 'Add recurring tasks (daily, weekly on given weekdays, monthly on a day) and per-user reminders before the due time. Keep existing behaviour. The interface is specified in README.md.';
const ARCH = 'First, as a senior software architect, design this change for this codebase (modules, data model, interfaces, edge cases, how it fits the existing structure) and write the design to DESIGN.md. Then implement it. ';
const DESIGN_ONLY = 'As a senior software architect, design this change for this codebase (modules, data model, interfaces, edge cases, how it fits the existing structure) and write the design to DESIGN.md. Write only DESIGN.md: do not change any code and do not implement. ';
const FROM_DESIGN = 'A design for this change is in DESIGN.md. Implement it in this codebase. ';

const EDIT_TOOLS = ['--tools', 'Read,Edit,Write,Glob,Grep,Bash', '--allowedTools', 'Read,Edit,Write,Glob,Grep,Bash(node:*),Bash(npm test:*)', '--permission-mode', 'acceptEdits'];
// Write(DESIGN.md) as an allow rule did not match the absolute path the agent writes to, so the design call gets Write under acceptEdits
// and no Edit/Bash; runArm checks afterwards that nothing but DESIGN.md changed and reverts anything else.
const DESIGN_TOOLS = ['--tools', 'Read,Glob,Grep,Write', '--allowedTools', 'Read,Glob,Grep,Write', '--permission-mode', 'acceptEdits'];

export const ARMS = {
    'direct-sonnet': [{ model: SONNET, prompt: REQUEST, tools: EDIT_TOOLS }],
    'arch-frame': [{ model: SONNET, prompt: ARCH + REQUEST, tools: EDIT_TOOLS }],
    'two-phase': [{ model: OPUS, prompt: DESIGN_ONLY + REQUEST, tools: DESIGN_TOOLS }, { model: SONNET, prompt: FROM_DESIGN + REQUEST, tools: EDIT_TOOLS }],
    'direct-opus': [{ model: OPUS, prompt: REQUEST, tools: EDIT_TOOLS }],
};
const JUDGE_PAIRS = [['direct-sonnet', 'arch-frame'], ['direct-sonnet', 'two-phase'], ['arch-frame', 'two-phase'],
    ['direct-sonnet', 'direct-opus'], ['arch-frame', 'direct-opus'], ['two-phase', 'direct-opus']];

const cleanEnv = () => ({ ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });

function run(cmd, args, { cwd, env, input, timeout = 900000 }) {
    return new Promise(res => {
        const p = spawn(cmd, args, { cwd, env, windowsHide: true });
        let out = '', err = '', killed = false;
        const t = setTimeout(() => {
            killed = true; err += `\ntimeout after ${timeout / 1000}s`;
            try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }); } catch { }
            p.kill();
        }, timeout);
        p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
        p.on('error', e => { clearTimeout(t); res({ out, err: e.message, code: -1, killed }); });
        p.on('close', code => { clearTimeout(t); res({ out, err, code, killed }); });
        p.stdin.on('error', () => { });
        p.stdin.end(input);
    });
}
const git = (cwd, ...a) => run('git', ['-C', cwd, ...a], { cwd });

export function parseStream(text) {
    let fin = {}, model, tools = 0;
    for (const l of text.split('\n')) {
        if (!l.startsWith('{')) continue;
        let o; try { o = JSON.parse(l); } catch { continue; }
        if (o.type === 'system' && o.subtype === 'init') model = o.model;
        if (o.type === 'assistant') for (const b of o.message?.content ?? []) if (b.type === 'tool_use') tools++;
        if (o.type === 'result') fin = o;
    }
    return { model, tools, turns: fin.num_turns, cost: fin.total_cost_usd ?? 0, reply: fin.result, error: fin.is_error ? (fin.subtype || 'error') : fin.result === undefined ? 'no result' : undefined };
}

// node:test TAP: count top-level "ok"/"not ok" lines.
export function tap(out) {
    const ok = (out.match(/^ok \d+ - /gm) ?? []).length, bad = (out.match(/^not ok \d+ - /gm) ?? []).length;
    return { pass: ok, fail: bad, failed: [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map(m => m[1]) };
}
const countTests = file => (readFileSync(file, 'utf8').match(/^test\(/gm) ?? []).length;

async function runArm(arm, i, outDir) {
    const dir = join(outDir, `${arm}-${i}`); mkdirSync(dir, { recursive: true });
    const cwd = mkdtempSync(join(tmpdir(), 'bench-arch-'));
    const calls = [], t0 = Date.now();
    try {
        cpSync(join(HERE, 'fixture'), cwd, { recursive: true });
        await git(cwd, 'init', '-q');
        await git(cwd, 'add', '-A');
        await git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'start');
        for (const [k, c] of ARMS[arm].entries()) {
            const args = ['-p', '--model', c.model, '--effort', 'medium', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project',
                '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands', '--max-budget-usd', '10', ...c.tools];
            const c0 = Date.now(), r = await run('claude', args, { cwd, env: cleanEnv(), input: c.prompt });
            writeFileSync(join(dir, `stream-${k + 1}.jsonl`), r.out);
            const s = parseStream(r.out);
            if (k === 0 && ARMS[arm].length > 1) {
                const st = (await git(cwd, 'status', '--porcelain')).out.split('\n').filter(l => l && !/DESIGN\.md$/.test(l));
                if (st.length) { s.designTouchedCode = st; await git(cwd, 'checkout', '-q', '--', '.'); await git(cwd, 'clean', '-fdq', '-e', 'DESIGN.md'); }
                if (!existsSync(join(cwd, 'DESIGN.md'))) s.error = s.error ?? 'no DESIGN.md written';
            }
            if (!s.error && r.code) s.error = `exit ${r.code}: ${r.err.trim().split('\n').pop()}`;
            if (r.killed) s.error = 'timeout';
            calls.push({ designTouchedCode: s.designTouchedCode, model: s.model ?? c.model, ms: Date.now() - c0, cost: s.cost, turns: s.turns, tools: s.tools, error: s.error, stderr: r.err.trim().slice(-300), reply: String(s.reply ?? '').slice(0, 1500) });
        }
        // what the agent left: own tests, diff (DESIGN.md excluded: it would reveal the arm)
        const own = await run('node', ['--test', '--test-reporter=tap', 'test/'], { cwd, env: process.env, input: '', timeout: 120000 });
        const ownT = tap(own.out);
        await git(cwd, 'add', '-A');
        const ex = ':(exclude)DESIGN.md';
        const stat = (await git(cwd, 'diff', '--cached', '--numstat', '--', '.', ex)).out.trim().split('\n').filter(Boolean).map(l => l.split('\t'));
        const patch = (await git(cwd, 'diff', '--cached', '--', '.', ex)).out;
        writeFileSync(join(dir, 'diff.patch'), patch);
        const added = stat.reduce((a, s) => a + (Number(s[0]) || 0), 0), removed = stat.reduce((a, s) => a + (Number(s[1]) || 0), 0);
        const src = stat.filter(s => /^src\//.test(s[2]));
        const designPath = join(cwd, 'DESIGN.md'), hasDesign = existsSync(designPath);
        if (hasDesign) writeFileSync(join(dir, 'DESIGN.md'), readFileSync(designPath));
        // hidden acceptance tests and the original tests, copied in after the diff was taken
        mkdirSync(join(cwd, '__hidden__')); cpSync(join(HERE, 'hidden', 'accept.test.js'), join(cwd, '__hidden__', 'accept.test.js'));
        mkdirSync(join(cwd, '__orig__')); cpSync(join(HERE, 'fixture', 'test'), join(cwd, '__orig__'), { recursive: true });
        const hid = await run('node', ['--test', '--test-reporter=tap', '__hidden__/accept.test.js'], { cwd, env: process.env, input: '', timeout: 120000 });
        const org = await run('node', ['--test', '--test-reporter=tap', '__orig__/tasks.test.js', '__orig__/server.test.js'], { cwd, env: process.env, input: '', timeout: 120000 });
        writeFileSync(join(dir, 'hidden.tap'), hid.out + hid.err); writeFileSync(join(dir, 'orig.tap'), org.out + org.err);
        const H = tap(hid.out), O = tap(org.out);
        const row = {
            arm, i, calls, error: calls.find(c => c.error)?.error,
            hiddenTotal: countTests(join(HERE, 'hidden', 'accept.test.js')), hiddenPass: H.pass, hiddenFailed: H.failed,
            origPass: O.pass, origFail: O.fail, ownPass: ownT.pass, ownFail: ownT.fail,
            linesAdded: added, linesRemoved: removed, linesChanged: added + removed, srcLines: stat.filter(s => /^src\//.test(s[2])).reduce((a, s) => a + (Number(s[0]) || 0) + (Number(s[1]) || 0), 0), testLines: stat.filter(s => /^test\//.test(s[2])).reduce((a, s) => a + (Number(s[0]) || 0) + (Number(s[1]) || 0), 0), files: stat.length, srcFiles: src.length,
            newFiles: stat.filter(s => s[1] === '0' && /^src\//.test(s[2])).map(s => s[2]),
            hasDesign, designChars: hasDesign ? readFileSync(designPath, 'utf8').length : 0,
            costUsd: +calls.reduce((a, c) => a + (c.cost || 0), 0).toFixed(4), ms: Date.now() - t0,
        };
        writeFileSync(join(dir, 'result.json'), JSON.stringify(row, null, 2));
        console.error(`  ${arm}#${i} hidden ${row.hiddenPass}/${row.hiddenTotal} orig ${row.origPass}/${row.origPass + row.origFail} lines ${row.linesChanged} files ${row.files} $${row.costUsd} ${Math.round(row.ms / 1000)}s${row.error ? ' ERROR ' + row.error : ''}`);
        return row;
    } finally { rmSync(cwd, { recursive: true, force: true }); }
}

async function pool(jobs, n, fn) {
    let k = 0; const out = [];
    await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => { while (k < jobs.length) { const j = k++; out[j] = await fn(jobs[j]); } }));
    return out;
}

const REQUEST_FOR_JUDGE = REQUEST;
const RUBRIC = `Judge the DESIGN QUALITY and MAINTAINABILITY of each change, as a strict senior reviewer would: how well it fits the existing structure and conventions, separation of concerns and clear module boundaries, a sensible data model, edge cases handled in the code, no duplicated logic, no needless complexity or speculative code, readable names, tests added for the new behaviour. Do not reward size or comments for their own sake. You cannot run the code.`;
const JUDGE = (x, y) => `You compare two changes that two different AI coding agents made to the same small Node project (shown as git diffs). You do not know who made which.
The request both received:
<<<
${REQUEST_FOR_JUDGE}
>>>
${RUBRIC}

Change X:
<<<
${x}
>>>
Change Y:
<<<
${y}
>>>
Which change is better by that standard? Answer with one line of JSON only: {"better":"X"|"Y"|"tie","why":"<20 words>"}`;

const cap = (s, n = 45000) => s.length > n ? s.slice(0, n) + '\n...(truncated)' : s;

async function judgePair(a, b, i, outDir) {
    const flip = Math.random() < 0.5, [xa, ya] = flip ? [b, a] : [a, b];
    // --srconly: only the diff of files under src/ (test volume sways the judge)
    const only = p => !arg('srconly', false) ? p : p.split(/^(?=diff --git )/m).filter(c => /^diff --git a\/src\//.test(c)).join('');
    const read = arm => cap(only(readFileSync(join(outDir, `${arm}-${i}`, 'diff.patch'), 'utf8')) || '(empty diff)');
    const cwd = mkdtempSync(join(tmpdir(), 'bench-judge-'));
    try {
        const r = await run('claude', ['-p', '--model', OPUS, '--effort', 'high', '--output-format', 'json', '--setting-sources', 'project', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands', '--tools', ''],
            { cwd, env: cleanEnv(), input: JUDGE(read(xa), read(ya)), timeout: 300000 });
        let o; try { o = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { o = {}; }
        const res = String(o.result ?? '');
        const m = res.match(/"better"\s*:\s*"(X|Y|tie)"/i), why = res.match(/"why"\s*:\s*"([^"]*)"/)?.[1];
        const v = m?.[1]?.toUpperCase();
        const winner = !v ? 'error' : v === 'TIE' ? 'tie' : (v === 'X') !== flip ? a : b;
        return { a, b, i, winner, why, flipped: flip, cost: o.total_cost_usd ?? 0 };
    } finally { rmSync(cwd, { recursive: true, force: true }); }
}

function loadRows(outDir) {
    const rows = [];
    if (!existsSync(outDir)) return rows;
    for (const d of readdirSync(outDir)) { const f = join(outDir, d, 'result.json'); if (existsSync(f)) rows.push(JSON.parse(readFileSync(f, 'utf8'))); }
    return rows;
}

const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
const f1 = x => Number.isFinite(x) ? x.toFixed(1) : '-';

const judgeFile = () => arg('srconly', false) ? 'judge-src.json' : 'judge.json';
function report(outDir) {
    const rows = loadRows(outDir), jf = join(outDir, judgeFile()), judges = existsSync(jf) ? JSON.parse(readFileSync(jf, 'utf8')) : [];
    const lines = ['| arm | n | hidden pass mean (min-max) | all-hidden runs | orig tests ok | own tests ok | lines changed (src/test) | files | time s | cost $ mean | errors |', '|---|---|---|---|---|---|---|---|---|---|---|'];
    let total = 0;
    for (const arm of Object.keys(ARMS)) {
        const rs = rows.filter(r => r.arm === arm); if (!rs.length) continue;
        const h = rs.map(r => r.hiddenPass), T = rs[0].hiddenTotal;
        total += rs.reduce((a, r) => a + r.costUsd, 0);
        lines.push(`| ${arm} | ${rs.length} | ${f1(mean(h))}/${T} (${Math.min(...h)}-${Math.max(...h)}) | ${h.filter(x => x === T).length}/${rs.length} | ${rs.filter(r => r.origFail === 0 && r.origPass === 9).length}/${rs.length} | ${rs.filter(r => r.ownFail === 0 && r.ownPass > 0).length}/${rs.length} | ${f1(mean(rs.map(r => r.linesChanged)))} (${f1(mean(rs.map(r => r.srcLines)))}/${f1(mean(rs.map(r => r.testLines)))}) | ${f1(mean(rs.map(r => r.files)))} | ${f1(mean(rs.map(r => r.ms / 1000)))} | ${mean(rs.map(r => r.costUsd)).toFixed(2)} | ${rs.filter(r => r.error).length} |`);
    }
    const jl = ['', '| pair | first wins | second wins | tie | error |', '|---|---|---|---|---|'];
    for (const [a, b] of JUDGE_PAIRS) {
        const js = judges.filter(j => j.a === a && j.b === b); if (!js.length) continue;
        jl.push(`| ${a} vs ${b} | ${js.filter(j => j.winner === a).length} | ${js.filter(j => j.winner === b).length} | ${js.filter(j => j.winner === 'tie').length} | ${js.filter(j => j.winner === 'error').length} |`);
    }
    const jc = judges.reduce((a, j) => a + (j.cost || 0), 0);
    const text = [...lines, ...jl, '', `agent runs cost $${total.toFixed(2)}, judge $${jc.toFixed(2)}, total $${(total + jc).toFixed(2)} (notional API price; billed to the subscription)`].join('\n');
    console.log(text); writeFileSync(join(outDir, arg('srconly', false) ? 'REPORT-src.md' : 'REPORT.md'), text + '\n');
}

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined) ? true : process.argv[i + 1]; };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const cmd = process.argv[2], outDir = resolve(HERE, arg('out', 'results')), runs = Number(arg('runs', 5)), jobs = Number(arg('jobs', 5));
    mkdirSync(outDir, { recursive: true });
    if (cmd === 'run') {
        const arms = String(arg('arms', Object.keys(ARMS).join(','))).split(',');
        const todo = [];
        for (let i = 0; i < runs; i++) for (const a of arms) if (arg('force', false) || !existsSync(join(outDir, `${a}-${i}`, 'result.json'))) todo.push([a, i]);
        console.error(`${todo.length} runs, ${jobs} at a time`);
        await pool(todo, jobs, ([a, i]) => runArm(a, i, outDir).catch(e => console.error(`  ${a}#${i} harness error: ${e.message}`)));
        report(outDir);
    } else if (cmd === 'judge') {
        const jf = join(outDir, judgeFile()), done = existsSync(jf) && !arg('force', false) ? JSON.parse(readFileSync(jf, 'utf8')) : [];
        const todo = [];
        for (const [a, b] of JUDGE_PAIRS) for (let i = 0; i < runs; i++) {
            const ok = arm => existsSync(join(outDir, `${arm}-${i}`, 'diff.patch'));
            if (ok(a) && ok(b) && !done.some(j => j.a === a && j.b === b && j.i === i && j.winner !== 'error')) todo.push([a, b, i]);
        }
        const fresh = await pool(todo, jobs, ([a, b, i]) => judgePair(a, b, i, outDir));
        const keep = done.filter(j => !todo.some(([a, b, i]) => a === j.a && b === j.b && i === j.i));
        writeFileSync(jf, JSON.stringify([...keep, ...fresh], null, 2));
        report(outDir);
    } else if (cmd === 'report') report(outDir);
    else console.error('usage: node bench.mjs run|judge|report [--runs 5] [--jobs 5] [--arms a,b] [--out results] [--force]');
}

export { run, git, cleanEnv, pool, EDIT_TOOLS, SONNET, mean, f1 };
