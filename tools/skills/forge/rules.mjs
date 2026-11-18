#!/usr/bin/env node
// rules.mjs - is each of the owner's rules still in force, and does it still pay off?
//
//   node rules.mjs                       in force + complaints per week (free, about a minute)
//   node rules.mjs --evals [--rule R03]  plus the A/B runs and a blind judge (claude -p, minutes)
//   node rules.mjs --selftest
//   flags: --runs 2  --model sonnet  --judge opus  --jobs 4  --days 35  --dry  --no-field
//
// rules/registry.json holds the rules. Per rule:
//   inForce: checks against what a session really loads - the installed plugin copy, ~/.claude/CLAUDE.md:
//     {"text": "gates:habits", "has": "..."}         a session-text constant of the installed gates.ts holds the phrase
//     {"text": "global", "has": "..."}               ~/.claude/CLAUDE.md holds the phrase
//     {"hook": "verify-guard", "env": "MAKARASTY_VERIFY_GUARD", "canary": {"fn": "shouldRefuse", "args": [...], "is": true}}
//                                                    registered in the installed index.ts, not switched off, and its
//                                                    decision function still refuses the canonical bad input
//   field: {"regex": "...", "since": "YYYY-MM-DD"}   the owner's own messages matching it, distinct chats per week
//   eval: "evals/<id>.json"                          A/B case file (see evals/README.md)
// Results: ~/.claude/makarasty/rules/<stamp>.json, one line per rule appended to history.jsonl.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync, cpSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const OUT = join(HOME, 'makarasty', 'rules');

// ---- where a session's rules really come from ---------------------------------------------------------
export function installed(name) {
    try {
        const j = JSON.parse(readFileSync(join(HOME, 'plugins', 'installed_plugins.json'), 'utf8'));
        const rows = (j.plugins ?? j)[name] ?? [];
        return (rows.find(r => r.scope === 'user') ?? rows[0])?.installPath;
    } catch { return undefined; }
}
const toolsDir = () => installed('makarasty-tools@makarasty');

// "## How to answer me" -> that section of ~/.claude/CLAUDE.md; no heading -> the whole file.
export function section(md, heading) {
    if (!heading) return md;
    const lines = md.split(/\r?\n/), i = lines.findIndex(l => /^#+\s/.test(l) && l.replace(/^#+\s*/, '').trim() === heading);
    if (i < 0) return '';
    const level = lines[i].match(/^#+/)[0].length;
    const end = lines.findIndex((l, k) => k > i && /^#+\s/.test(l) && l.match(/^#+/)[0].length <= level);
    return lines.slice(i, end < 0 ? undefined : end).join('\n');
}

const gatesCache = {};
async function gates(dir) { return gatesCache[dir] ??= await import(pathToFileURL(join(dir, 'hooks', 'gates.ts')).href); }

// A text source a rule names: "gates:habits", "global", "global:How to answer me", "ponytail", "file:<path>".
export async function textOf(ref) {
    const [kind, ...rest] = ref.split(':'), arg = rest.join(':');
    if (kind === 'gates') { const d = toolsDir(); return d ? String((await gates(d))[arg] ?? '') : ''; }
    if (kind === 'global') { const p = join(HOME, 'CLAUDE.md'); return existsSync(p) ? section(readFileSync(p, 'utf8'), arg) : ''; }
    // A file of the installed makarasty-tools copy: a check that lives in a skill's script, not in a hook.
    if (kind === 'tools') { const d = toolsDir(), p = d && join(d, arg); return p && existsSync(p) ? readFileSync(p, 'utf8') : ''; }
    if (kind === 'profile') { const p = join(HOME, 'makarasty', 'profile.md'); return existsSync(p) ? readFileSync(p, 'utf8') : ''; }
    if (kind === 'ponytail') {
        const d = installed('ponytail@ponytail');
        try { return createRequire(import.meta.url)(join(d, 'hooks', 'ponytail-instructions.js')).getPonytailInstructions(arg || 'full'); } catch { return ''; }
    }
    if (kind === 'file') { const p = resolve(HERE, 'rules', arg); return existsSync(p) ? readFileSync(p, 'utf8') : ''; }
    throw new Error(`unknown text source ${ref}`);
}

// Settings env wins over nothing; the process env (this shell) is what a session started here would get too.
function envOff(name) {
    let set = {};
    try { set = JSON.parse(readFileSync(join(HOME, 'settings.json'), 'utf8')).env ?? {}; } catch { }
    const v = process.env[name] ?? set[name];
    return v === 'off' || v === '0';
}

// A secret-guard canary needs a key-shaped string; built here so no key-shaped literal sits in a committed file.
const FAKE = { aws: 'AKIA' + 'QX7RT2ZP4LM9WB3K' };
const fake = v => typeof v === 'string' ? v.replace(/\{fake:(\w+)\}/g, (_, k) => FAKE[k]) : Array.isArray(v) ? v.map(fake) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fake(x)])) : v;

export async function inForce(rule) {
    const fails = [];
    for (const c of rule.inForce ?? []) {
        if (c.text) {
            const t = await textOf(c.text);
            if (!t.includes(c.has)) fails.push(`${c.text} lacks «${c.has.slice(0, 50)}»`);
        } else if (c.hook) {
            const d = toolsDir();
            if (!d) { fails.push('makarasty-tools not installed'); continue; }
            const index = readFileSync(join(d, 'hooks', 'index.ts'), 'utf8');
            // routes is registered by gates, not by index.ts.
            const via = c.via && index.includes(`'./${c.via}.ts'`) && readFileSync(join(d, 'hooks', `${c.via}.ts`), 'utf8').includes(`'./${c.hook}.ts'`);
            if (!index.includes(`'./${c.hook}.ts'`) && !via) fails.push(`${c.hook} not registered in the installed index.ts`);
            if (c.env && envOff(c.env)) fails.push(`${c.env}=off`);
            if (c.canary) {
                try {
                    const m = await import(pathToFileURL(join(d, 'hooks', `${c.hook}.ts`)).href);
                    const got = await m[c.canary.fn](...fake(c.canary.args));
                    const ok = c.canary.match ? new RegExp(c.canary.match, 'i').test(String(got ?? '')) : got === c.canary.is;
                    if (!ok) fails.push(`${c.hook}.${c.canary.fn} canary returned ${JSON.stringify(got)?.slice(0, 80)}`);
                } catch (e) { fails.push(`${c.hook} canary threw: ${e.message.slice(0, 80)}`); }
            }
        }
    }
    return { ok: fails.length === 0, checks: (rule.inForce ?? []).length, fails };
}

// ---- complaints in the field --------------------------------------------------------------------------
const SKIP = ['<', 'Another Claude session', 'This session is being continued', 'Background (from', 'Base directory for this skill', '[', 'Caveat:'];
export function ownWords(o) {
    if (o.type !== 'user' || o.isSidechain || o.isMeta) return [];
    const c = o.message?.content, out = [];
    const keep = t => { t = String(t ?? '').trim(); if (t && t.length < 4000 && !SKIP.some(s => t.startsWith(s))) out.push(t); };
    if (typeof c === 'string') keep(c);
    else if (Array.isArray(c)) for (const b of c) {
        if (b.type === 'text') keep(b.text);
        else if (b.type === 'tool_result') {
            const s = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map(x => x.text || '').join('') : '';
            if (/The user answered|User has answered/.test(s)) for (const m of s.matchAll(/="([^"]*)"/g)) keep(m[1]);
        }
    }
    return out;
}
export const week = ts => { const d = new Date(ts); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

// The text an edit adds: what a rule about written code (field "in": "edits") is counted on.
export function editsAdded(o) {
    if (o.type !== 'assistant') return [];
    const out = [];
    for (const b of o.message?.content ?? []) {
        if (b.type !== 'tool_use' || !/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(b.name)) continue;
        const i = b.input ?? {}, pairs = i.edits ? i.edits.map(e => [e.new_string, e.old_string]) : [[i.new_string ?? i.content ?? i.new_source, i.old_string]];
        for (const [n, old] of pairs) if (n) out.push({ t: String(n), old: String(old ?? '') });
    }
    return out;
}

async function transcripts(days, quick) {
    const root = join(HOME, 'projects'), cutoff = Date.now() - days * 864e5, files = [], seen = new Set(), msgs = [];
    // Subagent transcripts count for edits only (most code is written there), never as the owner's words.
    const walk = (d, sub) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { if (e.name !== 'subagents' || quick.length) walk(p, sub || e.name === 'subagents'); } else if (e.name.endsWith('.jsonl') && statSync(p).mtimeMs >= cutoff) files.push([p, sub]); } };
    if (existsSync(root)) walk(root, false);
    for (const [f, sub] of files) {
        const chat = f.split(/[\\/]/).pop().slice(0, 8);
        for await (const l of createInterface({ input: createReadStream(f, 'utf8'), crlfDelay: Infinity })) {
            const own = !sub && l.includes('"type":"user"'), edit = quick.length && l.includes('"type":"assistant"') && quick.some(q => l.includes(q));
            if (!own && !edit) continue;
            let o; try { o = JSON.parse(l); } catch { continue; }
            if (!o.timestamp || Date.parse(o.timestamp) < cutoff) continue;
            const add = (kind, t, old = '') => { const k = kind + o.timestamp + t.slice(0, 80); if (!seen.has(k)) { seen.add(k); msgs.push({ ts: o.timestamp, chat, kind, t, old }); } };
            if (own) for (const t of ownWords(o)) add('owner', t);
            else for (const e of editsAdded(o)) add('edits', e.t, e.old);
        }
    }
    return { files: files.length, msgs };
}

export function fieldCounts(rule, msgs) {
    const re = new RegExp(rule.field.regex, rule.field.in === 'edits' ? 'm' : 'i'), by = {}, kind = rule.field.in ?? 'owner';
    for (const m of msgs) if (m.kind === kind && re.test(m.t) && !(kind === 'edits' && re.test(m.old))) (by[week(m.ts)] ??= new Set()).add(m.chat);
    const weeks = Object.fromEntries(Object.entries(by).sort().map(([w, s]) => [w, s.size]));
    const since = rule.field.since, after = Object.entries(weeks).filter(([w]) => !since || w >= week(since)).reduce((a, [, n]) => a + n, 0);
    return { weeks, chatsSince: since ? after : undefined };
}

// ---- A/B runs -----------------------------------------------------------------------------------------
function claude(args, { cwd, env, input, timeout = 900000 }) {
    return new Promise(res => {
        const p = spawn('claude', args, { cwd, env, windowsHide: true });
        let out = '', err = '';
        const t = setTimeout(() => { p.kill(); err += `\ntimeout after ${timeout / 1000}s`; }, timeout);
        p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
        p.on('error', e => { clearTimeout(t); res({ out, err: e.message, code: -1 }); });
        p.on('close', code => { clearTimeout(t); res({ out, err, code }); });
        p.stdin.end(input);
    });
}

// stream-json lines -> final reply, the tool calls in order, cost.
export function parseStream(text) {
    const tools = []; let fin = {};
    for (const l of text.split('\n')) {
        if (!l.startsWith('{')) continue;
        let o; try { o = JSON.parse(l); } catch { continue; }
        if (o.type === 'assistant') for (const b of o.message?.content ?? []) if (b.type === 'tool_use') tools.push(`${b.name}: ${typeof b.input?.command === 'string' ? b.input.command : JSON.stringify(b.input).slice(0, 200)}`);
        if (o.type === 'result') fin = o;
    }
    return { reply: fin.result, tools, cost: fin.total_cost_usd ?? 0, error: fin.is_error ? (fin.subtype || 'error') : fin.result === undefined ? 'no result' : undefined };
}

// Arm args may name text sources: "@gates:habits" becomes a file holding that text.
async function armArgs(arm, tmp) {
    const out = [];
    for (const a of arm.args ?? []) {
        if (typeof a === 'string' && a.startsWith('@')) {
            const parts = await Promise.all(a.slice(1).split('+').map(textOf));
            if (parts.some(p => !p)) throw new Error(`empty text source ${a}`);
            mkdirSync(tmp, { recursive: true });
            const f = join(tmp, `arm-${out.length}.txt`); writeFileSync(f, parts.join('\n\n')); out.push(f);
        } else if (a === '{tools}') out.push(toolsDir()); else out.push(a);
    }
    return out;
}

export function scoreRun(p, r, files) {
    const t = String(r.reply ?? ''), log = r.tools.join('\n'), why = [];
    const test = (k, src, want) => { if (p[k] && new RegExp(p[k], 'i').test(src) !== want) why.push(k); };
    test('expect', t, true); test('forbid', t, false); test('expectTool', log, true); test('forbidTool', log, false);
    if (p.checkAfterEdit) {
        const last = r.tools.findLastIndex(x => /^(Edit|MultiEdit|Write|NotebookEdit):/.test(x)), re = new RegExp(p.checkAfterEdit, 'i');
        if (last >= 0 && !r.tools.slice(last + 1).some(x => /^(Bash|PowerShell):/.test(x) && re.test(x))) why.push('no check after the last edit');
    }
    for (const c of p.files ?? []) {
        const s = files[c.file];
        if (c.has && !(s != null && new RegExp(c.has, 'im').test(s))) why.push(`${c.file} lacks ${c.has}`);
        if (c.not && s != null && new RegExp(c.not, 'im').test(s)) why.push(`${c.file} has ${c.not}`);
    }
    if (p.maxWords && t.split(/\s+/).filter(Boolean).length > p.maxWords) why.push('maxWords');
    if (r.error) why.push(r.error);
    return { pass: why.length === 0, why };
}

const JUDGE = (rubric, prompt, x, y) => `You judge two replies an AI coding agent gave to the same request. You do not know which setup produced which.
The person's request:
<<<
${prompt}
>>>
What the person wants (their own standard):
${rubric}

Reply X (tools it called first, then its final message):
<<<
${x}
>>>
Reply Y:
<<<
${y}
>>>
Which reply serves the person better by that standard? Answer with one line of JSON only: {"better":"X"|"Y"|"tie","why":"<15 words>"}`;

const shown = r => `${r.tools.length ? r.tools.slice(0, 30).join('\n') + '\n---\n' : ''}${String(r.reply ?? '(no reply)').slice(0, 6000)}`;

async function pool(jobs, n, fn) {
    const out = []; let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => { while (i < jobs.length) { const k = i++; out[k] = await fn(jobs[k]); } }));
    return out;
}

const cleanEnv = extra => ({ ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ...extra });

async function runOne(c, p, armName, i, o) {
    const arm = c.arms[armName], cwd = mkdtempSync(join(tmpdir(), 'rules-run-'));
    try {
        const fx = p.fixture ?? c.fixture;
        if (fx) {
            cpSync(resolve(HERE, 'rules', 'fixtures', fx), cwd, { recursive: true });
            for (const g of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'start']]) await gitIn(cwd, g);
        }
        const extra = await armArgs(arm, cwd + '-args');
        const args = ['-p', '--model', o.model, '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project', '--no-session-persistence', ...(c.tools ?? ['--tools', '']), ...extra];
        const t0 = Date.now(), r = await claude(args, { cwd, env: cleanEnv(arm.env), input: p.text });
        const s = parseStream(r.out); if (!s.error && r.code) s.error = `exit ${r.code}: ${r.err.trim().split('\n').pop()}`;
        const files = {}; for (const f of p.files ?? []) { const q = join(cwd, f.file); files[f.file] = existsSync(q) ? readFileSync(q, 'utf8') : null; }
        const sc = scoreRun(p, s, files);
        // The start of each checked file, so a failed file check can be read afterwards.
        const seen = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v == null ? null : v.slice(0, 300)]));
        const row = { case: c.id, prompt: p.id, arm: armName, i, ...sc, cost: s.cost, ms: Date.now() - t0, tools: s.tools, reply: s.reply, files: seen, error: s.error };
        console.error(`  [${c.id}/${p.id}] ${armName}#${i} ${sc.pass ? 'pass' : 'FAIL ' + sc.why.join(',')} ${Math.round(row.ms / 1000)}s`);
        return row;
    } finally { rmSync(cwd, { recursive: true, force: true }); rmSync(cwd + '-args', { recursive: true, force: true }); }
}
function gitIn(dir, args) { return new Promise(res => spawn('git', ['-C', dir, ...args], { windowsHide: true }).on('close', res).on('error', res)); }

async function judge(c, p, on, off, o) {
    const flip = Math.random() < 0.5, [x, y] = flip ? [off, on] : [on, off];
    const cwd = mkdtempSync(join(tmpdir(), 'rules-judge-'));
    try {
        const r = await claude(['-p', '--model', o.judge, '--output-format', 'json', '--setting-sources', 'project', '--no-session-persistence', '--tools', ''], { cwd, env: cleanEnv(), input: JUDGE(c.rubric, p.text, shown(x), shown(y)) });
        let res; try { res = JSON.parse(r.out.slice(r.out.indexOf('{'))).result; } catch { }
        const m = String(res ?? '').match(/"better"\s*:\s*"(X|Y|tie)"/i), why = String(res ?? '').match(/"why"\s*:\s*"([^"]*)"/)?.[1];
        const b = m?.[1]?.toUpperCase();
        return { winner: !b ? 'error' : b === 'TIE' ? 'tie' : (b === 'X') !== flip ? 'on' : 'off', why };
    } finally { rmSync(cwd, { recursive: true, force: true }); }
}

// pays: the rule moves the outcome; absorbed: the bare model already does it (a rule to drop); none: no effect.
export function verdict(e, prev) {
    const onR = e.on.pass / e.on.runs, offR = e.off.pass / e.off.runs, j = e.judge, pairs = j.on + j.off + j.tie;
    const judgeOn = pairs ? j.on / pairs : 0, judgeOff = pairs ? j.off / pairs : 0;
    let v = onR - offR >= 0.34 || (judgeOn >= 0.6 && onR >= offR) ? 'pays' : offR - onR >= 0.34 || judgeOff >= 0.6 ? 'hurts' : offR >= 0.8 && onR - offR < 0.2 ? 'absorbed' : 'none';
    // A drop counts only over 8+ runs on both sides: 4 runs swing by a third on their own.
    if (prev && (prev.onRuns ?? 0) >= 8 && e.on.runs >= 8 && prev.onRate - onR >= 0.34) v = 'regressed';
    // A verdict resting on the judge alone over fewer than 4 pairs is a hint, not a result.
    if ((v === 'pays' || v === 'hurts') && Math.abs(onR - offR) < 0.34 && pairs < 4) v += '?';
    return { verdict: v, onRate: +onR.toFixed(2), offRate: +offR.toFixed(2), judgeOn: +judgeOn.toFixed(2) };
}
export function predictionHeld(pred, v) { return !pred ? undefined : (pred.onMin == null || v.onRate >= pred.onMin) && (pred.offMax == null || v.offRate <= pred.offMax); }

async function evalRule(rule, o) {
    const c = JSON.parse(readFileSync(resolve(HERE, 'rules', rule.eval), 'utf8')); c.id ??= rule.id;
    const jobs = [];
    for (const p of c.prompts) for (const arm of ['on', 'off']) for (let i = 0; i < o.runs; i++) jobs.push([p, arm, i]);
    if (o.dry) { for (const [p, a, i] of jobs) console.log(`  [${c.id}/${p.id}] ${a}#${i} ${JSON.stringify(c.arms[a])}`); return; }
    const rows = await pool(jobs, o.jobs, ([p, a, i]) => runOne(c, p, a, i, o));
    const pairs = [];
    if (c.rubric) for (const p of c.prompts) for (let i = 0; i < o.runs; i++) {
        const on = rows.find(r => r.prompt === p.id && r.arm === 'on' && r.i === i), off = rows.find(r => r.prompt === p.id && r.arm === 'off' && r.i === i);
        if (on && off && !on.error && !off.error) pairs.push([p, on, off]);
    }
    const js = await pool(pairs, o.jobs, ([p, on, off]) => judge(c, p, on, off, o));
    const words = r => String(r.reply ?? '').split(/\s+/).filter(Boolean).length;
    const sum = arm => { const rs = rows.filter(r => r.arm === arm); return { runs: rs.length, pass: rs.filter(r => r.pass).length, words: Math.round(rs.reduce((a, r) => a + words(r), 0) / (rs.length || 1)) }; };
    const e = { on: sum('on'), off: sum('off'), judge: { on: 0, off: 0, tie: 0, error: 0 }, cost: +rows.reduce((a, r) => a + (r.cost || 0), 0).toFixed(3) };
    for (const j of js) e.judge[j.winner]++;
    return { ...e, judgeWhy: js.map(j => `${j.winner}: ${j.why ?? ''}`), predict: c.predict, rows };
}

// ---- main ---------------------------------------------------------------------------------------------
async function main(argv) {
    if (argv[0] === '--selftest') return selftest();
    const flag = (n, d) => { const i = argv.indexOf(n); return i < 0 ? d : argv[i + 1]; };
    const o = { runs: Number(flag('--runs', 2)), model: flag('--model', 'sonnet'), judge: flag('--judge', 'opus'), jobs: Number(flag('--jobs', 4)), dry: argv.includes('--dry') };
    const only = flag('--rule')?.split(','), reg = JSON.parse(readFileSync(join(HERE, 'rules', 'registry.json'), 'utf8'));
    const rules = reg.rules.filter(r => !only || only.includes(r.id));
    const histFile = join(OUT, 'history.jsonl'), prevBy = {};
    if (existsSync(histFile)) for (const l of readFileSync(histFile, 'utf8').split('\n')) { try { const h = JSON.parse(l); if (h.onRate != null) prevBy[h.id] = h; } catch { } }
    console.error(`makarasty-tools installed: ${toolsDir() ?? 'NOT INSTALLED'}`);
    let msgs;
    if (!argv.includes('--no-field') && !o.dry) {
        const quick = rules.filter(r => r.field?.in === 'edits').map(r => r.field.quick);
        const t0 = Date.now(), m = await transcripts(Number(flag('--days', 35)), quick); msgs = m.msgs;
        console.error(`field: ${m.msgs.filter(x => x.kind === 'owner').length} own messages, ${m.msgs.length - m.msgs.filter(x => x.kind === 'owner').length} matching edits, ${m.files} transcripts, ${Math.round((Date.now() - t0) / 1000)}s`);
    }
    const results = [];
    for (const r of rules) {
        const res = { id: r.id, rule: r.ru ?? r.rule, inForce: await inForce(r) };
        if (msgs && r.field) res.field = fieldCounts(r, msgs);
        if (argv.includes('--evals') && r.eval) {
            console.error(`eval ${r.id}: ${r.eval}`);
            const e = await evalRule(r, o);
            if (e) { const v = verdict(e, prevBy[r.id]); res.eval = { ...v, on: e.on, off: e.off, judge: e.judge, judgeWhy: e.judgeWhy, cost: e.cost, predict: e.predict, predictionHeld: predictionHeld(e.predict, v), rows: e.rows }; }
        }
        results.push(res);
    }
    if (o.dry) return;
    mkdirSync(OUT, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-'), file = join(OUT, `${stamp}.json`);
    writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), tools: toolsDir(), model: o.model, judge: o.judge, runs: o.runs, results }, null, 1));
    for (const r of results) appendFileSync(histFile, JSON.stringify({ at: stamp, id: r.id, inForce: r.inForce.ok, onRate: r.eval?.onRate, onRuns: r.eval?.on.runs, offRate: r.eval?.offRate, verdict: r.eval?.verdict, chatsSince: r.field?.chatsSince }) + '\n');
    console.table(results.filter(r => r.inForce.checks || r.field || r.eval).map(r => ({
        id: r.id, 'in force': r.inForce.checks ? (r.inForce.ok ? 'yes' : 'NO: ' + r.inForce.fails.join('; ')) : '-',
        'complaints/week': r.field ? Object.values(r.field.weeks).slice(-5).join(' ') || '0' : '-',
        'on/off': r.eval ? `${r.eval.on.pass}/${r.eval.on.runs} vs ${r.eval.off.pass}/${r.eval.off.runs}` : '-',
        judge: r.eval ? `${r.eval.judge.on}:${r.eval.judge.off}:${r.eval.judge.tie}` : '-',
        words: r.eval ? `${r.eval.on.words} vs ${r.eval.off.words}` : '-',
        verdict: r.eval?.verdict ?? '-', predicted: r.eval?.predictionHeld == null ? '-' : r.eval.predictionHeld ? 'held' : 'MISSED',
    })));
    console.log(`results: ${file}`);
    if (results.some(r => !r.inForce.ok || r.eval?.verdict === 'regressed')) process.exitCode = 1;
}

function selftest() {
    assert.equal(section('# A\nx\n## B\ny\n## C\nz', 'B'), '## B\ny', 'one section, up to the next heading of its level');
    assert.equal(section('# A\n## B\ny\n### b\nq\n# D', 'B'), '## B\ny\n### b\nq', 'subsections stay in');
    assert.equal(section('# A', 'Nope'), '', 'missing heading is empty, so a check fails');
    assert.deepEqual(ownWords({ type: 'user', message: { content: [{ type: 'text', text: 'ты уверен?' }, { type: 'text', text: '<system-reminder>x' }] } }), ['ты уверен?'], 'system text skipped');
    assert.deepEqual(ownWords({ type: 'user', message: { content: [{ type: 'tool_result', content: 'User has answered your questions: "Q"="Да, всё", ' }] } }), ['Да, всё'], 'dialog answers are his words');
    assert.deepEqual(ownWords({ type: 'user', isSidechain: true, message: { content: 'x' } }), [], 'subagent lines are not his');
    assert.equal(week('2026-11-19T10:00:00Z'), '2026-11-16', 'weeks start Monday');
    const f = fieldCounts({ field: { regex: 'уверен', since: '2026-11-10' } }, [{ ts: '2026-11-03T00:00:00Z', chat: 'a', kind: 'owner', t: 'ты уверен' }, { ts: '2026-11-12T00:00:00Z', chat: 'b', kind: 'owner', t: 'Ты уверен?' }, { ts: '2026-11-12T01:00:00Z', chat: 'b', kind: 'owner', t: 'уверен?' }, { ts: '2026-11-12T01:00:00Z', chat: 'c', kind: 'edits', t: 'уверен' }]);
    assert.deepEqual(f, { weeks: { '2026-11-02': 1, '2026-11-09': 1 }, chatsSince: 1 }, 'distinct chats per week, counted since, owner words only');
    const ed = editsAdded({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { old_string: '// shortcut: a', new_string: '// shortcut: a\nx' } }, { type: 'tool_use', name: 'Write', input: { content: '// shortcut: new' } }] } });
    const fe = fieldCounts({ field: { in: 'edits', regex: '^\\s*//\\s*shortcut:' } }, ed.map((e, k) => ({ ts: '2026-11-12T00:00:00Z', chat: 'c' + k, kind: 'edits', ...e })));
    assert.deepEqual(fe.weeks, { '2026-11-09': 1 }, 'an edit that keeps an old shortcut line is not counted, a new one is');
    const s = parseStream('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"node --test"}}]}}\n{"type":"result","result":"Готово","total_cost_usd":0.1}');
    assert.deepEqual([s.reply, s.tools, s.error], ['Готово', ['Bash: node --test'], undefined], 'stream parsed');
    const p = { expect: 'готово', expectTool: 'node --test', forbid: 'запусти', files: [{ file: 'a.js', has: 'return a \\+ b', not: 'shortcut:' }], maxWords: 3 };
    assert.equal(scoreRun(p, s, { 'a.js': 'return a + b' }).pass, true, 'all checks pass');
    assert.deepEqual(scoreRun(p, { ...s, reply: 'запусти сам, готово' }, { 'a.js': '// shortcut: x\nreturn a + b' }).why, ['forbid', 'a.js has shortcut:'], 'forbid and file checks fail');
    assert.deepEqual(scoreRun(p, s, { 'a.js': null }).why, ['a.js lacks return a \\+ b'], 'a missing file fails its has check');
    const q = { checkAfterEdit: 'node --test' };
    assert.equal(scoreRun(q, { tools: ['Bash: node --test', 'Edit: {}'], reply: '' }, {}).pass, false, 'a test before the edit is no check of it');
    assert.equal(scoreRun(q, { tools: ['Edit: {}', 'Bash: node --test'], reply: '' }, {}).pass, true, 'a test after the last edit is');
    const e = (on, off, j) => ({ on: { pass: on, runs: 4 }, off: { pass: off, runs: 4 }, judge: j });
    assert.equal(verdict(e(4, 1, { on: 0, off: 0, tie: 0 })).verdict, 'pays', 'script score moves');
    assert.equal(verdict(e(2, 2, { on: 3, off: 1, tie: 0 })).verdict, 'pays', 'judge prefers on');
    assert.equal(verdict(e(2, 2, { on: 2, off: 0, tie: 0 })).verdict, 'pays?', 'two pairs are a hint only');
    assert.equal(verdict(e(4, 4, { on: 1, off: 1, tie: 2 })).verdict, 'absorbed', 'bare model already does it');
    assert.equal(verdict(e(1, 4, { on: 0, off: 3, tie: 1 })).verdict, 'hurts', 'rule makes it worse');
    assert.equal(verdict(e(2, 2, { on: 1, off: 1, tie: 2 })).verdict, 'none');
    assert.equal(verdict(e(1, 0, { on: 0, off: 0, tie: 0 }), { onRate: 1, onRuns: 8 }).verdict, 'none', 'four runs are too few to call a regression');
    const e8 = (on, off) => ({ on: { pass: on, runs: 8 }, off: { pass: off, runs: 8 }, judge: { on: 0, off: 0, tie: 0 } });
    assert.equal(verdict(e8(2, 0), { onRate: 1, onRuns: 8 }).verdict, 'regressed', 'on arm fell since the last run');
    assert.equal(predictionHeld({ onMin: 0.75, offMax: 0.5 }, { onRate: 1, offRate: 0.25 }), true);
    assert.equal(predictionHeld({ onMin: 0.75 }, { onRate: 0.5, offRate: 0 }), false);
    console.log('rules.mjs selftest done');
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) main(process.argv.slice(2)).catch(e => { console.error(e); process.exit(1); });
