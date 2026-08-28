/**
 * visual-probe.js - find visual defects by geometry, then let a screenshot confirm them.
 *
 * A model shown a screenshot and asked "does anything overlap here" will find something, every time,
 * whether or not anything does. So this runs first: the browser already knows every box's exact
 * rectangle, and geometry cannot be talked into seeing a defect. The screenshot comes second, aimed at
 * the candidates this returns, and its job is to confirm rather than to search.
 *
 * Paste the whole file into `javascript_tool`. It returns a bounded JSON object, never a DOM dump.
 *
 *   { viewport, counts, collisions[], clipped[], escaping[], offscreen[], invisibleText[] }
 *
 * Every entry carries a `selector` you can pass back to `document.querySelector` and a `rect`, so a
 * finding built from it is reproducible by someone who was never here.
 */
(() => {
  const MAX = 12;              // per category, so one bad page cannot flood a worker's context
  const MIN_OVERLAP_PX = 12;   // below this, antialiasing and 1px borders dominate
  const MIN_OVERLAP_FRAC = 0.1;

  const seen = new Map();
  const selectorFor = (el) => {
    if (seen.has(el)) return seen.get(el);
    const part = (e) => {
      if (e.id) return `#${CSS.escape(e.id)}`;
      const cls = (e.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
      const base = e.tagName.toLowerCase() + cls.map((c) => `.${CSS.escape(c)}`).join('');
      const sibs = e.parentElement ? [...e.parentElement.children].filter((s) => s.tagName === e.tagName) : [];
      return sibs.length > 1 ? `${base}:nth-of-type(${sibs.indexOf(e) + 1})` : base;
    };
    const path = [];
    for (let e = el; e && e.nodeType === 1 && path.length < 4; e = e.parentElement) path.unshift(part(e));
    const s = path.join(' > ');
    seen.set(el, s);
    return s;
  };

  const text = (el) => {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.replace(/\s+/g, ' ').trim();
  };

  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };

  const opaque = (cs) => {
    const bg = cs.backgroundColor || '';
    const m = bg.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const parts = m[1].split(',').map((v) => parseFloat(v));
    return parts.length < 4 || parts[3] >= 0.9;
  };

  // Collect visible, text-bearing leaves once. Everything below reads this list.
  const nodes = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (nodes.length > 4000) break;
    const t = text(el);
    if (!t) continue;
    if (el.closest('[aria-hidden="true"]')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.1) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) continue;
    nodes.push({ el, t, cs, r, z: cs.zIndex === 'auto' ? 0 : parseInt(cs.zIndex, 10) || 0 });
  }

  const out = { collisions: [], clipped: [], escaping: [], offscreen: [], invisibleText: [] };

  // 1. Text painted over text. Skip a pair where one covers the other opaquely and sits above it:
  //    that is a dialog or a menu doing its job, not a defect.
  for (let i = 0; i < nodes.length && out.collisions.length < MAX; i++) {
    for (let j = i + 1; j < nodes.length && out.collisions.length < MAX; j++) {
      const a = nodes[i], b = nodes[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (ox <= 0 || oy <= 0) continue;
      const area = ox * oy;
      const smaller = Math.min(a.r.width * a.r.height, b.r.width * b.r.height) || 1;
      if (area < MIN_OVERLAP_PX || area / smaller < MIN_OVERLAP_FRAC) continue;

      // Ask the browser what is actually painted in the middle of the overlap. A dialog, a sticky header
      // or any opaque panel sitting on top means neither text is visible there, so nothing collides.
      // This is the check that separates a real defect from ordinary occlusion, and it costs one hit test.
      const cx = (Math.max(a.r.left, b.r.left) + Math.min(a.r.right, b.r.right)) / 2;
      const cy = (Math.max(a.r.top, b.r.top) + Math.min(a.r.bottom, b.r.bottom)) / 2;
      let hit = 'offscreen';
      if (cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight) {
        const el = document.elementFromPoint(cx, cy);
        if (!el) continue;
        const onA = a.el === el || a.el.contains(el) || el.contains(a.el);
        const onB = b.el === el || b.el.contains(el) || el.contains(b.el);
        if (!onA && !onB) continue;
        hit = onA && onB ? 'both' : onA ? 'a' : 'b';
        // The one on top is opaque there, so the other's text is simply hidden rather than collided with.
        if (hit !== 'both' && opaque((hit === 'a' ? a : b).cs)) continue;
      }
      out.collisions.push({
        a: { selector: selectorFor(a.el), text: a.t.slice(0, 60), rect: rectOf(a.el), z: a.z },
        b: { selector: selectorFor(b.el), text: b.t.slice(0, 60), rect: rectOf(b.el), z: b.z },
        overlapPx: Math.round(area), fractionOfSmaller: +(area / smaller).toFixed(2), hitTest: hit,
      });
    }
  }

  for (const n of nodes) {
    const { el, cs, r } = n;

    // 2. Text cut off with no ellipsis: the value is wrong on screen and nothing says so.
    if (out.clipped.length < MAX && el.scrollWidth > el.clientWidth + 1 &&
        (cs.overflowX === 'hidden' || cs.overflowX === 'clip') && cs.textOverflow !== 'ellipsis') {
      out.clipped.push({ selector: selectorFor(el), text: n.t.slice(0, 60), rect: rectOf(el),
        visiblePx: el.clientWidth, neededPx: el.scrollWidth });
    }

    // 3. Painted outside a parent that is not clipping, so it lands on whatever is next to it.
    const p = el.parentElement;
    if (out.escaping.length < MAX && p && p !== document.body) {
      const pcs = getComputedStyle(p);
      if (pcs.overflow === 'visible') {
        const pr = p.getBoundingClientRect();
        const over = Math.round(Math.max(r.right - pr.right, pr.left - r.left, r.bottom - pr.bottom, pr.top - r.top));
        if (over > 2 && pr.width > 0) out.escaping.push({ selector: selectorFor(el), text: n.t.slice(0, 60),
          rect: rectOf(el), parent: selectorFor(p), parentRect: rectOf(p), overflowPx: over });
      }
    }

    // 4. Off the right edge of the document: the page scrolls sideways and the reader never sees it.
    if (out.offscreen.length < MAX && r.left > document.documentElement.clientWidth + 2) {
      out.offscreen.push({ selector: selectorFor(el), text: n.t.slice(0, 60), rect: rectOf(el) });
    }

    // 5. Text with no height. Reads as an empty screen and is usually a collapsed layout.
    if (out.invisibleText.length < MAX && n.t.length > 2 && r.height < 1) {
      out.invisibleText.push({ selector: selectorFor(el), text: n.t.slice(0, 60), rect: rectOf(el) });
    }
  }

  return JSON.stringify({
    viewport: { w: innerWidth, h: innerHeight, docW: document.documentElement.scrollWidth,
      zoom: +(devicePixelRatio || 1).toFixed(2), path: location.pathname + location.search },
    counts: { examined: nodes.length, collisions: out.collisions.length, clipped: out.clipped.length,
      escaping: out.escaping.length, offscreen: out.offscreen.length, invisibleText: out.invisibleText.length },
    ...out,
  });
})();
