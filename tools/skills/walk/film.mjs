// Load film for walk.mjs (`--film`): how a cold load reaches its settled page. `filmRecorder` is installed with
// context.addInitScript and samples the page every 50 ms from document start; `filmVerdict` turns the samples into findings.
// Sampling the DOM, not screenshots: a screenshot burst throttles the renderer and invents stalled transitions.

/** In-page. o = { sk: skeleton/loader selector, page: page box selector }. Outermost skeletons per tick, swaps, shifts. */
export function filmRecorder(o) {
    if (window.__walkFilm) return;
    const SK = o.sk;
    const f = (window.__walkFilm = { frames: [], shifts: [], swaps: [], ended: false });
    const t0 = performance.now();
    const ids = new WeakMap();
    let next = 1;
    const id = (el) => ids.get(el) ?? (ids.set(el, next++), next - 1);
    const box = (r) => (r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null);
    const label = (el) =>
        el && el.nodeType === 1
            ? `${el.tagName.toLowerCase()}.${String(el.getAttribute('class') || '')
                  .split(/\s+/)
                  .filter(Boolean)
                  .slice(0, 2)
                  .join('.')}`
            : '';
    try {
        new PerformanceObserver((list) => {
            for (const e of list.getEntries())
                if (!e.hadRecentInput)
                    f.shifts.push({
                        t: Math.round(e.startTime),
                        v: Number(e.value.toFixed(4)),
                        src: (e.sources || []).slice(0, 3).map((s) => ({ el: label(s.node), from: box(s.previousRect), to: box(s.currentRect) })),
                    });
        }).observe({ type: 'layout-shift', buffered: true });
    } catch {
        /* no layout-shift API: the film still records skeletons */
    }
    let live = new Map();
    const tick = () => {
        if (f.ended || performance.now() - t0 > 30000) return;
        const now = new Map();
        const sk = [];
        for (const el of document.querySelectorAll(SK)) {
            if (el.parentElement?.closest(SK)) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight) continue;
            const key = id(el);
            const parent = el.parentElement;
            now.set(key, { parent, h: parent ? parent.getBoundingClientRect().height : 0, cls: label(el), box: box(r) });
            sk.push([key, ...box(r), label(el)]);
        }
        const t = Math.round(performance.now() - t0);
        // A skeleton that left this tick: how much its container grew or shrank, and the box of what now fills its slot.
        for (const [key, was] of live) {
            if (now.has(key) || !was.parent?.isConnected) continue;
            const [sx, sy, sw, sh] = was.box;
            let content = null;
            let best = 0;
            for (const c of was.parent.children) {
                const r = c.getBoundingClientRect();
                const ov = Math.max(0, Math.min(r.right, sx + sw) - Math.max(r.x, sx)) * Math.max(0, Math.min(r.bottom, sy + sh) - Math.max(r.y, sy));
                if (ov > best) [best, content] = [ov, [r.x, r.y, r.width, r.height]];
            }
            f.swaps.push({ t, id: key, cls: was.cls, parent: label(was.parent), dy: Math.round(was.parent.getBoundingClientRect().height - was.h), sk: was.box, content: content && content.map(Math.round) });
        }
        live = now;
        // Text in the page box tells a blank screen (no text, no skeleton) from a loading or loaded one.
        const page = (o.page && document.querySelector(o.page)) || document.body;
        f.frames.push({ t, sk, txt: (page?.textContent || '').trim().length });
        setTimeout(tick, 50);
    };
    tick();
}

/** In-page, every page: each CSS transition/animation that starts, with what it animates, for `motionVerdict`. */
export function motionRecorder() {
    if (window.__walkMotion) return;
    // One entry per kind+property+element, counted: skeleton shimmers alone fire hundreds of animationstart events.
    const seen = (window.__walkMotion = []);
    const at = new Map();
    const label = (el) =>
        el && el.nodeType === 1
            ? `${el.tagName.toLowerCase()}.${String(el.getAttribute('class') || '')
                  .split(/\s+/)
                  .filter(Boolean)
                  .slice(0, 2)
                  .join('.')}`
            : '';
    const note = (kind) => (e) => {
        const m = { kind, prop: e.propertyName || e.animationName || '', el: label(e.target) };
        const key = `${m.kind}|${m.prop}|${m.el}`;
        if (at.has(key) && seen.includes(at.get(key))) return void at.get(key).n++;
        if (seen.length >= 300) return;
        m.n = 1;
        at.set(key, m);
        seen.push(m);
    };
    addEventListener('transitionstart', note('transition'), true);
    addEventListener('animationstart', note('animation'), true);
}

/** Node side. Transitions of layout properties make the page reflow every frame: motion that looks jerky. */
export function motionVerdict(list) {
    const layout = /^(width|height|max-height|max-width|min-height|top|left|right|bottom|margin|padding|inset|grid-template)/;
    const key = (m) => `${m.prop} on ${m.el}`;
    const counts = new Map();
    for (const m of list || []) if (m.kind === 'transition' && layout.test(m.prop)) counts.set(key(m), (counts.get(key(m)) || 0) + (m.n || 1));
    return {
        total: (list || []).reduce((s, m) => s + (m.n || 1), 0),
        layout: [...counts].map(([what, n]) => ({ what, n })).sort((a, b) => b.n - a.n).slice(0, 8),
    };
}

const overlap = (a, b) => {
    const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
    const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
    return w > 0 && h > 0 ? (w * h) / Math.min(a[2] * a[3], b[2] * b[3]) : 0;
};

/**
 * Node side. `film` is window.__walkFilm, `vp` the viewport. Returns numbers plus findings:
 * cascade = a skeleton replaced in place by a different skeleton (the page seems to load twice); remount = the same
 * kind re-created in place (it blinks); jump = a container that changed height by more than `jumpPx` at a swap;
 * offCentre = a page loader (class matching `loaderClass`) whose centre is far from the window centre.
 */
export function filmVerdict(film, vp, { jumpPx = 8, gapMs = 400, loaderClass = 'loader|spinner' } = {}) {
    const life = new Map();
    for (const { t, sk } of film.frames)
        for (const [key, x, y, w, h, cls] of sk) {
            const l = life.get(key) ?? { key, first: t, box: [x, y, w, h], cls };
            l.last = t;
            life.set(key, l);
        }
    const all = [...life.values()].sort((a, b) => a.first - b.first);
    const end = film.frames.at(-1)?.t ?? 0;
    const cascades = [];
    const remounts = [];
    for (const b of all)
        for (const a of all)
            if (a !== b && a.last < b.first && b.first - a.last <= 1500 && overlap(a.box, b.box) > 0.5) {
                (a.cls === b.cls ? remounts : cascades).push({ at: b.first, from: a.cls, to: b.cls, box: b.box });
                break;
            }
    const lingering = all.filter((l) => l.last === end && end - l.first > 5000).map(({ cls, box, first }) => ({ cls, box, since: first }));
    let waves = 0;
    let prev = -Infinity;
    for (const l of all) {
        if (l.first - prev > gapMs) waves++;
        prev = l.first;
    }
    const jumps = film.swaps.filter((s) => Math.abs(s.dy) > jumpPx).map(({ t, cls, parent, dy }) => ({ t, cls, parent, dy }));
    const loader = new RegExp(loaderClass, 'i');
    // A page loader only: a card's own spinner centres in its card, and a full-width bar is not a centred loader.
    const offCentre = all
        .filter((l) => loader.test(l.cls) && l.box[2] < vp.width * 0.5 && l.box[2] >= 24)
        .filter((l) => Math.abs(l.box[0] + l.box[2] / 2 - vp.width / 2) > 40 || Math.abs(l.box[1] + l.box[3] / 2 - vp.height / 2) > 60)
        .map(({ cls, box }) => ({ cls, box }));
    const lastSkeleton = all.filter((l) => !lingering.some((g) => g.cls === l.cls && g.since === l.first)).reduce((m, l) => Math.max(m, l.last), 0);
    const cls = film.shifts.reduce((s, e) => s + e.v, 0);
    const mismatches = film.swaps
        .filter((s) => !loader.test(s.cls))
        .filter((s) => s.sk && s.content && (Math.abs(s.sk[3] - s.content[3]) > jumpPx || Math.abs(s.sk[2] - s.content[2]) > 2 * jumpPx || Math.abs(s.sk[1] - s.content[1]) > jumpPx))
        .map(({ t, cls: c, sk, content }) => ({ t, cls: c, sk, content }));
    // The longest run with neither text nor a skeleton in the page box before it settled.
    let blankMs = 0;
    let runStart = null;
    for (const fr of film.frames) {
        const blank = !fr.sk.length && (fr.txt ?? 1) < 20 && fr.t <= Math.max(lastSkeleton, 1);
        if (blank && runStart === null) runStart = fr.t;
        if (!blank && runStart !== null) {
            blankMs = Math.max(blankMs, fr.t - runStart);
            runStart = null;
        }
    }
    const flashes = all.filter((l) => l.last - l.first < 250 && !remounts.some((r) => r.to === l.cls)).length;
    const lateShifts = film.shifts.filter((s) => s.t > lastSkeleton + 500 && s.v >= 0.01);
    return {
        skeletons: all.length,
        waves,
        settledMs: lastSkeleton,
        cls: Number(cls.toFixed(3)),
        topShifts: [...film.shifts].sort((a, b) => b.v - a.v).slice(0, 3),
        cascades: cascades.slice(0, 10),
        remounts: remounts.length,
        remountKinds: [...new Set(remounts.map((r) => r.to))],
        lingering: lingering.slice(0, 5),
        jumps: jumps.slice(0, 10),
        mismatches: mismatches.slice(0, 10),
        blankMs,
        flashes,
        lateShifts: lateShifts.slice(0, 5),
        offCentre: offCentre.slice(0, 5),
    };
}
