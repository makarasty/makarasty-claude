// The person's answers as they reach a chat, read one way by every guard that waits for his word.
//
// His answer can come from five places: the dialog in the chat, a box button there (it arrives as his next prompt), a
// prompt he types there, the inbox chat, and his phone (Telegram). The last two reach the asking chat as a prompt this
// plugin submits (core.mjs deliveryText) or, for a dialog still open, as the dialog's own result. The app shows a
// plugin's prompt framed: "The makarasty-tools plugin sent a message:\n<text>\n\nThis is how Claude Code surfaces…".
// Each guard used to parse that prompt itself, anchored at its first word, and the frame hid every phone and inbox yes
// (2026-11-17: "Да, пушь" from the phone, push-guard refused, the chat asked again). So the parsing lives here, and a
// test (consent.test.ts) feeds every guard the prompt exactly as the app frames it.
//
// That prompt is text, and text proves nothing: the same words can come from a file, a page or another chat. It also
// never reaches the hook that would read it: the engine sends a plugin's own $.prompt.submit past the hook that called
// it, and the inbox timer runs inside this plugin's prompt.submit hook (2026-11-17: an inbox "Да, пушь" refused twice
// after the 1.19.56 frame fix). So a delivered answer counts as his word only beside the record below, which hook code
// writes at the moment he acts, before the answer file exists: his pick in the inbox chat's own dialog, his tap or
// reply on the phone (the bot checks his Telegram id), or his typed prompt in the inbox chat in the turn that answered
// the item. A model writes the answer file (`inbox.mjs answer`) and can write any prose, but never this record.

import type { EngineInterface } from 'claude-code'
import { safe } from '../skills/inbox/core.mjs'

export type Pair = { question: string; answer: string }
export type Heard = { at: number; via: 'dialog' | 'phone' | 'typed'; pairs: Pair[] }
type D = Pick<EngineInterface, 'env' | 'fs'>

// `$.env.get` takes a literal name. On Windows node's homedir() is USERPROFILE; Git Bash's HOME is a /c/... path.
export async function configDir($: D): Promise<string | undefined> {
  const cfg = await $.env.get('CLAUDE_CONFIG_DIR')
  if (cfg) return cfg.replace(/[\\/]+$/, '')
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  return home ? `${home.replace(/[\\/]+$/, '')}/.claude` : undefined
}

const fileId = (id: string): string => id.split('~').map(safe).join('~')
async function readJSON<T>($: D, path: string): Promise<T | undefined> {
  try { return JSON.parse(String(await $.fs.read(path)).replace(/^﻿/, '')) as T } catch { return undefined }
}
export async function writeHeard($: D, root: string, id: string, h: Heard): Promise<void> {
  await $.fs.write(`${root}/heard-answers/${fileId(id)}.json`, JSON.stringify(h))
}
export async function readHeard($: D, root: string, id: string): Promise<Heard | undefined> {
  const h = await readJSON<Heard>($, `${root}/heard-answers/${fileId(id)}.json`)
  return h && Array.isArray(h.pairs) ? h : undefined
}
/** The inbox's answer to item `id`, if the inbox gave one, and his act on record for it. */
export async function inboxAnswer($: D, id: string): Promise<{ byInbox: boolean; heard?: Heard }> {
  const dir = await configDir($)
  const root = `${dir}/makarasty/inbox`
  const ans = dir ? await readJSON<{ by?: string; standing?: boolean }>($, `${root}/answers/${fileId(id)}.json`) : undefined
  if (ans?.by !== 'inbox') return { byInbox: false }
  return { byInbox: true, heard: ans.standing ? undefined : await readHeard($, root, id) } // a standing rule is not his act
}

const FRAME = /^\s*The ([\w-]+) plugin sent a message:\s*/
const FRAME_TAIL = /\s*This is how Claude Code surfaces a prompt a plugin submits[\s\S]*$/

/** The text a plugin submitted, without the app's frame around it, and which plugin the frame names. */
export function unframe(text: string): { plugin?: string; text: string } {
  const m = FRAME.exec(text)
  return m ? { plugin: m[1], text: text.slice(m[0].length).replace(FRAME_TAIL, '') } : { text }
}

// A JSON string literal: core.mjs deliveryText writes question and answer with JSON.stringify, so a quote inside either
// cannot end it early. Older answers wrote them raw; those still read, unless the text holds a quote.
const STR = '"(?:[^"\\\\]|\\\\.)*"'
const lit = (s: string): string => { try { return JSON.parse(s) as string } catch { return s.slice(1, -1) } }
const LEAD_ASK = 'The person answered your question from the inbox (makarasty-tools inbox), in place of the dialog here: '
const LEAD_BOX = 'The person answered your end-of-turn question '

/** The question/answer pairs of an inbox-delivered answer (his tap on the phone, or his pick in the inbox chat). */
export function deliveredPairs(raw: string): Pair[] {
  const text = unframe(raw).text.trimStart()
  if (text.startsWith(LEAD_BOX)) {
    const m = new RegExp(`^(${STR}) from the inbox \\(makarasty-tools inbox\\): (${STR})`).exec(text.slice(LEAD_BOX.length))
    return m ? [{ question: lit(m[1]!), answer: lit(m[2]!) }] : []
  }
  if (text.startsWith(LEAD_ASK)) {
    const body = text.slice(LEAD_ASK.length)
    return [...body.matchAll(new RegExp(`(${STR}): (${STR})`, 'g'))].map((m) => ({ question: lit(m[1]!), answer: lit(m[2]!) }))
  }
  return []
}

