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
// Safety stays where it was: only a prompt this plugin submitted (origin plugin, name makarasty-tools) carries an
// answer, and only the answer part of it counts; the question text beside it is the asking chat's own words and is read
// only to know what was answered.

export type Pair = { question: string; answer: string }

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

/** His answers in a prompt event: only from a prompt this plugin submitted. */
export function ownerAnswers(e: { text: string; origin?: { kind?: string; name?: string } }): Pair[] {
  return e.origin?.kind === 'plugin' && e.origin.name === 'makarasty-tools' ? deliveredPairs(e.text) : []
}
