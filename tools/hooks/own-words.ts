// What the person typed in a prompt, without the text the app or a paste put around it: <system-reminder> blocks
// (a side session's first message, linked-session notes), pastes, IDE context. Used where his words are consent: a
// chat start (said.jsonl) and a push (push-guard). Innermost blocks first, so nested and unclosed ones go too.
const BLOCKS = [
  /<system-reminder\b[^>]*>(?:(?!<system-reminder\b)[\s\S])*?(?:<\/system-reminder\s*>|$)/gi,
  /<pasted[_-]content\b[^>]*\/>/gi,
  /<pasted[_-]content\b[^>]*>[\s\S]*?(?:<\/pasted[_-]content[^>]*>|$)/gi,
  /<ide_[a-z_]+\b[^>]*>[\s\S]*?(?:<\/ide_[a-z_]+>|$)/gi,
  /\[Pasted text #\d+[^\]]*\]/g,
]
// A plugin's prompt the app shows in the person's place (it can arrive as a composer prompt): never his word.
// Another session's message is not his word either.
export const PLUGIN_FRAME = /The [\w-]+ plugin sent a message:|how Claude Code surfaces a prompt a plugin submits|^\s*(<cross-session-message|Another Claude session sent a message)/
export function ownWords(text: string): string {
  // A slash command: his words are its arguments (`/makarasty-tools:inbox подготовь shop к деплою`); app output is none.
  if (/^\s*<(command-name|command-message)/i.test(text)) return /<command-args>([\s\S]*?)<\/command-args>/i.exec(text)?.[1]?.trim() ?? ''
  if (/^\s*<(local-command-|task-notification)/i.test(text)) return ''
  let t = text
  for (let prev = ''; prev !== t;) { prev = t; for (const b of BLOCKS) t = t.replace(b, '') }
  return t === text ? text : t.trim()
}
