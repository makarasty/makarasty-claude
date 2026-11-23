// Project config for walk.mjs: where the app runs, how to sign in, where routes come from and the few class names
// that differ per project. Looked up in order: --config <file>, <project>/.claude/walk.json,
// <config dir>/makarasty/walk/<project folder name>.json (a project the person may not edit). Every key is optional.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

export const CONFIG_HOME = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'makarasty');

// Anything that dials, sends, writes, deletes, moves money or devices, or ends the session. Matched as a substring
// of the visible label, case-insensitive: a false "unsafe" only skips a click, a missed one can send something.
export const UNSAFE_WORDS = [
    'call', 'dial', 'text', 'sms', 'send', 'email', 'mail', 'delete', 'remove', 'archive', 'restore', 'submit', 'save',
    'apply', 'approve', 'deny', 'reject', 'sign', 'log out', 'logout', 'publish', 'post', 'start', 'resume', 'retry',
    'resend', 'pay', 'charge', 'refund', 'buy', 'purchase', 'checkout', 'ship', 'order', 'import', 'export', 'upload',
    'download', 'sync', 'run', 'merge', 'cancel', 'activate', 'enable', 'disable', 'revoke', 'reset', 'clear', 'confirm',
    'transfer', 'invite', 'share', 'reply', 'book', 'deploy', 'unsubscribe', 'subscribe', 'leave', 'close account', 'drop',
    'purge', 'cart', 'bag', 'wishlist', 'favorite', 'favourite', 'follow', 'friend', 'draft', 'backup', 'token', 'api key',
    'impersonate',
];

// Crawled and listed URLs are plain GETs a server may act on: a segment naming an action is never loaded.
export const ACTION_SEGMENT =
    /(^|[/_-])(log[-_]?out|log[-_]?off|sign[-_]?out|sign[-_]?off|exit|unsubscribe|delete|remove|destroy|cancel|pay|checkout|impersonate|export|download|disconnect|accept|confirm|revoke|activate|deactivate|archive|send|invite|approve|reject|reset|verify|callback|oauth)([/_.?#-]|$)/i;
// Sign-in plumbing, not screens of the app (a router view or a crawled URL alike).
export const VIEW_SKIP = /(^|[/_-])(log[-_]?in|log[-_]?out|sign[-_]?in|sign[-_]?up|sign[-_]?out|register|reset|verify|auth|oauth|callback|404)([/_.?#-]|$)|:pathMatch/i;

export const DEFAULTS = {
    origin: '',
    routes: { source: 'auto', list: [], start: ['/'], skip: '', maxRoutes: 400, perShape: 1 },
    nav: 'auto',
    signIn: { visit: [], state: '', check: '', screen: '' },
    pageSelector: 'main, [role="main"], #app, #root, body',
    barSelector: '',
    busySelector: '[class*="skeleton"], [aria-busy="true"], [class*="spinner"], [data-testid*="loader" i], [data-loader]',
    skeletonSelector: '[class*="skeleton"], [aria-busy="true"], [class*="spinner"], [class*="loader"]',
    loaderClass: 'loader|spinner',
    iconClass: 'material-(symbols|icons)|\\bicon\\b',
    dark: { media: true, htmlClass: 'dark', attr: '' },
    guard: { allow: '' },
    viewports: { wide: [1440, 900], narrow: [1024, 768] },
    hover: { hostSelector: '[data-tooltip], [data-tip], [data-tippy-content], [aria-describedby]', symbol: '', delayMs: 550 },
    fullPage: false,
    tileSelector: '[class*="card"], [class*="tile"]',
    unsafe: [],
    kit: { controlClasses: [] },
    probes: [],
};

const merge = (base, over) => {
    if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], v) : v;
    return out;
};

/** The app origin fleet-init wrote: `- App origin: <url>`, else the first URL of the `- Services:` line. */
export function originFromFleet(text) {
    const app = text.match(/^\s*-\s*\**App origin:?\**:?\s*`?(https?:\/\/[^\s`;,)]+)/im);
    if (app) return app[1].replace(/\/$/, '');
    const svc = text.match(/^\s*-\s*Services:\s*(https?:\/\/[^\s;,)]+)/im);
    return svc ? svc[1].replace(/\/$/, '') : '';
}

export function findConfigFile(project, explicit) {
    if (explicit) return resolve(explicit);
    const local = join(project, '.claude', 'walk.json');
    if (existsSync(local)) return local;
    const personal = join(CONFIG_HOME, 'walk', `${basename(resolve(project))}.json`);
    return existsSync(personal) ? personal : '';
}

export function loadConfig(project, explicit, overrides = {}) {
    const file = findConfigFile(project, explicit);
    const raw = file ? JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) : {};
    const cfg = merge(merge(DEFAULTS, raw), overrides);
    if (!cfg.origin && existsSync(join(project, 'FLEET.md'))) cfg.origin = originFromFleet(readFileSync(join(project, 'FLEET.md'), 'utf8'));
    cfg.origin = String(cfg.origin || '').replace(/\/$/, '');
    cfg.file = file;
    cfg.project = resolve(project);
    cfg.probes = (cfg.probes || []).map((p) => (isAbsolute(p) ? p : resolve(project, p)));
    return cfg;
}

export const unsafeRegex = (extra = []) =>
    new RegExp([...UNSAFE_WORDS, ...extra].map((w) => String(w).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

/** A walk signs in and clicks: only a dev or test host qualifies unless the person passes --allow-remote. */
export function isLocalOrigin(origin) {
    try {
        const h = new URL(origin).hostname;
        return /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/.test(h) || /\.(localhost|test)$/.test(h);
    } catch {
        return false;
    }
}

/**
 * One spelling per page: the app's base path dropped, a hash route (`/#/x`) read as `/x`, the query and a trailing slash
 * or `index.html` removed. `base` is the origin's own path, for an app served under `/app/`.
 */
export function routeKey(s, base = '') {
    let p = String(s || '');
    const hash = p.indexOf('#/');
    if (hash >= 0) p = p.slice(hash + 1);
    p = p.split(/[?#]/)[0];
    if (base && (p === base || p.startsWith(base + '/'))) p = p.slice(base.length);
    p = p.replace(/\/index\.html?$/i, '/').replace(/\/+$/, '');
    return p || '/';
}

/** A refused push (no access) or a redirect leaves another page on screen: its shots would be mislabelled. */
export const landedElsewhere = (route, landed, base = '') => {
    const [r, l] = [routeKey(route, base), routeKey(landed, base)];
    // The root is a prefix of every path: a home route that redirected must still count.
    return l !== r && (r === '/' || !l.startsWith(r + '/'));
};

/** Collapses record ids so a crawl walks one page per shape, not every row of a list. */
export function shapeOf(path) {
    return path
        .split(/[?#]/)[0]
        .split('/')
        // Digits, hex with a digit, a UUID, or a long token with digits and no hyphen: a record id. "oauth2-setup" is a page.
        .map((s) => (/^\d+$|^(?=.*\d)[0-9a-f]{8,}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^(?=.*\d)(?=.*[a-z])[a-z0-9_]{16,}$/i.test(s) ? ':id' : s))
        .join('/');
}

/** Playwright from the project (root or one folder down), WALK_PLAYWRIGHT, or the person's walk-deps folder. */
export function findPlaywright(project) {
    const roots = [project];
    try {
        for (const d of readdirSync(project, { withFileTypes: true }))
            if (d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules' && existsSync(join(project, d.name, 'package.json'))) roots.push(join(project, d.name));
    } catch {
        /* unreadable project folder: fall through to the other places */
    }
    if (process.env.WALK_PLAYWRIGHT) roots.push(process.env.WALK_PLAYWRIGHT);
    roots.push(join(CONFIG_HOME, 'walk-deps'));
    for (const root of roots)
        for (const name of ['playwright', 'playwright-core', '@playwright/test']) {
            try {
                return createRequire(join(root, 'package.json'))(name);
            } catch {
                /* not installed here */
            }
        }
    return null;
}

/** After a Playwright bump its own browser build is often not downloaded yet; an older installed one renders the same. */
export function installedChromium() {
    if (process.env.WALK_CHROMIUM) return process.env.WALK_CHROMIUM;
    const cache =
        process.env.PLAYWRIGHT_BROWSERS_PATH ||
        (process.platform === 'win32'
            ? join(process.env.LOCALAPPDATA || '', 'ms-playwright')
            : process.platform === 'darwin'
              ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
              : join(homedir(), '.cache', 'ms-playwright'));
    if (!existsSync(cache)) return '';
    const dirs = readdirSync(cache).filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d)).sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()));
    const exes = {
        win32: ['chrome-headless-shell-win64/chrome-headless-shell.exe', 'chrome-win64/chrome.exe', 'chrome-win/chrome.exe'],
        darwin: ['chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'],
        linux: ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux64/chrome', 'chrome-linux/chrome'],
    }[process.platform] || [];
    for (const d of dirs) for (const e of exes) if (existsSync(join(cache, d, e))) return join(cache, d, e);
    return '';
}
