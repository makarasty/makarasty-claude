#!/usr/bin/env node
// Turns an explanation written in Markdown into one self-contained, readable HTML page (an article, not a dashboard).
// Usage: node report.mjs <explain.md> <out.html>
// Supported: # to ####, paragraphs, - * and 1. lists (nested by indent), > note boxes, ``` or ~~~ code (copy button),
// ```flow, ```bars and ```svg pictures, ![caption](image.png) on its own line (embedded), | tables |, **bold**, *italic*,
// `code`, [text](url), ---. An ERROR writes no file. Whether the page explains anything is judged by the blind reader
// in SKILL.md, not here. After changing a check: node selftest.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, realpathSync } from 'node:fs';
import { dirname, resolve, extname, basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// chat: the sidebar title of the chat that made the page; account: its Desktop account; accountOf(title): the account of
// another chat a block names, '' when unknown (several devices can feed one machine, so the owner needs both to paste).
export function build(md, baseDir = '.', { chat = '', account = '', accountOf = () => '' } = {}) {
  const errors = [];
  const notes = [];
  const asks = [];
  let qn = 0, askWords = 0;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Code spans become placeholders first, so bold and links may wrap them and nothing inside them is touched.
  const inline = (s) => {
    const codes = [];
    let t = esc(String(s).replace(/`([^`]+)`/g, (m, c) => `\u0000${codes.push(c) - 1}\u0000`));
    t = t.replace(/&lt;br\s*\/?&gt;/gi, '<br>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(«])\*(?=\S)([^*]*?\S)\*(?=[\s).,;:!?»]|$)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (m, txt, u) => (/^(https?:|file:|mailto:)/i.test(u) ? `<a href="${u}">${txt}</a>` : m));
    return t.replace(/\u0000(\d+)\u0000/g, (m, n) => `<code>${esc(codes[n])}</code>`);
  };
  const svgSafe = (svg) => {
    if (!/^\s*<svg[\s>]/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) { errors.push('an ```svg block must start with <svg and end with </svg>'); return ''; }
    if (/<(script|style|foreignObject|iframe|object|embed)|[\s/"']on\w+\s*=|javascript:|&#|&(?!(?:amp|lt|gt|quot);)[a-z]+;|(?:href|src)\s*=\s*(?!["']?#)/i.test(svg)) {
      errors.push('an svg picture holds a script, a style, an event handler, an encoded character or an outside link: draw it with shapes and text only');
      return '';
    }
    if (!/<svg[^>]*\sviewBox=/i.test(svg)) { errors.push('an svg picture needs a viewBox, or it will not shrink to a phone'); return ''; }
    return svg.trim();
  };
  const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
  const image = (alt, path) => {
    const fig = (src) => `<figure><img src="${src}" alt="${esc(alt)}">${alt ? `<figcaption>${inline(alt)}</figcaption>` : ''}</figure>`;
    if (/^https?:\/\//i.test(path)) return fig(esc(path));
    const file = resolve(baseDir, path);
    const mime = MIME[extname(file).toLowerCase()];
    if (!mime) { errors.push(`image "${path}": use png, jpg, gif, webp or svg`); return ''; }
    if (!existsSync(file)) { errors.push(`image "${path}" not found (paths are relative to the .md file)`); return ''; }
    return fig(`data:${mime};base64,${readFileSync(file).toString('base64')}`);
  };
  // Split on a separator outside parentheses and backticks, so "(bad: a -> b)" and `a | b` stay whole.
  const splitOutside = (s, sep, parens = true) => {
    const out = [];
    let depth = 0, code = false, cur = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '`') code = !code;
      else if (parens && !code && c === '(') depth++;
      else if (parens && !code && c === ')') depth = Math.max(0, depth - 1);
      if (!code && depth === 0 && s.startsWith(sep, i) && s[i - 1] !== '\\') { out.push(cur); cur = ''; i += sep.length - 1; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  };
  const caption = (lines) => lines.find((l) => /^=\s/.test(l.trim()));

  // A shot inside a question: ![caption](a.png#box=x1,y1,x2,y2:label;…&dim=x1,y1,x2,y2:16 px;…) in image pixels of a PNG
  // (its size is in the header). box frames a changed spot, the first one gets the arrow; dim is a ruler with its size
  // written on it (vertical when x1=x2, horizontal when y1=y2), with dashed level lines back to the first box.
  const marksOf = (path, frag) => {
    const out = { box: [], dim: [] };
    for (const part of frag.split('&').filter(Boolean)) {
      const eq = part.indexOf('='), key = part.slice(0, eq), val = part.slice(eq + 1);
      if (!(key in out)) { errors.push(`shot "${path}": unknown mark "${part.slice(0, 20)}", write #box=…&dim=…`); continue; }
      for (const it of val.split(';').filter((x) => x.trim())) {
        const c = it.indexOf(':');
        let t = c < 0 ? '' : it.slice(c + 1).trim();
        try { t = decodeURIComponent(t); } catch { /* a literal % stays */ }
        out[key].push({ n: (c < 0 ? it : it.slice(0, c)).split(',').map(Number), t });
      }
    }
    return out;
  };
  const rr = (a, b, c, d, r) => { r = Math.max(0, Math.min(r, (c - a) / 2, (d - b) / 2)); return `M${a + r} ${b}H${c - r}Q${c} ${b} ${c} ${b + r}V${d - r}Q${c} ${d} ${c - r} ${d}H${a + r}Q${a} ${d} ${a} ${d - r}V${b + r}Q${a} ${b} ${a + r} ${b}Z`; };
  const tip = (cx, cy, ex, ey, L) => { const t = Math.atan2(ey - cy, ex - cx); return `M${ex - L * Math.cos(t - 0.5)} ${ey - L * Math.sin(t - 0.5)}L${ex} ${ey}L${ex - L * Math.cos(t + 0.5)} ${ey - L * Math.sin(t + 0.5)}`; };
  const r1 = (v) => Math.round(v * 10) / 10;
  const shot = (alt, ref) => {
    const [path, ...fr] = ref.split('#');
    const { box: boxes, dim: dims } = marksOf(path, fr.join('#'));
    let rel = path.trim();
    try { rel = decodeURI(rel); } catch { /* a literal % stays as written */ }
    const file = resolve(baseDir, rel);
    const mime = MIME[extname(file).toLowerCase()];
    if (!mime || !existsSync(file)) { errors.push(`shot "${path}": ${mime ? 'not found (paths are relative to the .md file)' : 'use png, jpg, gif, webp or svg'}`); return ''; }
    const buf = readFileSync(file);
    let mk = '';
    if (boxes.length || dims.length) {
      if (mime !== 'image/png' || buf.length < 24) { errors.push(`shot "${path}": a #box or #dim mark needs a PNG`); return ''; }
      const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20), pct = (v, of) => `${((v / of) * 100).toFixed(2)}%`;
      const inside = ({ n }) => n.length === 4 && n.every((v) => Number.isFinite(v) && v >= 0) && n[2] <= w && n[3] <= h;
      if (boxes.some((b) => !inside(b) || b.n[0] >= b.n[2] || b.n[1] >= b.n[3])) { errors.push(`shot "${path}": #box=x1,y1,x2,y2 in pixels inside ${w}x${h}`); return ''; }
      if (dims.some((x) => !inside(x) || (x.n[0] === x.n[2]) === (x.n[1] === x.n[3]))) { errors.push(`shot "${path}": #dim=x1,y1,x2,y2 inside ${w}x${h}, either x1=x2 (vertical) or y1=y2 (horizontal)`); return ''; }
      if (dims.some((x) => !x.t)) { errors.push(`shot "${path}": a #dim ruler says its size after a colon, e.g. dim=432,154,432,170:16 px`); return ''; }
      // Geometry is in image pixels; s keeps the arrow and ticks the same on screen for a 2x shot.
      const s = Math.max(1, w / 1000), two = (p) => `<path class="h" d="${p}"/><path d="${p}"/>`;
      let svg = '', labs = '';
      boxes.forEach(({ n: [a, b, c, d], t }) => { svg += two(rr(a, b, c, d, 8 * s)); if (t) labs += `<span class="ak-lab ak-lab-box" style="left:${pct(a, w)};top:${pct(b, h)}">${inline(t)}</span>`; });
      if (boxes.length) {
        // One curved arrow onto the first box, from above it, or from below when there is no room above.
        const [a, b, c, d] = boxes[0].n, ex = r1(c - Math.min(80 * s, (c - a) / 2)), up = b - 62 * s < 0;
        const ey = r1(up ? Math.min(h, d + 4 * s) : b - 4 * s), sy = r1(up ? Math.min(h - 2, d + 62 * s) : b - 62 * s);
        const sx = r1(ex + 120 * s <= w - 4 ? ex + 120 * s : Math.max(4, ex - 120 * s));
        svg += two(`M${sx} ${sy}Q${ex} ${sy} ${ex} ${ey}${tip(ex, sy, ex, ey, 17 * s)}`);
      }
      const bx = boxes[0]?.n;
      for (const { n: [a, b, c, d], t } of dims) {
        const v = a === c, T = 6 * s;
        if (bx) svg += `<path class="lv" d="${v ? (a > bx[0] ? `M${bx[0]} ${b}H${a}M${bx[0]} ${d}H${a}` : `M${a} ${b}H${bx[2]}M${a} ${d}H${bx[2]}`) : (b > bx[1] ? `M${a} ${bx[1]}V${b}M${c} ${bx[1]}V${d}` : `M${a} ${b}V${bx[3]}M${c} ${d}V${bx[3]}`)}"/>`;
        svg += two(v ? `M${a} ${b}V${d}M${a - T} ${b}H${a + T}M${a - T} ${d}H${a + T}` : `M${a} ${b}H${c}M${a} ${b - T}V${b + T}M${c} ${d - T}V${d + T}`);
        labs += `<span class="ak-lab ${v ? 'ak-lab-v' : 'ak-lab-h'}" style="left:${pct(v ? a : (a + c) / 2, w)};top:${pct(v ? (b + d) / 2 : b, h)}">${inline(t)}</span>`;
      }
      mk = `<div class="ak-mk"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${svg}</svg>${labs}</div>`;
    }
    return `<figure class="ak-shot">${alt ? `<figcaption>${inline(alt)}</figcaption>` : ''}<div class="ak-frame"><img src="data:${mime};base64,${buf.toString('base64')}" alt="${esc(alt)}">${mk}</div></figure>`;
  };
  const shots = (list) => (list.length ? `<div class="ak-shots">${list.map(([a, p]) => shot(a, p)).join('')}</div>` : '');
  // A path may hold spaces and one level of parentheses ("a (1).png"); a trailing "title" is dropped.
  const IMG = /!\[([^\]]*)\]\(((?:[^()]|\([^()]*\))+?)(?:\s+"[^"]*")?\)/g;
  const SURE = /^(высокая|средняя|низкая|вкус|high|medium|low|taste)(?!\p{L})[\s:—–-]*(.*)$/iu;
  const LEVEL = { высокая: 'hi', high: 'hi', средняя: 'mid', medium: 'mid', низкая: 'lo', low: 'lo', вкус: 'taste', taste: 'taste' };

  // ```ask <chat name as in the sidebar>: the chat's questions as cards. Lines before the first "? " are the block's intro;
  // "? question", then context lines and its shots; "* label | what changes | level: why" (the * marks the recommended one)
  // or "- label | what changes | level: why"; lines indented under an option add text or shots to it.
  const ask = (info, lines) => {
    const [named = '', acctNamed = ''] = splitOutside(info, '|', false).map((s) => s.trim());
    const to = named || chat;
    const acct = acctNamed || (to === chat ? account : accountOf(to)) || '';
    if (!to) errors.push('an ```ask block needs the chat its answers go to: ```ask <title as in the sidebar>, or pass --chat');
    askWords += lines.join(' ').split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
    const intro = [], qs = [];
    let q = null, o = null;
    for (const raw of lines) {
      if (!raw.trim()) continue;
      const ind = /^\s/.test(raw), l = raw.trim();
      let m;
      if (!ind && l.startsWith('? ')) { q = { text: l.slice(2).trim(), ctx: [], shots: [], opts: [] }; qs.push(q); o = null; continue; }
      if (!q) { intro.push(l); continue; }
      if (!ind && (m = l.match(/^([*-])\s+(.+)$/))) {
        const f = splitOutside(m[2], '|', false).map((s) => s.trim().replace(/\\\|/g, '|'));
        if (f.length > 3) errors.push(`option "${f[0]}": write "label | what changes | level: why", a | inside text goes in \`code\``);
        const s = f[2] ? f[2].match(SURE) : null;
        if (f[2] && !s) errors.push(`option "${f[0]}": the third part says how sure: высокая / средняя / низкая (вкус when it is a taste call; high / medium / low / taste), then why`);
        o = { rec: m[1] === '*', label: f[0], what: f[1] ?? '', sure: s ? { lv: LEVEL[s[1].toLowerCase()], word: s[1].toLowerCase(), why: s[2] } : null, extra: [], shots: [] };
        q.opts.push(o);
        continue;
      }
      const imgs = [...l.matchAll(IMG)].map((x) => [x[1], x[2]]);
      const rest = l.replace(IMG, '').trim();
      if (ind && o) { o.shots.push(...imgs); if (rest) o.extra.push(rest); continue; }
      if (!o) { q.shots.push(...imgs); if (rest) q.ctx.push(rest); continue; }
      errors.push(`question "${q.text}": the line "${l}" comes after its options; indent it under an option or start a new "? " question`);
    }
    if (!qs.length) errors.push('an ```ask block has no "? " question');
    const cards = qs.map((x) => {
      const n = ++qn;
      if (x.opts.length < 2) errors.push(`question ${n} "${x.text}": give at least two options to press`);
      if (x.opts.filter((y) => y.rec).length > 1) errors.push(`question ${n}: mark one recommended option (*), not several`);
      if (!x.opts.some((y) => y.sure)) errors.push(`question ${n}: say how sure you are on at least one option (| высокая: why), a taste call says so`);
      for (const y of x.opts) if (!y.what) errors.push(`question ${n}, option "${y.label}": say what changes if it is picked ("label | what changes | level: why")`);
      if (x.text.split(/\s+/).length > 22) notes.push(`question ${n} is ${x.text.split(/\s+/).length} words: keep the question short, the rest goes in the line under it`);
      const wide = x.opts.some((y) => y.shots.length);
      const opts = x.opts.map((y) => `<div class="ak-opt" data-v="${esc(y.label)}"${y.rec ? ' data-rec' : ''}><div class="ak-opt-h"><b>${inline(y.label)}</b>${y.rec ? `<span class="ak-rec">${ui.rec}</span>` : ''}</div>${y.what ? `<p>${inline(y.what)}</p>` : ''}${y.extra.map((e) => `<p>${inline(e)}</p>`).join('')}${y.sure ? `<p class="ak-sure ${y.sure.lv}"><span>${y.sure.lv === 'taste' ? ui.taste : `${ui.sure} ${esc(y.sure.word)}`}</span>${y.sure.why ? `${y.sure.why.startsWith('(') ? ' ' : ': '}${inline(y.sure.why)}` : ''}</p>` : ''}${shots(y.shots)}</div>`).join('');
      return `<article class="ak-q" data-n="${n}" data-q="${esc(x.text.replace(/`/g, ''))}"><h3><span class="ak-n">${n}</span><span>${inline(x.text)}</span></h3>${x.ctx.map((c) => `<p class="ak-ctx">${inline(c)}</p>`).join('')}${shots(x.shots)}<div class="ak-opts${wide ? ' ak-wide' : ''}">${opts}</div></article>`;
    });
    // Two blocks for one chat become one section: one copy button must carry all of that chat's answers.
    const same = asks.find((a) => a.to === to);
    if (same) { same.intro.push(...intro); same.cards.push(...cards); same.acct ||= acct; } else asks.push({ to, acct, intro, cards });
  };
  const acctTag = (a) => (a ? `<span class="ak-acct">${ui.acct} <b>${esc(a)}</b></span>` : '');
  const askSection = (a) => `<section class="ak-chat" data-chat="${esc(a.to)}" data-account="${esc(a.acct)}"><header class="ak-chat-h"><span>${ui.to}</span><b>«${esc(a.to)}»</b>${acctTag(a.acct)}<button type="button" class="ak-name" data-ak-name="${esc(a.to)}">${ui.name}</button></header>${a.intro.length ? `<p class="ak-intro">${a.intro.map(inline).join('<br>')}</p>` : ''}${a.cards.join('')}</section>`;

  // ```flow: one row per line, "label | step -> step (ok: note) -> step (bad: note)"; a last line "= caption".
  // Boxes are HTML, not SVG, so long words wrap instead of overflowing.
  const flow = (lines) => {
    const cap = caption(lines);
    const rows = lines.filter((l) => l.trim() && l !== cap).map((l) => {
      const parts = splitOutside(l, '|');
      const label = parts.length > 1 ? parts[0].trim() : '';
      const chain = (parts.length > 1 ? parts.slice(1).join('|') : parts[0]).trim();
      const steps = splitOutside(chain.replace(/-->|→/g, '->'), '->').map((s) => {
        const m = s.trim().match(/^(.*?)\s*\((ok|bad|wait)(?::\s*(.*))?\)$/i);
        if (m) return { t: m[1], st: m[2].toLowerCase(), note: m[3] };
        // A plain "(frontend)" is text; only a near-miss of a status is a mistake worth stopping for.
        if (/\((fail(ed)?|error|warn(ing)?|done|good|success|pending)(:[^)]*)?\)$/i.test(s.trim())) errors.push(`flow step "${s.trim()}": the status is ok, bad or wait`);
        return { t: s.trim() };
      });
      if (steps.some((s) => !s.t)) errors.push(`flow row "${l.trim()}": an empty step around "->"`);
      return `<div class="flow-row">${label ? `<div class="flow-label">${inline(label)}</div>` : ''}<div class="flow-steps">${steps.map((s) => `<div class="step${s.st ? ` ${s.st}` : ''}"><b>${inline(s.t)}</b>${s.note ? `<em class="sr">: </em><span>${inline(s.note)}</span>` : ''}</div>`).join(' <i aria-hidden="true">→</i> ')}</div></div>`;
    });
    if (!rows.length) errors.push('an empty ```flow block');
    return `<figure class="flow">${rows.join('')}${cap ? `<figcaption>${inline(cap.trim().replace(/^=\s*/, ''))}</figcaption>` : ''}</figure>`;
  };
  // ```bars: "label: 62 %" per line (the number is the last colon's value; thousands with a space, decimals with a
  // comma or dot), "*" before a label marks the one that matters, a last line "= caption" says what they count.
  const bars = (lines) => {
    const cap = caption(lines);
    const rows = lines.filter((l) => l.trim() && l !== cap).map((raw) => {
      const l = raw.replace(/\*\*/g, '');
      // The label ends at the first colon followed by a space and a number, so "В 12:30: 5 мин" and "Run: 5 at 10:30" both read right.
      const m = l.match(/^\s*(?:[-+]\s+)?(\*?)\s*(.+?):\s+([$€£₽]?)\s*([−-]?\d{1,3}(?:[  ]\d{3})+(?![\d.,])(?:[.,]\d+)?|[−-]?\d+(?:[.,]\d+)?)\s*(.*)$/);
      if (!m) { errors.push(`bars line "${l.trim()}": write "label: number unit"`); return null; }
      const v = Number(m[4].replace(/[  ]/g, '').replace(',', '.').replace('−', '-'));
      if (v < 0) { errors.push(`bars line "${l.trim()}": bars show sizes; put signed numbers in a table`); return null; }
      return { hot: !!m[1], label: m[2].replace(/\*\*/g, '').trim(), v, shown: `${m[3]}${m[4]}${m[5] ? ` ${m[5]}` : ''}` };
    }).filter(Boolean);
    if (!cap) errors.push('a ```bars block needs a last line "= what the bars count"');
    const max = Math.max(...rows.map((r) => r.v), 0) || 1;
    return `<figure class="bars">${rows.map((r) => `<div class="bar${r.hot ? ' hot' : ''}"><span>${inline(r.label)}</span><div><i style="width:${Math.max(1, Math.round((r.v / max) * 100))}%"></i><b>${esc(r.shown)}</b></div></div>`).join('')}${cap ? `<figcaption>${inline(cap.trim().replace(/^=\s*/, ''))}</figcaption>` : ''}</figure>`;
  };

  const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w-]*)/;
  const MARK = /^(\s*)([-*+]|\d{1,3}[.)]) (.*)$/;
  const blocks = (lines) => {
    const out = [];
    let i = 0;
    const isBreak = (l) => /^\s*$/.test(l) || FENCE.test(l) || /^(#{1,4} |> ?|\s*(?:[-*+]|\d{1,3}[.)]) |\|.*\||---\s*$|!\[)/.test(l);
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*$/.test(l)) { i++; continue; }
      let m;
      if ((m = l.match(/^(#{1,4}) (.+)$/))) { const n = Math.min(m[1].length, 3); out.push(`<h${n}>${inline(m[2].trim())}</h${n}>`); i++; continue; }
      if ((m = l.match(FENCE))) {
        const [, , fence, langRaw] = m;
        const lang = langRaw.toLowerCase();
        const close = new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
        const body = [];
        i++;
        while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
        if (i >= lines.length) errors.push('a code block is never closed');
        i++;
        if (lang === 'ask') ask(l.slice(m[0].length), body);
        else if (lang === 'svg') { const s = svgSafe(body.join('\n')); if (s) out.push(`<figure>${s}</figure>`); }
        else if (lang === 'flow') out.push(flow(body));
        else if (lang === 'bars') out.push(bars(body));
        else out.push(`<pre><button type="button">${ui.copy}</button><code>${esc(body.join('\n'))}</code></pre>`);
        continue;
      }
      if (/^> ?/.test(l)) {
        const body = [];
        while (i < lines.length && /^> ?/.test(lines[i])) body.push(lines[i++].replace(/^> ?/, ''));
        out.push(`<blockquote>${blocks(body)}</blockquote>`);
        continue;
      }
      if ((m = l.match(/^!\[([^\]]*)\]\(((?:[^()]|\([^()]*\))+)\)\s*$/))) { out.push(image(m[1], m[2])); i++; continue; }
      if (/^---\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
      if (/^\|.*\|\s*$/.test(l)) {
        const rows = [];
        while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
        const cells = (r) => splitOutside(r.trim().slice(1, -1), '|', false).map((c) => c.trim().replace(/\\\|/g, '|'));
        if (!(rows[1] && /^\|[\s:|-]+\|\s*$/.test(rows[1]))) { errors.push('a table needs a | --- | line under its header'); continue; }
        const head = cells(rows[0]);
        const row = (r) => { const c = cells(r); while (c.length < head.length) c.push(''); return c; };
        out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(2).map((r) => `<tr>${row(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
        continue;
      }
      if ((m = l.match(MARK))) {
        const indent = m[1].length;
        const ordered = /\d/.test(m[2]);
        const start = ordered ? parseInt(m[2], 10) : 1;
        const items = [];
        while (i < lines.length) {
          const im = lines[i].match(MARK);
          if (!im || im[1].length !== indent || /\d/.test(im[2]) !== ordered) break;
          const body = [im[3]];
          i++;
          // An item owns the lines indented past its marker, and blank lines between them.
          while (i < lines.length) {
            const nx = lines[i];
            if (/^\s*$/.test(nx)) {
              let j = i;
              while (j < lines.length && /^\s*$/.test(lines[j])) j++;
              if (j < lines.length && lines[j].match(/^\s*/)[0].length > indent) { while (i < j) { body.push(''); i++; } continue; }
              break;
            }
            const lead = nx.match(/^\s*/)[0].length;
            if (lead > indent) { body.push(nx.slice(Math.min(lead, indent + im[2].length + 1))); i++; continue; }
            if (lead === indent && !isBreak(nx)) { body.push(nx.trim()); i++; continue; }
            break;
          }
          const inner = blocks(body);
          items.push(`<li>${inner.replace(/^<p>([\s\S]*?)<\/p>(?=\n|$)/, '$1')}</li>`);
          // A blank line between two items of the same list keeps the list going ("loose" list).
          let j = i;
          while (j < lines.length && /^\s*$/.test(lines[j])) j++;
          const nx = j < lines.length && lines[j].match(MARK);
          if (j > i && nx && nx[1].length === indent && /\d/.test(nx[2]) === ordered) i = j;
        }
        out.push(ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
        continue;
      }
      const para = [];
      while (i < lines.length && !isBreak(lines[i])) para.push(lines[i++].trim());
      if (!para.length) { para.push(l.trim()); i++; }
      out.push(`<p>${para.map(inline).join('<br>\n')}</p>`);
    }
    return out.join('\n');
  };

  const lines = md.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  // Checks look at the prose only: code may legitimately hold "# comment", {{ x }}, TODO or <style>.
  const inFence = [];
  for (let i = 0, open = null; i < lines.length; i++) {
    const m = lines[i].match(FENCE);
    if (open) { inFence[i] = true; if (m && m[2][0] === open[0] && m[2].length >= open.length && !m[3]) open = null; }
    else if (m) { inFence[i] = true; open = m[2]; }
  }
  const prose = lines.filter((l, i) => !inFence[i]).join('\n').replace(/`[^`]*`/g, '');
  const h1 = lines.map((l, i) => (!inFence[i] && /^# /.test(l) ? i : -1)).filter((i) => i >= 0);
  if (h1.length !== 1) errors.push(`${h1.length} "# " titles: write exactly one, the main news in one plain sentence`);
  const title = h1.length ? lines[h1[0]].slice(2).trim() : '';
  const firstText = lines.slice((h1[0] ?? 0) + 1).find((l) => l.trim());
  if (h1.length === 1 && (!firstText || /^(#|```|~~~|\||!\[|>|\s*(?:[-*+]|\d+[.)]) )/.test(firstText))) errors.push('the title must be followed by a plain paragraph: the whole story in a few sentences for someone who knows nothing');
  // Common live-key shapes, code included; a report is read by others and kept on the Desktop.
  const secret = /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{20,}|[sr]k_live_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[\w-]{10,}|AIza[\w-]{30,}|\d{8,10}:AA[\w-]{30,}|eyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b[a-z][a-z0-9+]*:\/\/[^\s:/@]+:(?!\*+@)[^\s@/]{3,}@|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\b(?:password|passwd|pwd)\s*[=:]\s*['"]?(?=[^\s'"]*[\d!@#$%^&_])[\x21-\x7e]{6,}/i.test(md);
  if (secret) errors.push('the text holds what looks like a key, token or password: remove it, the page must never carry a secret');
  if (/\[\[|\{\{|\bTODO\b|\bTBD\b|<placeholder>/.test(prose)) errors.push('a template leftover ([[, {{, TODO, TBD) in the text: finish or remove it');
  if (/<(script|style|iframe|object|embed)\b/i.test(prose)) errors.push('raw HTML in the text: write Markdown, pictures go in ```svg blocks');

  // The page speaks the text's language: Russian when Cyrillic letters outnumber Latin ones.
  const cyr = (prose.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  const lat = (prose.match(/[A-Za-z]/g) ?? []).length;
  const ru = cyr >= lat;
  const plural = (n, one, few, many) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many}`;
  const ui = ru ? {
    lang: 'ru', copy: 'Копировать', done: 'Скопировано', sel: 'Выделено, нажми Ctrl+C', from: 'Страницу сделал чат', to: 'Ответ — в чат', name: 'Скопировать название', acct: 'аккаунт',
    rec: 'рекомендую', sure: 'Уверенность:', taste: 'Дело вкуса, решаешь ты', proof: 'Чем проверено и как доказано', un: 'не доказано', none: 'От тебя ничего не нужно: вопросов на этой странице нет.',
    sum: (q, c) => `<b>Нужно от тебя: ${plural(q, 'ответ', 'ответа', 'ответов')}${c > 1 ? ` в ${c} чат${c % 10 === 1 && c % 100 !== 11 ? 'е' : 'ах'}` : ''}.</b> Нажми вариант в каждой карточке; выбор сохраняется сам. ${c > 1 ? 'У каждого чата своя кнопка «Скопировать ответы» в конце его блока: вставь текст в этот чат, он продолжит работу сам.' : 'Затем «Скопировать ответы» в конце блока: вставь текст в этот чат, он продолжит работу сам.'}`,
    proofSum: (a, b) => `Доказано: ${a}. Не доказано: ${b}.`,
  } : {
    lang: 'en', copy: 'Copy', done: 'Copied', sel: 'Selected, press Ctrl+C', from: 'Page made by the chat', to: 'Answers go to the chat', name: 'Copy name', acct: 'account',
    rec: 'recommended', sure: 'Confidence:', taste: 'A taste call, yours to make', proof: 'How it was checked and proven', un: 'not proven', none: 'Nothing needed from you: this page asks no questions.',
    sum: (q, c) => `<b>Needed from you: ${q} answer${q === 1 ? '' : 's'}${c > 1 ? ` for ${c} chats` : ''}.</b> Press an option on each card; picks save themselves. ${c > 1 ? 'Each chat has its own "Copy answers" at the end of its block: paste the text into that chat and it carries on.' : 'Then "Copy answers" at the end of the block: paste the text into that chat and it carries on.'}`,
    proofSum: (a, b) => `Proven: ${a}. Not proven: ${b}.`,
  };
  if (!chat) errors.push('the page must name the chat that made it: pass --chat "<this chat\'s title as in the sidebar>" or --chat-id <session id>');

  // The fixed skeleton: chat bar, title, lead, the questions, the rest, then "Чем проверено" last whatever its place in the text.
  const h2s = lines.map((l, i) => (!inFence[i] && /^## /.test(l) ? i : -1)).filter((i) => i >= 0);
  const PROOF = /^##\s+(чем проверено|как доказано|как проверено|how it was checked|how it was proven)(?!\p{L})/iu;
  const pis = h2s.filter((i) => PROOF.test(lines[i]));
  const pi = pis[0];
  if (pis.length > 1) errors.push('two "## Чем проверено" sections: keep one, every check as a line of its list');
  if (pi === undefined) errors.push('no "## Чем проверено" section: every page ends with how each claim was checked, and says "не доказано" where it was not');
  const pEnd = pi === undefined ? pi : (h2s.find((i) => i > pi) ?? lines.length);
  const keep = (i) => i !== h1[0] && (pi === undefined || i < pi || i >= pEnd);
  // The lead ends at the first other heading or the first question block, so text after the cards never rises above them.
  const firstAsk = lines.findIndex((l, i) => (l.match(FENCE)?.[3] ?? '').toLowerCase() === 'ask' && !(i > 0 && inFence[i - 1] && !FENCE.test(lines[i - 1])));
  const firstH2 = Math.min(h2s.find((i) => i !== pi) ?? lines.length, firstAsk < 0 ? lines.length : firstAsk);
  const lead = blocks(lines.filter((l, i) => keep(i) && i < firstH2));
  const rest = blocks(lines.filter((l, i) => keep(i) && i >= firstH2));
  let proofHtml = '';
  if (pi !== undefined) {
    const UN = /не доказано|не проверено|не подтверждено|not proven|not checked|unverified/i;
    let good = 0, bad = 0;
    // Each item is judged by its own text only, up to its nested list, so a child line marks the child.
    const list = blocks(lines.slice(pi + 1, pEnd)).replace(/<li>((?:(?!<\/?li>|<[uo]l[ >])[\s\S])*)/g, (m, own) => (UN.test(own) ? (bad++, `<li class="ak-un" data-un="${ui.un}">${own}`) : (good++, m)));
    if (!good && !bad) errors.push('"## Чем проверено" has no list: one item per claim, how it was checked, «не доказано» where it was not');
    proofHtml = `<section class="ak-proof"><h2>${ui.proof}</h2>${good + bad ? `<p class="ak-proof-sum">${ui.proofSum(good, bad)}</p>` : ''}${list}</section>`;
  }
  const body = lead + rest + proofHtml;
  const leadWords = lead.replace(/<[^>]+>/g, ' ').split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
  if (leadWords > 50) notes.push(`the part above the questions is ${leadWords} words: the owner reads the top in a minute, move the rest below`);
  const askHtml = asks.length
    ? `<section class="ak-asks">${asks.length > 1 || asks[0].to !== chat || qn > 1 ? `<p class="ak-sum">${ui.sum(qn, asks.length)}</p>` : ''}${asks.map(askSection).join('')}</section>`
    : `<p class="ak-none">${ui.none}</p>`;
  const words = prose.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length + askWords;
  if (words > 1500) notes.push(`${words} words: long. Fine if it explains; cut whatever the reader would skip`);
  for (const p of body.match(/<p>[\s\S]*?<\/p>/g) ?? []) { const n = p.split(/\s+/).length; if (n > 130) notes.push(`a paragraph of ${n} words: split it where the thought turns`); }

  const css = readFileSync(new URL('./report.css', import.meta.url), 'utf8') + readFileSync(new URL('./ask.css', import.meta.url), 'utf8');
  // Always inlined: the chat bar's copy button needs it on a page without questions too; it stops early there.
  const askJs = readFileSync(new URL('./ask.js', import.meta.url), 'utf8');
  // Code blocks copy through ask.js's one copy routine (clipboard, then execCommand, then a box to copy by hand).
  const copy = `document.addEventListener('click',e=>{const b=e.target.closest('pre button');if(!b)return;const c=b.nextElementSibling;window.akCopy(c.textContent,()=>{b.textContent=${JSON.stringify(ui.done)};setTimeout(()=>b.textContent=${JSON.stringify(ui.copy)},2000)})})`;
  const html = `<!doctype html>
<html lang="${ui.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title.replace(/`/g, ''))}</title><style>${css}</style></head>
<body data-chat="${esc(chat)}" data-account="${esc(account)}" data-page="${esc(title.replace(/`/g, ''))}"><main>
<div class="ak-chatbar">${ui.from} <b>«${esc(chat)}»</b>${acctTag(account)}<button type="button" class="ak-name" data-ak-name="${esc(chat)}">${ui.name}</button></div>
<h1>${inline(title)}</h1>
${lead}
${askHtml}
${rest}
${proofHtml}
</main><script>${copy}</script>${askJs ? `<script>${askJs.replace(/<\/script/gi, '<\\/script')}</script>` : ''}</body></html>
`;
  return { html, errors, notes, words, title, questions: qn, chats: asks.map((a) => a.to) };
}

// Windows refuses <>:"/\|?* in a file name, and a ":" silently makes an empty file with a hidden stream instead.
export const safeName = (name) => name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' - ').replace(/\s+/g, ' ').replace(/^[\s.-]+|[\s.-]+$/g, '').slice(0, 120) || 'report';

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && import.meta.url === pathToFileURL(real(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const flag = (k) => { const i = args.indexOf(k); return i < 0 ? undefined : args.splice(i, 2)[1]; };
  let chat = flag('--chat'), account = flag('--account');
  const chatId = flag('--chat-id');
  const [src, out] = args;
  if (!src || !out) { console.error('usage: node report.mjs <explain.md> <out.html> --chat "<this chat\'s sidebar title>" | --chat-id <session id> [--account <name>]'); process.exit(2); }
  // The Desktop app's session records give each chat's sidebar title and account; a block's chat gets its account when its title is unique.
  let sessions = [];
  try { sessions = (await import('../unfinished/chats.mjs')).desktopSessions(); } catch { /* not on a Desktop machine */ }
  const me = chatId ? sessions.find((s) => s.id === chatId) : null;
  chat ||= me?.title ?? '';
  account ||= me?.account ?? '';
  if (chatId && !me) console.error(`NOTE no Desktop record for session ${chatId}: pass --chat "<title as in the sidebar>" and --account`);
  const accountOf = (title) => { const a = [...new Set(sessions.filter((s) => s.title === title).map((s) => s.account))]; return a.length === 1 ? a[0] : ''; };
  const text = readFileSync(src, 'utf8');
  if (/\.json$/i.test(src) || /^\s*\{\s*"/.test(text)) { console.error('ERROR the report skill changed: it now takes a Markdown explanation, not JSON. Re-read the skill\'s SKILL.md and write the text again from the facts.'); process.exit(1); }
  const r = build(text, dirname(resolve(src)), { chat: chat ?? '', account: account ?? '', accountOf });
  for (const n of r.notes) console.error('NOTE ' + n);
  if (r.errors.length) { for (const e of r.errors) console.error('ERROR ' + e); process.exit(1); }
  const dir = dirname(resolve(out));
  const ext = extname(out) || '.html';
  const file = join(dir, safeName(basename(out, extname(out))) + ext);
  mkdirSync(dir, { recursive: true });
  // Write beside and rename, so a reader never opens a half-written page.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, r.html);
  renameSync(tmp, file);
  console.log(`wrote ${file} (${r.words} words, about ${Math.max(1, Math.round(r.words / 180))} min to read)`);
}
