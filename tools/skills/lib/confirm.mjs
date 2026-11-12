#!/usr/bin/env node
// confirm.mjs - consent for deletes: the script reads what the person answered, the model only relays it.
//
//   node confirm.mjs plan <tool> <items.json | ->   write the plan, print the numbered list
//        items: [{id, what, bytes (number|null), how: 'undo'|'forever', note?, held?}]; held = why it cannot be chosen
//   node confirm.mjs select <tool>                  read the person's latest answer after the list; print the restated block and ASK: lines
//   node confirm.mjs grant <tool>                   read the person's latest answer after select; print GRANTED: <ids>
//   node confirm.mjs --selftest
// A plan carries a scope (prune: its repo's git dir, or 'all'; cleanup: 'machine'); check refuses a grant made under another one.
// Exit 2 with a one-line reason when there is no answer, the answer is not a valid selection, or nothing was confirmed.
// tool: cleanup | prune-trash | prune-empty (any [\w-]+ name works).
//
// The person's answer is read from this chat's transcript (<config>/projects/*/<session id>.jsonl): an AskUserQuestion answer
// (toolUseResult.answers) or a typed message (not a compact summary, meta record or tool result), main thread only, recorded after the step
// before it. A bare "да" is never a selection. The grant needs one answer line equal to the ASK label.
// The calling script (machine.mjs, prune.mjs) runs check(tool, ids, {scope}) before it deletes: only ids granted in the last 30 minutes
// pass, once each. Without CLAUDE_CODE_SESSION_ID (a person at their own terminal) check passes: that person is the consent.
// State: ${CLAUDE_CONFIG_DIR || ~/.claude}/makarasty/confirm/<session id>.<tool>.json
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const MIN = 60e3, TTL = 30 * MIN;
const config = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const sidOf = o => String(o.sid ?? process.env.CLAUDE_CODE_SESSION_ID ?? '').replace(/[^\w.-]/g, '_') || 'nosid';
const dirOf = o => o.dir ?? join(config(), 'makarasty', 'confirm');
const fileOf = (tool, o) => join(dirOf(o), `${sidOf(o)}.${String(tool).replace(/[^\w-]/g, '_')}.json`);
const nowOf = o => o.now ?? Date.now();
const load = (tool, o) => { try { return JSON.parse(readFileSync(fileOf(tool, o), 'utf8')); } catch { return null; } };
function save(tool, o, p) {
    mkdirSync(dirOf(o), { recursive: true });
    const f = fileOf(tool, o), t = `${f}.${process.pid}.tmp`;
    writeFileSync(t, JSON.stringify(p, null, 1));
    renameSync(t, f);
}
const fail = msg => ({ code: 2, out: msg });
const norm = s => String(s).toLowerCase().replace(/ё/g, 'е').replace(/\(recommended\)/g, ' ').replace(/\s+/g, ' ').trim();

function size(b, ru) {
    if (b == null) return ru ? 'размер неизвестен' : 'size unknown';
    const u = [['GB', 2 ** 30], ['MB', 2 ** 20], ['KB', 2 ** 10]].find(([, v]) => b >= v);
    return u ? `${(b / u[1]).toFixed(1)} ${u[0]}` : `${b} B`;
}

// ---- plan -----------------------------------------------------------------------------------------------------

export function makePlan(tool, items, o = {}) {
    // A repeated id is listed held (every copy): a grant is by id, so it could not tell the copies apart.
    const count = new Map();
    for (const x of items) count.set(x?.id, (count.get(x?.id) ?? 0) + 1);
    let n = 0;
    const list = items.map(x => {
        if (typeof x?.id !== 'string' || !x.id) throw new Error(`plan: bad id ${JSON.stringify(x?.id)}`);
        if (!['undo', 'forever'].includes(x.how)) throw new Error(`plan: ${x.id} needs how: 'undo' or 'forever'`);
        if (count.get(x.id) > 1) x = { ...x, held: o.dup ?? 'the same id is listed twice' };
        const it = { id: x.id, what: String(x.what ?? x.id), bytes: typeof x.bytes === 'number' ? x.bytes : null, how: x.how };
        if (x.note) it.note = String(x.note);
        if (x.held) it.held = String(x.held); else it.n = ++n;
        return it;
    });
    const plan = { tool, scope: o.scope ?? '', at: nowOf(o), items: list, sel: null, selAt: null, granted: [], grantedAt: null };
    save(tool, o, plan);
    const lines = [
        ...list.filter(i => !i.held).map(i => `${i.n}. ${i.what} - ${size(i.bytes)} - ${i.how === 'forever' ? 'FOREVER/НАВСЕГДА' + (i.note ? ` (${i.note})` : '') : i.note || 'можно вернуть/can be restored'} [${i.id}]`),
        ...list.filter(i => i.held).map(i => `- ${i.what} - held: ${i.held}`)];
    return { ...plan, lines };
}

// ---- the person's answer --------------------------------------------------------------------------------------

function transcriptOf(o) {
    if (o.transcript) return existsSync(o.transcript) ? o.transcript : null;
    const sid = sidOf(o), root = join(config(), 'projects');
    try { for (const d of readdirSync(root)) { const p = join(root, d, sid + '.jsonl'); if (existsSync(p)) return p; } } catch { /* no projects folder */ }
    return null;
}

// The last TAIL bytes of the transcript, from the first whole line: the answer asked for a moment ago is at the end, and a
// whole-file read fails past 512 MB ("Cannot create a string longer than 0x1fffffe8 characters").
// shortcut: an answer more than TAIL bytes from the end is not seen (a grant is 30 minutes old at most); raise TAIL if chats write that much in that time.
const TAIL = 16 << 20;
function tailOf(f, tail = TAIL) {
    const size = statSync(f).size;
    if (size <= tail) return readFileSync(f, 'utf8');
    const fd = openSync(f, 'r'), b = Buffer.alloc(tail);
    try { readSync(fd, b, 0, tail, size - tail); } finally { closeSync(fd); }
    return b.subarray(b.indexOf(10) + 1).toString('utf8'); // the cut first line goes
}

// The last answer the person gave after time T (ms): an AskUserQuestion answer or a typed message. Null when none.
function answerAfter(T, o) {
    const f = transcriptOf(o);
    if (!f) return null;
    let last = null;
    for (const line of tailOf(f, o.tail).split('\n')) {
        if (!line.trim()) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        if (!r || r.isSidechain === true || r.type !== 'user' || !(Date.parse(r.timestamp) > T)) continue;
        const a = r.toolUseResult?.answers;
        if (a && typeof a === 'object' && !Array.isArray(a)) last = Object.values(a).join('\n');
        else { const m = typed(r); if (m !== null) last = m; }
    }
    return last;
}

// A message the person typed: not a compact summary, a meta or visible-only record, a tag, or a tool result.
function typed(r) {
    if (r.isMeta === true || r.isCompactSummary === true || r.isVisibleInTranscriptOnly === true) return null;
    const c = r.message?.content;
    if (typeof c === 'string') return c.trimStart().startsWith('<') ? null : c;
    if (!Array.isArray(c) || c.some(x => x?.type === 'tool_result')) return null;
    const t = c.filter(x => x?.type === 'text' && typeof x.text === 'string' && !x.text.trimStart().startsWith('<')).map(x => x.text).join('\n');
    return t.trim() ? t : null;
}

// ---- select ---------------------------------------------------------------------------------------------------

const YES = new Set(['да', 'yes', 'ок', 'ok', 'давай', 'угу', 'ага', 'конечно', 'sure', 'го', 'yep']);
const NONE = new Set(['ничего', 'nothing', 'none', 'нет', 'no', 'отмена', 'cancel']);
const ALL = new Set(['все', 'all', 'everything']);
const EXC = new Set(['кроме', 'except']);
const FILL = new Set(['удали', 'удалить', 'delete', 'remove', 'номера', 'numbers', 'пункты', 'items', 'только', 'only', 'и', 'and']);
const HOWTO = 'answer with numbers: 1,3 or 1-4, все, все кроме 5, ничего';

// -> { none } | { nums } | { err }. n = how many numbered items.
function parse(answer, n) {
    // Text in parentheses ("(2 GB)", "(Recommended)") is a note, not an answer; every other word must be in the grammar.
    const s = norm(String(answer).replace(/\([^)]*\)/g, ' ')), bad = { err: HOWTO };
    const out = x => `${x} is not on the list (numbers 1..${n}; held items have no number)`;
    let nums = [], all = false, except = false, none = false, yes = false;
    for (const w of s.replace(/[–—]/g, '-').replace(/[,;.!?:]+/g, ' ').split(' ').filter(Boolean)) {
        const r = /^(\d+)-(\d+)$/.exec(w);
        if (r) {
            if (+r[1] < 1 || +r[1] > +r[2] || +r[2] > n) return { err: +r[1] > +r[2] ? bad.err : out(w) };
            for (let i = +r[1]; i <= +r[2]; i++) nums.push(i);
        } else if (/^\d+$/.test(w)) nums.push(+w);
        else if (ALL.has(w)) all = true;
        else if (EXC.has(w)) except = true;
        else if (NONE.has(w)) none = true;
        else if (YES.has(w)) yes = true;
        else if (!FILL.has(w)) return bad;
    }
    const picked = nums.length > 0;
    if (none) return picked || all || except ? bad : { none: true };
    if (all && !except && picked || except && !picked) return bad;
    if (!picked && !all) return yes ? { err: "a bare 'да' is not a selection: ask which numbers" } : bad;
    const off = nums.find(x => x < 1 || x > n);
    if (off !== undefined) return { err: out(off) };
    if (all || except) nums = Array.from({ length: n }, (_, i) => i + 1).filter(i => !nums.includes(i));
    return { nums: [...new Set(nums)].sort((a, b) => a - b) };
}

const label = (ru, how, nums) => `${how === 'undo' ? (ru ? 'Удалить с возвратом' : 'Remove, undoable') : (ru ? 'Удалить навсегда' : 'Delete forever')}: ${nums.join(', ')}`;

function restate(p, chosen, ru) {
    const live = p.items.filter(i => !i.held), held = p.items.filter(i => i.held);
    const word = i => `${i.n}. ${i.what} - ${size(i.bytes, ru)}${i.how === 'undo' && i.note ? ` (${i.note})` : ''}`;
    const by = how => chosen.filter(i => i.how === how);
    const L = [`${ru ? 'Выбрано' : 'Chosen'} ${chosen.length} ${ru ? 'из' : 'of'} ${live.length}:`];
    if (by('undo').length) L.push(`  ${ru ? 'удалю с возвратом' : 'remove, undoable'}: ${by('undo').map(word).join('; ')}`);
    if (by('forever').length) L.push(`  ${ru ? 'удалю НАВСЕГДА (не вернуть)' : 'delete FOREVER (cannot be restored)'}: ${by('forever').map(word).join('; ')}`);
    const rest = live.filter(i => !chosen.includes(i));
    const keep = [...(rest.length ? [rest.map(i => `${i.n}. ${i.what}`).join(', ')] : []), ...(held.length ? [`${ru ? 'занято' : 'held'}: ${held.map(i => `${i.what} (${i.held})`).join(', ')}`] : [])];
    if (keep.length) L.push(`${ru ? 'Не трогаю' : 'Not touched'}: ${keep.join('; ')}`);
    for (const how of ['undo', 'forever']) if (by(how).length) L.push(`ASK: ${label(ru, how, by(how).map(i => i.n))}`);
    return L.join('\n');
}

export function select(tool, o = {}) {
    const p = load(tool, o);
    if (!p) return fail(`no plan for ${tool}: run plan first`);
    const a = answerAfter(p.at, o);
    if (a === null) return fail('no answer from the person after the list: ask them');
    const ru = /[а-яё]/i.test(a), live = p.items.filter(i => !i.held), r = parse(a, live.length);
    if (r.err) return fail(r.err);
    const chosen = r.none ? [] : r.nums.map(x => live[x - 1]);
    Object.assign(p, { sel: chosen.map(i => i.id), selAt: nowOf(o), lang: ru ? 'ru' : 'en', granted: [], grantedAt: null });
    save(tool, o, p);
    if (!chosen.length) return { code: 0, out: ru ? 'ничего не выбрано, ничего не будет удалено' : 'nothing chosen, nothing will be deleted' };
    return { code: 0, out: restate(p, chosen, ru) };
}

// ---- grant ----------------------------------------------------------------------------------------------------

export function grant(tool, o = {}) {
    const p = load(tool, o);
    if (!p?.sel?.length) return fail('nothing selected: run select first');
    const a = answerAfter(p.selAt, o);
    if (a === null) return fail('no answer from the person after the ASK lines: ask them');
    // One answer line must EQUAL the label: "Remove, undoable: 1, 3 - нет, отмена" or "... : 1, 3, 4" is not the label for 1, 3.
    const line = x => norm(x).replace(/[\s.,;:!]+$/, '');
    const lines = new Set(a.split('\n').map(line));
    const has = l => lines.has(line(l));
    const chosen = p.sel.map(id => p.items.find(i => i.id === id)), granted = [];
    for (const how of ['undo', 'forever']) {
        const part = chosen.filter(i => i.how === how), nums = part.map(i => i.n);
        if (part.length && (has(label(true, how, nums)) || has(label(false, how, nums)))) granted.push(...part.map(i => i.id));
    }
    if (!granted.length) return fail('not confirmed: nothing granted');
    const no = p.sel.filter(id => !granted.includes(id));
    Object.assign(p, { granted, grantedAt: nowOf(o), sel: [] });
    save(tool, o, p);
    return { code: 0, out: [`GRANTED: ${granted.join(' ')}`, ...(no.length ? [`NOT GRANTED: ${no.join(' ')}`] : [])].join('\n') };
}

// ---- check ----------------------------------------------------------------------------------------------------

// Called by the script that deletes, with the ids it is about to act on. Throws unless the person granted every one.
export function check(tool, ids, o = {}) { // o.scope: the scope this run acts under, a string or a list of them
    // Unset outside Claude: a person at their own terminal. Set but empty, or unset inside a Claude shell (CLAUDECODE / CLAUDE_CODE_ENTRYPOINT
    // are set there), is what a model does to skip the check: refused.
    const inClaude = !!(process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT);
    if (!o.sid && (process.env.CLAUDE_CODE_SESSION_ID === '' || (inClaude && !process.env.CLAUDE_CODE_SESSION_ID))) throw new Error('not confirmed by the person: CLAUDE_CODE_SESSION_ID is missing or empty inside a Claude session. Do not act. Ask the person to run this from their own terminal, or with ! in the prompt');
    if (!o.sid && !process.env.CLAUDE_CODE_SESSION_ID) return;
    if (!ids.length) return;
    const p = load(tool, o), want = [].concat(o.scope ?? ''), fresh = p && nowOf(o) - p.grantedAt <= TTL, ok = new Set(fresh ? p.granted : []);
    if (fresh && !want.includes(p.scope ?? '')) throw new Error(`not confirmed by the person: that list was made for scope "${p.scope ?? ''}", this run is "${want.join('" or "')}". Do not act: show the list again from here`);
    const no = ids.filter(i => !ok.has(i));
    if (no.length) throw new Error(`not confirmed by the person: ${no.join(' ')}. Do not act on them: show the list from scan, ask which numbers, run confirm.mjs select, ask the ASK lines, run confirm.mjs grant`);
    p.granted = p.granted.filter(i => !ids.includes(i));
    save(tool, o, p);
}

// ---- selftest -------------------------------------------------------------------------------------------------

function selftest() {
    const tmp = mkdtempSync(join(tmpdir(), 'confirm-selftest-')), saved = { ...process.env };
    try {
        delete process.env.CLAUDE_CODE_SESSION_ID; delete process.env.CLAUDECODE; delete process.env.CLAUDE_CODE_ENTRYPOINT; // outside Claude, unless a line sets them
        process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude');
        const tr = join(tmp, 't.jsonl'), B = Date.parse('2026-11-09T10:00:00Z'), GB = 2 ** 30;
        let t = B;
        const o = () => ({ sid: 'S1', dir: join(tmp, 'c'), transcript: tr, now: t });
        const say = (text, at, extra = {}) => writeFileSync(tr, JSON.stringify({ type: 'user', isSidechain: false, timestamp: new Date(at).toISOString(), message: { role: 'user', content: text }, ...extra }) + '\n', { flag: 'a' });
        const ask = (text, at, extra = {}) => say([{ type: 'tool_result' }], at, { toolUseResult: { answers: { 'Что?': text } }, ...extra });
        const items = [{ id: 'a', what: 'A', bytes: 1.2 * GB, how: 'undo', note: 'to the bin' }, { id: 'b', what: 'B', bytes: 3 * GB, how: 'forever' },
            { id: 'c', what: 'C', bytes: 0.4 * GB, how: 'undo' }, { id: 'd', what: 'D', bytes: null, how: 'forever' }, { id: 'e', what: 'E', bytes: 5, how: 'undo' },
            { id: 'h', what: 'H', bytes: 1, how: 'undo', held: 'a chat uses it' }];
        // One step: a fresh plan, the person answers 1 s later, the script runs 1 s after that.
        const step = (answer, run = 'select', typed = false) => { t += 10e3; const p = makePlan('x', items, o()); (typed ? say : ask)(answer, t + 1e3); t += 2e3; return [p, run === 'select' ? select('x', o()) : null]; };
        const sel = a => step(a)[1];

        const [plan, none] = step('x');
        assert.match(plan.lines[0], /^1\. A - 1\.2 GB - to the bin \[a\]$/);
        assert.match(plan.lines[1], /^2\. B - 3\.0 GB - FOREVER/);
        assert.match(plan.lines[3], /^4\. D - size unknown/);
        assert.equal(plan.lines.at(-1), '- H - held: a chat uses it');
        assert.equal(none.code, 2, 'a word that is not a selection is refused');
        t += 10e3; makePlan('x', items, o());
        assert.match(select('x', o()).out, /no answer/, 'nothing recorded after the list');

        for (const yes of ['да', 'Да.', 'ok', 'Давай!']) { const r = sel(yes); assert.equal(r.code, 2); assert.match(r.out, /not a selection/, yes); }
        let r = sel('1,3');
        assert.equal(r.code, 0); assert.match(r.out, /Chosen 2 of 5/); assert.match(r.out, /ASK: Remove, undoable: 1, 3/); assert.doesNotMatch(r.out, /Delete forever/);
        assert.match(r.out, /Not touched: 2\. B, 4\. D, 5\. E; held: H \(a chat uses it\)/);
        assert.deepEqual(load('x', o()).sel, ['a', 'c']);
        r = sel('Все кроме 2 (Recommended)');
        assert.match(r.out, /ASK: Удалить с возвратом: 1, 3, 5\nASK: Удалить навсегда: 4/); assert.match(r.out, /Выбрано 4 из 5/); assert.match(r.out, /размер неизвестен/);
        assert.match(sel('all').out, /Chosen 5 of 5/);
        assert.deepEqual(load('x', o()).sel, ['a', 'b', 'c', 'd', 'e']);
        assert.deepEqual(JSON.parse(JSON.stringify(sel('1-3').out.match(/ASK: .*/g))), ['ASK: Remove, undoable: 1, 3', 'ASK: Delete forever: 2']);
        r = sel('2, 4 (2 GB)'); assert.equal(r.code, 0); assert.deepEqual(load('x', o()).sel, ['b', 'd'], 'text in parentheses is dropped');
        for (const bad of ['#2 #4', 'Все кроме #2', '3. branch issue#7', 'удали 1 и ветку 3', 'ничего 1', 'нет, 2', 'all nothing']) {
            r = sel(bad); assert.equal(r.code, 2, bad); assert.match(r.out, /answer with numbers/, bad);
        }
        r = sel('Да, 1 и 3'); assert.equal(r.code, 0); assert.deepEqual(load('x', o()).sel, ['a', 'c'], 'a yes-word next to a selection is filler');
        r = sel('Да, всё'); assert.equal(r.code, 0); assert.equal(load('x', o()).sel.length, 5);
        r = sel('1,3 удоли'); assert.equal(r.code, 2); assert.match(r.out, /answer with numbers/);
        r = sel('9'); assert.equal(r.code, 2); assert.match(r.out, /^9 is not on the list/);
        r = sel('6'); assert.equal(r.code, 2); assert.match(r.out, /^6 is not on the list.*held/);
        assert.equal(sel('1-9').code, 2);
        r = sel('ничего'); assert.equal(r.code, 0); assert.match(r.out, /ничего не будет удалено/); r = sel('nothing'); assert.match(r.out, /nothing will be deleted/); assert.deepEqual(load('x', o()).sel, []);
        assert.equal(sel('нет').code, 0);
        r = step('1,3', 'plan', true); r = select('x', o()); assert.equal(r.code, 0, 'a typed message counts');

        // grant
        const go = answer => { sel('1,2'); t += 1e3; ask(answer, t); t += 1e3; return grant('x', o()); };
        r = go('да'); assert.equal(r.code, 2); assert.match(r.out, /nothing granted/);
        r = go('Нет'); assert.equal(r.code, 2);
        r = go('Remove, undoable: 1'); assert.equal(r.code, 0); assert.match(r.out, /^GRANTED: a\nNOT GRANTED: b$/);
        assert.equal(grant('x', o()).code, 2, 'one answer grants once');
        process.env.CLAUDE_CODE_SESSION_ID = 'S1';
        assert.throws(() => check('x', ['b'], o()), /not confirmed by the person: b.*confirm\.mjs grant/);
        check('x', ['a'], o());
        assert.throws(() => check('x', ['a'], o()), /not confirmed.*a/, 'a grant is used once');
        // a transcript longer than the tail: the answer at its end is still read (tail 4 KB, 40 KB of earlier lines)
        const big = join(tmp, 'big.jsonl'), ob = () => ({ ...o(), transcript: big, tail: 4096 });
        t += 10e3; makePlan('x', items, ob());
        writeFileSync(big, JSON.stringify({ type: 'assistant', pad: 'é'.repeat(20e3) }) + '\n' + JSON.stringify({ type: 'user', isSidechain: false, timestamp: new Date(t + 1e3).toISOString(), toolUseResult: { answers: { 'Что?': '1,3' } }, message: { role: 'user', content: [{ type: 'tool_result' }] } }) + '\n');
        t += 2e3;
        assert.equal(select('x', ob()).code, 0, 'an answer at the end of a transcript longer than the tail is read');
        process.env.CLAUDE_CODE_SESSION_ID = '';
        assert.throws(() => check('x', ['b'], { ...o(), sid: undefined }), /missing or empty/, 'an empty session id is no way round the grant');
        delete process.env.CLAUDE_CODE_SESSION_ID;
        for (const v of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) {
            process.env[v] = '1';
            assert.throws(() => check('x', ['b'], { ...o(), sid: undefined }), /missing or empty/, `an unset session id inside Claude (${v}) is no way round the grant`);
            delete process.env[v];
        }
        r = go('Delete forever: 2\nRemove, undoable: 1, 3'); assert.equal(r.code, 0); assert.match(r.out, /^GRANTED: b\nNOT GRANTED: a$/); // "1, 3" is no label for 1
        r = go('Delete forever: 2 и Remove, undoable: 1'); assert.equal(r.code, 2, 'two labels on one line are no label');
        r = go('Remove, undoable: 1, 3 - нет, не надо, отмена'); assert.equal(r.code, 2, 'the label with more on its line');
        r = go('Удалить с возвратом: 1 (Recommended).'); assert.equal(r.code, 0, 'the label in Russian, with the marker and a full stop');
        r = go('Да, всё'); assert.equal(r.code, 2, 'a yes-word grants nothing; the exact label does');
        sel('1,3'); t += 1e3; ask('Remove, undoable: 1, 3, 4', t); t += 1e3;
        assert.equal(grant('x', o()).code, 2, 'a label that runs on into more numbers is not the label');
        ask('Remove, undoable: 1, 3', t += 1e3); t += 1e3;
        assert.equal(grant('x', o()).out, 'GRANTED: a c');
        const g = t; t = g + 31 * MIN;
        assert.throws(() => check('x', ['a'], { ...o(), now: g + 31 * MIN }), /not confirmed/, '31 minutes after the grant');
        t = g; check('x', ['c'], { ...o(), now: g + 29 * MIN });
        assert.doesNotThrow(() => check('x', ['zzz'], { dir: join(tmp, 'c') }), 'no session: a person at a terminal');
        assert.throws(() => check('x', ['zzz'], o()), /not confirmed/);

        // old answers and side threads do not count
        t += 10e3; ask('1,3', t - 5e3); makePlan('x', items, o());
        assert.match(select('x', o()).out, /no answer/, 'an answer from before the list');
        say('1', t + 1e3, { isSidechain: true }); ask('1', t + 2e3, { isSidechain: true });
        say('1', t + 3e3, { isMeta: true }); say('<command-name>x</command-name>', t + 4e3);
        t += 5e3;
        assert.match(select('x', o()).out, /no answer/, 'side thread, meta and tag messages');

        // a compact summary or a visible-only record quoting the ASK line is no answer; a pasted image plus text is a typed message
        sel('1,3'); t += 1e3;
        say('This session is being continued... ASK: Remove, undoable: 1, 3', t, { isCompactSummary: true }); say('Remove, undoable: 1, 3', t += 1e3, { isVisibleInTranscriptOnly: true });
        say([{ type: 'text', text: 'Remove, undoable: 1, 3' }, { type: 'tool_result' }], t += 1e3);
        t += 1e3;
        assert.match(grant('x', o()).out, /no answer/, 'compact summary, visible-only record, tool_result array');
        ask('Remove, undoable: 1, 3', t += 1e3); say([{ type: 'image' }, { type: 'text', text: 'стоп' }], t += 1e3); t += 1e3;
        assert.equal(grant('x', o()).code, 2, 'a later typed "стоп" with an image is the last answer');
        say([{ type: 'image' }, { type: 'text', text: 'Remove, undoable: 1, 3' }], t += 1e3); t += 1e3;
        assert.equal(grant('x', o()).out, 'GRANTED: a c');

        // scope: a grant made for one list does not pass another
        t += 10e3; makePlan('x', items, { ...o(), scope: 'A' }); ask('1,3', t + 1e3); t += 2e3; select('x', o());
        ask('Remove, undoable: 1, 3', t += 1e3); t += 1e3; assert.equal(grant('x', o()).out, 'GRANTED: a c');
        process.env.CLAUDE_CODE_SESSION_ID = 'S1';
        assert.throws(() => check('x', ['a'], { ...o(), scope: 'B' }), /scope "A"/);
        assert.throws(() => check('x', ['a'], o()), /scope "A"/, 'no scope is a scope');
        check('x', ['a'], { ...o(), scope: ['B', 'A'] });
        delete process.env.CLAUDE_CODE_SESSION_ID;

        // a repeated id is held, not an error
        const d = makePlan('x', [items[0], { ...items[1], id: 'a' }, items[2]], { ...o(), dup: 'same trash id in another repo' });
        assert.deepEqual(d.lines, ['1. C - 409.6 MB - можно вернуть/can be restored [c]', '- A - held: same trash id in another repo', '- B - held: same trash id in another repo']);
        console.log(`confirm.mjs selftest done (${process.platform}, node ${process.version})`);
    } finally {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
        rmSync(tmp, { recursive: true, force: true });
    }
}

// ---- CLI ------------------------------------------------------------------------------------------------------

function main(argv) {
    const [cmd, tool, src] = argv;
    if (cmd === '--selftest') return selftest();
    if (!['plan', 'select', 'grant'].includes(cmd) || !/^[\w-]+$/.test(tool ?? '') || (cmd === 'plan' && !src)) {
        console.error('usage: node confirm.mjs plan <tool> <items.json | -> | select <tool> | grant <tool> | --selftest');
        process.exitCode = 2; return;
    }
    if (cmd === 'plan') return console.log(makePlan(tool, JSON.parse(readFileSync(src === '-' ? 0 : src, 'utf8'))).lines.join('\n'));
    const r = (cmd === 'select' ? select : grant)(tool);
    (r.code ? console.error : console.log)(r.out);
    process.exitCode = r.code;
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
    try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
