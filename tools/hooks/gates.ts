import type { EngineInterface, Register } from 'claude-code'

// Two features that are usually off, asked inside the engine instead of by a shell or node started on every prompt:
//
// 1. The phone notification (notify.mjs). It is armed per chat by a marker file, and almost never is. The command hooks
//    asked with `sh -c 'for f in .../notify/*.json'`: a shell per prompt, turn end and notification to learn "nothing".
//    Here `$.fs` asks, and node starts only when a marker exists, with the same stdin payload the command hook got.
//    UserPromptSubmit, SessionStart resume and SessionEnd clear wait for notify.mjs. Stop, StopFailure and Notification
//    do not: the old hooks were `async: true`, and a turn must not wait on a phone message that sleeps 1.5 s before it
//    sends. A fire that fails is dropped, as a failed async command hook was.
//
// 2. The handoff reminder (context.mjs). The engine already knows the context size (`$.session.usage().context.tokens`:
//    the last response's input + cache read + cache write, the figure context.mjs summed from the transcript tail), so a
//    prompt under the threshold costs one call. Same rules as context.mjs: the first reminder at MAKARASTY_HANDOFF_AT
//    (700000; 0 = off), again every MAKARASTY_HANDOFF_STEP (150000), once per level; a /compact that drops the size
//    re-arms it; a prompt that already asks for the handoff gets none; a live fleet session or a collecting hold gets
//    none. State is the same
//    file, makarasty/context/<session>.
//
// One file because the engine refuses two hooks on the same event without a matcher, and UserPromptSubmit is both:
// the notify call and the reminder share that one hook.
//
// What the engine cannot say is the size before the window's first response (a fresh, resumed or just-compacted chat):
// `tokens` is absent, and the prompt goes to context.mjs, which reads the transcript. That is one node start per such
// session instead of one per prompt. Differences from context.mjs: a stale fleet record stays on disk (the file API cannot
// delete; it is ignored the same), and "back under the threshold" writes level 0, which reads as no file.

type Dollar = Pick<EngineInterface, 'env' | 'fs' | 'process' | 'plugin' | 'session' | 'clock'>

const PING = /^(permission_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog)$/

// The shell glob `notify/*.json`: a dot-file is not matched.
export const isMarker = (name: string): boolean => name.length > 5 && name[0] !== '.' && name.endsWith('.json')

// `$.env.get` takes a literal name, so the lookups are spelled out. On Windows node's homedir() is USERPROFILE, and Git
// Bash's HOME is a /c/... path the file API cannot open, so USERPROFILE goes first and a bad one just misses.
async function armed($: Dollar): Promise<boolean> {
  const bases: string[] = []
  const cfg = await $.env.get('CLAUDE_CONFIG_DIR')
  if (cfg) bases.push(cfg)
  else for (const h of [await $.env.get('USERPROFILE'), await $.env.get('HOME')]) if (h && !bases.includes(`${h}/.claude`)) bases.push(`${h}/.claude`)
  for (const base of bases) {
    try {
      if ((await $.fs.list(`${base}/makarasty/notify`)).some(f => isMarker(f.name))) return true
    } catch { /* no such folder: nothing armed here */ }
  }
  return false
}

// notify.mjs on the hook's own payload; it prints a note for the chat only on a resume.
const notify = ($: Dollar, e: unknown, timeoutMs: number) =>
  $.process.run(['node', `${$.plugin.root}/hooks/notify.mjs`], { stdin: JSON.stringify(e), timeoutMs })

const word = '(hand-?\\s?off|хенд-?\\s?офф)'
// The prompt asks for the handoff already: only the command, an imperative, or the word nearly alone.
export const asksForHandoff = (prompt: string): boolean => {
  const p = prompt.trim()
  return /^\/(makarasty-tools:)?handoff\b/i.test(p) ||
    new RegExp(`^(сделай|давай|do|make)\\s.{0,40}${word}`, 'i').test(p) ||
    new RegExp(`^(\\S+\\s+)?${word}(\\s+\\S+)?[.!?]*$`, 'i').test(p)
}

// The level to remind at, or 0 for none: the first threshold crossed, then every step above it, once each.
export const levelFor = (tokens: number, at: number, step: number, lastIn: number): number => {
  const last = tokens < lastIn - step ? 0 : lastIn
  const level = at + Math.floor((tokens - at) / step) * step
  return tokens >= at && level > last ? level : 0
}

export const reminder = (tokens: number): string => {
  const k = Math.round(tokens / 1000)
  return `This chat's context is at ${k}k tokens. Answer the person's message as usual; then, unless this ` +
    `session is a fleet worker or the task ends within this turn, add one line offering to hand the rest ` +
    `to a fresh chat with /makarasty-tools:handoff, in the person's language; a fleet coordinator ignores this ` +
    `line; its marks come from the watch (COORDINATOR CONTEXT), and its relaunch is in fleet-plan 8b. Offer it at a natural break, ` +
    `not mid-edit: if this turn ends with work half-done, offer it at the next break. A handoff costs answer quality in the next chat's first prompts [M49], so offer it only where the work changes phase, not to shorten a chat that is going well. Do not run it unasked.`
}

export const afterCompact = (transcript: string): string =>
  `This chat was just compacted. The full conversation before it is still on disk, one JSON object ` +
  `per line: ${transcript}. When the summary lacks a detail that matters - the person's exact ` +
  `request, an error string, a decision - search that file for it (grep, or a short node script over ` +
  `the user and assistant lines) rather than guessing or asking again. Never read it whole.`

async function base($: Dollar): Promise<string> {
  const cfg = await $.env.get('CLAUDE_CONFIG_DIR')
  if (cfg) return `${cfg}/makarasty`
  return `${(await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''}/.claude/makarasty`
}

// A fleet coordinator or worker (fleet.sh records it): the run's own marks watch its context. A record counts for two
// days and while its run folder exists without FINISHED.
async function fleetLive($: Dollar, dir: string, sid: string): Promise<boolean> {
  const rec = `${dir}/fleet-sessions/${sid}`
  let run: string
  try { run = (await $.fs.read(rec)).split('\n')[0]!.trim() } catch { return false }
  try {
    return (await $.clock.now()) - (await $.fs.stat(rec)).mtimeMs < 2 * 86400000 &&
      (await $.fs.stat(run)).kind === 'dir' && !(await $.fs.exists(`${run}/FINISHED`))
  } catch { return false }
}

// The hold command is collecting (its list file, makarasty/hold/<session>.md, starts with `collecting`): the person is
// dictating one item per message and the reminder waits for the codeword. A list untouched for a day no longer counts.
async function holding($: Dollar, dir: string, sid: string): Promise<boolean> {
  const f = `${dir}/hold/${sid}.md`
  try {
    // PowerShell 5.1 writes a BOM
    return (await $.fs.read(f)).replace(/^\uFEFF/, '').startsWith('collecting') && (await $.clock.now()) - (await $.fs.stat(f)).mtimeMs < 86400000
  } catch { return false }
}

async function remind($: Dollar, e: { prompt: string; session_id: string; transcript_path: string }): Promise<string | undefined> {
  const at = Number((await $.env.get('MAKARASTY_HANDOFF_AT')) ?? 700000)
  const step = Number((await $.env.get('MAKARASTY_HANDOFF_STEP')) ?? 150000) || 150000
  if (!(at > 0) || !e.transcript_path || !e.session_id) return undefined
  if (asksForHandoff(String(e.prompt || ''))) return undefined

  const tokens = (await $.session.usage()).context.tokens
  if (tokens === undefined) {
    // The window has had no response yet: context.mjs reads the size from the transcript.
    const r = await $.process.run(['node', `${$.plugin.root}/hooks/context.mjs`], { stdin: JSON.stringify({ ...e, hook_event_name: 'UserPromptSubmit' }), timeoutMs: 5000 }).catch(() => undefined)
    return r?.stdout.trim() || undefined
  }
  const dir = await base($)
  const sid = String(e.session_id).replace(/[^\w.-]/g, '_')
  const file = `${dir}/context/${sid}`
  let lastIn = 0
  try { lastIn = Number(await $.fs.read(file)) || 0 } catch { /* no level yet */ }
  if (tokens < at && lastIn === 0) return undefined // the common prompt: nothing to do

  if (await fleetLive($, dir, sid)) return undefined
  if (tokens >= at && (await holding($, dir, sid))) return undefined // the level stays unwritten: it reminds after the codeword
  if (tokens < at) { await $.fs.write(file, '0'); return undefined } // back under after a /compact: the next crossing reminds again
  const level = levelFor(tokens, at, step, lastIn)
  if (!level) return undefined
  await $.fs.write(file, String(level))
  return reminder(tokens)
}

export const register: Register = on => {
  // Fire and forget: the turn ends without waiting for the message.
  on('classic.Stop', async ($, e, next) => {
    if (await armed($)) void notify($, e, 20000).catch(() => {})
    return next(e)
  })
  on('classic.StopFailure', async ($, e, next) => {
    if (await armed($)) void notify($, e, 20000).catch(() => {})
    return next(e)
  })
  on('classic.Notification', async ($, e, next) => {
    if (PING.test(e.notification_type) && (await armed($))) void notify($, e, 20000).catch(() => {})
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (await armed($)) await notify($, e, 5000).catch(() => {})
    const out = await next(e)
    const note = await remind($, e).catch(() => undefined) // a reminder that fails must not cost the person their prompt
    return note ? { ...out, additionalContext: [...(out.additionalContext ?? []), note] } : out
  })

  // Resume: stdout of a SessionStart command hook is context for the chat, so notify.mjs's note is returned as such.
  on('classic.SessionStart', { source: 'resume' }, async ($, e, next) => {
    const out = await next(e)
    if (!(await armed($))) return out
    const note = (await notify($, e, 10000).catch(() => undefined))?.stdout.trim()
    return note ? { ...out, additionalContext: [...(out.additionalContext ?? []), note] } : out
  })

  // After a compaction the summary drops detail; the conversation is still on disk.
  on('classic.SessionStart', { source: 'compact' }, async ($, e, next) => {
    const out = await next(e)
    if (!e.transcript_path) return out
    return { ...out, additionalContext: [...(out.additionalContext ?? []), afterCompact(e.transcript_path)] }
  })

  on('classic.SessionEnd', { reason: 'clear' }, async ($, e, next) => {
    if (await armed($)) await notify($, e, 5000).catch(() => {})
    return next(e)
  })
}
