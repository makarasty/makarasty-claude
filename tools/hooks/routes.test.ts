import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { LICENSE, MAIN, SUB, briefDeny, briefLacksDone, briefLicensesAsk, unrouted } from './routes.ts'

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
  expect(await $.tool.call({ tool: 'Agent', prompt: brief } as never)).toEqual({ deny: briefDeny(brief) })
  await $.tool.call({ tool: 'Agent', prompt: `${brief}\nГотово, когда: вердикт по каждому из трёх.` } as never)
  expect(ran).toEqual(['Agent'])
})

// Real refused briefs, 2026-11-11..24 [M76]: 87 of 88 refusals had three list lines and no "Done when". Paths shortened.
const REAL_REFUSED = {
  folders: 'Run the walk below and judge the labels.\nFolders you may use:\n1. Folder C:/Users/mky/AppData/Local/Temp/claude/a/scratch\n2. Folder C:/Users/mky/AppData/Local/Temp/claude/b/scratch\n3. Folder C:/Users/mky/AppData/Local/Temp/claude/c/scratch\nReport what happened to you, not what designers should change.',
  rules: 'Goal: find standing rules the owner stated in chat.\nFour kinds:\n- product: a product decision (how a feature must behave)\n- pitfall: a tooling fact or trap agents got wrong\n- style: how he wants agents to talk to him\n- process: how agents must work\nOutput (your final message, at most 6 KB): one line per rule.\nMax 35 lines.',
  research: 'Research Claude Code team context.\n1. Every file Claude Code loads at session start for a project.\n2. Does Claude Code have a team memory feature?\n3. Can @import pull a file from the repo into a personal CLAUDE.md?\nReturn a compact list (max ~700 words), each point with its doc URL.',
  questions: 'Прочитай файл report.md. Ты его читатель.\nОтветь по-русски:\n1. Перескажи в 3-6 предложениях, о чём это.\n2. Что ты должен сделать сейчас, по шагам?\n3. Какие решения у тебя просят?\n4. Что не проверено или неизвестно?',
}
const STILL_REFUSED = 'Review these three plugins.\n1. Review plugin alpha for hooks that touch the shell.\n2. Review plugin beta for hooks that touch the shell.\n3. Review plugin gamma for hooks that touch the shell.\nGamma matters most.'

test('briefs that already say where they end, or list files and questions, are not refused; several tasks with no finish line still are', async ($, on) => {
  for (const [name, b] of Object.entries(REAL_REFUSED)) expect([name, briefLacksDone(b)]).toEqual([name, false])
  expect(briefLacksDone(STILL_REFUSED)).toBe(true)
  // Review of the first fix: three shapes the old rule refused and the loose one let through.
  expect(briefLacksDone('1. Make parse() tolerant. Return null on bad input.\n2. Add a cache to load().\n3. Rename foo to bar.')).toBe(true)
  expect(briefLacksDone('1. src/a.ts: fix X\n2. src/b.ts: fix Y\n3. src/c.ts: fix Z')).toBe(true)
  expect(briefLacksDone('1. a.ts \u2014 add Y\n2. b.ts \u2014 add Z\n3. c.ts \u2014 add W')).toBe(true)
  expect(briefLacksDone('Fix these:\n1. Folder C:/x/a\n2. BEFORE: C:/x/b\n3. `src/c.ts`')).toBe(false)
  for (const line of ['Finished when: all three read.', 'Success: a verdict each.', 'Deliver: a table.', 'Готово, когда: все три проверены.', 'Верни список с причинами.'])
    expect([line, briefLacksDone('Check:\n1. a thing\n2. b thing\n3. c thing\n' + line)]).toEqual([line, false])
  expect(briefLacksDone('Fix these:\n- `src/a.ts`\n- `src/b.ts`\n- `src/c.ts`')).toBe(false)
  const msg = briefDeny(STILL_REFUSED)
  expect(msg).toContain('Done when: Review plugin alpha for hooks; Review plugin beta for hooks; Review plugin gamma for hooks - each done')
  const ran = world(on)
  expect(await $.tool.call({ tool: 'Agent', prompt: STILL_REFUSED } as never)).toEqual({ deny: msg })
  await $.tool.call({ tool: 'Agent', prompt: REAL_REFUSED.research } as never)
  expect(ran).toEqual(['Agent'])
})

test('a brief that licenses a product question with no investigation is refused, a session brief too; a fleet agent is not asked for "done when"', async ($, on) => {
  const item = 'Find which side is right per docs and make them agree; if it is a product call, ask the owner in one AskUserQuestion.'
  expect(briefLicensesAsk(item)).toBe(true)
  expect(briefLicensesAsk(`${item} Do it after the investigation pass (callers, git history, usage).`)).toBe(false)
  expect(briefLicensesAsk('Check the specific behaviour of junctions and ask nothing.')).toBe(false)
  expect(briefLicensesAsk('If you hit a product call, ask.')).toBe(true)
  expect(briefLicensesAsk('If a design choice comes up, ask before changing it.')).toBe(true)
  expect(briefLicensesAsk('Если встретится продуктовое решение, спроси.')).toBe(true)
  expect(briefLicensesAsk("When the design choice is unclear, the owner's ask.")).toBe(false)
  expect(briefLicensesAsk('Find the owner of the design choice. If it is a product call, ask the owner which option.')).toBe(true)
  // The two real refusals (2026-11-11..25): "ask" described what the owner did or named a request, it told nobody to ask.
  expect(briefLicensesAsk('Read-only transcript analysis. When a chat builds a feature across 3+ files, does it design first? Sample 10 tasks (the owner asked for a feature; the chat edited 3+ files).')).toBe(false)
  expect(briefLicensesAsk("Check the ledger. When the reviewer runs not in production (reusing the existing production check), the owner's ask is ledger-2026-11-25.md.")).toBe(false)
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
