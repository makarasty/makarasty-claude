#!/usr/bin/env node
// inbox.mjs - the file side of the cross-chat inbox. The hook in every chat (tools/hooks/inbox.ts) writes items; the
// inbox chat lists and answers them here; the asking chat's hook waits here for the answer. Layout: core.mjs.
//
//   node inbox.mjs on | off | status        switch the inbox for every chat of this Claude config dir; status says when it last got an item, woke, carried an answer
//   node inbox.mjs test                     a check item from a pretend chat: the inbox chat should wake with it by itself
//   node inbox.mjs watchdog                 run in the inbox chat in the background; exits (and wakes it) only when the wake broke
//   node inbox.mjs list [--take]            pending items, explained, oldest first; marks this chat as the inbox (not while
//                                           another inbox chat is alive, unless --take)
//   node inbox.mjs show <id>               the whole item as JSON (a card's full brief)
//   node inbox.mjs answer <id> [text]       answer one item (text, or a JSON map on stdin); first answer wins
//   node inbox.mjs done <id>                the chat answered it itself (dialog, box button, card click, Esc)
//   node inbox.mjs wait <id>[,<id>...] <ms> block until every item is answered; prints the answer JSON (exit 3: timed out)
//   node inbox.mjs push <id>                one phone message for the item through notify.mjs, once
//   node inbox.mjs open <id>|local_<id>     bring that chat up in the app window of its own account (profile)
//   node inbox.mjs children <local_id>      app ids of the chats that chat started, one per line
//   node inbox.mjs report on|off [chat id]  that chat (default: the one running this) sends finish reports, or stops
//   node inbox.mjs reports                  every finish report of the last 3 days, shown or not
//   node inbox.mjs follow <chat>            finish reports on for a chat of any account: app id, session id, a piece of
//                                           its title, or its project (several matches: the candidates, exit 1)
//   node inbox.mjs mute <chat>              finish reports off for it (its questions still come)
//   node inbox.mjs followed                 the chats followed, then the busy ones that are not
//
// Exit 0 ok, 1 refused (already answered, unknown id, bad answer), 2 bad arguments, 3 wait timed out.

import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPORT_TTL_MS, TTL_MS, UNSEEN_REPORT_TTL_MS, expired, normalizeAnswer, pushText, render, renderReports, safe } from './core.mjs'

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
        if (j) out.push({ profile: name, host: f.slice(0, -5), cli: j.cliSessionId, cwd: String(j.cwd || j.originCwd || ''), last: Number(j.lastActivityAt) || 0, archived: !!j.isArchived, parent: j.spawnedFrom?.sessionId, title: String(j.title || '') })
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
const readOr = (/** @type {string} */ p) => { try { return readFileSync(p, 'utf8').trim() } catch { return '' } }

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
    if (/^local_[0-9a-f-]{36}$/.test(id)) writeFileSync(join(dir(join('reports', 'on')), id), new Date().toISOString()) // handed work: it reports its finish
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

  if (cmd === 'list') {
    const self = process.env.CLAUDE_CODE_SESSION_ID
    // Another chat that is the inbox and alive (its timer wrote `beat` in the last 2 minutes) is not taken over by a plain
    // list: this one lists read-only. `--take` moves the inbox here.
    const was = readOr(join(root, 'self')), beatAge = Date.now() - (Number(readOr(join(root, 'beat'))) || 0)
    const readOnly = !!was && was !== self && !rest.includes('--take') && id !== '--take' && beatAge < 120000
    if (readOnly) say(`inbox: ${was} is the inbox chat (beat ${Math.round(beatAge / 1000)}s ago); run \`inbox.mjs list --take\` to move it here`)
    else if (self) { mkdirSync(root, { recursive: true }); writeFileSync(join(root, 'self'), self) }
    const open = items().filter((i) => !answered(i.id) && i.session !== self)
    const done = reports().filter((r) => !shown(r.id) && r.session !== self)
    if (!open.length && !done.length) { say('inbox: nothing pending'); return 0 }
    if (open.length) say(`inbox: ${open.length} pending\n`)
    for (const it of open) say(`${render(it, Date.now(), process.env.CLAUDE_CODE_ACCOUNT_UUID)}\n`)
    if (done.length) {
      // Shown once: the next list leaves them out (`reports` shows them again for 3 days).
      say(`## Finished: ${new Set(done.map((r) => r.session)).size} chats, ${done.length} reports\n`)
      say(`${renderReports(done, Date.now(), process.env.CLAUDE_CODE_ACCOUNT_UUID)}\n`)
      if (!readOnly) for (const r of done) writeFileSync(join(dir(join('reports', 'seen')), r.id), '')
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
    // That profile's own copy of the app, given the link: the running window of that profile takes it and shows the chat.
    // The link quoted, as measured: unquoted it did not reach the window. No profile copy: the system's claude:// handler.
    const exe = prof ? join(profilesDir(), 'apps', prof.name, `Claude-${prof.name}.exe`) : undefined
    const argv = exe && existsSync(exe) ? [exe, `--user-data-dir="${prof.dir}"`, `"${url}"`] : ['cmd', '/c', 'start', '""', `"${url}"`]
    if (process.env.INBOX_DRY_OPEN) { say(argv.join(' ')); return 0 }
    spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref()
    say(`inbox: opened ${host}${prof ? ` in profile ${prof.name}` : ''}`)
    return 0
  }

  console.error(`inbox: unknown command ${cmd}`)
  return 2
}

main().then((c) => process.exit(c), (e) => { console.error(`inbox: ${e.message}`); process.exit(1) })
