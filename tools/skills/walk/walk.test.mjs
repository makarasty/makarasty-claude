// Tests for the walk skill: pure helpers always run; the cases that need a browser run when WALK_PLAYWRIGHT names a
// folder whose node_modules hold Playwright, and skip with that reason otherwise.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// CONFIG_HOME is read when config.mjs loads, so the temp config dir has to exist first.
const root = mkdtempSync(join(tmpdir(), 'walk-test-'));
const configDir = join(root, 'claude');
mkdirSync(configDir, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = configDir;
const { ACTION_SEGMENT, CONFIG_HOME, VIEW_SKIP, installedChromium, isLocalOrigin, landedElsewhere, loadConfig, originFromFleet, routeKey, shapeOf, unsafeRegex } = await import('./config.mjs');
const { filmRecorder, filmVerdict, motionRecorder, motionVerdict } = await import('./film.mjs');
const { autoBatch, probeFloating, probePage, slugOf, writeBatches } = await import('./probes.mjs');

const WALK = fileURLToPath(new URL('./walk.mjs', import.meta.url));
after(() => rmSync(root, { recursive: true, force: true }));

const fresh = (name) => {
    const dir = mkdtempSync(join(root, `${name}-`));
    return dir;
};

describe('motionVerdict', () => {
    it('lists layout-property transitions by count and ignores transform and opacity', () => {
        const v = motionVerdict([
            { kind: 'transition', prop: 'max-height', el: 'div.dropdown' },
            { kind: 'transition', prop: 'max-height', el: 'div.dropdown' },
            { kind: 'transition', prop: 'transform', el: 'div.card' },
            { kind: 'transition', prop: 'opacity', el: 'div.fade' },
            { kind: 'animation', prop: 'shimmer', el: 'div.x-skeleton' },
        ]);
        assert.deepEqual(v, { total: 5, layout: [{ what: 'max-height on div.dropdown', n: 2 }] });
    });

    it('counts a repeated entry by its n and survives no list', () => {
        assert.deepEqual(motionVerdict([{ kind: 'transition', prop: 'width', el: 'div.bar', n: 7 }]).layout, [{ what: 'width on div.bar', n: 7 }]);
        assert.deepEqual(motionVerdict(undefined), { total: 0, layout: [] });
    });
});

describe('filmVerdict', () => {
    const vp = { width: 1440, height: 900 };
    const frame = (t, ...sk) => ({ t, sk });

    it('calls a skeleton replaced in place by a different one a cascade, and counts the waves', () => {
        const film = {
            frames: [
                frame(0, [1, 0, 0, 1440, 900, 'div.app-skeleton']),
                frame(300, [1, 0, 0, 1440, 900, 'div.app-skeleton']),
                frame(350),
                frame(900, [2, 260, 120, 1100, 600, 'div.page-skeleton']),
                frame(1500),
            ],
            shifts: [],
            swaps: [],
        };
        const v = filmVerdict(film, vp);
        assert.deepEqual(v.cascades, [{ at: 900, from: 'div.app-skeleton', to: 'div.page-skeleton', box: [260, 120, 1100, 600] }]);
        assert.equal(v.waves, 2);
        assert.equal(v.settledMs, 900);
    });

    it('counts the same skeleton re-created in place as a remount, and one still up at the end as lingering', () => {
        const film = {
            frames: [
                frame(0, [1, 700, 430, 38, 38, 'div.page-loader']),
                frame(100),
                frame(200, [2, 700, 430, 38, 38, 'div.page-loader']),
                frame(300, [3, 0, 0, 10, 10, 'span.badge-skeleton'], [2, 700, 430, 38, 38, 'div.page-loader']),
                frame(6000, [3, 0, 0, 10, 10, 'span.badge-skeleton']),
            ],
            shifts: [],
            swaps: [],
        };
        const v = filmVerdict(film, vp);
        assert.deepEqual(v.cascades, []);
        assert.equal(v.remounts, 1);
        assert.deepEqual(v.lingering, [{ cls: 'span.badge-skeleton', box: [0, 0, 10, 10], since: 300 }]);
        assert.equal(v.settledMs, 300);
    });

    it('flags content that does not fill its skeleton box, a blank run with no loader, a sub-250 ms flash and a late shift', () => {
        const film = {
            frames: [
                frame(0),
                { t: 50, sk: [], txt: 0 },
                { t: 400, sk: [], txt: 0 },
                { t: 450, sk: [[1, 260, 120, 600, 400, 'div.x-skeleton']], txt: 0 },
                { t: 600, sk: [[2, 0, 0, 40, 10, 'span.x-skeleton']], txt: 50 },
                { t: 700, sk: [], txt: 900 },
            ],
            shifts: [{ t: 3000, v: 0.05, src: [] }],
            swaps: [
                { t: 600, id: 1, cls: 'div.x-skeleton', parent: 'div.card', dy: 0, sk: [260, 120, 600, 400], content: [260, 120, 600, 180] },
                { t: 700, id: 2, cls: 'span.x-skeleton', parent: 'span.x', dy: 0, sk: [0, 0, 40, 10], content: [0, 0, 44, 10] },
            ],
        };
        const v = filmVerdict(film, vp);
        assert.deepEqual(v.mismatches, [{ t: 600, cls: 'div.x-skeleton', sk: [260, 120, 600, 400], content: [260, 120, 600, 180] }]);
        assert.equal(v.blankMs, 450);
        assert.equal(v.flashes, 2);
        assert.deepEqual(v.lateShifts, [{ t: 3000, v: 0.05, src: [] }]);
    });

    it('keeps side-by-side skeletons that never overlap out of the cascade list', () => {
        const film = { frames: [frame(0, [1, 0, 0, 100, 100, 'a']), frame(100), frame(200, [2, 500, 0, 100, 100, 'b'])], shifts: [], swaps: [] };
        assert.deepEqual(filmVerdict(film, vp).cascades, []);
    });

    it('reports swaps that move the container past the threshold, the page loader off the window centre, and the CLS sum', () => {
        const film = {
            frames: [frame(0, [1, 300, 100, 60, 60, 'div.page-loader'])],
            shifts: [
                { t: 10, v: 0.05, src: [] },
                { t: 20, v: 0.2, src: [] },
            ],
            swaps: [
                { t: 500, id: 3, cls: 'div.card__skeleton', parent: 'div.card', dy: 4 },
                { t: 600, id: 4, cls: 'div.table-skeleton', parent: 'div.table', dy: -120 },
            ],
        };
        const v = filmVerdict(film, vp);
        assert.deepEqual(v.jumps, [{ t: 600, cls: 'div.table-skeleton', parent: 'div.table', dy: -120 }]);
        assert.deepEqual(v.offCentre, [{ cls: 'div.page-loader', box: [300, 100, 60, 60] }]);
        assert.equal(v.cls, 0.25);
        assert.equal(v.topShifts[0].v, 0.2);
    });

    it('keeps a centred loader out of offCentre and honours a custom loaderClass', () => {
        const centred = { frames: [frame(0, [1, 690, 420, 60, 60, 'div.page-loader'])], shifts: [], swaps: [] };
        assert.deepEqual(filmVerdict(centred, vp).offCentre, []);
        const custom = { frames: [frame(0, [1, 300, 100, 60, 60, 'div.waiting'])], shifts: [], swaps: [] };
        assert.equal(filmVerdict(custom, vp).offCentre.length, 0);
        assert.equal(filmVerdict(custom, vp, { loaderClass: 'waiting' }).offCentre.length, 1);
    });
});

describe('slugOf and autoBatch', () => {
    it('turns a route into a file-safe name and the root into home', () => {
        assert.equal(slugOf('/cases/981536625/info'), 'cases_981536625_info');
        assert.equal(slugOf('/billing/queues/billing-issues/active?x=1'), 'billing_queues_billing-issues_active_x_1');
        assert.equal(slugOf('/'), 'home');
        assert.equal(slugOf('/' + 'a'.repeat(300)).length, 120);
    });

    it('sizes a judge batch so one wave of 20 reads every route', () => {
        assert.equal(autoBatch(346), 18);
        assert.equal(autoBatch(5), 5);
        assert.equal(autoBatch(2), 5);
        assert.equal(autoBatch(0), 5);
        assert.equal(autoBatch(20), 5);
        assert.equal(autoBatch(101), 6);
        assert.equal(autoBatch(60, 5), 12);
    });
});

describe('writeBatches', () => {
    const row = (route) => ({
        route,
        landed: route,
        settled: true,
        shots: [`${route}.png`],
        errors: [],
        probes: {},
        hover: [{ name: 'hover0', trigger: 't', text: 'x', cut: false, covered: true, box: { x: 1 }, zIndex: '9' }],
    });

    it('sorts by route, splits by size and keeps only the judge fields of a hover', () => {
        const dir = fresh('batches');
        const jsonl = join(dir, 'walk.jsonl');
        writeFileSync(jsonl, ['/c', '/a', '/b'].map((r) => JSON.stringify(row(r))).join('\n') + '\n');
        const files = writeBatches(dir, jsonl, 2);
        assert.deepEqual(files.map((f) => f.slice(-13)), ['batch-01.json', 'batch-02.json']);
        const first = JSON.parse(readFileSync(files[0], 'utf8'));
        assert.deepEqual(first.map((r) => r.route), ['/a', '/b']);
        assert.deepEqual(first[0].hover, [{ name: 'hover0', trigger: 't', text: 'x', cut: false, covered: true }]);
        assert.deepEqual(JSON.parse(readFileSync(files[1], 'utf8')).map((r) => r.route), ['/c']);
    });

    it('reads a jsonl that starts with a byte order mark and regroups probes by theme', () => {
        const dir = fresh('bom');
        const jsonl = join(dir, 'walk.jsonl');
        writeFileSync(jsonl, '﻿' + JSON.stringify({ ...row('/a'), probes: { w: 1 }, probesDark: { d: 1 }, probesNarrow: { n: 1 } }) + '\n');
        const [file] = writeBatches(dir, jsonl, 5);
        assert.deepEqual(JSON.parse(readFileSync(file, 'utf8'))[0].probes, { wide: { w: 1 }, dark: { d: 1 }, narrow: { n: 1 } });
    });
});

describe('originFromFleet', () => {
    it('reads the App origin line, with or without markup and a trailing slash', () => {
        assert.equal(originFromFleet('# Fleet\n- App origin: http://localhost:5173\n'), 'http://localhost:5173');
        assert.equal(originFromFleet('- **App origin:** `http://localhost:3000/`'), 'http://localhost:3000');
    });

    it('falls back to the first URL of the Services line and prefers App origin when both exist', () => {
        const svc = '- Services: http://localhost:8080 (start: npm run dev); http://localhost:9000 (start: npm run api)';
        assert.equal(originFromFleet(svc), 'http://localhost:8080');
        assert.equal(originFromFleet(`${svc}\n- App origin: http://localhost:4000`), 'http://localhost:4000');
    });

    it('returns an empty string when the file names neither', () => {
        assert.equal(originFromFleet('# Fleet\n- Port: 5173\nSome prose with http://localhost:1 in it.'), '');
        assert.equal(originFromFleet(''), '');
    });
});

describe('loadConfig', () => {
    const write = (file, data) => {
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, JSON.stringify(data));
        return file;
    };

    it('looks up an explicit file, then <project>/.claude/walk.json, then the personal config for the folder name', () => {
        const project = fresh('lookup');
        const personal = write(join(CONFIG_HOME, 'walk', `${project.split(/[\\/]/).pop()}.json`), { origin: 'http://personal.test' });
        assert.equal(loadConfig(project).origin, 'http://personal.test');
        assert.equal(loadConfig(project).file, personal);
        write(join(project, '.claude', 'walk.json'), { origin: 'http://local.test' });
        assert.equal(loadConfig(project).origin, 'http://local.test');
        const explicit = write(join(project, 'elsewhere.json'), { origin: 'http://explicit.test' });
        assert.equal(loadConfig(project, explicit).origin, 'http://explicit.test');
        assert.equal(loadConfig(project, explicit).file, explicit);
    });

    it('finds no file in a folder nobody configured and reports an empty origin', () => {
        const cfg = loadConfig(fresh('bare'));
        assert.equal(cfg.file, '');
        assert.equal(cfg.origin, '');
    });

    it('merges the file over the defaults key by key, replaces arrays and lets overrides win', () => {
        const project = fresh('merge');
        write(join(project, '.claude', 'walk.json'), { origin: 'http://file.test/', routes: { perShape: 3 }, signIn: { visit: ['/dev-login'] }, viewports: { wide: [1000, 700] } });
        const cfg = loadConfig(project, '', { origin: 'http://override.test' });
        assert.equal(cfg.origin, 'http://override.test');
        assert.equal(cfg.routes.perShape, 3);
        assert.equal(cfg.routes.maxRoutes, 400);
        assert.deepEqual(cfg.routes.start, ['/']);
        assert.deepEqual(cfg.signIn.visit, ['/dev-login']);
        assert.equal(cfg.signIn.check, '');
        assert.deepEqual(cfg.viewports, { wide: [1000, 700], narrow: [1024, 768] });
        assert.equal(loadConfig(project).origin, 'http://file.test');
    });

    it('takes the origin from FLEET.md when no config names one', () => {
        const project = fresh('fleet');
        writeFileSync(join(project, 'FLEET.md'), '- App origin: http://localhost:6001/\n');
        assert.equal(loadConfig(project).origin, 'http://localhost:6001');
    });

    it('resolves relative probe paths against the project and keeps absolute ones', () => {
        const project = fresh('probes');
        const abs = join(root, 'abs-probe.mjs');
        write(join(project, '.claude', 'walk.json'), { probes: ['tools/probe.mjs', abs] });
        assert.deepEqual(loadConfig(project).probes, [join(project, 'tools', 'probe.mjs'), abs]);
        const noFile = fresh('probes-none');
        assert.deepEqual(loadConfig(noFile, '', { probes: ['p.mjs'] }).probes, [join(noFile, 'p.mjs')]);
    });
});

describe('shapeOf', () => {
    it('collapses numeric, uuid, hex and long mixed ids and keeps words', () => {
        assert.equal(shapeOf('/cases/981536625/info'), '/cases/:id/info');
        assert.equal(shapeOf('/users/123e4567-e89b-12d3-a456-426614174000'), '/users/:id');
        assert.equal(shapeOf('/files/deadbeef0123'), '/files/:id');
        assert.equal(shapeOf('/docs/abc123def456ghi789'), '/docs/:id');
        assert.equal(shapeOf('/b/123?tab=1#x'), '/b/:id');
        assert.equal(shapeOf('/billing/queues/billing-issues/active'), '/billing/queues/billing-issues/active');
        assert.equal(shapeOf('/settings/very-long-descriptive-page-name'), '/settings/very-long-descriptive-page-name');
        assert.equal(shapeOf('/'), '/');
    });
});

describe('isLocalOrigin', () => {
    it('accepts dev hosts only', () => {
        for (const o of ['http://localhost:5173', 'http://127.0.0.1:3000', 'http://[::1]:8080', 'http://app.localhost:5173', 'http://shop.test']) assert.equal(isLocalOrigin(o), true, o);
        for (const o of ['http://example.com', 'https://staging.example.com', 'http://localhost.example.com', 'http://127.0.0.1.example.com', 'not a url', '']) assert.equal(isLocalOrigin(o), false, o);
    });
});

describe('unsafeRegex', () => {
    it('blocks labels that send, write or delete, and passes the ones that only look', () => {
        const re = unsafeRegex();
        for (const label of ['Delete row', 'Send SMS', 'Save', 'Log out', 'Call the office']) assert.equal(re.test(label), true, label);
        for (const label of ['Filters', 'Columns', 'Add filter', 'Overview', 'New thing']) assert.equal(re.test(label), false, label);
    });

    it('adds the config words, matched literally', () => {
        assert.equal(unsafeRegex().test('Frobnicate'), false);
        assert.equal(unsafeRegex(['frobnicate']).test('Frobnicate'), true);
        assert.equal(unsafeRegex(['a.b']).test('axb'), false);
        assert.equal(unsafeRegex(['a.b']).test('a.b'), true);
    });
});

describe('landedElsewhere', () => {
    it('ignores query, hash, a trailing slash and a deeper path of the same route', () => {
        for (const [route, landed] of [['/a', '/a'], ['/a', '/a/'], ['/a', '/a?x=1'], ['/a', '/a#top'], ['/a', '/a/sub'], ['/', '/']]) assert.equal(landedElsewhere(route, landed), false, `${route} -> ${landed}`);
    });

    it('flags a redirect to another page, including a sibling that shares a prefix', () => {
        for (const [route, landed] of [['/a', '/login'], ['/a', '/ab'], ['/cases/1', '/cases'], ['/cases/1', '/cases/2'], ['/', '/home']]) assert.equal(landedElsewhere(route, landed), true, `${route} -> ${landed}`);
    });
});

// Browser cases.
const loadPlaywright = () => {
    if (!process.env.WALK_PLAYWRIGHT) return null;
    try {
        return createRequire(join(process.env.WALK_PLAYWRIGHT, 'package.json'))('playwright');
    } catch {
        return null;
    }
};
const pw = loadPlaywright();
const skipLive = pw ? false : 'Playwright not loadable: set WALK_PLAYWRIGHT to a folder whose node_modules hold it';

const launchBrowser = () => {
    let exe = '';
    try {
        if (!existsSync(pw.chromium.executablePath())) exe = installedChromium();
    } catch {
        exe = installedChromium();
    }
    return pw.chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
};

describe('probePage and friends in a real page', { skip: skipLive }, () => {
    let browser;
    const open = async (html) => {
        const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
        await page.setContent(html);
        return page;
    };
    const base = (body) => `<!doctype html><html><body style="margin:0;font:14px sans-serif"><main style="padding:8px">${body}</main></body></html>`;
    const opts = { pageSelector: 'main', iconClass: 'material-(symbols|icons)', kitClasses: ['kit-btn'] };

    it('launches', async () => {
        browser = await launchBrowser();
    });
    after(async () => browser?.close());

    it('finds uneven gaps between stacked blocks', async () => {
        const block = (gap) => `<div style="height:40px;margin-top:${gap}px;background:#ddd">block</div>`;
        const page = await open(base(`<section id="stack">${block(0)}${block(8)}${block(8)}${block(24)}</section>`));
        const out = await page.evaluate(probePage, opts);
        assert.deepEqual(out.unevenGaps.map((g) => g.gaps), [[8, 8, 24]]);
        await page.close();
    });

    it('does not flag evenly spaced blocks', async () => {
        const block = '<div style="height:40px;margin-top:8px;background:#ddd">block</div>';
        const page = await open(base(`<section>${block}${block}${block}${block}</section>`));
        assert.deepEqual((await page.evaluate(probePage, opts)).unevenGaps, []);
        await page.close();
    });

    it('finds the same button label twice', async () => {
        const page = await open(base('<div><button>Save Draft</button> <button>Save Draft</button> <button>Other One</button></div>'));
        assert.deepEqual((await page.evaluate(probePage, opts)).duplicates, [{ text: 'Save Draft', n: 2 }]);
        await page.close();
    });

    it('finds text cut off with no ellipsis, and leaves an ellipsis alone', async () => {
        const page = await open(
            base(
                '<div id="cut" style="width:60px;overflow:hidden;white-space:nowrap">A long sentence that does not fit</div>' +
                    '<div id="dots" style="width:60px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">Another long sentence that does not fit</div>',
            ),
        );
        const out = await page.evaluate(probePage, opts);
        assert.equal(out.clipped.length, 1);
        assert.equal(out.clipped[0].axis, 'x');
        assert.match(out.clipped[0].el, /A long sentence/);
        await page.close();
    });

    it('reports a button drawn without the kit class and not one that has it', async () => {
        const page = await open(base('<div><button>Plain</button> <button class="kit-btn">Kit</button> <div class="kit-btn"><button>Wrapped</button></div></div>'));
        const { handmade } = await page.evaluate(probePage, opts);
        assert.equal(handmade.length, 1);
        assert.match(handmade[0], /Plain/);
        const without = await page.evaluate(probePage, { ...opts, kitClasses: [] });
        assert.equal(without.handmade, undefined);
        await page.close();
    });

    it('finds placeholder text that leaked into the page', async () => {
        const page = await open(base('<p>Total: undefined</p><p>All fine here</p>'));
        const { badText } = await page.evaluate(probePage, opts);
        assert.equal(badText.length, 1);
        assert.equal(badText[0].match, 'undefined');
        await page.close();
    });

    it('finds table rows of unequal height', async () => {
        const rows = '<tr><td>a</td></tr><tr><td style="height:60px">b</td></tr><tr><td>c</td></tr>';
        const page = await open(base(`<table><tbody>${rows}</tbody></table>`));
        const { rowDrift } = await page.evaluate(probePage, opts);
        assert.equal(rowDrift.length, 1);
        assert.ok(rowDrift[0].heights.length >= 2);
        await page.close();
    });

    it('reports a floating layer cut by the window, only when it was not there before the mark', async () => {
        const layer = '<div class="popover" style="position:fixed;left:-30px;top:50px;width:100px;height:40px;z-index:10;background:#eee">tip</div>';
        const page = await open(base('<p>x</p>' + layer));
        const found = await page.evaluate(probeFloating, false);
        assert.equal(found.length, 1);
        assert.equal(found[0].cut, true);
        await page.evaluate(probeFloating, true);
        assert.deepEqual(await page.evaluate(probeFloating, false), []);
        await page.close();
    });

    it('records a skeleton in film frames and a transition in the motion list', async () => {
        const page = await open(base('<div class="x-skeleton" style="width:100px;height:20px;transition:width 1s">s</div>'));
        await page.evaluate(motionRecorder);
        await page.evaluate(filmRecorder, { sk: '.x-skeleton', page: 'main' });
        await page.evaluate(() => (document.querySelector('.x-skeleton').style.width = '300px'));
        await page.waitForTimeout(300);
        const film = await page.evaluate(() => {
            window.__walkFilm.ended = true;
            return { frames: window.__walkFilm.frames.length, sk: window.__walkFilm.frames[0].sk.length };
        });
        assert.ok(film.frames >= 2);
        assert.equal(film.sk, 1);
        const motion = await page.evaluate(() => window.__walkMotion);
        assert.deepEqual(motionVerdict(motion).layout, [{ what: 'width on div.x-skeleton', n: 1 }]);
        await page.close();
    });
});

// A small three-page site on a free port; the walk must never press the delete button.
const PAGES = {
    '/': `<main><h1>Home</h1><nav><a href="/a">Go to A</a></nav>
<div><button id="del" onclick="fetch('/hit-delete', { method: 'POST' })">Delete everything</button>
<button id="add" onclick="openDialog()">Add item</button>
<button id="idle">New thing</button>
<button role="tab" aria-selected="false" onclick="fetch('/tab-save', { method: 'POST' })">Overview</button>
<a href="/logout">Sign out</a> <a href="/records/7/delete">Remove record</a></div>
<script>
const closeDialog = () => document.getElementById('dlg')?.remove();
const openDialog = () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="dlg" role="dialog" style="position:fixed;top:120px;left:300px;width:320px;height:180px;background:#fff;border:1px solid #888;z-index:10"><button aria-label="Close" onclick="closeDialog()">x</button><p>Dialog body</p></div>');
};
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDialog(); });
</script></main>`,
    '/a': '<main><h1>Page A</h1><a href="/">Home</a> <a href="/b/123">One</a> <a href="/b/456">Two</a></main>',
    '/b/123': '<main><h1>Record 123</h1><a href="/a">Back</a></main>',
    '/b/456': '<main><h1>Record 456</h1><a href="/a">Back</a></main>',
};

const startSite = async () => {
    const hits = [];
    const server = createServer((req, res) => {
        if (req.method === 'POST' || /logout|delete/.test(req.url)) {
            hits.push(req.url);
            res.end('ok');
            return;
        }
        const html = PAGES[req.url.split('?')[0]];
        res.writeHead(html ? 200 : 404, { 'content-type': 'text/html' });
        res.end(html ? `<!doctype html><html><head><title>t</title></head><body>${html}</body></html>` : 'not found');
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    return { server, hits, origin: `http://127.0.0.1:${server.address().port}` };
};

const runWalk = (argv, ms = 150000) =>
    new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [WALK, ...argv], { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`TIMED OUT walk.mjs after ${ms / 1000}s\n${out}\n${err}`));
        }, ms);
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, out, err });
        });
    });

describe('walk.mjs refusals (no browser needed)', () => {
    it('exits 2 for a remote origin without --allow-remote', async () => {
        const r = await runWalk(['run', join(fresh('remote'), 'out'), '--project', fresh('project'), '--origin', 'http://example.com'], 30000);
        assert.equal(r.code, 2);
        assert.match(r.err, /not a local dev host/);
    });

    it('exits 2 when no origin is known and 2 for an unknown command', async () => {
        const project = fresh('noorigin');
        assert.equal((await runWalk(['run', join(project, 'out'), '--project', project], 30000)).code, 2);
        assert.equal((await runWalk(['frob', '--project', project, '--origin', 'http://127.0.0.1:1'], 30000)).code, 2);
    });

    it('exits 2 when the out folder already holds a run, and leaves that run untouched', async () => {
        const site = await startSite();
        try {
            const out = fresh('taken');
            writeFileSync(join(out, 'walk.jsonl'), '{"route":"/"}\n');
            const r = await runWalk(['run', out, '--project', fresh('project'), '--origin', site.origin], 30000);
            assert.equal(r.code, 2);
            assert.match(r.err, /is not empty/);
            assert.equal(readFileSync(join(out, 'walk.jsonl'), 'utf8'), '{"route":"/"}\n');
            const other = fresh('someones');
            writeFileSync(join(other, 'notes.txt'), 'keep');
            const r2 = await runWalk(['run', other, '--project', fresh('project2'), '--origin', site.origin], 30000);
            assert.equal(r2.code, 2);
            assert.equal(readFileSync(join(other, 'notes.txt'), 'utf8'), 'keep');
        } finally {
            site.server.close();
        }
    });

    it('prints the resolved config for the config command', async () => {
        const r = await runWalk(['config', '--project', fresh('printed'), '--origin', 'http://127.0.0.1:1'], 30000);
        assert.equal(r.code, 0);
        assert.equal(JSON.parse(r.out).origin, 'http://127.0.0.1:1');
    });
});

describe('walk.mjs end to end', { skip: skipLive }, () => {
    it('crawls three pages, keeps one record per shape, never presses the delete button and flags the dead control', { timeout: 170000 }, async () => {
        const site = await startSite();
        try {
            const out = join(fresh('e2e'), 'out');
            const project = fresh('project');
            const r = await runWalk(['run', out, '--project', project, '--origin', site.origin, '--workers', '2', '--no-hover', '--max-minutes', '3']);
            assert.equal(r.code, 0, `${r.out}\n${r.err}`);

            const rows = readFileSync(join(out, 'walk.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
            const routes = rows.map((x) => x.route);
            assert.ok(routes.includes('/'), routes.join());
            assert.ok(routes.includes('/a'), routes.join());
            assert.equal(routes.filter((x) => x.startsWith('/b/')).length, 1, routes.join());
            assert.equal(rows.length, 3);

            const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
            assert.equal(summary.routes, 3);
            assert.ok(summary.batches >= 1);

            assert.deepEqual(site.hits, [], 'the walk pressed a delete button');

            const home = rows.find((x) => x.route === '/');
            assert.equal(home.error, undefined);
            assert.ok(home.clicks.every((c) => !/delete/i.test(c.label)), 'a Delete click was recorded');
            const idle = home.clicks.find((c) => c.label.startsWith('New thing'));
            assert.ok(idle, JSON.stringify(home.clicks.map((c) => c.label)));
            assert.equal(idle.dead, true);
            const add = home.clicks.find((c) => c.label.startsWith('Add item'));
            assert.ok(add, JSON.stringify(home.clicks.map((c) => c.label)));
            assert.ok(add.dialog, 'the dialog was not seen');
            assert.equal(add.dialog.noClose, false);
            const tab = home.clicks.find((c) => c.kind === 'tab');
            assert.ok(tab, 'no tab click');
            // The label passed the unsafe list; the network guard is what stopped its write.
            assert.ok((tab.blocked || []).some((b) => b.startsWith("POST ") && b.includes("/tab-save")), JSON.stringify(tab));

            const shots = rows.flatMap((x) => x.shots);
            assert.ok(shots.length >= 9, `${shots.length} shots`);
            for (const s of shots) assert.equal(readFileSync(s).subarray(1, 4).toString(), 'PNG', s);
            assert.ok(existsSync(join(out, 'batch-01.json')));

            const again = await runWalk(['run', out, '--project', project, '--origin', site.origin], 30000);
            assert.equal(again.code, 2);
        } finally {
            site.server.close();
        }
    });
});

describe('writeBatches by picture count', () => {
    it('starts a new batch before a judge would read more than maxShots pictures', () => {
        const d = mkdtempSync(join(tmpdir(), 'walk-shots-'));
        const jsonl = join(d, 'walk.jsonl');
        const row = (route, n) => JSON.stringify({ route, shots: Array.from({ length: n }, (_, i) => `${route}.${i}.png`), errors: [] });
        writeFileSync(jsonl, [row('/a', 90), row('/b', 90), row('/c', 10), row('/d', 10)].join('\n') + '\n');
        const files = writeBatches(d, jsonl, 20, 150);
        assert.deepEqual(files.map((f) => JSON.parse(readFileSync(f, 'utf8')).map((r) => r.route)), [['/a'], ['/b', '/c', '/d']]);
        rmSync(d, { recursive: true, force: true });
    });
});

describe('routeKey and the shapes of real URLs', () => {
    it('reads hash routes, drops a base path, a trailing slash and index.html', () => {
        assert.equal(routeKey('/#/users?x=1'), '/users');
        assert.equal(routeKey('/app/x/', '/app'), '/x');
        assert.equal(routeKey('/a/index.html'), '/a');
        assert.equal(landedElsewhere('/x', '/app/x', '/app'), false);
        assert.equal(landedElsewhere('/', '/home'), true);
    });
    it('keeps hyphenated slugs with digits as pages and collapses ids', () => {
        assert.equal(shapeOf('/docs/oauth2-authentication'), '/docs/oauth2-authentication');
        assert.equal(shapeOf('/u/550e8400-e29b-41d4-a716-446655440000'), '/u/:id');
        assert.equal(shapeOf('/cases/981536625/info'), '/cases/:id/info');
    });
    it('never loads a crawled URL whose segment names an action, and leaves look-alike words alone', () => {
        for (const p of ['/records/12/delete', '/logout', '/sign-out', '/orders/5/cancel', '/invoices/3/pay', '/download/12']) assert.ok(ACTION_SEGMENT.test(p), p);
        for (const p of ['/authors', '/deleted/items', '/payments', '/docs/authentication']) assert.ok(!ACTION_SEGMENT.test(p), p);
        assert.ok(VIEW_SKIP.test('/login') && !VIEW_SKIP.test('/authors'));
        assert.ok(unsafeRegex().test('Add to cart') && !unsafeRegex().test('Claims'));
    });
});
