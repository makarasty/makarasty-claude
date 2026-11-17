import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { BRIEF, LICENSE, MAIN, SUB, briefLacksDone, briefLicensesAsk, unrouted } from './routes.ts'

// The plugin's hooks module (gates.ts registers routes.ts and calls it from its one Stop hook) runs above these stubs.
function world(on: On, env: Record<string, string> = {}) {
  const ran: string[] = []
  for (const ev of ['Stop', 'SubagentStop'] as const) on(`classic.${ev}`, async () => ({}))
  on('tool.call', async (_$, e) => { ran.push(e.tool); return { result: 'ok' } })
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', MAKARASTY_SCREEN: 'off', ...env })
  mock.clock(on, { now: 1_000_000 })
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  return ran
}

// Real lines from 2026-11-10..17 [M76].
test('a named finding with no destination is caught; a routed one, a status line or a plain caveat is not', () => {
  expect(unrouted('`inboxes.page.dom.test.ts:629` не проходит проверку типов. Это ошибка не из этой работы, я её не трогал.')).toHaveLength(1)
  expect(unrouted('- Найден дефект, его я не трогал: на карточке предложения видно, что этот MBI занят другим пациентом.')).toHaveLength(1)
  expect(unrouted('**Странность, которую не разбирал.** У 17 пациентов кейс в другой организации.')).toHaveLength(1)
  expect(unrouted('**Не починено:**\n- 22: страница RPM Settings висит на скелетонах.')).toHaveLength(1)
  for (const ok of ['Сам не трогал, повесил чип «Kyiv».', 'localStorage не трогали.', 'Push не делал.', 'Не проверено: смена периода на экране.',
    'Шаблон ещё не сделан, жду выбор.', 'Не трогал: это файл другого чата.', 'Не исправил, записал в docs/FINDINGS-OPEN.md.', 'Не сделано: нет доступа к prod.'])
    expect(unrouted(ok)).toEqual([])
})

test('Stop: a done reply with an unrouted finding is refused once; an ask, a findings write or stop_hook_active lets it end', async ($, on) => {
  world(on)
  const last = 'Все 10 пунктов закрыты.\nЭто ошибка не из этой работы, я её не трогал.'
  expect(String((await $.classic.Stop({ stop_hook_active: false, last_assistant_message: last } as never)).block)).toContain(MAIN)
  expect((await $.classic.Stop({ stop_hook_active: true, last_assistant_message: last } as never)).block).toBeUndefined()
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'r', ask: 'Чинить тест inboxes.page?' } as never)
  expect((await $.classic.Stop({ stop_hook_active: false, last_assistant_message: last } as never)).block).toBeUndefined()
  await $.tool.call({ tool: 'Edit', file_path: '/w/docs/FINDINGS-OPEN.md', old_string: 'a', new_string: 'b' } as never)
  expect((await $.classic.Stop({ stop_hook_active: false, last_assistant_message: last } as never)).block).toBeUndefined()
  expect((await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Готово, тесты зелёные.' } as never)).block).toBeUndefined()
})

test('SubagentStop: a report that skips an item with no blocker is sent back once', async ($, on) => {
  world(on)
  const r = await $.classic.SubagentStop({ stop_hook_active: false, last_assistant_message: 'ponytail: OFF.\nОстальные тулы группы (mattpocock-skills, sunup) не разбирал: ты спрашивал про ponytail.' } as never)
  expect(String(r.block)).toContain(SUB)
  expect((await $.classic.SubagentStop({ stop_hook_active: false, last_assistant_message: 'sunup не разбирал: нет доступа к его репо.' } as never)).block).toBeUndefined()
})

test('a brief with three items and no "done when" is refused; with one, or with fewer items, it goes; off by env', async ($, on) => {
  const brief = 'Group thirdparty. Tools:\n1. ponytail\n2. mattpocock-skills\n3. sunup\nVerdict for ponytail: ON / OFF.'
  expect(briefLacksDone(brief)).toBe(true)
  expect(briefLacksDone(`${brief}\nDone when: a verdict with evidence for each of ponytail, mattpocock-skills, sunup.`)).toBe(false)
  expect(briefLacksDone('Find the caller of foo.\n- in src\n- in tests')).toBe(false)
  const ran = world(on)
  expect(await $.tool.call({ tool: 'Agent', prompt: brief } as never)).toEqual({ deny: BRIEF })
  await $.tool.call({ tool: 'Agent', prompt: `${brief}\nГотово, когда: вердикт по каждому из трёх.` } as never)
  expect(ran).toEqual(['Agent'])
})

test('a brief that licenses a product question with no investigation is refused, a session brief too; a fleet agent is not asked for "done when"', async ($, on) => {
  const item = 'Find which side is right per docs and make them agree; if it is a product call, ask the owner in one AskUserQuestion.'
  expect(briefLicensesAsk(item)).toBe(true)
  expect(briefLicensesAsk(`${item} Do it after the investigation pass (callers, git history, usage).`)).toBe(false)
  expect(briefLicensesAsk('Check the specific behaviour of junctions and ask nothing.')).toBe(false)
  const ran = world(on)
  expect(await $.tool.call({ tool: 'mcp__ccd_session__start_session', prompt: 'Close leftovers.', background: item } as never)).toEqual({ deny: LICENSE })
  await $.tool.call({ tool: 'Agent', subagent_type: 'makarasty:fleet-coder', prompt: 'Task t3:\n1. a\n2. b\n3. c' } as never)
  expect(ran).toEqual(['Agent'])
})

test('MAKARASTY_ROUTES=off drops every check', async ($, on) => {
  const ran = world(on, { MAKARASTY_ROUTES: 'off' })
  await $.tool.call({ tool: 'Agent', prompt: 'x:\n1. a\n2. b\n3. c' } as never)
  expect(ran).toEqual(['Agent'])
  expect((await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Готово. Это ошибка, я её не трогал.' } as never)).block).toBeUndefined()
})
