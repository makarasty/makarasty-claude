// render.mjs - the Telegram HTML renderer: the one place the layout of a phone message lives. The words come from
// strings.mjs (t); the decisions (which question, which options) come from the inbox's core.mjs. Another channel is
// another renderer over the same messages. No imports but strings.mjs: the hooks module runs without Node.
import { t } from './strings.mjs'

const cut = (/** @type {string} */ s, /** @type {number} */ n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Text for Telegram's HTML mode: only &, < and > are special there. Cut fields as plain text first, then escape. */
export const esc = (/** @type {string} */ s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// What reads as code in a chat's words: a `quoted` span, a path (C:\x\y, a/b/c, ~/x), a file name with a known
// extension, a commit hash. Set as <code>: monospace, copied by a tap, and never turned into a link (Telegram links
// "COMPLAINTS.md" as a domain, 2026-11-17).
const CODE = new RegExp([
  '`[^`\\n]+`',
  '[A-Za-z]:\\\\[^\\s"«»<>]+',
  // a path, not "yes/no": it starts at ~/ ./ ../ or /, or has three parts, or ends in a file name with an extension
  '(?<![\\w/.~])(?:~|\\.{1,2})?/[\\w.@*-]+(?:/[\\w.@*-]+)*/?',
  '[\\w.@*-]+(?:/[\\w.@*-]+){2,}/?',
  '[\\w.@*-]+/[\\w@*-]*\\.[A-Za-z]\\w{0,4}\\b',
  '[\\w.-]+\\.(?:md|ts|mts|mjs|cjs|js|jsx|tsx|json|jsonl|py|html|css|vue|sh|ps1|bat|yml|yaml|toml|txt|log|lock)\\b',
  '\\b(?=[0-9a-f]*\\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\\b',
].join('|'), 'g')
/** A chat's plain words as Telegram HTML: escaped, code-like parts as <code>; with md, also **bold** and *italic* (never
 *  inside code). */
export function rich(/** @type {string} */ s, md = false) {
  const plain = (/** @type {string} */ x) => {
    const e = esc(x)
    return md ? e.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<i>$2</i>') : e
  }
  let out = '', at = 0
  for (const m of String(s).matchAll(CODE)) {
    out += plain(s.slice(at, m.index)) + `<code>${esc(m[0].startsWith('`') ? m[0].slice(1, -1) : m[0])}</code>`
    at = m.index + m[0].length
  }
  return out + plain(s.slice(at))
}

/**
 * The phone message of an inbox item, the owner's pick B3 (2026-11-17): the question first and bold, so a lock screen shows
 * it; "project · kind · age" small under it, and a note under that when the phone cannot answer it whole.
 */
export function phoneHtml(/** @type {{ question: string, meta: string, note?: string }} */ m) {
  return `<b>${rich(cut(m.question, 600))}</b>\n<i>${esc(m.meta)}${m.note ? esc(`\n${m.note}`) : ''}</i>`
}

/**
 * The inline keyboard: options in one row when short (up to 3, 34 characters together), else one per row; "Details" last.
 * `multi`: a multi-select question, one option per row, a tap ticks it (`sel` holds the ticked indexes) and "Done" sends
 * them. `later`: one question of several, "Later" answers it so the others need not wait for it.
 */
export function phoneKeyboard(/** @type {string[]} */ options, more = true, lang = 'en', /** @type {{ multi?: boolean, sel?: number[], later?: boolean }} */ o = {}) {
  const btn = (/** @type {string} */ text, /** @type {string} */ data) => ({ text: cut(text, 40), callback_data: data })
  const row = !o.multi && options.length <= 3 && options.join('').length <= 34
  const label = (/** @type {string} */ x, /** @type {number} */ i) => (o.multi ? `${o.sel?.includes(i) ? '☑' : '☐'} ${x}` : x)
  const rows = row ? (options.length ? [options.map((x, i) => btn(x, `a${i}`))] : []) : options.map((x, i) => [btn(label(x, i), `a${i}`)])
  const tail = [...(o.multi ? [btn(t(lang, 'done1'), 'd')] : []), ...(o.later ? [btn(t(lang, 'later'), 's')] : []), ...(more ? [btn(t(lang, 'more'), 'm')] : [])]
  if (row && rows.length && tail.length === 1 && more) rows[0].push(tail[0]); else if (tail.length) rows.push(tail)
  return { inline_keyboard: rows }
}

/** What an answered message becomes: one grey line, no emoji, easy to scroll past and to read back later. */
export const collapsed = (/** @type {string} */ short, /** @type {string} */ outcome) => `<i>${rich(short)} — ${esc(cut(outcome, 200))}</i>`

/** One small grey line: a note, an acknowledgement, a hint. */
export const note = (/** @type {string} */ text) => `<i>${esc(text)}</i>`

/** The bot's /help: a bold title, one bullet per line, a grey note at the end. */
export function helpHtml(/** @type {string | undefined} */ lang) {
  return [
    `<b>${esc(t(lang, 'helpTitle'))}</b>`,
    ...['helpAny', 'helpQuestions', 'helpMore'].map((k) => `• ${esc(t(lang, k))}`),
    note(t(lang, 'helpNote')),
  ].join('\n')
}

/** /status: the count in bold, a line per waiting question (already cut as plain text), the inbox's state in grey. */
export function statusHtml(/** @type {string | undefined} */ lang, /** @type {number} */ count, /** @type {{ question: string, where: string, age: string }[]} */ items, /** @type {boolean} */ alive) {
  return [
    `<b>${esc(t(lang, 'statusWaiting', { n: count }))}</b>`,
    ...items.map((i) => `• ${rich(i.question)} <i>${esc(i.where)} · ${esc(i.age)}</i>`),
    note(t(lang, alive ? 'inboxUp' : 'inboxDown')),
  ].join('\n')
}

/** The explanation under a question: the model's text in a quote, and the hint; or the "no explanation" line. */
export function explainHtml(/** @type {string | undefined} */ lang, /** @type {string} */ question, /** @type {string | undefined} */ text) {
  return text ? `${question}\n\n<blockquote>${rich(text, true)}</blockquote>\n${note(t(lang, 'explainHint'))}` : `${question}\n\n${note(t(lang, 'explainNone'))}`
}

/**
 * A model's Markdown answer as Telegram HTML: **bold**, `code`, ``` blocks, # headings as bold, - lists as •. Short: the first
 * paragraphs up to about `head` characters are shown, the rest folds into an expandable quote; the whole is kept under 3800.
 * Converted paragraph by paragraph, so a cut never lands inside a tag.
 */
export function mdToTg(/** @type {string} */ md, head = 700) {
  const inline = (/** @type {string} */ s) => rich(s, true)
  const para = (/** @type {string} */ p) => {
    if (/^```/.test(p)) return `<pre>${esc(p.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, ''))}</pre>`
    return p.split('\n').map((l) => {
      const h = /^#{1,6}\s+(.*)$/.exec(l)
      if (h) return `<b>${inline(h[1])}</b>`
      const li = /^\s*[-*+]\s+(.*)$/.exec(l)
      return li ? `• ${inline(li[1])}` : inline(l)
    }).join('\n')
  }
  // A fenced block is one paragraph whatever blank lines it holds.
  const paras = String(md).trim().replace(/\r\n/g, '\n').split(/(```[\s\S]*?(?:```|$))/).flatMap((part) => (part.startsWith('```') ? [part] : part.split(/\n{2,}/))).map((p) => p.trim()).filter(Boolean)
  const shown = [], folded = []
  let n = 0
  for (const p of paras) { if (n + p.length <= head || !shown.length) shown.push(p); else folded.push(p); n += p.length }
  // A first paragraph too long even alone (tags and escapes grow it) is cut until it fits, never dropped: an empty text
  // is refused by Telegram and the answer would be lost.
  const fit = (/** @type {string[]} */ ps, /** @type {number} */ max) => {
    const out = []; let len = 0
    for (const p of ps) {
      let h = para(cut(p, max))
      for (let n = max; !out.length && h.length > max && n > 50; n = Math.floor(n * 0.7)) h = para(cut(p, n))
      if (len + h.length > max) break
      out.push(h); len += h.length + 2
    }
    return out.join('\n\n')
  }
  const top = fit(shown, 2000) || esc(cut(String(md).trim(), 1500))
  const rest = folded.length ? fit(folded, 3700 - top.length) : ''
  return rest ? `${top}\n<blockquote expandable>${rest}</blockquote>` : top
}
