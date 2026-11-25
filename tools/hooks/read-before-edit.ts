import type { Register } from 'claude-code'

// The owner's 14 days of chats (to 2026-11-25): the harness refused an Edit 89 times with "File has not been read yet" and 49 times
// with "File has been modified since read"; the file was almost always read in a shell (cat, sed -n, Get-Content) or rewritten by the
// chat's own shell command. Each refusal cost a round trip of 12-21 s. The harness's read state is filled by a Read, so on that exact
// refusal the hook reads the file itself and runs the Edit once more. A Write is never touched: overwriting an unread file stays refused.

export const MAX_BYTES = 256 * 1024
export const STALE = /has not been read yet|has been modified since read/i
export const NOTE = 'The file was re-read just before this edit because the harness had no current read of it, so your earlier view of it may be out of date; the edit applied to what is on disk now.'

// What the model read: core's `text`, or a string result (a hook's own answer has no `text`).
const textOf = (r: { text?: string; result?: unknown }): string => r.text ?? (typeof r.result === 'string' ? r.result : '')

export const register: Register = on => {
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (!STALE.test(textOf(ran))) return ran
    try {
      if ((await $.env.get('MAKARASTY_READ_GUARD')) === 'off') return ran
      const path = (e as { file_path?: unknown }).file_path
      if (typeof path !== 'string' || !path) return ran
      const st = await $.fs.stat(path)
      if (st.kind !== 'file' || st.size > MAX_BYTES) return ran
      const read = await $.tool.call({ tool: 'Read', file_path: path } as never)
      if (read.deny !== undefined || read.isError) return ran
      const again = await next(e)
      // A second refusal is the honest answer (old_string no longer matches, or the file changed again): the model sees that one.
      return again.deny !== undefined || again.isError || STALE.test(textOf(again)) ? again : { ...again, context: [...(again.context ?? []), NOTE] }
    } catch {
      return ran
    }
  }).catch(($, e, next) => next(e))
}
