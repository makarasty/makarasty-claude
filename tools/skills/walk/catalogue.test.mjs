import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const SCRIPT = fileURLToPath(new URL('./catalogue.mjs', import.meta.url));

const SEED = {
    version: 1,
    kinds: [
        {
            id: 'V01',
            title: 'Popup jumps when it opens',
            category: 'motion',
            detector: { kind: 'FILM', spec: 'Record frames while the dialog opens', cost: 'high' },
            impl: 'films.popupJump',
            judge: 'Watch the dialog open: it must not shift',
        },
        {
            id: 'V02',
            title: 'Uneven gaps between stacked blocks',
            category: 'spacing',
            detector: { kind: 'PROBE', spec: 'Compare gaps between sibling cards', cost: 'low' },
            impl: 'probes.unevenGaps',
            judge: null,
        },
        {
            id: 'V03',
            title: 'Icon looks off-brand',
            category: 'brand',
            detector: { kind: 'JUDGE', spec: 'Look at icons for style mismatch', cost: 'low' },
            impl: null,
            judge: 'Icons share one stroke width and style',
        },
        {
            id: 'V04',
            title: 'Stale data after a role switch',
            category: 'data',
            detector: { kind: 'NO', spec: 'Needs a second writer', cost: 'high' },
            impl: null,
            judge: null,
        },
        {
            id: 'V05',
            title: 'Label clipped on hover',
            category: 'text',
            detector: { kind: 'HOVER', spec: 'X'.repeat(300), cost: 'low' },
            impl: null,
            judge: null,
        },
    ],
};

const OLD = {
    entries: [
        {
            id: 'V01',
            title: 'Old title kept',
            category: 'old-cat',
            evidence: { chats: 4, messages: 5, first: '2026-01-01', last: '2026-02-02', agentBriefOnly: false },
            quotes: ['всплывающее окно прыгает'],
            rule: 'rules/x.md:1',
            detector: { kind: 'FILM', spec: 'old spec', cost: 'high' },
            sources: ['a:1'],
        },
        {
            id: 'V02',
            title: 'Has its own impl',
            category: 'spacing',
            evidence: { chats: 1, messages: 1, first: null, last: null },
            quotes: [],
            rule: 'r',
            detector: { kind: 'PROBE', spec: 's', cost: 'low' },
            impl: 'probes.mine',
            sources: [],
        },
    ],
    dropped: [],
};

let dir;
let seed;
let old;
let n = 0;

function cli(args, { file } = {}) {
    const full = file === null ? args : [...args, '--file', file ?? join(dir, 'cat.json'), '--seed', seed];
    const r = spawnSync(process.execPath, [SCRIPT, ...full], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
}

function freshFile() {
    n += 1;
    return join(dir, `cat-${n}.json`);
}

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

before(() => {
    dir = mkdtempSync(join(tmpdir(), 'catalogue-test-'));
    seed = join(dir, 'kinds.json');
    old = join(dir, 'old.json');
    writeFileSync(seed, JSON.stringify(SEED));
    writeFileSync(old, JSON.stringify(OLD));
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe('init', () => {
    it('writes the catalogue from the seed', () => {
        const file = freshFile();
        const r = cli(['init'], { file });
        assert.equal(r.code, 0);
        assert.equal(r.out.trim(), '5 kinds, 2 with a working detector');
        const cat = read(file);
        assert.equal(cat.version, 1);
        assert.equal(cat.kinds.length, 5);
        assert.deepEqual(cat.kinds[0].evidence, { complaints: 0, projects: [], first: null, last: null });
        assert.deepEqual(cat.kinds[0].quotes, []);
        assert.equal(cat.kinds[1].impl, 'probes.unevenGaps');
        assert.ok(readFileSync(file, 'utf8').endsWith('}\n'));
        assert.match(readFileSync(file, 'utf8'), /\n {2}"version"/);
    });

    it('changes nothing when the catalogue exists', () => {
        const file = freshFile();
        writeFileSync(file, '{"version":1,"kinds":[]}');
        const r = cli(['init'], { file });
        assert.equal(r.code, 0);
        assert.match(r.out, /already exists/);
        assert.equal(readFileSync(file, 'utf8'), '{"version":1,"kinds":[]}');
    });

    it('imports an old file: person fields kept, impl added, missing ids added', () => {
        const file = freshFile();
        const r = cli(['init', '--from', old], { file });
        assert.equal(r.code, 0);
        assert.equal(r.out.trim(), '5 kinds, 2 with a working detector');
        const cat = read(file);
        assert.deepEqual(cat.kinds.map((k) => k.id), ['V01', 'V02', 'V03', 'V04', 'V05']);
        const v1 = cat.kinds[0];
        assert.equal(v1.title, 'Old title kept');
        assert.equal(v1.category, 'old-cat');
        assert.deepEqual(v1.evidence, OLD.entries[0].evidence);
        assert.deepEqual(v1.quotes, ['всплывающее окно прыгает']);
        assert.equal(v1.rule, 'rules/x.md:1');
        assert.deepEqual(v1.detector, OLD.entries[0].detector);
        assert.deepEqual(v1.sources, ['a:1']);
        assert.equal(v1.impl, 'films.popupJump');
        assert.equal(v1.judge, 'Watch the dialog open: it must not shift');
        assert.equal(cat.kinds[1].impl, 'probes.mine');
        assert.equal(cat.kinds[2].judge, 'Icons share one stroke width and style');
        assert.equal(cat.kinds[2].evidence.complaints, 0);
    });

    it('rejects an old file without entries', () => {
        const bad = join(dir, 'bad.json');
        writeFileSync(bad, '{}');
        const file = freshFile();
        assert.equal(cli(['init', '--from', bad], { file }).code, 1);
        assert.equal(existsSync(file), false);
    });
});

describe('with a catalogue', () => {
    let file;
    let imported;
    before(() => {
        file = freshFile();
        cli(['init'], { file });
        imported = freshFile();
        cli(['init', '--from', old], { file: imported });
    });

    it('find ranks a title match first', () => {
        const r = cli(['find', 'uneven', 'gaps'], { file });
        assert.equal(r.code, 0);
        const first = r.out.split('\n')[0];
        assert.equal(first, 'V02  PROBE  probes.unevenGaps  Uneven gaps between stacked blocks');
    });

    it('find matches a title word over a spec word', () => {
        const r = cli(['find', 'icon', 'stroke'], { file });
        assert.match(r.out.split('\n')[0], /^V03 {2}JUDGE {2}- {2}Icon looks off-brand$/);
    });

    it('find matches a Cyrillic quote', () => {
        const r = cli(['find', 'Всплывающее', 'ПРЫГАЕТ'], { file: imported });
        assert.match(r.out.split('\n')[0], /^V01 {2}FILM {2}films\.popupJump {2}Old title kept$/);
    });

    it('find drops short words and prints no match', () => {
        assert.equal(cli(['find', 'a', 'to'], { file }).out.trim(), 'no match');
        assert.equal(cli(['find'], { file }).code, 2);
        assert.equal(cli(['find', 'zzzqqq'], { file }).out.trim(), 'no match');
    });

    it('add gets the next id and today dates', () => {
        const r = cli(
            ['add', '--title', 'Toast hides button', '--category', 'layers', '--kind', 'PROBE', '--spec', 'overlap', '--quote', 'toast covers it', '--project', 'proj-a'],
            { file },
        );
        assert.equal(r.code, 0);
        assert.equal(r.out.trim(), 'V06');
        const added = read(file).kinds.at(-1);
        assert.equal(added.id, 'V06');
        assert.equal(added.impl, null);
        assert.equal(added.evidence.complaints, 1);
        assert.deepEqual(added.evidence.projects, ['proj-a']);
        assert.match(added.evidence.first, dayPattern);
        assert.equal(added.evidence.first, added.evidence.last);
        assert.deepEqual(added.quotes, ['toast covers it']);
        assert.deepEqual(added.detector, { kind: 'PROBE', spec: 'overlap' });
    });

    it('add keeps going past two digits and validates the kind', () => {
        const f = freshFile();
        writeFileSync(f, JSON.stringify({ version: 1, kinds: [{ id: 'V88', title: 't', detector: { kind: 'NO' } }] }));
        const ok = cli(['add', '--title', 'x', '--category', 'c', '--kind', 'JUDGE', '--spec', 's', '--impl', 'probes.x'], { file: f });
        assert.equal(ok.out.trim(), 'V89');
        assert.equal(read(f).kinds.at(-1).impl, 'probes.x');
        const bad = cli(['add', '--title', 'x', '--category', 'c', '--kind', 'MAGIC', '--spec', 's'], { file: f });
        assert.equal(bad.code, 2);
        assert.match(bad.err, /--kind must be one of/);
        assert.equal(read(f).kinds.length, 2);
        assert.equal(cli(['add', '--title', 'x'], { file: f }).code, 2);
    });

    it('hit bumps evidence, creating complaints on an imported entry', () => {
        const file = imported;
        const r = cli(['hit', 'V01', '--quote', 'jumps again', '--project', 'proj-b'], { file });
        assert.equal(r.code, 0);
        const v1 = read(file).kinds[0];
        assert.equal(v1.evidence.complaints, 5);
        assert.match(v1.evidence.last, dayPattern);
        assert.notEqual(v1.evidence.last, '2026-02-02');
        assert.equal(v1.evidence.first, '2026-01-01');
        assert.deepEqual(v1.quotes, ['всплывающее окно прыгает', 'jumps again']);
        assert.deepEqual(v1.evidence.projects, ['proj-b']);
        cli(['hit', 'V01', '--quote', 'jumps again', '--project', 'proj-b'], { file });
        const again = read(file).kinds[0];
        assert.equal(again.evidence.complaints, 6);
        assert.deepEqual(again.quotes, ['всплывающее окно прыгает', 'jumps again']);
        assert.deepEqual(again.evidence.projects, ['proj-b']);
        assert.equal(cli(['hit', 'V99'], { file }).code, 1);
    });

    it('impl sets and clears', () => {
        assert.equal(cli(['impl', 'V03', 'probes.iconStyle'], { file }).code, 0);
        assert.equal(read(file).kinds[2].impl, 'probes.iconStyle');
        assert.equal(cli(['impl', 'V03', '-'], { file }).code, 0);
        assert.equal(read(file).kinds[2].impl, null);
        assert.equal(cli(['impl', 'V03'], { file }).code, 2);
    });

    it('show prints the entry as JSON', () => {
        const r = cli(['show', 'V02'], { file });
        assert.equal(JSON.parse(r.out).id, 'V02');
    });
});

describe('judge-lines and stats', () => {
    let file;
    before(() => {
        file = freshFile();
        cli(['init'], { file });
    });

    it('lists JUDGE kinds and still-visible kinds without impl, never FILM or NO', () => {
        const lines = cli(['judge-lines'], { file }).out.trim().split('\n');
        assert.deepEqual(
            lines.map((l) => l.slice(0, 3)),
            ['V03', 'V05'],
        );
        assert.equal(lines[0], 'V03 Icon looks off-brand: Icons share one stroke width and style');
        assert.equal(lines[1], `V05 Label clipped on hover: ${'X'.repeat(240)}`);
    });

    it('prints counts per detector kind', () => {
        const r = cli(['stats'], { file });
        assert.equal(r.code, 0);
        const rows = r.out.trim().split('\n').map((l) => l.split(/\s{2,}/));
        assert.deepEqual(rows[0], ['kind', 'total', 'with impl', 'without impl']);
        assert.deepEqual(rows.find((x) => x[0] === 'FILM'), ['FILM', '1', '1', '0']);
        assert.deepEqual(rows.find((x) => x[0] === 'NO'), ['NO', '1', '0', '1']);
        assert.deepEqual(rows.at(-1), ['all', '5', '2', '3']);
    });
});

describe('judge-lines scope and fallback', () => {
    it('keeps JUDGE and PIXEL, and PROBE/CLICK/HOVER/FILM only without impl (FILM marked); leaves NO and COVERED out', () => {
        const kind = (id, k, impl) => ({ id, title: id, category: 'c', detector: { kind: k, spec: 's' }, impl, judge: null });
        const file = freshFile();
        writeFileSync(
            file,
            JSON.stringify({
                version: 1,
                kinds: [
                    kind('V01', 'JUDGE', 'probes.a'),
                    kind('V02', 'PIXEL', 'probes.b'),
                    kind('V03', 'PROBE', null),
                    kind('V04', 'PROBE', 'probes.c'),
                    kind('V05', 'CLICK', null),
                    kind('V06', 'HOVER', null),
                    kind('V07', 'FILM', null),
                    kind('V08', 'NO', null),
                    kind('V09', 'COVERED', null),
                ],
            }),
        );
        const ids = cli(['judge-lines'], { file }).out.trim().split('\n').map((l) => l.slice(0, 3));
        assert.deepEqual(ids, ['V01', 'V02', 'V03', 'V05', 'V06', 'V07']);
        assert.ok(cli(['judge-lines'], { file }).out.includes('V07 (film frames only) '));
    });

    it('falls back to the seed kinds when there is no catalogue, with one stderr line naming init', () => {
        const r = cli(['judge-lines'], { file: join(dir, 'none-yet.json') });
        assert.equal(r.code, 0);
        assert.deepEqual(r.out.trim().split('\n').map((l) => l.slice(0, 3)), ['V03', 'V05']);
        assert.equal(r.err.trim().split('\n').length, 1);
        assert.match(r.err, /init/);
        assert.equal(existsSync(join(dir, 'none-yet.json')), false);
    });
});

describe('failures', () => {
    it('a missing catalogue exits 1 and names init', () => {
        for (const args of [['find', 'gaps'], ['add', '--title', 't', '--category', 'c', '--kind', 'NO', '--spec', 's'], ['hit', 'V01'], ['impl', 'V01', 'x'], ['stats'], ['show', 'V01']]) {
            const r = cli(args, { file: join(dir, 'missing.json') });
            assert.equal(r.code, 1, args.join(' '));
            assert.match(r.err, /init/);
        }
    });

    it('an unknown command or no command exits 2 with usage', () => {
        const unknown = cli(['frobnicate']);
        assert.equal(unknown.code, 2);
        assert.match(unknown.err, /usage:/);
        assert.equal(cli([], { file: null }).code, 2);
        assert.equal(cli(['stats', '--bogus', 'x']).code, 2);
    });

    it('writes are atomic: no .tmp file is left behind', () => {
        const file = freshFile();
        cli(['init'], { file });
        cli(['hit', 'V02'], { file });
        cli(['impl', 'V02', '-'], { file });
        assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
    });

    it('the default catalogue path follows CLAUDE_CONFIG_DIR', () => {
        const cfg = join(dir, 'cfg');
        const r = spawnSync(process.execPath, [SCRIPT, 'init', '--seed', seed], {
            encoding: 'utf8',
            env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
        });
        assert.equal(r.status, 0);
        assert.ok(existsSync(join(cfg, 'makarasty', 'visual-catalogue.json')));
    });
});

describe('concurrency and file safety', () => {
    it('8 concurrent adds give 8 distinct ids, valid JSON, nothing lost, no lock or tmp left', async () => {
        const file = freshFile();
        cli(['init'], { file });
        const runs = Array.from({ length: 8 }, (_, i) =>
            new Promise((done) => {
                const p = spawn(process.execPath, [SCRIPT, 'add', '--title', `Parallel ${i}`, '--category', 'c', '--kind', 'NO', '--spec', 's', '--file', file, '--seed', seed], { stdio: ['ignore', 'pipe', 'pipe'] });
                let out = '';
                p.stdout.on('data', (d) => (out += d));
                p.on('close', (code) => done({ code, id: out.trim() }));
            }),
        );
        const results = await Promise.all(runs);
        assert.deepEqual(results.map((r) => r.code), Array(8).fill(0));
        assert.equal(new Set(results.map((r) => r.id)).size, 8);
        const cat = read(file);
        assert.equal(cat.kinds.length, 13);
        assert.equal(new Set(cat.kinds.map((k) => k.id)).size, 13);
        for (let i = 0; i < 8; i++) assert.ok(cat.kinds.some((k) => k.title === `Parallel ${i}`));
        const name = basename(file);
        assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith(`${name}.`) && !f.endsWith('.bak')), []);
    });

    it('a write keeps the previous file as .bak', () => {
        const file = freshFile();
        cli(['init'], { file });
        const before = readFileSync(file, 'utf8');
        cli(['hit', 'V01'], { file });
        assert.equal(readFileSync(`${file}.bak`, 'utf8'), before);
    });

    it('a fresh lock held by another run ends in a clear error naming the lock', () => {
        const file = freshFile();
        cli(['init'], { file });
        writeFileSync(`${file}.lock`, '');
        const r = cli(['hit', 'V01'], { file });
        assert.equal(r.code, 1);
        assert.match(r.err, /locked by another run/);
        assert.ok(r.err.includes(`${file}.lock`));
        assert.equal(read(file).kinds[0].evidence.complaints, 0);
    });

    it('a lock older than 30 s is stale and is taken over', () => {
        const file = freshFile();
        cli(['init'], { file });
        const lock = `${file}.lock`;
        writeFileSync(lock, '');
        const old = new Date(Date.now() - 60_000);
        utimesSync(lock, old, old);
        const r = cli(['hit', 'V01'], { file });
        assert.equal(r.code, 0);
        assert.equal(read(file).kinds[0].evidence.complaints, 1);
        assert.equal(existsSync(lock), false);
    });

    it('reads a catalogue saved with a leading BOM', () => {
        const file = freshFile();
        writeFileSync(file, `\uFEFF${JSON.stringify({ version: 1, kinds: SEED.kinds })}`);
        assert.equal(cli(['show', 'V02'], { file }).code, 0);
        assert.equal(cli(['hit', 'V02'], { file }).code, 0);
        assert.equal(read(file).kinds[1].evidence.complaints, 1);
        const bomSeed = join(dir, 'bom-seed.json');
        writeFileSync(bomSeed, `\uFEFF${JSON.stringify(SEED)}`);
        const fresh = freshFile();
        const r = spawnSync(process.execPath, [SCRIPT, 'init', '--file', fresh, '--seed', bomSeed], { encoding: 'utf8' });
        assert.equal(r.status, 0);
    });
});

describe('sweep', async () => {
    const { sweepRows } = await import('./catalogue.mjs');
    const rows = [
        { route: '/a', probes: { unevenGaps: [{ el: 'div', gaps: [8, 24] }] }, probesDark: { unevenGaps: [] }, clicks: [{ name: 'click0', dead: true, opening: { animated: false } }] },
        { route: '/b', probes: { unevenGaps: [] }, clicks: [{ name: 'click0', dead: false, opening: { animated: true } }], film: { cls: 0.02, blankMs: 900 } },
    ];
    it('finds the routes where a probe field holds candidates, per width', () => {
        const hits = sweepRows(rows, 'probes.unevenGaps');
        assert.deepEqual(hits.map((h) => [h.route, h.where]), [['/a', ['wide']]]);
    });
    it('reads click flags and film thresholds, not mere presence', () => {
        assert.deepEqual(sweepRows(rows, 'clicks.dead').map((h) => h.route), ['/a']);
        assert.deepEqual(sweepRows(rows, 'clicks.opening').map((h) => h.route), ['/a']);
        assert.deepEqual(sweepRows(rows, 'film.cls').map((h) => h.route), []);
        assert.deepEqual(sweepRows(rows, 'film.blankMs').map((h) => h.route), ['/b']);
    });
    it('the CLI sweeps a walk folder by kind id and refuses a kind with no detector', () => {
        const dir = mkdtempSync(join(tmpdir(), 'walk-sweep-'));
        const file = join(dir, 'cat.json');
        const seedFile = join(dir, 'seed.json');
        writeFileSync(seedFile, JSON.stringify({ version: 1, kinds: [
            { id: 'V05', title: 'Uneven gaps', category: 'spacing', detector: { kind: 'PROBE', spec: 's' }, impl: 'probes.unevenGaps', judge: null },
            { id: 'V06', title: 'No detector', category: 'x', detector: { kind: 'PROBE', spec: 's' }, impl: null, judge: 'look' },
        ] }));
        writeFileSync(join(dir, 'walk.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
        const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a, '--file', file, '--seed', seedFile], { encoding: 'utf8' });
        assert.equal(run('init').status, 0);
        const ok = run('sweep', dir, 'V05');
        assert.equal(ok.status, 0, ok.stderr);
        assert.match(ok.stdout, /^V05 probes\.unevenGaps: 1 of 2 routes\n\/a {2}\[wide\]/);
        assert.equal(run('sweep', dir, 'V06').status, 1);
        rmSync(dir, { recursive: true, force: true });
    });
});
