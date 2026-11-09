import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The world beneath the gate: which session files exist, what the .mjs hook exits with, and every run it asked for.
function world(on: On, opts: { fleet: boolean; exitCode?: number; stderr?: string; cfg?: string; noNode?: boolean }) {
  const runs: { argv: readonly string[]; stdin: string }[] = []
  const looked: string[] = []
  mock.env(on, { CLAUDE_CONFIG_DIR: opts.cfg ?? 'C:\\cfg\\' })
  on('session.id', () => ({ value: 'sid-1' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('classic.Stop', () => ({}))
  on('fs.exists', ($, e) => { looked.push(e.path); return { value: opts.fleet } })
  on('process.run', ($, e) => {
    if (opts.noNode) throw new Error('node not found')
    runs.push({ argv: e.argv, stdin: e.init?.stdin ?? '' })
    return { value: { exitCode: opts.exitCode ?? 0, stdout: '', stderr: opts.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: 'ran' }))
  return { runs, looked }
}

test('a chat outside a fleet runs no process at all', async ($, on) => {
  const w = world(on, { fleet: false })
  expect((await $.tool.call({ tool: 'Bash', command: 'npm test' })).isError).not.toBe(true)
  expect((await $.tool.call({ tool: 'Edit', file_path: '/a', old_string: 'a', new_string: 'b' })).isError).not.toBe(true)
  expect(w.runs.length).toBe(0)
  // The engine hands the path on in the host's own separators.
  expect(w.looked.map((p) => p.split('\\').join('/'))).toEqual(['C:/cfg/makarasty/fleet-sessions/sid-1', 'C:/cfg/makarasty/fleet-sessions/sid-1'])
})

test('an unwatched tool is not even looked at', async ($, on) => {
  const w = world(on, { fleet: true })
  await $.tool.call({ tool: 'Read', file_path: '/a' })
  expect(w.looked.length + w.runs.length).toBe(0)
})

test('a fleet chat reaches the memory hook with the classic payload, and exit 2 refuses', async ($, on) => {
  const w = world(on, { fleet: true, exitCode: 2, stderr: 'RUN PAUSED\n' })
  const r = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(r.deny).toBe('RUN PAUSED')
  expect(w.runs[0]!.argv[1]).toMatch(/hooks\/fleet-memory\.mjs$/)
  const p = JSON.parse(w.runs[0]!.stdin)
  expect(p.hook_event_name).toBe('PreToolUse')
  expect(p.tool_name).toBe('Bash')
  expect(p.tool_input).toEqual({ command: 'npm test' })
})

test('an edit in a fleet chat goes to the contract hook, and exit 0 lets it through', async ($, on) => {
  const w = world(on, { fleet: true })
  const r = await $.tool.call({ tool: 'Write', file_path: '/a', content: 'x' })
  expect(r.isError).not.toBe(true)
  expect(w.runs[0]!.argv[1]).toMatch(/hooks\/fleet-contract\.mjs$/)
})

test('a hook that cannot start does not block the call', async ($, on) => {
  world(on, { fleet: true, noNode: true })
  const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(r.isError).not.toBe(true)
})

test('the stop guard blocks a fleet worker and leaves any other chat alone', async ($, on) => {
  const w = world(on, { fleet: true, exitCode: 2, stderr: 'claim still open' })
  const held = await $.classic.Stop({ stop_hook_active: false })
  expect(held.block).toBe('claim still open')
  expect(w.runs[0]!.argv[1]).toMatch(/hooks\/fleet-guard\.mjs$/)
})

test('outside a fleet the stop guard runs nothing', async ($, on) => {
  const w = world(on, { fleet: false })
  const done = await $.classic.Stop({ stop_hook_active: false })
  expect(done.block).toBeUndefined()
  expect(w.runs.length).toBe(0)
})

test('a stop guard that refuses without a word still blocks with a reason', async ($, on) => {
  world(on, { fleet: true, exitCode: 2, stderr: '' })
  const held = await $.classic.Stop({ stop_hook_active: false })
  expect(held.block).toBe('refused by the fleet')
})

test('a subagent call carries its agent id to the hook as agent_id', async ($, on) => {
  const w = world(on, { fleet: true })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1b2' })
  const p = JSON.parse(w.runs[0]!.stdin)
  expect(p.agent_id).toBe('a1b2')
  expect(p.tool_input).toEqual({ command: 'ls' })
})

// ---- SubagentStop: a dispatched worker's reply stays short ----

const DISPATCH = 'Read C:/runs/r1/tasks/claimed/t7/prompt.md and follow it.'
const long = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n')
const jsonl = (first: string, last: string) => [
  { type: 'user', message: { role: 'user', content: first } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: last }] } },
].map(r => JSON.stringify(r)).join('\n')

function stopWorld(on: On, opts: { fleet: boolean; first?: string; last?: string }) {
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg' })
  on('classic.SubagentStop', () => ({}))
  on('fs.exists', () => ({ value: opts.fleet }))
  on('fs.read', () => ({ value: jsonl(opts.first ?? DISPATCH, opts.last ?? 'DONE') }))
}
const ev = (o: object = {}) => ({ session_id: 's1', stop_hook_active: false, agent_id: 'a1', agent_type: 'worker', agent_transcript_path: '/a.jsonl', ...o })

test('a long reply from a dispatch prompt is blocked with the report path', async ($, on) => {
  stopWorld(on, { fleet: true, last: long })
  const r = await $.classic.SubagentStop(ev({ last_assistant_message: long }))
  expect(r.block).toContain('5 lines')
  expect(r.block).toContain('C:/runs/r1/reports/t7.md')
})

test('the reply is read from the transcript tail when the event lacks it', async ($, on) => {
  stopWorld(on, { fleet: true, last: 'x'.repeat(401) })
  expect((await $.classic.SubagentStop(ev())).block).toContain('401 chars')
})

test('a short reply passes', async ($, on) => {
  stopWorld(on, { fleet: true })
  expect((await $.classic.SubagentStop(ev({ last_assistant_message: 'a\nb\nDONE' }))).block).toBeUndefined()
})

test('a subagent not spawned from a dispatch prompt passes', async ($, on) => {
  stopWorld(on, { fleet: true, first: 'Find the bug in foo.ts', last: long })
  expect((await $.classic.SubagentStop(ev({ last_assistant_message: long }))).block).toBeUndefined()
})

test('a second stop (stop_hook_active) passes', async ($, on) => {
  stopWorld(on, { fleet: true, last: long })
  expect((await $.classic.SubagentStop(ev({ stop_hook_active: true, last_assistant_message: long }))).block).toBeUndefined()
})

test('outside a fleet nothing is read', async ($, on) => {
  stopWorld(on, { fleet: false, last: long })
  expect((await $.classic.SubagentStop(ev({ last_assistant_message: long }))).block).toBeUndefined()
})

test('a run path with a space still finds the report path', async ($, on) => {
  stopWorld(on, { fleet: true, first: 'Read C:/Users/John Doe/runs/r1/tasks/claimed/t7/prompt.md and follow it.', last: long })
  expect((await $.classic.SubagentStop(ev({ last_assistant_message: long }))).block).toContain('C:/Users/John Doe/runs/r1/reports/t7.md')
})

test('a reviewer is told to end with PASS or DEFECTS, not DONE', async ($, on) => {
  stopWorld(on, { fleet: true, first: 'Read C:/runs/r1/tasks/claimed/t7/review.md and follow it.', last: long })
  const b = (await $.classic.SubagentStop(ev({ last_assistant_message: long }))).block ?? ''
  expect(b).toContain('t7.review.md')
  expect(b).toContain('PASS or DEFECTS: <count>')
  expect(b).not.toContain('DONE')
})
