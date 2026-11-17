import type { Register } from 'claude-code'
import { fields } from './secret-guard.ts'

// Refuses code that adds a `shortcut:` (or older `ponytail:`) comment: a note aimed at an AI tool, which the person
// bans («No `shortcut:` comments», ~/.claude/CLAUDE.md 2026-11-16, after 173 such lines were found in his repos). A
// third-party plugin's session text asks for them in every chat and subagent, so the text ban alone does not hold:
// 355 such edits in 35 days, most by subagents, and 4 chats in the two days after the ban [M77]. Only added lines
// count: an edit that keeps an old one passes. Shell lines that write a file with one (heredoc, Set-Content, sed -i)
// are read too. MAKARASTY_COMMENT_GUARD=off drops it.

export const MESSAGE =
  'Not written: the new text adds a `shortcut:` comment. The person bans notes aimed at an AI tool in code; a comment ' +
  'says the why for the next human reader, in one line. Write the limit as a plain comment (for example "// Only ISO ' +
  'dates for now: the report page sends nothing else") or leave it out, then write again.'

// A comment marker at the line start, or after code (`x = 1 // shortcut: ...`).
const LINE = /(^\s*(\*|'|;+)|(^|\s)(\/\/+|#+|<!--|\/\*+|--))\s*(shortcut|ponytail):/i

// The comment lines `text` adds that `old` does not already hold.
export function added(text: string, old = ''): string[] {
  const kept = new Set(old.split(/\r?\n/).filter((l) => LINE.test(l)).map((l) => l.trim()))
  return text.split(/\r?\n/).filter((l) => LINE.test(l) && !kept.has(l.trim()))
}

// A shell line that writes a file and carries such a comment on one of its lines.
const WRITES = /(<<-?\s*['"]?\w+|>\s*\S|\b(Set-Content|Add-Content|Out-File|tee|writeFileSync|write_text)\b|\bsed\s+(-\w*i|--in-place)|\bopen\([^)]*['"][wa])/i
export const shellAdds = (cmd: string): boolean => WRITES.test(cmd) && added(cmd).length > 0

export const register: Register = on => {
  on('tool.call', { tool: /^(Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell)$/ }, async ($, e, next) => {
    let deny = false
    try {
      const i = e as Record<string, unknown>
      const cmd = typeof i.command === 'string' ? i.command : undefined
      const hit = cmd !== undefined ? /shortcut:|ponytail:/i.test(cmd) && shellAdds(cmd) : (() => { const f = fields(e); return /shortcut:|ponytail:/i.test(f.text) && added(f.text, f.old).length > 0 })()
      deny = hit && (await $.env.get('MAKARASTY_COMMENT_GUARD')) !== 'off'
    } catch {
      // A bug in this guard lets the write through rather than blocking every edit.
    }
    return deny ? { deny: MESSAGE } : next(e)
  }).catch(($, e, next) => next(e))
}
