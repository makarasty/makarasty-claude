import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { MESSAGE, TTL_MS, waits } from './pane-guard.ts'

const TOOL = 'mcp__Claude_Browser__javascript_tool'
const HIDDEN = 'Error: javascript_tool timed out after 45s. The Browser pane is currently hidden. The script was sent to the page.'

// The app beneath the hook: the page answers `results` in turn (an error text, or null for success); the clock is the test's.
function app(on: On, results: (string | null)[], clock: { now: number }, env: Record<string, string> = {}) {
  const log: string[] = []
  mock.env(on, env)
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: clock.now }))
  on('tool.call', (_$, e) => {
    log.push(e.tool)
    const err = results.shift()
    return err ? { result: err } : { result: 'ok', text: 'ok' }
  })
  return log
}
const js = (text: string) => ({ tool: TOOL, action: 'javascript_exec', text }) as never
const WAIT = 'await new Promise(r => setTimeout(r, 1500)); document.title'
const deny = (r: unknown) => (r as { deny?: string }).deny

test('which scripts wait: timers over a second, frames, intervals, polling; instant reads do not', () => {
  for (const s of [WAIT, 'setTimeout(() => go(), 5000)', 'requestAnimationFrame(f)', 'setInterval(f, 100)', 'while (!document.querySelector(".x")) await sleep(50)', 'await new Promise(r => setTimeout(r, ms))']) expect(waits(s)).toBe(true)
  for (const s of ['document.title', 'await new Promise(r => setTimeout(r, 300))', 'setTimeout(f, 1000)', 'for (const a of document.links) a.href', 'JSON.stringify(window.__s)']) expect(waits(s)).toBe(false)
})

test('after a hidden-pane timeout a waiting script is refused with the way out, an instant one runs', async ($, on) => {
  const clock = { now: 1_000_000 }
  const log = app(on, [HIDDEN], clock)
  expect(deny(await $.tool.call(js(WAIT)))).toBeUndefined()
  clock.now += 60_000
  expect(deny(await $.tool.call(js(WAIT)))).toBe(MESSAGE)
  expect(log).toEqual([TOOL])
  expect(deny(await $.tool.call(js('document.title')))).toBeUndefined()
})

test('no mark, no refusal: a waiting script runs when the pane was never reported hidden', async ($, on) => {
  const log = app(on, [], { now: 1 })
  expect(deny(await $.tool.call(js(WAIT)))).toBeUndefined()
  expect(log).toEqual([TOOL])
})

test('a successful script clears the mark', async ($, on) => {
  const log = app(on, [HIDDEN, null], { now: 1 })
  await $.tool.call(js(WAIT))
  await $.tool.call(js('document.title'))
  expect(deny(await $.tool.call(js(WAIT)))).toBeUndefined()
  expect(log).toHaveLength(3)
})

test('an error that is not the hidden pane does not mark it', async ($, on) => {
  app(on, ['Error: javascript_tool timed out after 45s. The script did not finish.'], { now: 1 })
  await $.tool.call(js(WAIT))
  expect(deny(await $.tool.call(js(WAIT)))).toBeUndefined()
})

test('the mark lasts 10 minutes', async ($, on) => {
  const clock = { now: 1 }
  app(on, [HIDDEN], clock)
  await $.tool.call(js(WAIT))
  clock.now += TTL_MS - 1
  expect(deny(await $.tool.call(js(WAIT)))).toBe(MESSAGE)
  clock.now += 2
  expect(deny(await $.tool.call(js(WAIT)))).toBeUndefined()
})

test('showing the pane clears the mark', async ($, on) => {
  app(on, [HIDDEN], { now: 1 })
  await $.tool.call(js(WAIT))
  await $.tool.call({ tool: 'mcp__ccd_view__show_pane' } as never)
  expect(deny(await $.tool.call(js(WAIT)))).toBeUndefined()
})

test('MAKARASTY_PANE_GUARD=off lets the waiting script run', async ($, on) => {
  app(on, [HIDDEN], { now: 1 }, { MAKARASTY_PANE_GUARD: 'off' })
  await $.tool.call(js(WAIT))
  expect(deny(await $.tool.call(js(WAIT)))).toBeUndefined()
})
