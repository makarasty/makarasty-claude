#!/usr/bin/env node
// Self-check of the Telegram watcher (watcher.mjs): the node stand-in for the hook engine, the lock, the task XML, and
// telegram.ts polling through it against a local fake Bot API, in a temp config dir. `node watcher-selftest.mjs`.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'watcher-selftest-'))
process.env.CLAUDE_CONFIG_DIR = join(tmp, 'cfg')
const W = await import(pathToFileURL(join(here, 'watcher.mjs')).href)
let passed = 0
const check = async (/** @type {string} */ name, /** @type {() => unknown} */ f) => { await f(); passed++; process.stdout.write(`ok ${name}\n`) }
const TOKEN = '123456789:Zq8Lm3Vb7Nx2Wc5Rt9Yh4Js6'
const cfg = process.env.CLAUDE_CONFIG_DIR, tg = join(cfg, 'makarasty', 'telegram')
mkdirSync(tg, { recursive: true })
writeFileSync(join(cfg, 'makarasty', 'notify.json'), JSON.stringify({ telegram: { token: TOKEN, chat_id: '42' } }))
writeFileSync(join(cfg, 'makarasty', 'profile.md'), 'Language: Russian')
writeFileSync(join(cfg, 'makarasty', 'inbox.on'), '1')
// A plugin root whose inbox.mjs only records that the poll started it.
const fakeRoot = join(tmp, 'plugin')
mkdirSync(join(fakeRoot, 'skills', 'inbox'), { recursive: true })
writeFileSync(join(fakeRoot, 'skills', 'inbox', 'inbox.mjs'), `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(join(tmp, 'runs.txt'))}, process.argv.slice(2).join(' ') + '\\n')\n`)

// A fake Bot API: getUpdates hands out `queue` once, everything else succeeds.
/** @type {object[]} */ let queue = []
/** @type {string[]} */ const calls = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d }).on('end', () => {
    const method = String(req.url).split('/').pop() ?? ''
    calls.push(method)
    assert.ok(String(req.url).startsWith(`/bot${TOKEN}/`))
    const result = method === 'getUpdates' ? queue.splice(0) : method === 'sendMessage' ? { message_id: 7 } : true
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, result }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)))
const api = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`

try {
  await check('fs.write creates the folders, leaves no temp file', async () => {
    const p = join(tmp, 'a', 'b', 'c.json')
    await W.writeText(p, 'x1'); await W.writeText(p, 'x2')
    assert.equal(readFileSync(p, 'utf8'), 'x2')
    assert.deepEqual(readdirSync(dirname(p)), ['c.json'])
  })
  await check('fs.read rejects a missing file; fs.list gives the engine shape', async () => {
    const $ = W.engine({ root: fakeRoot })
    await assert.rejects($.fs.read(join(tmp, 'nope.txt')))
    const l = await $.fs.list(join(tmp, 'a', 'b'))
    assert.deepEqual(Object.keys(l[0]).sort(), ['isLink', 'kind', 'mtimeMs', 'name', 'size'])
    assert.equal(l[0].kind, 'file')
  })
  await check('process.run maps node, passes stdin and env, returns the engine shape', async () => {
    const r = await W.run(['node', '-e', 'process.stdin.on("data",d=>process.stdout.write(String(d)+process.env.WX))'], { stdin: 'hi', env: { WX: '!' } })
    assert.equal(r.exitCode, 0); assert.equal(r.stdout, 'hi!'); assert.equal(r.isStdoutTruncated, false)
  })
  await check('process.run kills at timeoutMs and rejects', async () => {
    const t = Date.now()
    await assert.rejects(W.run(['node', '-e', 'setTimeout(()=>{},60000)'], { timeoutMs: 500 }), /still running/)
    assert.ok(Date.now() - t < 5000)
  })
  await check('http.fetch goes to a localhost API only, engine shape', async () => {
    const r = await W.engine({ root: fakeRoot, api }).http.fetch(`https://api.telegram.org/bot${TOKEN}/getMe`, { method: 'POST', body: '{}' })
    assert.equal(r.status, 200); assert.equal(r.ok, true); assert.equal(typeof r.text, 'string')
    for (const bad of ['http://evil.example', 'https://127.0.0.1', 'http://127.0.0.1.evil.example', 'http://localhost@evil.example']) assert.equal(W.localApi(bad), undefined, bad)
    assert.equal(W.localApi('http://localhost:8081'), 'http://localhost:8081')
  })
  await check('one watcher per config dir; a stale lock is taken over', async () => {
    const other = spawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)'])
    const f = join(tg, 'watcher.lock')
    writeFileSync(f, `${other.pid} ${Date.now()}`)
    assert.equal(W.takeLock(tg), false)
    assert.equal(W.lockOwner(tg), other.pid)
    const old = new Date(Date.now() - 120000); utimesSync(f, old, old)
    assert.equal(W.takeLock(tg), true)
    assert.equal(readFileSync(f, 'utf8').split(' ')[0], String(process.pid))
    other.kill(); rmSync(f, { force: true })
  })
  await check('verdict: exits only when hung 3 min or 120 failed ticks', () => {
    assert.equal(W.verdict({ fails: 119, inflightMs: 179000 }), 'ok')
    assert.equal(W.verdict({ fails: 120, inflightMs: 0 }), 'exit-failing')
    assert.equal(W.verdict({ fails: 0, inflightMs: 181000 }), 'exit-hung')
  })
  await check('task XML: indefinite, IgnoreNew, normal priority, interactive, every minute, hidden console', () => {
    const x = W.taskXml({ user: 'PC\\me', node: 'C:\\Program Files\\nodejs\\node.exe', launcher: 'C:\\U\\a&b\\tg-watch.mjs', config: 'C:\\U\\.claude', start: '2026-11-19T20:00:00' })
    for (const s of ['<ExecutionTimeLimit>PT0S<', '<MultipleInstancesPolicy>IgnoreNew<', '<Priority>5<', '<LogonType>InteractiveToken<', '<Interval>PT1M<', '<LogonTrigger>', '--headless', 'a&amp;b', '<DisallowStartIfOnBatteries>false<', '<StopIfGoingOnBatteries>false<']) assert.ok(x.includes(s), s)
    assert.ok(!x.includes('a&b'))
  })

  const { telegramTick } = await import(pathToFileURL(join(here, '..', '..', 'hooks', 'telegram.ts')).href)
  const $ = W.engine({ root: fakeRoot, api })
  const polled = join(tg, 'polled')
  await check('a chat holding a fresh lease: the watcher does not poll', async () => {
    writeFileSync(polled, `${Date.now()} chatA`); calls.length = 0
    await telegramTick($)
    assert.equal(calls.length, 0)
  })
  await check('notify setup holding the lease ahead: the watcher does not poll', async () => {
    writeFileSync(polled, `${Date.now() + 16 * 60e3} setup`); calls.length = 0
    await telegramTick($)
    assert.equal(calls.length, 0)
  })
  await check('a stale lease: the watcher claims it, a message lands in inbound/ and starts the headless inbox', async () => {
    writeFileSync(polled, `${Date.now() - 60000} chatA`); calls.length = 0
    queue = [{ update_id: 5001, message: { message_id: 77, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: 'добавь задачу в Obsidian' } }]
    await telegramTick($)
    assert.equal(readFileSync(polled, 'utf8').split(' ')[1], 'watcher')
    assert.ok(calls.includes('getUpdates'))
    assert.equal(JSON.parse(readFileSync(join(tg, 'inbound', '5001.json'), 'utf8')).text, 'добавь задачу в Obsidian')
    assert.equal(readFileSync(join(tg, 'offset'), 'utf8'), '5002')
    for (let i = 0; i < 50 && !existsSync(join(tmp, 'runs.txt')); i++) await new Promise((r) => setTimeout(r, 100))
    assert.equal(readFileSync(join(tmp, 'runs.txt'), 'utf8').trim(), 'telegram')
  })
  await check('a stranger is ignored and starts nothing', async () => {
    writeFileSync(join(tmp, 'runs.txt'), '')
    queue = [{ update_id: 5002, message: { message_id: 78, chat: { id: 99, type: 'private' }, from: { id: 99 }, text: 'hi' } }]
    await telegramTick($)
    assert.ok(!existsSync(join(tg, 'inbound', '5002.json')))
    assert.equal(readFileSync(join(tmp, 'runs.txt'), 'utf8'), '')
  })
  await check('runWatcher: holds the lease, then on a plugin move exits 0 and hands the lease back', async () => {
    writeFileSync(polled, '0 nobody')
    const script = `const W = await import(${JSON.stringify(pathToFileURL(join(here, 'watcher.mjs')).href)}); const t0 = Date.now();
      process.exitCode = await W.runWatcher({ root: ${JSON.stringify(fakeRoot)}, api: ${JSON.stringify(api)}, pluginRoot: () => (Date.now() - t0 > 3000 ? 'elsewhere' : ${JSON.stringify(fakeRoot)}) })`
    const c = spawn(process.execPath, ['--input-type=module', '-e', script], { env: process.env, stdio: 'ignore' })
    let held = false
    for (let i = 0; i < 40 && !held; i++) { await new Promise((r) => setTimeout(r, 250)); try { held = readFileSync(polled, 'utf8').split(' ')[1] === 'watcher' } catch { /* not yet */ } }
    assert.ok(held, 'the watcher took the lease')
    assert.ok(existsSync(join(tg, 'watcher.lock')))
    const code = await new Promise((r) => c.on('exit', r))
    assert.equal(code, 0)
    assert.equal(readFileSync(polled, 'utf8'), '0 watcher')
    assert.ok(!existsSync(join(tg, 'watcher.lock')))
    assert.match(readFileSync(join(tg, 'watcher.log'), 'utf8'), /plugin moved/)
    assert.ok(!readFileSync(join(tg, 'watcher.log'), 'utf8').includes(TOKEN))
  })
  process.stdout.write(`${passed} passed, 0 failed\n`)
} finally {
  server.close()
  rmSync(tmp, { recursive: true, force: true })
}
