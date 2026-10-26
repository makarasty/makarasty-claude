#!/usr/bin/env node
// selfreview.mjs - are the owner's chats with Claude getting better? Streams every main-chain transcript once
// and prints, for a window and the same-length window before it, the numbers that answer that: corrections,
// context size, clones, agents, skill use, installed-but-unused skills, instructions typed again and again.
// It judges nothing; the skill's prose does.
//
//   node selfreview.mjs [--since 2026-09-26] [--until today] [--json] [--save]
//   node selfreview.mjs --selftest
//
// Transcripts: ${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*/*.jsonl (project dirs of AppData-Local-Temp and the
// <session>/subagents subfolders are skipped). --save writes <config>/makarasty/selfreview/<until>.json and the
// report then also shows the change since the latest earlier saved file. Windows are UTC days, `until` included.
//
// shortcut: assistant lines are read with regexes, not JSON.parse (field order of the transcript writer);
//   upgrade to parse if the writer changes order.
// shortcut: a clone's own skill calls and context size are not counted, only its new human prompts.
// shortcut: a file untouched since before the previous window is read only up to its first prompt (clone owner).
import { createReadStream, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const BIG = 2 * 1024 * 1024;
const DAY = 864e5;
const NOISE = /<(system-reminder|command-[a-z]+|local-command-[a-z]+|task-notification)>[\s\S]*?<\/\1>/g;
const SKIP = /^(Caveat:|\[Request interrupted|<local-command|<task-notification|<ci-monitor-event|<user-prompt-submit-hook|This session is being continued)/;
const MACHINE = /^(Continue work handed off|You are the coordinator|Run the brief|You are worker|The owner asked on|Work the brief at|You deliver the sunup|<scheduled-task)/;
// `\b` never matches after Cyrillic, so word ends use a lookahead
const STRICT = /перепровер|ты уверен|я же (сказал|просил|говорил)|зачем ты|снова не|не работает|ничего не (изменилось|поменялось)|сломал|галюцин|нагалюц|ты не сделал|не исправил|doesn'?t work|you broke|still (broken|not)/iu;
const BROAD = /перепровер|ты уверен|я же (сказал|просил|говорил)|не так(?![\p{L}\p{N}])|зачем ты|опять|снова не|не работает|не то(?![\p{L}\p{N}])|ничего не (изменилось|поменялось)|сломал|не понял|непонятно|не нравит|ужасн|бред|галюцин|нагалюц|хуйн|хуй|бля|пиздец|нахуй|заебал|ебан|ты не сделал|не исправил|wtf|what the|doesn'?t work|you broke|still (broken|not)/iu;
const PLAIN = /простым языком|короче|слишком много текста|много букв|проще объясни|не понял|не понятно|непонятно|plain (english|language|words)|too (long|much text)|explain (it )?simply|eli5/iu;
const SELF_PROJ = /makarasty-claude|sunup|claude-desktop-toolbox/i;
const CMD_BUILTIN = new Set(['model', 'compact', 'doctor', 'insights', 'goal', 'auto-mode-setup', 'clear', 'resume', 'config', 'context', 'cost', 'usage', 'login', 'logout', 'help', 'exit', 'init', 'permissions', 'status', 'agents', 'mcp', 'plugin', 'memory', 'rewind', 'fast', 'effort', 'terminal-setup', 'ide', 'vim', 'bug', 'export', 'review', 'rename']);
const SK_BUILTIN = /^(loop|simplify|code-review|security-review|review|init|run|schedule|batch|claude-api|update-config|keybindings-help|fewer-permission-prompts|plugin-authoring|workflow-authoring|dataviz|debug|artifact-[\w-]+)$/;

// Secrets never reach the output: masked before anything is clipped or stored.
const SECRETS = [
    /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, /\bgh[pousr]_[A-Za-z0-9]{16,}/g, /\bgithub_pat_[A-Za-z0-9_]{16,}/g, /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
    /\bAKIA[0-9A-Z]{12,}/g, /\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi,
    /\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*\S+/gi,
    /[A-Za-z0-9+\/=_-]{32,}/g,
];
export const mask = s => SECRETS.reduce((t, r) => t.replace(r, '[redacted]'), String(s ?? ''));
export const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
export const safe = (s, n = 120) => clip(mask(s), n);

const hash = t => createHash('sha1').update(t).digest('base64').slice(0, 12);
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const projOf = d => d.replace(/--claude-worktrees-.*/, '');

// The prompt a user line carries: {text, cmd, kind: 'h' human | 'm' machine | 'p' element pick}, or null.
export function promptOf(o) {
    if (o.isMeta || o.isCompactSummary || o.isSidechain) return null;
    const c = o.message?.content;
    let raw;
    if (typeof c === 'string') raw = c;
    else if (Array.isArray(c)) {
        if (c.some(b => b?.type === 'tool_result')) return null;
        raw = c.filter(b => b?.type === 'text').map(b => b.text).join('\n');
    } else return null;
    raw = raw.trim();
    if (SKIP.test(raw)) return null;
    const cmd = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(raw)?.[1];
    let text = raw.replace(NOISE, '').trim();
    if (cmd) text = `/${cmd} ${/<command-args>([\s\S]*?)<\/command-args>/.exec(raw)?.[1] ?? ''}`.trim();
    if (!text || SKIP.test(text)) return null;
    return { text, cmd, kind: text.startsWith('<launch-selected-element>') ? 'p' : MACHINE.test(text) ? 'm' : 'h' };
}

// Streams one transcript. headOnly stops after the first prompt (only its start and clone key are needed).
export async function scanFile(file, headOnly = false) {
    const s = { id: file.replace(/^.*[\\/]/, '').replace(/\.jsonl$/, ''), file, maxCtx: 0, agents: 0, calls: {}, cmds: {}, events: [] };
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
        if (line.includes('"isSidechain":true')) continue;
        if (line.includes('"type":"user"')) {
            if (line.includes('"type":"tool_result"')) continue;
            let o; try { o = JSON.parse(line); } catch { continue; }
            const p = promptOf(o);
            if (!p || !o.timestamp) continue;
            if (p.cmd && !CMD_BUILTIN.has(p.cmd)) s.cmds[p.cmd] = (s.cmds[p.cmd] || 0) + 1;
            const h = p.kind === 'h';
            s.events.push({ ts: o.timestamp, key: o.timestamp.slice(0, 19) + '\0' + hash(p.text), kind: p.kind,
                strict: h && STRICT.test(p.text), broad: h && BROAD.test(p.text), plain: h && PLAIN.test(p.text),
                text: h && !p.text.startsWith('/') && p.text.length <= 1500 ? clip(mask(p.text), 400) : '' });
            if (headOnly) break;
        } else if (!headOnly && line.includes('"type":"assistant"')) {
            const u = line.indexOf('"usage":{');
            if (u >= 0) {
                const w = line.slice(u, u + 500), n = k => +(new RegExp(`"${k}":(\\d+)`).exec(w)?.[1] ?? 0);
                const c = n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens');
                if (c > s.maxCtx) s.maxCtx = c;
            }
            if (!line.includes('"type":"tool_use"')) continue;
            for (const m of line.matchAll(/"type":"tool_use","id":"[^"]*","name":"(Skill|Agent|Task)"(?:,"input":\{[^}]{0,400}?"skill":"([^"]+)")?/g)) {
                if (m[1] === 'Skill') { if (m[2]) s.calls[m[2]] = (s.calls[m[2]] || 0) + 1; } else s.agents++;
            }
        }
    }
    return s;
}

// Desktop account per cliSessionId (Claude-Profiles dirs are the accounts); reads only the head of each file.
function desktopAccounts(sinceMs) {
    const map = new Map(), roots = [];
    const lad = process.env.LOCALAPPDATA, apd = process.env.APPDATA;
    if (lad) { try { for (const a of readdirSync(join(lad, 'Claude-Profiles'))) roots.push([a, join(lad, 'Claude-Profiles', a, 'claude-code-sessions')]); } catch {} }
    for (const r of [apd && join(apd, 'Claude'), join(homedir(), 'Library', 'Application Support', 'Claude'), join(homedir(), '.config', 'Claude')]) if (r) roots.push(['default', join(r, 'claude-code-sessions')]);
    const walk = (dir, account, depth) => {
        let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
            const p = join(dir, e.name);
            if (e.isDirectory()) { if (depth < 4) walk(p, account, depth + 1); continue; }
            if (!/^local_.*\.json$/.test(e.name)) continue;
            try {
                if (statSync(p).mtimeMs < sinceMs) continue;
                const id = /"cliSessionId":"([^"]+)"/.exec(readFileSync(p, 'utf8').slice(0, 4096))?.[1];
                if (id) map.set(id, account);
            } catch {}
        }
    };
    for (const [a, r] of roots) walk(r, a, 0);
    return map;
}

// Skills installed: plugin skills (installPaths of installed_plugins.json) and personal ~/.claude/skills.
export function installedSkills(cfg) {
    const out = new Set();
    const add = (prefix, dir) => {
        let ents; try { ents = readdirSync(join(dir, 'skills'), { withFileTypes: true }); } catch { return; }
        for (const e of ents) if (e.isDirectory() && existsSync(join(dir, 'skills', e.name, 'SKILL.md'))) out.add(prefix + e.name);
    };
    try {
        const j = JSON.parse(readFileSync(join(cfg, 'plugins', 'installed_plugins.json'), 'utf8'));
        for (const [k, v] of Object.entries(j.plugins ?? {})) for (const i of Array.isArray(v) ? v : [v]) if (i?.installPath) add(k.split('@')[0] + ':', i.installPath);
    } catch {}
    add('', cfg);
    return [...out].sort();
}

const catOf = n => n.startsWith('makarasty-tools:') ? 'makarasty-tools' : n.startsWith('makarasty:') ? 'makarasty' : SK_BUILTIN.test(n) ? 'built-in' : 'third-party';

// Everything the report needs from [from, to) ISO strings, given the deduped sessions and prompts.
function measure(D, from, to) {
    const inW = ts => ts >= from && ts < to;
    const chats = D.chats.filter(s => inW(s.born)), clones = D.clones.filter(s => inW(s.born));
    const ps = D.prompts.filter(p => inW(p.ts));
    const hp = ps.filter(p => p.kind === 'h');
    const pct = (n, d) => d ? +(100 * n / d).toFixed(1) : 0;
    const ctx = chats.filter(s => s.maxCtx > 0), c4 = ctx.filter(s => s.maxCtx > 4e5).length, c7 = ctx.filter(s => s.maxCtx > 7e5).length;
    const sk = {}, per = {};
    for (const s of chats) {
        const names = new Set([...Object.keys(s.calls), ...Object.keys(s.cmds)]);
        for (const n of names) { const v = Math.max(s.calls[n] || 0, s.cmds[n] || 0); sk[n] = (sk[n] || 0) + v; per[n] = (per[n] || 0) + 1; } // a command and its Skill call are one use
    }
    const bycat = { makarasty: 0, 'makarasty-tools': 0, 'third-party': 0, 'built-in': 0 };
    for (const [n, v] of Object.entries(sk)) bycat[catOf(n)] += v;
    const acct = {};
    for (const p of hp) { const a = D.accounts.get(p.sid) ?? 'cli'; acct[a] = (acct[a] || 0) + 1; }
    const m = {
        chats: chats.length, prompts: hp.length, ppc: +(hp.length / (chats.length || 1)).toFixed(1), projects: new Set(hp.map(p => p.proj)).size,
        strict: pct(hp.filter(p => p.strict).length, hp.length), broad: pct(hp.filter(p => p.broad).length, hp.length), plain: pct(hp.filter(p => p.plain).length, hp.length),
        clone: pct(clones.length, chats.length + clones.length),
        c400: c4, c400p: pct(c4, ctx.length), c700: c7, c700p: pct(c7, ctx.length),
        agents: median(chats.map(s => s.agents)), skills: Object.values(bycat).reduce((a, b) => a + b, 0),
        'sk:makarasty': bycat.makarasty, 'sk:makarasty-tools': bycat['makarasty-tools'], 'sk:third-party': bycat['third-party'], 'sk:built-in': bycat['built-in'],
        self: pct(hp.filter(p => SELF_PROJ.test(p.proj)).length, hp.length),
        machine: ps.filter(p => p.kind === 'm').length, picks: ps.filter(p => p.kind === 'p').length,
    };
    return { m, sk, per, acct, hp };
}

// Phrases of 6+ words typed in at least `minChats` different chats; overlapping ones are merged into the commonest.
export function repeated(hp, { n = 6, minChats = 3, top = 10 } = {}) {
    const seen = new Map();
    let cur = null, ci = -1;
    for (const p of [...hp].sort((a, b) => (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0))) {
        if (!p.text || p.text.startsWith('/')) continue;
        if (p.sid !== cur) { cur = p.sid; ci++; }
        // urls, paths and key=value pairs are pasted data, not instructions
        const w = p.text.toLowerCase().replace(/\S*[\\/:=]\S*/g, ' ').split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 60);
        for (let i = 0; i + n <= w.length; i++) {
            const g = w.slice(i, i + n);
            if (new Set(g).size < 4 || g.filter(x => /^\d+$/.test(x)).length > 1 || g.includes('redacted')) continue;
            const k = g.join(' '), e = seen.get(k);
            if (!e) seen.set(k, { n: 1, last: ci }); else if (e.last !== ci) { e.n++; e.last = ci; }
        }
    }
    const cand = [...seen].filter(([, e]) => e.n >= minChats).sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1));
    const picked = [];
    for (const [k, e] of cand) {
        const ws = new Set(k.split(' '));
        if (picked.some(q => [...ws].filter(x => q.ws.has(x)).length / ws.size >= 0.5)) continue;
        picked.push({ phrase: safe(k), chats: e.n, ws });
        if (picked.length >= top) break;
    }
    return picked.map(({ phrase, chats }) => ({ phrase, chats }));
}

export async function collect({ cfg, since, until, log = () => {} }) {
    const from = since + 'T00:00:00.000Z', to = new Date(Date.parse(until + 'T00:00:00Z') + DAY).toISOString();
    const span = Date.parse(to) - Date.parse(from), pFrom = new Date(Date.parse(from) - span).toISOString();
    const root = join(cfg, 'projects'), sessions = [];
    let dirs = []; try { dirs = readdirSync(root); } catch {}
    const files = [];
    for (const d of dirs) {
        if (d.includes('AppData-Local-Temp')) continue;
        let ents; try { ents = readdirSync(join(root, d), { withFileTypes: true }); } catch { continue; }
        for (const e of ents) {
            if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
            const p = join(root, d, e.name);
            try { const st = statSync(p); files.push({ p, proj: projOf(d), mtime: st.mtimeMs, birth: st.birthtimeMs || st.mtimeMs }); } catch {}
        }
    }
    const cut = Date.parse(pFrom) - DAY;
    let full = 0, head = 0, i = 0;
    for (const f of files) {
        const h = f.mtime < cut;
        let s; try { s = await scanFile(f.p, h); } catch { continue; }
        if (!s.events.length) continue;
        h ? head++ : full++;
        Object.assign(s, { proj: f.proj, birth: f.birth, start: s.events[0].ts, key: s.events[0].key });
        s.events.sort((a, b) => (a.ts < b.ts ? -1 : 1)); // the first event is the first prompt
        sessions.push(s);
        if (++i % 300 === 0) log(`${i}/${files.length} files`);
    }
    // the earliest session owns a prompt (ts to the second + text); clones copy history, so their copies are not theirs
    sessions.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.birth - b.birth || (a.id < b.id ? -1 : 1)));
    const seen = new Set(), firstKeys = new Set(), D = { chats: [], clones: [], prompts: [], accounts: new Map() };
    for (const s of sessions) {
        const clone = firstKeys.has(s.key);
        firstKeys.add(s.key);
        let born = null;
        for (const e of s.events) {
            if (seen.has(e.key)) continue;
            seen.add(e.key); born ??= e.ts;
            D.prompts.push({ ...e, sid: s.id, proj: s.proj });
        }
        if (clone) { s.born = born ?? s.events.at(-1).ts; D.clones.push(s); } else { s.born = s.start; D.chats.push(s); }
    }
    D.accounts = desktopAccounts(Date.parse(pFrom));
    const cur = measure(D, from, to), prev = measure(D, pFrom, from);
    const installed = installedSkills(cfg);
    const used = new Set(Object.keys(cur.sk));
    const bare = new Set([...used].filter(n => !n.includes(':')));
    const top = Object.entries(cur.sk).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 15).map(([name, uses]) => ({ name, uses, chats: cur.per[name], cat: catOf(name) }));
    const total = Math.max(1, cur.m.prompts);
    return {
        generated: new Date().toISOString(), since, until, prevSince: pFrom.slice(0, 10), prevUntil: new Date(Date.parse(from) - DAY).toISOString().slice(0, 10),
        window: cur.m, previous: prev.m, topSkills: top,
        unusedSkills: installed.filter(n => !used.has(n) && !bare.has(n.slice(n.indexOf(':') + 1))), installedSkills: installed.length,
        accounts: Object.fromEntries(Object.entries(cur.acct).map(([a, n]) => [a, +(100 * n / total).toFixed(1)])),
        repeated: repeated(cur.hp), scanned: { files: files.length, full, head, sessions: sessions.length },
    };
}

const ROWS = [
    ['chats', 'chats', 'n'], ['prompts', 'human prompts', 'n'], ['ppc', 'prompts per chat', 'x'], ['projects', 'projects', 'n'],
    ['strict', 'strict corrections %', 'pct'], ['broad', 'broad corrections %', 'pct'], ['plain', 'plain-language asks %', 'pct'], ['clone', 'clone %', 'pct'],
    ['c400', 'chats over 400k', 'n'], ['c400p', '  as % of chats', 'pct'], ['c700', 'chats over 700k', 'n'], ['c700p', '  as % of chats', 'pct'],
    ['agents', 'median agents per chat', 'x'], ['skills', 'skill calls', 'n'],
    ['sk:makarasty', '  makarasty', 'n'], ['sk:makarasty-tools', '  makarasty-tools', 'n'], ['sk:third-party', '  third-party', 'n'], ['sk:built-in', '  built-in', 'n'],
    ['self', 'self-tooling share of prompts %', 'pct'], ['machine', 'machine prompts (excluded)', 'n'], ['picks', 'element picks (excluded)', 'n'],
];
const HEAD = ['strict', 'c700', 'c700p', 'clone'];

const delta = (a, b, kind) => {
    const d = +(a - b).toFixed(1), sg = d > 0 ? '+' : '';
    if (kind === 'pct') return `${sg}${d} pp`;
    if (kind === 'x') return `${sg}${d}`;
    return `${sg}${d}` + (b ? ` (${sg}${Math.round(100 * (a - b) / b)}%)` : '');
};

export function render(r, saved) {
    const W = r.window, P = r.previous, S = saved?.window;
    const cell = (k, v, kind) => kind === 'pct' ? v + '%' : String(v);
    const L = [`# Self review: ${r.since} to ${r.until} vs ${r.prevSince} to ${r.prevUntil}`, ''];
    L.push('Headline: ' + HEAD.map(k => { const [, name, kind] = ROWS.find(x => x[0] === k); return `${name.trim()} ${cell(k, W[k], kind)} (${delta(W[k], P[k], kind)})`; }).join('; '), '');
    const rows = [['metric', 'now', 'before', 'change', ...(S ? [`vs saved ${saved.until}`] : [])]];
    for (const [k, name, kind] of ROWS) rows.push([name, cell(k, W[k], kind), cell(k, P[k], kind), delta(W[k], P[k], kind), ...(S ? [kind === 'n' || S[k] == null ? '-' : delta(W[k], S[k], kind)] : [])]);
    const w = rows[0].map((_, i) => Math.max(...rows.map(x => x[i].length)));
    rows.forEach((x, j) => { L.push('| ' + x.map((c, i) => c.padEnd(w[i])).join(' | ') + ' |'); if (!j) L.push('|' + w.map(n => '-'.repeat(n + 2)).join('|') + '|'); });
    L.push('', `Prompts by account: ${Object.entries(r.accounts).sort((a, b) => b[1] - a[1]).map(([a, v]) => `${a} ${v}%`).join(', ') || '-'}`);
    L.push('', 'Top skills (now):', ...(r.topSkills.length ? r.topSkills.map((s, i) => `${String(i + 1).padStart(2)}. ${s.name}  ${s.uses} uses in ${s.chats} chats  [${s.cat}]`) : ['  none']));
    L.push('', `Installed but not called in the window (${r.unusedSkills.length} of ${r.installedSkills}): ${r.unusedSkills.join(', ') || 'none'}`);
    L.push('', 'Most repeated instructions (6+ words, 3+ chats):', ...(r.repeated.length ? r.repeated.map((x, i) => `${String(i + 1).padStart(2)}. ${x.chats} chats: "${x.phrase}"`) : ['  none']));
    L.push('', `Read ${r.scanned.full} transcripts in full and ${r.scanned.head} to their first prompt (${r.scanned.files} files, ${r.scanned.sessions} with a prompt).`);
    return L.join('\n');
}

function latestSaved(dir, until) {
    let names = []; try { names = readdirSync(dir).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n) && n < until + '.json').sort(); } catch {}
    if (!names.length) return null;
    try { return JSON.parse(readFileSync(join(dir, names.at(-1)), 'utf8')); } catch { return null; }
}

const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + 'T00:00:00Z'));

export async function run(argv, cfg) {
    const flag = (n, d) => { const i = argv.indexOf(n); return i < 0 ? d : argv[i + 1]; };
    const today = new Date().toISOString().slice(0, 10);
    let until = flag('--until', 'today'); if (until === 'today') until = today;
    let since = flag('--since', null);
    if (!isDate(until)) throw new Error(`--until must be YYYY-MM-DD or today, got ${until}`);
    since ??= new Date(Date.parse(until + 'T00:00:00Z') - 30 * DAY).toISOString().slice(0, 10);
    if (!isDate(since) || since > until) throw new Error(`--since must be YYYY-MM-DD and not after --until, got ${since}`);
    const r = await collect({ cfg, since, until, log: m => process.stderr.write(m + '\n') });
    const dir = join(cfg, 'makarasty', 'selfreview'), saved = latestSaved(dir, until);
    if (argv.includes('--save')) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, until + '.json'), JSON.stringify(r, null, 1)); }
    return argv.includes('--json') ? JSON.stringify(r, null, 1) : render(r, saved);
}

async function selftest() {
    const root = mkdtempSync(join(tmpdir(), 'selfreview-st-'));
    try {
        const cfg = join(root, 'cfg'), pdir = join(cfg, 'projects', 'C--x-makarasty-claude'), odir = join(cfg, 'projects', 'C--x-other');
        for (const d of [pdir, odir, join(cfg, 'projects', 'C--x-AppData-Local-Temp-scratch'), join(pdir, 'sub', 'subagents')]) mkdirSync(d, { recursive: true });
        const U = (text, ts, extra = {}) => JSON.stringify({ type: 'user', isSidechain: false, timestamp: ts, message: { role: 'user', content: text }, ...extra });
        const A = (content, ts, ctx = 1000) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content, usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: ctx - 2, output_tokens: 5 } } });
        const T = (name, input) => ({ type: 'tool_use', id: 'toolu_1', name, input });
        const phrase = 'всегда сначала покажи мне план перед правками';
        // window 2026-10-10..2026-10-20 (11 days), previous 2026-09-29..2026-10-09
        const a = [U('привет сделай задачу один', '2026-10-12T10:00:00.000Z'),
            A([T('Skill', { skill: 'makarasty-tools:forge' }), T('Agent', { description: 'x' }), T('Agent', { description: 'y' })], '2026-10-12T10:01:00.000Z', 750000),
            U('ты уверен? перепроверь', '2026-10-12T10:05:00.000Z'),
            U('это не то, переделай', '2026-10-12T10:06:00.000Z'),
            U('простым языком объясни', '2026-10-12T10:07:00.000Z'),
            U('Continue work handed off from the chat x', '2026-10-12T10:08:00.000Z'),
            U('<launch-selected-element>div</launch-selected-element>', '2026-10-12T10:09:00.000Z'),
            U('my key sk-abcdefghijklmnopqrstuvwxyz123456 and password=hunter2 ' + phrase, '2026-10-12T10:10:00.000Z'),
            U('<command-name>/makarasty-tools:unfinished</command-name><command-args>3</command-args>', '2026-10-12T10:11:00.000Z'),
            U('', '2026-10-12T10:12:00.000Z', { message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } })].join('\n');
        writeFileSync(join(pdir, 'a.jsonl'), a);
        writeFileSync(join(pdir, 'a-clone.jsonl'), a.split('\n').slice(0, 3).join('\n') + '\n' + U('новый вопрос после клона', '2026-10-15T09:00:00.000Z'));
        writeFileSync(join(pdir, 'sub', 'subagents', 'agent-1.jsonl'), U('subagent prompt', '2026-10-12T11:00:00.000Z'));
        writeFileSync(join(cfg, 'projects', 'C--x-AppData-Local-Temp-scratch', 't.jsonl'), U('temp project prompt', '2026-10-12T11:00:00.000Z'));
        writeFileSync(join(odir, 'b.jsonl'), [U('второй чат ' + phrase, '2026-10-13T10:00:00.000Z'), U('doesn\'t work, still broken', '2026-10-13T10:01:00.000Z'), A([T('Skill', { skill: 'foo' })], '2026-10-13T10:02:00.000Z', 450000)].join('\n'));
        writeFileSync(join(odir, 'c.jsonl'), U('третий чат ' + phrase + ' пожалуйста', '2026-10-14T10:00:00.000Z'));
        writeFileSync(join(odir, 'old.jsonl'), [U('старый чат', '2026-10-01T10:00:00.000Z'), U('зачем ты это сделал', '2026-10-01T10:01:00.000Z')].join('\n'));
        const plug = join(root, 'plug'); mkdirSync(join(plug, 'skills', 'forge'), { recursive: true }); mkdirSync(join(plug, 'skills', 'idle'), { recursive: true });
        writeFileSync(join(plug, 'skills', 'forge', 'SKILL.md'), '---\n---\n'); writeFileSync(join(plug, 'skills', 'idle', 'SKILL.md'), '---\n---\n');
        mkdirSync(join(cfg, 'skills', 'foo'), { recursive: true }); writeFileSync(join(cfg, 'skills', 'foo', 'SKILL.md'), '---\n---\n');
        mkdirSync(join(cfg, 'plugins'), { recursive: true });
        writeFileSync(join(cfg, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'makarasty-tools@m': [{ installPath: plug }] } }));

        const r = await collect({ cfg, since: '2026-10-10', until: '2026-10-20' });
        const W = r.window, P = r.previous;
        assert.equal(W.chats, 3, 'a, b, c are chats; the clone, subagent and temp project are not');
        assert.equal(W.clone, 25, 'one clone of four sessions');
        assert.equal(W.prompts, 10, 'human prompts after dedupe, machine/pick/tool_result out: ' + W.prompts);
        assert.equal(W.machine, 1); assert.equal(W.picks, 1);
        assert.equal(W.strict, 20, 'ты уверен + doesn\'t work of 10');
        assert.equal(W.broad, 30, 'strict two plus "не то"');
        assert.equal(W.plain, 10);
        assert.equal(W.c400, 2); assert.equal(W.c700, 1); assert.equal(W.c700p, 50, 'two chats have usage: 750k and 450k');
        assert.equal(W.agents, 0, 'median of 2,0,0'); assert.equal(W['sk:makarasty-tools'], 2, 'forge call and unfinished command'); assert.equal(W['sk:third-party'], 1);
        assert.equal(W.self, 70, 'seven of ten prompts are in makarasty-claude');
        assert.equal(P.chats, 1); assert.equal(P.strict, 50);
        assert.deepEqual(r.unusedSkills, ['makarasty-tools:idle'], 'forge and foo were called');
        assert.equal(r.repeated.length, 1); assert.ok(r.repeated[0].chats === 3 && r.repeated[0].phrase.length <= 120, JSON.stringify(r.repeated));
        const text = render(r, null);
        assert.ok(!/sk-abcdef|hunter2|abcdefghijklmnopqrstuvwxyz123456/.test(text + JSON.stringify(r)), 'secrets are masked');
        assert.ok(text.includes('strict corrections %') && text.includes('Headline'));
        assert.equal(mask('Authorization: Bearer abcdefgh12345678 ghp_' + 'a'.repeat(20) + ' AKIA' + 'B'.repeat(16)).includes('abcdefgh12345678'), false);
        assert.ok(safe('x'.repeat(300)).length <= 120);
        // end to end: --save twice, the second shows the change since the first
        const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg }, me = fileURLToPath(import.meta.url);
        const go = args => spawnSync(process.execPath, [me, ...args], { encoding: 'utf8', env });
        const o1 = go(['--since', '2026-09-29', '--until', '2026-10-09', '--save']);
        assert.equal(o1.status, 0, o1.stderr); assert.ok(existsSync(join(cfg, 'makarasty', 'selfreview', '2026-10-09.json')) && !o1.stdout.includes('vs saved'));
        const o2 = go(['--since', '2026-10-10', '--until', '2026-10-20', '--save']);
        assert.ok(o2.stdout.includes('vs saved 2026-10-09'), o2.stdout);
        assert.equal(JSON.parse(go(['--since', '2026-10-10', '--until', '2026-10-20', '--json']).stdout).window.chats, 3);
        assert.notEqual(go(['--since', 'junk']).status, 0, 'bad date fails');
        console.log('selfreview.mjs selftest done');
    } finally { rmSync(root, { recursive: true, force: true }); }
}

async function main(argv) {
    if (argv[0] === '--selftest') return selftest();
    const cfg = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const t0 = Date.now();
    console.log(await run(argv, cfg));
    if (!argv.includes('--json')) console.error(`time ${((Date.now() - t0) / 1000).toFixed(1)}s, peak RSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).catch(e => { console.error(e.stack || e); process.exit(1); });
}
