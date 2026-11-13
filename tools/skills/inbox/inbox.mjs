#!/usr/bin/env node
// inbox.mjs - the file side of the cross-chat inbox. The hook in every chat (tools/hooks/inbox.ts) writes items; the
// inbox chat lists and answers them here; the asking chat's hook waits here for the answer. Layout: core.mjs.
//
//   node inbox.mjs on | off | status        switch the inbox for every chat of this Claude config dir; status says when it last got an item, woke, carried an answer
//   node inbox.mjs test                     a check item from a pretend chat: the inbox chat should wake with it by itself
//   node inbox.mjs watchdog                 run in the inbox chat in the background; exits (and wakes it) only when the wake broke
//   node inbox.mjs list [--take]            pending items, explained, oldest first; marks this chat as the inbox (not while
//                                           another inbox chat is alive, unless --take)
//   node inbox.mjs scan                     file the questions waiting in live chats of every account that have no item (list does it when this chat becomes the inbox)
//   node inbox.mjs show <id>               the whole item as JSON (a card's full brief)
//   node inbox.mjs answer <id> [text]       answer one item (text, or a JSON map on stdin); first answer wins
//   node inbox.mjs done <id>                the chat answered it itself (dialog, box button, card click, Esc)
//   node inbox.mjs wait <id>[,<id>...] <ms> block until every item is answered; prints the answer JSON (exit 3: timed out)
//   node inbox.mjs push <id>                one phone message for the item through notify.mjs, once
//   node inbox.mjs open <id>|local_<id>     bring that chat up in the app window of its own account (profile)
//   node inbox.mjs start <profile> <folder> <name> --said "<his words>" [--model m] [--effort e] [--mode default|plan|auto]
//                                           a new chat in that folder on that profile's account, named <name>; then SendMessage
//                                           the brief to <name>. Refused (2) when <config>/makarasty/dispatch.off exists or --said
//                                           (15+ chars, 3+ words) is not in the person's own prompts of the last 24 h (said.jsonl; one prompt, one
//                                           start). Queued (4) while a Claude window is in front or under 2 GiB RAM is free.
//   node inbox.mjs start <profile> <folder> <name> --standing "<words>" --relaunch-of <local_app id>
//                                           the other consent, for a chat relaunching itself at ~700K context: <words> (15+ chars) must be
//                                           in a line of <config>/makarasty/answers.md about a relaunch at 700K; the old chat must be live,
//                                           on <profile>, in <folder>; one standing start per old chat. Not together with --said.
//   node inbox.mjs start --drain            retry queued starts, oldest first (and failed ones under 3 tries, 10 min apart); stops after the first that runs
//   node inbox.mjs starts                   queued and recent starts
//   node inbox.mjs children <local_id>     app ids of the chats that chat started, one per line
//   node inbox.mjs report on|off [chat id]  that chat (default: the one running this) sends finish reports, or stops
//   node inbox.mjs reports                  every finish report of the last 3 days, shown or not
//   node inbox.mjs follow <chat>            finish reports on for a chat of any account: app id, session id, a piece of
//                                           its title, or its project (several matches: the candidates, exit 1)
//   node inbox.mjs mute <chat>              finish reports off for it (its questions still come)
//   node inbox.mjs followed                 the chats followed, then the busy ones that are not
//
// Exit 0 ok, 1 refused (already answered, unknown id, bad answer), 2 bad arguments, 3 wait timed out.

import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { freemem, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPORT_TTL_MS, TTL_MS, UNSEEN_REPORT_TTL_MS, clean, contextOf, expired, itemId, normalizeAnswer, pushText, render, renderReports, safe } from './core.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const base = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'makarasty')
const root = join(base, 'inbox')
const dir = (/** @type {string} */ d) => { const p = join(root, d); mkdirSync(p, { recursive: true }); return p }
const readJSON = (/** @type {string} */ p) => { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, '')) } catch { return undefined } }
const say = (/** @type {string} */ s) => process.stdout.write(`${s}\n`)

// Created exclusively: two writers at once (two inbox chats, the inbox and the dialog) leave exactly one answer.
function create(/** @type {string} */ path, /** @type {string} */ text) {
  try { const fd = openSync(path, 'wx'); writeSync(fd, text); closeSync(fd); return true } catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code === 'EEXIST') return false; throw e }
}
const stdin = () => { try { return readFileSync(0, 'utf8').trim() } catch { return '' } }

function sweepable(/** @type {any} */ it, /** @type {string} */ f) {
  const now = Date.now()
  if (!answered(it.id)) return expired(it, now)
  if (now - it.at > 14 * 24 * 3600e3) return true // hard cap, delivered or not
  const ans = readJSON(join(root, 'answers', f))
  const needsDelivery = ans?.by === 'inbox' && it.kind !== 'ask'
  return now - (Number(ans?.at) || it.at) > TTL_MS[it.kind] && (!needsDelivery || existsSync(join(root, 'delivered', it.id)))
}

function items() {
  const out = []
  for (const f of readdirSync(dir('items'))) {
    if (!f.endsWith('.json')) continue
    const it = readJSON(join(root, 'items', f))
    if (!it) continue
    // Swept lazily: an unanswered one after 7 days (the night and the weekend); an answered one a day after its ANSWER (not
    // after the question: one answered late is still to be delivered), and an inbox answer to a box or card only once delivered.
    if (sweepable(it, f)) { for (const d of ['items', 'answers', 'pushed', 'delivered']) rmSync(join(root, d, d === 'items' || d === 'answers' ? f : f.slice(0, -5)), { force: true }); continue }
    out.push(it)
  }
  return out.sort((a, b) => a.at - b.at)
}
const norm = (/** @type {string} */ id) => id.split('~').map(safe).join('~')
// The desktop profile that holds a chat: <profiles>/<name>/claude-code-sessions/<account>/<org>/local_<id>.json. Several
// accounts run side by side as separate app windows, one profile folder each (launched with --user-data-dir).
const profilesDir = () => process.env.INBOX_PROFILES_DIR || join(process.env.LOCALAPPDATA || '', 'Claude-Profiles')
function profileOf(/** @type {string} */ host) {
  const top = profilesDir()
  if (!existsSync(top)) return undefined
  for (const name of readdirSync(top)) {
    const sessions = join(top, name, 'claude-code-sessions')
    if (!existsSync(sessions)) continue
    for (const acc of readdirSync(sessions)) for (const org of readdirSync(join(sessions, acc))) {
      if (existsSync(join(sessions, acc, org, `${host}.json`))) return { name, dir: join(top, name) }
    }
  }
  return undefined
}
// The exe of the window already running with that profile's --user-data-dir (main runs the installed app, the others a
// renamed copy), given the link with the same flag: that window takes it. Never the bare claude:// handler: it has no
// --user-data-dir and opened a fresh signed-out app instead of the operator's window. The link quoted, as measured:
// unquoted it did not reach the window. INBOX_PROCS (lines "exe|command line") stands in for the process list in tests.
function profileExe(/** @type {{name: string, dir: string}} */ prof) {
  let procs = process.env.INBOX_PROCS
  if (procs === undefined) {
    try { procs = execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name like 'Claude%'" | % { $_.ExecutablePath + '|' + $_.CommandLine }`], { encoding: 'utf8', timeout: 20e3 }) } catch { procs = '' }
  }
  const flag = `--user-data-dir="${prof.dir}"`.toLowerCase()
  const row = procs.split(/\r?\n/).find((l) => { const c = l.toLowerCase(); return c.includes(flag) && !c.includes('--type=') })
  return row?.split('|')[0] || undefined
}
function linkArgv(/** @type {{name: string, dir: string} | undefined} */ prof, /** @type {string} */ url) {
  const exe = prof && profileExe(prof)
  return exe && prof ? [exe, `--user-data-dir="${prof.dir}"`, `"${url}"`] : undefined
}
function launch(/** @type {{name: string, dir: string} | undefined} */ prof, /** @type {string} */ url) {
  const argv = linkArgv(prof, url)
  if (!argv) return false
  spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref()
  return true
}
const noWindow = (/** @type {{name: string} | undefined} */ prof) => `inbox: no running app window for ${prof ? `profile ${prof.name}` : 'that chat (it is in no profile)'}; open that account from its own shortcut first`

// Every chat of every profile, from the app's own records: profile, app id, CLI id, folder, last activity, archived.
function chats() {
  const top = profilesDir(), out = []
  if (!existsSync(top)) return out
  for (const name of readdirSync(top)) {
    const sessions = join(top, name, 'claude-code-sessions')
    if (!existsSync(sessions)) continue
    for (const acc of readdirSync(sessions)) for (const org of readdirSync(join(sessions, acc))) {
      const d = join(sessions, acc, org)
      let files = []
      try { files = readdirSync(d) } catch { continue }
      for (const f of files) {
        if (!/^local_[0-9a-f-]{36}\.json$/.test(f)) continue
        const j = readJSON(join(d, f))
        if (j) out.push({ profile: name, acc, host: f.slice(0, -5), cli: j.cliSessionId, cwd: String(j.cwd || j.originCwd || ''), last: Number(j.lastActivityAt) || 0, focused: Number(j.lastFocusedAt) || 0, archived: !!j.isArchived, parent: j.spawnedFrom?.sessionId, title: String(j.title || '') })
      }
    }
  }
  return out
}
// A chat belongs to a project when its folder is the project's or inside it (worktrees included).
const inProject = (/** @type {string} */ cwd, /** @type {string} */ project) => {
  const c = cwd.replace(/\\/g, '/').toLowerCase(), p = project.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return c === p || c.startsWith(`${p}/`) || (!p.includes('/') && c.split('/').includes(p))
}
const LIVE_MS = 3 * 3600e3
const BUSY_MS = 30 * 60e3

// The chat a person names: its app id or session id, else a piece of its title or its project, among the chats not
// archived. Several by title or project: the ones active in the last 3 h, if that leaves one.
function resolve(/** @type {string} */ q) {
  const all = chats().filter((c) => !c.archived)
  const exact = all.filter((c) => c.host === q || c.cli === q)
  if (exact.length || /^local_[0-9a-f-]{36}$/.test(q)) return exact.length ? exact : [{ host: q, cli: undefined, title: '', profile: '?', last: 0, cwd: '' }]
  const t = q.toLowerCase()
  const hits = all.filter((c) => c.title.toLowerCase().includes(t) || inProject(c.cwd, q))
  const live = hits.filter((c) => Date.now() - c.last < LIVE_MS)
  return hits.length > 1 && live.length === 1 ? live : hits
}
const chatLine = (/** @type {{ profile: string, host: string, last: number, title: string, cwd: string }} */ c) =>
  `${c.profile}\t${c.host}\t${c.last ? `${Math.round((Date.now() - c.last) / 60e3)} min` : '?'}\t${c.title || '(no title)'}\t${c.cwd}`

// Which account a new task for a project goes to. The operator's rule: first the account where chats of that project
// run now (live in the last 3 h), then the one with the most chats of it; a tie or nothing found is the operator's call.
// Limits left on an account are not known here (another person may have spent them): the skill asks when unsure.
function pick(/** @type {string} */ project, now = Date.now()) {
  const mine = chats().filter((c) => !c.archived && inProject(c.cwd, project))
  const count = (/** @type {typeof mine} */ list) => Object.entries(list.reduce((m, c) => ({ ...m, [c.profile]: (m[c.profile] ?? 0) + 1 }), /** @type {Record<string, number>} */ ({}))).sort((a, b) => b[1] - a[1])
  const live = count(mine.filter((c) => now - c.last < LIVE_MS)), all = count(mine)
  if (live.length === 1) return { profile: live[0][0], why: `a chat of this project runs there now (${live[0][1]})`, live, all }
  if (live.length > 1) return { profile: undefined, why: 'chats of this project run on several accounts now: ask', live, all }
  if (all.length && (all.length === 1 || all[0][1] > all[1][1])) return { profile: all[0][0], why: `most chats of this project (${all[0][1]})`, live, all }
  return { profile: undefined, why: all.length ? 'a tie between accounts: ask' : 'no chat of this project yet: ask', live, all }
}

// The coordinator's list of work it handed out: which chat, where, what for, and what it last said. A file, so it
// outlives a /compact, a restart and the night.
const tasksFile = () => join(base, 'coord', 'tasks.json')
const loadTasks = () => /** @type {{ chat: string, profile: string, project: string, task: string, status: string, at: string, notes: string[] }[]} */ (readJSON(tasksFile()) ?? [])
const saveTasks = (/** @type {ReturnType<typeof loadTasks>} */ t) => { mkdirSync(join(base, 'coord'), { recursive: true }); const tmp = `${tasksFile()}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`; writeFileSync(tmp, JSON.stringify(t, null, 1)); renameSync(tmp, tasksFile()) }

const answered = (/** @type {string} */ id) => existsSync(join(root, 'answers', `${id}.json`))

// Finish reports, oldest first. Swept after 3 days (7 if never shown) with their markers; a chat's switch after 30 days untouched.
function reports() {
  const out = [], d = dir('reports'), now = Date.now()
  for (const f of readdirSync(d)) {
    if (!f.endsWith('.json')) continue
    const r = readJSON(join(d, f))
    if (!r) continue
    if (now - r.at > (shown(r.id) ? REPORT_TTL_MS : UNSEEN_REPORT_TTL_MS)) { for (const p of [f, join('seen', f.slice(0, -5)), join('announced', f.slice(0, -5))]) rmSync(join(d, p), { force: true }); continue }
    out.push(r)
  }
  for (const f of readdirSync(dir(join('reports', 'on')))) { const p = join(d, 'on', f); if (now - statSync(p).mtimeMs > 30 * 24 * 3600e3) rmSync(p, { force: true }) }
  return out.sort((a, b) => a.at - b.at)
}
const shown = (/** @type {string} */ id) => existsSync(join(root, 'reports', 'seen', id))
// Questions the hook answered by the person's standing rule (auto.jsonl, one line per question) in the last 24 h, not shown yet.
function autoAnswers() {
  const out = [], now = Date.now()
  for (const l of readOr(join(root, 'auto.jsonl')).split('\n')) {
    let e; try { e = JSON.parse(l) } catch { continue }
    if (e?.id && now - e.at < 24 * 3600e3 && !existsSync(join(root, 'auto-seen', e.id))) out.push(e)
  }
  return out
}
const readOr = (/** @type {string} */ p) => { try { return readFileSync(p, 'utf8').trim() } catch { return '' } }

// ---- start: a new chat on another account, gated, consented, journaled ----
// Journal <root>/starts/<key>.json, key = sha1(profile|folder|name): queued -> cli-done -> imported -> done | failed. A start that
// finds its journal imported/done (updated in the last 24 h) only prints the host; cli-done skips the CLI turn. Consent: the words
// the person typed (<root>/said.jsonl, written by the hook), one typed prompt = one start. Gate: no Claude window of ours in front.
// Env for tests: INBOX_FG=claude|other|unknown (a comma list: the 1st, 2nd... read), INBOX_FREEMEM (bytes), INBOX_CLAUDE (the CLI).
const dispatchOff = () => existsSync(join(base, 'dispatch.off'))
const MIN_FREE = 2 * 1024 ** 3, MODES = ['default', 'plan', 'auto']
const sha1 = (/** @type {string} */ s) => createHash('sha1').update(s).digest('hex')
const squash = (/** @type {string} */ s) => s.toLowerCase().replace(/\s+/g, ' ').trim()
// A failed start is retried by --drain up to 3 attempts in all, 10 min apart; then it stays failed (status shows it).
const retryable = (/** @type {any} */ j) => j.state === 'queued' || j.state === 'cli-done' || (j.state === 'failed' && (j.attempts || 1) < 3 && Date.now() - Date.parse(j.updated) > 10 * 60e3)
const journals = () => { try { return readdirSync(join(root, 'starts')).filter((f) => f.endsWith('.json')).map((f) => readJSON(join(root, 'starts', f))).filter(Boolean) } catch { return [] } }
const saveJournal = (/** @type {any} */ j) => { j.updated = new Date().toISOString(); writeFileSync(join(dir('starts'), `${j.key}.json`), JSON.stringify(j, null, 1)) }
const ledgerFile = () => join(base, 'coord', 'dispatch.jsonl')
const bundledCli = (/** @type {{name: string, dir: string}} */ prof) => {
  if (process.env.INBOX_CLAUDE) return process.env.INBOX_CLAUDE
  const top = join(prof.dir, 'claude-code'), ver = (/** @type {string} */ v) => v.split('.').map((n) => Number(n) || 0)
  try {
    const vs = readdirSync(top).sort((a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0); return 0 }) // newest first
    for (const v of vs) for (const h of readdirSync(join(top, v))) { const exe = join(top, v, h, 'claude.exe'); if (existsSync(exe)) return exe }
  } catch { /* no bundled CLI */ }
  return 'claude'
}
// The standing answer: {id, line} when `standing` is in a line of answers.md that is about a relaunch at 700K, and `old` is a live
// chat of this profile and folder that has not been relaunched yet (<root>/standing-used/<its app id>, one per old chat). Else {why}.
function standingConsent(/** @type {string} */ standing, /** @type {string} */ old, /** @type {string} */ profile, /** @type {string} */ folder, /** @type {boolean} */ mark) {
  const q = squash(standing), flat = (/** @type {string} */ s) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const line = q.length < 15 ? '' : readOr(join(base, 'answers.md')).split(/\r?\n/).find((l) => /relaunch|перезапус/i.test(l) && /700/.test(l) && squash(l).includes(q))
  if (!line) return { why: 'no line of answers.md about a relaunch at 700K contains those words (15+ characters): offer a card' }
  const chat = chats().find((c) => !c.archived && c.host === old)
  if (!chat) return { why: `--relaunch-of ${old} is no live chat: offer a card` }
  if (chat.profile !== profile || flat(chat.cwd) !== flat(folder)) return { why: `${old} is in profile ${chat.profile}, folder ${chat.cwd}: a relaunch stays on its account and folder: offer a card` }
  const used = join(root, 'standing-used', sha1(old))
  if (mark) dir('standing-used')
  if (mark ? !create(used, new Date().toISOString()) : existsSync(used)) return { why: `${old} was relaunched already (one standing start per chat): offer a card` }
  return { id: `standing|${old}`, line: line.trim() }
}
// {id} when the words are the person's own: a substring of a composer prompt of the last 24 h (15+ chars, 3+ words) that has
// not started a chat yet. The prompt is the unit, not the words: another cut of the same prompt is the same mark. Else {why}.
// `mark` false (a dry run) only looks.
// The prompt must ask for a start (a start verb) or name the chat: any sentence he typed is not consent (live 2026-11-12).
// The inbox SKILL's own start phrases count («подготовь X к деплою», «перезапусти чат»).
const START_VERB = /(?<![a-zа-яё])(запуст|запуск|перезапус|созда|начн|начин|откро|открой|заведи|подними|подготов|передай|поручи|стартан|нов(ый|ую|ого) (чат|сесси)|start|create|open|launch|relaunch|spin up|new (chat|session))/i
function consent(/** @type {string} */ said, /** @type {boolean} */ mark, name = '') {
  const none = 'no matching words of the person in the last 24 h (15+ characters, 3+ words): offer a card', q = squash(said)
  if (q.length < 15 || q.split(' ').length < 3) return { why: none }
  let reused = false, noVerb = false
  if (mark) dir('said-used')
  for (const l of readOr(join(root, 'said.jsonl')).split(/\r?\n/)) {
    let id = ''
    try {
      const e = JSON.parse(l), at = typeof e.at === 'number' ? e.at : Date.parse(e.at), t = squash(String(e.text ?? ''))
      if (Date.now() - at < 24 * 3600e3 && t.includes(q)) { if (START_VERB.test(t) || (squash(name).length >= 5 && !q.includes(squash(name)) && t.includes(squash(name)))) id = `${e.at}|${e.session}`; else noVerb = true }
    } catch { continue }
    if (!id) continue
    const used = join(root, 'said-used', sha1(id))
    if (mark ? create(used, new Date().toISOString()) : !existsSync(used)) return { id }
    reused = true
  }
  return { why: reused ? 'that typed prompt already started a chat (one prompt, one start): offer a card' : noVerb ? 'those are his words, but that prompt asks for no start (no start verb, no chat name): offer a card' : none }
}
// The window in front: 'other' = open; 'claude' = one of our app windows (--user-data-dir under the profiles folder); 'unknown' = the read failed.
const FG_PS = 'Add-Type \'using System;using System.Runtime.InteropServices;public class FG{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);}\'; $p=[uint32]0; [void][FG]::GetWindowThreadProcessId([FG]::GetForegroundWindow(),[ref]$p); $w=Get-CimInstance Win32_Process -Filter "ProcessId=$p"; $w.ExecutablePath+\'|\'+$w.CommandLine'
let fgCalls = 0
let drainStop = false // set once a start went past the gates (or hit a gate/RAM wait that holds for all): --drain stops there
function gateVerdict() {
  const fg = process.env.INBOX_FG // test override; a comma list answers the 1st, 2nd... call (the last repeats)
  if (fg) { const seq = fg.split(','); return seq[Math.min(fgCalls++, seq.length - 1)] }
  let out
  try { out = execFileSync('powershell', ['-NoProfile', '-Command', FG_PS], { encoding: 'utf8', timeout: 8e3, stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return 'unknown' }
  const [exe = '', ...c] = out.split('|')
  if (!exe) return 'unknown'
  if (!/^claude[^\\/]*\.exe$/i.test(exe.split(/[\\/]/).pop() ?? '')) return 'other'
  const m = /--user-data-dir=(?:"([^"]*)"|(\S+))/i.exec(c.join('|')), flat = (/** @type {string} */ s) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const udd = flat(m?.[1] ?? m?.[2] ?? ''), top = flat(profilesDir())
  return udd && (udd === top || udd.startsWith(`${top}/`)) ? 'claude' : 'other'
}
// One lock per profile, held from the gate check to the flip-back; stale after 5 min. The file holds a random token: after a
// takeover it is read back, and only the one whose token is in it goes on (two takeovers at once leave one winner).
function lockTake(/** @type {string} */ profile) {
  const f = join(dir('starts'), `${safe(profile)}.lock`), token = randomUUID()
  for (let i = 0; i < 2; i++) {
    try { const fd = openSync(f, 'wx'); writeSync(fd, `${token} ${process.pid} ${new Date().toISOString()}`); closeSync(fd); return readOr(f).startsWith(token) ? { f, token } : undefined } catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e }
    try {
      if (Date.now() - statSync(f).mtimeMs <= 5 * 60e3) return undefined
      const gone = `${f}.stale-${randomUUID()}`
      renameSync(f, gone); rmSync(gone, { force: true }) // one rename wins; a loser throws ENOENT
    } catch { return undefined } // busy: someone else is taking it over, or it is fresh
  }
  return undefined
}
const nextLine = (/** @type {string} */ name, /** @type {string} */ profile) => say(`next: SendMessage to "${name}" with the brief; that turn runs on ${profile}'s account`)

async function startOne(/** @type {{profile: string, folder: string, name: string, said?: string, standing?: string, relaunchOf?: string, model?: string, effort?: string, mode?: string}} */ a) {
  const { profile, folder, name, model, effort, mode, relaunchOf } = a, said = a.said ?? '', t0 = Date.now(), key = sha1(`${profile}|${folder}|${name}`), dry = !!process.env.INBOX_DRY_OPEN
  // The ledger keeps the prompt's id and 60 characters of the words, not the words.
  const led = { at: new Date().toISOString(), verb: 'start', profile, folder, name, key, consent: relaunchOf ? 'standing' : 'said', relaunchOf: relaunchOf ?? '', said: said.slice(0, 60), saidId: '', gate: '', freemem: /** @type {number | string} */ (''), result: '', ms: 0 }
  const end = (/** @type {number} */ code, /** @type {string} */ result) => {
    led.result = result; led.ms = Date.now() - t0
    if (!dry) {
      mkdirSync(join(base, 'coord'), { recursive: true }); appendFileSync(ledgerFile(), `${JSON.stringify(led)}\n`)
      const rows = readOr(ledgerFile()).split(/\r?\n/).filter(Boolean)
      if (rows.length > 2500) writeFileSync(ledgerFile(), `${rows.slice(-2000).join('\n')}\n`)
    }
    return code
  }
  if (dispatchOff()) { console.error('inbox: dispatch is off: offer a card'); return end(2, 'refused: dispatch.off') }
  const prof = { name: profile, dir: join(profilesDir(), profile) }
  /** @type {any} */ let j = readJSON(join(root, 'starts', `${key}.json`))
  if (j && (j.state === 'imported' || j.state === 'done')) {
    if (Date.now() - Date.parse(j.updated) < 24 * 3600e3) {
      say(`inbox: already started local_${j.sid} in profile ${profile}, folder ${folder} (${j.state})`); nextLine(name, profile)
      return end(0, `already ${j.state}`)
    }
    j = undefined // a day later the same name is a new start
  }
  if (j) {
    if (j.mode && !MODES.includes(j.mode)) {
      console.error(`inbox: the journal of "${name}" has mode ${j.mode}: only ${MODES.join(', ')}`)
      if (!dry) { j.state = 'failed'; j.attempts = 3; j.note = `mode ${j.mode} is not allowed`; saveJournal(j) } // no retry can fix it: out of attempts, so it blocks nobody
      return end(2, 'refused: mode')
    }
    if ((model ?? '') !== (j.model ?? '') || (effort ?? '') !== (j.effort ?? '') || (mode ?? '') !== (j.mode ?? '')) {
      console.error(`inbox: "${name}" is already ${j.state} with model "${j.model}", effort "${j.effort}", mode "${j.mode}"; the flags passed now differ: repeat it as it was, or use another name`)
      return end(2, 'refused: flags differ')
    }
    led.said = j.said; led.saidId = j.saidId ?? ''
  } else {
    const c = relaunchOf ? standingConsent(a.standing ?? '', relaunchOf, profile, folder, !dry) : consent(said, !dry, name)
    if (c.why) { console.error(`inbox: ${c.why}`); return end(2, 'refused: consent') }
    led.saidId = c.id ?? ''
    led.said = (c.line ?? said).slice(0, 60)
    j = { key, profile, folder, name, said: led.said, saidId: c.id, ...(relaunchOf ? { standing: led.said, relaunchOf } : {}), model: model ?? '', effort: effort ?? '', mode: mode ?? '', sid: randomUUID(), state: 'queued', at: new Date().toISOString(), updated: '', note: '' }
    if (!dry) saveJournal(j)
  }
  const urlOf = () => `claude://resume?session=${j.sid}`
  const cliArgv = () => [bundledCli(prof), '-p', 'Reply with the single word READY.', '--session-id', j.sid, '-n', name, ...(j.model ? ['--model', j.model] : []), ...(j.effort ? ['--effort', j.effort] : []), ...(j.mode ? ['--permission-mode', j.mode] : [])]
  // The chat that window shows (the app stamps lastFocusedAt): opened again after the import, so the window flips to the new
  // chat and straight back. Read after the CLI turn (up to 180 s): the person may have switched chats meanwhile.
  const backOf = () => {
    const shown = chats().filter((c) => c.profile === profile).sort((x, y) => y.focused - x.focused)[0]
    return shown?.focused ? { host: shown.host, url: `claude://claude.ai/epitaxy/${shown.host}` } : undefined
  }
  const argv = linkArgv(prof, urlOf())
  if (dry) { // writes nothing: no journal, no mark, no ledger row
    if (!argv) { console.error(noWindow(prof)); return 1 }
    say(`cd ${folder}`); say(cliArgv().join(' ')); say(argv.join(' ')); const b = backOf(); if (b) say(`back: ${b.url}`)
    return 0
  }
  const queue = (/** @type {string} */ why) => { j.note = why; if (j.state !== 'cli-done') j.state = j.cliDone ? 'cli-done' : 'queued'; saveJournal(j); say(`inbox: queued: ${why}`); return end(4, `queued: ${why}`) }
  const lock = lockTake(profile)
  if (!lock) return queue(`another start of ${profile} is running`)
  try {
    const host = () => `local_${j.sid}`, doneLine = (/** @type {string} */ flip) => { say(`inbox: started ${host()} in profile ${profile}, folder ${folder}${flip}`); nextLine(name, profile) }
    const imported = () => { j.state = 'imported'; saveJournal(j); writeFileSync(join(dir(join('reports', 'on')), host()), `started ${new Date().toISOString()}`) } // its finish reports come
    // A retry whose link already took effect (the import was only slow): done, and no link fired again.
    if ((j.state === 'cli-done' || j.cliDone) && profileOf(host())?.name === profile) {
      imported(); j.state = 'done'; j.note = 'imported meanwhile; no flip-back'; saveJournal(j); doneLine('; no flip-back (imported meanwhile)')
      return end(0, 'done: imported meanwhile')
    }
    const free = process.env.INBOX_FREEMEM !== undefined ? Number(process.env.INBOX_FREEMEM) : freemem()
    led.freemem = free
    if (free < MIN_FREE) return drainStop = true, queue(`only ${Math.round(free / 2 ** 20)} MiB of RAM free (floor ${MIN_FREE / 2 ** 20})`)
    const closed = (/** @type {string} */ g) => `a Claude window is in front; it starts when none is${g === 'unknown' ? ' (the foreground window could not be read)' : ''}`
    led.gate = gateVerdict()
    if (led.gate !== 'other') { drainStop = true; return queue(closed(led.gate)) }
    if (!argv) { j.state = 'failed'; j.attempts = (j.attempts || 0) + 1; j.note = noWindow(prof); saveJournal(j); console.error(j.note); return end(1, 'failed: no window') }
    drainStop = true // from here the start works (CLI turn or import)
    if (j.state !== 'cli-done' && !j.cliDone) {
      j.sid = randomUUID(); j.state = 'queued'; saveJournal(j) // a failed turn may have left its id used: a new one each try
      const cli = cliArgv()
      try { execFileSync(cli[0], cli.slice(1), { cwd: folder, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180e3 }) } catch (e) {
        j.state = 'failed'; j.attempts = (j.attempts || 0) + 1; j.note = `the CLI turn failed: ${/** @type {Error} */ (e).message.split('\n')[0]}`; saveJournal(j); console.error(`inbox: ${j.note}`); return end(1, 'failed: cli')
      }
      j.state = 'cli-done'; j.cliDone = true; j.note = ''; saveJournal(j)
    }
    const back = backOf(), g2 = gateVerdict()
    if (g2 !== 'other') { led.gate += `,${g2}`; return queue(closed(g2)) }
    launch(prof, urlOf())
    for (let i = 0, n = Math.ceil((Number(process.env.INBOX_IMPORT_WAIT) || 30e3) / 500); i < n && profileOf(host())?.name !== profile; i++) await new Promise((r) => setTimeout(r, 500)) // INBOX_IMPORT_WAIT (ms): the selftest
    if (profileOf(host())?.name !== profile) {
      // An attempt, like a failed CLI turn: the same 3 tries 10 min apart; a retry first looks whether it was imported after all.
      j.state = 'failed'; j.cliDone = true; j.attempts = (j.attempts || 0) + 1; j.note = 'not imported in 30 s'; saveJournal(j)
      console.error(`inbox: ${profile} did not import ${j.sid} within 30 s (is that account's window running?)`); return end(1, 'failed: import')
    }
    imported()
    // the flip-back always runs: it restores the chat that window showed (measured 2 s [M71])
    const flip = back ? (launch(prof, back.url), `; window sent back to ${back.host}`) : ''
    j.state = 'done'; j.note = ''; saveJournal(j)
    doneLine(flip)
    return end(0, 'done')
  } finally { if (readOr(lock.f).startsWith(lock.token)) rmSync(lock.f, { force: true }) }
}

async function startCmd(/** @type {string | undefined} */ id, /** @type {string[]} */ rest) {
  if (dispatchOff()) { console.error('inbox: dispatch is off: offer a card'); return 2 }
  if (id === '--drain') {
    // Oldest first, up to the first start that gets past the gates: a run does one CLI turn at most, under the hook's time limit (180 s).
    const todo = journals().filter(retryable).sort((x, y) => (Date.parse(x.at) || 0) - (Date.parse(y.at) || 0))
    say(`inbox: ${todo.length} queued start${todo.length === 1 ? '' : 's'}${todo.length > 1 ? '; oldest first, this run stops after the first that gets past the gates' : ''}`)
    let code = 0
    // One that fails for its own reason (no window of its profile, a bad mode) is marked failed and the next is tried: it blocks nobody.
    for (const j of todo) { drainStop = false; code = await startOne(j); if (drainStop) break }
    return code
  }
  const [folder, ...args] = rest, words = [], o = /** @type {Record<string, string>} */ ({})
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--switches-window') continue // accepted, ignored: the gate replaced it
    if (['--said', '--standing', '--relaunch-of', '--model', '--effort', '--mode'].includes(args[i]) && args[i + 1] !== undefined) o[args[i].slice(2)] = args[++i]
    else words.push(args[i])
  }
  const name = words.join(' ').trim()
  if (!id || !existsSync(join(profilesDir(), id, 'claude-code-sessions')) || !folder || !existsSync(folder) || !name || !(o.said || (o.standing && o['relaunch-of'])) || (o.said && (o.standing || o['relaunch-of'])) || (!o.standing !== !o['relaunch-of'])) {
    console.error('inbox: usage: start <profile> <folder> <chat name> --said "<his words>" | --standing "<words of answers.md>" --relaunch-of <app id> [--model m] [--effort e] [--mode default|plan|auto]  |  start --drain  (a profile under Claude-Profiles, an existing folder)'); return 2
  }
  if (o.mode && !MODES.includes(o.mode)) { console.error(`inbox: --mode ${o.mode} refused: only ${MODES.join(', ')}`); return 2 }
  return startOne({ profile: id, folder, name, said: o.said, standing: o.standing, relaunchOf: o['relaunch-of'], model: o.model, effort: o.effort, mode: o.mode })
}


// ---- scan: questions that wait in chats which filed no item ----
// Run when a chat becomes the inbox (list's first mark, or --take) and by `inbox.mjs scan`. Every account's transcripts sit in the
// one shared <config>/projects tree. For each chat of the registry active in the last 24 h (not archived, not the inbox chat, not a
// hold chat) the tail of its transcript is read (never the whole file): the last AskUserQuestion with no tool_result after it, or
// the last wrap_up with an `ask` and no real user prompt after it, becomes an item through the normal path (found: 'scan').
function tailLines(/** @type {string} */ path, n = 400, maxBytes = 2 * 1024 * 1024) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size, len = Math.min(size, maxBytes), buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    const lines = buf.toString('utf8').split('\n')
    if (size > len) lines.shift() // the first line is cut
    return lines.filter(Boolean).slice(-n)
  } finally { closeSync(fd) }
}
const textOf = (/** @type {any} */ c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '')
// As the hook: a hold chat's list starts with `collecting` and was touched in the last day.
function holding(/** @type {string} */ cli) {
  for (const f of [join(base, 'hold', safe(cli), 'index.md'), join(base, 'hold', `${safe(cli)}.md`)]) {
    const t = readOr(f)
    if (!t) continue
    if (!/^\s*collecting\b/.test(t)) return false
    try { return Date.now() - statSync(f).mtimeMs < 86400e3 } catch { return true }
  }
  return false
}
function undelivered(/** @type {string} */ cli) {
  try {
    return readdirSync(join(root, 'items')).some((f) => {
      if (!f.endsWith('.json') || !f.startsWith(`${safe(cli)}~`)) return false
      const it = readJSON(join(root, 'items', f))
      return it?.kind === 'choice' && readJSON(join(root, 'answers', f))?.by === 'inbox' && !existsSync(join(root, 'delivered', it.id))
    })
  } catch { return false }
}
function scan(/** @type {string[]} */ selves) {
  const projects = join(dirname(base), 'projects'), where = new Map(), filed = []
  try { for (const d of readdirSync(projects)) { try { for (const f of readdirSync(join(projects, d))) if (f.endsWith('.jsonl')) where.set(f.slice(0, -6), join(projects, d, f)) } catch { /* not a folder */ } } } catch { return filed }
  for (const c of chats()) {
    if (c.archived || !c.cli || selves.includes(c.cli) || Date.now() - c.last > 24 * 3600e3) continue
    const path = where.get(c.cli)
    if (!path || holding(c.cli)) continue
    let lines
    try { lines = tailLines(path) } catch { continue }
    const results = new Set(), msgs = []
    /** @type {{ tool: any, at: number, ctx: { role: string, text: string }[] } | undefined} */ let wait
    for (const l of lines) {
      let e
      try { e = JSON.parse(l) } catch { continue }
      if (!e || e.isSidechain) continue // a subagent's turn is not the chat's
      const content = e.message?.content
      if (e.type === 'user') {
        if (Array.isArray(content)) for (const b of content) if (b?.type === 'tool_result') results.add(b.tool_use_id)
        if (e.isMeta || (Array.isArray(content) && content.every((b) => b?.type === 'tool_result'))) continue
        wait = undefined // a real prompt after the question: the chat went on
        const t = textOf(content); if (t) msgs.push({ role: 'user', text: t })
      } else if (e.type === 'assistant' && Array.isArray(content)) {
        const t = textOf(content); if (t) msgs.push({ role: 'assistant', text: t })
        for (const b of content) if (b?.type === 'tool_use' && (b.name === 'AskUserQuestion' || (b.name === 'mcp__ccd_turn__wrap_up' && String(b.input?.ask ?? '').trim()))) wait = { tool: b, at: Date.parse(e.timestamp) || c.last, ctx: msgs.slice(-6) }
      }
    }
    if (!wait || (wait.tool.name === 'AskUserQuestion' && results.has(wait.tool.id))) continue
    if (Date.now() - wait.at > 24 * 3600e3) continue // a day-old question in a chat touched today: it would be swept as expired and filed again
    const t = wait.tool, id = itemId(c.cli, t.id)
    if (existsSync(join(root, 'items', `${id}.json`)) || existsSync(join(root, 'answers', `${id}.json`))) continue
    // As the hook's re-ask rule: a box of this chat that the inbox answered and the chat has not taken yet means the chat is about to get
    // that answer as a prompt; its newer wrap_up is not a new question.
    if (t.name !== 'AskUserQuestion' && undelivered(c.cli)) continue
    const title = clean(c.title || msgs.find((m) => m.role === 'user')?.text || ''), head = { id, at: wait.at, session: c.cli, cwd: c.cwd, chat: `${title.length > 70 ? `${title.slice(0, 69)}…` : title} (${c.cli.slice(0, 8)})`, host: c.host, account: c.acc, profile: c.profile, context: contextOf(wait.ctx), found: 'scan' }
    let item
    if (t.name === 'AskUserQuestion') {
      if (!Array.isArray(t.input?.questions) || !t.input.questions.length) continue
      item = { ...head, kind: 'ask', questions: t.input.questions }
    } else item = { ...head, kind: 'choice', ask: String(t.input.ask), recap: t.input.recap, actions: (t.input.actions ?? []).map((/** @type {any} */ x) => x?.label ?? x?.action ?? '').filter(Boolean) }
    if (create(join(dir('items'), `${id}.json`), JSON.stringify(item))) {
      filed.push(id)
      say(`inbox: found a waiting question in ${c.profile} / ${String(c.cwd).split(/[\\/]/).filter(Boolean).pop()}: ${(item.kind === 'ask' ? item.questions[0]?.question : item.ask).slice(0, 80)} (${id})`)
    }
  }
  return filed
}

async function main() {
  const [cmd, id, ...rest] = process.argv.slice(2)
  if (cmd === 'on') { mkdirSync(base, { recursive: true }); writeFileSync(join(base, 'inbox.on'), `${new Date().toISOString()}\n`); say('inbox: on for every chat that loads makarasty-tools (running chats after their next restart or plugin reload)'); return 0 }
  if (cmd === 'off') { rmSync(join(base, 'inbox.on'), { force: true }); say('inbox: off'); return 0 }
  if (cmd === 'status') {
    const on = existsSync(join(base, 'inbox.on')), all = existsSync(join(root, 'items')) ? items() : []
    const ago = (/** @type {number | undefined} */ t) => (t ? `${Math.round((Date.now() - t) / 60e3)} min ago` : 'never')
    // The newest file of a folder: when the inbox last got an item, woke the inbox chat, carried an answer.
    const newest = (/** @type {string} */ d) => { try { return Math.max(...readdirSync(join(root, d)).map((f) => statSync(join(root, d, f)).mtimeMs)) } catch { return undefined } }
    const last = all.at(-1)
    say(`inbox: ${on ? 'on' : 'off'}, ${all.filter((i) => !answered(i.id)).length} pending, folder ${root}`)
    say(`last item: ${last ? `${ago(last.at)} from ${String(last.cwd).split(/[\\/]/).filter(Boolean).pop()} (${last.kind})` : 'none'}`)
    say(`last wake of the inbox chat: ${ago(newest('announced'))}; last answer: ${ago(newest('answers'))}`)
    say(`inbox chat: ${existsSync(join(root, 'self')) ? readFileSync(join(root, 'self'), 'utf8').trim() : 'none yet (run list once)'}`)
    say(`finish reports not shown yet: ${reports().filter((r) => !shown(r.id)).length}`)
    const rows = readOr(ledgerFile()).split(/\r?\n/).filter(Boolean).slice(-10)
    say(`dispatch ledger, last ${rows.length}:`)
    for (const l of rows) { try { const e = JSON.parse(l); say(`  ${e.at} ${e.verb} ${e.profile} ${e.name}: ${e.result} (gate ${e.gate || '-'}, ${e.ms} ms)`) } catch { /* torn line */ } }
    const q = journals().filter((j) => j.state === 'queued' || j.state === 'cli-done')
    say(`queued starts: ${q.length}${dispatchOff() ? ' (dispatch is off)' : ''}`)
    for (const j of q) say(`  ${j.state}	${j.profile}	${j.name}	${j.note}`)
    for (const j of journals().filter((x) => x.state === 'failed')) say(`  failed (${j.attempts || 1} attempt${(j.attempts || 1) === 1 ? '' : 's'}${retryable(j) ? ', drain retries it' : ''})	${j.profile}	${j.name}	${j.note}`)
    return 0
  }
  if (cmd === 'starts') {
    // queued starts and the ones of the last day
    const all = journals().filter((j) => j.state === 'queued' || j.state === 'cli-done' || Date.now() - Date.parse(j.updated) < 24 * 3600e3)
    if (!all.length) say('inbox: no starts')
    for (const j of all.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))) say(`${j.state}	${j.profile}	${j.name}	${j.folder}	${j.updated}	${j.note}`)
    return 0
  }
  if (cmd === 'watchdog') {
    // Runs in the inbox chat as a background task the person can see. It prints nothing while the plugin's wake works;
    // it exits, which wakes the chat, when an item from another chat sits unannounced for a minute (the wake is broken)
    // or when another chat took over as the inbox. Not while the inbox chat is inside a turn (the hook's `turn` file):
    // a chat cannot be woken mid-turn, and its wake runs once the turn ends, so an item waiting then is no broken wake.
    // The hook's `turn` file is written only by a plugin copy that has it (1.19.14+), so a chat still on an older copy
    // also counts as at work when its own transcript changed after the item came in: it is handling it, or was woken.
    const me = process.env.CLAUDE_CODE_SESSION_ID
    say(`inbox watchdog: watching ${root} for ${me}`)
    const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
    let transcript = ''
    const touched = () => {
      if (!me) return 0
      if (!transcript) { try { transcript = readdirSync(projects).map((d) => join(projects, d, `${me}.jsonl`)).find((p) => existsSync(p)) ?? '' } catch { /* no projects folder */ } }
      try { return transcript ? statSync(transcript).mtimeMs : 0 } catch { return 0 }
    }
    for (;;) {
      await new Promise((r) => setTimeout(r, Number(process.env.INBOX_WATCHDOG_MS) || 10000)) // the env: the selftest
      const self = existsSync(join(root, 'self')) ? readFileSync(join(root, 'self'), 'utf8').trim() : ''
      if (me && self && self !== me) { say(`INBOX WATCHDOG: another chat (${self}) is the inbox now; this one is no longer woken`); return 1 }
      for (const it of existsSync(join(root, 'items')) ? items() : []) {
        if (answered(it.id) || it.session === self || existsSync(join(root, 'announced', it.id))) continue
        const [state, since] = readOr(join(root, 'turn')).split(' ')
        if (state === 'busy' && Date.now() - Number(since) < 2 * 3600e3) continue // a turn longer than 2 h: a lost end marker
        if (touched() > it.at) continue
        if (Date.now() - it.at > 60000) { const beat = Number(readOr(join(root, 'beat'))) || 0; say(`INBOX WATCHDOG: item ${it.id} has waited ${Math.round((Date.now() - it.at) / 1000)} s and the inbox chat was not woken: the wake is broken (plugin not loaded in this chat, or its timer stopped; its last tick ${beat ? `${Math.round((Date.now() - beat) / 1000)} s ago` : 'never'})`); return 1 }
      }
    }
  }
  if (cmd === 'test') {
    // A check item from a pretend chat: the inbox chat's own timer should wake it within ~15 s with this question.
    const id = `inboxcheck~t${Date.now()}`
    mkdirSync(join(root, 'items'), { recursive: true })
    writeFileSync(join(root, 'items', `${id}.json`), JSON.stringify({ id, kind: 'choice', at: Date.now(), session: 'inboxcheck', cwd: 'inbox-check', chat: 'inbox check', ask: 'Inbox check: did this reach the inbox chat by itself?', actions: ['Yes'], context: 'written by `inbox.mjs test`' }))
    say(`inbox: check item ${id} written at ${new Date().toISOString()}; the inbox chat should wake with it within about 15 s`)
    return 0
  }

  if (cmd === 'chats') {
    // `chats [project] [--live]`: one line per chat, newest first. --live: active in the last 3 h.
    const live = rest.includes('--live') || id === '--live', project = id && id !== '--live' ? id : ''
    const list = chats().filter((c) => !c.archived && (!project || inProject(c.cwd, project)) && (!live || Date.now() - c.last < LIVE_MS)).sort((a, b) => b.last - a.last)
    for (const c of list) say(`${c.profile}\t${c.host}\t${Math.round((Date.now() - c.last) / 60e3)} min\t${c.cwd}`)
    if (!list.length) say('inbox: no chat matches')
    return 0
  }
  if (cmd === 'children') {
    // `children <app id>`: the app ids of the chats that chat started (the app's spawnedFrom), one per line.
    for (const c of chats()) if (id && c.parent === id && !c.archived) say(c.host)
    return 0
  }
  if (cmd === 'follow' || cmd === 'mute') {
    const q = [id, ...rest].filter(Boolean).join(' ')
    if (!q) { console.error(`inbox: ${cmd} <app id | session id | piece of its title | project>`); return 2 }
    const found = resolve(q)
    if (found.length !== 1) {
      if (!found.length) { say(`inbox: no chat matches "${q}"`); return 1 }
      say(`inbox: ${found.length} chats match "${q}"; name one by its app id:`)
      for (const c of found.sort((a, b) => b.last - a.last).slice(0, 15)) say(chatLine(c))
      if (found.length > 15) say(`... ${found.length - 15} more, older: a longer piece of the title narrows it`)
      return 1
    }
    const c = found[0], on = dir(join('reports', 'on'))
    for (const k of [c.host, c.cli].filter(Boolean).map((x) => safe(String(x)))) {
      if (cmd === 'follow') writeFileSync(join(on, k), new Date().toISOString()); else rmSync(join(on, k), { force: true })
    }
    say(`inbox: ${cmd === 'follow' ? 'following' : 'muted'} ${c.title || c.host} (${c.host}${c.profile !== '?' ? `, ${c.profile}` : ''}): finish reports ${cmd === 'follow' ? 'on' : 'off'}; its questions come either way`)
    return 0
  }
  if (cmd === 'followed') {
    const on = new Set(readdirSync(dir(join('reports', 'on'))))
    const me = process.env.CLAUDE_CODE_SESSION_ID, self = readOr(join(root, 'self'))
    const all = chats().filter((c) => !c.archived && c.cli !== me && c.cli !== self)
    const followed = all.filter((c) => on.has(c.host) || (c.cli && on.has(c.cli)))
    say(followed.length ? `followed (${followed.length}):` : 'inbox: no chat followed')
    for (const c of followed.sort((a, b) => b.last - a.last)) say(chatLine(c))
    const busy = all.filter((c) => !followed.includes(c) && Date.now() - c.last < BUSY_MS).sort((a, b) => b.last - a.last)
    if (busy.length) { say(`busy in the last 30 min, not followed (${busy.length}):`); for (const c of busy) say(chatLine(c)) }
    return 0
  }
  if (cmd === 'report') {
    const who = safe(rest[0] || process.env.CLAUDE_CODE_SESSION_ID || '')
    if ((id !== 'on' && id !== 'off') || !who) { console.error('inbox: report on|off [session id or local_ app id]'); return 2 }
    const f = join(dir(join('reports', 'on')), who)
    if (id === 'on') writeFileSync(f, new Date().toISOString()); else rmSync(f, { force: true })
    say(`inbox: finish reports ${id} for ${who}`)
    return 0
  }
  if (cmd === 'reports') {
    const all = reports()
    say(all.length ? renderReports(all, Date.now(), process.env.CLAUDE_CODE_ACCOUNT_UUID) : 'inbox: no finish reports in the last 3 days')
    return 0
  }
  if (cmd === 'pick') {
    if (!id) { console.error('inbox: pick needs a project folder or name'); return 2 }
    const p = pick(id)
    say(`${p.profile ?? 'ASK'}: ${p.why}. live ${JSON.stringify(p.live)}, all ${JSON.stringify(p.all)}`)
    return 0
  }
  if (cmd === 'track') {
    // `track <chat> <profile> <project> <task...>`
    const [profile, project, ...task] = rest
    if (!id || !profile || !project || !task.length) { console.error('inbox: track <chat> <profile> <project> <task>'); return 2 }
    const t = loadTasks().filter((x) => x.chat !== id)
    t.push({ chat: id, profile, project, task: task.join(' '), status: 'started', at: new Date().toISOString(), notes: [] })
    if (/^local_[0-9a-f-]{36}$/.test(id)) writeFileSync(join(dir(join('reports', 'on')), id), `started ${new Date().toISOString()}`) // handed work: it reports its finish
    saveTasks(t); say(`inbox: tracking ${id}`); return 0
  }
  if (cmd === 'note') {
    // `note <chat> <status> [text...]`: status is one word (working, waiting, paused, done, failed ...).
    const t = loadTasks(), x = t.find((y) => y.chat === id)
    if (!x || !rest[0]) { console.error(`inbox: ${x ? 'note needs a status' : `no tracked chat ${id}`}`); return 1 }
    x.status = rest[0]
    if (rest.length > 1) x.notes = [...x.notes, `${new Date().toISOString().slice(0, 16)} ${rest.slice(1).join(' ')}`].slice(-10)
    saveTasks(t); say(`inbox: ${id} ${x.status}`); return 0
  }
  if (cmd === 'tasks') {
    const t = loadTasks().filter((x) => id === '--all' || x.status !== 'done')
    if (!t.length) { say('inbox: no tracked work'); return 0 }
    for (const x of t) say(`${x.status}\t${x.profile}\t${x.chat}\t${x.project}\t${x.task}${x.notes.length ? `\n\t\tlast: ${x.notes.at(-1)}` : ''}`)
    return 0
  }

  if (cmd === 'scan') {
    // Files the questions that wait in live chats of every account and have no item (also run by the first list and by list --take).
    if (!scan([process.env.CLAUDE_CODE_SESSION_ID || '']).length) say('inbox: scan found no waiting question without an item')
    return 0
  }
  if (cmd === 'list') {
    const self = process.env.CLAUDE_CODE_SESSION_ID
    // Another chat that is the inbox and alive (its timer wrote `beat` in the last 2 minutes) is not taken over by a plain
    // list: this one lists read-only. `--take` moves the inbox here.
    const was = readOr(join(root, 'self')), beatAge = Date.now() - (Number(readOr(join(root, 'beat'))) || 0)
    const readOnly = !!was && was !== self && !rest.includes('--take') && id !== '--take' && beatAge < 120000
    if (readOnly) say(`inbox: ${was} is the inbox chat (beat ${Math.round(beatAge / 1000)}s ago); run \`inbox.mjs list --take\` to move it here`)
    else if (self) {
      mkdirSync(root, { recursive: true }); writeFileSync(join(root, 'self'), self)
      // This chat just became the inbox: questions already waiting in other chats (they filed no item) enter the normal path now.
      if (was !== self || rest.includes('--take') || id === '--take') { try { scan([self]) } catch (e) { console.error(`inbox: scan failed: ${/** @type {Error} */ (e).message}`) } }
    }
    const open = items().filter((i) => !answered(i.id) && i.session !== self)
    const done = reports().filter((r) => !shown(r.id) && r.session !== self)
    const auto = autoAnswers()
    if (!open.length && !done.length && !auto.length) { say('inbox: nothing pending'); return 0 }
    if (open.length) say(`inbox: ${open.length} pending\n`)
    for (const it of open) say(`${render(it, Date.now(), process.env.CLAUDE_CODE_ACCOUNT_UUID)}\n`)
    if (done.length) {
      // Shown once: the next list leaves them out (`reports` shows them again for 3 days).
      say(`## Finished: ${new Set(done.map((r) => r.session)).size} chats, ${done.length} reports\n`)
      say(`${renderReports(done, Date.now(), process.env.CLAUDE_CODE_ACCOUNT_UUID)}\n`)
      if (!readOnly) for (const r of done) writeFileSync(join(dir(join('reports', 'seen')), r.id), '')
    }
    if (auto.length) {
      // Shown once, like the finish reports. The chat took each answer as the person's own, so a wrong one is told to it by hand.
      say('## Answered by a standing rule (last 24 h)\n')
      for (const e of auto) say(`- ${e.chat}: "${e.question}" -> ${e.label}  (rule: "${e.rule}"; to undo say "отмени ${e.id}")`)
      say('')
      if (!readOnly) for (const id of new Set(auto.map((e) => e.id))) writeFileSync(join(dir('auto-seen'), id), '')
    }
    return 0
  }

  if (!id) { console.error(`inbox: ${cmd ?? '(none)'} needs an item id`); return 2 }
  const itemPath = join(root, 'items', `${norm(id)}.json`)
  const item = readJSON(itemPath)

  if (cmd === 'show') {
    if (!item) { console.error(`inbox: no item ${id}`); return 1 }
    say(JSON.stringify(item, null, 2))
    return 0
  }

  if (cmd === 'answer') {
    if (!item) { console.error(`inbox: no item ${id} (answered and swept, or expired)`); return 1 }
    const text = rest.length ? rest.join(' ') : stdin()
    let raw = text
    try { if (/^[{"]/.test(text)) raw = JSON.parse(text) } catch { /* plain text answer */ }
    let norm
    try { norm = normalizeAnswer(item, raw) } catch (e) { console.error(`inbox: ${/** @type {Error} */ (e).message}`); return 1 }
    const ans = { id: item.id, at: Date.now(), by: 'inbox', ...norm }
    if (!create(join(dir('answers'), `${item.id}.json`), JSON.stringify(ans))) {
      const was = readJSON(join(root, 'answers', `${item.id}.json`))
      say(`inbox: already answered ${was?.by === 'chat' ? 'in the chat itself' : 'from the inbox'}; this answer was not used`)
      return 1
    }
    say(`inbox: answered ${item.id}`)
    return 0
  }

  if (cmd === 'done') {
    const ok = create(join(dir('answers'), `${norm(id)}.json`), JSON.stringify({ id: norm(id), at: Date.now(), by: 'chat', ...(rest[0] ? { choice: rest.join(' ') } : {}) }))
    say(ok ? 'inbox: done' : 'inbox: already answered')
    return 0
  }

  if (cmd === 'wait') {
    // One id, or several joined by commas (the inbox chat's own dialog waits for all of its items).
    const ids = id.split(',').map(norm)
    const until = Date.now() + Math.min(Number(rest[0]) || 600000, 600000)
    while (Date.now() < until) {
      const got = ids.map((i) => readJSON(join(root, 'answers', `${i}.json`)))
      if (got.every(Boolean)) { say(JSON.stringify(ids.length === 1 ? got[0] : got)); return 0 }
      await new Promise((r) => setTimeout(r, 500))
    }
    return 3
  }

  if (cmd === 'push') {
    if (!item || answered(item.id)) return 0
    // The marker is empty once pushed; while notify has failed it holds {fails, at}: tried again after 5 min, 3 times at most.
    const mark = join(dir('pushed'), item.id), now = Date.now(), prev = existsSync(mark) ? readJSON(mark) : undefined
    if (existsSync(mark) && !prev) return 0
    if (prev && (prev.fails >= 3 || now - prev.at < 5 * 60e3)) return 0
    const attempt = JSON.stringify({ fails: (prev?.fails ?? 0) + 1, at: now })
    if (prev) writeFileSync(mark, attempt); else if (!create(mark, attempt)) return 0
    try { execFileSync(process.execPath, [join(here, '..', '..', 'hooks', 'notify.mjs'), 'send', pushText(item)], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }) } catch (e) { console.error(`inbox: push failed: ${/** @type {Error} */ (e).message.split('\n')[0]}`); return 1 } // the attempt record stays: a later tick retries
    writeFileSync(mark, '')
    say('inbox: pushed')
    return 0
  }

  if (cmd === 'open') {
    const host = id.startsWith('local_') ? id : item?.host
    if (!host || !/^local_[0-9a-f-]{36}$/.test(host)) { console.error(`inbox: no app id for ${id} (an item from before the link was kept)`); return 1 }
    const url = `claude://claude.ai/epitaxy/${host}`
    const prof = profileOf(host)
    const argv = linkArgv(prof, url)
    if (!argv) { console.error(noWindow(prof)); return 1 }
    if (process.env.INBOX_DRY_OPEN) { say(argv.join(' ')); return 0 }
    launch(prof, url)
    say(`inbox: opened ${host}${prof ? ` in profile ${prof.name}` : ''}`)
    return 0
  }

  if (cmd === 'start') return startCmd(id, rest)

  console.error(`inbox: unknown command ${cmd}`)
  return 2
}

main().then((c) => process.exit(c), (e) => { console.error(`inbox: ${e.message}`); process.exit(1) })
