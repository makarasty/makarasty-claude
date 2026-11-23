#!/usr/bin/env node
// Catalogue of visual defect kinds: each kind names a detector and, when one exists,
// the walk.jsonl field that implements it. Complaints add to it so the next walk sweeps for them.
import { randomBytes } from 'node:crypto';
import {
    closeSync,
    copyFileSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const DETECTOR_KINDS = ['COVERED', 'PROBE', 'FILM', 'HOVER', 'CLICK', 'PIXEL', 'JUDGE', 'NO'];

const USAGE = `usage: node catalogue.mjs <command> [--file <catalogue.json>] [--seed <kinds.json>] ...
  init [--from <old.json>]     create the catalogue from the seed, optionally importing an old file
  find <words...>              top 5 kinds matching the words
  add --title <t> --category <c> --kind <${DETECTOR_KINDS.join('|')}> --spec <s>
      [--impl <field>] [--judge <line>] [--quote <q>] [--project <name>]
  hit <id> [--quote <q>] [--project <name>]   one more complaint about a kind
  impl <id> <field|->          set the implementing walk.jsonl field ('-' clears it)
  judge-lines                  kinds a judge must look for by eye, one line each
  stats                        counts per detector kind
  sweep <walkDir> <id|field>   routes of a walk where that detector fires
  show <id>                    one entry as JSON`;

const OPTIONS = {
    file: { type: 'string' },
    seed: { type: 'string' },
    from: { type: 'string' },
    title: { type: 'string' },
    category: { type: 'string' },
    kind: { type: 'string' },
    spec: { type: 'string' },
    impl: { type: 'string' },
    judge: { type: 'string' },
    quote: { type: 'string' },
    project: { type: 'string' },
};

class CliError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

const usageError = (message) => new CliError(`${message}\n${USAGE}`, 2);

export function defaultCataloguePath(env = process.env) {
    return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'makarasty', 'visual-catalogue.json');
}

export function today(now = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function tokenize(text) {
    return String(text ?? '')
        .toLowerCase()
        .split(/[^\p{L}]+/u)
        .filter((w) => w.length >= 3);
}

// Title words weigh 3x; every other field counts once per query word it contains.
export function rank(kinds, words) {
    const query = new Set(words.flatMap(tokenize));
    const scored = kinds.map((k) => {
        const titleWords = new Set(tokenize(k.title));
        const otherWords = new Set(
            [k.category, k.detector?.spec, k.judge, ...(k.quotes ?? [])].flatMap(tokenize),
        );
        let score = 0;
        for (const w of query) {
            if (titleWords.has(w)) score += 3;
            if (otherWords.has(w)) score += 1;
        }
        return { kind: k, score };
    });
    return scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((s) => s.kind);
}

export function nextId(kinds) {
    const max = kinds.reduce((m, k) => {
        const n = /^V(\d+)$/.exec(k.id);
        return n ? Math.max(m, Number(n[1])) : m;
    }, 0);
    return `V${String(max + 1).padStart(2, '0')}`;
}

export function freshEvidence() {
    return { complaints: 0, projects: [], first: null, last: null };
}

function readJson(path, what) {
    let text;
    try {
        text = readFileSync(path, 'utf8');
    } catch {
        throw new CliError(`cannot read ${what}: ${path}`, 1);
    }
    try {
        return JSON.parse(text.replace(/^﻿/, ''));
    } catch {
        throw new CliError(`${what} is not valid JSON: ${path}`, 1);
    }
}

// The tmp name is unique per writer and the previous file is kept as .bak, so a crash or a bad write loses nothing.
export function writeAtomic(path, data) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
        const fd = openSync(tmp, 'w');
        try {
            writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        if (existsSync(path)) copyFileSync(path, `${path}.bak`);
        renameSync(tmp, path);
    } catch (e) {
        try {
            unlinkSync(tmp);
        } catch {
            // the tmp file was never created or is already gone
        }
        throw e;
    }
}

const LOCK_TRIES = 100;
const LOCK_WAIT_MS = 50;
const LOCK_STALE_MS = 30_000;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function takeOverStale(lock) {
    try {
        if (Date.now() - statSync(lock).mtimeMs <= LOCK_STALE_MS) return;
        // Rename is atomic: of several waiters that find the same stale lock, one wins and the rest see ENOENT.
        const gone = `${lock}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
        renameSync(lock, gone);
        unlinkSync(gone);
    } catch {
        // another waiter already took it over or the holder released it
    }
}

/** Runs fn while holding <file>.lock, so load-modify-write cycles from parallel chats do not interleave. */
export function withLock(file, fn) {
    const lock = `${file}.lock`;
    mkdirSync(dirname(file), { recursive: true });
    let fd = null;
    for (let i = 0; fd === null; i++) {
        try {
            fd = openSync(lock, 'wx');
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            if (i >= LOCK_TRIES) {
                throw new CliError(`catalogue is locked by another run: ${lock}\nif no run is active, delete that file`, 1);
            }
            takeOverStale(lock);
            sleep(LOCK_WAIT_MS);
        }
    }
    try {
        return fn();
    } finally {
        closeSync(fd);
        try {
            unlinkSync(lock);
        } catch {
            // taken over as stale while this run was still going
        }
    }
}

/** Re-reads the catalogue inside the lock, lets fn change it and return the output, then writes it back. */
function mutate(ctx, fn) {
    return withLock(ctx.file, () => {
        const cat = load(ctx.file);
        const out = fn(cat);
        writeAtomic(ctx.file, cat);
        return out;
    });
}

function loadSeedKinds(seedPath) {
    const seed = readJson(seedPath, 'seed');
    if (!Array.isArray(seed.kinds)) throw new CliError(`seed has no kinds array: ${seedPath}`, 1);
    return seed.kinds;
}

export function buildFromSeed(seedKinds) {
    return {
        version: 1,
        kinds: seedKinds.map((s) => ({
            id: s.id,
            title: s.title,
            category: s.category,
            evidence: freshEvidence(),
            quotes: [],
            detector: s.detector,
            impl: s.impl ?? null,
            judge: s.judge ?? null,
        })),
    };
}

// The old entry's own fields win; the seed only fills impl and judge when it lacks them.
export function mergeOld(old, seedKinds) {
    const seedById = new Map(seedKinds.map((s) => [s.id, s]));
    const kinds = old.entries.map((e) => {
        const s = seedById.get(e.id);
        const merged = { ...e };
        if (!('impl' in e)) merged.impl = s?.impl ?? null;
        if (!('judge' in e)) merged.judge = s?.judge ?? null;
        return merged;
    });
    const have = new Set(kinds.map((k) => k.id));
    const added = buildFromSeed(seedKinds.filter((s) => !have.has(s.id))).kinds;
    return { version: 1, kinds: [...kinds, ...added] };
}

function scriptPath() {
    return fileURLToPath(import.meta.url);
}

function load(path) {
    if (!existsSync(path)) {
        throw new CliError(`no catalogue at ${path}\nrun: node ${scriptPath()} init`, 1);
    }
    const cat = readJson(path, 'catalogue');
    if (!Array.isArray(cat.kinds)) throw new CliError(`catalogue has no kinds array: ${path}`, 1);
    return cat;
}

function findKind(cat, id) {
    const kind = cat.kinds.find((k) => k.id === id);
    if (!kind) throw new CliError(`no kind ${id}`, 1);
    return kind;
}

const implCell = (k) => k.impl ?? '-';

function cmdInit(opts, ctx) {
    return withLock(ctx.file, () => initLocked(opts, ctx));
}

function initLocked(opts, ctx) {
    if (existsSync(ctx.file)) return `catalogue already exists, unchanged: ${ctx.file}`;
    const seedKinds = loadSeedKinds(ctx.seed);
    let cat;
    if (opts.from) {
        const old = readJson(opts.from, 'old catalogue');
        if (!Array.isArray(old.entries)) throw new CliError(`old catalogue has no entries array: ${opts.from}`, 1);
        cat = mergeOld(old, seedKinds);
    } else {
        cat = buildFromSeed(seedKinds);
    }
    writeAtomic(ctx.file, cat);
    return `${cat.kinds.length} kinds, ${cat.kinds.filter((k) => k.impl).length} with a working detector`;
}

function cmdFind(words, ctx) {
    if (!words.length) throw usageError('find needs at least one word');
    const hits = rank(load(ctx.file).kinds, words).slice(0, 5);
    if (!hits.length) return 'no match';
    return hits.map((k) => `${k.id}  ${k.detector?.kind}  ${implCell(k)}  ${k.title}`).join('\n');
}

function cmdAdd(opts, ctx) {
    for (const f of ['title', 'category', 'kind', 'spec']) {
        if (!opts[f]) throw usageError(`add needs --${f}`);
    }
    if (!DETECTOR_KINDS.includes(opts.kind)) {
        throw usageError(`--kind must be one of ${DETECTOR_KINDS.join(', ')}`);
    }
    return mutate(ctx, (cat) => {
        const id = nextId(cat.kinds);
        const day = today();
        cat.kinds.push({
            id,
            title: opts.title,
            category: opts.category,
            evidence: { complaints: 1, projects: opts.project ? [opts.project] : [], first: day, last: day },
            quotes: opts.quote ? [opts.quote] : [],
            detector: { kind: opts.kind, spec: opts.spec },
            impl: opts.impl && opts.impl !== '-' ? opts.impl : null,
            judge: opts.judge ?? null,
        });
        return id;
    });
}

function cmdHit(id, opts, ctx) {
    if (!id) throw usageError('hit needs an id');
    return mutate(ctx, (cat) => {
        const kind = findKind(cat, id);
        const ev = (kind.evidence ??= freshEvidence());
        // An imported entry counts chats, not complaints: start from that so its history is not reset.
        ev.complaints = (ev.complaints ?? ev.chats ?? 0) + 1;
        ev.first ??= today();
        ev.last = today();
        ev.projects ??= [];
        if (opts.project && !ev.projects.includes(opts.project)) ev.projects.push(opts.project);
        kind.quotes ??= [];
        if (opts.quote && !kind.quotes.includes(opts.quote)) kind.quotes.push(opts.quote);
        return `${id}: ${ev.complaints} complaints`;
    });
}

function cmdImpl(id, field, ctx) {
    if (!id || !field) throw usageError('impl needs an id and a field');
    return mutate(ctx, (cat) => {
        const kind = findKind(cat, id);
        kind.impl = field === '-' ? null : field;
        return `${id}  ${implCell(kind)}`;
    });
}

// A judge sees stills: the wide, dark and narrow shots, click shots and, in a --film run, three load frames. A FILM kind
// with no detector is judged on those frames only; data (NO) kinds are not theirs.
const STILL_ALWAYS = new Set(['JUDGE', 'PIXEL']);
const STILL_WITHOUT_IMPL = new Set(['PROBE', 'CLICK', 'HOVER', 'FILM']);

function cmdJudgeLines(ctx) {
    let kinds;
    if (existsSync(ctx.file)) {
        kinds = load(ctx.file).kinds;
    } else {
        // A first walk has no personal catalogue yet; the shipped seed is enough for the judge brief.
        kinds = loadSeedKinds(ctx.seed);
        process.stderr.write(`no personal catalogue yet, using the shipped kinds; run: node ${scriptPath()} init\n`);
    }
    return kinds
        .filter((k) => STILL_ALWAYS.has(k.detector?.kind) || (!k.impl && STILL_WITHOUT_IMPL.has(k.detector?.kind)))
        .map((k) => `${k.id}${k.detector?.kind === 'FILM' ? ' (film frames only)' : ''} ${k.title}: ${(k.judge || k.detector?.spec || '').slice(0, 240)}`)
        .join('\n');
}

function cmdStats(ctx) {
    const kinds = load(ctx.file).kinds;
    const rows = [['kind', 'total', 'with impl', 'without impl']];
    for (const name of DETECTOR_KINDS) {
        const of = kinds.filter((k) => k.detector?.kind === name);
        if (!of.length) continue;
        const withImpl = of.filter((k) => k.impl).length;
        rows.push([name, of.length, withImpl, of.length - withImpl]);
    }
    const withImpl = kinds.filter((k) => k.impl).length;
    rows.push(['all', kinds.length, withImpl, kinds.length - withImpl]);
    const width = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
    return rows.map((r) => r.map((c, i) => String(c).padEnd(width[i])).join('  ').trimEnd()).join('\n');
}

// A field "fires" when it holds a candidate; these need a threshold or a flag rather than plain non-emptiness.
const FIRES = {
    'clicks.opening': (v) => v?.animated === false,
    'clicks.moved': (v) => !!v && (v.moved?.length > 0 || Math.abs(v.widthChange || 0) > 1),
    'clicks.dialog': (v) => !!v && ['cut', 'closeOutside', 'textClose', 'noClose', 'blackScrim'].some((k) => v[k]),
    'clicks.layers': (v) => (v || []).some((l) => l.cut || l.covered),
    'clicks.dead': (v) => v === true,
    'film.cls': (v) => v >= 0.1,
    'film.blankMs': (v) => v >= 300,
    'film.waves': (v) => v > 2,
};
const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' ? Object.values(v).some(nonEmpty) : typeof v === 'number' ? v > 0 : !!v);

/** Routes of a walk where the field fires, with the evidence: the whole-app check for one defect kind. */
export function sweepRows(rows, field) {
    const [head, ...rest] = field.split('.');
    const fires = FIRES[field] || nonEmpty;
    const pick = (obj) => rest.reduce((o, k) => (o == null ? o : o[k]), obj);
    const hits = [];
    for (const r of rows) {
        let found = [];
        if (head === 'probes') found = [['wide', r.probes], ['dark', r.probesDark], ['narrow', r.probesNarrow]].filter(([, p]) => p && fires(pick(p))).map(([w, p]) => [w, pick(p)]);
        else if (head === 'clicks' || head === 'hover') found = (r[head] || []).filter((c) => fires(pick(c))).map((c) => [c.name, rest.length ? pick(c) : c]);
        else if (fires(rest.length ? pick(r[head]) : r[head])) found = [[head, rest.length ? pick(r[head]) : r[head]]];
        if (found.length) hits.push({ route: r.route, where: found.map(([w]) => w), evidence: JSON.stringify(found[0][1]).slice(0, 200) });
    }
    return hits;
}

function cmdSweep(dir, what, ctx) {
    if (!dir || !what) throw usageError('sweep needs a walk folder and a kind id or field');
    const field = /^V\d+$/i.test(what) ? findKind(load(ctx.file), what.toUpperCase()).impl : what;
    if (!field) throw new CliError(`${what} has no detector yet (impl is empty): write one first, then set it with impl.`, 1);
    const jsonl = join(resolve(dir), 'walk.jsonl');
    if (!existsSync(jsonl)) throw new CliError(`no walk.jsonl in ${dir}`, 1);
    const rows = readFileSync(jsonl, 'utf8').replace(/^﻿/, '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const hits = sweepRows(rows, field);
    return [`${what} ${field}: ${hits.length} of ${rows.length} routes`, ...hits.map((h) => `${h.route}  [${h.where.join(',')}]  ${h.evidence}`)].join('\n');
}

export function run(argv, env = process.env) {
    const [command, ...rest] = argv;
    if (!command) throw usageError('missing command');
    let parsed;
    try {
        parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true });
    } catch (e) {
        throw usageError(e.message);
    }
    const { values: opts, positionals } = parsed;
    const ctx = {
        file: resolve(opts.file ?? defaultCataloguePath(env)),
        seed: resolve(opts.seed ?? join(dirname(scriptPath()), 'kinds.json')),
    };
    switch (command) {
        case 'init':
            return cmdInit(opts, ctx);
        case 'find':
            return cmdFind(positionals, ctx);
        case 'add':
            return cmdAdd(opts, ctx);
        case 'hit':
            return cmdHit(positionals[0], opts, ctx);
        case 'impl':
            return cmdImpl(positionals[0], positionals[1], ctx);
        case 'judge-lines':
            return cmdJudgeLines(ctx);
        case 'stats':
            return cmdStats(ctx);
        case 'sweep':
            return cmdSweep(positionals[0], positionals[1], ctx);
        case 'show': {
            if (!positionals[0]) throw usageError('show needs an id');
            return JSON.stringify(findKind(load(ctx.file), positionals[0]), null, 2);
        }
        default:
            throw usageError(`unknown command: ${command}`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        const out = run(process.argv.slice(2));
        if (out) process.stdout.write(`${out}\n`);
    } catch (e) {
        if (!(e instanceof CliError)) throw e;
        process.stderr.write(`${e.message}\n`);
        process.exit(e.code);
    }
}
