import type { Register } from 'claude-code'

// Refuses killing a process BY NAME: `taskkill /IM`, `Stop-Process -Name`, `Get-Process x | Stop-Process`, `pkill`,
// `killall`, `kill $(pgrep x)`. A name matches every process of that name, and on a shared box that includes other
// sessions' dev servers, test runners and the person's own tools (a `taskkill /IM node.exe` once killed a sandbox proxy
// that another chat was using). Allowed: by PID (`taskkill /PID 4242 /F`, `Stop-Process -Id 4242`, `kill 4242`). `taskkill /T` is refused: it takes the whole child tree.
// Look the PID up first (Get-CimInstance Win32_Process, `netstat -ano`, `ps`), check it is yours, then kill that PID.
// Shape borrowed from git-guard and delete-guard: a function hook, quotes masked, no process spawned. The person can
// still run anything themselves with `!`.
// shortcut: wmic/CIM Terminate, `.Kill()` on a Get-Process object, and a variable or foreach loop that holds the name
// (`$p = Get-Process node; Stop-Process -Id $p.Id`) are not read; upgrade if one bites.
const WHY = 'it kills every process of that name, other sessions\' and the person\'s own included. Find the PID first (`Get-CimInstance Win32_Process`, `netstat -ano`, `ps`), check it is yours, then kill that PID: `taskkill /PID <n> /F` (from Git Bash `taskkill //PID <n> //F`: it rewrites `/PID` into a path), `Stop-Process -Id <n>`, `kill <n>`'
const TREE = 'taskkill /T kills the whole child tree, which can include other sessions\' processes: kill the one PID (`taskkill /PID n /F`; from Git Bash `taskkill //PID n //F`), then each child you own by its PID'
const SHELL = /^((ba|z|da|k)?sh|pwsh|powershell|cmd)$/
const SHELL_CMD = /^-\w*c$|^-command$|^\/{1,2}[ck]$/i
// Wrappers whose own options (and the values of some) come before the command they run.
const WRAP = /^(env|command|sudo|nohup|time|exec|nice|timeout|xargs|doas|stdbuf|setsid|wsl|call|start|ionice|runuser)$/
// The options of each wrapper that take the next word as their value (`xargs -r kill` has none: -r is a flag).
const VALUED: Record<string, RegExp> = {
  xargs: /^-[adEILnPs]$/, sudo: /^(-[ughpCrtU]|--user|--group)$/, doas: /^-[uC]$/, runuser: /^-[ugc]$/, timeout: /^(-[sk]|--signal|--kill-after)$/,
  nice: /^-n$/, env: /^-[uCS]$/, ionice: /^-[cnp]$/, stdbuf: /^-[ioe]$/,
}
const ID = /^-id(:|$)/i
const GET_PROC = /^(get-process|gps)$/
// A word as the tool name: no quote marks, path or extension, lower case.
const base = (w: string): string => w.replace(/^\$?[({]+/, '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()

// Whether the end of `s` is inside an open quote: a ' inside "..." or a " inside '...' does not count.
function inQuote(s: string): boolean {
  let q = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (q === '"' && c === '\\') i++
    else if (q) { if (c === q) q = '' }
    else if (c === '"' || c === "'") q = c
  }
  return q !== ''
}

// Heredoc bodies. One fed to a shell (`bash <<EOF`, `bash -s <<EOF`, `cat <<EOF | sh`) is code and goes to `nested`; any
// other (a commit message) is text and is dropped. A `<<` inside quotes or `$(( ))` is no heredoc, and one with no
// terminator line leaves its lines as commands. Each line is read once, with a window around each `<<` and a scan budget.
function heredocs(cmd: string, nested: [string, string][]): string {
  const lines = cmd.split('\n'), out: string[] = []
  let budget = 100000
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    let n = 0, p = i + 1
    for (const m of line.matchAll(/(?<!<)<<-?[ \t]*['"]?(\w+)['"]?/g)) {
      if (++n > 20) break
      const head = line.slice(0, m.index)
      if (inQuote(head) || head.lastIndexOf('((') > head.lastIndexOf('))')) continue
      const tag = m[1]!
      let j = p
      while (j < lines.length && budget-- > 0) {
        const t = lines[j]!.trim()
        if (t.startsWith(tag) && !/\w/.test(t[tag.length] ?? '')) break
        j++
      }
      if (j >= lines.length || budget <= 0) continue
      const before = line.slice(Math.max(0, m.index - 80), m.index), rest = line.slice(m.index + m[0].length, m.index + m[0].length + 200)
      const code = /(?:^|[\s;&|(])(?:ba|z|da|k)?sh(?:[ \t]+-[\w-]+)*[ \t]*$/.test(before) || /^[^;&|]*\|\s*(?:\S*[\/])?(?:ba|z|da|k)?sh(?:\s+-[\w-]+)*\s*(?:$|[;&|])/.test(rest)
      if (code) nested.push([lines.slice(p, j).join('\n'), 'Bash'])
      p = j + 1
    }
    out.push(line.replace(/(?<!<)<<-?[ \t]*['"]?\w+['"]?/g, ' '))
    i = p - 1
  }
  return out.join('\n')
}

export function check(cmd: string, tool = 'Bash', depth = 0): string | null {
  if (depth > 4) return null
  const lits: string[] = [], nested: [string, string][] = []
  let text = heredocs(cmd, nested)
  for (const m of text.matchAll(/\$\(([^()]*)\)|[<>]\(([^()]*)\)|`([^`]*)`/g)) nested.push([m[1] ?? m[2] ?? m[3]!, tool])
  text = text.replace(/@'[\s\S]*?'@|@"[\s\S]*?"@/g, ' ').replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g, (_, a?: string, b?: string) => `\u0001${lits.push(a ?? b ?? '') - 1}\u0001`)
    .replace(/\d*[<>]+&?\s*[^\s;&|()<>]+/g, ' ')
  const unq = (w: string): string => w.replace(/\u0001(\d+)\u0001/g, (_, n) => lits[+n]!)
  // The command word of one statement and its arguments, past wrappers (`sudo -u root`, `timeout -s KILL 5`, `VAR=x`).
  const parse = (s: string): { head: string; args: string[] } => {
    const w = s.trim().split(/\s+/).filter(Boolean).map(unq)
    let at = 0, wrap = ''
    for (; at < w.length; at++) {
      const x = w[at]!.replace(/^\$?[({]+/, '')
      if (WRAP.test(x.toLowerCase())) wrap = x.toLowerCase()
      else if (/^(&|!)$|^\w+=/.test(x)) continue
      else if (wrap && x.startsWith('-')) { if (VALUED[wrap]?.test(x)) at++ }
      else if (!(wrap && /^(\d+[smhd]?|\/[a-z])$/i.test(x))) break
    }
    return { head: base(w[at] ?? ''), args: w.slice(at + 1) }
  }
  for (const chain of text.split(/&&|\|\||[;&\n]/)) {
    const stages = chain.split('|'), whole = unq(chain)
    for (let i = 0; i < stages.length; i++) {
      // A brace block belongs to the pipe stage it sits in: `Get-Process x | % { Stop-Process -Id $_.Id }` is fed by Get-Process.
      for (const stmt of stages[i]!.split(/[{}]/)) {
        const { head, args } = parse(stmt)
        if (/^(eval|iex|invoke-expression)$/.test(head)) nested.push([args.join(' '), tool])
        else if (SHELL.test(head)) {
          const f = args.findIndex((w) => SHELL_CMD.test(w))
          if (f >= 0) nested.push([args.slice(f + 1).join(' '), /^(pwsh|powershell)$/.test(head) ? 'PowerShell' : 'Bash'])
        } else if (head === 'taskkill') {
          // By PID, or filtered on a PID, is fine; a name (/IM, or a /FI on anything but PID) is not.
          const pid = args.some((w) => /^[/-]{1,2}pid$/i.test(w))
          const fi = args.flatMap((w, k) => (/^[/-]{1,2}fi$/i.test(w) ? [args[k + 1] ?? ''] : []))
          if (args.some((w) => /^[/-]{1,2}im$/i.test(w)) || (!pid && fi.some((f) => !/^\s*pid\s+eq\s+\d+\s*$/i.test(f)))) return `taskkill /IM (or /FI on a name): ${WHY}`
          if (args.some((w) => /^[/-]{1,2}t$/i.test(w))) return TREE
        } else if (head === 'pkill' || head === 'killall') return `${head}: ${WHY}`
        else if (head === 'stop-process' || head === 'spps' || (head === 'kill' && tool === 'PowerShell')) {
          if (args.some((w) => /^-n(a(m(e)?)?)?(:|$)/i.test(w))) return `Stop-Process -Name: ${WHY}`
          const feeders = stages.slice(0, i).map((s) => parse(s.split(/[{}]/)[0]!))
          // Fed by a Get-Process that names no Id, the pipeline chose the processes by name, whatever -Id says after it.
          // ... unless a later stage narrows it to one Id (`| Where-Object { $_.Id -eq 4242 } |`).
          const narrowed = /\$_\.id\s+-eq\s+\d+/i.test(unq(stages.slice(0, i).join('|')))
          if (!narrowed && feeders.some((f) => (GET_PROC.test(f.head) || (tool === 'PowerShell' && f.head === 'ps')) && !f.args.some((w) => ID.test(w)))) return `Get-Process <name> | Stop-Process: ${WHY}`
          // Fed by anything else with no -Id: only a feeder asking for an Id shows it is by PID.
          if (i > 0 && !args.some((w) => ID.test(w)) && !/-id\b|\.id\b|owningprocess/i.test(unq(stages.slice(0, i).join('|')))) return `<pipeline> | Stop-Process: ${WHY}`
          const sub = /-id[:\s]+\$?\(+\s*(?:get-process|gps)\b([^)]*)/i.exec(whole)
          if (sub && !/-id\b/i.test(sub[1]!)) return `Stop-Process -Id (Get-Process <name>).Id: ${WHY}`
        } else if (head === 'kill' && (/\b(pgrep|pidof)\b/.test(whole) || (/\b(ps|tasklist)\b/.test(whole) && /\b(grep|findstr|awk)\b/.test(whole)))) return `kill with a PID looked up by name: ${WHY}`
      }
    }
  }
  for (const [n, t] of nested) { const why = check(n, t, depth + 1); if (why) return why }
  return null
}

const MAYBE = /taskkill|pkill|killall|stop-process|spps|\bkill\b/i

export function denial(command: string, off: boolean, tool = 'Bash'): string | null {
  if (off || !MAYBE.test(command)) return null
  const why = check(command, tool)
  return why && `Blocked by makarasty-tools kill-guard: ${why}. MAKARASTY_KILL_GUARD=off turns this off, or ask the person to run it themselves with \`!\`.`
}

export const register: Register = on => {
  on('tool.call', { tool: /^(Bash|PowerShell|Monitor)$/ }, async ($, e, next) => {
    const command = (e.tool === 'Bash' || e.tool === 'PowerShell' || e.tool === 'Monitor' ? e.command : '') ?? '' // a Monitor on a ws has no command
    let deny: string | null = null
    try { deny = denial(command, (await $.env.get('MAKARASTY_KILL_GUARD')) === 'off', e.tool) } catch {
      // shortcut: a bug in this guard (not a refusal) lets the call run rather than blocking every shell call.
    }
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => next(e))
}
