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

// Armed means THIS chat has a marker, notify/<session>.json. notify.mjs does nothing without its own marker (the resume flush of
// other chats' unsent messages runs only from the resumed chat's own marker), so another chat's marker is no reason to start
// node here. The id is checked as notify.mjs checks it: a path must not reach the folder.
// `$.env.get` takes a literal name, so the lookups are spelled out. On Windows node's homedir() is USERPROFILE, and Git
// Bash's HOME is a /c/... path the file API cannot open, so USERPROFILE goes first and a bad one just misses.
async function armed($: Dollar, sid: unknown): Promise<boolean> {
  if (typeof sid !== 'string' || !/^[\w-]+$/.test(sid)) return false
  const bases: string[] = []
  const cfg = await $.env.get('CLAUDE_CONFIG_DIR')
  if (cfg) bases.push(cfg)
  else for (const h of [await $.env.get('USERPROFILE'), await $.env.get('HOME')]) if (h && !bases.includes(`${h}/.claude`)) bases.push(`${h}/.claude`)
  for (const base of bases) {
    try {
      if (await $.fs.exists(`${base}/makarasty/notify/${sid}.json`)) return true
    } catch { /* unreadable: not armed here */ }
  }
  return false
}

// notify.mjs on the hook's own payload; it prints a note for the chat only on a resume.
const notify = ($: Dollar, e: unknown, timeoutMs: number) =>
  $.process.run(['node', `${$.plugin.root}/hooks/notify.mjs`], { stdin: JSON.stringify(e), timeoutMs })

const word = '(hand-?\\s?of{1,2}|х[еэ]нд-?\\s?оф{1,2})'
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
  return `This chat's context is at ${k}k tokens. Answer the person's message as usual; then say the context size once, save the state and notes (progress, open items, decisions) where a new chat could pick them up, and keep working. ` +
    `Offer a handoff with /makarasty-tools:handoff only if the person asked for one: a handoff costs answer quality in the next chat's first prompts [M49]. ` +
    `A fleet worker or coordinator ignores this line; its marks come from the watch (COORDINATOR CONTEXT), and its relaunch is in fleet-plan 8b. Do not offer or run a handoff unasked.`
}

export const afterCompact = (transcript: string): string =>
  `This chat was just compacted. The full conversation before it is still on disk, one JSON object ` +
  `per line: ${transcript}. When the summary lacks a detail that matters - the person's exact ` +
  `request, an error string, a decision - search that file for it (the Grep tool, or a short node script over ` +
  `the user and assistant lines) rather than guessing or asking again. Never read it whole.`

// Token economy rules, once per main session (SessionStart does not fire in subagents). MAKARASTY_ECONOMY=off drops it.
export const economy =
  'Token economy: spawn the narrowest agent (Explore for read-only search; fleet-coder for edits and fleet-reviewer for review if installed, ' +
  'else general-purpose) and set model and effort on every spawn: every Sonnet spawn high (coder or finder, never medium), reviewer Opus medium (high for diffs over ~400 lines or ' +
  'security), judgement and design Opus. Keep noisy work (test runs, screenshots, wide searches, logs) in subagents, routine screenshots at ' +
  'scale 0.5; show one whenever the person wants to see it. Read big files with ' +
  'the Grep tool and a line range; `git diff --stat` before a full diff; scope checks to the files you touched.'

// Named, not fixed: a terse-reply rule from another plugin made cheap subagents drop defects they had seen, and this line
// brought the report back without unasked fixes [M53]. Main sessions and subagents; MAKARASTY_FINDINGS=off drops it.
export const findings =
  'Findings: a defect you notice beyond the task goes in your reply (where, what is wrong); ask before fixing it. ' +
  'Never drop one to keep a reply short. Why: the person trusts your report and does not re-check it.'

const findingsOn = async ($: Dollar) => (await $.env.get('MAKARASTY_FINDINGS')) !== 'off'

// Habits that each cost hours in measured runs (Edit failures [M25] [M31], polling and waiting on questions [M52],
// "fixed" with no proof [M23]) and lived only in fleet docs, plus how far a session acts alone and how it reports: the
// standing answers of people who run many chats at once. A person's own limits go in profile.md. Rides with the economy
// text and its switch.
export const habits =
  "Working rules: Edit a file only after reading it with the Read tool. Wait for a task's completion notice; never poll with sleep loops. " +
  'Call a fix done only after a check you ran shows it, and say plainly what you did not check. Report in this order: what happened, why, ' +
  'what you did, what the person must do. Told it is urgent: the core change and one check, no extra review rounds, then list what you skipped. ' +
  'Do without asking, then report: run the scoped tests, typecheck or build; start the dev server the task needs, after checking its port ' +
  'and using one that already answers (never a second); fix what your own change broke. Ask first, listing the files: a commit, push, merge, release, delete, anything ' +
  'sent off this machine, stopping a process the person started, a real choice between approaches; otherwise take the recommended option and ' +
  "say so in one line. Other chats may share this checkout: edit and commit only your own files, name another chat's file, never touch or " +
  'discard it. A check that runs out of memory is too broad: narrow it, never raise --max-old-space-size or drop a worker cap someone set. ' +
  'New errors after a tool update: find the culprit before any rollback or pin. The code is wrong (fix it), another checker misses ' +
  'it (report the gap), or the new version has a bug (cite its issue or changelog, then pin with a comment linking it).'

// How a question reaches a person who runs many chats and answers hours later, often in free text [M63] [M67]. Once,
// here, instead of in every skill and command that asks. Rides with the economy text and its switch.
export const asking =
  'Asking the person: write each question so it stands alone (what happened, why it is asked, what each option does): ' +
  'they answer it hours later among other chats. Number every list they answer point by point. Work they already asked ' +
  'for is finished without asking "continue?". A step only they can do (restart an app and look, sign in, click in ' +
  'another app, check by eye) is one click or one command, with its link or exact path, asked in AskUserQuestion (or the ' +
  'end-of-turn ask) with the outcomes as options, never only in prose, where it gets missed. A delete-or-keep question says what the thing is, what made it, its size, what breaks without it, and your recommendation. ' +
  'Several questions go in one ask (AskUserQuestion), the recommended option first. A turn that ends waiting on the person ends with a ' +
  'message that stands alone: what happened, and the one thing to press or type.'

// The person's own facts (language, machine, channels, standing answers) live in <config>/makarasty/profile.md, written by
// them; shipped text names nobody's machine [M67]. Read only when the file is there; capped so a long file costs little.
export const PROFILE_MAX = 2000
async function profile($: Dollar): Promise<string[]> {
  const dir = await base($)
  const text = dir ? String(await $.fs.read(`${dir}/profile.md`).catch(() => '')).replace(/^﻿/, '').trim() : ''
  const cut = text.length > PROFILE_MAX ? ` [cut at ${PROFILE_MAX} characters: the rest of the file is not read]` : ''
  return text ? [`The person's profile (${dir}/profile.md, their own facts and standing answers; they override a skill's defaults): ${text.slice(0, PROFILE_MAX)}${cut}`] : []
}

const withEconomy = async ($: Dollar, out: { additionalContext?: string[] }, more: string[] = []) => {
  const rules = [...((await $.env.get('MAKARASTY_ECONOMY')) === 'off' ? [] : [economy, habits, asking]), ...((await findingsOn($)) ? [findings] : [])]
  const all = [...(out.additionalContext ?? []), ...more, ...rules, ...(await profile($).catch(() => []))]
  return all.length ? { ...out, additionalContext: all } : out
}

// Where the state lives, or undefined with no config dir, USERPROFILE or HOME: a hooks module imports nothing but claude-code (no
// os.homedir()), and a path built from nothing would write under the drive root.
async function base($: Dollar): Promise<string | undefined> {
  const cfg = await $.env.get('CLAUDE_CONFIG_DIR')
  if (cfg) return `${cfg}/makarasty`
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  return home ? `${home}/.claude/makarasty` : undefined
}

// A fleet coordinator or worker (fleet.sh records it): the run's own marks watch its context. Live while its run folder
// exists without FINISHED and the record, the run folder or its claimed or done folder was touched in the last two days.
async function fleetLive($: Dollar, dir: string, sid: string): Promise<boolean> {
  const rec = `${dir}/fleet-sessions/${sid}`
  let run: string
  try { run = (await $.fs.read(rec)).split('\n')[0]!.trim() } catch { return false }
  try {
    if ((await $.fs.stat(run)).kind !== 'dir' || (await $.fs.exists(`${run}/FINISHED`))) return false
    // The record is written only at chips or a take-over, so a run that works for days outlives it: the run folder, and the
    // claimed and done folders the queue touches on every claim and finish, count as the run's own pulse.
    const now = await $.clock.now()
    for (const p of [rec, run, `${run}/tasks/claimed`, `${run}/tasks/done`]) {
      if (now - (await $.fs.stat(p).then(s => s.mtimeMs, () => 0)) < 2 * 86400000) return true
    }
    return false
  } catch { return false }
}

// The hold command is collecting (its list file, makarasty/hold/<session>.md, starts with `collecting`): the person is
// dictating one item per message and the reminder waits for the codeword. A list untouched for a day no longer counts.
async function holding($: Dollar, dir: string, sid: string): Promise<boolean> {
  // The list is hold/<session>/index.md (skills/hold/hold.mjs) or the older single file hold/<session>.md.
  for (const f of [`${dir}/hold/${sid}/index.md`, `${dir}/hold/${sid}.md`]) {
    try {
      // PowerShell 5.1 writes a BOM
      if ((await $.fs.read(f)).replace(/^\uFEFF/, '').startsWith('collecting') && (await $.clock.now()) - (await $.fs.stat(f)).mtimeMs < 86400000) return true
    } catch { /* no such list */ }
  }
  return false
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
  if (!dir) return undefined
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
    if (await armed($, e.session_id)) void notify($, e, 20000).catch(() => {})
    return next(e)
  })
  on('classic.StopFailure', async ($, e, next) => {
    if (await armed($, e.session_id)) void notify($, e, 20000).catch(() => {})
    return next(e)
  })
  on('classic.Notification', async ($, e, next) => {
    if (PING.test(e.notification_type) && (await armed($, e.session_id))) void notify($, e, 20000).catch(() => {})
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (await armed($, e.session_id)) await notify($, e, 5000).catch(() => {})
    const out = await next(e)
    const note = await remind($, e).catch(() => undefined) // a reminder that fails must not cost the person their prompt
    return note ? { ...out, additionalContext: [...(out.additionalContext ?? []), note] } : out
  })

  // Resume: stdout of a SessionStart command hook is context for the chat, so notify.mjs's note is returned as such.
  on('classic.SessionStart', { source: 'resume' }, async ($, e, next) => {
    const out = await next(e)
    const note = (await armed($, e.session_id)) ? (await notify($, e, 10000).catch(() => undefined))?.stdout.trim() : ''
    return withEconomy($, out, note ? [note] : [])
  })

  // After a compaction the summary drops detail; the conversation is still on disk.
  on('classic.SessionStart', { source: 'compact' }, async ($, e, next) => {
    const out = await next(e)
    return withEconomy($, out, e.transcript_path ? [afterCompact(e.transcript_path)] : [])
  })

  for (const source of ['startup', 'clear'] as const) {
    on('classic.SessionStart', { source }, async ($, e, next) => withEconomy($, await next(e)))
  }

  // SessionStart does not fire in subagents, and cheap subagents are where the dropped defects showed.
  on('classic.SubagentStart', async ($, e, next) => {
    const out = await next(e)
    return (await findingsOn($)) ? { ...out, additionalContext: [...(out.additionalContext ?? []), findings] } : out
  })

  // A session id that comes back (resume) is live again: drop the ended marker, whatever the source.
  on('classic.SessionStart', async ($, e, next) => {
    try {
      const dir = await base($)
      const f = `${dir}/ended/${String(e.session_id ?? '').replace(/[^\w.-]/g, '_')}`
      if (dir && e.session_id && (await $.fs.exists(f))) await $.process.run(['node', '-e', 'require("fs").rmSync(process.argv[1],{force:true})', f], { timeoutMs: 3000 }) // shortcut: the engine has no fs delete event, so node removes it
    } catch { /* a marker that cannot be removed must not cost the session its start */ }
    return next(e)
  })

  // Every end reason but /clear leaves a marker: the desktop app keeps a finished chat's process alive, so pid alone says live.
  // /clear keeps the process running and its sessions file may still name the old id, so a marker would release a live chat.
  on('classic.SessionEnd', async ($, e, next) => {
    try {
      const dir = await base($)
      if (dir && e.session_id && e.reason !== 'clear') await $.fs.write(`${dir}/ended/${String(e.session_id).replace(/[^\w.-]/g, '_')}`, new Date(await $.clock.now()).toISOString())
    } catch { /* a marker that cannot be written must not cost the session its end */ }
    return next(e)
  })

  on('classic.SessionEnd', { reason: 'clear' }, async ($, e, next) => {
    if (await armed($, e.session_id)) await notify($, e, 5000).catch(() => {})
    return next(e)
  })
}
