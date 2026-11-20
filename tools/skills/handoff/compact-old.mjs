#!/usr/bin/env node
// compact-old.mjs - compacts the chat a handoff left behind, so its later wakes read a summary instead of ~700K.
//
//   node compact-old.mjs check <local_id>   exit 0 "ok: ..." when the chat may be archived and compacted; 3 "skip: <why>"
//   node compact-old.mjs run <local_id>     the chat must be archived (its process stopped); runs /compact on its
//                                           transcript with the bundled CLI and prints "ok: compacted <pre>K -> <post>K"
//
// The order is check, archive_session, run, unarchive_session (the receiving chat does the app calls). A live app
// process keeps its history in memory and writes past the boundary, so run refuses an unarchived chat; after
// unarchive the CLI loads the compacted view (proven twice, 2026-11-20, compact-trigger findings). Archiving cleans
// the chat's worktree and archives its finished side sessions, so check skips both cases.
// Env for tests: INBOX_PROFILES_DIR (app profiles), INBOX_CLAUDE (the CLI), CLAUDE_CONFIG_DIR (transcripts).

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { bundledCli, profilesDir } from '../inbox/cli.mjs'

const ls = (/** @type {string} */ d) => { try { return readdirSync(d) } catch { return [] } }
const readJSON = (/** @type {string} */ f) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return undefined } }

/** Every app record of every profile: { prof, rec }. */
function records() {
  const out = []
  for (const name of ls(profilesDir())) {
    const s = join(profilesDir(), name, 'claude-code-sessions')
    for (const acc of ls(s)) for (const org of ls(join(s, acc))) for (const f of ls(join(s, acc, org))) {
      if (!/^local_[0-9a-f-]{36}\.json$/.test(f)) continue
      const rec = readJSON(join(s, acc, org, f))
      if (rec) out.push({ prof: { name, dir: join(profilesDir(), name) }, rec: { ...rec, sessionId: rec.sessionId || f.slice(0, -5) } })
    }
  }
  return out
}

function transcript(/** @type {string} */ cli) {
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
  for (const p of ls(projects)) { const f = join(projects, p, `${cli}.jsonl`); if (existsSync(f)) return f }
  return undefined
}

const boundaries = (/** @type {string} */ f) => readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('"compact_boundary"'))
// The session's running total (the CLI's own `total_cost_usd` is that total, not this turn's): the last cost-state line.
const spent = (/** @type {string} */ f) => { const l = readFileSync(f, 'utf8').split('\n').filter((x) => x.includes('"cost-state"')).at(-1); try { return Number(JSON.parse(l ?? '').totalCostUSD) || 0 } catch { return 0 } }

function find(/** @type {string} */ id) {
  const host = id.startsWith('local_') ? id : `local_${id}`, all = records()
  return { all, hit: all.find((r) => r.rec.sessionId === host) }
}

function check(/** @type {string} */ id) {
  const { all, hit } = find(id)
  if (!hit) return [3, `skip: no app record for ${id}`]
  const r = hit.rec
  if (!r.cliSessionId) return [3, 'skip: the record has no CLI session id']
  if (r.worktreePath || r.worktreeName || /[\\/]\.claude[\\/]worktrees[\\/]/i.test(String(r.cwd))) return [3, 'skip: it works in a worktree, and archiving would clean that worktree']
  const kids = all.filter((x) => x.rec.spawnedFrom?.sessionId === r.sessionId && !x.rec.lineageDetached && !x.rec.isArchived)
  if (kids.length) return [3, `skip: archiving it would archive its side session(s) too: ${kids.map((k) => k.rec.title || k.rec.sessionId).join(', ')}`]
  if (!transcript(r.cliSessionId)) return [3, `skip: no transcript ${r.cliSessionId}.jsonl`]
  return [0, `ok: ${r.sessionId} (${r.title || 'untitled'}) on ${r.model}; next archive_session, then run`]
}

function run(/** @type {string} */ id) {
  const [code, why] = check(id)
  if (code) return [code, why]
  const { prof, rec } = /** @type {NonNullable<ReturnType<typeof find>['hit']>} */ (find(id).hit)
  if (!rec.isArchived) return [2, 'refused: archive it first; a running chat keeps its old history in memory and writes past the summary']
  const f = /** @type {string} */ (transcript(rec.cliSessionId)), before = boundaries(f).length, usd0 = spent(f), exe = bundledCli(prof), t0 = Date.now()
  // --safe-mode: no plugin hooks (no phone message, no reminders) in this one-off turn; the summary itself needs none.
  const args = ['-p', '/compact', '--resume', rec.cliSessionId, ...(rec.model ? ['--model', rec.model] : []), '--safe-mode', '--output-format', 'json']
  const [cmd, argv] = exe.endsWith('.mjs') ? [process.execPath, [exe, ...args]] : [exe, args]
  const p = spawnSync(cmd, argv, { cwd: rec.cwd, encoding: 'utf8', timeout: 600e3, windowsHide: true })
  const after = boundaries(f)
  if (p.error || p.status !== 0 || after.length <= before) return [1, `failed: exit ${p.status ?? p.error?.message}, boundaries ${before} -> ${after.length}; ${String(p.stderr || '').trim().split('\n')[0] ?? ''}`]
  let m = {}
  try { m = JSON.parse(/** @type {string} */ (after.at(-1))).compactMetadata ?? {} } catch { /* the size is only for the report */ }
  const k = (/** @type {unknown} */ n) => (typeof n === 'number' ? `${Math.round(n / 1000)}K` : '?')
  const usd = spent(f) - usd0, cost = usd > 0 ? `; cost $${usd.toFixed(2)} at API prices` : ''
  return [0, `ok: compacted ${k(/** @type {any} */ (m).preTokens)} -> ${k(/** @type {any} */ (m).postTokens)} in ${Math.round((Date.now() - t0) / 1000)} s${cost}; next unarchive_session ${rec.sessionId}`]
}

const [verb, id] = process.argv.slice(2)
const [code, line] = verb === 'check' && id ? check(id) : verb === 'run' && id ? run(id) : [2, 'usage: node compact-old.mjs check|run <local_id>']
console.log(line)
process.exit(code)
