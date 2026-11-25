import type { Register } from 'claude-code'

// The owner's 14 days of chats (to 2026-11-25): the browser's javascript_tool timed out at 45 s 18 times while its pane was hidden, and
// every one ran a script that waits (setTimeout, requestAnimationFrame, polling): a hidden page throttles timers and never draws a
// frame. Three were a repeat of the same script in the same chat. The tool's error says "The Browser pane is currently hidden"; from then
// on a waiting script is refused with the way out, until a script runs (the pane is shown) or the mark is 10 minutes old.

export const TTL_MS = 10 * 60 * 1000
export const HIDDEN = /currently hidden/i
export const MESSAGE = 'the Browser pane is hidden, so a script that waits (a timer over 1 s, requestAnimationFrame, a polling loop) times out after 45 s: show the pane first (mcp__ccd_view__show_pane), or read the page instantly (get_page_text, read_page, find).'

const TIMER = /\bsetTimeout\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*?,\s*(\d[\d_]*)\s*\)/g

// Whether a script sits and waits: such a script is cut off in a hidden pane.
export function waits(script: string): boolean {
  if (/\b(?:requestAnimationFrame|setInterval)\s*\(/.test(script)) return true
  for (const m of script.matchAll(TIMER)) if (Number(m[1]!.replaceAll('_', '')) > 1000) return true
  if (/new\s+Promise\b/.test(script) && /\bsetTimeout\s*\(/.test(script) && !/\bsetTimeout\s*\([^;]*?,\s*\d[\d_]*\s*\)/.test(script)) return true
  return /\bwhile\s*\(|\bfor\s*\(\s*;\s*;/.test(script) && /\bawait\b|Date\.now|performance\.now/.test(script)
}

const marks = new Map<string, number>()

export const register: Register = on => {
  on('tool.call', { tool: /^mcp__.+__javascript_tool$/ }, async ($, e, next) => {
    let sid = ''
    try {
      if ((await $.env.get('MAKARASTY_PANE_GUARD')) === 'off') return next(e)
      sid = await $.session.id()
      const at = marks.get(sid)
      const i = e as unknown as { text?: unknown; script?: unknown; code?: unknown }
      if (at !== undefined && (await $.clock.now()) - at < TTL_MS && waits(String(i.text ?? i.script ?? i.code ?? ''))) return { deny: MESSAGE }
    } catch {
      return next(e)
    }
    const ran = await next(e)
    try {
      if (ran.deny !== undefined) return ran
      if (HIDDEN.test(ran.text ?? (typeof ran.result === 'string' ? ran.result : ''))) {
        marks.set(sid, await $.clock.now())
        if (marks.size > 50) marks.delete(marks.keys().next().value!)
      } else if (!ran.isError) marks.delete(sid)
    } catch {
      // The mark is a convenience: a failed clock or session read leaves the call's result as it is.
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__ccd_view__show_pane' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) marks.delete(await $.session.id().catch(() => ''))
    return ran
  }).catch(($, e, next) => next(e))
}
