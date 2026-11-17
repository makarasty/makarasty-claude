#!/usr/bin/env node
// Turns a report JSON into one self-contained HTML file ("Маршрут" design: a time spine with stations).
// Usage: node report.mjs <report.json> <out.html>
// Strict: any WARN fails the build (exit 1, no file) unless the JSON sets "allowWarnings": true.
// A weak writer ships a page that looks right but says wrong things; these checks are the only reviewer it gets.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('usage: node report.mjs <report.json> <out.html>'); process.exit(2); }
const r = JSON.parse(readFileSync(src, 'utf8'));
const warn = [];
const fail = (m) => { console.error('ERROR ' + m); process.exit(1); };

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Glue wraps a run in a nowrap span and never changes a character, so find and copy stay exact.
// Each run joins one token to one neighbour: a dot to the words before it, a Latin id, a thousands group,
// an arrow or × with both sides, a range, a number and its noun, a product and its version (before
// punctuation), or a short word and the next word. A dot that opens a segment (after code) sticks to it too.
const GLUE = new RegExp([
  String.raw`^ ·`,
  String.raw`(?:\S+ ){1,2}·`,
  String.raw`\S+ [→×] \S+`,
  String.raw`(?<![\p{L}\d-])[A-Za-z][A-Za-z\d]*(?:-[A-Za-z\d]+)+(?![\p{L}\d-])`,
  String.raw`[-−+]?\d{1,3}(?: \d{3})+(?!\d)`,
  String.raw`\d[\d.,]*[-–]\d[\d.,]*`,
  String.raw`\p{L}+ \d{1,4}(?:[.,]\d+)*(?=[,.;:)!?]|$)`,
  String.raw`(?<![\p{L}\d])(?:\p{L}{1,2}|\d[\d.,:]*) \S+`,
].join('|'), 'gu');
const glue = (t) => t.replace(GLUE, (m) => (m.length > 28 ? m : `<span class="nw">${m}</span>`));
// Code never breaks inside a name. A path breaks only at a slash, backslash or space; a segment over
// 30 characters gets one break, at the hyphen nearest its middle.
const pieces = (seg) => {
  if (seg.length <= 30) return [seg];
  const cuts = [...seg.matchAll(/-/g)].map((m) => m.index + 1);
  if (!cuts.length) return [seg];
  const at = cuts.reduce((a, b) => (Math.abs(b - seg.length / 2) < Math.abs(a - seg.length / 2) ? b : a));
  return [seg.slice(0, at), seg.slice(at)];
};
const codeHtml = (c) => {
  if (c.length <= 24) return `<code class="nw">${esc(c)}</code>`;
  return `<code>${c.split(/(?<=[\\/ ])/).flatMap(pieces).map((p) => (p.length > 30 ? esc(p) : `<span class="nw">${esc(p)}</span>`)).join('<wbr>')}</code>`;
};
// Inline markup for plain strings: `code` and [[accent]] only, everything else is escaped.
// Punctuation after code stays with it, and a range of two codes (`1.18.12`–`1.18.15`) is one unit.
const md = (s) => {
  const parts = String(s ?? '').split(/(`[^`]+`|\[\[.+?\]\])/);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i % 2 === 0) { out.push(glue(esc(part))); continue; }
    if (part[0] === '[') { const hl = part.slice(2, -2); out.push(`<span class="hl${hl.length <= 24 ? ' nw' : ''}">${glue(esc(hl))}</span>`); continue; }
    const code = codeHtml(part.slice(1, -1));
    const next = parts[i + 1] ?? '';
    if (next === '–' && parts[i + 2]?.[0] === '`') {
      out.push(`<span class="nw">${code}–${codeHtml(parts[i + 2].slice(1, -1))}</span>`);
      parts[i + 1] = ''; parts[i + 2] = '``'; i += 2; continue;
    }
    const punct = next.match(/^[,.;:)»!?]/);
    if (punct) { out.push(`<span class="nw">${code}${esc(punct[0])}</span>`); parts[i + 1] = next.slice(1); continue; }
    out.push(code);
  }
  return out.join('');
};
const list = (v) => (v == null || v === '' ? [] : Array.isArray(v) ? v : [v]);
const plural = (n, one, few, many) => { const a = n % 10, b = n % 100; return `${n} ${a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many}`; };
const lowerFirst = (s) => (/^\p{Lu}\p{Ll}/u.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const words = (s) => new Set(String(s).toLowerCase().split(/[^\p{L}\d]+/u).filter(Boolean));
const plain = (s) => String(s ?? '').replace(/`[^`]*`/g, ' ');

for (const k of ['title', 'headline', 'stops', 'items']) if (!r[k]) fail(`missing "${k}"`);
const owners = Object.entries(r.owners ?? { you: 'Ты' });
if (owners.length > 6) warn.push(`${owners.length} owners: only 6 colours and shapes exist, merge some`);
const ownerCls = Object.fromEntries(owners.map(([id], i) => [id, `o${Math.min(i + 1, 6)}`]));
const ownerName = Object.fromEntries(owners);
const reader = owners[0][0];
const stops = r.stops;
const stopIds = new Set(stops.map((s) => s.id));
const KINDS = new Set(['now', 'milestone', 'nodate', 'done']);
const done = (r.done ?? []).map((d) => ({ ...d }));
// The done list hangs off the stop of kind "done", else (only when there is a done list) the stop "done" or the last one.
const doneStop = (stops.find((s) => s.kind === 'done') ?? (done.length ? stops.find((s) => s.id === 'done') ?? stops.at(-1) : null))?.id;
const kindOf = (s) => s.kind ?? (s.id === doneStop ? 'done' : '');
const infoStop = new Set(stops.filter((s) => s.info).map((s) => s.id));
for (const s of stops) if (s.kind && !KINDS.has(s.kind)) warn.push(`stop "${s.id}": unknown kind "${s.kind}", use now, milestone, nodate, done or none`);

let n = 0;
// Numbers follow the page order: stops in order, items in their JSON order inside a stop.
const items = stops.flatMap((s) => r.items.filter((it) => it.stop === s.id)).map((it) => ({ ...it, n: ++n }));
for (const d of done) d.n = ++n;
for (const it of r.items) {
  if (!stopIds.has(it.stop)) fail(`item "${it.title}": unknown stop "${it.stop}"`);
  if (!ownerCls[it.owner]) fail(`item "${it.title}": unknown owner "${it.owner}"`);
}
// The reader's colour means "this needs you"; the reader's other items render neutral.
const needs = (it) => it.ask ?? (it.owner === reader && it.stop !== doneStop && !infoStop.has(it.stop));
// Facts at an info stop are neutral whoever owns them, so the overview never reads them as open work.
const cls = (it) => (infoStop.has(it.stop) || (it.owner === reader && !needs(it)) ? 'info' : ownerCls[it.owner]);

// Ids, files, paths, versions and hyphen ranges must be in backticks (copy, find and wrapping depend on it).
// Standard names (UTF-8, SHA-256, GPT-4) are words, not ids. A path is lowercase segments with 2+ slashes,
// a glob or a trailing slash: "Done/Partly/Blocked" and "16/17/18" are lists, not paths.
const STANDARD = /^(?:UTF|SHA|ISO|GPT|COVID|RFC|IEEE|MD|AES|RSA|ECMA|ES|HTTP|TLS|USB|PCI)-/;
const PLAIN = [
  // One-letter prefixes count only with a number (X-037); H-1B is a visa, not an id.
  [/\b[A-Z]{1,6}-[A-Z\d]*\d[A-Z\d]*\b/g, 'an id', (m) => !STANDARD.test(m) && (/^[A-Z]{2}/.test(m) || /^[A-Z]-\d+$/.test(m))],
  [/https?:\/\/\S+|\b[a-z][\w-]*(?:\.[a-z][\w-]*)+\/[\w./-]*/g, 'a URL'],
  [/\b[a-z]+_[a-z_]+\b/g, 'a snake_case name'],
  [/\b[\w.-]+\.(?:md|mjs|cjs|ts|tsx|vue|json|html|ps1|sh|py|yml|yaml)\b/g, 'a file name'],
  [/(?<![\w.])(?:[a-z0-9_.-]*[a-z][a-z0-9_.-]*\/){2,}[a-z0-9_.*-]*|(?<![\w.])[a-z][\w.-]*\/(?:\*|(?=[\s,.;:)»]|$))/g, 'a path'],
  [/\b\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, 'a version'],
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, 'a commit hash'],
];
const lint = (where, s) => {
  const t = plain(s);
  for (const [re, what, ok = () => true] of PLAIN) { const m = (t.match(re) ?? []).find(ok); if (m) warn.push(`${where}: "${m.trim()}" looks like ${what}: put it in backticks`); }
  const big = t.match(/(?<![\d.,])\b\d{5,}\b(?![.,]\d)/);
  if (big) warn.push(`${where}: "${big[0]}" needs a thousands space ("37 035"), or backticks if it is a code`);
  if (/~\s?\d/.test(t)) warn.push(`${where}: "~" before a number: write «около 40» or «примерно на 40», as a person would say it`);
  const range = t.match(/(?<![\d-])\d{1,3}-\d{1,3}(?![\d-])/);
  if (range) warn.push(`${where}: "${range[0]}" is a range: use an en dash (–)`);
  const k = t.match(/\d[\d.,–]*\s?[Kk]\b/);
  if (k) warn.push(`${where}: "${k[0]}" uses a Latin K: write "тыс."`);
  // Only a date with a 4-digit year: `22.11` may be a version as well as a date.
  const date = String(s).match(/`(\d{1,2}\.\d{1,2}\.\d{4})`/);
  if (date) warn.push(`${where}: "${date[1]}" is a date: dates and counts are plain text, drop the backticks`);
};
for (const k of ['headline', 'sub', 'meta', 'footer']) if (r[k]) lint(k, r[k]);
for (const s of stops) if (s.note) lint(`stop "${s.id}" note`, s.note);

const SIZE = /\d[\d\s,.]*\s*(строк|файл|KB|КБ|МБ|MB|токен|lines?\b|files?\b|tokens?\b)/i;
const SHRINK = /меньше|больше|сократ|уменьш|экономи|−|→/i;
const HISTORY = /changelog|release notes|журнал изменений|git log|коммит/i;
const UNIT = /\$|€|₽|%|\bKB\b|\bMB\b|КБ|МБ|\bмс\b|\bms\b/;
const SYMBOLS = new Set(['$', '€', '₽', '%', 'KB', 'MB', 'GB', 'КБ', 'МБ', 'ГБ', 'мс', 'ms', 'с', 's']);
for (const it of items) {
  const w = (m) => warn.push(`#${it.n} ${m}`);
  const texts = [it.title, it.text, it.warn, it.how, it.checked, it.flag, it.src, it.barsNote, it.big?.note, it.effect?.text, it.effect?.how,
    ...(it.steps ?? []).flatMap((s) => [s.title, s.text]), ...list(it.more), ...(it.tags ?? []).map((t) => (Array.isArray(t) ? t[1] : t))];
  for (const s of texts) if (s) lint(`#${it.n}`, s);
  if ((it.title ?? '').length > 60) w('title over 60 chars: shorten, move the rest to "text"');
  if ((it.text ?? '').length > 220) w('text over 220 chars: keep 1-2 sentences, move the rest to "more"');
  if (it.who && it.who.length > 14) w(`"who" over 14 chars: at most 2 words, e.g. "Аня → ты"`);
  if (it.who && ![...words(it.who)].some((x) => words(ownerName[it.owner]).has(x))) w(`"who" (${it.who}) names someone other than owner "${ownerName[it.owner]}": add that person to "owners" and use them as owner`);
  if (it.steps?.length > 1 && it.steps.every((s) => s.must)) w('every step is "must": mark only the steps people skip at a cost');
  // Something the reader must act on says how: a command, steps, or one line on where to click or what to answer.
  if (needs(it) && !it.cmd && !it.steps && !it.how) w('needs the reader but says not how: add "how" (where to click or what to answer), "steps" or "cmd"');
  const stop = stops.find((s) => s.id === it.stop);
  if (needs(it) && /(?:^|[^\p{L}])(?:ничего не (?:нужно|надо)|ничего делать не надо|для сведения|факты)(?:[^\p{L}]|$)/iu.test(stop.note ?? '')) w(`stop "${stop.id}" says nothing is needed, yet this item needs the reader: set "info": true on the stop or "ask": false on the item`);
  if (it.figure && /(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\//i.test(it.figure)) w('figure loads an external URL: inline it, the file must work offline');
  if (it.figure && /<script/i.test(it.figure)) w('figure has a <script>: draw with SVG or HTML only');
  if (it.bars && !it.barsNote) w('bars have no "barsNote": say what they count');
  if (it.bars && !it.barsUnit && UNIT.test(`${it.barsNote ?? ''} ${it.big?.value ?? ''}`)) w('bars count a unit ($, KB, %, мс...) but have no "barsUnit"');
  if (typeof it.barsUnit === 'string' && !SYMBOLS.has(it.barsUnit.trim())) w(`barsUnit "${it.barsUnit}" is a word: use a symbol (${[...SYMBOLS].join(' ')}) or three forms ["обход", "обхода", "обходов"]`);
  if (Array.isArray(it.barsUnit) && it.barsUnit.length !== 3) w('barsUnit as a list needs three forms: ["обход", "обхода", "обходов"]');
  // Bars read best sorted; a time series keeps its order with "barsKeepOrder": true.
  const vals = (it.bars ?? []).map((b) => Number(b.value) || 0);
  if (vals.length > 2 && !it.barsKeepOrder && !vals.every((v, i) => !i || v <= vals[i - 1]) && !vals.every((v, i) => !i || v >= vals[i - 1])) w('bars are not sorted: sort them, or set "barsKeepOrder": true for a time series');
  if ((it.flag ?? '').length > 40) w('flag over 40 chars: a 1–4 word label; the reason goes in "text" or "more"');
  // History is not state: an ask built from a changelog may already be done. "checked" says what was looked at
  // now and when; it is printed on the card, so a fake one sits in front of the reader.
  if (needs(it) && HISTORY.test(`${it.src ?? ''} ${r.meta ?? ''} ${r.footer ?? ''}`) && !it.checked) w('needs the reader, and the source is history (changelog, git log, commits): look at the current state and write it in "checked" (what, when)');
  if (it.checked && /не\s*провер/i.test(it.checked)) w('"checked" says it was not checked: check it, or drop the ask and add a flag');
  if (it.checked && !/\d/.test(it.checked)) w('"checked" names what you looked at and when (a date or time), not just "да"');
  if (/провер|свер/i.test(it.src ?? '')) w('"src" says what was checked: that goes in "checked"; "src" only names the source');
  // Plain tags are one style: all code or all words.
  const plainTags = (it.tags ?? []).filter((t) => !Array.isArray(t)).map((t) => /^`[^`]+`$/.test(t));
  if (plainTags.includes(true) && plainTags.includes(false)) w('tags mix code and plain words: pick one style, or use [id, words] pairs');
  if (it.effect && !needs(it) && it.owner === reader) w('effect on an item that needs nothing from the reader: effect only where you propose or ship a change');
  // A total and its parts must agree when they share a unit; otherwise the check cannot tell and is skipped.
  if (it.big && it.bars && typeof it.barsUnit === 'string') {
    const v = String(it.big.value), unit = v.replace(/[\d\s.,−-]/g, '').trim();
    if (unit === it.barsUnit.trim()) {
      const total = Number(v.replace(/[^\d,.]/g, '').replace(',', '.')), sum = it.bars.reduce((a, b) => a + (Number(b.value) || 0), 0);
      if (Number.isFinite(total) && Math.abs(total - sum) > Math.max(1, total * 0.005)) w(`big says ${v} but the bars add up to ${sum.toLocaleString('ru-RU')}: reconcile them or add the missing part as a bar`);
    }
  }
  if (it.effect && !['measured', 'forecast'].includes(it.effect.basis)) w('effect.basis must be "measured" or "forecast"');
  if (it.effect?.basis === 'measured' && (!/\d/.test(it.effect.how ?? '') || /не провер/i.test(it.effect.how ?? ''))) w('a "measured" effect needs a number or sample in "how" and cannot be unchecked: otherwise it is "forecast"');
  // Size is never the reason for a change (owner, 2026-11-17). Only a size offered as the gain trips this:
  // a size and a comparison in the title or text of an item that is still open.
  const sizeText = `${it.title} ${it.text ?? ''}`;
  if (!it.effect && !it.costIsGoal && it.stop !== doneStop && !infoStop.has(it.stop) && SIZE.test(sizeText) && SHRINK.test(sizeText)) w('talks about size (lines, files, KB, tokens): give "effect" (what changes for the reader), or set "costIsGoal": true when the item is about cost');
  if (it.costIsGoal && !(SIZE.test(sizeText) && SHRINK.test(sizeText))) w('"costIsGoal" changes nothing here: drop it');
}
done.forEach((d) => { lint(`done #${d.n}`, d.text); list(d.more).forEach((m) => lint(`done #${d.n} more`, m)); });
// One shipped change is one done row: a card sharing a version, or two ids, with a done row repeats it.
const ticks = (s) => (String(s ?? '').match(/`[^`]+`/g) ?? []).map((x) => x.slice(1, -1));
const cardIds = (it) => new Set([...[it.title, it.text, it.src].flatMap(ticks), ...(it.tags ?? []).filter(Array.isArray).map((t) => String(t[0]).replace(/`/g, ''))]);
for (const it of items.filter((x) => x.stop !== doneStop)) {
  const mine = cardIds(it);
  for (const d of done) {
    const shared = ticks(d.text).filter((t) => mine.has(t));
    if (shared.some((t) => /^\d+\.\d+\.\d+$/.test(t)) || shared.length >= 2) { warn.push(`#${it.n} repeats done #${d.n} (${shared.join(', ')}): a shipped change is one done row; put what the reader should know in its "more"`); break; }
  }
}
if (items.filter((it) => it.effect).length > Math.max(1, items.length / 2)) warn.push('more than half the items carry "effect": keep it only where a change has a real effect on the reader not already in the title or text');
// The source is named once: in meta when there is one, else on the cards.
const firstWord = (s) => plain(s).trim().split(/[\s:,]+/)[0]?.toLowerCase();
const sources = (s) => new Set([...ticks(s), ...(String(s ?? '').match(/\b[\w.-]+\.(?:md|json|html)\b|changelog|git log/gi) ?? [])].map((x) => x.toLowerCase()));
const metaSrc = sources(r.meta), footSrc = sources(r.footer);
const both = [...metaSrc].filter((x) => footSrc.has(x) && !/^\d/.test(x));
if (both.length) warn.push(`meta and footer both name ${both.join(', ')}: say the source once`);
const cardSrc = items.filter((it) => it.src && [...sources(it.src)].some((x) => metaSrc.has(x) || footSrc.has(x)));
if (cardSrc.length >= 2) warn.push(`cards ${cardSrc.map((it) => '#' + it.n).join(', ')} repeat the source from meta or footer: say it once`);
const srcCount = {};
for (const it of items) for (const x of sources(it.src)) srcCount[x] = (srcCount[x] ?? 0) + 1;
const common = Object.entries(srcCount).find(([, c]) => c >= 3 && c >= 0.6 * items.length);
if (common) warn.push(`${common[1]} cards name ${common[0]} as their source: say it once in meta or the footer`);
if ((r.meta ?? '').length > 80) warn.push(`meta is ${r.meta.length} chars: keep it under 80, the rest goes to the footer`);
if (r.headline.length > 100) warn.push(`headline is ${r.headline.length} chars: keep it under 100, the rest goes to "sub" or a card`);
// Done rows that carry versions read newest first (or oldest first) within one product.
const byProduct = {};
for (const d of done) { const m = String(d.text).match(/^(.*?)`(\d+)\.(\d+)\.(\d+)`/); if (m) (byProduct[m[1].trim()] ??= []).push(+m[2] * 1e6 + +m[3] * 1e3 + +m[4]); }
for (const [prod, vs] of Object.entries(byProduct)) if (vs.length > 2 && !vs.every((v, i) => !i || v < vs[i - 1]) && !vs.every((v, i) => !i || v > vs[i - 1])) warn.push(`done rows of ${prod || 'the product'} are out of version order: sort them`);
const inStop = (s) => items.filter((i) => i.stop === s.id);
const lead = items.filter((i) => i.stop === stops[0].id && needs(i)).length;
// Only the highlighted count is checked: "[[3 пункта]]" must match the items at the first stop that need the reader.
const WORDS = { один: 1, одна: 1, одно: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10 };
const first = (r.headline.match(/\[\[([^\s\]]+)/) ?? [])[1]?.toLowerCase();
const saidN = first && (/^\d+$/.test(first) ? first : WORDS[first]);
// The sub may state the same count: "[[4 решения]]", "[[2 вопроса]]".
const subN = (r.sub ?? '').match(/\[\[(\d+|\p{L}+) (?:пункт|решени|вопрос|задач|дел)/u);
const subSaid = subN && (/^\d+$/.test(subN[1]) ? subN[1] : WORDS[subN[1].toLowerCase()]);
if (subSaid && Number(subSaid) !== lead) fail(`sub says ${subSaid}, but the first stop has ${lead} items that need "${owners[0][1]}"`);
if (saidN && Number(saidN) !== lead) fail(`headline says ${saidN}, but the first stop has ${lead} items that need "${owners[0][1]}": fix the headline or the items`);
for (const s of stops) if (!inStop(s).length && !(s.id === doneStop && done.length)) warn.push(`stop "${s.id}" is empty: drop it or move items there`);
if (r.project && r.meta && plain(r.meta).toLowerCase().startsWith(String(r.project).toLowerCase())) warn.push('meta starts with the project name, which the top bar already shows: drop it from meta');
// Quoted text keeps its own dashes: code spans, commands and figures are not checked.
const prose = JSON.stringify({ ...r, items: r.items.map(({ cmd, figure, ...it }) => it) }).replace(/`[^`]*`/g, '');
if (prose.includes('—')) warn.push('em dash found: use a colon, a comma or a full stop');
if (warn.length && !r.allowWarnings) {
  for (const m of warn) console.error('ERROR ' + m);
  fail(`${warn.length} problem(s) above. Fix the content; never rename or reword just to pass a check. If a check is wrong for this report, set "allowWarnings": true and say which one`);
}

const body = (v) => {
  const ps = list(v);
  return ps.length > 1 ? `<ul>${ps.map((p) => `<li>${md(p)}</li>`).join('')}</ul>` : `<p>${md(ps[0])}</p>`;
};
const more = (v, n) => (list(v).length ? `<details class="more"><summary class="tog"><span class="when-shut">Подробнее</span><span class="when-open">Свернуть</span><span class="sr">, пункт ${n}</span></summary><div class="more-body">${body(v)}</div></details>` : '');
const chip = (it) => `<a class="chip" data-o="${cls(it)}" href="#i${it.n}" aria-label="Пункт ${it.n}, ${esc(cls(it) === 'info' ? 'для сведения' : ownerName[it.owner])}">${it.n}</a>`;
const doneRange = () => {
  const a = done[0].n, b = done.at(-1).n, t = a === b ? `${a}` : `${a}–${b}`;
  return `<a class="chip" data-o="done" href="#${doneStop}" aria-label="Пункты ${t}, готово">${t}</a>`;
};
const stopCount = (s) => inStop(s).length + (s.id === doneStop ? done.length : 0);

const overview = stops.map((s) => {
  const chips = inStop(s).map(chip).join('') + (s.id === doneStop && done.length ? doneRange() : '');
  const name = chips ? `<a class="stn" href="#${esc(s.id)}" aria-label="${esc(s.name)}, ${plural(stopCount(s), 'пункт', 'пункта', 'пунктов')}">${md(s.name)}</a>` : `<span class="stn">${md(s.name)}</span>`;
  return `<li data-k="${kindOf(s)}"><span class="mark" aria-hidden="true"></span>${name}<span class="chips">${chips}</span></li>`;
}).join('\n');
// A stop's column grows with its chips and its name, so 7 numbers fit on one row and long names do not touch.
const cols = stops.map((s) => `minmax(0,${Math.max(1, (inStop(s).length + (s.id === doneStop && done.length ? 2 : 0)) / 3, s.name.length / 14).toFixed(2)}fr)`).join(' ');

const fmt = (v, unit) => {
  const t = typeof v === 'number' ? v.toLocaleString('ru-RU').replace(/\s/g, ' ') : String(v);
  if (!unit) return t;
  if (Array.isArray(unit)) return plural(Number(v) || 0, ...unit).replace(/^\S+/, t);
  return /^[$€£]$/.test(unit) ? unit + t : `${t} ${unit}`;
};
const bars = (it) => {
  const max = Math.max(...it.bars.map((b) => Number(b.value) || 0), 1);
  const len = Math.max(...it.bars.map((b) => String(b.label).length));
  // Short labels sit beside the bar (mono, so ch is exact); long ones go on their own line.
  const stack = len > 12;
  const rows = it.bars.map((b) => `<div class="bar" style="--p:${((Number(b.value) || 0) / max * 100).toFixed(1)}%;--c:var(--${b.hot ? 'o' : 'bar'})"><span>${md(b.label)}</span><i></i><b class="nw">${esc(fmt(b.value, it.barsUnit))}</b></div>`).join('');
  const label = [it.barsNote, ...it.bars.map((b) => `${b.label} ${fmt(b.value, it.barsUnit)}`)].filter(Boolean).join(', ');
  return `<figure class="bars${stack ? ' stack' : ''}"${stack ? '' : ` style="--lw:${len}ch"`} aria-label="${esc(label)}">${it.barsNote ? `<figcaption>${md(it.barsNote)}</figcaption>` : ''}${rows}</figure>`;
};
const visual = (it) => {
  const o = [];
  // Many steps, or 5+ steps holding a long code name, go in two rows so the name fits on one line.
  const longCode = it.steps?.some((s) => ticks(s.text).some((c) => c.length > 20));
  const wrapSteps = it.steps && (it.steps.length > 6 || (it.steps.length >= 5 && longCode));
  if (it.steps) o.push(`<ol class="pipe${wrapSteps ? ' wrap' : ''}" style="--n:${wrapSteps ? Math.ceil(it.steps.length / 2) : it.steps.length}">${it.steps.map((s) => `<li${s.must || s.main ? ` class="${[s.must && 'must', s.main && 'go'].filter(Boolean).join(' ')}"` : ''}>${s.must ? '<span class="req">обязательно</span>' : ''}<b>${md(s.title)}</b><span>${md(s.text ?? '')}</span></li>`).join('')}</ol>`);
  if (it.big) o.push(`<p class="big"><span class="bv">${md(it.big.value)}</span>${it.big.note ? `<small>${md(it.big.note)}</small>` : ''}</p>`);
  if (it.bars) o.push(bars(it));
  if (it.tags) o.push(`<ul class="tags">${it.tags.map((t) => Array.isArray(t) ? `<li><code class="id">${esc(String(t[0]).replace(/^`(.*)`$/, '$1'))}</code>${t[1] ? `<span>${md(t[1])}</span>` : ''}</li>` : `<li>${md(t)}</li>`).join('')}</ul>`);
  // figure is trusted raw SVG/HTML from the report author, kept in a scroll box so it never widens the page.
  if (it.figure) o.push(`<div class="figure" tabindex="0" role="group" aria-label="Рисунок к пункту ${it.n}">${it.figure}</div>`);
  return o.join('\n');
};
// A command gets a full-width block with a copy button; <wbr> after each separator lets long paths wrap there.
// A flag sticks to its value ("--channel telegram"); a path breaks only after its separators.
const cmdHtml = (c) => c.split(' ').reduce((acc, tok) => (/^-/.test(acc.at(-1) ?? '') && !/ /.test(acc.at(-1)) && !/^-/.test(tok) ? [...acc.slice(0, -1), `${acc.at(-1)} ${tok}`] : [...acc, tok]), [])
  .map((tok) => (/[\\/]/.test(tok) ? esc(tok).replace(/([\\/])/g, '$1<wbr>') : `<span class="nw">${esc(tok)}</span>`)).join(' ');
const cmd = (it) => list(it.cmd).map((c) => `<div class="cmd"><pre><code>${cmdHtml(c)}</code></pre><button type="button" class="btn copy">Копировать</button></div>`).join('\n');
// The owner is shown by colour, tick shape and legend; a badge appears only for a hand-off ("Аня → ты").
const who = (it) => (it.who ? `<span class="who" title="${esc(it.who)}">${esc(it.who)}</span>` : '');
const card = (it) => `<article class="card" id="i${it.n}" data-o="${cls(it)}">
<header class="card-h"><span class="num">${it.n}</span><h3>${md(it.title)}</h3>${who(it)}</header>
${it.text ? `<p class="body">${md(it.text)}</p>` : ''}
${it.warn ? `<p class="warn">${md(it.warn)}</p>` : ''}
${visual(it)}
${cmd(it)}
${it.how ? `<p class="act"><span class="lbl">Как</span><span>${md(it.how)}</span></p>` : ''}
${it.checked ? `<p class="act"><span class="lbl">Сверено</span><span>${md(it.checked)}</span></p>` : ''}
${it.effect ? `<div class="effect" data-b="${it.effect.basis === 'measured' ? 'measured' : 'forecast'}"><span class="eb">${it.effect.basis === 'measured' ? 'измерено' : 'прогноз'}</span><p>${md(it.effect.text)}</p>${it.effect.how ? `<p class="how">${md(it.effect.how)}</p>` : ''}</div>` : ''}
${it.flag ? `<span class="flag${it.flag.length > 40 ? ' long' : ''}">${md(it.flag)}</span>` : ''}
${it.src ? `<p class="src">${md(it.src)}</p>` : ''}
${more(it.more, it.n)}
</article>`;

// A done row with "more" is itself the disclosure. Dates are group headers, printed where they change;
// when every row shares one date it goes into the stop note instead.
const dates = [...new Set(done.map((d) => d.date ?? ''))];
const oneDate = dates.length === 1 ? dates[0] : '';
const doneRow = (d) => {
  const line = `<span class="num">${d.n}</span><span>${md(d.text)}</span>`;
  return list(d.more).length
    ? `<li><details class="more row"><summary class="line">${line}</summary><div class="more-body">${body(d.more)}</div></details></li>`
    : `<li><div class="line">${line}</div></li>`;
};
const doneList = () => `<ol class="done" data-o="done">${done.map((d, i) => `${!oneDate && (i === 0 || d.date !== done[i - 1].date) ? `<li class="dh">${md(d.date ?? '')}</li>` : ''}${doneRow(d)}`).join('\n')}</ol>`;

const route = stops.map((s) => {
  const its = inStop(s);
  const hasDone = s.id === doneStop && done.length > 0;
  if (!its.length && !hasDone) return '';
  const count = stopCount(s);
  // A note starting with the count's own number ("4 пункта · 4 вопроса") only repeats it.
  const dup = s.note && Number.parseInt(s.note, 10) === count;
  const note = [plural(count, 'пункт', 'пункта', 'пунктов'), hasDone && oneDate, !dup && s.note && lowerFirst(s.note)].filter(Boolean).join(' · ');
  return `<li class="station" id="${esc(s.id)}" data-k="${kindOf(s)}"><span class="mark" aria-hidden="true"></span>
<div class="st-h"><h2>${md(s.name)}</h2><p>${md(note)}</p></div>
<div class="cards">
${its.map(card).join('\n')}${hasDone ? doneList() : ''}
</div>
</li>`;
}).filter(Boolean).join('\n');

const infoUsed = items.some((it) => cls(it) === 'info');
const legend = owners.length > 1 || infoUsed
  ? `<ul class="legend">${owners.map(([id, label]) => `<li data-o="${ownerCls[id]}">${esc(label)}</li>`).join('')}${infoUsed ? '<li data-o="info">Для сведения</li>' : ''}</ul>`
  : '';
const css = readFileSync(new URL('./report.css', import.meta.url), 'utf8');
const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.title)}</title>
<script>try{var t=localStorage.getItem('report-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}</script>
<style>${css}</style>
</head>
<body>
<div class="wrap">
<header class="top${String(r.project ?? '').length > 12 ? ' long' : ''}"><b>${esc(r.project ?? '')}</b><span>${md(r.meta ?? '')}</span>
<div class="tools"><button type="button" class="btn" id="all">Раскрыть всё</button><button type="button" class="btn" id="theme">Тема: авто</button></div></header>
<section class="hero">
<h1${r.headline.length > 90 ? ' class="long"' : ''}>${md(r.headline)}</h1>
${r.sub ? `<p class="sub">${md(r.sub)}</p>` : ''}
<nav class="overview" aria-label="Пункты по времени"><ol style="--cols:${cols}">
${overview}
</ol></nav>
${legend}
</section>
<ol class="route">
${route}
</ol>
${r.footer ? `<footer>${md(r.footer)}</footer>` : ''}
</div>
<script>
(function(){var h=document.documentElement,b=document.getElementById('theme'),order=['auto','light','dark'],label={auto:'Тема: авто',light:'Тема: светлая',dark:'Тема: тёмная'};
function cur(){return h.dataset.theme||'auto'}function show(){b.textContent=label[cur()]}
b.onclick=function(){var n=order[(order.indexOf(cur())+1)%3];if(n==='auto')delete h.dataset.theme;else h.dataset.theme=n;try{n==='auto'?localStorage.removeItem('report-theme'):localStorage.setItem('report-theme',n)}catch(e){}show()};show();
var all=document.getElementById('all'),more=[].slice.call(document.querySelectorAll('details.more')),saved=null;
if(!more.length)all.hidden=true;
function sync(){var open=more.length&&more.every(function(d){return d.open});all.textContent=open?'Свернуть всё':'Раскрыть всё'}
all.onclick=function(){var open=!more.every(function(d){return d.open});more.forEach(function(d){d.open=open});sync()};
more.forEach(function(d){d.addEventListener('toggle',sync)});
addEventListener('beforeprint',function(){saved=more.map(function(d){return d.open});more.forEach(function(d){d.open=true})});
addEventListener('afterprint',function(){if(saved)more.forEach(function(d,i){d.open=saved[i]});saved=null});
[].forEach.call(document.querySelectorAll('.copy'),function(btn){btn.onclick=function(){
var code=btn.parentNode.querySelector('code'),text=code.textContent;
function done(ok){btn.textContent=ok?'Скопировано':'Выделено, нажми Ctrl+C';setTimeout(function(){btn.textContent='Копировать'},2000)}
function select(){var s=getSelection(),rg=document.createRange();rg.selectNodeContents(code);s.removeAllRanges();s.addRange(rg);var ok=false;try{ok=document.execCommand('copy')}catch(e){}done(ok)}
try{navigator.clipboard.writeText(text).then(function(){done(true)},select)}catch(e){select()}}})})();
</script>
</body>
</html>
`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
for (const m of warn) console.log('WARN (allowed) ' + m);
console.log(`ok ${out} (${items.length} items, ${done.length} done, ${(html.length / 1024).toFixed(1)} KB)`);
