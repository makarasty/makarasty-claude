import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

// A started session stays linked: every turn it ends wakes the chat that started it, which re-reads its whole context
// to relay a line. 197 such wakes in 14 days, 78% with no work, about 477K context each; the starters had started up to
// 36 sessions and detached almost none [M81]. The operator wants started sessions at the top level («пусть создаёт
// сразу на топ-уровне», 2026-11-18), so each is detached at once. wake_when_done: true keeps one linked.
const DETACH = 'mcp__ccd_session_mgmt__detach_session'
export const startedId = (text: string): string | undefined => /session_id: (local_[0-9a-f-]{36})/.exec(text)?.[1]
// A card the person clicked starts with no tool call here; the app says so in the next turn, naming the card's title.
export const clickedTitles = (text: string): string[] =>
  [...text.matchAll(/The user started your suggested background task task_\w+ \("([^"]+)"\)/g)].map((m) => m[1]!)
export const DETACHED = (id: string) =>
  `Detached ${id} to the top level (the operator's default): its turn ends will not wake this chat. Start a session with wake_when_done: true when this turn needs its result.`
export const REFUSED = (id: string, why: string) => `Detach of ${id} refused (${why.slice(0, 160)}): it stays linked and wakes this chat at each turn it ends.`

type Row = { sessionId?: string; title?: string; startedBy?: string }

async function off($: Pick<EngineInterface, 'env'>): Promise<boolean> {
  return (await $.env.get('MAKARASTY_DETACH')) === 'off'
}

export const register: Register = (on) => {
  on('tool.call', { tool: /^mcp__ccd_session__(start_session|hand_off_to_session)$/ }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined || r.isError || (e as unknown as { wake_when_done?: boolean }).wake_when_done === true || (await off($))) return r
    const id = startedId(r.text ?? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? '')))
    if (!id) return r // a proposal card or an offer: nothing started yet
    const d = await $.tool.call({ tool: DETACH, session_id: id } as never).catch((err: unknown): ToolCallResult => ({ deny: String(err) }))
    const line = d.deny || d.isError ? REFUSED(id, d.deny ?? String(d.text ?? '')) : DETACHED(id)
    return { ...r, context: [...(r.context ?? []), line] }
  }).catch(($, e, next) => next(e))

  // prompt.submit, not turn.start: the note can also arrive inside a running turn.
  on('prompt.submit', { text: /The user started your suggested background task/ }, async ($, e, next) => {
    const titles = clickedTitles(e.text)
    if (!titles.length || (await off($))) return next(e)
    const list = await $.tool.call({ tool: 'mcp__ccd_session_mgmt__list_sessions', linked: true, limit: 50 } as never).catch(() => undefined)
    const me = (await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')) ?? ''
    let rows: Row[] = []
    try { rows = JSON.parse(String(list?.text ?? list?.result ?? '[]')) as Row[] } catch { rows = [] }
    for (const row of rows) if (row.sessionId && row.startedBy === me && titles.includes(row.title ?? '')) await $.tool.call({ tool: DETACH, session_id: row.sessionId } as never).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))
}
