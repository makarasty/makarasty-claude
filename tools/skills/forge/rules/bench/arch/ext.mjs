// Extension probe: take each finished tree (fixture + results/<arm>-<i>/diff.patch), give the same Sonnet "direct" request
// for a follow-up change, and measure what it costs and whether it works (a maintainability proxy: how hard is the next change).
//   node ext.mjs run [--runs 5] [--jobs 5] [--src results] [--out results-ext]   |   node ext.mjs report [--out results-ext]
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDIT_TOOLS, SONNET, cleanEnv, f1, git, mean, pool, run, tap } from './bench.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARMS = ['direct-sonnet', 'arch-frame', 'two-phase', 'direct-opus'];
const EXT = `Extend the existing recurrence feature with two more recurrence types. They must work wherever recurrence works today (module API, POST /tasks, completing a task creates the next one, reminders for the next task). Keep existing behaviour.
- { type: 'yearly' }: the next due has the same month and day as the completed task's due, one year later, same time of day. A due on Feb 29 moves to Feb 28 in a non-leap year and stays on Feb 28 afterwards.
- { type: 'interval', days: N }: N is an integer from 2 to 365; the next due is exactly N days after the completed task's due.
Like the other types, they need a due date, and anything invalid is a ValidationError (HTTP 400).`;
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const countTests = f => (readFileSync(f, 'utf8').match(/^test\(/gm) ?? []).length;
const sumLines = rows => rows.reduce((a, s) => a + (Number(s[0]) || 0) + (Number(s[1]) || 0), 0);

async function one(arm, i, src, out) {
    const dir = join(out, `${arm}-${i}`); mkdirSync(dir, { recursive: true });
    const cwd = mkdtempSync(join(tmpdir(), 'bench-ext-')), t0 = Date.now();
    try {
        cpSync(join(HERE, 'fixture'), cwd, { recursive: true });
        await git(cwd, 'init', '-q'); await git(cwd, 'add', '-A');
        await git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture');
        const ap = await git(cwd, 'apply', '--whitespace=nowarn', resolve(src, `${arm}-${i}`, 'diff.patch'));
        if (ap.code) throw new Error('patch does not apply: ' + ap.err);
        await git(cwd, 'add', '-A');
        await git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'tree');
        const args = ['-p', '--model', SONNET, '--effort', 'medium', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project', '--no-session-persistence',
            '--strict-mcp-config', '--disable-slash-commands', '--max-budget-usd', '10', ...EDIT_TOOLS];
        const r = await run('claude', args, { cwd, env: cleanEnv(), input: EXT });
        writeFileSync(join(dir, 'stream.jsonl'), r.out);
        let cost = 0, error;
        for (const l of r.out.split('\n')) { if (!l.startsWith('{')) continue; try { const o = JSON.parse(l); if (o.type === 'result') { cost = o.total_cost_usd ?? 0; if (o.is_error) error = o.subtype; } } catch { } }
        if (r.killed) error = 'timeout';
        await git(cwd, 'add', '-A');
        const stat = (await git(cwd, 'diff', '--cached', '--numstat')).out.trim().split('\n').filter(Boolean).map(l => l.split('\t'));
        writeFileSync(join(dir, 'diff.patch'), (await git(cwd, 'diff', '--cached')).out);
        const srcStat = stat.filter(s => /^src\//.test(s[2]));
        for (const [d, f] of [['__ext__', 'ext.test.js'], ['__hidden__', 'accept.test.js']]) { mkdirSync(join(cwd, d)); cpSync(join(HERE, 'hidden', f), join(cwd, d, f)); }
        const ext = await run('node', ['--test', '--test-reporter=tap', '__ext__/ext.test.js'], { cwd, env: process.env, input: '', timeout: 120000 });
        const reg = await run('node', ['--test', '--test-reporter=tap', '__hidden__/accept.test.js'], { cwd, env: process.env, input: '', timeout: 120000 });
        writeFileSync(join(dir, 'ext.tap'), ext.out + ext.err);
        const E = tap(ext.out), R = tap(reg.out);
        const row = { arm, i, error, extPass: E.pass, extTotal: countTests(join(HERE, 'hidden', 'ext.test.js')), extFailed: E.failed, regPass: R.pass, regTotal: countTests(join(HERE, 'hidden', 'accept.test.js')), lines: sumLines(stat), files: stat.length, srcFiles: srcStat.length, srcLines: sumLines(srcStat), costUsd: +cost.toFixed(4), ms: Date.now() - t0 };
        writeFileSync(join(dir, 'result.json'), JSON.stringify(row, null, 2));
        console.error(`  ${arm}#${i} ext ${row.extPass}/${row.extTotal} reg ${row.regPass}/${row.regTotal} lines ${row.lines} files ${row.files} $${row.costUsd} ${Math.round(row.ms / 1000)}s${error ? ' ERROR ' + error : ''}`);
        return row;
    } finally { rmSync(cwd, { recursive: true, force: true }); }
}

function report(out) {
    const rows = [];
    for (const d of existsSync(out) ? readdirSync(out) : []) { const f = join(out, d, 'result.json'); if (existsSync(f)) rows.push(JSON.parse(readFileSync(f, 'utf8'))); }
    const L = ['| arm | n | ext tests mean (min-max) | all-pass runs | regression 24 intact | lines changed | src files touched | cost $ mean | errors |', '|---|---|---|---|---|---|---|---|---|'];
    for (const arm of ARMS) {
        const rs = rows.filter(r => r.arm === arm); if (!rs.length) continue;
        const e = rs.map(r => r.extPass), T = rs[0].extTotal;
        L.push(`| ${arm} | ${rs.length} | ${f1(mean(e))}/${T} (${Math.min(...e)}-${Math.max(...e)}) | ${e.filter(x => x === T).length}/${rs.length} | ${rs.filter(r => r.regPass === r.regTotal).length}/${rs.length} | ${f1(mean(rs.map(r => r.lines)))} | ${f1(mean(rs.map(r => r.srcFiles)))} | ${mean(rs.map(r => r.costUsd)).toFixed(2)} | ${rs.filter(r => r.error).length} |`);
    }
    const t = `${L.join('\n')}\n\nextension runs cost $${rows.reduce((a, r) => a + r.costUsd, 0).toFixed(2)}`;
    console.log(t); writeFileSync(join(out, 'REPORT.md'), t + '\n');
}

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const out = resolve(HERE, arg('out', 'results-ext')), src = resolve(HERE, arg('src', 'results')), runs = Number(arg('runs', 5)), jobs = Number(arg('jobs', 5));
    mkdirSync(out, { recursive: true });
    if (process.argv[2] === 'run') {
        const todo = [];
        for (let i = 0; i < runs; i++) for (const a of ARMS) if (existsSync(join(src, `${a}-${i}`, 'diff.patch')) && !existsSync(join(out, `${a}-${i}`, 'result.json'))) todo.push([a, i]);
        console.error(`${todo.length} extension runs`);
        await pool(todo, jobs, ([a, i]) => one(a, i, src, out).catch(e => console.error(`  ${a}#${i} harness error: ${e.message}`)));
        report(out);
    } else report(out);
}
