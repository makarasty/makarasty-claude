import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
declare const setTimeout: (f: (v?: unknown) => void, ms: number) => unknown // the test runtime has it
import { proseQuestion } from './inbox.ts'

// A question asked only in the text of a reply reaches the inbox too. Kept apart from inbox.test.ts, which another
// chat edits for its strings.

test('the last question of a reply is found; code, statements and early questions are not', () => {
  expect(proseQuestion('Сделал.\n\nОстался мой временный лог `.openwith-catch.log`. Удалить его?')).toBe('Удалить его?')
  expect(proseQuestion('Готово, тесты зелёные.')).toBeUndefined()
  expect(proseQuestion('Почему так? Потому что кеш.\n\nДальше\n\nещё\n\nи ещё\n\nВсё сделано.')).toBeUndefined()
  expect(proseQuestion('Итог.\n\n```js\nconst a = b ? c : d\nif (x?) {}\n```\nГотово.')).toBeUndefined()
  expect(proseQuestion('1. Остальное готово.\n2. Нашёл ещё баг в `pdf.ts`. Сделать его тоже?')).toBe('Сделать его тоже?')
  // 2026-11-12: a question to the chat's own reviewer with more text after it, and a hold chat's «…» (?
  expect(proseQuestion('Отдал на ревью Opus с одним вопросом. Проиграется ли финальная цитата или пропадёт совсем? Если пропадёт, тест был прав.\n\n`z99-fix-static` ещё работает.')).toBeUndefined()
  expect(proseQuestion('02. «Patience» → лейбл «123 patients counted» (? "Patience"). Записал, скриншот сохранён.')).toBeUndefined()
})

function world(on: On, o: { self?: string } = {}) {
  const disk = new Map<string, string>([['/cfg/makarasty/inbox.on', 'x']])
  if (o.self) disk.set('/cfg/makarasty/inbox/self', o.self)
  const plain = (p: string): string => p.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg' })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.id', () => ({ value: 'chatA' }))
  on('session.cwd', () => ({ value: 'C:/work/app' }))
  on('session.messages', () => ({ value: [{ role: 'user' as const, text: 'почини логи', toolUses: [] }] }))
  on('fs.exists', (_$, e) => ({ value: disk.has(plain(e.path)) }))
  on('fs.read', (_$, e) => (disk.has(plain(e.path)) ? { value: disk.get(plain(e.path))! } : { deny: 'ENOENT' }))
  on('fs.write', (_$, e) => { disk.set(plain(e.path), e.text); return { value: undefined } })
  on('fs.list', (_$, e) => {
    const dir = `${plain(e.path)}/`
    const names = [...disk.keys()].filter((k) => k.startsWith(dir) && !k.slice(dir.length).includes('/')).map((k) => k.slice(dir.length))
    return names.length ? { value: names.map((name) => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) } : { deny: 'ENOENT' }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  const items = () => [...disk.keys()].filter((k) => k.startsWith('/cfg/makarasty/inbox/items/')).map((k) => JSON.parse(disk.get(k)!))
  return { clock, disk, items }
}
const turn = (answer: string, extra: object = {}) => ({ answer, reason: 'answer', durationMs: 5000, isAborted: false, turnId: 't1', ...extra }) as never

test('a reply ending with a question in prose becomes an inbox box item with the question and the tail', async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('Логи починил.\n\nОстался временный лог `.openwith-catch.log`, 32 байта. Удалить его?'))
  const it = w.items()
  expect(it.length).toBe(1)
  expect(it[0]).toMatchObject({ kind: 'choice', ask: 'Удалить его?', actions: [] })
  expect(it[0].recap).toContain('32 байта')
})

test('no item for a statement, a subagent turn, the inbox chat itself, or a turn that already asked formally', async ($, on) => {
  const w = world(on)
  await $.turn.complete(turn('Готово, тесты зелёные.'))
  await $.turn.complete(turn('Удалить?', { agentId: 'a1' }))
  expect(w.items().length).toBe(0)
  w.disk.set('/cfg/makarasty/inbox/items/chatA~toolu_9.json', JSON.stringify({ id: 'chatA~toolu_9', kind: 'choice', at: 999_000, session: 'chatA', cwd: 'C:/work/app', chat: 'c', ask: 'Запушить?' }))
  await $.turn.complete(turn('Запушить ветку?'))
  expect(w.items().length).toBe(1) // only the formal one
})

test('the inbox chat does not file its own prose questions', async ($, on) => {
  const w = world(on, { self: 'chatA' })
  await $.turn.complete(turn('Отправить это в darkkitty?'))
  expect(w.items().length).toBe(0)
})

test('a session start or plugin reload starts the inbox chat timer, so a new item wakes it with no prompt typed', async ($, on) => {
  const w = world(on, { self: 'chatA' })
  const clock = w.clock
  const woke: string[] = []
  on('prompt.submit', (_$, e) => { woke.push(e.text); return { text: e.text } })
  w.disk.set('/cfg/makarasty/inbox/items/chatB~t1.json', JSON.stringify({ id: 'chatB~t1', kind: 'choice', at: 1, session: 'chatB', cwd: 'C:/work/app', chat: 'c', ask: 'Запушить?' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: 'C:/work/app', surface: null, isInteractive: true } as never)
  await clock.advance(15000)
  for (let i = 0; i < 100 && !woke.length; i++) await new Promise((r) => setTimeout(r, 5))
  expect(woke[0]).toContain('- app: Запушить?')
})
