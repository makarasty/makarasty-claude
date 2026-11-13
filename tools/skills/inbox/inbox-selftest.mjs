#!/usr/bin/env node
// inbox-selftest.mjs - inbox.mjs against a temporary config dir: an item a chat wrote is listed explained, the first
// answer wins and a second is refused, a waiter gets the answer, a push goes out once (notify's dry-run sink), an expired
// item is swept, and the inbox chat never lists its own items. About two seconds, no network.
//   node tools/skills/inbox/inbox-selftest.mjs      exit 0 = every check passed

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONSENT, continueAnswer } from './core.mjs'

const cli = join(dirname(fileURLToPath(import.meta.url)), 'inbox.mjs')
const tmp = join(tmpdir(), `inbox-selftest-${process.pid}`)
const root = join(tmp, 'makarasty', 'inbox')
const sink = join(tmp, 'sent')
const env = { ...process.env, CLAUDE_CONFIG_DIR: tmp, NOTIFY_DRY_RUN: sink, CLAUDE_CODE_SESSION_ID: 'inboxChat', CLAUDE_CODE_ACCOUNT_UUID: 'my-account' }
let pass = 0, fail = 0
const check = (/** @type {string} */ name, /** @type {boolean} */ ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${detail}`}`) }
const run = (/** @type {string[]} */ args, input = '') => spawnSync(process.execPath, [cli, ...args], { env, input, encoding: 'utf8' })

const Q = 'Какую базу взять для отчётов?'
const item = (/** @type {Record<string, unknown>} */ o) => ({ kind: 'ask', at: Date.now() - 5 * 60e3, session: 'chatA', cwd: 'C:\\work\\reports-app', chat: 'Сделай выгрузку (chatA)', context: 'assistant: в проекте уже есть Postgres', questions: [{ question: Q, options: [{ label: 'Postgres' }, { label: 'SQLite', description: 'файл рядом с отчётом' }] }], ...o })
const put = (/** @type {Record<string, unknown>} */ it) => { mkdirSync(join(root, 'items'), { recursive: true }); writeFileSync(join(root, 'items', `${it.id}.json`), JSON.stringify(it)) }

try {
  check('on writes the switch', run(['on']).status === 0 && existsSync(join(tmp, 'makarasty', 'inbox.on')))
  put(item({ id: 'chatA~t1', host: 'local_aaaa', account: 'other-account', explain: 'Чат делает выгрузку и спрашивает, какую базу взять.' }))
  put(item({ id: 'inboxChat~t9', session: 'inboxChat' })) // the inbox chat's own: never listed there
  put(item({ id: 'chatB~old', at: Date.now() - 25 * 3600e3 })) // asked and answered more than a day ago: swept
  mkdirSync(join(root, 'answers'), { recursive: true }); writeFileSync(join(root, 'answers', 'chatB~old.json'), JSON.stringify({ id: 'chatB~old', at: Date.now() - 25 * 3600e3, by: 'chat' }))

  const list = run(['list'])
  check('list shows the item explained, with its question and options', list.status === 0 && list.stdout.includes('reports-app — question, waiting 5 min') &&
    list.stdout.includes('Plainly: Чат делает выгрузку') && list.stdout.includes(Q) && list.stdout.includes('- SQLite: файл рядом с отчётом') &&
    list.stdout.includes('Chat on another account: open it with `inbox.mjs open chatA~t1`'), list.stdout)
  check('list skips the inbox chat\'s own item and marks it as the inbox', !list.stdout.includes('inboxChat~t9') && readFileSync(join(root, 'self'), 'utf8') === 'inboxChat')
  check('an answered item a day old is swept', !list.stdout.includes('chatB~old') && !existsSync(join(root, 'items', 'chatB~old.json')))

  // A waiter (the asking chat's hook) blocks until the inbox answers.
  const waiter = spawn(process.execPath, [cli, 'wait', 'chatA~t1', '20000'], { env })
  let out = ''
  waiter.stdout.on('data', (d) => { out += d })
  const exited = new Promise((r) => waiter.on('exit', r))
  const bad = run(['answer', 'chatA~t1', '{"some other question":"x"}'])
  check('an answer missing a question is refused', bad.status === 1 && bad.stderr.includes('no answer for'), bad.stderr)
  const a = run(['answer', 'chatA~t1'], JSON.stringify({ [Q]: 'SQLite' }))
  check('the first answer is written', a.status === 0, a.stderr)
  check('the waiter gets it', (await exited) === 0 && JSON.parse(out).answers[Q] === 'SQLite' && JSON.parse(out).by === 'inbox', out)
  const second = run(['answer', 'chatA~t1', 'Postgres'])
  check('a second answer is refused and names who answered', second.status === 1 && second.stdout.includes('from the inbox'), second.stdout)
  check('done after an answer changes nothing', run(['done', 'chatA~t1']).stdout.includes('already answered') && JSON.parse(readFileSync(join(root, 'answers', 'chatA~t1.json'), 'utf8')).by === 'inbox')
  check('an answered item leaves the list', run(['list']).stdout.includes('nothing pending'))

  put(item({ id: 'chatA~t2', kind: 'choice', ask: 'Запушить ветку fix-login?', actions: ['Да, пушь', 'Не сейчас'], questions: undefined }))
  check('a single-label answer fits a box', run(['answer', 'chatA~t2', 'Да, пушь']).status === 0 && JSON.parse(readFileSync(join(root, 'answers', 'chatA~t2.json'), 'utf8')).choice === 'Да, пушь')

  put(item({ id: 'chatA~t3' }))
  const t = Date.now()
  check('wait times out with exit 3', run(['wait', 'chatA~t3', '600']).status === 3 && Date.now() - t < 5000)
  const p1 = run(['push', 'chatA~t3']), p2 = run(['push', 'chatA~t3'])
  const sent = existsSync(sink) ? readFileSync(sink, 'utf8').trim().split('\n') : []
  check('one push, once, naming the project and the question', p1.status === 0 && p2.status === 0 && sent.length === 1 && sent[0].includes('reports-app') && sent[0].includes(Q), `${p1.stderr} ${sent.join(' / ')}`)
  // A push that fails leaves no marker, so the next tick retries it.
  put(item({ id: 'chatA~t4' }))
  const sentN = () => (existsSync(sink) ? readFileSync(sink, 'utf8').trim().split('\n').length : 0)
  const mark4 = join(root, 'pushed', 'chatA~t4'), failedPush = (/** @type {string} */ id) => spawnSync(process.execPath, [cli, 'push', id], { env: { ...env, NOTIFY_DRY_RUN: tmp }, encoding: 'utf8' }) // a folder as the sink: notify cannot write it
  const failed = failedPush('chatA~t4')
  check('a failed push keeps an attempt record, not the pushed mark', failed.status === 1 && JSON.parse(readFileSync(mark4, 'utf8')).fails === 1, failed.stderr)
  const n0 = sentN()
  check('no retry within 5 minutes', run(['push', 'chatA~t4']).status === 0 && sentN() === n0 && JSON.parse(readFileSync(mark4, 'utf8')).fails === 1)
  writeFileSync(mark4, JSON.stringify({ fails: 1, at: Date.now() - 6 * 60e3 }))
  check('after 5 minutes the push is retried and goes out', run(['push', 'chatA~t4']).status === 0 && sentN() === n0 + 1 && readFileSync(mark4, 'utf8') === '')
  put(item({ id: 'chatA~t5' }))
  writeFileSync(join(root, 'pushed', 'chatA~t5'), JSON.stringify({ fails: 3, at: Date.now() - 3600e3 }))
  check('after 3 failed tries it gives up', run(['push', 'chatA~t5']).status === 0 && sentN() === n0 + 1)
  run(['done', 'chatA~t4']); run(['done', 'chatA~t5'])
  check('the chat answering itself closes the item', run(['done', 'chatA~t3']).stdout.includes('done') && JSON.parse(readFileSync(join(root, 'answers', 'chatA~t3.json'), 'utf8')).by === 'chat')
  // open: finds the profile that holds the chat and hands the link to that profile's app copy (dry run prints it)
  const host = 'local_9fe89352-d54d-4073-874d-1806f8dacf22'
  const prof = join(tmp, 'profiles')
  mkdirSync(join(prof, 'acct2', 'claude-code-sessions', 'acc', 'org'), { recursive: true })
  writeFileSync(join(prof, 'acct2', 'claude-code-sessions', 'acc', 'org', `${host}.json`), '{}')
  // The running windows as Win32_Process rows: acct2 from its renamed copy (plus a renderer child to skip), main from
  // the installed app; the link goes to that exe with the same --user-data-dir, never to the bare claude:// handler.
  const exe2 = 'C:\\Apps\\acct2\\Claude-acct2.exe'
  const procs = [`${exe2}|"${exe2}" --type=renderer --user-data-dir="${join(prof, 'acct2')}"`, `${exe2}|"${exe2}" --user-data-dir="${join(prof, 'acct2')}"`, 'C:\\WA\\Claude.exe|"C:\\WA\\Claude.exe" --user-data-dir="C:\\other\\main"'].join('\n')
  const runP = (/** @type {string[]} */ a, /** @type {string} */ ps = procs) => spawnSync(process.execPath, [cli, ...a], { env: { ...env, INBOX_PROFILES_DIR: prof, INBOX_DRY_OPEN: '1', INBOX_PROCS: ps }, encoding: 'utf8' })
  const o = runP(['open', host])
  check('open hands the quoted link to the running window of the profile that holds the chat', o.status === 0 && o.stdout.startsWith(exe2) && !o.stdout.includes('--type=') && o.stdout.includes(`--user-data-dir="${join(prof, 'acct2')}"`) && o.stdout.includes(`"claude://claude.ai/epitaxy/${host}"`), o.stdout + o.stderr)
  const o2 = runP(['open', 'local_00000000-0000-0000-0000-000000000000'])
  check('a chat in no profile is refused, not sent to the bare link handler (it opened a fresh signed-out app)', o2.status === 1 && !o2.stdout.includes('cmd'), o2.stdout + o2.stderr)
  const o3 = runP(['open', host], '')
  check('no running window of that profile: refused', o3.status === 1 && /no running app window for profile acct2/.test(o3.stderr), o3.stdout + o3.stderr)
  // Two chats of acct2, the later-shown one is what its window shows now: start sends the window back to it.
  const seen = join(prof, 'acct2', 'claude-code-sessions', 'acc', 'org'), shownNow = 'local_11111111-1111-1111-1111-111111111111'
  writeFileSync(join(seen, `${shownNow}.json`), JSON.stringify({ lastFocusedAt: 2000 })); writeFileSync(join(seen, 'local_22222222-2222-2222-2222-222222222222.json'), JSON.stringify({ lastFocusedAt: 1000 }))
  // start: consent, kill switch, mode, gate, RAM floor, lock, journal, ledger. Nothing launches an app: the gate and the RAM
  // read are overridden by env, and the CLI turn is never reached except through a journal already at cli-done.
  let wn = 0 // every prompt gets its own session id: the mark is the prompt (at + session), so equal timestamps must not collide
  const wrote = (/** @type {string} */ text, /** @type {number} */ ago = 1000) => { mkdirSync(root, { recursive: true }); appendFileSync(join(root, 'said.jsonl'), `${JSON.stringify({ at: Date.now() - ago, session: `chatP${++wn}`, text })}\n`) }
  wrote('Please   start a NEW chat for the Cross-Account work, thanks')
  wrote('an ancient request to start the oldest chat', 25 * 3600e3)
  for (const w of ['second quote words here', 'third quote words here', 'fourth quote words here', 'fifth quote words here', 'sixth quote words here', 'eighth quote words here']) wrote(`запусти чат: ${w}`)
  wrote('please start a chat for me okay')
  wrote('these words ask for nothing in particular') // his, but no start verb and no chat name
  wrote('worker-zz needs the report numbers fixed') // names the chat
  const LONG = 'this is a deliberately long request to start a chat on the other account, with many many words in it, please'
  wrote(LONG)
  const Q1 = 'start a new chat for the cross-account'
  const S = (/** @type {string[]} */ a, /** @type {Record<string, string>} */ x = {}) => spawnSync(process.execPath, [cli, ...a], { env: { ...env, INBOX_PROFILES_DIR: prof, INBOX_PROCS: procs, ...x }, encoding: 'utf8' })
  // The same, async: `file` appears after `delay` ms (the app importing the chat while start waits for it).
  const SA = (/** @type {string[]} */ a, /** @type {Record<string, string>} */ x, /** @type {string} */ file, delay = 1000) => new Promise((/** @type {(r: {status: number | null, out: string}) => void} */ res) => {
    const p = spawn(process.execPath, [cli, ...a], { env: { ...env, INBOX_PROFILES_DIR: prof, INBOX_PROCS: procs, ...x } }); let out = ''
    p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { out += d })
    setTimeout(() => writeFileSync(file, '{}'), delay)
    p.on('exit', (status) => res({ status, out }))
  })
  const OPEN = { INBOX_FREEMEM: '99999999999', INBOX_FG: 'other' }
  const sha = (/** @type {string} */ s) => createHash('sha1').update(s).digest('hex')
  const jfile = (/** @type {string} */ name) => join(root, 'starts', `${sha(`acct2|${tmp}|${name}`)}.json`)
  const jget = (/** @type {string} */ name) => { try { return JSON.parse(readFileSync(jfile(name), 'utf8')) } catch { return undefined } }
  const jstate = (/** @type {string} */ name) => jget(name)?.state
  const usedN = () => (existsSync(join(root, 'said-used')) ? readdirSync(join(root, 'said-used')).length : 0)
  const ledgerPath = join(tmp, 'makarasty', 'coord', 'dispatch.jsonl')
  const ledger = () => (existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
  const st = runP(['start', 'acct2', tmp, 'test', '--model', 'opus', 'cross-account', '--switches-window', '--mode', 'plan', '--said', Q1])
  for (const f of [shownNow, 'local_22222222-2222-2222-2222-222222222222']) rmSync(join(seen, `${f}.json`))
  const sid = /--session-id ([0-9a-f-]{36}) -n test cross-account --model opus --permission-mode plan/.exec(st.stdout)?.[1]
  check('start names a CLI turn in the folder and hands its id to that profile through claude://resume', st.status === 0 && st.stdout.startsWith(`cd ${tmp}`) && !!sid && st.stdout.includes(exe2) && st.stdout.includes(`"claude://resume?session=${sid}"`), st.stdout + st.stderr)
  check('start then sends that window back to the chat it showed (highest lastFocusedAt)', st.stdout.includes(`back: claude://claude.ai/epitaxy/${shownNow}`), st.stdout)
  const st2 = runP(['start', 'acct2', tmp, 'test', 'cross-account', '--said', Q1])
  check('a dry run writes nothing under the root: no journal, no mark, no ledger row, no lock, no folders', st2.status === 0 && !existsSync(jfile('test cross-account')) && usedN() === 0 && ledger().length === 0 && !existsSync(join(root, 'starts')) && !existsSync(join(root, 'said-used')))
  check('--said missing is refused (2)', S(['start', 'acct2', tmp, 'x'], OPEN).status === 2)
  check('words under 15 characters or 3 words are refused even when they match a prompt', S(['start', 'acct2', tmp, 'x', '--said', 'start a chat'], { ...OPEN, INBOX_FG: 'claude' }).status === 2 && S(['start', 'acct2', tmp, 'x', '--said', 'startachatforme-ok'], { ...OPEN, INBOX_FG: 'claude' }).status === 2 && !existsSync(jfile('x')))
  check('a profile that does not exist is refused', S(['start', 'nosuch', tmp, 'x', '--said', Q1], OPEN).status === 2)
  const oldQ = S(['start', 'acct2', tmp, 'old', '--said', 'start the oldest chat'], OPEN)
  check('words older than 24 h are refused', oldQ.status === 2 && oldQ.stderr.includes('no matching words of the person in the last 24 h') && !existsSync(jfile('old')), oldQ.stderr)
  check('words the person never typed are refused', S(['start', 'acct2', tmp, 'nope', '--said', 'deploy it to production'], OPEN).status === 2 && !existsSync(jfile('nope')))
  const noVerb = runP(['start', 'acct2', tmp, 'nv', '--said', 'ask for nothing in particular'])
  check('his words with no start verb and no chat name are refused', noVerb.status === 2 && noVerb.stderr.includes('asks for no start') && !existsSync(jfile('nv')), noVerb.stderr)
  const named = runP(['start', 'acct2', tmp, 'worker-zz', '--said', 'needs the report numbers fixed'])
  check('words in a prompt that names the chat count (dry run: nothing written)', named.status === 0 && !existsSync(jfile('worker-zz')) && usedN() === 0, named.stdout + named.stderr)
  const badMode = S(['start', 'acct2', tmp, 'bm', '--said', Q1, '--mode', 'bypassPermissions'], OPEN)
  check('a mode outside default|plan|auto is refused', badMode.status === 2 && badMode.stderr.includes('--mode') && !existsSync(jfile('bm')), badMode.stderr)
  writeFileSync(join(tmp, 'makarasty', 'dispatch.off'), '')
  const off = S(['start', 'acct2', tmp, 'off', '--said', Q1], OPEN)
  check('dispatch.off refuses every start', off.status === 2 && off.stderr.includes('dispatch is off: offer a card') && !existsSync(jfile('off')), off.stderr)
  check('dispatch.off refuses --drain too', S(['start', '--drain'], OPEN).status === 2)
  rmSync(join(tmp, 'makarasty', 'dispatch.off'))
  const fgc = S(['start', 'acct2', tmp, 'n1', '--said', Q1], { ...OPEN, INBOX_FG: 'claude' })
  check('a Claude window in front: queued (4), journal queued, the prompt marked used, a ledger row', fgc.status === 4 && fgc.stdout.includes('queued: a Claude window is in front') && jstate('n1') === 'queued' && usedN() === 1 && ledger().at(-1)?.result.startsWith('queued') && ledger().at(-1)?.gate === 'claude', fgc.stdout + fgc.stderr)
  check('the same words start no second chat', S(['start', 'acct2', tmp, 'n2', '--said', Q1], OPEN).status === 2 && !existsSync(jfile('n2')))
  const cut = S(['start', 'acct2', tmp, 'n2', '--said', 'new chat for the cross-account work'], OPEN)
  check('another cut of the same typed prompt is the same prompt: refused, one prompt one start', cut.status === 2 && cut.stderr.includes('already started a chat') && !existsSync(jfile('n2')) && usedN() === 1, cut.stderr)
  check('a start of the same key again continues its journal without new words', S(['start', 'acct2', tmp, 'n1', '--said', Q1], { ...OPEN, INBOX_FG: 'claude' }).status === 4 && usedN() === 1)
  const diff = S(['start', 'acct2', tmp, 'n1', '--said', Q1, '--model', 'opus'], { ...OPEN, INBOX_FG: 'claude' })
  check('the same key with other flags is refused, not silently run with the old ones', diff.status === 2 && /flags passed now differ/.test(diff.stderr) && jget('n1').model === '', diff.stderr)
  const unk = S(['start', 'acct2', tmp, 'n3', '--said', 'second quote words'], { ...OPEN, INBOX_FG: 'unknown' })
  check('an unreadable foreground window fails closed: queued', unk.status === 4 && jstate('n3') === 'queued' && /could not be read/.test(unk.stdout), unk.stdout + unk.stderr)
  const ram = S(['start', 'acct2', tmp, 'n4', '--said', 'third quote words'], { ...OPEN, INBOX_FREEMEM: String(1024 ** 3) })
  check('under 2 GiB of free RAM: queued, says why', ram.status === 4 && jstate('n4') === 'queued' && /1024 MiB of RAM free/.test(ram.stdout), ram.stdout + ram.stderr)
  const lockF = join(root, 'starts', 'acct2.lock')
  writeFileSync(lockF, 'other')
  const locked = S(['start', 'acct2', tmp, 'n5', '--said', 'fourth quote words'], OPEN)
  check('a fresh lock of the profile: queued, the lock is left alone', locked.status === 4 && /another start of acct2/.test(locked.stdout) && jstate('n5') === 'queued' && readFileSync(lockF, 'utf8') === 'other', locked.stdout + locked.stderr)
  utimesSync(lockF, new Date(Date.now() - 6 * 60e3), new Date(Date.now() - 6 * 60e3))
  const stale = S(['start', 'acct2', tmp, 'n5', '--said', 'x'], { ...OPEN, INBOX_FG: 'claude' })
  check('a lock older than 5 min is retaken (the start reaches the gate) and released', stale.status === 4 && /Claude window is in front/.test(stale.stdout) && !existsSync(lockF), stale.stdout + stale.stderr)
  const lng = S(['start', 'acct2', tmp, 'long', '--said', LONG], { ...OPEN, INBOX_FG: 'claude' })
  const lrow = ledger().at(-1)
  check('the ledger and the journal keep the prompt id and 60 characters of the words, not all of them', lng.status === 4 && lrow.said.length === 60 && /^\d+\|chatP\d+$/.test(lrow.saidId) && jget('long').said.length === 60, JSON.stringify(lrow))
  const rows = ledger()
  check('every attempt left a ledger row with the fields', rows.length >= 6 && rows.every((x) => x.verb === 'start' && x.profile === 'acct2' && x.key && 'gate' in x && 'freemem' in x && 'ms' in x && x.at), JSON.stringify(rows.at(-1)))
  const stat = S(['status'], OPEN)
  check('status prints the ledger and the queued starts', stat.stdout.includes('dispatch ledger, last 10:') && stat.stdout.includes('queued starts: 5') && stat.stdout.includes('queued: a Claude window'), stat.stdout)
  check('starts lists them', S(['starts']).stdout.split('\n').filter((l) => l.startsWith('queued\tacct2')).length === 5, S(['starts']).stdout)
  const dr = S(['start', '--drain'], { ...OPEN, INBOX_FG: 'claude' })
  check('--drain handles one start per run, the oldest; a Claude window in front keeps it queued', dr.status === 4 && dr.stdout.includes('5 queued starts; oldest first, this run stops after the first') && ['n1', 'n3', 'n4', 'n5', 'long'].every((n) => jstate(n) === 'queued') && ledger().length === rows.length + 1 && ledger().at(-1)?.name === 'n1', dr.stdout + dr.stderr)
  // done / imported: the same key prints its host, no second chat. cli-done: the CLI turn is skipped, only the import runs.
  const jw = (/** @type {string} */ name, /** @type {Record<string, unknown>} */ o) => writeFileSync(jfile(name), JSON.stringify({ key: sha(`acct2|${tmp}|${name}`), profile: 'acct2', folder: tmp, name, said: 'x', model: '', effort: '', mode: '', sid: 'ffffffff-0000-0000-0000-000000000006', state: 'queued', at: new Date().toISOString(), updated: new Date().toISOString(), note: '', ...o }))
  const jr = (/** @type {string} */ name, /** @type {string} */ state, /** @type {string} */ sid2) => jw(name, { state, sid: sid2 })
  jr('fin', 'done', 'aaaaaaaa-0000-0000-0000-000000000001')
  const nJ = readdirSync(join(root, 'starts')).length, nU = usedN(), fin = S(['start', 'acct2', tmp, 'fin', '--said', 'anything at all'], { INBOX_FG: 'claude', INBOX_FREEMEM: '1' })
  check('a start whose journal is done prints its host and starts nothing', fin.status === 0 && fin.stdout.includes('local_aaaaaaaa-0000-0000-0000-000000000001') && fin.stdout.includes('next: SendMessage to "fin"') && readdirSync(join(root, 'starts')).length === nJ && usedN() === nU, fin.stdout + fin.stderr)
  jw('stale-done', { state: 'done', sid: 'aaaaaaaa-0000-0000-0000-000000000009', updated: new Date(Date.now() - 25 * 3600e3).toISOString() })
  const again = S(['start', 'acct2', tmp, 'stale-done', '--said', 'eighth quote words'], { ...OPEN, INBOX_FG: 'claude' })
  check('a done journal older than 24 h no longer short-circuits: a new start, a new journal', again.status === 4 && jstate('stale-done') === 'queued' && jget('stale-done').sid !== 'aaaaaaaa-0000-0000-0000-000000000009' && usedN() === nU + 1, again.stdout + again.stderr)
  const sid3 = 'bbbbbbbb-0000-0000-0000-000000000002', sid4 = 'dddddddd-0000-0000-0000-000000000004', backHost = 'local_cccccccc-0000-0000-0000-000000000003', node = process.execPath
  jr('imp', 'cli-done', sid3); jr('imp2', 'cli-done', sid4)
  writeFileSync(join(seen, `${backHost}.json`), JSON.stringify({ lastFocusedAt: 5000 }))
  // the "window" is node itself: the link goes to a process that rejects the unknown flag and exits; the chat shows up in the profile a second later
  const win = { INBOX_PROCS: `${node}|"${node}" --user-data-dir="${join(prof, 'acct2')}"` }
  const imp = await SA(['start', 'acct2', tmp, 'imp', '--said', 'anything at all'], { ...OPEN, ...win }, join(seen, `local_${sid3}.json`))
  check('cli-done: no CLI turn, the import is seen, finish reports switched on, state done, flip-back sent', imp.status === 0 && imp.out.includes(`started local_${sid3}`) && imp.out.includes(`window sent back to ${backHost}`) && imp.out.includes('next: SendMessage') && jstate('imp') === 'done' && existsSync(join(root, 'reports', 'on', `local_${sid3}`)) && ledger().at(-1)?.result === 'done', imp.out)
  const imp2 = await SA(['start', 'acct2', tmp, 'imp2', '--said', 'anything at all'], { ...OPEN, ...win, INBOX_FG: 'other,other,claude' }, join(seen, `local_${sid4}.json`))
  check('the flip-back runs whatever the foreground reads after the import', imp2.status === 0 && imp2.out.includes(`window sent back to ${backHost}`) && jstate('imp2') === 'done', imp2.out)
  const sid5 = 'eeeeeeee-0000-0000-0000-000000000005'
  jr('imp3', 'cli-done', sid5)
  const imp3 = S(['start', 'acct2', tmp, 'imp3', '--said', 'anything at all'], { ...OPEN, ...win, INBOX_FG: 'other,claude' })
  check('a Claude window in front right before the resume link: queued, the journal keeps cli-done', imp3.status === 4 && jstate('imp3') === 'cli-done', imp3.stdout + imp3.stderr)
  // The import not seen in time is an attempt: failed with a note; a retry that finds the chat imported finishes without firing the link again.
  const sid7 = 'eeeeeeee-0000-0000-0000-000000000007'
  jr('imp4', 'cli-done', sid7)
  const imp4 = S(['start', 'acct2', tmp, 'imp4', '--said', 'anything at all'], { ...OPEN, ...win, INBOX_IMPORT_WAIT: '600' })
  check('import not seen in time: failed, one attempt, "not imported in 30 s", the CLI turn is not redone', imp4.status === 1 && jstate('imp4') === 'failed' && jget('imp4').attempts === 1 && jget('imp4').note === 'not imported in 30 s' && jget('imp4').sid === sid7 && ledger().at(-1)?.result === 'failed: import', imp4.stdout + imp4.stderr)
  writeFileSync(join(seen, `local_${sid7}.json`), '{}')
  const imp5 = S(['start', 'acct2', tmp, 'imp4', '--said', 'anything at all'], { ...OPEN, INBOX_FG: 'claude' })
  check('a retry finds it imported meanwhile: done, no flip-back, no link, no gate needed', imp5.status === 0 && imp5.stdout.includes('imported meanwhile') && jstate('imp4') === 'done' && existsSync(join(root, 'reports', 'on', `local_${sid7}`)), imp5.stdout + imp5.stderr)
  // --drain retries a failed start once its last attempt is 10 min old, 3 attempts in all; status lists the failed ones
  const jf = (/** @type {string} */ name, /** @type {number} */ attempts, /** @type {number} */ ageMin) => jw(name, { state: 'failed', attempts, at: '1990-01-01T00:00:00Z', updated: new Date(Date.now() - ageMin * 60e3).toISOString(), note: 'the CLI turn failed: boom' })
  jw('badm', { mode: 'bypassPermissions', at: '1980-01-01T00:00:00Z' })
  const dm = S(['start', '--drain'], { ...OPEN, INBOX_FG: 'claude' })
  check('--drain re-checks the mode of the journal: failed with no attempts left, and the next start is tried', dm.status === 4 && dm.stderr.includes('bypassPermissions') && jstate('badm') === 'failed' && jget('badm').attempts === 3 && ledger().at(-1)?.name === 'n1' && ledger().at(-2)?.result === 'refused: mode', dm.stdout + dm.stderr)
  rmSync(jfile('badm'))
  // no running window of that profile: an attempt, failed with the reason; the drain goes on to the next (the first gate read is open, the second closed)
  jw('nw', { at: '1985-01-01T00:00:00Z' })
  const dn = S(['start', '--drain'], { ...OPEN, INBOX_FG: 'other,claude', INBOX_PROCS: '' })
  check('--drain: a start with no window of its profile becomes failed (one attempt, the reason) and does not block the next', dn.status === 4 && jstate('nw') === 'failed' && jget('nw').attempts === 1 && /no running app window/.test(jget('nw').note) && ledger().at(-1)?.name === 'n1', dn.stdout + dn.stderr)
  rmSync(jfile('nw'))
  jf('f-new', 1, 1); jf('f-old', 1, 11); jf('f-last', 3, 60)
  const dr2 = S(['start', '--drain'], { ...OPEN, INBOX_FG: 'claude' })
  check('--drain retries a failed start older than 10 min with attempts left, not a recent one or one at 3 attempts', dr2.stdout.includes('queued start') && jstate('f-old') === 'queued' && jstate('f-new') === 'failed' && jstate('f-last') === 'failed', dr2.stdout + dr2.stderr)
  check('status shows a failed start that is out of attempts', /failed \(3 attempts\)\tacct2\tf-last/.test(S(['status'], OPEN).stdout), S(['status'], OPEN).stdout)
  writeFileSync(ledgerPath, `${Array.from({ length: 2600 }, (_, i) => JSON.stringify({ at: 'x', verb: 'start', n: i })).join('\n')}\n`)
  S(['start', 'acct2', tmp, 'n1', '--said', Q1], { ...OPEN, INBOX_FG: 'claude' })
  check('the ledger is trimmed to its last 2000 rows once it passes 2500', ledger().length === 2000 && ledger().at(-1)?.name === 'n1' && ledger()[0].n === 601, String(ledger().length))
  // The standing answer: a relaunch at ~700K context needs no typed prompt, only a line of answers.md and a live old chat of the same profile and folder.
  writeFileSync(join(tmp, 'makarasty', 'answers.md'), ['- Relaunch a chat at ~700K context: «Да, все чаты» — every chat relaunches itself with a handoff, no question (2026-11-12)', '- Deploy to staging: «Да» — about 700 users, no question', '- Relaunch a chat when it is slow: «Да» — every chat relaunches itself, no limit stated'].join('\n'))
  const relChat = (/** @type {string} */ profile, /** @type {string} */ n, /** @type {string} */ cwd, /** @type {boolean} */ archived = false) => {
    const d = join(prof, profile, 'claude-code-sessions', 'acc', 'org'); mkdirSync(d, { recursive: true })
    const host = `local_aaaaaaaa-0000-0000-0000-00000000000${n}`; writeFileSync(join(d, `${host}.json`), JSON.stringify({ cwd, lastActivityAt: Date.now(), isArchived: archived })); return { host, f: join(d, `${host}.json`) }
  }
  const oA = relChat('acct2', '1', tmp), oB = relChat('acct2', '2', tmp), oDev = relChat('dev', '3', tmp), oDir = relChat('acct2', '4', join(tmp, 'elsewhere')), oArc = relChat('acct2', '5', tmp, true)
  const SW = '--standing', STAND = 'every chat relaunches itself'
  const sdir = join(root, 'standing-used'), standN = () => (existsSync(sdir) ? readdirSync(sdir).length : 0)
  const RL = (/** @type {string} */ name, /** @type {string[]} */ rest, x = {}) => S(['start', 'acct2', tmp, name, ...rest], { ...OPEN, INBOX_FG: 'claude', ...x })
  const said0 = usedN(), rows0 = ledger().length
  const dryS = S(['start', 'acct2', tmp, 'rl-dry', SW, STAND, '--relaunch-of', oB.host], { ...OPEN, INBOX_DRY_OPEN: '1' })
  check('standing: a dry run prints the plan and writes nothing (no journal, no standing mark, no ledger row)', dryS.status === 0 && dryS.stdout.startsWith(`cd ${tmp}`) && !existsSync(jfile('rl-dry')) && standN() === 0 && ledger().length === rows0, dryS.stdout + dryS.stderr)
  const rl1 = RL('rl1', [SW, STAND, '--relaunch-of', oA.host])
  check('standing: a relaunch line plus a live old chat of the same profile and folder passes consent and stops at the gate: queued, journal keeps the line and relaunchOf', rl1.status === 4 && jstate('rl1') === 'queued' && jget('rl1').relaunchOf === oA.host && /Relaunch a chat at ~700K/.test(jget('rl1').standing) && standN() === 1 && usedN() === said0, rl1.stdout + rl1.stderr)
  check('standing: the ledger row says consent standing and names the old chat', ledger().at(-1)?.consent === 'standing' && ledger().at(-1)?.relaunchOf === oA.host && ledger().at(-1)?.gate === 'claude', JSON.stringify(ledger().at(-1)))
  const rl2 = RL('rl2', [SW, STAND, '--relaunch-of', oA.host])
  check('standing: a second relaunch of the same old chat is refused (exit 2, no journal)', rl2.status === 2 && /relaunched already/.test(rl2.stderr) && !existsSync(jfile('rl2')) && standN() === 1, rl2.stderr)
  check('standing: the same start again continues its journal', RL('rl1', [SW, STAND, '--relaunch-of', oA.host]).status === 4)
  const refused = (/** @type {string} */ what, /** @type {string[]} */ rest) => { const r = RL(`rl-${what}`, rest); check(`standing: ${what} is refused (2), nothing written`, r.status === 2 && !existsSync(jfile(`rl-${what}`)) && standN() === 1, r.stdout + r.stderr) }
  refused('a line that is not in answers.md', [SW, 'every chat obeys the owner', '--relaunch-of', oB.host])
  refused('a substring under 15 characters', [SW, 'relaunches itself', '--relaunch-of', oB.host].map((v) => (v === 'relaunches itself' ? 'relaunches' : v)))
  refused('a line about 700 that is not a relaunch', [SW, 'about 700 users', '--relaunch-of', oB.host])
  refused('a relaunch line without 700', [SW, 'no limit stated', '--relaunch-of', oB.host])
  refused('an old chat of another profile', [SW, STAND, '--relaunch-of', oDev.host])
  refused('an old chat in another folder', [SW, STAND, '--relaunch-of', oDir.host])
  refused('an archived old chat', [SW, STAND, '--relaunch-of', oArc.host])
  refused('an old chat that does not exist', [SW, STAND, '--relaunch-of', 'local_aaaaaaaa-0000-0000-0000-0000000000ff'])
  refused('--said together with --standing', ['--said', Q1, SW, STAND, '--relaunch-of', oB.host])
  refused('--standing without --relaunch-of', [SW, STAND])
  for (const o of [oA, oB, oDev, oDir, oArc]) rmSync(o.f)
  for (const h of [`local_${sid3}`, `local_${sid4}`, `local_${sid7}`, backHost]) rmSync(join(seen, `${h}.json`), { force: true })
  // The coordinator: which account a project's new task goes to, the chats of a project, and the list of handed-out work.
  const sess = (/** @type {string} */ profile, /** @type {string} */ id, /** @type {string} */ cwd, /** @type {number} */ ago) => {
    const d = join(prof, profile, 'claude-code-sessions', 'acc', 'org'); mkdirSync(d, { recursive: true })
    writeFileSync(join(d, `local_${id}.json`), JSON.stringify({ cwd, lastActivityAt: Date.now() - ago, cliSessionId: id }))
  }
  const P = 'C:\\work\\proj-alpha' // Windows separators, as the app writes them
  sess('dev', '11111111-1111-1111-1111-111111111111', P, 9 * 3600e3)
  sess('dev', '22222222-2222-2222-2222-222222222222', `${P}\\.claude\\worktrees\\x`, 9 * 3600e3)
  sess('main', '33333333-3333-3333-3333-333333333333', P, 9 * 3600e3)
  const penv = { ...env, INBOX_PROFILES_DIR: prof }
  const r = (/** @type {string[]} */ a) => spawnSync(process.execPath, [cli, ...a], { env: penv, encoding: 'utf8' })
  check('pick: the account with the most chats of the project when none runs now', r(['pick', 'proj-alpha']).stdout.startsWith('dev: most chats'), r(['pick', 'proj-alpha']).stdout)
  sess('acct2', '44444444-4444-4444-4444-444444444444', `${P}\\.claude\\worktrees\\fleet`, 60e3)
  check('pick: the account where a chat of the project runs now wins over the count', r(['pick', 'proj-alpha']).stdout.startsWith('acct2: a chat of this project runs there now'), r(['pick', 'proj-alpha']).stdout)
  sess('main', '55555555-5555-5555-5555-555555555555', P, 120e3)
  check("pick: live chats on two accounts is the person's call", r(['pick', 'proj-alpha']).stdout.startsWith('ASK'), r(['pick', 'proj-alpha']).stdout)
  check("pick: an unknown project is the person's call", r(['pick', 'nothing-here']).stdout.startsWith('ASK: no chat'))
  const live = r(['chats', 'proj-alpha', '--live']).stdout.trim().split('\n')
  check('chats --live lists only the running chats of the project, newest first', live.length === 2 && live[0].startsWith('acct2\tlocal_4444') && live[1].startsWith('main\tlocal_5555'), live.join(' / '))
  check('track, note and tasks keep the handed-out work', r(['track', 'local_4444', 'acct2', 'proj-alpha', 'auto', 'Enter']).status === 0 &&
    r(['note', 'local_4444', 'paused', 'stopped', 'at', 'a', 'safe', 'point']).status === 0 && /^paused\tacct2\tlocal_4444\tproj-alpha\tauto Enter\n\t\tlast: .* stopped at a safe point/.test(r(['tasks']).stdout), r(['tasks']).stdout)
  check('a note for an untracked chat is refused', r(['note', 'local_9999', 'done']).status === 1)
  r(['note', 'local_4444', 'done'])
  check('done work leaves the default list and stays in --all', r(['tasks']).stdout.includes('no tracked work') && r(['tasks', '--all']).stdout.startsWith('done'))
  // Finish reports: the switch per chat, shown once by list, again by reports, swept after 3 days.
  check('report on/off writes and removes the chat\'s switch', run(['report', 'on', 'chatR']).status === 0 && existsSync(join(root, 'reports', 'on', 'chatR')) &&
    run(['report', 'off', 'chatR']).status === 0 && !existsSync(join(root, 'reports', 'on', 'chatR')))
  check('report on with no id switches on the chat running it', run(['report', 'on']).stdout.includes('on for inboxChat') && existsSync(join(root, 'reports', 'on', 'inboxChat')))
  check('track of an app id switches its reports on', r(['track', 'local_66666666-6666-6666-6666-666666666666', 'main', 'p', 'task']).status === 0 && existsSync(join(root, 'reports', 'on', 'local_66666666-6666-6666-6666-666666666666')))
  const rep = (/** @type {Record<string, unknown>} */ o) => { mkdirSync(join(root, 'reports'), { recursive: true }); writeFileSync(join(root, 'reports', `${o.id}.json`), JSON.stringify({ session: String(o.id).split('~')[0], cwd: 'C:\\work\\vize', chat: 'Обнови зависимости (chatR)', host: 'local_rrrr', account: 'my-account', ...o })) }
  rep({ id: 'chatR~turn-1', at: Date.now() - 20 * 60e3, recap: 'Обновил vite, тесты зелёные.' })
  rep({ id: 'chatR~turn-2', at: Date.now() - 2 * 60e3, recap: 'Обновил sass.', excerpt: 'Готово. Сверх задачи: в `build.ts` мёртвый импорт.' })
  rep({ id: 'chatS~turn-1', at: Date.now() - 8 * 24 * 3600e3, recap: 'старый' })
  const l1 = run(['list'])
  check('list shows reports under Finished, newest of a chat in full, the earlier one as a line', l1.stdout.includes('## Finished: 1 chats, 2 reports') && l1.stdout.includes('vize — finished 2 min ago') &&
    l1.stdout.includes('Сверх задачи: в `build.ts` мёртвый импорт') && l1.stdout.includes('Earlier, 20 min ago: Обновил vite') && l1.stdout.includes('Open the chat: [Обнови зависимости (chatR)](#local_rrrr)'), l1.stdout)
  check('a report older than 7 days is swept', !l1.stdout.includes('старый') && !existsSync(join(root, 'reports', 'chatS~turn-1.json')))
  check('a shown report leaves the next list', run(['list']).stdout.includes('nothing pending'))
  check('reports shows them again', run(['reports']).stdout.includes('Обновил sass.'))
  check('status counts the reports not shown yet', run(['status']).stdout.includes('finish reports not shown yet: 0'))
  // A report nobody has seen outlives the 3 days; once shown, it goes at 3.
  rep({ id: 'chatU~turn-1', at: Date.now() - 4 * 24 * 3600e3, recap: 'не показан' })
  check('an unseen report 4 days old is kept and listed', run(['reports']).stdout.includes('не показан') && existsSync(join(root, 'reports', 'chatU~turn-1.json')))
  check('list shows it once', run(['list']).stdout.includes('не показан') && run(['list']).stdout.includes('nothing pending'))
  check('a shown report 4 days old is swept', !run(['reports']).stdout.includes('не показан') && !existsSync(join(root, 'reports', 'chatU~turn-1.json')))
  // follow / mute / followed: a chat of any account named by a piece of its title, its project or its app id.
  const titled = (/** @type {string} */ profile, /** @type {string} */ id, /** @type {string} */ cwd, /** @type {string} */ title, /** @type {number} */ ago) => {
    const d = join(prof, profile, 'claude-code-sessions', 'acc', 'org'); mkdirSync(d, { recursive: true })
    writeFileSync(join(d, `local_${id}.json`), JSON.stringify({ cwd, title, lastActivityAt: Date.now() - ago, cliSessionId: `cli-${id.slice(0, 4)}` }))
  }
  titled('acct2', '77777777-7777-7777-7777-777777777777', 'C:\\work\\proj-beta', 'Превью и баги', 5 * 60e3)
  titled('main', '88888888-8888-8888-8888-888888888888', 'C:\\work\\proj-beta', 'Старый деплой', 20 * 3600e3)
  titled('main', '99999999-9999-9999-9999-999999999999', 'C:\\work\\proj-gamma', 'Gamma отчёты', 2 * 3600e3)
  titled('main', 'aaaaaaaa-9999-9999-9999-999999999999', 'C:\\work\\proj-gamma', 'Gamma линтеры', 2 * 3600e3)
  const f1 = r(['follow', 'превью']) // a piece of the title, any case, another account
  check('follow by a piece of the title switches that chat on by app id and session id', f1.status === 0 && f1.stdout.includes('following Превью и баги (local_77777777-7777-7777-7777-777777777777, acct2)') &&
    existsSync(join(root, 'reports', 'on', 'local_77777777-7777-7777-7777-777777777777')) && existsSync(join(root, 'reports', 'on', 'cli-7777')), f1.stdout)
  const f2 = r(['follow', 'Gamma'])
  check('an ambiguous name lists the candidates and switches nothing', f2.status === 1 && f2.stdout.includes('2 chats match "Gamma"') && f2.stdout.includes('Gamma линтеры') &&
    !existsSync(join(root, 'reports', 'on', 'local_99999999-9999-9999-9999-999999999999')), f2.stdout)
  check('a project with one chat active now picks that one', r(['mute', 'proj-beta']).stdout.includes('muted Превью и баги') && !existsSync(join(root, 'reports', 'on', 'cli-7777')))
  r(['follow', 'local_99999999-9999-9999-9999-999999999999'])
  const fl = r(['followed']).stdout
  check('followed lists the followed chats, then the busy ones that are not', /^followed \(1\):\nmain\tlocal_9999.*Gamma отчёты/.test(fl) && /busy in the last 30 min, not followed \(\d+\):[\s\S]*Превью и баги/.test(fl) && !fl.includes('Старый деплой'), fl)
  check('a name nothing matches is refused', r(['follow', 'нет-такого']).status === 1)
  // The watchdog: an item waiting while the inbox chat is inside a turn is no broken wake; the same item while idle is.
  put(item({ id: 'chatW~t1', at: Date.now() - 70e3 }))
  writeFileSync(join(root, 'self'), 'inboxChat')
  writeFileSync(join(root, 'turn'), `busy ${Date.now()}`)
  const wenv = { ...env, INBOX_WATCHDOG_MS: '100' }
  const busy = spawnSync(process.execPath, [cli, 'watchdog'], { env: wenv, encoding: 'utf8', timeout: 1500 })
  check('the watchdog stays quiet while the inbox chat is in a turn', busy.status === null && !busy.stdout.includes('INBOX WATCHDOG'), busy.stdout)
  writeFileSync(join(root, 'turn'), `idle ${Date.now()}`)
  const idle = spawnSync(process.execPath, [cli, 'watchdog'], { env: wenv, encoding: 'utf8', timeout: 5000 })
  check('the watchdog calls the wake broken when the inbox chat is idle', idle.status === 1 && idle.stdout.includes('the wake is broken') && idle.stdout.includes('last tick never'), idle.stdout)
  // A chat on a plugin copy with no turn file: its own transcript written after the item came in means it is at work.
  const tr = join(tmp, 'projects', 'C--work', 'inboxChat.jsonl')
  mkdirSync(dirname(tr), { recursive: true }); writeFileSync(tr, '{}')
  rmSync(join(root, 'turn'), { force: true })
  const old = spawnSync(process.execPath, [cli, 'watchdog'], { env: wenv, encoding: 'utf8', timeout: 1500 })
  check('the watchdog stays quiet when the inbox chat transcript changed after the item (no turn file)', old.status === null && !old.stdout.includes('INBOX WATCHDOG'), old.stdout)
  utimesSync(tr, new Date(Date.now() - 600e3), new Date(Date.now() - 600e3)) // idle since before the item
  writeFileSync(join(root, 'turn'), `busy ${Date.now() - 3 * 3600e3}`)
  const lost = spawnSync(process.execPath, [cli, 'watchdog'], { env: wenv, encoding: 'utf8', timeout: 5000 })
  check('a busy mark older than 2 h counts as lost: the alarm goes off', lost.status === 1, lost.stdout)
  // An item answered late is kept until delivered; a day after its answer it goes (answered by the chat itself: at once).
  const late = (/** @type {string} */ id, /** @type {string} */ by) => { put(item({ id, kind: 'choice', ask: 'Q?', actions: ['Да'], questions: undefined, at: Date.now() - 30 * 3600e3 })); writeFileSync(join(root, 'answers', `${id}.json`), JSON.stringify({ id, at: Date.now() - 25 * 3600e3, by, choice: 'Да' })) }
  late('chatL~t1', 'inbox'); late('chatL~t2', 'chat')
  run(['list'])
  check('an inbox answer given a day ago but not delivered keeps its item', existsSync(join(root, 'items', 'chatL~t1.json')) && existsSync(join(root, 'answers', 'chatL~t1.json')))
  check('an item the chat answered itself a day ago is swept', !existsSync(join(root, 'items', 'chatL~t2.json')))
  mkdirSync(join(root, 'delivered'), { recursive: true }); writeFileSync(join(root, 'delivered', 'chatL~t1'), '1')
  run(['list'])
  check('delivered, a day after its answer, it is swept', !existsSync(join(root, 'items', 'chatL~t1.json')) && !existsSync(join(root, 'answers', 'chatL~t1.json')))
  // Answered on day 6.9 and not delivered: kept past day 7; the hard cap is 14 days from the question.
  const aged = (/** @type {string} */ id, /** @type {number} */ days) => { put(item({ id, kind: 'choice', ask: 'Q?', actions: ['Да'], questions: undefined, at: Date.now() - days * 24 * 3600e3 })); writeFileSync(join(root, 'answers', `${id}.json`), JSON.stringify({ id, at: Date.now() - 3600e3, by: 'inbox', choice: 'Да' })) }
  aged('chatL~t3', 6.9); aged('chatL~t4', 15)
  run(['list'])
  check('an inbox answer an hour old, question 6.9 days old, undelivered: kept', existsSync(join(root, 'items', 'chatL~t3.json')) && existsSync(join(root, 'answers', 'chatL~t3.json')))
  check('a question 15 days old is swept even undelivered', !existsSync(join(root, 'items', 'chatL~t4.json')))
  writeFileSync(join(root, 'items', 'chatL~t3.json'), JSON.stringify(item({ id: 'chatL~t3', kind: 'choice', ask: 'Q?', actions: ['Да'], questions: undefined, at: Date.now() - 7.1 * 24 * 3600e3 })))
  run(['list'])
  check('still kept once the question passes 7 days (answered, undelivered)', existsSync(join(root, 'items', 'chatL~t3.json')))
  rmSync(join(root, 'items', 'chatL~t3.json'), { force: true }); rmSync(join(root, 'answers', 'chatL~t3.json'), { force: true })
  // A day-old question nobody answered stays; the night does not eat it.
  rmSync(join(root, 'turn'), { force: true })
  put(item({ id: 'chatN~t1', at: Date.now() - 25 * 3600e3 }))
  check('an unanswered item a day old is kept', run(['list']).stdout.includes('chatN~t1') && existsSync(join(root, 'items', 'chatN~t1.json')))
  put(item({ id: 'chatN~t2', at: Date.now() - 8 * 24 * 3600e3 }))
  run(['list'])
  check('an unanswered item 8 days old is swept', !existsSync(join(root, 'items', 'chatN~t2.json')))
  // list does not take the inbox from another chat whose timer beat just now; --take does.
  const beat = (/** @type {number} */ ago) => writeFileSync(join(root, 'beat'), String(Date.now() - ago))
  writeFileSync(join(root, 'self'), 'otherChat'); beat(10e3)
  const ro = run(['list'])
  check('list leaves a live inbox chat alone and says how to take over', ro.status === 0 && ro.stdout.includes('inbox: otherChat is the inbox chat (beat ') && ro.stdout.includes('inbox.mjs list --take') && readFileSync(join(root, 'self'), 'utf8') === 'otherChat', ro.stdout)
  check('a dead inbox chat (no beat for 3 min) is taken over', (beat(180e3), run(['list']).status === 0) && readFileSync(join(root, 'self'), 'utf8') === 'inboxChat')
  writeFileSync(join(root, 'self'), 'otherChat'); beat(10e3)
  check('--take moves the inbox here', run(['list', '--take']).status === 0 && readFileSync(join(root, 'self'), 'utf8') === 'inboxChat')
  // A plain terminal (no session id) listing while a live inbox exists does not mark reports as seen.
  writeFileSync(join(root, 'self'), 'otherChat'); beat(10e3)
  rep({ id: 'chatV~turn-1', at: Date.now() - 60e3, recap: 'ещё не видел' })
  const term = spawnSync(process.execPath, [cli, 'list'], { env: { ...env, CLAUDE_CODE_SESSION_ID: '' }, encoding: 'utf8' })
  check('a terminal list leaves reports unseen and the inbox chat alone', term.stdout.includes('otherChat is the inbox chat') && !existsSync(join(root, 'reports', 'seen', 'chatV~turn-1')) && readFileSync(join(root, 'self'), 'utf8') === 'otherChat', term.stdout)
  writeFileSync(join(root, 'self'), 'inboxChat'); run(['list'])
  // The coordinator's task file is written through a unique temp name: a leftover fixed name cannot block it.
  mkdirSync(join(tmp, 'makarasty', 'coord', 'tasks.json.tmp'), { recursive: true })
  check('tasks.json does not use a fixed temp name', run(['track', 'chatT', 'main', 'p', 'task']).status === 0 && existsSync(join(tmp, 'makarasty', 'coord', 'tasks.json')))
  // continueAnswer: only a pure continue question with a yes-like option, and nothing that needs the person's own consent.
  const ask = (/** @type {string} */ q, /** @type {string[]} */ labels) => ({ kind: 'ask', questions: [{ question: q, options: labels.map((label) => ({ label })) }] })
  check('continueAnswer picks the recommended yes-like option', JSON.stringify(continueAnswer(/** @type {any} */ (ask('Продолжать?', ['Нет', 'Да (Рекомендую)'])))) === JSON.stringify({ 'Продолжать?': 'Да (Рекомендую)' }))
  check('continueAnswer refuses consent words, no yes option, and a non-continue question', !continueAnswer(/** @type {any} */ (ask('Продолжить и закоммитить?', ['Да']))) && !continueAnswer(/** @type {any} */ (ask('Continue?', ['Stop', 'Show plan']))) && !continueAnswer(/** @type {any} */ (ask('Какую базу?', ['Да'])))  && CONSENT.test('Deploy now') && CONSENT.test('удалить') && !CONSENT.test('Продолжить, довести до конца'))
  const full = (/** @type {Record<string, unknown>} */ q) => /** @type {any} */ ({ kind: 'ask', questions: [{ question: 'Продолжать?', options: [{ label: 'Да' }, { label: 'Нет' }], ...q }] })
  const stakes = ['Продолжать и запушить?', 'Продолжить и смержить в master?', 'Продолжать, задеплоить на прод?', 'Продолжить выкатку на прод?', 'Продолжить, стереть старые данные?', 'Продолжить, перезаписав прод-базу?', 'Продолжить и отправить письмо клиенту?', 'Continue and ship it to production?', 'Продолжить и сбросить базу?', 'Продолжить, снести старую ветку?', 'Продолжить и откатить миграцию?', 'Продолжить и залить на сервер?', 'Продолжить и очистить папку dist?', 'Continue and reset the database?', 'Continue with a force rebase?', 'Continue and buy the domain?', 'Continue and close the PR?']
  check('continueAnswer refuses a stake in the question, however prefixed', stakes.every((q) => !continueAnswer(full({ question: q }))) && !!continueAnswer(full({})) && !!continueAnswer(full({ question: 'Продолжить с миграцией схемы?' })) && !continueAnswer(full({ question: 'Продолжить, пока ты не уйдёшь на обед и мы не вернёмся к этому разговору позже?' })))
  check('continueAnswer refuses a stake in the header, a description or a preview', !continueAnswer(full({ header: 'Деплой' })) && !continueAnswer(full({ options: [{ label: 'Да', description: 'выкатит на прод' }, { label: 'Нет' }] })) && !continueAnswer(full({ options: [{ label: 'Да', preview: 'git push origin master' }, { label: 'Нет' }] })))
  check('continueAnswer refuses a choice between approaches and options that are not one yes plus one no', !continueAnswer(full({ question: 'Как продолжим?', options: [{ label: 'Продолжить через REST (Рекомендую)' }, { label: 'Продолжить через GraphQL' }] })) && !continueAnswer(full({ options: [{ label: 'Да' }, { label: 'Нет' }, { label: 'Позже' }] })) && !continueAnswer(full({ options: [{ label: 'Да' }, { label: 'Сначала покажи план' }] })))
  // list shows what a standing rule answered, once, with the undo hint.
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'auto.jsonl'), JSON.stringify({ at: Date.now() - 60e3, id: 'chatZ~t1', chat: 'Чат Z (chatZ)', question: 'Продолжать?', label: 'Да', rule: 'Continue questions: answered yes.' }) + '\n')
  const auto1 = run(['list']), auto2 = run(['list'])
  check('list shows an answer given by a standing rule once, with the undo hint', auto1.stdout.includes('## Answered by a standing rule (last 24 h)') && auto1.stdout.includes('отмени chatZ~t1') && !auto2.stdout.includes('standing rule'), auto1.stdout + auto2.stdout)
  // scan: questions waiting in live chats of any account, read from the shared transcript tree, filed as items.
  const cdir = join(prof, 'dev', 'claude-code-sessions', 'acc7', 'org'); mkdirSync(cdir, { recursive: true })
  const tdir = join(tmp, 'projects', 'C--work-scan'); mkdirSync(tdir, { recursive: true })
  const T = Math.floor(Date.now() / 1000) * 1000 - 2 * 3600e3 // the question's timestamp (2 h ago): `at` must carry it
  const line = (/** @type {string} */ type, /** @type {unknown} */ content, /** @type {Record<string, unknown>} */ x = {}) => JSON.stringify({ type, timestamp: new Date(x.ts ? Number(x.ts) : T).toISOString(), message: { role: type, content }, ...x })
  const askTool = (/** @type {string} */ id) => ({ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question: `Which DB for ${id}?`, options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] } })
  const wrapTool = (/** @type {string} */ id) => ({ type: 'tool_use', id, name: 'mcp__ccd_turn__wrap_up', input: { ask: `Push the branch ${id}?`, recap: 'Fixed login.', actions: [{ label: 'Yes, push' }, { label: 'Not now' }] } })
  /** @param {string} name @param {string[]} lines @param {{ago?: number, archived?: boolean}} [o] */
  const chat = (name, lines, o = {}) => {
    const cli = randomUUID(), host = `local_${randomUUID()}`
    writeFileSync(join(cdir, `${host}.json`), JSON.stringify({ cliSessionId: cli, cwd: `C:\\work\\${name}`, title: `Chat ${name}`, lastActivityAt: Date.now() - (o.ago ?? 60e3), isArchived: !!o.archived }))
    writeFileSync(join(tdir, `${cli}.jsonl`), `${lines.join('\n')}\n`)
    return { cli, host }
  }
  const u = (/** @type {string} */ text) => line('user', text)
  const toolRes = (/** @type {string} */ id) => line('user', [{ type: 'tool_result', tool_use_id: id, content: 'ok' }])
  const open1 = chat('open-ask', [u('Сделай выгрузку'), line('assistant', [{ type: 'text', text: 'Нужна база.' }, askTool('toolu_A1')])])
  const answered = chat('answered-ask', [u('x'), line('assistant', [askTool('toolu_A2')]), toolRes('toolu_A2'), line('assistant', [{ type: 'text', text: 'ok' }])])
  const wrapLater = chat('wrap-later', [u('x'), line('assistant', [wrapTool('toolu_W1')]), u('да, пушь')])
  const wrapOpen = chat('wrap-open', [u('Почини логин'), line('assistant', [wrapTool('toolu_W2')])])
  const existing = chat('has-item', [u('x'), line('assistant', [askTool('toolu_A3')])])
  const held = chat('held', [u('x'), line('assistant', [askTool('toolu_A4')])])
  const me = chat('inbox-itself', [u('x'), line('assistant', [askTool('toolu_A5')])])
  const oldChat = chat('stale', [u('x'), line('assistant', [askTool('toolu_A6')])], { ago: 30 * 3600e3 })
  const arch = chat('archived', [u('x'), line('assistant', [askTool('toolu_A7')])], { archived: true })
  const side = chat('sidechain', [u('x'), line('assistant', [askTool('toolu_A8')], { isSidechain: true })])
  const big = chat('big', [...Array.from({ length: 3000 }, (_, i) => line('user', `${'filler '.repeat(150)}${i}`)), line('assistant', [askTool('toolu_A9')])])
  const meta = chat('meta-after', [u('x'), line('assistant', [askTool('toolu_B1')]), line('user', 'hook text', { isMeta: true })])
  const old8 = chat('eight-days', [u('x'), line('assistant', [askTool('toolu_D8')], { ts: Date.now() - 8 * 24 * 3600e3 })]) // the chat is active now, its question is 8 days old
  const wrapRe = chat('wrap-reask', [u('x'), line('assistant', [wrapTool('toolu_R2')])])
  const idOf = (/** @type {{cli: string}} */ c, /** @type {string} */ t) => `${c.cli}~${t}`
  mkdirSync(join(root, 'items'), { recursive: true }); mkdirSync(join(tmp, 'makarasty', 'hold', held.cli), { recursive: true })
  writeFileSync(join(root, 'items', `${idOf(existing, 'toolu_A3')}.json`), '{"mine":1}')
  writeFileSync(join(tmp, 'makarasty', 'hold', held.cli, 'index.md'), 'collecting\n- a\n')
  // the inbox chat is whoever runs the scan: its own session id
  // an earlier box of wrap-reask that the inbox answered and the chat has not taken yet
  mkdirSync(join(root, 'answers'), { recursive: true })
  writeFileSync(join(root, 'items', `${wrapRe.cli}~toolu_R1.json`), JSON.stringify({ id: `${wrapRe.cli}~toolu_R1`, kind: 'choice', at: T, session: wrapRe.cli, ask: 'Push?', actions: ['Yes'] }))
  writeFileSync(join(root, 'answers', `${wrapRe.cli}~toolu_R1.json`), JSON.stringify({ id: `${wrapRe.cli}~toolu_R1`, at: T, by: 'inbox', choice: 'Yes' }))
  const meEnv = { ...penv, CLAUDE_CODE_SESSION_ID: me.cli }
  const sc = spawnSync(process.execPath, [cli, 'scan'], { env: meEnv, encoding: 'utf8' })
  const itemOf = (/** @type {{cli: string}} */ c, /** @type {string} */ t) => { try { return JSON.parse(readFileSync(join(root, 'items', `${idOf(c, t)}.json`), 'utf8')) } catch { return undefined } }
  const a1 = itemOf(open1, 'toolu_A1'), w2 = itemOf(wrapOpen, 'toolu_W2')
  check('scan files an open AskUserQuestion as an ask item with its questions, chat, folder, app id, account, time', sc.status === 0 && a1?.kind === 'ask' && a1.questions[0].question === 'Which DB for toolu_A1?' && a1.session === open1.cli && a1.host === open1.host && a1.cwd === 'C:\\work\\open-ask' && a1.account === 'acc7' && a1.profile === 'dev' && a1.at === T && a1.found === 'scan' && a1.chat.startsWith('Chat open-ask (') && a1.context.includes('assistant: Нужна база.'), sc.stdout + sc.stderr + JSON.stringify(a1))
  check('scan files a wrap_up ask nobody answered as a choice item with its actions and recap', w2?.kind === 'choice' && w2.ask === 'Push the branch toolu_W2?' && w2.actions.join('|') === 'Yes, push|Not now' && w2.recap === 'Fixed login.' && w2.found === 'scan', JSON.stringify(w2))
  check('scan prints one line per filed item', sc.stdout.split('\n').filter((l) => l.startsWith('inbox: found a waiting question')).length === 4 && sc.stdout.includes('toolu_W2'), sc.stdout)
  check('scan files nothing for an answered AskUserQuestion, nor a wrap_up with a later prompt', !itemOf(answered, 'toolu_A2') && !itemOf(wrapLater, 'toolu_W1'))
  check('scan leaves an existing item alone (no duplicate, no rewrite)', readFileSync(join(root, 'items', `${idOf(existing, 'toolu_A3')}.json`), 'utf8') === '{"mine":1}' && !sc.stdout.includes('toolu_A3'))
  check('scan skips a hold chat, the inbox chat itself, a chat idle over 24 h, an archived one, a subagent turn', !itemOf(held, 'toolu_A4') && !itemOf(me, 'toolu_A5') && !itemOf(oldChat, 'toolu_A6') && !itemOf(arch, 'toolu_A7') && !itemOf(side, 'toolu_A8'))
  check('a question older than 24 h is not filed even in a chat active now', !itemOf(old8, 'toolu_D8') && !sc.stdout.includes('toolu_D8'))
  check('a wrap_up while the chat\'s earlier box answer is undelivered is not filed', !itemOf(wrapRe, 'toolu_R2') && !sc.stdout.includes('toolu_R2'))
  mkdirSync(join(root, 'delivered'), { recursive: true }); writeFileSync(join(root, 'delivered', `${wrapRe.cli}~toolu_R1`), '1')
  check('once that answer is delivered the wrap_up is filed (found: scan)', spawnSync(process.execPath, [cli, 'scan'], { env: meEnv, encoding: 'utf8' }).stdout.includes('toolu_R2') && itemOf(wrapRe, 'toolu_R2')?.found === 'scan')
  check('scan reads the tail of a transcript far bigger than the tail', !!itemOf(big, 'toolu_A9'))
  check('a hook-injected meta message after the question does not cancel it', !!itemOf(meta, 'toolu_B1'))
  const sc2 = spawnSync(process.execPath, [cli, 'scan'], { env: meEnv, encoding: 'utf8' })
  check('a second scan files nothing again', sc2.stdout.includes('scan found no waiting question') && !sc2.stdout.includes('found a waiting'), sc2.stdout)
  check('an answered item is not filed again by a scan', (writeFileSync(join(root, 'answers', `${idOf(open1, 'toolu_A1')}.json`), '{}'), rmSync(join(root, 'items', `${idOf(open1, 'toolu_A1')}.json`)), !spawnSync(process.execPath, [cli, 'scan'], { env: meEnv, encoding: 'utf8' }).stdout.includes('toolu_A1')))
  // list: becoming the inbox (first mark, or --take) scans; an ordinary list of the inbox chat does not
  const lateChat = chat('late-ask', [u('x'), line('assistant', [askTool('toolu_L1')])])
  writeFileSync(join(root, 'self'), 'otherChat'); writeFileSync(join(root, 'beat'), String(Date.now() - 10e3))
  const ro2 = spawnSync(process.execPath, [cli, 'list'], { env: meEnv, encoding: 'utf8' })
  check('a read-only list scans nothing', !ro2.stdout.includes('toolu_L1') && !itemOf(lateChat, 'toolu_L1'), ro2.stdout)
  const tk = spawnSync(process.execPath, [cli, 'list', '--take'], { env: meEnv, encoding: 'utf8' })
  check('list --take scans, and the filed item is in the same list', tk.stdout.includes('toolu_L1') && !!itemOf(lateChat, 'toolu_L1') && tk.stdout.includes('Which DB for toolu_L1?'), tk.stdout)
  const lateChat2 = chat('late-ask2', [u('x'), line('assistant', [askTool('toolu_L2')])])
  spawnSync(process.execPath, [cli, 'list'], { env: meEnv, encoding: 'utf8' })
  check('a plain list by the chat that already is the inbox does not scan', !itemOf(lateChat2, 'toolu_L2'))
  writeFileSync(join(root, 'self'), 'inboxChat')
  check('off removes the switch', run(['off']).status === 0 && !existsSync(join(tmp, 'makarasty', 'inbox.on')))
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
