import type { Register } from 'claude-code'

// Catches an agent stuck in a loop in seconds: the same call failing the same way three times, or two failing
// calls taking turns three times. The engine lets a tool.call hook add a
// reminder to the result the model reads next (`context`), so the note costs no model turn and nothing is
// denied: work is never blocked. State is a module variable, bounded, never written to disk; a hot reload or a
// lost hooks worker starts it empty, which only delays a note.
export const NOTE_A = 'This exact command failed 3 times with the same output. Stop retrying it: read the error, change the approach, or ask the user.'
export const NOTE_B = 'These two commands keep taking turns and both fail with the same output each time (3 rounds). Stop alternating between them: read the errors, change the approach, or ask the user.'

const KEEP = 10 // calls remembered per loop
const SESSIONS = 50 // loops remembered; the least recently used one goes first
const GAP_MS = 10 * 60 * 1000 // a longer pause starts the history over
const HEAD = 2048 // chars from the start and
const TAIL = 512 // from the end of the output identify an outcome
// Calls that never count and never reset: reading and searching are what a stuck agent does between retries.
const IGNORED = /^(Read|Grep|Glob|LSP|ToolSearch)$/

type Entry = { key: string; fail: boolean; sig: string; at: number }
export type State = { calls: Entry[]; noted: Set<string> }
export type Call = { tool: string; input: string }
export type Outcome = { isError: boolean; text: string }

export const fresh = (): State => ({ calls: [], noted: new Set() })

// 32-bit FNV-1a, enough to tell two texts apart in a window of ten.
export const hash = (s: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

// What the call is, whatever its spelling: shell text with whitespace collapsed, a file edit by path and content.
export function callOf(e: Record<string, unknown>): Call {
  const tool = String(e.tool)
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  if (tool === 'Bash' || tool === 'PowerShell') return { tool, input: str(e.command).replace(/\s+/g, ' ').trim() }
  if (tool === 'Edit') return { tool, input: `${str(e.file_path)} ${hash(str(e.old_string) + '\0' + str(e.new_string))}` }
  if (tool === 'Write') return { tool, input: `${str(e.file_path)} ${hash(str(e.content))}` }
  const { tool_use_id: _a, agentId: _b, tool: _c, ...rest } = e
  return { tool, input: hash(JSON.stringify(rest) ?? '') }
}

// Output with what changes between two identical failures taken out: temp paths, timestamps, durations, hex ids
// and long digit runs (ids, sizes). Short standalone numbers stay: HTTP 502 and 503 are different outcomes.
// Head and tail both count: the cause of a failure is often the last lines.
export function normalize(text: string): string {
  return (text.length > HEAD + TAIL ? text.slice(0, HEAD) + '\n' + text.slice(-TAIL) : text)
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"]*?[\\/](?:Temp|tmp)[\\/][^\s'"]*/gi, '<tmp>')
    .replace(/\/tmp\/[^\s'"]*/g, '<tmp>')
    .replace(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:[.,]\d+)?)?(?:Z|[+-]\d\d:?\d\d)?/g, '<time>')
    .replace(/\d+(?:\.\d+)?\s?(?:ms|milliseconds?|seconds?|secs?|s|minutes?|mins?|m)\b/gi, '<dur>')
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d{5,}/g, '#')
}

const sigOf = (o: Outcome): string => hash(normalize(o.text))

// Records one finished call and says what to tell the model, or null. `at` is the clock in ms.
export function observe(st: State, call: Call, outcome: Outcome, at = Date.now()): string | null {
  const last = st.calls.at(-1)
  if (last && at - last.at > GAP_MS) { st.calls.length = 0; st.noted.clear() }
  const entry: Entry = { key: `${call.tool}\0${call.input}`, fail: outcome.isError, sig: sigOf(outcome), at }
  // A refusal by a guard counts as a failing outcome: its text is the output.
  // A success ends the trouble: the notes may speak again if it comes back.
  if (!entry.fail) { st.noted.clear(); if (st.calls.length && st.calls.at(-1)!.key !== entry.key) st.calls.length = 0 }
  st.calls.push(entry)
  if (st.calls.length > KEEP) st.calls.shift()
  if (!entry.fail) return null

  const c = st.calls
  const same = (a: Entry, b: Entry): boolean => a.fail && b.fail && a.key === b.key && a.sig === b.sig
  let id: string | null = null, note = ''
  const [a, b, d] = c.slice(-3)
  if (a && b && d && same(a, b) && same(b, d)) { id = `A\0${d.key}\0${d.sig}`; note = NOTE_A }
  else if (c.length >= 6) {
    const w = c.slice(-6)
    if (w[0]!.key !== w[1]!.key && w.every((x, i) => same(x, w[i % 2]!))) { id = `B\0${[w[0]!.key, w[1]!.key].sort().join('\0')}`; note = NOTE_B }
  }
  if (id === null || st.noted.has(id)) return null
  if (st.noted.size >= 20) st.noted.clear()
  st.noted.add(id)
  return note
}

// One state per loop (session id plus subagent id), the least recently used evicted past SESSIONS.
const states = new Map<string, State>()
export function stateFor(id: string): State {
  const st = states.get(id) ?? fresh()
  states.delete(id)
  states.set(id, st)
  if (states.size > SESSIONS) states.delete(states.keys().next().value!)
  return st
}

export const register: Register = on => {
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (IGNORED.test(String(e.tool)) || (await $.env.get('MAKARASTY_LOOP_GUARD')) === 'off') return ran
    const id = `${await $.session.id()}|${e.agentId ?? ''}`
    const call = callOf(e as unknown as Record<string, unknown>), at = await $.clock.now()
    if (ran.deny !== undefined) {
      // A refusal by a guard is a failing outcome, its text the output. It carries no context: the note rides on the text.
      const note = observe(stateFor(id), call, { isError: true, text: ran.deny }, at)
      return note ? { ...ran, deny: ran.deny + '\n' + note } : ran
    }
    const note = observe(stateFor(id), call, { isError: ran.isError === true, text: ran.text ?? '' }, at)
    return note ? { ...ran, context: [...(ran.context ?? []), note] } : ran
  }).catch(($, e, next) => next(e))
}
