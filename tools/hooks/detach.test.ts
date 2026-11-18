import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { DETACHED, clickedTitles, startedId } from './detach.ts'

const KID = 'local_15eb08aa-4923-4bb3-9fc0-16d8a0dc2339'
const STARTED = `Started session "Probe" (session_id: ${KID}, name: detach-probe). It runs on its own; you get a note here when its turn ends.`

// The app beneath the hooks: start_session answers as the desktop app did on 2026-11-18, detach and list are recorded.
function app(on: On, o: { refuse?: boolean; env?: Record<string, string>; rows?: object[] } = {}) {
  const calls: { tool: string; session_id?: string }[] = []
  mock.env(on, { CLAUDE_CODE_HOST_SESSION_ID: 'local_parent', ...o.env })
  on('session.id', () => ({ value: 'parent' }))
  on('session.cwd', () => ({ value: 'C:\\work' }))
  mock.clock(on, { now: 1_000_000 })
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ deny: 'ENOENT' }))
  on('tool.call', (_$, e) => {
    const c = e as unknown as { tool: string; session_id?: string; initiation?: string }
    calls.push({ tool: c.tool, session_id: c.session_id })
    if (c.tool === 'mcp__ccd_session__start_session') return { result: c.initiation === 'own_initiative' ? 'Proposed "Probe" (task_id: task_ab12cd34)' : STARTED }
    if (c.tool === 'mcp__ccd_session__hand_off_to_session') return { result: STARTED }
    if (c.tool === 'mcp__ccd_session_mgmt__detach_session') return o.refuse ? { deny: 'shares this worktree' } : { result: `Session ${c.session_id} is now a top-level session.` }
    if (c.tool === 'mcp__ccd_session_mgmt__list_sessions') return { result: JSON.stringify(o.rows ?? []) }
    return { result: 'ok' }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const detached = () => calls.filter((c) => c.tool === 'mcp__ccd_session_mgmt__detach_session').map((c) => c.session_id)
  return { detached }
}

test('the id and clicked-card titles are read from the app texts', () => {
  expect(startedId(STARTED)).toBe(KID)
  expect(startedId('Proposed "x" (task_id: task_ab12cd34)')).toBeUndefined()
  const note = '<system-reminder>\nThe user started your suggested background task task_91d3975c ("Show loading in selects") in a separate local session.\n</system-reminder>'
  expect(clickedTitles(note)).toEqual(['Show loading in selects'])
  expect(clickedTitles('Сделай выгрузку')).toEqual([])
})

test('a started session and a hand-off are detached at once, and the model is told', async ($, on) => {
  const a = app(on)
  const r = await $.tool.call({ tool: 'mcp__ccd_session__start_session', initiation: 'user_asked', title: 'Probe', prompt: 'p', background: 'b' } as never)
  expect(a.detached()).toEqual([KID])
  expect((r as { context?: string[] }).context?.at(-1)).toBe(DETACHED(KID))
  await $.tool.call({ tool: 'mcp__ccd_session__hand_off_to_session', title: 'T', remaining_plan: 'p' } as never)
  expect(a.detached()).toEqual([KID, KID])
})

test('a proposal card and wake_when_done stay linked', async ($, on) => {
  const a = app(on)
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', initiation: 'own_initiative', title: 'Probe', prompt: 'p', background: 'b' } as never)
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', initiation: 'user_asked', title: 'Probe', prompt: 'p', background: 'b', wake_when_done: true } as never)
  expect(a.detached()).toEqual([])
})

test('MAKARASTY_DETACH=off leaves every session linked', async ($, on) => {
  const a = app(on, { env: { MAKARASTY_DETACH: 'off' } })
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', initiation: 'user_asked', title: 'Probe', prompt: 'p', background: 'b' } as never)
  expect(a.detached()).toEqual([])
})

test('a refused detach keeps the start and says it stays linked', async ($, on) => {
  const a = app(on, { refuse: true })
  const r = await $.tool.call({ tool: 'mcp__ccd_session__start_session', initiation: 'user_asked', title: 'Probe', prompt: 'p', background: 'b' } as never)
  expect(a.detached()).toEqual([KID])
  expect((r as { result?: string }).result).toBe(STARTED)
  expect((r as { context?: string[] }).context?.at(-1)).toMatch(/refused \(.*shares this worktree.*\): it stays linked/)
})

test('a card the person clicked is detached when its note arrives; another chat\'s session and other titles are not', async ($, on) => {
  const a = app(on, { rows: [
    { sessionId: 'local_kid1', title: 'Show loading in selects', startedBy: 'local_parent' },
    { sessionId: 'local_kid2', title: 'Other card', startedBy: 'local_parent' },
    { sessionId: 'local_kid3', title: 'Show loading in selects', startedBy: 'local_someone' },
  ] })
  await $.prompt.submit({ text: 'The user started your suggested background task task_91d3975c ("Show loading in selects") in a separate local session.' })
  expect(a.detached()).toEqual(['local_kid1'])
})
