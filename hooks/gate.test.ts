import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const DAY = 86400000
const unix = (p: string): string => p.replaceAll('\\', '/')
const entry = { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false }

// The fleet record the way fleet.sh writes it: the run path on its first line. fleet false: no record. finished: the run has
// FINISHED. gone: the run folder is gone. age: ms since the record was rewritten. `transcript` serves any other file read.
type Rec = { fleet: boolean; finished?: boolean; gone?: boolean; age?: number; runAge?: number }
function record(on: On, opts: Rec, transcript?: (path: string) => string | undefined) {
  const looked: string[] = []
  mock.clock(on, { now: 10 * DAY })
  on('fs.read', (_$, e) => {
    const p = unix(e.path)
    if (p.includes('/makarasty/fleet-sessions/')) { looked.push(p); return opts.fleet ? { value: 'C:/runs/r1\nmore' } : { deny: 'ENOENT' } }
    const t = transcript?.(p)
    return t === undefined ? { deny: 'ENOENT' } : { value: t }
  })
  on('fs.stat', (_$, e) => {
    const p = unix(e.path)
    if (p.includes('/fleet-sessions/')) return { value: { ...entry, mtimeMs: 10 * DAY - (opts.age ?? 1000) } }
    if (p.endsWith('/runs/r1') && !opts.gone) return { value: { ...entry, kind: 'dir' as const, mtimeMs: opts.runAge === undefined ? 0 : 10 * DAY - opts.runAge } }
    return { deny: 'ENOENT' }
  })
  on('fs.exists', (_$, e) => ({ value: unix(e.path).includes('/fleet-sessions/') ? opts.fleet : unix(e.path).endsWith('/runs/r1/FINISHED') && !!opts.finished }))
  return { looked }
}

// The world beneath the gate: which session files exist, what the .mjs hook exits with, and every run it asked for.
function world(on: On, opts: Rec & { exitCode?: number; stderr?: string; cfg?: string; noNode?: boolean }) {
  const runs: { argv: readonly string[]; stdin: string }[] = []
  mock.env(on, { CLAUDE_CONFIG_DIR: opts.cfg ?? 'C:\\cfg\\' })
  on('session.id', () => ({ value: 'sid-1' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('classic.Stop', () => ({}))
  const { looked } = record(on, opts)
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
  expect(w.looked).toEqual(['C:/cfg/makarasty/fleet-sessions/sid-1', 'C:/cfg/makarasty/fleet-sessions/sid-1'])
})

test('a record whose run FINISHED is not a fleet chat: no hook runs', async ($, on) => {
  const w = world(on, { fleet: true, finished: true })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.classic.Stop({ stop_hook_active: false })
  expect(w.runs.length).toBe(0)
})

test('a record whose run folder is gone is not a fleet chat: no hook runs', async ($, on) => {
  const w = world(on, { fleet: true, gone: true })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.classic.Stop({ stop_hook_active: false })
  expect(w.runs.length).toBe(0)
})

test('an old record with a run folder touched in the last two days is still a fleet chat', async ($, on) => {
  const w = world(on, { fleet: true, age: 3 * DAY, runAge: 1000 })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(w.runs[0]!.argv[1]).toMatch(/hooks\/fleet-memory\.mjs$/)
})

test('a record not rewritten for two days is not a fleet chat: no hook runs', async ($, on) => {
  const w = world(on, { fleet: true, age: 3 * DAY })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.classic.Stop({ stop_hook_active: false })
  expect(w.runs.length).toBe(0)
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

function stopWorld(on: On, opts: { fleet: boolean; first?: string; last?: string; big?: boolean; tail?: string }) {
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg' })
  on('classic.SubagentStop', () => ({}))
  const text = jsonl(opts.first ?? DISPATCH, opts.last ?? 'DONE')
  // big: fs.read rejects a transcript over 4 MiB, so the head comes from a node one-liner.
  record(on, { fleet: opts.fleet }, p => (p.endsWith('/a.jsonl') && !opts.big ? text : undefined))
  const ran: string[][] = []
  on('process.run', (_$, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: `${text.split('\n')[0]}\n${opts.tail === undefined ? '' : JSON.stringify(opts.tail)}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { ran }
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

test('a transcript over 4 MiB is still checked: the prompt from its head, the reply from the event', async ($, on) => {
  const w = stopWorld(on, { fleet: true, big: true })
  const r = await $.classic.SubagentStop(ev({ last_assistant_message: long }))
  expect(r.block).toContain('5 lines')
  expect(r.block).toContain('C:/runs/r1/reports/t7.md')
  expect(w.ran).toHaveLength(1)
  expect(w.ran[0]![3]).toBe('/a.jsonl')
})

test('a transcript over 4 MiB with a short reply passes', async ($, on) => {
  stopWorld(on, { fleet: true, big: true })
  expect((await $.classic.SubagentStop(ev({ last_assistant_message: 'DONE' }))).block).toBeUndefined()
})

// A second-level subagent (a coder or reviewer a fleet-lead spawned) ends with the SubagentHandback tool: its transcript's
// last rows are the tool_use and its result, with no text block, and the event carries the root session id plus its own agent id [M61].
const handback = (msg: string) => [
  { type: 'user', message: { role: 'user', content: DISPATCH } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'SubagentHandback', input: { message: msg } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'delivered' }] } },
].map(r => JSON.stringify(r)).join('\n')
const grandchild = (o: object = {}) => ev({ agent_id: 'a-deep', agent_type: 'makarasty:fleet-coder', ...o })

function handbackWorld(on: On, msg: string) {
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg' })
  on('classic.SubagentStop', () => ({}))
  record(on, { fleet: true }, p => (p.endsWith('/a.jsonl') ? handback(msg) : undefined))
}

test('a depth-2 subagent ending with SubagentHandback has its long reply blocked', async ($, on) => {
  handbackWorld(on, long)
  const r = await $.classic.SubagentStop(grandchild())
  expect(r.block).toContain('5 lines')
  expect(r.block).toContain('C:/runs/r1/reports/t7.md')
})

test('a depth-2 handback whose event carries an empty last_assistant_message is still capped', async ($, on) => {
  handbackWorld(on, long)
  expect((await $.classic.SubagentStop(grandchild({ last_assistant_message: '' }))).block).toContain('5 lines')
})

test('a short SubagentHandback passes', async ($, on) => {
  handbackWorld(on, 'DONE')
  expect((await $.classic.SubagentStop(grandchild())).block).toBeUndefined()
})

test('a depth-2 handback block asks for SubagentHandback again; an assistant-text block keeps the reply wording', async ($, on) => {
  handbackWorld(on, long)
  const b = (await $.classic.SubagentStop(grandchild())).block ?? ''
  expect(b).toContain('call SubagentHandback again with at most 3 lines')
})

test('a long reply in assistant text is told to reply, not to call SubagentHandback', async ($, on) => {
  stopWorld(on, { fleet: true, last: long })
  const b = (await $.classic.SubagentStop(ev({ last_assistant_message: long }))).block ?? ''
  expect(b).toContain('then reply with at most 3 lines')
  expect(b).not.toContain('SubagentHandback')
})

// Over 4 MiB: the node one-liner returns the last handback from the file's tail as line 2.
test('a transcript over 4 MiB whose agent ended with a long SubagentHandback is capped', async ($, on) => {
  const w = stopWorld(on, { fleet: true, big: true, tail: long })
  const r = await $.classic.SubagentStop(grandchild({ last_assistant_message: '' }))
  expect(r.block).toContain('5 lines')
  expect(r.block).toContain('call SubagentHandback again with')
  expect(w.ran).toHaveLength(1)
})

test('a transcript over 4 MiB with a short SubagentHandback passes', async ($, on) => {
  stopWorld(on, { fleet: true, big: true, tail: 'DONE' })
  expect((await $.classic.SubagentStop(grandchild({ last_assistant_message: '' }))).block).toBeUndefined()
})
