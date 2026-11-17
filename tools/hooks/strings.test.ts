import { expect, test } from 'claude-code/testing'
import { phoneAsk, type Item } from '../skills/inbox/core.mjs'
import { phoneKeyboard, rich } from '../skills/notify/render.mjs'
import { STRINGS, langOf, t } from '../skills/notify/strings.mjs'

// The one table of what the person reads on a phone channel, and the profile line that picks its language.
test('langOf: Russian only when the profile names it on its Language line', () => {
  expect(langOf(undefined)).toBe('en')
  expect(langOf('')).toBe('en')
  expect(langOf('Machine: 32 GB.')).toBe('en')
  expect(langOf('Language: English.\nNotes in Russian are fine.')).toBe('en')
  expect(langOf('Language: Russian')).toBe('ru')
  expect(langOf('\uFEFFLanguage: Russian, plain and short. Machine facts: x')).toBe('ru')
  expect(langOf('Language: русский')).toBe('ru')
  expect(langOf('Язык: русский')).toBe('ru')
  expect(langOf('Machine: x\nlanguage: RUSSIAN.')).toBe('ru')
})

test('t: the language, then English, then the key; {name} filled once, never re-read', () => {
  expect(t('ru', 'done')).toBe('готово')
  expect(t('en', 'done')).toBe('done')
  expect(t(undefined, 'done')).toBe('done')
  expect(t('de', 'done')).toBe('done')
  expect(t('ru', 'no.such.key')).toBe('no.such.key')
  expect(t('en', 'paused', { n: 2 })).toBe('paused: background jobs are still running (2)')
  expect(t('en', 'outNotSent', { pick: 'Yes', why: '{pick} $& x' })).toBe('Yes (not sent: {pick} $& x)')
  expect(t('en', 'paused')).toBe('paused: background jobs are still running ({n})')
})

test('both languages carry the same keys', () => {
  expect(Object.keys(STRINGS.ru).sort()).toEqual(Object.keys(STRINGS.en).sort())
})

const item = (extra: Partial<Item> = {}): Item => ({ id: 'c~1', kind: 'choice', at: 1_000_000, session: 'c', cwd: 'C:\\work\\proj', chat: 'x', ask: 'Push the branch?', actions: ['Yes', 'No'], ...extra })

test('phoneAsk: English with no language, Russian with ru, the same decisions in both', () => {
  const en = phoneAsk(item(), 1_000_000 + 3 * 60000)
  const ru = phoneAsk(item(), 1_000_000 + 3 * 60000, 'ru')
  expect(en.html).toBe('<b>Push the branch?</b>\n<i>proj · yes/no · 3 min</i>')
  expect(ru.html).toBe('<b>Push the branch?</b>\n<i>proj · да/нет · 3 мин</i>')
  expect({ ...en, html: '', message: null }).toEqual({ ...ru, html: '', message: null })
  expect(en.message).toEqual({ question: 'Push the branch?', meta: 'proj · yes/no · 3 min', note: '' })
  expect(en.options).toEqual(['Yes', 'No'])
  const card = (lang?: string) => phoneAsk(item({ kind: 'card', title: 'Log cleanup' }), 1_000_000 + 2 * 3600e3, lang)
  expect(card().html).toBe('<b>Start "Log cleanup"?</b>\n<i>proj · card · 2 h\nstart it from the inbox on the computer</i>')
  expect(card('ru').html).toBe('<b>Запустить «Log cleanup»?</b>\n<i>proj · карточка · 2 ч\nзапуск из инбокса на компьютере</i>')
})

test('phoneKeyboard: the details button is in the language', () => {
  expect(phoneKeyboard(['Yes', 'No']).inline_keyboard[0]!.at(-1)!.text).toBe('❔ Details')
  expect(phoneKeyboard(['Yes', 'No'], true, 'ru').inline_keyboard[0]!.at(-1)!.text).toBe('❔ Подробнее')
  expect(phoneKeyboard(['Yes', 'No'], false, 'ru').inline_keyboard[0]).toHaveLength(2)
})

// Paths, file names, code and commit hashes read as <code>: monospace, copied by a tap, never a link (Telegram linked
// "COMPLAINTS.md" as a domain, 2026-11-17). Plain words with a slash stay words.
test('rich: code-like parts become <code>, "yes/no" and HTML specials stay text', () => {
  expect(rich('записка в docs/COMPLAINTS.md, коммит 98118dc')).toBe('записка в <code>docs/COMPLAINTS.md</code>, коммит <code>98118dc</code>')
  expect(rich(String.raw`правит ` + '`push-guard`' + String.raw` в C:\Users\x\a.ts и tools/hooks/*.ts`)).toBe(String.raw`правит <code>push-guard</code> в <code>C:\Users\x\a.ts</code> и <code>tools/hooks/*.ts</code>`)
  expect(rich('yes/no, да/нет, a/b, 2026, decade')).toBe('yes/no, да/нет, a/b, 2026, decade')
  expect(rich('A & <b>')).toBe('A &amp; &lt;b&gt;')
  expect(rich('**bold** in `a*b*c`', true)).toBe('<b>bold</b> in <code>a*b*c</code>')
})
