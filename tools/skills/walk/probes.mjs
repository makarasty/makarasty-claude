// In-page probes for walk.mjs. Each probe is serialized into the page by page.evaluate, so it closes over nothing
// outside its own body and takes its project facts as one argument. A probe returns candidates, not verdicts: a judge
// reads the shot before calling one a defect.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Split walk.jsonl into `batch-NN.json` files, the unit one judge reads: at most `size` routes and at most `maxShots`
 * pictures, since a judge reads every picture and a full batch of click-heavy routes would not fit one context.
 */
export function writeBatches(outDir, jsonl, size, maxShots = 150) {
    // A hand-cut jsonl from Windows PowerShell 5.1 starts with a BOM.
    const rows = readFileSync(jsonl, 'utf8')
        .replace(/^﻿/, '')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    rows.sort((a, b) => a.route.localeCompare(b.route));
    const compact = (r) => ({
        route: r.route,
        landed: r.landed,
        settled: r.settled,
        error: r.error,
        shots: r.shots,
        errors: r.errors,
        probes: { wide: r.probes, dark: r.probesDark, narrow: r.probesNarrow },
        custom: r.custom,
        film: r.film,
        motion: r.motion,
        tileHover: r.tileHover,
        hover: (r.hover || []).map(({ name, trigger, text, cut, covered }) => ({ name, trigger, text, cut, covered })),
        clicks: (r.clicks || []).map(({ name, kind, label, layers, dialog, opening, moved, dead, blocked, error }) => ({
            name,
            kind,
            label,
            layers: (layers || []).map(({ cut, covered, text }) => ({ cut, covered, text })),
            dialog,
            opening,
            moved,
            dead,
            blocked,
            error,
        })),
    });
    const groups = [];
    let cur = [];
    let shots = 0;
    for (const r of rows) {
        const n = (r.shots || []).length;
        if (cur.length && (cur.length >= size || shots + n > maxShots)) groups.push(cur), (cur = []), (shots = 0);
        cur.push(r);
        shots += n;
    }
    if (cur.length) groups.push(cur);
    return groups.map((g, i) => {
        const file = join(outDir, `batch-${String(i + 1).padStart(2, '0')}.json`);
        writeFileSync(file, JSON.stringify(g.map(compact), null, 1));
        return file;
    });
}

export const slugOf = (route) =>
    route
        .replace(/^\/+/, '')
        .replace(/[^\w-]+/g, '_')
        .slice(0, 120) || 'home';

/** Judges run at most 20 at once: a batch of ceil(routes / 20) keeps one wave; under 5 routes a judge is mostly start-up. */
export const autoBatch = (routes, slots = 20) => Math.max(5, Math.ceil(routes / slots));

/**
 * Geometry and text defects visible without interaction. Capped lists so one broken page cannot flood the log.
 * o = { pageSelector, iconClass, kitClasses }.
 */
export function probePage(o) {
    const W = innerWidth;
    const H = innerHeight;
    const icon = new RegExp(o.iconClass || 'material-(symbols|icons)');
    const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1 || r.bottom < 0 || r.top > H || el.closest('.sr-only, .visually-hidden')) return null;
        const s = getComputedStyle(el);
        return s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0 ? null : r;
    };
    const cls = (el) => (typeof el.className === 'string' ? el.className : el.getAttribute('class') || '');
    const label = (el) => {
        const c = cls(el).split(/\s+/).filter(Boolean).slice(0, 2).join('.');
        const text = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 50);
        return `${el.tagName.toLowerCase()}${c ? '.' + c : ''}${text ? ` "${text}"` : ''}`;
    };
    const box = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
    const out = { hscroll: null, clipped: [], overlaps: [], rowHeights: [], offscreen: [], badText: [], brokenImg: [], tiny: [] };

    const se = document.scrollingElement || document.documentElement;
    if (se.scrollWidth > se.clientWidth + 1) out.hscroll = { scrollWidth: se.scrollWidth, clientWidth: se.clientWidth };

    for (const el of document.querySelectorAll('body *')) {
        if (out.clipped.length >= 15) break;
        if (icon.test(cls(el)) || !el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
        const r = visible(el);
        if (!r) continue;
        const s = getComputedStyle(el);
        const hidesX = /hidden|clip/.test(s.overflowX) && s.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1;
        const hidesY = /hidden|clip/.test(s.overflowY) && !String(s.webkitLineClamp || '').match(/\d/) && el.scrollHeight > el.clientHeight + 2;
        if (hidesX || hidesY) out.clipped.push({ el: label(el), box: box(r), axis: hidesX ? 'x' : 'y' });
    }

    const interactive = [
        ...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role="button"], [role="tab"], [role="checkbox"], [role="switch"]'),
    ]
        .map((el) => ({ el, r: visible(el) }))
        .filter((x) => x.r);
    for (const { el, r } of interactive) {
        // Only a control cut by the edge: one wholly past it sits in a closed off-canvas drawer.
        if (out.offscreen.length < 10 && ((r.right > W + 1 && r.left < W) || (r.left < -1 && r.right > 0))) out.offscreen.push({ el: label(el), box: box(r) });
        if (out.tiny.length < 10 && (r.width < 16 || r.height < 16) && el.tagName !== 'INPUT') out.tiny.push({ el: label(el), box: box(r) });
        const atCenter = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        if (out.overlaps.length < 10 && atCenter && !el.contains(atCenter) && !atCenter.contains(el) && r.top >= 0 && r.bottom <= H && r.left >= 0 && r.right <= W) {
            const cover = atCenter.closest('[class]') || atCenter;
            if (!/scrim|overlay|backdrop|tooltip|hint/i.test(cls(cover))) out.overlaps.push({ el: label(el), coveredBy: label(cover), box: box(r) });
        }
    }

    const rows = new Map();
    const parentIds = new Map();
    for (const { el, r } of interactive) {
        if (el.tagName !== 'BUTTON' || !(el.innerText || '').trim()) continue;
        const p = el.parentElement;
        if (!parentIds.has(p)) parentIds.set(p, parentIds.size);
        const key = `${parentIds.get(p)}:${Math.round(r.top + r.height / 2)}`;
        (rows.get(key) || rows.set(key, []).get(key)).push({ el, r });
    }
    for (const group of rows.values()) {
        const hs = [...new Set(group.map((g) => Math.round(g.r.height)))];
        if (group.length > 1 && hs.length > 1 && Math.max(...hs) - Math.min(...hs) > 2 && out.rowHeights.length < 8)
            out.rowHeights.push({ heights: hs, buttons: group.map((g) => label(g.el)).slice(0, 5) });
    }

    const bad =
        /\b(undefined|null|NaN|Invalid Date|\[object Object\])\b|\{\{|\}\}|\bTODO\b|lorem ipsum|\b[a-z]+(?:_[a-z]+){2,}\b|\b[a-z]+\.[a-z]+\.[a-z_]+\b|^\s*\{\s*"(error|message|status|code)"/;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && out.badText.length < 12; n = walker.nextNode()) {
        const t = n.textContent.trim();
        if (!t || t.length > 300 || icon.test(cls(n.parentElement)) || n.parentElement.closest('script, style, code, pre, textarea, input')) continue;
        const m = t.match(bad);
        const doubled = /\S {2,}\S/.test(n.textContent) && getComputedStyle(n.parentElement).whiteSpace.startsWith('pre');
        if ((m || doubled) && visible(n.parentElement)) out.badText.push({ text: t.slice(0, 120), match: m ? m[0] : 'double space', el: label(n.parentElement) });
    }

    for (const img of document.images) if (out.brokenImg.length < 8 && img.complete && img.naturalWidth === 0 && visible(img)) out.brokenImg.push(img.currentSrc.slice(0, 160));

    out.buttonHeights = [...new Set(interactive.filter((x) => x.el.tagName === 'BUTTON' && (x.el.innerText || '').trim()).map((x) => Math.round(x.r.height)))].sort((a, b) => a - b);

    const pageBox = document.querySelector(o.pageSelector || 'body') || document.body;
    out.unevenGaps = [];
    out.rowDrift = [];
    out.spill = [];
    out.duplicates = [];
    for (const parent of pageBox.querySelectorAll('*')) {
        if (out.unevenGaps.length >= 8) break;
        const kids = [...parent.children].map((c) => ({ c, r: visible(c) })).filter((k) => k.r && k.r.height > 8);
        if (kids.length < 3 || parent.closest('tbody, table, [role="row"], svg')) continue;
        let stacked = true;
        const gaps = [];
        for (let i = 1; i < kids.length; i++) {
            const g = kids[i].r.top - kids[i - 1].r.bottom;
            if (g < -1 || Math.abs(kids[i].r.left - kids[0].r.left) > 2) stacked = false;
            gaps.push(Math.round(g));
        }
        if (stacked && Math.max(...gaps) - Math.min(...gaps) > 4 && Math.max(...gaps) < 64) out.unevenGaps.push({ el: label(parent), gaps: gaps.slice(0, 8) });
    }
    for (const body of pageBox.querySelectorAll('tbody')) {
        const hs = [...body.children].map((tr) => visible(tr)).filter(Boolean).map((r) => Math.round(r.height));
        if (hs.length > 2 && Math.max(...hs) - Math.min(...hs) > 2 && out.rowDrift.length < 5) out.rowDrift.push({ el: label(body.closest('table') || body), heights: [...new Set(hs)].slice(0, 6) });
    }
    for (const el of pageBox.querySelectorAll('*')) {
        if (out.spill.length >= 6) break;
        const s = getComputedStyle(el);
        if (s.maxHeight === 'none' || !/visible/.test(s.overflowY) || el.scrollHeight <= el.clientHeight + 2 || !visible(el)) continue;
        out.spill.push({ el: label(el), maxHeight: s.maxHeight, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
    }
    const byText = new Map();
    for (const { el } of interactive) {
        if (el.tagName !== 'BUTTON' || el.closest('tbody, [role="row"], [role="tablist"], nav')) continue;
        const t = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
        if (t.length >= 2) byText.set(t, (byText.get(t) || 0) + 1);
    }
    // Two or three copies of one labelled control; more is a repeated row, and icon-ligature-only labels are not words.
    for (const [text, n] of byText) if (n > 1 && n <= 3 && !/^[a-z_\s]+$/.test(text) && out.duplicates.length < 6) out.duplicates.push({ text: text.slice(0, 40), n });

    // Controls drawn by hand next to the project's own kit: only when the config names the kit's root classes.
    const kit = o.kitClasses || [];
    if (kit.length) {
        out.handmade = [];
        const fromKit = (el) => {
            for (let e = el, i = 0; e && i < 5; e = e.parentElement, i++) if (kit.some((k) => e.classList?.contains(k))) return true;
            return false;
        };
        for (const { el } of interactive) {
            if (out.handmade.length >= 10) break;
            if (!pageBox.contains(el) || el.tagName === 'A' || !el.matches('button, select, [role="button"]') || fromKit(el)) continue;
            out.handmade.push(label(el));
        }
    }
    return out;
}

/**
 * After a hover: floating layers that appeared (tooltip, menu, popover) and whether each is cut by the viewport or covered.
 * `mark` = true tags the layers already on screen before any hover, so later calls report only what a hover opened.
 */
export function probeFloating(mark) {
    const found = [];
    const layers =
        '[role=tooltip],[role=menu],[role=listbox],[role=dialog],[class*="tip"],[class*="hint"],[class*="popover"],[class*="menu"],[class*="dropdown"],[class*="popper"],[class*="floating"]';
    for (const el of document.querySelectorAll(layers)) {
        if (el.hasAttribute('data-walk-base')) continue;
        const s = getComputedStyle(el);
        if (!/fixed|absolute/.test(s.position) || s.zIndex === 'auto' || Number(s.opacity) === 0 || s.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8 || r.width > innerWidth * 0.9) continue;
        if (mark) {
            el.setAttribute('data-walk-base', '');
            continue;
        }
        const cut = r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight;
        // elementFromPoint skips pointer-events:none layers (most tooltips), so lift that for the one read.
        const pe = el.style.pointerEvents;
        el.style.pointerEvents = 'auto';
        const top = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, r.x + r.width / 2)), Math.min(innerHeight - 1, Math.max(0, r.y + r.height / 2)));
        el.style.pointerEvents = pe;
        found.push({
            el: `${el.tagName.toLowerCase()}.${String(el.getAttribute('class') || '').split(/\s+/)[0]}`,
            text: (el.innerText || '').trim().slice(0, 80),
            box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            cut,
            covered: !!top && !el.contains(top),
            zIndex: s.zIndex,
        });
        if (found.length >= 3) break;
    }
    return found;
}

/**
 * The open dialog's box and its close controls: the close is an icon inside the card, never a "Close" text button or an X
 * outside it; the scrim is tinted, not near-black. Only closers on screen in the dialog's own layer (its full-window fixed
 * ancestor, else the dialog) count: a page's own "Close menu" toggle or a parked off-screen panel's X is not the popup's.
 */
export function probeDialog() {
    const node = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].find((x) => x.getBoundingClientRect().width > 20 && x.getBoundingClientRect().height > 20);
    if (!node) return null;
    const d = node.getBoundingClientRect();
    const inside = (r) => r.left >= d.left - 1 && r.right <= d.right + 1 && r.top >= d.top - 1 && r.bottom <= d.bottom + 1;
    let host = node;
    for (let p = node.parentElement; p && p !== document.body; p = p.parentElement) {
        const r = p.getBoundingClientRect();
        if (getComputedStyle(p).position === 'fixed' && r.width >= innerWidth - 2 && r.height >= innerHeight - 2) {
            host = p;
            break;
        }
    }
    const closers = [...host.querySelectorAll('button, [role="button"]')].filter((b) => {
        const r = b.getBoundingClientRect();
        const shown = r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
        return shown && (/^(close|×|✕)$/i.test((b.innerText || '').trim()) || /close/i.test(b.getAttribute('aria-label') || ''));
    });
    const black = [...document.querySelectorAll('body *')].some((x) => {
        const s = getComputedStyle(x);
        const r = x.getBoundingClientRect();
        const m = s.backgroundColor.match(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/);
        return s.position === 'fixed' && r.width >= innerWidth - 2 && r.height >= innerHeight - 2 && m && +m[1] < 40 && +m[2] < 40 && +m[3] < 40 && (m[4] === undefined ? 1 : +m[4]) >= 0.5;
    });
    return {
        x: Math.round(d.x),
        y: Math.round(d.y),
        w: Math.round(d.width),
        h: Math.round(d.height),
        cut: d.left < 0 || d.top < 0 || d.right > innerWidth || d.bottom > innerHeight,
        closeOutside: closers.some((b) => !inside(b.getBoundingClientRect())),
        textClose: closers.some((b) => /^close$/i.test((b.innerText || '').trim())),
        noClose: !closers.some((b) => inside(b.getBoundingClientRect())),
        blackScrim: black,
    };
}
