/**
 * design-probe.js - find design defects by geometry and computed style, so a screenshot confirms rather
 * than invents.
 *
 * "The button is crooked" is a rectangle 3 px lower than its siblings. "The spacing is off" is a row whose
 * gaps read 8, 8, 13. "That text is hard to read" is a contrast ratio of 2.9 against a floor of 4.5. Each
 * of those is a number the browser already holds, and a number cannot be talked into a defect the way a
 * model shown a screenshot can. So this runs first and returns candidates with their rectangles; the
 * screenshot comes second, zoomed to a candidate, and its job is to confirm.
 *
 * Paste the whole file into `javascript_tool`. It returns one bounded JSON object, never a DOM dump:
 *
 *   { viewport, root, scale, landmarks[], misaligned[], unevenGaps[], unevenHeights[], offScale[],
 *     lowContrast[], smallTargets[], stretchedImages[], ghostBoxes[], longLines[], counts }
 *
 * `scale` is the page's own vocabulary read off the page: the spacing, font sizes, families, weights,
 * radii and colours it actually uses, each with a count. `offScale` is what sits outside that vocabulary.
 * When the project publishes tokens, set `window.__fleetScale = { spacing: [...], fontSizes: [...],
 * radii: [...] }` before running, and off-scale means off-token instead of off-histogram.
 *
 * `landmarks` is the recon a canvas run needs: the structural elements of the screen with their rectangles
 * and the styles an artboard has to reproduce. `counts` carries the full totals; the lists are capped.
 *
 * Complements visual-probe.js, which owns collisions, clipping, escaping and offscreen text. Run both.
 */
(() => {
  const MAX = 12;             // per category, so one bad page cannot flood a worker's context
  const TOL_ALIGN = 1.5;      // px; below this is subpixel rounding
  const MAX_ALIGN = 24;       // px; beyond this the siblings sit on different lines, not misaligned
  const TOL_GAP = 1;          // px; gaps closer than this are the same gap
  const MAX_GAP = 64;         // px; larger is a deliberate push (auto margin, spacer), not rhythm
  const MIN_TARGET = 24;      // px; WCAG 2.5.8 target size, level AA
  const CONTRAST_TEXT = 4.5, CONTRAST_LARGE = 3;   // WCAG 1.4.3
  const LONG_LINE_CH = 90;

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

  const r1 = (v) => Math.round(v * 10) / 10;
  const r2 = (v) => Math.round(v * 2) / 2;
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r1(r.left), y: r1(r.top), w: r1(r.width), h: r1(r.height) }; };
  const ownText = (el) => { let t = ''; for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue; return t.replace(/\s+/g, ' ').trim(); };
  const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const hist = () => {
    const m = new Map();
    return {
      add: (k) => m.set(k, (m.get(k) || 0) + 1),
      top: (n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => ({ value: k, n: c })),
      size: () => m.size, get: (k) => m.get(k) || 0, total: () => [...m.values()].reduce((a, b) => a + b, 0),
    };
  };

  // Colour: `rgb(a)` in, {r,g,b,a} out; relative luminance and contrast as WCAG defines them.
  const parse = (c) => {
    const m = String(c || '').match(/rgba?\(([^)]+)\)/); if (!m) return null;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const contrast = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  const blend = (top, alpha, under) => ({ r: alpha * top.r + (1 - alpha) * under.r, g: alpha * top.g + (1 - alpha) * under.g, b: alpha * top.b + (1 - alpha) * under.b, a: 1 });
  // The colour actually painted behind an element: every ancestor's background composited from the
  // outside in, starting from the white canvas. An ancestor painting an image or a gradient makes the
  // answer unknowable here, and the entry says so rather than guessing.
  const bgBehind = (el) => {
    const layers = [];
    let approx = false;
    for (let e = el; e; e = e.parentElement) {
      const c = getComputedStyle(e);
      if (c.backgroundImage && c.backgroundImage !== 'none') return { color: null, approx: true, image: true };
      const col = parse(c.backgroundColor);
      if (col && col.a > 0) { layers.push(col); if (col.a < 0.99) approx = true; else break; }
    }
    let result = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) result = blend(layers[i], layers[i].a, result);
    return { color: result, approx, image: false };
  };
  const opacityChain = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o; };

  // Collect visible elements once. Everything below reads this list.
  const nodes = [];
  const inSvg = (el) => el.tagName.toLowerCase() !== 'svg' && !!el.closest('svg');
  for (const el of document.body.querySelectorAll('*')) {
    if (nodes.length > 4000) break;
    if (inSvg(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.1) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    nodes.push({ el, cs, r, t: ownText(el) });
  }
  const info = new Map(nodes.map((n) => [n.el, n]));
  const flowChildren = (el) => [...el.children].map((c) => info.get(c)).filter(Boolean).filter((n) => n.cs.position !== 'absolute' && n.cs.position !== 'fixed');
  const isControl = (el) => el.matches('button, input:not([type=checkbox]):not([type=radio]):not([type=hidden]), select, textarea, [role=button], a[class*=btn], a[class*=button]');
  const interactive = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=switch], [tabindex="0"]';

  const out = { misaligned: [], unevenGaps: [], unevenHeights: [], offScale: [], lowContrast: [], smallTargets: [], stretchedImages: [], ghostBoxes: [], longLines: [] };
  const counts = {};
  const push = (cat, entry) => { counts[cat] = (counts[cat] || 0) + 1; if (out[cat].length < MAX) out[cat].push(entry); };

  // 1. Rows. Children of a flex or grid container that share a line should share an edge - which edge
  //    depends on align-items - and the gaps between them should repeat. A child that sets its own
  //    align-self is excused from the edge check; a gap beside an auto margin is excused from rhythm.
  const lines = (kids, horizontal) => {
    const sorted = [...kids].sort((a, b) => (horizontal ? a.r.top - b.r.top : a.r.left - b.r.left));
    const groups = [];
    for (const k of sorted) {
      const g = groups[groups.length - 1];
      const near = g ? (horizontal ? Math.abs(k.r.top - g[0].r.top) : Math.abs(k.r.left - g[0].r.left)) : Infinity;
      if (g && near < MAX_ALIGN) g.push(k); else groups.push([k]);
    }
    return groups.map((g) => g.sort((a, b) => (horizontal ? a.r.left - b.r.left : a.r.top - b.r.top)));
  };
  for (const n of nodes) {
    const d = n.cs.display;
    const flex = d === 'flex' || d === 'inline-flex';
    const grid = d === 'grid' || d === 'inline-grid';
    if (!flex && !grid) continue;
    const kids = flowChildren(n.el);
    if (kids.length < 2) continue;
    const horizontal = grid ? true : !/column/.test(n.cs.flexDirection);
    for (const line of lines(kids, horizontal)) {
      if (line.length < 2) continue;
      const ai = n.cs.alignItems;
      const selfOf = (k) => (k.cs.alignSelf && k.cs.alignSelf !== 'auto' && k.cs.alignSelf !== 'normal' ? k.cs.alignSelf : ai);
      const edge = (k) => {
        const self = selfOf(k);
        if (self === 'center') return horizontal ? k.r.top + k.r.height / 2 : k.r.left + k.r.width / 2;
        if (/end/.test(self)) return horizontal ? k.r.bottom : k.r.right;
        if (self === 'baseline') return null;
        return horizontal ? k.r.top : k.r.left;
      };
      const cand = line.filter((k) => selfOf(k) === ai && edge(k) !== null);
      if (cand.length >= 2) {
        const edges = cand.map(edge).sort((a, b) => a - b);
        const median = edges.length % 2 ? edges[(edges.length - 1) / 2] : (edges[edges.length / 2 - 1] + edges[edges.length / 2]) / 2;
        const off = cand.filter((k) => { const dv = Math.abs(edge(k) - median); return dv > TOL_ALIGN && dv < MAX_ALIGN; });
        if (off.length && off.length < cand.length) {
          push('misaligned', {
            container: selectorFor(n.el), axis: horizontal ? 'y' : 'x', alignItems: ai, reference: r1(median), aligned: cand.length - off.length,
            items: off.map((k) => ({ selector: selectorFor(k.el), text: k.t.slice(0, 40), rect: rectOf(k.el), deviationPx: r1(edge(k) - median) })),
          });
        }
      }
      if (line.length >= 3) {
        const gaps = [];
        for (let i = 1; i < line.length; i++) {
          const a = line[i - 1], b = line[i];
          const auto = horizontal
            ? (a.el.style.marginRight === 'auto' || b.el.style.marginLeft === 'auto')
            : (a.el.style.marginBottom === 'auto' || b.el.style.marginTop === 'auto');
          const g = horizontal ? b.r.left - a.r.right : b.r.top - a.r.bottom;
          if (!auto && g >= -TOL_GAP && g <= MAX_GAP) gaps.push(r2(g));
        }
        const distinct = [...new Set(gaps)];
        if (gaps.length >= 2 && distinct.length > 1 && Math.max(...gaps) - Math.min(...gaps) > TOL_GAP) {
          push('unevenGaps', {
            container: selectorFor(n.el), axis: horizontal ? 'x' : 'y', gaps, declaredGap: n.cs.gap,
            items: line.slice(0, 6).map((k) => ({ selector: selectorFor(k.el), rect: rectOf(k.el) })),
          });
        }
      }
      if (horizontal) {
        const ctrls = line.filter((k) => isControl(k.el));
        const hs = [...new Set(ctrls.map((k) => r2(k.r.height)))];
        if (ctrls.length >= 2 && hs.length > 1 && Math.max(...hs) - Math.min(...hs) > TOL_GAP) {
          push('unevenHeights', {
            container: selectorFor(n.el), heights: hs,
            items: ctrls.map((k) => ({ selector: selectorFor(k.el), text: k.t.slice(0, 40), h: r2(k.r.height), rect: rectOf(k.el) })),
          });
        }
      }
    }
  }

  // 2. The page's own scale, read off the page, and what falls outside it.
  const spacing = hist(), sizes = hist(), families = hist(), weights = hist(), ramp = hist(), radii = hist(), fgs = hist(), bgs = hist();
  const spacingAt = new Map(), radiusAt = new Map(), sizeAt = new Map();
  const note = (map, k, el, prop) => { if (!map.has(k)) map.set(k, { selector: selectorFor(el), prop }); };
  for (const n of nodes) {
    const { el, cs } = n;
    // One element counts each spacing value once, whichever sides carry it: a lone 13 px padding is one
    // vote for 13, not four, or a single odd box would vote itself onto the scale.
    const own = new Map();
    for (const p of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) { const v = r2(px(cs[p])); if (v > 0 && !own.has(v)) own.set(v, p); }
    if (/flex|grid/.test(cs.display)) for (const p of ['rowGap', 'columnGap']) { const v = r2(px(cs[p])); if (v > 0 && !own.has(v)) own.set(v, p); }
    for (const [v, p] of own) { spacing.add(v); note(spacingAt, v, el, p); }
    const radius = r2(px(cs.borderTopLeftRadius));
    const bordered = px(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none';
    const bgc = parse(cs.backgroundColor);
    if (radius > 0 && (bordered || (bgc && bgc.a > 0))) { radii.add(radius); note(radiusAt, radius, el, 'border-radius'); }
    if (bgc && bgc.a >= 0.99) bgs.add(hex(bgc));
    if (n.t.length >= 2) {
      const fs = r2(px(cs.fontSize)); sizes.add(fs); note(sizeAt, fs, el, 'font-size');
      const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(); families.add(fam);
      weights.add(cs.fontWeight);
      ramp.add(`${fam} ${fs}px ${cs.fontWeight}`);
      const fg = parse(cs.color); if (fg) fgs.add(hex(fg));
    }
  }
  const given = window.__fleetScale || null;
  const inScale = (h, v, override) => (override ? override.map(Number).some((x) => Math.abs(x - v) < 0.26) : h.get(v) >= Math.max(3, Math.ceil(h.total() * 0.02)));
  const scaleOf = (h, override) => (override ? override.map(Number) : h.top(40).filter((e) => inScale(h, e.value)).map((e) => e.value).sort((a, b) => a - b));
  const scale = {
    source: given ? 'window.__fleetScale' : 'histogram of this page',
    spacing: scaleOf(spacing, given && given.spacing), fontSizes: scaleOf(sizes, given && given.fontSizes), radii: scaleOf(radii, given && given.radii),
    spacingHistogram: spacing.top(12), fontSizeHistogram: sizes.top(12), radiusHistogram: radii.top(8),
    families: families.top(6), weights: weights.top(6), typeRamp: ramp.top(12), distinctTypeCombos: ramp.size(),
    textColors: fgs.top(10), distinctTextColors: fgs.size(), backgrounds: bgs.top(10), distinctBackgrounds: bgs.size(),
  };
  const nearest = (list, v) => (list.length ? list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a)) : null);
  const offs = [];
  for (const [v, at] of spacingAt) if (!inScale(spacing, v, given && given.spacing)) offs.push({ kind: 'spacing', value: v, n: spacing.get(v), nearest: nearest(scale.spacing, v), ...at });
  for (const [v, at] of sizeAt) if (!inScale(sizes, v, given && given.fontSizes)) offs.push({ kind: 'font-size', value: v, n: sizes.get(v), nearest: nearest(scale.fontSizes, v), ...at });
  for (const [v, at] of radiusAt) if (!inScale(radii, v, given && given.radii)) offs.push({ kind: 'radius', value: v, n: radii.get(v), nearest: nearest(scale.radii, v), ...at });
  offs.sort((a, b) => a.n - b.n);
  for (const o of offs) push('offScale', o);

  // 3. Text you cannot read. Disabled controls and gradient-filled text are exempt.
  for (const n of nodes) {
    const { el, cs, t } = n;
    if (t.length < 2) continue;
    if (el.closest('[disabled], [aria-disabled="true"]')) continue;
    if (cs.webkitTextFillColor && cs.webkitTextFillColor !== cs.color) continue;
    const fg0 = parse(cs.color); if (!fg0) continue;
    const bg = bgBehind(el); if (!bg.color) continue;
    const alpha = Math.min(1, fg0.a * opacityChain(el));
    const fg = alpha < 1 ? blend(fg0, alpha, bg.color) : fg0;
    const fs = px(cs.fontSize), bold = parseInt(cs.fontWeight, 10) >= 700;
    const needed = fs >= 24 || (fs >= 18.66 && bold) ? CONTRAST_LARGE : CONTRAST_TEXT;
    const ratio = contrast(fg, bg.color);
    if (ratio < needed) push('lowContrast', { selector: selectorFor(el), text: t.slice(0, 40), rect: rectOf(el), fg: hex(fg), bg: hex(bg.color), ratio: r1(ratio), needed, fontSize: fs, approx: bg.approx || alpha < 1 });
  }

  // 4. Targets too small to hit. A link inside running text is exempt; a small input inside a large label
  //    is hit through the label.
  for (const n of nodes) {
    const { el, r } = n;
    if (!el.matches(interactive)) continue;
    if (r.width >= MIN_TARGET && r.height >= MIN_TARGET) continue;
    const p = el.parentElement;
    if (el.tagName === 'A' && p && [...p.childNodes].some((c) => c.nodeType === 3 && c.nodeValue.trim())) continue;
    const label = el.closest('label');
    if (label && label !== el) { const lr = label.getBoundingClientRect(); if (lr.width >= MIN_TARGET && lr.height >= MIN_TARGET) continue; }
    push('smallTargets', { selector: selectorFor(el), text: (n.t || el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, 40), rect: rectOf(el), minPx: MIN_TARGET });
  }

  // 5. Images drawn at the wrong aspect ratio.
  for (const n of nodes) {
    const { el, cs, r } = n;
    if (el.tagName !== 'IMG' || !el.complete || !el.naturalWidth || !el.naturalHeight) continue;
    if (cs.objectFit && cs.objectFit !== 'fill') continue;
    const d = (r.width / r.height) / (el.naturalWidth / el.naturalHeight);
    if (Math.abs(d - 1) > 0.03) push('stretchedImages', { selector: selectorFor(el), rect: rectOf(el), natural: `${el.naturalWidth}x${el.naturalHeight}`, distortion: r1(d) });
  }

  // 6. Boxes that draw a border or a fill around nothing. Skeletons, swatches and progress bars are the
  //    legitimate cases, so these are candidates for a screenshot, never findings on their own.
  for (const n of nodes) {
    const { el, cs, r } = n;
    if (r.width < 24 || r.height < 24) continue;
    if (el.tagName === 'HR' || el.hasAttribute('role') || el.hasAttribute('aria-label')) continue;
    if (el.matches('input, select, textarea, button, [contenteditable]')) continue;   // an empty field is a field
    const bordered = px(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none';
    const bgc = parse(cs.backgroundColor);
    const filled = bgc && bgc.a > 0.05;
    if (!bordered && !filled) continue;
    if (el.textContent.trim()) continue;
    if (el.querySelector('img, svg, canvas, video, iframe, picture, input, select, textarea, button')) continue;
    if (cs.backgroundImage && cs.backgroundImage !== 'none') continue;
    push('ghostBoxes', { selector: selectorFor(el), rect: rectOf(el), border: bordered ? cs.borderTop : null, background: filled ? hex(bgc) : null });
  }

  // 7. Lines too long to read comfortably, estimated in characters from the box width and the font size.
  for (const n of nodes) {
    const { el, cs, r, t } = n;
    if (t.length < 120 || (/inline/.test(cs.display) && cs.display !== 'inline-block')) continue;
    const chars = Math.round(r.width / (px(cs.fontSize) * 0.5));
    if (chars > LONG_LINE_CH) push('longLines', { selector: selectorFor(el), rect: rectOf(el), charsPerLine: chars, fontSize: px(cs.fontSize) });
  }

  // 8. Landmarks: what an artboard has to reproduce, at the numbers it has to reproduce them at.
  const landmarks = [];
  const styleOf = (el) => {
    const cs = getComputedStyle(el); const bg = bgBehind(el); const c = parse(cs.color);
    return {
      font: `${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily.split(',')[0].replace(/["']/g, '').trim()}`,
      color: c ? hex(c) : cs.color, background: bg.color ? hex(bg.color) : (bg.image ? 'image' : null),
      padding: cs.padding, border: px(cs.borderTopWidth) > 0 ? cs.borderTop : 'none', radius: cs.borderRadius,
      shadow: cs.boxShadow === 'none' ? 'none' : cs.boxShadow.slice(0, 60), gap: /flex|grid/.test(cs.display) ? cs.gap : undefined, display: cs.display,
    };
  };
  const pick = ['header', '[role=banner]', 'nav', '[role=navigation]', 'aside', 'main', '[role=main]', 'footer', 'h1', 'h2', 'h3', 'button', 'a[class*=btn]',
    'input:not([type=hidden])', 'select', 'table', 'thead th', 'tbody tr', 'tbody td', '[role=tab]', '[role=tablist]', 'form', 'label', '[class*=card]'];
  const taken = new Set();
  for (const sel of pick) {
    if (landmarks.length >= 24) break;
    let el = null;
    try { el = [...document.querySelectorAll(sel)].find((e) => info.has(e) && !taken.has(e)); } catch { el = null; }
    if (!el) continue;
    taken.add(el);
    landmarks.push({ role: sel, selector: selectorFor(el), text: ownText(el).slice(0, 40), rect: rectOf(el), style: styleOf(el) });
  }
  const rootCs = getComputedStyle(document.documentElement), bodyCs = getComputedStyle(document.body);
  const bodyFg = parse(bodyCs.color), bodyBg = bgBehind(document.body);
  const root = { fontSize: rootCs.fontSize, fontFamily: bodyCs.fontFamily.split(',').slice(0, 2).join(',').replace(/["']/g, ''), color: bodyFg ? hex(bodyFg) : bodyCs.color, background: bodyBg.color ? hex(bodyBg.color) : 'image' };

  return JSON.stringify({
    viewport: { w: innerWidth, h: innerHeight, docW: document.documentElement.scrollWidth, docH: document.documentElement.scrollHeight, dpr: +(devicePixelRatio || 1).toFixed(2), zoom: rootCs.zoom, path: location.pathname + location.search },
    root, scale, landmarks,
    counts: { examined: nodes.length, ...counts },
    ...out,
  });
})();
