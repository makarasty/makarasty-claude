#!/usr/bin/env node
// chats.mjs - what do the other chats of this project still leave open? Reads the Claude Code transcripts
// of one project (and its worktrees) and prints, per chat, what the model needs to judge it: the first and
// last human prompts, the last assistant text, files edited, open todos, commit/push counts, and which of the
// edited files are still uncommitted. It judges nothing.
//
//   node chats.mjs [--cwd <dir>] [--days 7] [--limit 40] [--self <session-id>] [--json]
//   node chats.mjs --selftest
//
// Transcripts: ${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<cwd with every non-alphanumeric as ->/*.jsonl.
// Desktop titles and accounts are read when the Desktop app's session folders exist.
//
// shortcut: Task* todo ids are assumed sequential from 1 per chat; upgrade if a transcript breaks that.
// shortcut: an assistant line over 2 MB is not parsed; its timestamp, last text tail and edit paths come from regexes over its
// first and last 64 KB, so an edit in the middle of it can be missed. Such chats are counted and marked as partly read.
import { createReadStream, readdirSync, statSync, openSync, readSync, closeSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const BIG = 2 * 1024 * 1024;
const LIVE_MS = 5 * 60 * 1000;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const WIN = process.platform === 'win32';
const WINDOW = 64 * 1024;
const NOISE =/<(system-reminder|command-[a-z]+|local-command-[a-z]+|task-notification)>[\s\S]*?<\/\1>/g;

export const slugOf = cwd => resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
// Hides pasted credentials in anything that gets printed. Over-masking is fine; leaking is not.
const MASKED = '‹masked›';
const SECRETS = [
    [/\bBearer\s+\S+/gi, `Bearer ${MASKED}`],
    [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASKED}@`],
    [/(password|passwd|пароль|token|secret|api[_-]?key|x-api-key)(["']?\s*[:=]\s*)["']?[^\s"']+/gi, `$1$2${MASKED}`],
    [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g, MASKED],
    [/(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, MASKED],
    [/(?<![A-Za-z0-9])xox[abp]-[A-Za-z0-9-]{10,}/g, MASKED],
    [/(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g, MASKED],
    [/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, MASKED],
    [/(?<![A-Za-z0-9])[0-9a-f]{32,}(?![A-Za-z0-9])/gi, MASKED],
    // runs are found first and judged after: lookaheads inside the pattern are quadratic on a long run
    [/[A-Za-z0-9+/]{32,}={0,2}/g, m => (/\d/.test(m) && /[A-Z]/.test(m) && /[a-z]/.test(m) ? MASKED : m)],
];
export const mask = s => SECRETS.reduce((t, [re, to]) => t.replace(re, to), String(s ?? ''));
// head and tail of a long text: a closing question lives at the end
const cut = (s, n = 600) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, 150) + ' … ' + s.slice(-(n - 150)) : s; };
const norm = p => p.replace(/\\/g, '/').replace(/\/+$/, '');
const key = p => (WIN || process.platform === 'darwin' ? norm(p).toLowerCase() : norm(p));

// Human text of a user line, or null when the line is a tool result, meta, a compaction summary or only noise.
export function humanText(o) {
    if (o.isMeta || o.isCompactSummary || o.isSidechain) return null;
    const c = o.message?.content;
    let raw;
    if (typeof c === 'string') raw = c;
    else if (Array.isArray(c)) {
        if (c.some(b => b?.type === 'tool_result')) return null;
        raw = c.filter(b => b?.type === 'text').map(b => b.text).join('\n');
    } else return null;
    const cmd = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(raw)?.[1];
    const text = raw.replace(NOISE, '').trim();
    if (/^\[Request interrupted/.test(text)) return null;
    const out = text || cmd || '';
    return out ? { text: out, cmd } : null;
}

export const endsWithQuestion = t => /[?？][\s)"'»*_`]*$/.test(String(t ?? '').trim());

// Streams one transcript; returns the facts about its main chain, or null when it has no human prompt.
export async function scanFile(file, cwd) {
    const s = { id: file.replace(/^.*[\\/]/, '').replace(/\.jsonl$/, ''), file, title: null, first: null, firstTs: null, start: null, last: null,
        prompts: [], sig: [], partial: 0, lastText: null, edited: new Set(), commits: 0, pushes: 0, handoff: false, todos: null };
    const tasks = new Map();
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
        const isUser = line.includes('"type":"user"');
        const isAsst = !isUser && line.includes('"type":"assistant"');
        if (!isUser && !isAsst) {
            if (line.includes('"type":"custom-title"')) { try { s.title = JSON.parse(line).customTitle || s.title; } catch {} }
            continue;
        }
        if (line.includes('"isSidechain":true')) continue;
        if (line.length > BIG && !isUser) { bigLine(s, tasks, line, cwd); continue; }
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.isSidechain) continue;
        if (o.timestamp) { s.start ??= o.timestamp; s.last = o.timestamp; }
        if (o.type === 'user') {
            const h = humanText(o);
            if (!h) continue;
            if (h.cmd && /makarasty-tools:handoff/.test(h.cmd)) s.handoff = true;
            const safe = mask(h.text);
            s.first ??= safe; s.firstTs ??= o.timestamp; s.sig.push(clip(safe, 120));
            s.prompts.push(clip(safe, 300)); if (s.prompts.length > 3) s.prompts.shift();
        } else if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
            for (const b of o.message.content) {
                if (b.type === 'text' && b.text?.trim()) s.lastText = b.text;
                else if (b.type === 'tool_use') toolUse(s, tasks, b, cwd);
            }
        }
    }
    if (s.first == null) return null;
    s.title = s.title && mask(s.title); s.lastText = s.lastText && mask(s.lastText);
    if (!s.todos && tasks.size) s.todos = [...tasks.values()];
    s.edited = [...s.edited];
    return s;
}

// An assistant line over BIG: read what matters from its first and last 64 KB without parsing it.
function bigLine(s, tasks, line, cwd) {
    s.partial++;
    const head = line.slice(0, WINDOW), tail = line.slice(-WINDOW);
    const unesc = t => { try { return JSON.parse(`"${t}"`); } catch { return t; } };
    const ts = /"timestamp":"([^"]+)"/.exec(head)?.[1] ?? /"timestamp":"([^"]+)"/.exec(tail)?.[1];
    if (ts) { s.start ??= ts; s.last = ts; }
    for (const w of [head, tail]) {
        for (const m of w.matchAll(/"name":"(Edit|Write|NotebookEdit|MultiEdit)"[^]*?"(?:file_path|notebook_path)":"((?:[^"\\]|\\.)*)"/g)) {
            toolUse(s, tasks, { type: 'tool_use', name: m[1], input: { file_path: unesc(m[2]) } }, cwd);
        }
    }
    let t;
    const mt = tail.lastIndexOf('"type":"text"');
    if (mt >= 0) t = /^"type":"text","text":"((?:[^"\\]|\\.)*)/.exec(tail.slice(mt))?.[1];
    else if (head.lastIndexOf('"type":"text"') > head.lastIndexOf('"type":"tool_use"')) { // the text block runs into the tail
        const q = /^(?:[^"\\]|\\.)*/.exec(tail)[0], tu = tail.indexOf('"type":"tool_use"');
        if (tu < 0 || q.length < tu) t = q;
    }
    if (t && t.trim()) s.lastText = unesc(t);
}

function toolUse(s, tasks, b, cwd) {
    const i = b.input ?? {};
    if (EDIT_TOOLS.has(b.name)) { const p = i.file_path ?? i.notebook_path; if (p) { s.edited.add(p); if (/[\\/]handoff[\\/]/.test(p)) s.handoff = true; } }
    else if (b.name === 'Bash' || b.name === 'PowerShell') {
        const c = String(i.command ?? '');
        if (/\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(c)) s.commits++;
        if (/\bgit\s+(?:-C\s+\S+\s+)?push\b/.test(c)) s.pushes++;
    } else if (b.name === 'TodoWrite' && Array.isArray(i.todos)) s.todos = i.todos;
    else if (b.name === 'TaskCreate') tasks.set(String(tasks.size + 1), { content: i.subject ?? i.title ?? '', status: 'pending' });
    else if (b.name === 'TaskUpdate' && tasks.has(String(i.taskId)) && i.status) tasks.get(String(i.taskId)).status = i.status;
    else if (b.name === 'Skill' && /handoff/.test(String(i.skill ?? ''))) s.handoff = true;
}

// Desktop session titles: cliSessionId -> {title, account, archived}. Reads only the head of each file.
function desktopTitles(sinceMs) {
    const map = new Map();
    const roots = [];
    const lad = process.env.LOCALAPPDATA, apd = process.env.APPDATA;
    if (lad) { try { for (const a of readdirSync(join(lad, 'Claude-Profiles'))) roots.push([a, join(lad, 'Claude-Profiles', a, 'claude-code-sessions')]); } catch {} }
    for (const r of [apd && join(apd, 'Claude'), join(homedir(), 'Library', 'Application Support', 'Claude'), join(homedir(), '.config', 'Claude')]) if (r) roots.push(['default', join(r, 'claude-code-sessions')]);
    const buf = Buffer.alloc(2048);
    const walk = (dir, account, depth) => {
        let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
            const p = join(dir, e.name);
            if (e.isDirectory()) { if (depth < 4) walk(p, account, depth + 1); continue; }
            if (!/^local_.*\.json$/.test(e.name)) continue;
            try {
                if (statSync(p).mtimeMs < sinceMs) continue;
                const fd = openSync(p, 'r'); const n = readSync(fd, buf, 0, 2048, 0); closeSync(fd);
                const h = buf.toString('utf8', 0, n);
                const id = /"cliSessionId":"([^"]+)"/.exec(h)?.[1]; if (!id) continue;
                const t = /"title":"((?:[^"\\]|\\.)*)"/.exec(h)?.[1];
                map.set(id, { title: t ? JSON.parse(`"${t}"`) : null, account, archived: /"isArchived":true/.test(h) });
            } catch {}
        }
    };
    for (const [a, r] of roots) walk(r, a, 0);
    return map;
}

function projectFiles(cfg, cwd, sinceMs) {
    const root = join(cfg, 'projects'), slug = slugOf(cwd), out = [];
    let dirs = []; try { dirs = readdirSync(root); } catch {}
    for (const d of dirs) {
        const dd = WIN ? d.toLowerCase() : d, ss = WIN ? slug.toLowerCase() : slug; // Windows paths ignore case
        if (dd !== ss && !dd.startsWith(ss + '--claude-worktrees-')) continue;
        let ents; try { ents = readdirSync(join(root, d), { withFileTypes: true }); } catch { continue; }
        for (const e of ents) {
            if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
            const p = join(root, d, e.name);
            try { const st = statSync(p); if (st.mtimeMs >= sinceMs) out.push({ p, mtime: st.mtimeMs }); } catch {}
        }
    }
    return out;
}

const git = (dir, a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// Uncommitted paths of one toplevel as a list of {p, dir}, or null when status fails.
function statusItems(top) {
    const st = git(top, ['status', '--porcelain=v1', '-z']);
    if (st.status !== 0) return null;
    const parts = st.stdout.split('\0'), items = [];
    for (let k = 0; k < parts.length; k++) {
        const e = parts[k]; if (e.length < 4) continue;
        if (/[RC]/.test(e.slice(0, 2))) k++; // rename/copy: next field is the old path
        const rel = e.slice(3);
        items.push({ p: key(join(top, rel)), dir: rel.endsWith('/') });
    }
    return items;
}

// A file belongs to the repo that owns its directory, not to cwd: a worktree under .claude/worktrees is gitignored
// in the main checkout. Returns 'dirty', 'clean' or 'unchecked' (directory gone, not a repo, status failed).
function repoCheck() {
    const tops = new Map(), status = new Map();
    return f => {
        const dir = dirname(f);
        if (!tops.has(dir)) {
            const r = existsSync(dir) ? git(dir, ['rev-parse', '--show-toplevel']) : null;
            tops.set(dir, r && r.status === 0 ? r.stdout.trim() : null);
        }
        const top = tops.get(dir);
        if (!top) return 'unchecked';
        if (!status.has(top)) status.set(top, statusItems(top));
        const items = status.get(top);
        return !items ? 'unchecked' : uncommitted([f], items).length ? 'dirty' : 'clean';
    };
}

export function uncommitted(edited, dirty) {
    if (!dirty) return [];
    return edited.filter(f => { const k = key(f); return dirty.some(d => d.dir ? k.startsWith(d.p + '/') || k === d.p : k === d.p); });
}

export async function collect({ cwd, days = 7, limit = 40, self = null, cfg }) {
    const since = Date.now() - days * 864e5;
    const files = projectFiles(cfg, cwd, since);
    const titles = desktopTitles(since);
    const sessions = [];
    let skipped = 0, next = 0;
    const worker = async () => {
        while (next < files.length) {
            const f = files[next++];
            const id = f.p.replace(/^.*[\\/]/, '').replace(/\.jsonl$/, '');
            if (self && id === self) continue;
            let s; try { s = await scanFile(f.p, cwd); } catch { s = null; }
            if (!s) { skipped++; continue; }
            // mtime is also bumped by a title write or a resume, so the last message decides the age
            s.act = s.last ? Date.parse(s.last) : f.mtime;
            s.mtime = f.mtime;
            if (s.act < since) continue;
            sessions.push(s);
        }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    // clones: the same first prompt and one chat's prompts a prefix of the other's are one chat; the latest activity stays.
    // The same start with diverging prompts is a fork: both stay.
    const related = (a, b) => { const n = Math.min(a.length, b.length); return a.slice(0, n).every((x, i) => x === b[i]); };
    const groups = new Map(), all = [];
    for (const s of sessions.sort((a, b) => b.act - a.act || b.mtime - a.mtime)) {
        const k = s.firstTs + '\0' + s.first, g = groups.get(k) ?? [];
        groups.set(k, g);
        const m = g.find(x => related(s.sig, x.sig));
        if (m) {
            m.clones.push(s.id);
            for (const f of s.edited) if (!m.edited.includes(f)) m.edited.push(f);
            m.commits = Math.max(m.commits, s.commits); m.pushes = Math.max(m.pushes, s.pushes);
            m.handoff ||= s.handoff; m.partial = Math.max(m.partial, s.partial);
        } else { Object.assign(s, { clones: [], forkOf: g[0]?.id ?? null }); g.push(s); all.push(s); }
    }
    const check = repoCheck();
    const gitRepo = git(cwd, ['rev-parse', '--show-toplevel']).status === 0;
    const rel = f => { const r = relative(cwd, f); return r && !r.startsWith('..') && !isAbsolute(r) ? r.split(sep).join('/') : null; };
    const chats = all.sort((a, b) => b.act - a.act || b.mtime - a.mtime).slice(0, limit).map(s => {
        const d = titles.get(s.id);
        const open = (s.todos ?? []).filter(t => t.status !== 'completed').map(t => clip(mask(t.content ?? t.subject ?? t.activeForm), 120));
        const mine = s.edited.filter(rel); // files outside the project (scratchpads, temp) are not its open work
        const state = new Map(mine.map(f => [f, check(f)]));
        const pick = v => mine.filter(f => state.get(f) === v).map(rel);
        return {
            id: s.id, title: mask(s.title ?? d?.title ?? '') || null, account: d?.account ?? null, archived: !!d?.archived,
            start: s.start, last: s.last, live: Date.now() - s.mtime < LIVE_MS && Date.now() - s.act < 6 * LIVE_MS,
            first: clip(s.first, 300), prompts: s.prompts, lastText: cut(s.lastText), asks: endsWithQuestion(s.lastText),
            edited: mine.map(rel), editedOutside: s.edited.length - mine.length, uncommitted: pick('dirty'), unchecked: pick('unchecked'),
            partial: s.partial, openTodos: open, commits: s.commits, pushes: s.pushes, handoff: s.handoff, clones: s.clones, forkOf: s.forkOf,
        };
    });
    return { cwd, days, skipped, gitRepo, total: all.length, chats };
}

const ago = ms => { const m = Math.round(ms / 60000); return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

export function render(r) {
    const bigs = r.chats.reduce((n, c) => n + c.partial, 0);
    const L = [`# ${r.total > r.chats.length ? `showing ${r.chats.length} of ${r.total}` : r.chats.length} chats in ${r.cwd} (last ${r.days}d)${bigs ? `, ${bigs} line(s) over 2 MB read only partly` : ''}${r.skipped ? `, ${r.skipped} without a human prompt skipped` : ''}${r.gitRepo ? '' : ', not a git repo'}`];
    r.chats.forEach((c, i) => {
        const age = c.last ? ago(Date.now() - Date.parse(c.last)) + ' ago' : '?';
        const head = c.title ?? clip(c.first, 60);
        L.push('', `## ${i + 1}. ${head} (${c.id.slice(0, 8)}, ${c.live ? 'LIVE, ' : ''}last msg ${age}${c.account ? ', ' + c.account : ''}${c.archived ? ', archived' : ''}${c.forkOf ? ', fork of ' + c.forkOf.slice(0, 8) : ''})`);
        if (!c.prompts.includes(c.first)) L.push(`- first: ${c.first}`);
        c.prompts.forEach((p, k) => L.push(`- ${k === c.prompts.length - 1 ? 'last' : 'prev'} ask: ${p}`));
        L.push(`- reply${c.asks ? ' (ends with a question)' : ''}: ${c.lastText || '-'}`);
        if (c.edited.length) L.push(`- edited ${c.edited.length}: ${c.edited.slice(0, 6).join(', ')}${c.edited.length > 6 ? ', …' : ''}${c.editedOutside ? ` (+${c.editedOutside} outside the project)` : ''}${c.uncommitted.length ? `; uncommitted ${c.uncommitted.length}: ${c.uncommitted.slice(0, 6).join(', ')}${c.uncommitted.length > 6 ? ', …' : ''}` : c.unchecked.length ? '' : '; none uncommitted'}${c.unchecked.length ? `; NOT CHECKED ${c.unchecked.length} (worktree gone or not a repo): ${c.unchecked.slice(0, 4).join(', ')}${c.unchecked.length > 4 ? ', …' : ''}` : ''}`);
        if (c.partial) L.push(`- partly read: ${c.partial} assistant line(s) over 2 MB, edits and todos in them can be missing`);
        if (c.openTodos.length) L.push(`- open todos: ${c.openTodos.slice(0, 5).join(' | ')}${c.openTodos.length > 5 ? ' | …' : ''}`);
        L.push(`- git: ${c.commits} commit, ${c.pushes} push; handoff ${c.handoff ? 'yes' : 'no'}${c.clones.length ? `; clones: ${c.clones.map(x => x.slice(0, 8)).join(', ')}` : ''}`);
    });
    return L.join('\n');
}

async function selftest() {
    const root = mkdtempSync(join(tmpdir(), 'chats-st-'));
    try {
        const cwd = join(root, 'proj'); mkdirSync(cwd);
        const cfg = join(root, 'cfg'), dir = join(cfg, 'projects', slugOf(cwd));
        mkdirSync(dir, { recursive: true });
        spawnSync('git', ['-C', cwd, 'init', '-q']);
        writeFileSync(join(cwd, 'a.txt'), 'x');
        const U = (text, ts, extra = {}) => JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text }, ...extra });
        const A = (content, ts, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content }, ...extra });
        const T = (n, i) => ({ type: 'tool_use', name: n, input: i });
        const clone = [U('fix the thing', '2026-01-01T10:00:00Z'), A([{ type: 'text', text: 'done' }], '2026-01-01T10:01:00Z')].join('\n');
        writeFileSync(join(dir, 'clone1.jsonl'), clone);
        writeFileSync(join(dir, 'clone2.jsonl'), clone + '\n' + U('and more', '2026-01-01T10:02:00Z'));
        writeFileSync(join(dir, 'work.jsonl'), [
            U('<system-reminder>noise</system-reminder>build X', '2026-01-02T10:00:00Z'),
            JSON.stringify({ type: 'custom-title', customTitle: 'Build X' }),
            A([T('Write', { file_path: join(cwd, 'a.txt') }), T('Bash', { command: 'git commit -m x' }),
                T('TodoWrite', { todos: [{ content: 'step one', status: 'completed' }, { content: 'step two', status: 'pending' }] })], '2026-01-02T10:01:00Z'),
            U('', '2026-01-02T10:01:30Z', { message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
            A([{ type: 'text', text: 'Shall I go on?' }], '2026-01-02T10:02:00Z'),
        ].join('\n'));
        writeFileSync(join(dir, 'side.jsonl'), U('sub task', '2026-01-03T10:00:00Z', { isSidechain: true }));
        writeFileSync(join(dir, 'me.jsonl'), U('this chat', '2026-01-04T10:00:00Z'));
        const r = await collect({ cwd, days: 1e5, cfg, self: 'me' });
        assert.equal(r.chats.length, 2, 'clone pair is one, sidechain-only and self are gone');
        assert.equal(r.skipped, 1, 'sidechain-only counted as skipped');
        const c = r.chats.find(x => x.id === 'work'), k = r.chats.find(x => x.id !== 'work');
        assert.equal(c.title, 'Build X'); assert.equal(c.first, 'build X', 'noise stripped');
        assert.equal(c.asks, true); assert.equal(c.commits, 1);
        assert.deepEqual(c.openTodos, ['step two']);
        assert.deepEqual(c.edited, ['a.txt']); assert.deepEqual(c.uncommitted, ['a.txt'], 'untracked file is uncommitted');
        assert.equal(k.id, 'clone2', 'clone with the later activity is kept'); assert.deepEqual(k.clones, ['clone1']);
        assert.equal(k.prompts.length, 2);
        assert.ok(render(r).includes('## ') && render(r).includes('Build X'), 'markdown renders');
        assert.equal(slugOf('C:\\Users\\mky\\Desktop\\x-y'), resolve('C:\\Users\\mky\\Desktop\\x-y').replace(/[^A-Za-z0-9]/g, '-'));
        // second project: a worktree under .claude/worktrees, secrets, forks, huge assistant lines
        const cwd2 = join(root, 'proj2'); mkdirSync(cwd2);
        const dir2 = join(cfg, 'projects', slugOf(cwd2)); mkdirSync(dir2, { recursive: true });
        const g2 = (...a) => spawnSync('git', ['-C', cwd2, '-c', 'user.email=a@b', '-c', 'user.name=a', ...a], { encoding: 'utf8' });
        g2('init', '-q'); writeFileSync(join(cwd2, 'a.txt'), '1'); writeFileSync(join(cwd2, '.gitignore'), '.claude/worktrees/\n');
        g2('add', '.'); g2('commit', '-qm', 'i');
        const wt = join(cwd2, '.claude', 'worktrees', 'wt1');
        g2('worktree', 'add', '-q', wt, '-b', 'wt1'); writeFileSync(join(wt, 'new.txt'), 'work');
        const w2 = (n, lines) => writeFileSync(join(dir2, n + '.jsonl'), lines.join('\n'));
        const X = 'X'.repeat((2.2 * 1024 * 1024) | 0);
        w2('wtchat', [U('in worktree', '2026-10-25T10:00:00Z'), A([T('Write', { file_path: join(wt, 'new.txt') }), T('Write', { file_path: join(cwd2, '.claude', 'worktrees', 'gone1', 'x.txt') })], '2026-10-25T10:01:00Z')]);
        w2('sec', [U('use password: Hunter2Secret! and key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV and postgres://admin:p4ss@db.prod:5432/x', '2026-10-25T11:00:00Z'),
            JSON.stringify({ type: 'custom-title', customTitle: 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2' }),
            A([{ type: 'text', text: 'lorem ipsum '.repeat(75) + ' Shall I drop the production table users? ' }], '2026-10-25T11:01:00Z')]);
        const fork = ['refactor X', '2026-10-24T10:00:00Z'];
        w2('f1', [U(...fork), U('go left', '2026-10-24T10:01:00Z'), A([T('Write', { file_path: join(cwd2, 'f1.txt') })], '2026-10-24T10:05:00Z')]);
        w2('f2', [U(...fork), U('go right', '2026-10-24T10:02:00Z'), A([T('Write', { file_path: join(cwd2, 'f2.txt') })], '2026-10-24T10:06:00Z')]);
        w2('c1', [U('same chat', '2026-10-23T10:00:00Z'), A([T('Write', { file_path: join(cwd2, 'c1.txt') })], '2026-10-23T10:01:00Z')]);
        w2('c2', [U('same chat', '2026-10-23T10:00:00Z'), U('more', '2026-10-23T10:02:00Z'), A([T('Write', { file_path: join(cwd2, 'c2.txt') })], '2026-10-23T10:03:00Z')]);
        w2('big1', [U('big one', '2026-10-22T10:00:00Z'), A([T('Write', { file_path: join(cwd2, 'b1.txt') }), { type: 'text', text: X + ' Shall I drop users?' }], '2026-10-22T10:01:00Z')]);
        w2('big2', [U('big two', '2026-10-21T10:00:00Z'), A([{ type: 'text', text: X }, T('Write', { file_path: join(cwd2, 'b2.txt') })], '2026-10-21T10:01:00Z')]);
        const r2 = await collect({ cwd: cwd2, days: 1e5, cfg });
        const by = id => r2.chats.find(x => x.id === id);
        assert.deepEqual(by('wtchat').uncommitted, ['.claude/worktrees/wt1/new.txt'], 'worktree edit is uncommitted although the main checkout ignores it');
        assert.deepEqual(by('wtchat').unchecked, ['.claude/worktrees/gone1/x.txt'], 'gone worktree is unchecked, not clean');
        assert.match(render(r2), /NOT CHECKED 1 \(worktree gone/);
        const out = JSON.stringify(r2) + render(r2);
        for (const leak of ['Hunter2Secret', 'sk-ant-api03', 'p4ss', 'ghp_a1B2']) assert.ok(!out.includes(leak), 'leaked ' + leak);
        assert.ok(out.includes('postgres://‹masked›@db.prod'), 'scheme and host kept');
        assert.ok(by('sec').asks && by('sec').lastText.includes('drop the production table users?'), 'trailing question survives the cut');
        assert.ok(by('sec').lastText.length < 620 && by('sec').lastText.startsWith('lorem'), 'head and tail kept');
        assert.ok(by('f1') && by('f2') && (by('f1').forkOf === 'f2' || by('f2').forkOf === 'f1'), 'diverging prompts are a fork, both stay');
        assert.match(render(r2), /fork of f[12]/);
        assert.ok(!by('c1') && by('c2').clones.includes('c1'), 'prefix clone merges');
        assert.deepEqual(by('c2').edited.sort(), ['c1.txt', 'c2.txt'], 'merge unions edited files');
        assert.deepEqual(by('big1').edited, ['b1.txt'], 'edit in a 2 MB assistant line');
        assert.equal(by('big1').last, '2026-10-22T10:01:00Z'); assert.equal(by('big1').partial, 1);
        assert.ok(by('big1').asks && by('big1').lastText.endsWith('Shall I drop users?'), 'question at the end of a huge text');
        assert.deepEqual(by('big2').edited, ['b2.txt'], 'edit in the tail of a 2 MB line'); assert.equal(by('big2').last, '2026-10-21T10:01:00Z');
        assert.match(render(r2), /2 line\(s\) over 2 MB read only partly/);
        const r3 = await collect({ cwd: cwd2, days: 1e5, cfg, limit: 2 });
        assert.equal(r3.chats.length, 2); assert.match(render(r3), /^# showing 2 of \d+ chats/);
        if (WIN) assert.equal((await collect({ cwd: cwd2.replace(/^./, c => c.toLowerCase()), days: 1e5, cfg })).chats.length, r2.chats.length, 'lowercase drive');
        for (const bad of ['0', '-3', 'abc', '']) assert.equal(spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--cwd', cwd2, '--days', bad]).status, 2, '--days ' + bad);
        // every kind of secret, and plain text left alone
        for (const s of ['sk-abcdefghijklmnopqrstuv', 'ghp_' + 'a'.repeat(24), 'github_pat_' + 'a'.repeat(24), 'xoxb-1234567890-abc', 'AKIAABCDEFGHIJKLMNOP', 'eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4', 'Bearer abc.def',
            'api_key=zzz', 'x-api-key: zzz', 'token: zzz', 'пароль: zzz', 'secret=zzz', 'passwd: zzz', 'a'.repeat(32), 'aB3'.repeat(12)]) assert.ok(mask(`x ${s} y`).includes('‹masked›') && !/zzz/.test(mask(s)), 'not masked: ' + s);
        assert.equal(mask('risk-assessment-framework src/components/features/authentication/x.ts'), 'risk-assessment-framework src/components/features/authentication/x.ts');
        console.log('chats.mjs selftest done');
    } finally { rmSync(root, { recursive: true, force: true }); }
}

async function main(argv) {
    if (argv[0] === '--selftest') return selftest();
    const flag = (n, d) => { const i = argv.indexOf(n); return i < 0 ? d : argv[i + 1]; };
    const cwd = resolve(flag('--cwd', process.cwd()));
    const cfg = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const num = (n, d) => {
        const i = argv.indexOf(n); if (i < 0) return d;
        const x = Number(argv[i + 1]);
        if (!(x > 0) || !Number.isFinite(x)) { console.error(`${n} needs a positive number, got "${argv[i + 1] ?? ''}"`); process.exit(2); }
        return x;
    };
    const r = await collect({ cwd, cfg, days: num('--days', 7), limit: num('--limit', 40), self: flag('--self', null) });
    console.log(argv.includes('--json') ? JSON.stringify(r, null, 1) : render(r));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).catch(e => { console.error(e.stack || e); process.exit(1); });
}
