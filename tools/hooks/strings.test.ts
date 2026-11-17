import { expect, test } from 'claude-code/testing'
import { phoneAsk, type Item } from '../skills/inbox/core.mjs'
import { phoneKeyboard } from '../skills/notify/render.mjs'
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
