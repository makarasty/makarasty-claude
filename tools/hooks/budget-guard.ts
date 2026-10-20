import type { Register } from 'claude-code'

// Enforces the "Verify budget" rule: a whole-repo typecheck or whole-suite test run costs gigabytes, and several agent
// sessions share one 32 GB box. On a Bash or PowerShell call that is a HEAVY verify run it refuses when
//   1. another heavy verify run is already live on the machine (wait for it, or scope this one), or
//   2. the run goes to the background with no kill-after limit (a hung run holds its RAM for hours).
// Shape borrowed from git-guard and delete-guard: a function hook, a small lexer, an exported pure `check`. Unlike them
// it spawns one process, the listing, and only after the line itself has shown it is a heavy run, so `git status` and
// `npm install` never pay for it.
//
// Heavy: vitest/jest/mocha/ava/playwright test with no file filter, tsc/vue-tsc on a project, `npm|pnpm|yarn|bun test`
// `typecheck` `check` scripts, `nx run-many`, `turbo run test`, `gradlew test|check|build`, `cargo test`, `pytest` with no
// path, `node --test` with no file, `node scripts/fleet-selftest.mjs`. Scoped runs pass: a file or directory operand,
// `-t`/`--grep`/`-k`, `--changed`/`--related`, `--project <one>`, `--filter`, `-p <tsconfig of one package>`, a qualified
// gradle task (`:app:test`), `cargo test -p x`; so do `--version`/`--help`/`--listTests`. A single package's tsconfig is
// scoped; `-p .` and `-p tsconfig.json` are the repo's own and heavy.
//
// Watch mode is not a verify run, in the call or among the live processes: the owner's `tsc --watch` or `vitest` watcher
// runs all day and must not block every typecheck. A live vitest counts only with `run`/`--run` for the same reason.
//
// Known limits (not code): a heavy run hidden in a script file (`bash check.sh`), in a variable, or behind a name the lexer
// does not know is not seen; a PowerShell `Start-Process`/`Start-Job` of a heavy run counts as foreground; a hung live run
// blocks until its owner ends it (the refusal names the pid); the machine-wide listing also sees runs of other users.

// `age`: seconds the process has run, when the listing could read it.
type Proc = { pid: number; cmd: string; age?: number }
type Seg = { words: string[]; bg: boolean }
type Run = { text: string; bg: boolean; timeout: boolean }
export type { Proc }

// Splits a command line into commands of words. Quotes and escapes are read; `$( )` and parens are plain separators, so a
// run inside a substitution is a command of its own. A single `&` (not `&&`, not `2>&1`) sends the command before it to
// the background. `esc` is the shell's escape character.
// A heredoc body (`<<EOF ... EOF`) and a PowerShell here-string are text, not commands: `git commit -F - <<'EOF'` with
// "npm test passes" in it is no run. Cut only when the terminator is found; after 50 openers the rest is left in place.
// shortcut: a heredoc fed to a shell (`bash <<EOF`) is code and is skipped too; upgrade if a run hides there.
function noDocs(src: string, ps: boolean): string {
  if (ps) return src.replace(/@'[\s\S]*?'@|@"[\s\S]*?"@/g, ' ')
  let out = '', pos = 0, tries = 0
  const re = /(?<!<)<<(?!<)-?[ \t]*['"]?(\w+)['"]?/g
  for (let m = re.exec(src); m && tries < 50; m = re.exec(src)) {
    tries++
    const nl = src.indexOf('\n', re.lastIndex)
    if (nl < 0) break
    const end = new RegExp(`\\n[ \\t]*${m[1]}[ \\t]*(?=\\r?\\n|$)`, 'g')
    end.lastIndex = nl
    const t = end.exec(src)
    if (!t) continue
    out += src.slice(pos, nl) + '\n'
    pos = t.index + t[0].length
    re.lastIndex = pos
  }
  return out + src.slice(pos)
}

function segments(src: string, ps: boolean): Seg[] {
  src = noDocs(src, ps)
  const out: Seg[] = []
  const esc = ps ? '`' : '\\'
  let words: string[] = [], cur = '', has = false
  // `( ... ) &` and `{ ...; } &` send the whole group to the background: where each open group began, and the group that
  // just closed (its first segment, and how many segments stood when it closed).
  const open: number[] = []
  let closed: { from: number; at: number } | undefined
  const word = (): void => { if (has) words.push(cur); cur = ''; has = false }
  // Redirections are no arguments: `2>&1`, `> out.log`, `&>f`, `< in`.
  const noRedirect = (ws: string[]): string[] => {
    const r: string[] = []
    for (let k = 0; k < ws.length; k++) if (/^(&|\d*)(>>?|<)/.test(ws[k]!)) { if (/^(&|\d*)(>>?|<)&?$/.test(ws[k]!)) k++ } else r.push(ws[k]!)
    return r
  }
  const seg = (bg = false): void => { word(); words = noRedirect(words); if (words.length) out.push({ words, bg }); words = [] }
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!, n = src[i + 1] ?? ''
    if (c === esc && /[\r\n]/.test(n)) { word(); i += n === '\r' && src[i + 2] === '\n' ? 2 : 1 } // a line continuation
    else if (c === esc) {
      // In Bash a backslash before an ordinary character stays, so an unquoted `C:\x` still reads as a Windows path.
      if (ps || '"\'\\;&|()<>$` *?~#'.includes(n)) { cur += n; i++ } else cur += c
      has = true
    } else if (c === "'" && (!has || /[=:]/.test(src[i - 1] ?? ''))) {
      // A quote opens at the start of a word or after `=`; inside a word (`don't`) it is a letter and swallows nothing.
      const e = src.indexOf("'", i + 1), end = e < 0 ? src.length : e; cur += src.slice(i + 1, end); has = true; i = end
    } else if (c === '"') {
      let end = i + 1
      for (; end < src.length && src[end] !== '"'; end++) { if (src[end] === esc && src[end + 1] === '"') end++; cur += src[end] }
      has = true; i = end
    } else if (c === '&') {
      if (n === '&') { seg(); i++ } // `&&`
      else if (src[i - 1] === '>' || src[i - 1] === '<' || n === '>') { cur += c; has = true } // `2>&1`, `&>file`
      else if (ps) word() // PowerShell's `&` is the call operator
      else {
        seg(true)
        if (closed && closed.at === out.length) for (let k = closed.from; k < out.length; k++) out[k]!.bg = true
      }
    } else if (c === '(' || (c === '{' && !has && /\s/.test(n))) { seg(); open.push(out.length) }
    else if (c === ')' || (c === '}' && !has && /^[\s;&|)]?$/.test(n))) { seg(); closed = { from: open.pop() ?? out.length, at: out.length } }
    else if (c === '\n' || c === ';' || c === '|') seg()
    else if (/\s/.test(c)) word()
    else if (c === '#' && !has) { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e - 1 }
    else { cur += c; has = true }
  }
  seg()
  return out
}

// A process command line as words: double quotes group, nothing else is read.
const argv = (cmd: string): string[] => [...cmd.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!)

const ALIAS: Record<string, string> = { 'npm-cli': 'npm', 'npx-cli': 'npx' }
// The tool a word names: the file name of a path, lower case, without its launcher suffix. Flags stay as written.
// `playwright` anywhere in a path is the test runner's cli (`@playwright/test/cli.js`).
function tok(w: string): string {
  if (w.startsWith('-')) return w
  if (/playwright/i.test(w) && /[\\/]/.test(w)) return 'playwright'
  const t = w.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(exe|cmd|bat|ps1|mjs|cjs|js)$/, '')
  return t.endsWith('gradlewrappermain') ? 'gradlew' : (ALIAS[t] ?? t)
}

// Flags that take the next word as their value, so it is not mistaken for a file or a filter.
const VALUE = /^(-c|--config|--root|-r|--reporter|--outputfile|--pool|--max-?workers|--min-?workers|-j|--jobs|--test-?timeout|--hook-?timeout|--environment|--mode|--dir|--shard|--timeout|--require|--import|-p|--project|--filter|-F|-t|-g|-k|-m|-n|--grep|--tests|--package|--test-?name-?pattern|--test-?path-?pattern|--cov|--rootdir|--maxfail|--tb|--ignore|--target|--module|--lib|--outdir|--jsx|--types|--outfile|--declarationdir|--moduleresolution|--prefix|--cwd|-C|--workspace)$/i
const PM_VALUE = /^(--filter|-F|--prefix|--cwd|-C|--dir|--workspace|-w)$/
const INFO = /^(--version|-h|--help|--listtests|--list|--collect-only|--co|--showconfig|--init|--listfilesonly|--dry-run)$/i
// A filter that narrows what runs: by test name, by changed files, by project.
const SCOPE = /^(-t|-g|-k|--grep|--testnamepattern|--testpathpattern|--test-name-pattern|--changed|--onlychanged|--only-changed|--related|--findrelatedtests|--project|--filter|-F|--workspace|--prefix|--cwd|--lf|--last-failed)(=|$)/i
// Not a verify run: a watcher, vitest's UI server, gradle's continuous build.
const WATCH = /^(--watch|--watchall|--watch=true|--ui|--continuous)$/i
// The package scripts that are surely the whole suite or the whole typecheck. Any other `test:<x>` (`test:changed`, `test:dom`,
// `test:rules`) is a project's own scoped or small script, and `check` means lint in one repo and everything in the next.
const SCRIPT = /^(t|tst|tests?|typecheck|type-check|test:all|test:ci)$/i
const TARGET = /^(test|typecheck|type-check)$/i
// `command` and `builtin` are not wrappers: `command -v tsc` looks a tool up, it does not run it.
const WRAP = new Set(['time', 'nice', 'nohup', 'env', 'cross-env', 'npx', 'bunx', 'pnpx', 'exec', 'sudo', 'stdbuf', 'call', 'xvfb-run', 'dotenv'])

// The words that are not flags, each flag's value skipped, up to `--`.
function pos(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--') break
    if (a.startsWith('-')) { if (VALUE.test(a)) i++; continue }
    out.push(a)
  }
  return out
}
const flag = (args: string[], re: RegExp): boolean => args.some((a) => re.test(a))
// `tsc -p packages/a` is one package; `-p .` and `-p tsconfig.json` (or `tsconfig.app.json`) are the repo's own project.
function project(args: string[]): string | undefined {
  const i = args.findIndex((a) => /^(-p|--project)$/i.test(a))
  return i >= 0 ? args[i + 1] : args.find((a) => /^(-p|--project)=/i.test(a))?.split('=')[1]
}
const ROOT_PROJECT = /^(\.|\.\/|(\.\/)?tsconfig(\.[\w-]+)*\.json)$/i

// Is this tool, with these arguments, a heavy verify run? `live` reads a process's command line: its rules are the same,
// except that a run that may be a watcher does not count.
function heavyTool(t: string, args: string[], live: boolean): boolean {
  // `-v` is a version flag for these tools; for pytest and cargo it is verbose.
  if (flag(args, INFO) || flag(args, /^-V$/) || (flag(args, /^-v$/) && /^(vitest|jest|mocha|ava|tsc|vue-tsc)$/.test(t))) return false
  const ps = pos(args)
  switch (t) {
    case 'vitest': case 'jest': case 'mocha': case 'ava': {
      if (flag(args, WATCH) || (t === 'mocha' && flag(args, /^-w$/))) return false
      // A bare `vitest` is a watcher on a terminal; only `run` is surely a one-shot.
      if (/^(dev|serve|watch)$/.test(ps[0] ?? '')) return false
      if (t === 'vitest' && (ps[0] === 'list' || (live && ps[0] !== 'run' && !flag(args, /^--run$/)))) return false
      const rest = t === 'vitest' && /^(run|watch|dev|related|bench|typecheck)$/.test(ps[0] ?? '') ? ps.slice(1) : ps
      return !(flag(args, SCOPE) || rest.length || ps[0] === 'related')
    }
    case 'tsc': case 'vue-tsc': {
      if (flag(args, /^(-w|--watch)$/i)) return false
      const p = project(args)
      return !(ps.length || (p !== undefined && !ROOT_PROJECT.test(p)))
    }
    case 'playwright': return ps[0] === 'test' && !(ps.length > 1 || flag(args, SCOPE))
    case 'pytest': return !(ps.length || flag(args, SCOPE) || flag(args, /^-(k|m)$/))
    case 'nx': return ps[0] === 'run-many' && !flag(args, /^(--projects|--exclude)(=|$)/)
    case 'turbo': return (ps[0] === 'run' ? ps.slice(1) : ps).some((s) => TARGET.test(s)) && !flag(args, SCOPE)
    case 'gradlew': case 'gradle': return !flag(args, /^(--tests(=|$)|-t$)/) && !flag(args, WATCH) && ps.some((s) => /^(test|check|build)$/i.test(s))
    case 'cargo': {
      const own = args.includes('--') ? args.slice(0, args.indexOf('--')) : args
      const sub = pos(own).filter((s) => !s.startsWith('+'))
      return (sub[0] === 'test' || sub[0] === 't') && !(sub.length > 1 || flag(own, /^(-p|--package|--test|--lib|--bin|--doc|--example)(=|$)/))
    }
    case 'fleet-selftest': return true
    default: return false
  }
}

// One command's words: is it a heavy verify run, and does a kill-after limit (`timeout N`) stand in front of it?
// `ps`: PowerShell, which has no `timeout` prefix (its `timeout` is a sleep), so a `timeout` word is no limit there.
function analyze(W: string[], live: boolean, ps: boolean, depth = 0, timeout = false): { heavy: boolean; timeout: boolean } {
  const no = { heavy: false, timeout }
  for (let i = 0; i < W.length; i++) {
    const w = W[i]!, t = tok(w)
    if (w.startsWith('-') || /^\$?(env:)?[A-Za-z_]\w*=/.test(w) || WRAP.has(t) || /^([{}!]|then|do|else|elif)$/.test(w)) continue
    if (t === 'timeout' || t === 'gtimeout') {
      timeout ||= !ps // PowerShell's own `timeout` is a sleep, no limit; its arguments are still skipped
      for (i++; W[i]?.startsWith('-'); ) i += /^(-k|-s|--kill-after|--signal)$/.test(W[i]!) ? 2 : 1 // W[i] is now the duration
      continue
    }
    if (t === 'node' || t === 'nodejs') {
      let j = i + 1, test = false
      for (; W[j]?.startsWith('-'); j++) {
        const f = W[j]!.toLowerCase()
        if (/^(-e|--eval|-p|--print|-v|--version|-h|--help|-c|--check)$/.test(f)) return no
        if (f === '--test') test = true
        if (/^(--import|-r|--require|--loader|--experimental-loader|--env-file|-C|--conditions|--input-type|--stack-size|--test-reporter|--test-name-pattern|--test-concurrency|--test-timeout|--test-reporter-destination)$/.test(f)) j++
      }
      // `node --test` alone runs every test file it finds; a file operand or a name pattern scopes it.
      if (test) return { heavy: !W[j] && !flag(W, /^--test-name-pattern/) && !flag(W, WATCH), timeout }
      i = j - 1; continue // the script is the next tool
    }
    if (/^(python[\d.]*|py)$/.test(t)) {
      let j = i + 1
      while (W[j]?.startsWith('-') && W[j] !== '-m') j++
      i = W[j] === '-m' ? j : j - 1; continue
    }
    if (t === 'java') {
      let j = i + 1
      for (; W[j]?.startsWith('-'); j++) if (/^(-cp|-classpath|--class-path|-jar)$/.test(W[j]!)) j++
      i = j - 1; continue
    }
    if (!live && depth < 3 && /^(bash|sh|zsh|dash|cmd|powershell|pwsh)$/.test(t)) {
      // A command handed to a nested shell is read as its own line, with the limit that stands before it.
      const k = W.findIndex((a, n) => n > i && /^(-[a-z]*c|\/[ck]|-command)$/i.test(a))
      if (k < 0 || W[k + 1] === undefined) return no
      const inner = /^(cmd|powershell|pwsh)$/.test(t) ? W.slice(k + 1).join(' ') : W[k + 1]!
      const found = segments(inner, /^(powershell|pwsh)$/.test(t)).map((s) => analyze(s.words, live, /^(powershell|pwsh)$/.test(t), depth + 1, timeout)).find((r) => r.heavy)
      return found ?? no
    }
    if (/^(npm|pnpm|yarn|bun)$/.test(t)) {
      let p = i + 1
      for (; W[p]?.startsWith('-') && W[p] !== '--'; p++) if (PM_VALUE.test(W[p]!)) p++
      const sub = W[p]?.toLowerCase()
      if (sub === undefined) return no
      if (sub === 'exec' || sub === 'dlx' || (t === 'bun' && sub === 'x')) { i = p; continue } // `pnpm exec vitest`: the tool follows
      const args = W.slice(i + 1)
      if (flag(args, INFO) || flag(args, WATCH)) return no
      if (t === 'bun' && sub === 'test') return { heavy: !(pos(W.slice(p + 1)).length || flag(args, /^(-t|--test-name-pattern)(=|$)/)), timeout }
      let at = p
      if (sub === 'run' || sub === 'run-script') { at = p + 1; while (W[at]?.startsWith('-')) at++ }
      const script = W[at]?.toLowerCase()
      if (!script || !SCRIPT.test(script) || /watch/.test(script)) return no
      const p2 = project(args)
      // Anything after the script is a filter, before or after `--`: `npm run test -- twilio.store` runs one file.
      const tail = W.slice(at + 1), dash = tail.indexOf('--')
      const scoped = args.some((a) => SCOPE.test(a) || (t === 'npm' && a === '-w')) || (p2 !== undefined && !ROOT_PROJECT.test(p2)) ||
        pos(tail).length > 0 || (dash >= 0 && pos(tail.slice(dash + 1)).length > 0)
      return { heavy: !scoped, timeout }
    }
    return { heavy: heavyTool(t, W.slice(i + 1), live), timeout }
  }
  return no
}

// PowerShell has no `timeout` prefix; these are the ways to wait on a process or job with a limit.
const PS_LIMIT = /\b(Wait-Process|Wait-Job|Receive-Job)\b[^\n;|]*-Timeout|\.WaitForExit\(\s*\d|-TimeoutSec/i
// Cheap first look: the words a heavy run is made of, so the lexer and the process listing never run for `git status`.
const MAYBE = /\b(vitest|jest|mocha|ava|playwright|tsc|vue-tsc|pytest|run-many|turbo|gradlew?|cargo|fleet-selftest|tests?|tst|typecheck|type-check|check|check-types)\b|--test\b|\b(npm|pnpm|yarn|bun)\s+t\b/i

// The heavy verify runs a command line starts, each with whether it is backgrounded and whether a limit stands before it.
export function heavy(command: string, tool = 'Bash'): Run[] {
  if (!MAYBE.test(command)) return []
  const ps = tool === 'PowerShell'
  const runs: Run[] = []
  for (const s of segments(command, ps)) {
    const r = analyze(s.words, false, ps)
    if (r.heavy) runs.push({ text: s.words.join(' '), bg: s.bg, timeout: r.timeout || (ps && PS_LIMIT.test(command)) })
  }
  return runs
}

// A process's command line cut to what tells runs apart: paths reduced to file names, 90 characters.
function short(cmd: string): string {
  const s = argv(cmd).map((w) => (w.startsWith('-') ? w : w.replace(/^.*[\\/]/, ''))).join(' ')
  return s.length > 90 ? `${s.slice(0, 87)}...` : s
}

const SHOW = 3
// A heavy run older than this is not a run someone waits for but one that hung (a worker OOM can leave vitest hung with no
// error for hours): it is named in a refusal, never a reason for one.
export const STALE_SECONDS = 3600
const list = (ps: Proc[]): string => `${ps.slice(0, SHOW).map((p) => `pid ${p.pid} \`${short(p.cmd)}\``).join(', ')}${ps.length > SHOW ? ` and ${ps.length - SHOW} more` : ''}`
// null = let it run, otherwise why not. `processes`: what the machine runs now (pid + command line), or undefined when the
// listing failed or timed out, which skips the first rule (fail open) and leaves the second.
export function check(command: string, tool: string, input: { run_in_background?: boolean } = {}, processes?: Proc[]): string | null {
  const runs = heavy(command, tool)
  if (!runs.length) return null
  const why: string[] = []
  const live = (processes ?? []).filter((p) => analyze(argv(p.cmd), true, false).heavy)
  // A run of unknown age counts, as before the age was read.
  const old = live.filter((p) => p.age !== undefined && p.age > STALE_SECONDS), fresh = live.filter((p) => !old.includes(p))
  if (fresh.length) {
    why.push(`another heavy verify run is live on this machine: ${list(fresh)}. ` +
      'Several sessions share one 32 GB box and a whole-repo typecheck or suite costs gigabytes each. Wait for it (its result is yours to read) or scope your run to one file or project ' +
      '(`vitest run src/x.test.ts`, `tsc --noEmit -p packages/a`, `-t`, `--changed`). If it looks hung, tell the user; do not end it yourself')
  }
  const loose = runs.find((r) => (r.bg || input.run_in_background === true) && !r.timeout)
  if (loose) {
    why.push(`\`${loose.text}\` starts a heavy verify run in the background with no kill-after limit, and a hung run holds its RAM for hours. Every long run gets a hard timeout: ` +
      (tool === 'PowerShell'
        ? 'PowerShell has no `timeout` prefix, so run it in the foreground (the tool call caps it) or `Start-Process ... -PassThru` then `Wait-Process -Timeout <seconds>` and stop it when that runs out'
        : 'prefix `timeout <twice its usual seconds>` (`timeout 900 npm test`) or run it in the foreground, where the tool call caps it'))
  }
  if (!why.length) return null
  if (old.length) why.push(`${list(old)} has run over an hour and looks hung: tell the user (it is not counted against you)`)
  return `Blocked by makarasty-tools budget-guard: ${why.join('. Also, ')}. MAKARASTY_BUDGET_GUARD=off turns this off.`
}

// ps's `etime` (`[[dd-]hh:]mm:ss`) in seconds.
const ETIME = '(?:\\d+-)?(?:\\d+:)?\\d+:\\d+'
function seconds(etime: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime)!
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4])
}
// The listing as Proc: Windows rows are `pid<TAB>seconds<TAB>command line` (seconds empty when CIM gave no start time), ps rows
// are `pid etime args`. A row without the age column is read as `pid command line`, age unknown.
export function parse(out: string, win = true): Proc[] {
  const procs: Proc[] = []
  const aged = win ? /^\s*(\d+)\t(\d*)\t(\S.*)$/ : new RegExp(`^\\s*(\\d+)\\s+(${ETIME})\\s+(\\S.*)$`)
  for (const line of out.split(/\r?\n/)) {
    let m = aged.exec(line)
    if (m) procs.push({ pid: Number(m[1]), cmd: m[3]!, ...(m[2] ? { age: win ? Number(m[2]) : seconds(m[2]) } : {}) })
    else if ((m = /^\s*(\d+)[\t ]+(\S.*)$/.exec(line))) procs.push({ pid: Number(m[1]), cmd: m[2]! })
  }
  return procs
}

// Windows tells itself apart by OS, or by ComSpec / SystemRoot when a host strips OS from the environment.
export const isWindows = (os?: string, comspec?: string, sysroot?: string): boolean => os === 'Windows_NT' || !!comspec || !!sysroot

// Windows: command lines come only from CIM. Measured 2026-10-20 on this box under load (4 other sessions): the whole call
// through a node child is about 300 ms median (powershell startup alone 112 ms); the WQL filter plus -Property is the
// fastest of the three tried (a Where-Object filter 310 ms, no -Property 360 ms). `tasklist /v` takes 12-14 s and has no
// command lines; `wmic` is gone from this build. One `-Command` string, no double quotes, so no quoting survives to break it.
// The middle column is seconds since CreationDate, empty when CIM has none.
export const WIN_LIST = "Get-CimInstance Win32_Process -Property ProcessId,CommandLine,CreationDate -Filter 'Name=''node.exe'' OR Name=''bun.exe'' OR Name=''python.exe'' OR Name=''java.exe'' OR Name=''cargo.exe'' OR Name=''pytest.exe''' | ForEach-Object { '' + $_.ProcessId + [char]9 + $(if ($_.CreationDate) { [int]((Get-Date) - $_.CreationDate).TotalSeconds } else { '' }) + [char]9 + $_.CommandLine }"

export const register: Register = on => {
  on('tool.call', { tool: /^(Bash|PowerShell)$/ }, async ($, e, next) => {
    const command = e.tool === 'Bash' || e.tool === 'PowerShell' ? e.command : ''
    // Cheap look first (the lexer), the process listing only for a line that is a heavy verify run.
    if (!heavy(command, e.tool).length) return next(e)
    if ((await $.env.get('MAKARASTY_BUDGET_GUARD')) === 'off') return next(e)
    const bg = (e.tool === 'Bash' || e.tool === 'PowerShell') && e.run_in_background === true
    let procs: Proc[] | undefined
    try {
      const win = isWindows(await $.env.get('OS'), await $.env.get('ComSpec'), await $.env.get('SystemRoot'))
      const r = await $.process.run(win ? ['powershell', '-NoProfile', '-NonInteractive', '-Command', WIN_LIST] : ['ps', '-eo', 'pid=,etime=,args='], { timeoutMs: 8000 })
      if (r.exitCode === 0) procs = parse(r.stdout, win)
      // shortcut: this session's own processes are not told apart; the listing runs before the call starts, so only an earlier
      // background run of this session shows up, which is a live heavy run all the same.
    } catch {
      // The listing failed or timed out: the call runs (fail open). A guard of RAM, not of data, must not block honest work.
    }
    const deny = check(command, e.tool, { run_in_background: bg }, procs)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => next(e))
}
