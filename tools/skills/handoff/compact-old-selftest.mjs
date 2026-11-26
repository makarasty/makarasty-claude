#!/usr/bin/env node
// Selftest for compact-old.mjs: fake app profiles, transcripts and CLI in a temp dir; never the machine's real chats.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url)), script = join(here, 'compact-old.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'compact-old-')), prof = join(tmp, 'profiles'), cfg = join(tmp, 'config'), work = join(tmp, 'project')
const recs = join(prof, 'acct', 'claude-code-sessions', 'a', 'o'), proj = join(cfg, 'projects', 'p')
for (const d of [recs, proj, work]) mkdirSync(d, { recursive: true })
let pass = 0, fail = 0
const check = (/** @type {string} */ name, /** @type {boolean} */ ok, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${detail}`}`) }

const id = (/** @type {number} */ n) => `local_aaaaaaaa-0000-0000-0000-00000000000${n}`, cliId = (/** @type {number} */ n) => `cccccccc-0000-0000-0000-00000000000${n}`
const chat = (/** @type {number} */ n, extra = {}) => {
  writeFileSync(join(recs, `${id(n)}.json`), JSON.stringify({ sessionId: id(n), cliSessionId: cliId(n), cwd: work, model: 'claude-opus-5-5', title: `chat ${n}`, isArchived: false, ...extra }))
  writeFileSync(join(proj, `${cliId(n)}.jsonl`), '{"type":"user"}\n{"type":"cost-state","totalCostUSD":100.5}\n')
}
const fake = join(tmp, 'fake-claude.mjs'), log = join(tmp, 'fake.log')
writeFileSync(fake, `import { appendFileSync } from 'node:fs'
const a = process.argv.slice(2), f = ${JSON.stringify(proj)} + '/' + a[a.indexOf('--resume') + 1] + '.jsonl'
if (a[0] === 'auth') { console.log(JSON.stringify({ loggedIn: !process.env.FAKE_SIGNED_OUT })); process.exit(process.env.FAKE_SIGNED_OUT ? 1 : 0) }
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ a, cwd: process.cwd() }) + '\\n')
if (process.env.FAKE_AUTH_FAIL) { appendFileSync(f, JSON.stringify({ type: 'system', subtype: 'local_command', content: '<local-command-stderr>Error during compaction: Failed to authenticate: OAuth session expired and could not be refreshed</local-command-stderr>' }) + '\\n'); process.exit(0) }
if (!process.env.FAKE_NO_BOUNDARY) appendFileSync(f, JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 712345, postTokens: 23456 } }) + '\\n' + JSON.stringify({ type: 'cost-state', totalCostUSD: 103.5 }) + '\\n')`)
const env = { ...process.env, INBOX_PROFILES_DIR: prof, INBOX_CLAUDE: fake, CLAUDE_CONFIG_DIR: cfg }
const C = (/** @type {string[]} */ a, x = {}) => spawnSync(process.execPath, [script, ...a], { env: { ...env, ...x }, encoding: 'utf8' })

chat(1); chat(2, { worktreePath: join(tmp, 'wt') }); chat(3); chat(4, { spawnedFrom: { sessionId: id(3) } }); chat(5, { spawnedFrom: { sessionId: id(3) }, lineageDetached: true })
const c1 = C(['check', id(1)])
check('check: a plain chat may be compacted', c1.status === 0 && c1.stdout.startsWith('ok:'), c1.stdout + c1.stderr)
const c2 = C(['check', id(2)])
check('check: a worktree chat is skipped (archiving would clean the worktree)', c2.status === 3 && /worktree/.test(c2.stdout), c2.stdout)
const c3 = C(['check', id(3)])
check('check: a chat with an attached side session is skipped, a detached one does not count', c3.status === 3 && /chat 4/.test(c3.stdout) && !/chat 5/.test(c3.stdout), c3.stdout)
check('check: an unknown chat is skipped', C(['check', id(9)]).status === 3)
check('check: a plain chat names no pin step', !/pinned/.test(c1.stdout), c1.stdout)
chat(6, { isStarred: true, titleSource: 'tool', lastActivityAt: Date.UTC(2026, 10, 25, 22, 29) })
const c6 = C(['check', id(6)])
check('check: a pinned chat says to unpin first and pin again after unarchive', c6.status === 0 && /pinned: set_pinned false first, set_pinned true after unarchive/.test(c6.stdout), c6.stdout)
check('check: prints the session field the app hook would add (UTC day), plain and archived',
  c6.stdout.includes(`archive session field: "chat 6" (title set by an agent), folder ${work}, last active 2026-11-25 (${id(6)})`) &&
  c6.stdout.includes(`unarchive session field: "chat 6" (title set by an agent), folder ${work}, last active 2026-11-25, archived (${id(6)})`), c6.stdout)
const c7 = C(['check', id(1)], { FAKE_SIGNED_OUT: '1' })
check('check: a signed-out CLI is a skip with the sign-in command, before anything is archived', c7.status === 3 && /signed out/.test(c7.stdout) && /auth login/.test(c7.stdout), c7.stdout)
const r1 = C(['run', id(1)])
check('run: refused while the chat is not archived, /compact is not called', r1.status === 2 && /archive it first/.test(r1.stdout) && !existsSync(log), r1.stdout)
chat(1, { isArchived: true })
const r2 = C(['run', id(1)]), call = existsSync(log) ? JSON.parse(readFileSync(log, 'utf8').trim().split('\n').at(-1) ?? '{}') : {}
check('run: an archived chat is compacted with its own model, safe mode, in its folder; the sizes are reported', r2.status === 0 && /compacted 712K -> 23K in \d+ s; cost \$3\.00 at API prices/.test(r2.stdout) && call.a?.join(' ') === `-p /compact --resume ${cliId(1)} --model claude-opus-5-5 --safe-mode --output-format json` && call.cwd === work, r2.stdout + JSON.stringify(call))
const r3 = C(['run', id(1)], { FAKE_NO_BOUNDARY: '1' })
check('run: a CLI turn that writes no new boundary is a failure', r3.status === 1 && /boundaries (\d+) -> \1\b/.test(r3.stdout), r3.stdout)
const r4 = C(['run', id(1)], { FAKE_AUTH_FAIL: '1' })
check('run: a compaction error the CLI wrote into the transcript is the reason', r4.status === 1 && /Error during compaction: Failed to authenticate: OAuth session expired/.test(r4.stdout), r4.stdout)
check('run: a signed-out CLI is refused before /compact', C(['run', id(1)], { FAKE_SIGNED_OUT: '1' }).status === 3)
rmSync(tmp, { recursive: true, force: true })
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
