#!/usr/bin/env node
// inbox-selftest.mjs - inbox.mjs against a temporary config dir: an item a chat wrote is listed explained, the first
// answer wins and a second is refused, a waiter gets the answer, a push goes out once (notify's dry-run sink), an expired
// item is swept, and the inbox chat never lists its own items. About two seconds, no network.
//   node tools/skills/inbox/inbox-selftest.mjs      exit 0 = every check passed

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  put(item({ id: 'chatB~old', at: Date.now() - 25 * 3600e3 })) // a day old: swept

  const list = run(['list'])
  check('list shows the item explained, with its question and options', list.status === 0 && list.stdout.includes('reports-app — question, waiting 5 min') &&
    list.stdout.includes('Plainly: Чат делает выгрузку') && list.stdout.includes(Q) && list.stdout.includes('- SQLite: файл рядом с отчётом') &&
    list.stdout.includes('Chat on another account: open it with `inbox.mjs open chatA~t1`'), list.stdout)
  check('list skips the inbox chat\'s own item and marks it as the inbox', !list.stdout.includes('inboxChat~t9') && readFileSync(join(root, 'self'), 'utf8') === 'inboxChat')
  check('an expired item is swept', !list.stdout.includes('chatB~old') && !existsSync(join(root, 'items', 'chatB~old.json')))

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
  check('the chat answering itself closes the item', run(['done', 'chatA~t3']).stdout.includes('done') && JSON.parse(readFileSync(join(root, 'answers', 'chatA~t3.json'), 'utf8')).by === 'chat')
  // open: finds the profile that holds the chat and hands the link to that profile's app copy (dry run prints it)
  const host = 'local_9fe89352-d54d-4073-874d-1806f8dacf22'
  const prof = join(tmp, 'profiles')
  mkdirSync(join(prof, 'dev2', 'claude-code-sessions', 'acc', 'org'), { recursive: true })
  writeFileSync(join(prof, 'dev2', 'claude-code-sessions', 'acc', 'org', `${host}.json`), '{}')
  mkdirSync(join(prof, 'apps', 'dev2'), { recursive: true }); writeFileSync(join(prof, 'apps', 'dev2', 'Claude-dev2.exe'), '')
  const o = spawnSync(process.execPath, [cli, 'open', host], { env: { ...env, INBOX_PROFILES_DIR: prof, INBOX_DRY_OPEN: '1' }, encoding: 'utf8' })
  check('open hands the quoted link to the profile that holds the chat', o.status === 0 && o.stdout.includes('Claude-dev2.exe') && o.stdout.includes(`--user-data-dir="${join(prof, 'dev2')}"`) && o.stdout.includes(`"claude://claude.ai/epitaxy/${host}"`), o.stdout + o.stderr)
  const o2 = spawnSync(process.execPath, [cli, 'open', 'local_00000000-0000-0000-0000-000000000000'], { env: { ...env, INBOX_PROFILES_DIR: prof, INBOX_DRY_OPEN: '1' }, encoding: 'utf8' })
  check('a chat in no profile goes to the system link handler', o2.status === 0 && o2.stdout.startsWith('cmd /c start'), o2.stdout)
  // The coordinator: which account a project's new task goes to, the chats of a project, and the list of handed-out work.
  const sess = (/** @type {string} */ profile, /** @type {string} */ id, /** @type {string} */ cwd, /** @type {number} */ ago) => {
    const d = join(prof, profile, 'claude-code-sessions', 'acc', 'org'); mkdirSync(d, { recursive: true })
    writeFileSync(join(d, `local_${id}.json`), JSON.stringify({ cwd, lastActivityAt: Date.now() - ago, cliSessionId: id }))
  }
  const P = 'C:\\work\\oxi-yapper' // Windows separators, as the app writes them
  sess('dev', '11111111-1111-1111-1111-111111111111', P, 9 * 3600e3)
  sess('dev', '22222222-2222-2222-2222-222222222222', `${P}\\.claude\\worktrees\\x`, 9 * 3600e3)
  sess('main', '33333333-3333-3333-3333-333333333333', P, 9 * 3600e3)
  const penv = { ...env, INBOX_PROFILES_DIR: prof }
  const r = (/** @type {string[]} */ a) => spawnSync(process.execPath, [cli, ...a], { env: penv, encoding: 'utf8' })
  check('pick: the account with the most chats of the project when none runs now', r(['pick', 'oxi-yapper']).stdout.startsWith('dev: most chats'), r(['pick', 'oxi-yapper']).stdout)
  sess('dev2', '44444444-4444-4444-4444-444444444444', `${P}\\.claude\\worktrees\\fleet`, 60e3)
  check('pick: the account where a chat of the project runs now wins over the count', r(['pick', 'oxi-yapper']).stdout.startsWith('dev2: a chat of this project runs there now'), r(['pick', 'oxi-yapper']).stdout)
  sess('main', '55555555-5555-5555-5555-555555555555', P, 120e3)
  check("pick: live chats on two accounts is the person's call", r(['pick', 'oxi-yapper']).stdout.startsWith('ASK'), r(['pick', 'oxi-yapper']).stdout)
  check("pick: an unknown project is the person's call", r(['pick', 'nothing-here']).stdout.startsWith('ASK: no chat'))
  const live = r(['chats', 'oxi-yapper', '--live']).stdout.trim().split('\n')
  check('chats --live lists only the running chats of the project, newest first', live.length === 2 && live[0].startsWith('dev2\tlocal_4444') && live[1].startsWith('main\tlocal_5555'), live.join(' / '))
  check('track, note and tasks keep the handed-out work', r(['track', 'local_4444', 'dev2', 'oxi-yapper', 'auto', 'Enter']).status === 0 &&
    r(['note', 'local_4444', 'paused', 'stopped', 'at', 'a', 'safe', 'point']).status === 0 && /^paused\tdev2\tlocal_4444\toxi-yapper\tauto Enter\n\t\tlast: .* stopped at a safe point/.test(r(['tasks']).stdout), r(['tasks']).stdout)
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
  rep({ id: 'chatS~turn-1', at: Date.now() - 4 * 24 * 3600e3, recap: 'старый' })
  const l1 = run(['list'])
  check('list shows reports under Finished, newest of a chat in full, the earlier one as a line', l1.stdout.includes('## Finished: 1 chats, 2 reports') && l1.stdout.includes('vize — finished 2 min ago') &&
    l1.stdout.includes('Сверх задачи: в `build.ts` мёртвый импорт') && l1.stdout.includes('Earlier, 20 min ago: Обновил vite') && l1.stdout.includes('Open the chat: [Обнови зависимости (chatR)](#local_rrrr)'), l1.stdout)
  check('a report older than 3 days is swept', !l1.stdout.includes('старый') && !existsSync(join(root, 'reports', 'chatS~turn-1.json')))
  check('a shown report leaves the next list', run(['list']).stdout.includes('nothing pending'))
  check('reports shows them again', run(['reports']).stdout.includes('Обновил sass.'))
  check('status counts the reports not shown yet', run(['status']).stdout.includes('finish reports not shown yet: 0'))
  // follow / mute / followed: a chat of any account named by a piece of its title, its project or its app id.
  const titled = (/** @type {string} */ profile, /** @type {string} */ id, /** @type {string} */ cwd, /** @type {string} */ title, /** @type {number} */ ago) => {
    const d = join(prof, profile, 'claude-code-sessions', 'acc', 'org'); mkdirSync(d, { recursive: true })
    writeFileSync(join(d, `local_${id}.json`), JSON.stringify({ cwd, title, lastActivityAt: Date.now() - ago, cliSessionId: `cli-${id.slice(0, 4)}` }))
  }
  titled('dev2', '77777777-7777-7777-7777-777777777777', 'C:\\work\\darkkitty', 'Превью и баги', 5 * 60e3)
  titled('main', '88888888-8888-8888-8888-888888888888', 'C:\\work\\darkkitty', 'Старый деплой', 20 * 3600e3)
  titled('main', '99999999-9999-9999-9999-999999999999', 'C:\\work\\lifelines', 'LifeLines отчёты', 2 * 3600e3)
  titled('main', 'aaaaaaaa-9999-9999-9999-999999999999', 'C:\\work\\lifelines', 'LifeLines линтеры', 2 * 3600e3)
  const f1 = r(['follow', 'превью']) // a piece of the title, any case, another account
  check('follow by a piece of the title switches that chat on by app id and session id', f1.status === 0 && f1.stdout.includes('following Превью и баги (local_77777777-7777-7777-7777-777777777777, dev2)') &&
    existsSync(join(root, 'reports', 'on', 'local_77777777-7777-7777-7777-777777777777')) && existsSync(join(root, 'reports', 'on', 'cli-7777')), f1.stdout)
  const f2 = r(['follow', 'LifeLines'])
  check('an ambiguous name lists the candidates and switches nothing', f2.status === 1 && f2.stdout.includes('2 chats match "LifeLines"') && f2.stdout.includes('LifeLines линтеры') &&
    !existsSync(join(root, 'reports', 'on', 'local_99999999-9999-9999-9999-999999999999')), f2.stdout)
  check('a project with one chat active now picks that one', r(['mute', 'darkkitty']).stdout.includes('muted Превью и баги') && !existsSync(join(root, 'reports', 'on', 'cli-7777')))
  r(['follow', 'local_99999999-9999-9999-9999-999999999999'])
  const fl = r(['followed']).stdout
  check('followed lists the followed chats, then the busy ones that are not', /^followed \(1\):\nmain\tlocal_9999.*LifeLines отчёты/.test(fl) && /busy in the last 30 min, not followed \(\d+\):[\s\S]*Превью и баги/.test(fl) && !fl.includes('Старый деплой'), fl)
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
  check('off removes the switch', run(['off']).status === 0 && !existsSync(join(tmp, 'makarasty', 'inbox.on')))
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
