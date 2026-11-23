#!/usr/bin/env node
// Parallel visual walk of a running web app: N headless Chromium windows share one sign-in and walk every route.
//   node walk.mjs run <outDir> [--project <dir>] [--config <file>] [--origin <url>] [--workers 6] [--filter <substr> | --routes /a,/b]
//        [--limit <n>] [--quick] [--film] [--hover] [--clicks] [--no-hover] [--no-clicks] [--batch <n>] [--max-minutes 40] [--allow-remote]
//   node walk.mjs login [--project <dir>]   a visible window opens; the person signs in by hand; the session is saved
//   node walk.mjs batches <outDir>          rebuilds batch-NN.json and summary.json from a walk.jsonl (a cut-short run)
//   node walk.mjs config [--project <dir>]  prints the resolved config
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACTION_SEGMENT, CONFIG_HOME, VIEW_SKIP, findPlaywright, installedChromium, isLocalOrigin, landedElsewhere, loadConfig, routeKey, shapeOf, unsafeRegex } from './config.mjs';
import { filmRecorder, filmVerdict, motionRecorder, motionVerdict } from './film.mjs';
import { autoBatch, probeDialog, probeFloating, probePage, slugOf, writeBatches } from './probes.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
    const i = args.indexOf(name);
    return i >= 0 ? (args.splice(i, 2)[1] ?? '') : dflt;
};
const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 && !!args.splice(i, 1);
};
const USAGE = 'usage: node walk.mjs run <outDir> [--project <dir>] [--workers 6] [--filter <s> | --routes /a,/b] [--quick] [--film] ... | login | batches <outDir> | config';
const num = (name, dflt, min) => {
    const v = Number(opt(name, String(dflt)));
    if (!Number.isInteger(v) || v < min) {
        console.error(`walk: ${name} takes a whole number >= ${min}.`);
        process.exit(2);
    }
    return v;
};
const project = resolve(opt('--project', process.cwd()));
const originArg = opt('--origin', '');
const cfg = loadConfig(project, opt('--config', ''), originArg ? { origin: originArg } : {});
const workers = num('--workers', 6, 1);
const filter = opt('--filter', '');
const only = opt('--routes', '').split(',').map((s) => s.trim()).filter(Boolean);
const limit = num('--limit', 0, 0);
const maxMinutes = Math.min(num('--max-minutes', 40, 1), 30000);
const batchArg = num('--batch', 0, 0);
// --quick is the light shot and probes; a detector that needs a film, hovers or clicks asks for them by name.
const quick = flag('--quick');
const film = flag('--film');
const hover = quick ? flag('--hover') : !flag('--no-hover');
const clicks = quick ? flag('--clicks') : !flag('--no-clicks');
const allowRemote = flag('--allow-remote');
const [cmd, outArg] = args;
const ORIGIN = cfg.origin;
let HOST = '';
let BASE = '';
try {
    HOST = ORIGIN && new URL(ORIGIN).origin;
    BASE = ORIGIN && new URL(ORIGIN).pathname.replace(/\/+$/, '');
} catch {
    console.error(`walk: ${ORIGIN} is not a URL.`);
    process.exit(2);
}
const WIDE = { width: cfg.viewports.wide[0], height: cfg.viewports.wide[1] };
const NARROW = { width: cfg.viewports.narrow[0], height: cfg.viewports.narrow[1] };
// Two projects can share a folder name: the saved session is keyed by the full path too.
const STATE_HOME = join(CONFIG_HOME, 'walk', 'state', `${basename(project)}-${createHash('sha1').update(project.toLowerCase()).digest('hex').slice(0, 8)}.json`);
const savedState = cfg.signIn.state ? resolve(project, cfg.signIn.state) : STATE_HOME;

function finish(outDir, extra = {}) {
    const jsonl = join(outDir, 'walk.jsonl');
    const summaryFile = join(outDir, 'summary.json');
    const before = existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, 'utf8')) : {};
    // Batch files of an earlier split would send a judge the same routes twice.
    for (const f of readdirSync(outDir)) if (/^batch-\d+\.json$/.test(f)) rmSync(join(outDir, f), { force: true });
    const rows = existsSync(jsonl) ? readFileSync(jsonl, 'utf8').replace(/^﻿/, '').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const batch = batchArg || autoBatch(rows.length);
    const batches = rows.length ? writeBatches(outDir, jsonl, batch) : [];
    const summary = { ...before, routes: rows.length, shot: rows.filter((r) => !r.error && r.shots?.length).length, errors: rows.filter((r) => r.error).length, batch, batches: batches.length, ...extra };
    writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
    return summary;
}

if (cmd === 'config') {
    console.log(JSON.stringify({ ...cfg, savedState, savedStateExists: existsSync(savedState) }, null, 2));
    process.exit(0);
}
if (cmd === 'batches') {
    if (!outArg || !existsSync(join(resolve(outArg), 'walk.jsonl'))) {
        console.error('walk: batches needs a folder holding walk.jsonl.');
        process.exit(2);
    }
    const s = finish(resolve(outArg), { rebuilt: true });
    console.log(`walk: ${s.routes} routes, ${s.batches} judge batches of ${s.batch} (summary.json).`);
    process.exit(0);
}
if (!ORIGIN) {
    console.error('walk: no app origin. Pass --origin, set "origin" in .claude/walk.json, or write "- App origin: <url>" in FLEET.md.');
    process.exit(2);
}
if (!allowRemote && !isLocalOrigin(ORIGIN)) {
    console.error(`walk: ${ORIGIN} is not a local dev host. A walk signs in and clicks; pass --allow-remote only for a test environment the person named.`);
    process.exit(2);
}
if (cmd !== 'run' && cmd !== 'login') {
    console.error(USAGE);
    process.exit(2);
}
const badRoute = only.find((r) => !r.startsWith('/') || r.startsWith('//'));
if (badRoute) {
    console.error(`walk: a route starts with one "/" and stays on the app (${badRoute}).`);
    process.exit(2);
}

const ev = (page, fn, arg) => page.evaluate(fn, arg);
// The page box: the first selector of the config list that matches, so "main, #app, body" never picks body first.
const pickPage = (list) => {
    for (const s of list.split(/,(?![^(]*\))/)) {
        try {
            if (document.querySelector(s.trim())) return s.trim();
        } catch {
            /* an invalid selector in the config is skipped */
        }
    }
    return 'body';
};
const landedOf = (page) => ev(page, () => location.pathname + location.search + (location.hash.startsWith('#/') ? location.hash : ''));
const onSignInScreen = (page) =>
    ev(
        page,
        ({ sel, base }) => {
            if (sel) return !!document.querySelector(sel);
            const pw = [...document.querySelectorAll('input[type="password"]')].some((i) => i.getBoundingClientRect().width > 0);
            const path = (location.hash.startsWith('#/') ? location.hash.slice(1) : location.pathname).slice(location.hash.startsWith('#/') ? 0 : base.length);
            return pw || /(^|\/)(log[-_]?in|sign[-_]?in)(\/|$)|^\/auth(\/|$)/i.test(path);
        },
        { sel: cfg.signIn.screen, base: BASE },
    ).catch(() => false);
const signedInOnce = async (page) => {
    if (page.isClosed()) return false;
    if (cfg.signIn.check) return !!(await page.evaluate(`(async () => { try { return !!(${cfg.signIn.check}); } catch { return false; } })()`).catch(() => false));
    return page.url().startsWith(HOST) && (await ev(page, () => document.readyState !== 'loading').catch(() => false)) && !(await onSignInScreen(page));
};
// A sign-in form can paint a moment after the first check: two calm reads 1.5 s apart, not one.
const signedIn = async (page) => (await signedInOnce(page)) && (await page.waitForTimeout(1500), await signedInOnce(page));

async function launch(headed) {
    const pw = findPlaywright(project);
    if (!pw) {
        console.error(`walk: Playwright not found in ${project} or one folder down. Install it outside the project: npm i --prefix "${join(CONFIG_HOME, 'walk-deps')}" playwright`);
        process.exit(1);
    }
    let exe = '';
    try {
        if (!existsSync(pw.chromium.executablePath())) exe = installedChromium();
    } catch {
        exe = installedChromium();
    }
    return pw.chromium.launch({ headless: !headed, ...(exe ? { executablePath: exe } : {}) });
}
// Service workers are blocked: a request a worker makes is invisible to the click guard.
const context = (browser, extra = {}) => browser.newContext({ viewport: WIDE, ignoreHTTPSErrors: true, serviceWorkers: 'block', ...extra });

try {
    await fetch(ORIGIN, { signal: AbortSignal.timeout(15000) });
} catch (e) {
    // A self-signed dev certificate still means the server answers.
    if (!/certificate|self.signed|CERT_/i.test(String(e.cause?.code || e.cause?.message || ''))) {
        console.error(`walk: nothing answers on ${ORIGIN}. Start the project's dev server (or ask whoever owns it); never a second copy on another port.`);
        process.exit(1);
    }
}

if (cmd === 'login') {
    const browser = await launch(true);
    const page = await (await context(browser)).newPage();
    await page.goto(ORIGIN + (cfg.signIn.visit[0] || '/'), { waitUntil: 'domcontentloaded' });
    console.log('walk: sign in in the window that opened; it closes by itself once signed in (10 min limit).');
    const startUrl = page.url();
    // Saved only after the sign-in screen was seen and then left, so a slow first paint is never saved as a session.
    let sawSignIn = !!cfg.signIn.check && !(await signedInOnce(page));
    for (let i = 0; i < 300 && !page.isClosed(); i++) {
        await page.waitForTimeout(2000);
        // A passwordless or SSO sign-in shows no password field: leaving the host or the start URL counts as seeing it.
        if (!sawSignIn) sawSignIn = (await onSignInScreen(page)) || !page.url().startsWith(HOST) || page.url() !== startUrl;
        else if (await signedIn(page)) {
            mkdirSync(dirname(savedState), { recursive: true });
            const tmp = `${savedState}.${process.pid}.tmp`;
            await page.context().storageState({ path: tmp, indexedDB: true });
            if (existsSync(savedState)) copyFileSync(savedState, `${savedState}.bak`);
            renameSync(tmp, savedState);
            console.log(`walk: signed in; session saved to ${savedState}`);
            await browser.close();
            process.exit(0);
        }
    }
    console.error(sawSignIn ? 'walk: no sign-in within 10 minutes; nothing saved.' : 'walk: no sign-in screen appeared, so there is nothing to save; set signIn.screen or signIn.check in the config.');
    await browser.close();
    process.exit(1);
}

const outDir = outArg && resolve(outArg);
if (!outDir) {
    console.error(USAGE);
    process.exit(2);
}
mkdirSync(outDir, { recursive: true });
// A folder with files in it is someone's evidence (an earlier run, a project, the Desktop): a run takes a new one.
if (readdirSync(outDir).length) {
    console.error(`walk: ${outDir} is not empty. Give each run a new folder (diff.mjs compares two).`);
    process.exit(2);
}
const STATE = join(outDir, 'login.json');
const JSONL = join(outDir, 'walk.jsonl');
writeFileSync(JSONL, '', { flag: 'wx' });
const started = Date.now();
// A wedged call has no timeout of its own: the walk stops loudly, with batches of what it finished.
setTimeout(() => {
    finish(outDir, { partial: true, wallMs: Date.now() - started });
    console.error(`walk: hit --max-minutes ${maxMinutes}; batches and summary.json hold the routes finished so far.`);
    process.exit(3);
}, maxMinutes * 60000).unref();

const UNSAFE = unsafeRegex(cfg.unsafe);
const FILE = /\.(pdf|zip|csv|xlsx?|docx?|png|jpe?g|gif|svg|mp4|webm|exe|dmg|apk)$/i;
const extraSkip = cfg.routes.skip ? new RegExp(cfg.routes.skip, 'i') : null;
// Sign-in plumbing is no screen to judge, and a segment naming an action can act when opened, a router view on mount included.
const skipped = (path) => FILE.test(path.split(/[?#]/)[0]) || VIEW_SKIP.test(path) || ACTION_SEGMENT.test(path) || !!extraSkip?.test(path);
const GUARD_ALLOW = cfg.guard.allow ? new RegExp(cfg.guard.allow, 'i') : null;
const custom = [];
for (const p of cfg.probes) {
    const m = await import(pathToFileURL(p).href);
    for (const [name, fn] of Object.entries(m)) if (typeof fn === 'function') custom.push([name, fn]);
}

/** One sign-in for every window: a session saved by `login`, else the config's visit URLs (a dev login), else none. */
async function signIn(browser) {
    const saved = existsSync(savedState);
    const page = await (await context(browser, saved ? { storageState: savedState } : {})).newPage();
    if (saved) {
        await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
        for (let i = 0; i < 10; i++) if (await signedIn(page)) return (await page.context().storageState({ path: STATE, indexedDB: true }), page);
            else await page.waitForTimeout(1000);
        throw new Error(`walk: the saved session in ${savedState} no longer signs in; run "node walk.mjs login" again.`);
    }
    for (const url of cfg.signIn.visit.length ? cfg.signIn.visit : ['/']) {
        await page.goto(ORIGIN + url, { waitUntil: 'domcontentloaded' });
        for (let i = 0; i < 15; i++) if (await signedIn(page)) return (await page.context().storageState({ path: STATE, indexedDB: true }), page);
            else await page.waitForTimeout(1500);
    }
    throw new Error('walk: the app shows a sign-in screen. Run "node walk.mjs login" once and sign in by hand, or set signIn.visit / signIn.check in the config.');
}

/** Same-origin sitemap paths, following one level of a sitemap index. */
async function sitemap(page) {
    const read = (url) =>
        ev(page, async (u) => {
            const res = await fetch(u).catch(() => null);
            if (!res?.ok || !/xml/.test(res.headers.get('content-type') || '')) return { index: false, locs: [] };
            const text = await res.text();
            return { index: /<sitemapindex/i.test(text), locs: [...text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]) };
        }, url).catch(() => ({ index: false, locs: [] }));
    const top = await read(ORIGIN + '/sitemap.xml');
    let locs = top.locs;
    if (top.index) locs = (await Promise.all(top.locs.slice(0, 10).map((u) => read(u)))).flatMap((r) => r.locs);
    const out = [];
    for (const u of locs) {
        try {
            const url = new URL(u);
            if (url.origin === HOST && (url.pathname + '/').startsWith(BASE + '/')) out.push(url.pathname.slice(BASE.length) + url.search || '/');
        } catch {
            /* a malformed loc is skipped */
        }
    }
    return out;
}

/** Routes from the app's own router (Vue), else the sitemap, else a crawl of links from the start pages. */
async function harvest(page) {
    const src = cfg.routes.source;
    if (src === 'auto' || src === 'vue-router') {
        const r = await ev(page, (skip) => {
            const app = document.querySelector('#app')?.__vue_app__ || [...document.querySelectorAll('body > *')].find((e) => e.__vue_app__)?.__vue_app__;
            const router = app?.config.globalProperties.$router;
            if (!router) return null;
            const re = new RegExp(skip, 'i');
            const all = router.getRoutes().filter((x) => x.path.startsWith('/') && !x.redirect && x.components && !re.test(x.path));
            // A parent and its '' child share one path: walk it once.
            const paths = (keep) => [...new Set(all.filter(keep).map((x) => x.path))];
            return { fixed: paths((x) => !x.path.includes(':')), params: paths((x) => x.path.includes(':')) };
        }, VIEW_SKIP.source).catch(() => null);
        if (r) return { source: 'vue-router', ...r };
        if (src === 'vue-router') throw new Error('walk: routes.source is vue-router but no Vue router was found on the page.');
    }
    if (src === 'auto' || src === 'sitemap') {
        const paths = await sitemap(page);
        if (paths.length) return { source: 'sitemap', fixed: paths, params: [], crawl: true };
    }
    if (src === 'list') return { source: 'list', fixed: [], params: [] };
    return { source: 'crawl', fixed: cfg.routes.start, params: [], crawl: true };
}

/** SPA push (Vue) or a plain load, then three calm ticks with no visible busy element in the page box and no route transition. */
async function open(page, route) {
    if (nav === 'push')
        // A guard awaiting a dead API never resolves the push: the settle loop below decides, not the promise.
        await Promise.race([
            ev(page, (p) => (document.querySelector('#app')?.__vue_app__ || [...document.querySelectorAll('body > *')].find((e) => e.__vue_app__)?.__vue_app__).config.globalProperties.$router.push(p).catch(() => {}), route),
            page.waitForTimeout(10000),
        ]);
    else await page.goto(ORIGIN + route, { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + 30000;
    let calm = 0;
    while (calm < 3 && Date.now() < deadline) {
        await page.waitForTimeout(600);
        const busy = await ev(page, ({ list, busySel }) => {
            let box = null;
            for (const s of list.split(/,(?![^(]*\))/)) {
                try {
                    if ((box = document.querySelector(s.trim()))) break;
                } catch {
                    /* an invalid selector in the config is skipped */
                }
            }
            const shown = (el) => {
                const r = el.getBoundingClientRect();
                const s = getComputedStyle(el);
                return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
            };
            let spinning = false;
            try {
                // Busy inside the page box, or a loader covering half the window from anywhere (a splash or a portal).
                const big = (el) => {
                    const r = el.getBoundingClientRect();
                    return r.width * r.height >= innerWidth * innerHeight * 0.5;
                };
                spinning = (!!box && [...box.querySelectorAll(busySel)].some(shown)) || [...document.querySelectorAll(busySel)].some((el) => shown(el) && big(el));
            } catch {
                /* an invalid busy selector counts as nothing busy */
            }
            // A route transition still leaving paints two pages in one shot.
            return !box || !!document.querySelector('[class*="-leave-active"], [class*="-enter-active"]') || spinning;
        }, { list: cfg.pageSelector, busySel: cfg.busySelector }).catch(() => true);
        calm = busy ? 0 : calm + 1;
    }
    return { landed: await landedOf(page), settled: calm >= 3 };
}

async function setTheme(page, dark) {
    if (cfg.dark.media) await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
    await ev(page, ({ c, attr, d }) => {
        // Only a class the walker added is taken off again: a dark-by-default app keeps its own.
        const html = document.documentElement;
        if (c && d && !html.classList.contains(c)) (html.classList.add(c), (window.__walkAddedDark = true));
        if (c && !d && window.__walkAddedDark) (html.classList.remove(c), (window.__walkAddedDark = false));
        // "data-theme=dark": the attribute is set for dark and removed for light.
        if (attr) {
            const [name, value = 'dark'] = attr.split('=');
            if (d) document.documentElement.setAttribute(name, value);
            else document.documentElement.removeAttribute(name);
        }
    }, { c: cfg.dark.htmlClass, attr: cfg.dark.attr, d: dark });
}

const queue = [];
const seen = new Set();
const shapes = new Map();
const known = new Map();
const slugs = new Map();
let patterns = [];
let crawling = false;
let nav = 'goto';
let firstRoute = true;
let aborted = '';
let fixedViews = new Set();
const requeued = new Set();

/** Queue a page once, within maxRoutes, and in a crawl one page per URL shape; `kept` = a router path or a listed route. */
function enqueue(path, kept = false) {
    // A listed route keeps its query (`/?seed=1` and `/?seed=1&x` are two screens); a crawled one is one page per path.
    const key = routeKey(path) + ((kept || !crawling) && path.includes('?') ? path.slice(path.indexOf('?')).split('#')[0] : '');
    if (seen.has(key) || seen.size >= cfg.routes.maxRoutes || skipped(path)) return;
    if (crawling && !kept) {
        const shape = shapeOf(key);
        if ((shapes.get(shape) || 0) >= cfg.routes.perShape) return;
        shapes.set(shape, (shapes.get(shape) || 0) + 1);
    }
    seen.add(key);
    queue.push(path.includes('#/') ? path : key);
}

// A param learned from /users/42 must not fill /orders/:id: values are keyed by the static segment before the param.
const paramKey = (path, name) => {
    const segs = path.split('/');
    const i = segs.findIndex((s) => new RegExp(`^:${name}(\\(|\\?|$)`).test(s));
    return `${segs[i - 1] || ''}/${name}`;
};

/** Learn param values from any URL seen and queue each record route whose params are all known; in a crawl, queue new pages. */
function learn(urls) {
    for (const url of urls) {
        if (!url || !url.startsWith('/')) continue;
        const path = routeKey(url);
        // `/orders/pending` is a screen of its own, not an id for `/orders/:id`.
        if (!fixedViews.has(path)) for (const p of patterns) {
            const m = path.match(p.re);
            if (m) for (const [k, v] of Object.entries(m.groups || {})) if (v && !/^(new|create|add|edit)$/i.test(v) && !known.has(paramKey(p.path, k))) known.set(paramKey(p.path, k), v);
        }
        if (crawling && (!only.length)) enqueue(url.includes('#/') ? url : path);
    }
    for (const p of patterns) {
        if (p.filled) continue;
        const path = p.path.replace(/:(\w+)(\(([^)]*)\))?\??/g, (_, name, _g, rx) => known.get(paramKey(p.path, name)) ?? (rx && /^[\w|-]+$/.test(rx) ? rx.split('|')[0] : '\0'));
        if (path.includes('\0') || seen.has(path) || only.length || (filter && !path.includes(filter))) continue;
        p.filled = true;
        enqueue(path, true);
    }
}

const links = (page) =>
    ev(page, ({ origin, base }) => {
        const out = [];
        for (const a of document.querySelectorAll('a[href]')) {
            // An <a> inside an SVG has an SVGAnimatedString href: read the attribute.
            let u;
            try {
                u = new URL(a.getAttribute('href'), location.href);
            } catch {
                continue;
            }
            if (u.origin !== origin || u.protocol.indexOf('http') !== 0) continue;
            const p = u.pathname.startsWith(base + '/') || u.pathname === base ? u.pathname.slice(base.length) || '/' : '';
            if (p) out.push(p + u.search + (u.hash.startsWith('#/') ? u.hash : ''));
        }
        return out;
    }, { origin: HOST, base: BASE }).catch(() => []);

/**
 * Blocks every request that could write (anything but GET/HEAD/OPTIONS, unless guard.allow names it) while a click or
 * a row open is in flight: a label list can miss a "Create backup"; the network cannot.
 */
async function guarded(page, act) {
    const blocked = [];
    // A GraphQL read travels by POST too; its body starts with a query, a write with "mutation".
    const graphRead = (req) => {
        try {
            const body = JSON.parse(req.postData() || 'null');
            return [body].flat().every((b) => typeof b?.query === 'string' && !/^\s*mutation\b/.test(b.query));
        } catch {
            return false;
        }
    };
    const handler = (r) => {
        const req = r.request();
        if (/^(GET|HEAD|OPTIONS)$/.test(req.method()) || GUARD_ALLOW?.test(req.url()) || graphRead(req)) return r.fallback();
        blocked.push(`${req.method()} ${req.url().slice(0, 160)}`);
        return r.abort('blockedbyclient');
    };
    // A socket frame cannot be stopped by a route: it is counted so a judge sees that a click spoke to a live channel.
    const onSocket = (ws) => ws.on('framesent', () => blocked.push(`websocket frame sent on ${ws.url().slice(0, 120)} (not blocked)`));
    page.on('websocket', onSocket);
    await page.route('**/*', handler);
    try {
        await act();
    } finally {
        page.off('websocket', onSocket);
        await page.unroute('**/*', handler).catch(() => {});
    }
    return blocked;
}

/** On a list with rows, open the first record by a plain first cell to learn its id; never a row that can call, mail or toggle. */
async function openFirstRow(page, pageSel) {
    const cell = await page.$(`:is(${pageSel}) :is(tbody tr, [role="row"]):not(:has(th)) :is(td, [role="cell"]):first-child`);
    if (!cell) return;
    const safe = await cell.evaluate((c) => {
        const row = c.closest('tr, [role="row"]') || c;
        const live = 'a[href^="tel"], a[href^="mailto"], a[href^="sms"], a[href^="callto"], button, input, select, label, [role="button"], [role="switch"], [role="checkbox"]';
        // A phone number has separators; a bare record id does not. Dates (2024-01-15, 01/15/2024) are not phones.
        const text = row.innerText.replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, ' ');
        return !c.querySelector(live) && !row.querySelector('a[href^="tel"], a[href^="sms"], a[href^="callto"]') && !/(\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]\d{2,4}[\s.-]\d{2,4}/.test(text);
    }).catch(() => false);
    if (!safe) return;
    const before = await landedOf(page);
    lastAction.set(page, `open the first row on ${routeKey(before, BASE)}`);
    await guarded(page, async () => {
        await cell.click({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(1500);
    });
    const after = await landedOf(page);
    if (new URL(page.url()).origin === HOST && routeKey(after, BASE) !== routeKey(before, BASE)) learn([routeKey(after, BASE)]);
}

/** A dev-server reload (another chat's edit) unmounts every window at once: wait for the app to come back signed in. */
async function ready(page) {
    // A dev server restarting (another chat's edit) answers nothing for a while: that is waited out, up to 3 minutes.
    for (let i = 0; i < 36; i++) {
        if (await fetch(ORIGIN, { signal: AbortSignal.timeout(4000) }).then(() => true, (e) => /certificate|self.signed|CERT_/i.test(String(e.cause?.code || e.cause?.message || '')))) break;
        await new Promise((r) => setTimeout(r, 5000));
    }
    for (let i = 0; i < 30; i++) {
        if (await signedIn(page)) return true;
        if (i === 10 || i === 20) await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(500);
    }
    return false;
}

const LAYERS = '[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"], [class*="dropdown"], [class*="popover"], [class*="menu"]';

/**
 * Opens what a person opens without committing anything: tabs, menus, Filters/Columns/Layouts panels, "Add/New" popups
 * outside table rows and forms. Each open layer is shot and probed, then closed with Escape; a layer that will not close
 * sends the window home. A label matching the unsafe list is never pressed, and the network guard blocks any write.
 * Returns false when the window had to leave the route.
 */
async function safeClicks(page, row, shot, pageSel, origin) {
    row.clicks = [];
    const scope = cfg.barSelector ? `${pageSel}, ${cfg.barSelector}` : pageSel;
    const targets = await ev(page, ({ unsafe, scope }) => {
        for (const x of document.querySelectorAll('[data-walk-click]')) x.removeAttribute('data-walk-click');
        const caps = { tab: 6, menu: 4, panel: 3, popup: 3 };
        const re = new RegExp(unsafe, 'i');
        const out = [];
        for (const el of document.querySelectorAll(`:is(${scope}) :is(button, [role="tab"], [role="button"])`)) {
            const r = el.getBoundingClientRect();
            if (r.width <= 4 || r.height <= 4 || r.top < 0 || r.bottom > innerHeight) continue;
            // `form` is set for a button inside a form or tied to one by its form attribute: such a button submits it.
            if (el.closest('tbody, [role="row"], [aria-disabled="true"], form') || el.form || el.disabled || el.getAttribute('aria-selected') === 'true') continue;
            if (el.tagName === 'A' && el.href && new URL(el.href, location.href).origin !== location.origin) continue;
            const named = [el.innerText, el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'), ...(el.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => id && document.getElementById(id)?.textContent)];
            if (named.some((t) => t && re.test(t))) continue;
            const raw = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ');
            // Icon-font ligatures ("add", "more_vert", "tune") lead the visible label: drop them before reading the words.
            const label = raw.replace(/^(?:[a-z]+(?:_[a-z]+)*\s+)+/, '');
            const kind =
                el.getAttribute('role') === 'tab'
                    ? 'tab'
                    : /^(more_vert|more_horiz|⋮|…|\.\.\.)$/.test(raw) || /^more/i.test(el.getAttribute('aria-label') || '') || /^(true|menu|listbox)$/.test(el.getAttribute('aria-haspopup') || '')
                      ? 'menu'
                      : /^(Filters?|Layouts?|Columns?)$/i.test(label)
                        ? 'panel'
                        : /^(Add|New|\+)\b/.test(label)
                          ? 'popup'
                          : '';
            if (!kind || !caps[kind]) continue;
            caps[kind]--;
            const id = kind + out.length;
            el.setAttribute('data-walk-click', id);
            out.push({ kind, id, label: label.slice(0, 40) || raw.slice(0, 40) });
        }
        return out;
    }, { unsafe: UNSAFE.source, scope });
    // Side panels last: closing one reflows the page for a while, and the next click would read that as "opening moved it".
    const order = { menu: 0, popup: 1, tab: 2, panel: 3 };
    targets.sort((a, b) => order[a.kind] - order[b.kind]);
    for (const t of targets) {
        const el = await page.$(`[data-walk-click="${t.id}"]`);
        if (!el) continue;
        lastAction.set(page, `click "${t.label}" on ${row.route}`);
        const before = await landedOf(page);
        await ev(page, probeFloating, true);
        // Where the page's own elements sit before a menu or popup opens; opening one must not move them.
        const pinned = await ev(page, ({ id, scope, layers }) => {
            const skip = document.querySelector(`[data-walk-click="${id}"]`);
            const els = [...document.querySelectorAll(`:is(${scope}) *`)]
                .filter((e) => !skip?.contains(e) && !e.closest('col, colgroup') && e.children.length === 0 && e.getBoundingClientRect().width > 4 && e.getBoundingClientRect().height > 4)
                .slice(0, 30);
            els.forEach((e, i) => e.setAttribute('data-walk-pos', String(i)));
            for (const x of document.querySelectorAll(layers)) x.setAttribute('data-walk-pre', '');
            window.__walkMut = 0;
            window.__walkObs?.disconnect();
            window.__walkObs = new MutationObserver((l) => {
                window.__walkMut += l.filter((m) => !(m.type === 'attributes' && String(m.attributeName).startsWith('data-walk'))).length;
            });
            window.__walkObs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
            window.__walkRes = performance.getEntriesByType('resource').length;
            window.__walkFocus = document.activeElement;
            window.__walkHref = location.href;
            return { cw: document.documentElement.clientWidth, pos: els.map((e) => [Math.round(e.getBoundingClientRect().x), Math.round(e.getBoundingClientRect().y)]) };
        }, { id: t.id, scope, layers: LAYERS });
        let opening = null;
        let dead = false;
        const blocked = await guarded(page, async () => {
            await el.click({ timeout: 1500 }).catch(() => {});
            await page.waitForTimeout(80);
            // A layer that is up 80 ms after the click with nothing animating on it or its parents appeared abruptly.
            opening = await ev(page, ({ kind, layers }) => {
                const pre = [...document.querySelectorAll('[data-walk-pre]')];
                const layer =
                    kind === 'menu' || kind === 'popup'
                        ? [...document.querySelectorAll(layers)].find((x) => {
                              const r = x.getBoundingClientRect();
                              const s = getComputedStyle(x);
                              return r.width > 40 && r.height > 20 && !x.hasAttribute('data-walk-pre') && s.visibility !== 'hidden' && /fixed|absolute/.test(s.position);
                          })
                        : null;
                pre.forEach((x) => x.removeAttribute('data-walk-pre'));
                if (!layer) return null;
                const chain = [layer, layer.parentElement, layer.parentElement?.parentElement].filter(Boolean);
                return { layer: `${layer.tagName.toLowerCase()}.${String(layer.getAttribute('class') || '').split(/\s+/)[0]}`, animated: chain.some((x) => x.getAnimations().length > 0) };
            }, { kind: t.kind, layers: LAYERS }).catch(() => null);
            await page.waitForTimeout(820);
            // A click that changed no node, loaded nothing, moved no focus and opened nothing is a dead control.
            dead = await ev(page, (id) => {
                window.__walkObs?.disconnect();
                const clicked = document.querySelector(`[data-walk-click="${id}"]`);
                const focus = document.activeElement === window.__walkFocus || document.activeElement === clicked;
                return window.__walkMut === 0 && performance.getEntriesByType('resource').length === window.__walkRes && location.href === window.__walkHref && focus;
            }, t.id).catch(() => false);
        });
        if (new URL(page.url()).origin !== HOST) {
            row.clicks.push({ name: null, ...t, error: `left the app for ${new URL(page.url()).origin}` });
            await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' }).catch(() => {});
            return false;
        }
        if ((await ev(page, () => performance.timeOrigin).catch(() => 0)) !== origin) throw new Error('walk: the page reloaded mid-route');
        const name = `click${row.clicks.length}`;
        await shot(name);
        const layers = await ev(page, probeFloating, false);
        const dialog = await ev(page, probeDialog);
        const moved =
            t.kind === 'menu' || t.kind === 'popup'
                ? await ev(page, (p) => {
                      const out = [];
                      for (const e of document.querySelectorAll('[data-walk-pos]')) {
                          const was = p.pos[+e.getAttribute('data-walk-pos')];
                          const r = e.getBoundingClientRect();
                          if (was && (Math.abs(r.x - was[0]) > 2 || Math.abs(r.y - was[1]) > 2) && out.length < 5)
                              out.push({ el: `${e.tagName.toLowerCase()}.${String(e.getAttribute('class') || '').split(/\s+/)[0]}`, dx: Math.round(r.x - was[0]), dy: Math.round(r.y - was[1]) });
                          e.removeAttribute('data-walk-pos');
                      }
                      return { moved: out, widthChange: document.documentElement.clientWidth - p.cw };
                  }, pinned)
                : undefined;
        row.clicks.push({ name, ...t, layers, dialog, opening, moved, dead, blocked: blocked.length ? blocked.slice(0, 5) : undefined, probes: dialog || layers.length ? await ev(page, probePage, probeOpts(pageSel)) : undefined });
        // A side panel is a toggle and its open state outlives the route: press it again rather than trust Escape.
        // Closing can write too (a save-on-close draft): the guard stays on through the re-click, Escape and a settle.
        const closing = await guarded(page, async () => {
            if (t.kind === 'panel') await el.click({ timeout: 1500 }).catch(() => {});
            for (let i = 0; i < 2; i++) await page.keyboard.press('Escape').then(() => page.waitForTimeout(250));
            await page.waitForTimeout(700);
        });
        if (closing.length) row.clicks.at(-1).blocked = [...(row.clicks.at(-1).blocked || []), ...closing].slice(0, 8);
        if (await ev(page, () => !!document.querySelector('[role="dialog"], [aria-modal="true"]'))) {
            await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
            return false;
        }
        if (routeKey(await landedOf(page)) !== routeKey(before)) return false;
    }
    return true;
}

/** Cards or tiles that lift, grow, gain a shadow or blur on hover. */
async function tileHover(page, pageSel) {
    const look = (id) =>
        ev(page, (id) => {
            const el = document.querySelector(`[data-walk-tile="${id}"]`);
            if (!el) return null;
            const s = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return { transform: s.transform, shadow: s.boxShadow, filter: s.filter, w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y) };
        }, id);
    const tiles = await ev(page, ({ pageSel, tileSel }) => {
        for (const x of document.querySelectorAll('[data-walk-tile]')) x.removeAttribute('data-walk-tile');
        return [...document.querySelectorAll(`:is(${pageSel}) :is(${tileSel})`)]
            .filter((el) => {
                const r = el.getBoundingClientRect();
                return r.width >= 120 && r.height >= 60 && r.width <= 720 && r.height <= 520 && r.top >= 0 && r.bottom <= innerHeight && !el.parentElement?.closest(tileSel);
            })
            .slice(0, 5)
            .map((el, i) => (el.setAttribute('data-walk-tile', String(i)), { id: String(i), label: `${el.tagName.toLowerCase()}.${String(el.getAttribute('class') || '').split(/\s+/)[0]}` }));
    }, { pageSel, tileSel: cfg.tileSelector });
    const moved = [];
    for (const t of tiles) {
        const before = await look(t.id);
        const el = await page.$(`[data-walk-tile="${t.id}"]`);
        if (!before || !el) continue;
        await el.hover({ timeout: 1000 }).catch(() => {});
        await page.waitForTimeout(350);
        const after = await look(t.id);
        await page.mouse.move(1, 1);
        if (!after) continue;
        const diff = Object.keys(before).filter((k) => (typeof before[k] === 'number' ? Math.abs(before[k] - after[k]) > 1 : before[k] !== after[k]));
        if (diff.length) moved.push({ tile: t.label, changed: diff, before: Object.fromEntries(diff.map((k) => [k, before[k]])), after: Object.fromEntries(diff.map((k) => [k, after[k]])) });
    }
    return moved;
}

/** Cold-loads the route under the film recorder: three shots on the way (0.7, 1.6, 3.5 s), then waits for skeletons to stop changing. */
async function filmRoute(page, route, shot) {
    // From a blank document: a cold goto keeps the previous page painted until the new one paints.
    await page.goto('about:blank');
    await page.goto(ORIGIN + route, { waitUntil: 'commit' });
    const start = Date.now();
    for (const at of [700, 1600, 3500]) {
        await page.waitForTimeout(Math.max(0, at - (Date.now() - start)));
        await shot(`film-${String(at).padStart(4, '0')}`).catch(() => {});
    }
    let last = '';
    for (let calm = 0; calm < 8 && Date.now() - start < 25000; ) {
        await page.waitForTimeout(250);
        const now = await ev(page, () => (window.__walkFilm?.frames.at(-1)?.sk ?? []).map((s) => s[0]).join(',')).catch(() => '?');
        calm = now === last ? calm + 1 : 0;
        last = now;
    }
    const data = await ev(page, () => {
        const f = window.__walkFilm;
        if (f) f.ended = true;
        return f ?? null;
    }).catch(() => null);
    return data ? filmVerdict(data, WIDE, { loaderClass: cfg.loaderClass }) : { error: 'walk: the film recorder did not run' };
}

const probeOpts = (pageSel) => ({ pageSelector: pageSel, iconClass: cfg.iconClass, kitClasses: cfg.kit.controlClasses });

async function runCustom(page, pageSel) {
    if (!custom.length) return undefined;
    const out = {};
    for (const [name, fn] of custom) out[name] = await ev(page, fn, probeOpts(pageSel)).catch((e) => ({ error: String(e.message).slice(0, 200) }));
    return out;
}

/**
 * One file stem per route, the same in every run so diff.mjs pairs the right shots: a route whose stem could also come
 * from another (an underscore, a capital on a case-blind disk, anything replaced, over 120 characters) gets a hash of itself.
 */
function slugFor(route) {
    const s = slugOf(route);
    return /^\/[a-z0-9/-]*$/.test(route) && route.length <= 120 ? s : `${s}-${createHash('sha1').update(route).digest('hex').slice(0, 6)}`;
}

const lastAction = new WeakMap();

async function walkOne(page, route, retry = true) {
    // The last action before a lost session is what ended it, so a failed wait does not overwrite it.
    if (!(await ready(page))) return { route, slug: slugOf(route), shots: [], error: 'walk: the app did not come back signed in', signedOut: true, ms: 0 };
    lastAction.set(page, `open ${route}`);
    const errors = [];
    const onConsole = (m) => m.type() === 'error' && errors.push('console: ' + m.text().slice(0, 300));
    const onPageError = (e) => errors.push('pageerror: ' + String(e.message).slice(0, 300));
    const onResponse = (r) => r.status() >= 400 && !/\/favicon\.ico(\?|$)/.test(r.url()) && errors.push(`http ${r.status()}: ${r.request().method()} ${r.url().slice(0, 200)}`);
    page.on('console', onConsole);
    page.on('pageerror', onPageError);
    page.on('response', onResponse);
    const slug = slugFor(route);
    const t0 = Date.now();
    const row = { route, slug, shots: [] };
    const shot = async (name, opts = {}) => {
        const path = join(outDir, `${slug}.${name}.png`);
        await page.screenshot({ path, animations: 'disabled', ...opts });
        row.shots.push(path);
    };
    try {
        await page.setViewportSize(WIDE);
        await setTheme(page, false);
        if (film) row.film = await filmRoute(page, route, shot);
        Object.assign(row, await open(page, route));
        row.openMs = Date.now() - t0;
        const origin = await ev(page, () => performance.timeOrigin);
        const pageSel = await ev(page, pickPage, cfg.pageSelector);
        if (new URL(page.url()).origin !== HOST) row.landed = `${page.url().slice(0, 120)} (another host)`;
        else if (await onSignInScreen(page)) row.landed = `${row.landed} (sign-in screen)`;
        if (row.landed.endsWith(')') || landedElsewhere(route, row.landed, BASE)) {
            row.error = `walk: landed on ${row.landed} (redirect, no access, another host or a sign-in screen); no shots taken`;
            if (!row.landed.endsWith(')')) learn([routeKey(row.landed, BASE)]);
            if (row.landed.endsWith('(another host)')) await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' }).catch(() => {});
            row.ms = Date.now() - t0;
            return row;
        }
        await setTheme(page, false);
        await shot('light', { fullPage: !!cfg.fullPage });
        row.probes = await ev(page, probePage, probeOpts(pageSel));
        row.custom = await runCustom(page, pageSel);
        learn(await links(page));
        if (hover) {
            row.hover = [];
            await ev(page, probeFloating, true);
            // The app chrome (sidebar, header) repeats on every route: hover it on the first route only.
            const chrome = firstRoute;
            firstRoute = false;
            const scope = chrome ? 'body' : pageSel;
            await ev(page, ({ s, sel, sym }) => {
                for (const x of document.querySelectorAll('[data-walk-hint]')) x.removeAttribute('data-walk-hint');
                for (const el of document.querySelectorAll(`:is(${s}) :is(${sel})`)) el.setAttribute('data-walk-hint', '');
                if (sym) for (const el of document.querySelectorAll(`:is(${s}) *`)) if (Object.getOwnPropertySymbols(el).some((k) => k.description === sym)) el.setAttribute('data-walk-hint', '');
            }, { s: scope, sel: cfg.hover.hostSelector, sym: cfg.hover.symbol });
            const targets = await page.$$(`:is(${scope}) [data-walk-hint]:visible`);
            row.hintHosts = targets.length;
            for (const el of targets.slice(0, chrome ? 40 : 15)) {
                await el.hover({ timeout: 1000 }).catch(() => {});
                await page.waitForTimeout(cfg.hover.delayMs);
                const floating = await ev(page, probeFloating, false);
                if (floating.length) {
                    const f = floating[0];
                    const name = `hover${row.hover.length}`;
                    const x = Math.max(0, f.box.x - 40);
                    const y = Math.max(0, f.box.y - 40);
                    const clip = { x, y, width: Math.min(WIDE.width - x, f.box.w + 80), height: Math.min(WIDE.height - y, f.box.h + 80) };
                    if (clip.width > 4 && clip.height > 4) await shot(name, { clip });
                    row.hover.push({ name, trigger: await el.evaluate((t) => (t.innerText || t.getAttribute('aria-label') || t.getAttribute('class') || '').toString().trim().slice(0, 60)).catch(() => ''), ...f });
                    await ev(page, probeFloating, true);
                }
                if (row.hover.length >= 8) break;
            }
            await page.mouse.move(1, 1);
            await page.waitForTimeout(200);
            row.tileHover = await tileHover(page, pageSel);
            row.hoverMs = Date.now() - t0 - row.openMs;
        }
        if (!quick) {
            await setTheme(page, true);
            await page.waitForTimeout(350);
            await shot('dark', { fullPage: !!cfg.fullPage });
            row.probesDark = await ev(page, probePage, probeOpts(pageSel));
            await setTheme(page, false);
            await page.setViewportSize(NARROW);
            // Some layouts re-measure on a poll, not on resize: half a second showed the wide layout in a narrow window.
            await page.waitForTimeout(1500);
            await shot('narrow', { fullPage: !!cfg.fullPage });
            row.probesNarrow = await ev(page, probePage, probeOpts(pageSel));
            await page.setViewportSize(WIDE);
            await page.waitForTimeout(500);
        }
        // A dev-server reload mid-route leaves later shots of a fresh, light, still-loading page under this route's name.
        if ((await ev(page, () => performance.timeOrigin)) !== origin) throw new Error('walk: the page reloaded mid-route');
        let stayed = true;
        if (clicks) {
            const c0 = Date.now();
            stayed = await safeClicks(page, row, shot, pageSel, origin);
            row.clickMs = Date.now() - c0;
        }
        if (stayed && patterns.some((p) => !p.filled)) await openFirstRow(page, pageSel);
    } catch (e) {
        row.error = String(e.message).slice(0, 400);
    } finally {
        page.off('console', onConsole);
        page.off('pageerror', onPageError);
        page.off('response', onResponse);
    }
    row.motion = motionVerdict(await ev(page, () => {
        const m = window.__walkMotion || [];
        return m.splice(0, m.length);
    }).catch(() => []));
    row.errors = [...new Set(errors)].slice(0, 20);
    row.ms = Date.now() - t0;
    if (retry && /context was destroyed|__vue_app__|navigation|reloaded mid-route/i.test(row.error || '') && !page.isClosed()) {
        // The first attempt's pictures are of a page that reloaded: they go, so the folder holds only what a row lists.
        for (const s of row.shots) rmSync(s, { force: true });
        return walkOne(page, route, false);
    }
    return row;
}

const browser = await launch(false);
let source = '';
try {
    const first = await signIn(browser);
    const h = await harvest(first);
    await first.context().close();
    source = h.source;
    nav = cfg.nav === 'auto' ? (h.source === 'vue-router' ? 'push' : 'goto') : cfg.nav;
    crawling = !!h.crawl;
    if (h.source === 'vue-router') fixedViews = new Set(h.fixed.map((r) => routeKey(r)));
    const badListed = cfg.routes.list.find((r) => !String(r).startsWith('/') || String(r).startsWith('//'));
    if (badListed) throw new Error(`walk: routes.list entry "${badListed}" must start with one "/"`);
    if (only.length) for (const r of only) (seen.add(routeKey(r)), queue.push(r));
    else {
        for (const r of h.fixed) if (!filter || crawling || r.includes(filter)) enqueue(r, h.source === 'vue-router');
        for (const r of cfg.routes.list) if (!filter || r.includes(filter)) enqueue(r, true);
    }
    patterns = h.params.map((path) => ({ path, re: new RegExp('^' + path.replace(/:(\w+)(\([^)]*\))?\??/g, '(?<$1>[^/]+)') + '/?$') }));
    console.log(`walk: ${queue.length} routes from ${h.source}${crawling ? ' (more as links are found)' : ''}, ${patterns.length} record patterns, ${workers} windows, nav ${nav}`);
    let done = 0;
    let active = 0;
    const cap = limit || Infinity;
    // A route that wedges (an evaluate that never returns) is cut off so its window can be rebuilt.
    const routeMs = (film ? 120 : 75) * 1000 + (clicks ? 45000 : 0);
    const newPage = async () => {
        const ctx = await context(browser, { storageState: STATE });
        await ctx.addInitScript(motionRecorder);
        if (film) await ctx.addInitScript(filmRecorder, { sk: cfg.skeletonSelector, page: cfg.pageSelector.split(/,(?![^(]*\))/)[0].trim() });
        const page = await ctx.newPage();
        await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' }).catch(() => {});
        return page;
    };
    const worker = async () => {
        let page = await newPage();
        // A busy worker may still queue routes it learns, so an empty queue is final only when every worker is idle.
        while (!aborted && done < cap && (queue.length || active)) {
            if (!queue.length) {
                await new Promise((r) => setTimeout(r, 500));
                continue;
            }
            const route = queue.shift();
            const n = ++done;
            active++;
            const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
            try {
                // Crawling toward a --filter: pages that do not match are opened for their links only.
                if (crawling && filter && !route.includes(filter)) {
                    done--;
                    await within(open(page, route).then(async () => learn(await links(page))), 45000).catch(() => {});
                    continue;
                }
                let timer;
                const row = await Promise.race([
                    walkOne(page, route).catch((e) => ({ route, slug: slugOf(route), shots: [], error: String(e.message).slice(0, 400) })),
                    new Promise((r) => (timer = setTimeout(() => r({ route, slug: slugOf(route), shots: [], error: `walk: the route took over ${routeMs / 1000} s and was cut off`, wedged: true }), routeMs))),
                ]);
                clearTimeout(timer);
                // A crashed, closed or wedged window is rebuilt from the shared sign-in; a lost session ends the walk.
                const alive = !page.isClosed() && (await within(ev(page, () => 1).catch(() => 0), 5000));
                if (row.wedged || !alive || row.signedOut) {
                    const what = lastAction.get(page) || route;
                    await within(page.context().close().catch(() => {}), 10000);
                    page = await newPage();
                    if (row.signedOut) {
                        if (await ready(page)) {
                            // Signed in again after a rebuild: the route was lost to the wait, not to the app; walk it once more.
                            if (!requeued.has(route)) requeued.add(route), queue.push(route), (done--), (row.skipRow = true);
                        } else aborted = `the session ended (last action: ${what}); sign in again and re-walk the rest`;
                    }
                }
                if (!row.skipRow) {
                    appendFileSync(JSONL, JSON.stringify(row) + '\n');
                    console.log(`${String(n).padStart(3)} ${row.ms ?? 0}ms ${route}${row.error ? ' ERROR ' + row.error : ''}`);
                }
            } finally {
                active--;
            }
        }
        await page.context().close().catch(() => {});
    };
    const results = await Promise.allSettled(Array.from({ length: workers }, worker));
    const failed = results.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message || r.reason).slice(0, 200));
    const unfilled = patterns.filter((p) => !p.filled).map((p) => p.path);
    const s = finish(outDir, { source, workers, wallMs: Date.now() - started, unfilled, ...(aborted ? { aborted } : {}), ...(failed.length ? { workerErrors: failed } : {}) });
    console.log(`walk: ${s.routes} routes (${s.shot} shot, ${s.errors} with an error), ${Math.round(s.wallMs / 1000)} s; ${s.batches} judge batches; ${unfilled.length} record routes had no link to fill them (summary.json).`);
    if (aborted) console.error(`walk: stopped early: ${aborted}.`);
    if (failed.length) console.error(`walk: ${failed.length} window(s) failed: ${failed[0]}`);
    process.exitCode = aborted || failed.length || s.shot === 0 ? 1 : 0;
} finally {
    await browser.close();
}
