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

export function build(md, baseDir = '.') {
  const errors = [];
  const notes = [];
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
        if (lang === 'svg') { const s = svgSafe(body.join('\n')); if (s) out.push(`<figure>${s}</figure>`); }
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
  const ui = ru ? { lang: 'ru', copy: 'Копировать', done: 'Скопировано', sel: 'Выделено, нажми Ctrl+C' } : { lang: 'en', copy: 'Copy', done: 'Copied', sel: 'Selected, press Ctrl+C' };

  const body = blocks(lines.filter((l, i) => i !== h1[0]));
  const words = prose.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
  if (words > 1500) notes.push(`${words} words: long. Fine if it explains; cut whatever the reader would skip`);
  for (const p of body.match(/<p>[\s\S]*?<\/p>/g) ?? []) { const n = p.split(/\s+/).length; if (n > 130) notes.push(`a paragraph of ${n} words: split it where the thought turns`); }

  const css = readFileSync(new URL('./report.css', import.meta.url), 'utf8');
  // A page opened from disk may have no clipboard API: then select the code so Ctrl+C works.
  const copy = `document.addEventListener('click',e=>{const b=e.target.closest('pre button');if(!b)return;const c=b.nextElementSibling,say=t=>{b.textContent=t;setTimeout(()=>b.textContent=${JSON.stringify(ui.copy)},2000)},sel=()=>{const r=document.createRange();r.selectNodeContents(c);getSelection().removeAllRanges();getSelection().addRange(r);say(${JSON.stringify(ui.sel)})};try{navigator.clipboard.writeText(c.textContent).then(()=>say(${JSON.stringify(ui.done)}),sel)}catch(x){sel()}})`;
  const html = `<!doctype html>
<html lang="${ui.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title.replace(/`/g, ''))}</title><style>${css}</style></head>
<body><main>
<h1>${inline(title)}</h1>
${body}
</main><script>${copy}</script></body></html>
`;
  return { html, errors, notes, words, title };
}

// Windows refuses <>:"/\|?* in a file name, and a ":" silently makes an empty file with a hidden stream instead.
export const safeName = (name) => name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' - ').replace(/\s+/g, ' ').replace(/^[\s.-]+|[\s.-]+$/g, '').slice(0, 120) || 'report';

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && import.meta.url === pathToFileURL(real(process.argv[1])).href) {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) { console.error('usage: node report.mjs <explain.md> <out.html>'); process.exit(2); }
  const text = readFileSync(src, 'utf8');
  if (/\.json$/i.test(src) || /^\s*\{\s*"/.test(text)) { console.error('ERROR the report skill changed: it now takes a Markdown explanation, not JSON. Re-read the skill\'s SKILL.md and write the text again from the facts.'); process.exit(1); }
  const r = build(text, dirname(resolve(src)));
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
