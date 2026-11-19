// The Telegram poll with no chat open (owner, 2026-11-19): a resident node process, started by Task Scheduler through
// tg-watch.mjs, runs tools/hooks/telegram.ts unchanged with a node stand-in for the hook engine's `$`. It polls as
// session "watcher" under the same lease as the chats, whose own timers take over 30 s after it stops (at once when it
// exits cleanly). Design, task settings and edge cases: docs/TELEGRAM.md "The watcher".
//   node inbox.mjs scheduler on | off | status
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { readFile, readdir, writeFile, rename, mkdir, lstat, unlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mainCli } from './cli.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const TASK = 'makarasty Telegram watcher'
export const SESSION = 'watcher'
const FETCH_MS = 30000, LOCK_STALE_MS = 60000, HUNG_MS = 180000, MAX_FAILS = 120, LOG_MAX = 256 * 1024
const configDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms))

/** Kills a process and everything it started; Windows has no process groups to signal. */
function killTree(/** @type {number | undefined} */ pid) {
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
}

/** One command, the whole output, killed at the time limit: `$.process.run`. It inherits this process's hidden console. */
export function run(/** @type {readonly string[]} */ argv, /** @type {{cwd?: string, env?: Record<string, string>, stdin?: string, timeoutMs?: number}} */ init = {}) {
  return new Promise((resolve, reject) => {
    const exe = argv[0] === 'node' ? process.execPath : String(argv[0])
    /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */ let c
    try { c = spawn(exe, argv.slice(1), { cwd: init.cwd, env: { ...process.env, ...init.env }, windowsHide: true, stdio: 'pipe' }) } catch (e) { reject(e); return }
    const cap = 4 << 20
    let out = '', err = '', settled = false
    c.stdout.on('data', (d) => { if (out.length <= cap) out += d })
    c.stderr.on('data', (d) => { if (err.length <= cap) err += d })
    const ms = init.timeoutMs ?? 30000
    const kill = setTimeout(() => { if (settled) return; settled = true; killTree(c.pid); reject(new Error(`still running after ${ms} ms`)) }, ms)
    c.on('error', (e) => { if (settled) return; settled = true; clearTimeout(kill); reject(e) })
    c.on('close', (code) => {
      if (settled) return
      settled = true; clearTimeout(kill)
      resolve({ exitCode: code ?? 1, stdout: out.slice(0, cap), stderr: err.slice(0, cap), isStdoutTruncated: out.length > cap, isStderrTruncated: err.length > cap })
    })
    c.stdin.on('error', () => undefined)
    c.stdin.end(init.stdin ?? '')
  })
}

/** Writes through a temp file and a rename; a reader holding the file (20-30 chats read `polled` each second) makes the
 *  rename fail on Windows, so it retries, then writes in place as the engine does. Creates the folders, as `$.fs.write`. */
export async function writeText(/** @type {string} */ p, /** @type {string} */ text) {
  await mkdir(dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  await writeFile(tmp, text)
  for (let i = 0; i < 5; i++) {
    try { await rename(tmp, p); return } catch (e) { if (!['EPERM', 'EACCES', 'EBUSY'].includes(/** @type {any} */ (e).code)) break; await sleep(25) }
  }
  await writeFile(p, text)
  await unlink(tmp).catch(() => undefined)
}

/** `$.model.complete` with no tools, plugins, MCP, hooks or saved session, in an empty folder: the engine's call has none of
 *  them, and the prompt is another chat's text that must not reach a file or a tool. The CLI's login pays for it. */
export async function complete(/** @type {{model?: string, prompt?: unknown, system?: string, timeoutMs?: number}} */ req) {
  const prompt = typeof req.prompt === 'string' ? req.prompt : Array.isArray(req.prompt) ? req.prompt.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('\n') : ''
  const cwd = mkdtempSync(join(tmpdir(), 'tg-explain-'))
  try {
    const argv = [mainCli(), '-p', '--model', req.model ?? 'haiku', '--safe-mode', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--output-format', 'json', ...(req.system ? ['--system-prompt', req.system] : [])]
    const r = await run(argv, { cwd, stdin: prompt, timeoutMs: req.timeoutMs ?? 60000 })
    /** @type {any} */ let j
    try { j = JSON.parse(r.stdout) } catch { return { isAnswered: false, reason: 'api-error', status: 0, error: (r.stderr || r.stdout).slice(0, 300) } }
    const text = typeof j?.result === 'string' ? j.result.trim() : ''
    return j?.is_error ? { isAnswered: false, reason: 'api-error', status: 0, error: text.slice(0, 300) } : text ? { isAnswered: true, text } : { isAnswered: false, reason: 'empty-reply' }
  } catch (e) { return { isAnswered: false, reason: 'api-error', status: 0, error: /** @type {Error} */ (e).message } }
  finally { rmSync(cwd, { recursive: true, force: true }) }
}

/** A test Bot API is honoured only on this machine: an environment variable can never redirect the token elsewhere. */
export const localApi = (/** @type {string | undefined} */ a) => (a && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(a) ? a : undefined)

/** The node stand-in for the parts of the hook engine's `$` that telegram.ts uses. `api` (tests): a localhost Bot API. */
export function engine(/** @type {{root: string, session?: string, api?: string}} */ o) {
  const api = localApi(o.api)
  return {
    env: { get: async (/** @type {string} */ n) => process.env[n] || undefined },
    fs: {
      read: async (/** @type {string} */ p) => (await readFile(p, 'utf8')),
      write: writeText,
      exists: async (/** @type {string} */ p) => existsSync(p),
      list: async (/** @type {string} */ p) => Promise.all((await readdir(p)).map(async (name) => {
        const s = await lstat(join(p, name)).catch(() => undefined)
        return { name, kind: s?.isFile() ? 'file' : s?.isDirectory() ? 'directory' : 'other', size: s?.isFile() ? s.size : 0, mtimeMs: s?.isFile() ? s.mtimeMs : 0, isLink: !!s?.isSymbolicLink() }
      })),
    },
    http: {
      // A time limit the engine has and fetch has not: after sleep or a dropped network a request waited 300 s for headers.
      fetch: async (/** @type {string} */ url, /** @type {{method?: string, headers?: Record<string, string>, body?: string}} */ init = {}) => {
        const r = await fetch(api ? url.replace('https://api.telegram.org', api) : url, { method: init.method ?? 'GET', headers: init.headers, body: init.body, signal: AbortSignal.timeout(FETCH_MS) })
        return { status: r.status, ok: r.ok, headers: Object.fromEntries(r.headers), text: await r.text() }
      },
    },
    process: { run },
    plugin: { root: o.root },
    session: { id: async () => o.session ?? SESSION },
    clock: {
      now: async () => Date.now(),
      sleep,
      every: (/** @type {number} */ ms, /** @type {() => void} */ f) => { const h = setInterval(f, ms); return { cancel: () => clearInterval(h) } },
    },
    model: { complete },
  }
}

// ---- the resident loop ----

const alive = (/** @type {number} */ pid) => { try { process.kill(pid, 0); return true } catch (e) { return /** @type {any} */ (e).code === 'EPERM' } }
/** One watcher per config dir: `watcher.lock` = "<pid> <start ms>", touched every 10 s; a lock untouched for a minute
 *  is a dead one's even if its pid was reused. */
export function takeLock(/** @type {string} */ tg) {
  const f = join(tg, 'watcher.lock')
  for (let i = 0; i < 2; i++) {
    try { const fd = openSync(f, 'wx'); writeSync(fd, `${process.pid} ${Date.now()}`); closeSync(fd); return true }
    catch (e) {
      if (/** @type {any} */ (e).code !== 'EEXIST') throw e
      const pid = Number(readFileSync(f, 'utf8').split(' ')[0]) || 0
      let fresh = false
      try { fresh = Date.now() - statSync(f).mtimeMs < LOCK_STALE_MS } catch { /* gone meanwhile */ }
      if (pid && pid !== process.pid && fresh && alive(pid)) return false
      rmSync(f, { force: true })
    }
  }
  return false
}
export const lockOwner = (/** @type {string} */ tg) => {
  try { const f = join(tg, 'watcher.lock'), pid = Number(readFileSync(f, 'utf8').split(' ')[0]) || 0; return pid && Date.now() - statSync(f).mtimeMs < LOCK_STALE_MS && alive(pid) ? pid : 0 } catch { return 0 }
}

// The token travels in every Bot API URL; a log line never carries it.
const scrub = (/** @type {string} */ s) => s.replace(/bot\d{5,}:[\w-]{20,}/g, 'bot<token>').replace(/\b\d{5,}:[\w-]{20,}/g, '<token>')
function logger(/** @type {string} */ tg) {
  const f = join(tg, 'watcher.log')
  return (/** @type {string} */ line) => {
    try {
      if (existsSync(f) && statSync(f).size > LOG_MAX) renameSync(f, `${f}.1`)
      appendFileSync(f, `${new Date().toISOString()} ${scrub(line)}\n`)
    } catch { /* a log that cannot be written never stops the poll */ }
  }
}

/** What the loop does after a tick: keep going, or exit so the task's 1-minute trigger starts a fresh process. */
export function verdict(/** @type {{fails: number, inflightMs: number}} */ s) {
  if (s.inflightMs > HUNG_MS) return 'exit-hung'
  if (s.fails >= MAX_FAILS) return 'exit-failing'
  return 'ok'
}

/** The resident poll. Returns the exit code: 0 a clean stop (plugin moved, signal), 1 hung or failing. */
export async function runWatcher(/** @type {{root: string, pluginRoot?: () => string | undefined, api?: string}} */ o) {
  const cfg = configDir(), tg = join(cfg, 'makarasty', 'telegram')
  mkdirSync(tg, { recursive: true })
  if (!takeLock(tg)) return 0
  const log = logger(tg)
  const { telegramTick } = await import(pathToFileURL(join(here, '..', '..', 'hooks', 'telegram.ts')).href)
  const $ = engine({ root: o.root, api: o.api ?? process.env.WATCHER_TELEGRAM_API })
  log(`start pid ${process.pid}, node ${process.version}, plugin ${o.root}`)
  let fails = 0, inflight = 0
  /** @type {(code: number) => void} */ let stop = () => undefined
  const done = new Promise((r) => { stop = r })
  const tick = setInterval(() => {
    if (inflight) return
    if (!existsSync(join(cfg, 'makarasty', 'inbox.on'))) { fails = 0; return } // inbox off: no poll, as in the chats
    inflight = Date.now()
    telegramTick($).then(() => { fails = 0 }, (/** @type {any} */ e) => {
      fails++
      if (fails === 1 || fails % 30 === 0) log(`tick failed (${fails} in a row): ${e?.message ?? e}`)
    }).finally(() => { inflight = 0 })
  }, 1000)
  const beat = setInterval(() => {
    try { const now = new Date(); utimesSync(join(tg, 'watcher.lock'), now, now) } catch { /* recreated below if lost */ }
    const v = verdict({ fails, inflightMs: inflight ? Date.now() - inflight : 0 })
    if (v !== 'ok') { log(v === 'exit-hung' ? 'a tick has run 3 min: exit for a fresh start' : `${fails} failed ticks in a row: exit for a fresh start`); stop(1); return }
    const now = o.pluginRoot?.()
    if (o.pluginRoot && now !== o.root) { log(`plugin moved to ${now ?? '(none)'}: exit for a fresh start`); stop(0) }
  }, 10000)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => stop(0))
  const code = await done
  clearInterval(tick); clearInterval(beat)
  // Hand the lease to the chats now rather than in 30 s.
  try { if (readFileSync(join(tg, 'polled'), 'utf8').split(' ')[1] === SESSION) writeFileSync(join(tg, 'polled'), `0 ${SESSION}`) } catch { /* no lease */ }
  rmSync(join(tg, 'watcher.lock'), { force: true })
  log(`stop, code ${code}`)
  return code
}

// ---- Task Scheduler ----

const xmlEsc = (/** @type {string} */ s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** The task: at log on and every minute (IgnoreNew makes a running watcher skip it), in his session so screenshots work,
 *  no 72 h limit, normal priority (the default 7 is below normal and its children inherit it), no battery or idle stops. */
export function taskXml(/** @type {{user: string, node: string, launcher: string, config: string, start: string}} */ o) {
  const q = (/** @type {string} */ s) => `"${s}"`
  const args = `--headless ${q(o.node)} ${q(o.launcher)} --config ${q(o.config)}`
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>makarasty-tools</Author><Description>Answers the owner's Telegram bot while no Claude chat is open. inbox.mjs scheduler off removes it.</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${xmlEsc(o.user)}</UserId></LogonTrigger>
    <TimeTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>${o.start}</StartBoundary><Enabled>true</Enabled></TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>${xmlEsc(o.user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xmlEsc(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'conhost.exe'))}</Command><Arguments>${xmlEsc(args)}</Arguments></Exec></Actions>
</Task>
`
}

const schtasks = (/** @type {string[]} */ a) => spawnSync('schtasks', a, { encoding: 'utf8', windowsHide: true })
const ago = (/** @type {number} */ ms) => (ms < 120e3 ? `${Math.round(ms / 1000)} s` : ms < 7200e3 ? `${Math.round(ms / 60e3)} min` : `${Math.round(ms / 3600e3)} h`)

/** `inbox.mjs scheduler on|off|status`. */
export function schedulerCmd(/** @type {string | undefined} */ sub, /** @type {(s: string) => void} */ say = (s) => process.stdout.write(`${s}\n`)) {
  const cfg = configDir(), base = join(cfg, 'makarasty'), tg = join(base, 'telegram')
  if (process.platform !== 'win32') { say('inbox: the scheduled watcher is Windows only; elsewhere the chats poll as before'); return 1 }
  if (sub === 'on') {
    const launcher = join(base, 'bin', 'tg-watch.mjs')
    mkdirSync(dirname(launcher), { recursive: true })
    copyFileSync(join(here, 'tg-watch.mjs'), launcher)
    const user = `${process.env.USERDOMAIN || ''}${process.env.USERDOMAIN ? '\\' : ''}${process.env.USERNAME || ''}`
    const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19) // the task reads it as local time
    const xml = taskXml({ user, node: process.execPath, launcher, config: cfg, start: local })
    const f = join(tmpdir(), `tg-watch-task-${process.pid}.xml`)
    writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')])) // schtasks reads the XML as UTF-16
    const c = schtasks(['/Create', '/TN', TASK, '/XML', f, '/F'])
    rmSync(f, { force: true })
    if (c.status !== 0) { say(`inbox: the task was not created: ${(c.stderr || c.stdout).trim()}`); return 1 }
    const r = schtasks(['/Run', '/TN', TASK])
    say(`inbox: scheduled task "${TASK}" created (at log on and every minute, hidden); ${r.status === 0 ? 'started now' : `not started now: ${(r.stderr || r.stdout).trim()}`}`)
    return 0
  }
  if (sub === 'off') {
    const had = schtasks(['/Query', '/TN', TASK]).status === 0
    if (had) { schtasks(['/End', '/TN', TASK]); schtasks(['/Delete', '/TN', TASK, '/F']) }
    // Only the watcher itself, by the pid in its lock: a reply it started finishes and is sent.
    const pid = lockOwner(tg)
    if (pid) { try { process.kill(pid) } catch { /* gone */ } }
    try { if (readFileSync(join(tg, 'polled'), 'utf8').split(' ')[1] === SESSION) writeFileSync(join(tg, 'polled'), `0 ${SESSION}`) } catch { /* no lease */ }
    rmSync(join(tg, 'watcher.lock'), { force: true })
    rmSync(join(base, 'bin', 'tg-watch.mjs'), { force: true })
    say(`inbox: ${had ? `scheduled task "${TASK}" removed` : 'no scheduled task'}${pid ? `, watcher ${pid} stopped` : ''}; the chats poll Telegram as before`)
    return 0
  }
  if (sub === 'status' || !sub) {
    const q = schtasks(['/Query', '/TN', TASK, '/FO', 'LIST', '/V'])
    const field = (/** @type {string} */ k) => new RegExp(`^${k}:\\s*(.*)$`, 'mi').exec(q.stdout)?.[1]?.trim()
    const pid = lockOwner(tg)
    const [at, who] = (() => { try { return readFileSync(join(tg, 'polled'), 'utf8').split(' ') } catch { return ['0', ''] } })()
    const lastok = Number((() => { try { return readFileSync(join(tg, 'lastok'), 'utf8') } catch { return '0' } })()) || 0
    say(q.status === 0 ? `task: ${field('Status') ?? '?'}, last run ${field('Last Run Time') ?? '?'}, last result ${field('Last Result') ?? '?'}` : 'task: none (`inbox.mjs scheduler on` creates it)')
    say(`watcher: ${pid ? `running, pid ${pid}` : 'not running'}; inbox ${existsSync(join(base, 'inbox.on')) ? 'on' : 'off (nothing polls)'}`)
    say(`poll: lease ${who || '(none)'} ${Number(at) ? `${ago(Date.now() - Number(at))} ago` : ''}; last good poll ${lastok ? `${ago(Date.now() - lastok)} ago` : 'never'}`)
    try { const tail = readFileSync(join(tg, 'watcher.log'), 'utf8').trim().split('\n').slice(-3); if (tail[0]) say(`log:\n  ${tail.join('\n  ')}`) } catch { /* no log yet */ }
    return 0
  }
  say('inbox: scheduler on | off | status'); return 2
}
