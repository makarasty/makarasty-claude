import type { Register } from 'claude-code'

// Refuses recursive deletes that reach past a named folder inside the project: `rm -rf ..`, `Remove-Item -Recurse *`,
// `rd /s C:\`, `find / -delete`. One mistyped or empty path takes the project, the home folder or a drive with it, and
// no undo exists. Shape borrowed from git-guard: a function hook, a small lexer, no process spawned. Allowed on
// purpose: a recursive delete of a path strictly inside the working directory or the OS temp folder
// (`rm -rf node_modules dist`), any non-recursive delete, `git rm -r` (git's own, guarded by git-guard). The person
// can still run anything themselves with `!`.
//
// Claude Code itself already refuses `rm -rf .`, `./*`, `*` and `..`; those rules stay here too (cheap, and other modes and
// agents do not have them). The real gaps this guard closes: `.git` and `.git/objects`, `find . -delete`, `cmd /c rd /s /q .`,
// `rm -rf "$PWD"`, and `cd .. && rm -rf <the folder the session runs in>`. `Get-ChildItem | Remove-Item -Recurse` is a gap
// that stays open on purpose: a pipeline's paths cannot be read, and refusing it blocks honest work.
//
// Links are not walked. Measured 2026-10-20 (Git Bash, cmd, PowerShell 5.1.26100): `rm -rf t`, `cmd /c rd /s /q t` and
// `Remove-Item -Recurse -Force t` all unlink a junction inside `t` and leave its target intact; only `git worktree remove`
// follows one (git-guard refuses that). A glob through a link (`Remove-Item -Recurse t\link\*`) does empty the target:
// out of scope.
//
// The ruling: refuse only what can be shown dangerous from the line itself. A path the line does not settle (an unset
// variable, `$1`, `$(ls)`, `$_`), a pipeline (`| xargs rm -rf`, `| Remove-Item -Recurse`) and a folder reached by a computed
// `cd` are allowed, because guessing at them blocks honest work; what the line does settle (`$HOME`, `$PWD`, `~`, literal
// loop lists, literal assignments, `mktemp`, Join-Path of those, `cd` and `pushd`/`popd` with literal folders) is resolved.
export type Env = { cwd: string; home: string; tmp: string }
// Besides the delete commands, pseudo-commands keep what later words depend on, in order: `=` (a variable assignment:
// name, value), `for` (a loop variable and its literal items), `cd` (a change of folder), `deep` (the text past the
// nesting limit, when it holds a delete word), `scope`/`end` (a nested shell or substitution: its cd and assignments end
// with it).
//
// Known limits (not code): a `cd` or assignment inside `( ... )` leaks to the commands after it; assignments in a branch
// or loop body are read as always run; `rsync --delete`, `git clean`, `shutil`/`fs.rm` in a script, `mv x /dev/null`,
// `> file` truncation and `dd` are not deletes this guard reads; `-exec` bodies are read once, not per file; a Git Bash
// cwd spelled `/c/...` is read as POSIX;
// an 8.3 short temp path (`C:\Users\LONGNA~1\...\Temp`) next to the long spelling of the same folder is two folders
// without a file-system call to join them.
type Cmd = { name: string; args: string[]; ps: boolean }

// Same set as git-guard: `su -c "..."` takes its command line like a shell does.
const SHELL = /(^|[\\/])((ba|z|da|k)?sh|pwsh|powershell|cmd|su)(\.exe)?$/i
const WINSH = /(^|[\\/])(pwsh|powershell|cmd)(\.exe)?$/i
const WRAPPER = /^(env|command|sudo|nohup|time|exec|builtin|nice|xargs|timeout|watch|coproc|ionice|stdbuf|setsid|wsl(\.exe)?|doas|runuser|flock|taskset|strace|chronic|busybox|npx|bunx|pnpx|pnpm|yarn)$/
// bash -c / -lc, powershell -Command (and its prefixes), cmd /c; -EncodedCommand carries base64 UTF-16.
const SHELL_CMD = /^(-\w*c|-c(o(m(m(a(nd?)?)?)?)?)?|\/[ck])$/i
const ENCODED = /^-e(c|nc[a-z]*)$/i
// Node's rimraf and del-cli (and trash) delete recursively without a flag; they unlink links, as rm does.
const NODE_DEL = new Set(['rimraf', 'del-cli', 'trash'])
const DEL = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'find', ...NODE_DEL])
// What `find -exec` may run that deletes.
const RM = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'unlink', 'shred', ...NODE_DEL])
// cmd's rd/rmdir/del take `/s /q` switches; elsewhere `/c` is a path.
const CMD_SWITCH = new Set(['rd', 'rmdir', 'del', 'erase'])
// find tests that narrow what -delete reaches (`-type` alone does not; -maxdepth does with `-type f`, see check).
const NARROWS = /^-(i?name|i?path|i?wholename|i?regex|i?lname|[acm]time|[acm]min|newer\w*|empty|size|user|group|perm|samefile)$/
// The narrowing tests that take a pattern; a pattern that matches everything narrows nothing.
const PATTERN_TEST = /^-(i?name|i?path|i?wholename|i?regex|i?lname)$/
// Does a find expression's filter limit what -delete reaches? A test does (a negated one too: `! -name x` still filters),
// -maxdepth does with `-type f`, a `( a -o b )` group does when every branch does; at the top level only the branch that
// holds the delete counts. A pattern that matches everything (`*`, `.*`) narrows nothing.
function findNarrowed(t: string[]): boolean {
  const andNarrows = (b: string[]): boolean => {
    for (let i = 0; i < b.length; i++) {
      const w = b[i]!
      if (w === '(') {
        let d = 1, e = i + 1
        for (; e < b.length && d; e++) d += b[e] === '(' ? 1 : b[e] === ')' ? -1 : 0
        if (orNarrows(b.slice(i + 1, e - 1), true)) return true
        i = e - 1
      } else if (NARROWS.test(w) && (!PATTERN_TEST.test(w) || !/^(\.?\*+|)$/.test(b[i + 1] ?? ''))) return true
    }
    return b.includes('-maxdepth') && b.some((y, k) => y === '-type' && b[k + 1] === 'f')
  }
  const orNarrows = (b: string[], all: boolean): boolean => {
    const branches: string[][] = [[]]
    let d = 0
    for (const w of b) {
      if (w === '(') d++
      else if (w === ')') d--
      if (!d && /^(-o|-or)$/.test(w)) branches.push([])
      else branches.at(-1)!.push(w)
    }
    return all ? branches.every(andNarrows) : andNarrows(branches.at(-1)!)
  }
  return orNarrows(t, false)
}
const DELETISH = /\b(rm|rmdir|rd|del|erase|ri|remove-item|rimraf|del-cli|trash)\b|-delete\b/i
const strip = (w: string): string => w.replace(/^["']|["']$/g, '')
const TEMP_PATH = /^\[(?:system\.)?io\.path\]::gettemppath\(\)$/i
// What an expression stands for in a path word, or undefined when only the run knows: the working folder (`pwd`), a fresh
// temp folder (`mktemp`), the project root (`git rev-parse --show-toplevel`, the folder of `$0`), the temp folder, or a
// Join-Path of those with a literal name.
function special(inner: string): string | undefined {
  const t = inner.trim()
  if (/^(pwd|get-location)$/i.test(t)) return '$PWD'
  if (/^mktemp\b/.test(t)) return '$(mktemp)'
  if (/^git\s+rev-parse\s+--show-toplevel(\s+2>\S+)?$/.test(t)) return '$(root)'
  // The folder of the running script: somewhere in the project, which one the line does not say.
  if (/\$0|BASH_SOURCE/.test(t) && /^(dirname\b|cd\b[^;&|]*&&\s*pwd$)/.test(t)) return '$(inproj)'
  // GetTempPath() ends in a separator, so whatever follows it is a name inside the temp folder.
  if (TEMP_PATH.test(t)) return '$env:TEMP/'
  const plus = /^\[(?:system\.)?io\.path\]::gettemppath\(\)\s*\+\s*(.+)$/i.exec(t)
  if (plus) return `$env:TEMP/${strip(plus[1]!)}`
  const j = /^join-path\s+(?:-path\s+)?(\S+)\s+(?:-childpath\s+)?(\S+)$/i.exec(t)
  if (j) {
    const a = strip(j[1]!).replace(/^\((.*)\)$/, '$1')
    return `${/^get-location$/i.test(a) ? '$PWD' : TEMP_PATH.test(a) ? '$env:TEMP' : a}/${strip(j[2]!)}`
  }
  return undefined
}
const subst = (inner: string): string => special(inner) ?? '$()'
const mk = (name: string, args: string[], ps: boolean): Cmd => ({ name, args, ps })
// A nested shell's commands run in a scope of their own: its cd and assignments end with it.
function nest(src: string, ps: boolean, out: Cmd[], depth: number): void {
  out.push(mk('scope', [], ps)); lex(src, ps, out, depth); out.push(mk('end', [], ps))
}
// An argv handed on as a command line (find -exec): each word quoted again so a space or `$` in it stays inside the word.
const requote = (ws: string[], ps: boolean): string => ws.map((w) => /^[\w@%+=:,./{}-]+$/.test(w) ? w : `'${w.replace(/'/g, ps ? "''" : "'\\''")}'`).join(' ')
// A heredoc on a shell's own stdin is code; one fed to any other command is that command's text.
const SHELL_BEFORE = /(?:^|[\s;&|(/\\])(?:ba|z|da|k)?sh(?:\.exe)?(?:[ \t]+-[\w-]+)*[ \t]*$/
// Cuts every heredoc body out of `src` (what follows the marker on its line stays) and hands a body that feeds a shell to
// `code`. The terminator is looked for from each `<<TAG`; after 50 openers (`cout << x << y` is one too) the rest is left
// in place, so a long input costs a bounded number of passes, and more text is read, never less.
function heredocs(src: string, code: (body: string) => void): string {
  let out = '', pos = 0, tries = 0
  const re = /(?<!<)<<(?!<)-?[ \t]*['"]?(\w+)['"]?/g
  for (let m = re.exec(src); m && tries < 50; m = re.exec(src)) {
    tries++
    const nl = src.indexOf('\n', re.lastIndex)
    if (nl < 0) break
    const end = new RegExp(`\\n[ \\t]*${m[1]}\\b`, 'g')
    end.lastIndex = nl
    const t = end.exec(src)
    if (!t) continue
    if (SHELL_BEFORE.test(src.slice(Math.max(pos, m.index - 120), m.index))) code(src.slice(nl + 1, t.index))
    out += src.slice(pos, nl) + '\n'
    pos = t.index + t[0].length
    re.lastIndex = pos
  }
  return out + src.slice(pos)
}
const base = (w: string): string => w.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(exe|cmd|bat)$/, '')

// Index of the `)` that closes a paren whose body starts at `from`. `esc` is the shell's escape character.
function closing(s: string, from: number, esc: string): number {
  for (let d = 1, i = from; i < s.length; i++) {
    const c = s[i]
    if (c === esc) i++
    else if (c === "'") { const e = s.indexOf("'", i + 1); i = e < 0 ? s.length : e }
    else if (c === '(') d++
    else if (c === ')' && --d === 0) return i
  }
  return s.length
}

// Splits `src` into commands and pushes every delete command (and any shell string handed on) into `out`.
// A substitution's value is unknown, so it stands as `$()` (see `subst`).
// shortcut: quotes inside a $( ) that hold parens can mis-pair, as in git-guard; upgrade to a real parser if that bites.
function lex(src: string, ps: boolean, out: Cmd[], depth = 0): void {
  // Too deep to read: a delete word still in the text is refused rather than guessed.
  if (depth > 4) { if (DELETISH.test(src)) out.push(mk('deep', [src], ps)); return }
  src = src.replace(ps ? /`\r?\n/g : /\\\r?\n/g, ' ')
  if (ps) src = src.replace(/<#[\s\S]*?#>/g, ' ') // PowerShell block comments
  src = heredocs(src, (body) => nest(body, false, out, depth + 1)).replace(/@'[\s\S]*?'@|@"[\s\S]*?"@/g, ' ')
  const esc = ps ? '`' : '\\'
  let words: string[] = [], cur = '', has = false
  const word = (): void => { if (has) words.push(cur); cur = ''; has = false }
  const seg = (): void => { word(); if (words.length) command(words, ps, out, depth); words = [] }
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (c === esc) {
      // In Bash a backslash before an ordinary character stays, so an unquoted `C:\Users` still reads as a Windows path.
      const n = src[i + 1] ?? ''
      if (ps || '"\'\\;&|()<>$` *?~#'.includes(n)) { cur += n; i++ } else cur += c
      has = true
    } else if (c === "'") {
      const e = src.indexOf("'", i + 1), end = e < 0 ? src.length : e
      cur += src.slice(i + 1, end); has = true; i = end
    } else if (c === '"') {
      let end = i + 1, body = ''
      while (end < src.length && src[end] !== '"') {
        const d = src[end]!
        if (d === esc) {
          const n = src[end + 1] ?? ''
          if (ps || '"\\$`'.includes(n)) { body += n; end += 2 } else { body += d; end++ }
        } else if (d === '$' && src[end + 1] === '(') {
          const e = closing(src, end + 2, esc), inner = src.slice(end + 2, e)
          nest(inner, ps, out, depth + 1); body += subst(inner); end = e + 1
        } else if (!ps && d === '`') {
          const e = src.indexOf('`', end + 1), stop = e < 0 ? src.length : e, inner = src.slice(end + 1, stop)
          nest(inner, ps, out, depth + 1); body += subst(inner); end = stop + 1
        } else { body += d; end++ }
      }
      cur += body; has = true; i = end
    } else if (c === '$' && src[i + 1] === '(') {
      const e = closing(src, i + 2, esc), inner = src.slice(i + 2, e)
      nest(inner, ps, out, depth + 1); cur += subst(inner); has = true; i = e
    } else if (!ps && c === '`') {
      const e = src.indexOf('`', i + 1), end = e < 0 ? src.length : e, inner = src.slice(i + 1, end)
      nest(inner, ps, out, depth + 1); cur += subst(inner); has = true; i = end
    } else if (ps && c === '(' && !has && words.length && !/^(if|elseif|while|until|foreach|for|switch|catch)$/i.test(words[0]!)) {
      // A PowerShell (expression) in argument position is an operand whose value only the run knows.
      const e = closing(src, i + 1, esc), inner = src.slice(i + 1, e)
      nest(inner, ps, out, depth + 1); cur += subst(inner); has = true; i = e
    } else if (ps && has && src.startsWith('()', i)) { cur += '()'; i++ } // a method call with no arguments: [IO.Path]::GetTempPath()
    else if ((c === '{' || c === '}') && !has && /\s/.test(src[i + 1] ?? ' ')) seg() // a brace standing alone opens or closes a block
    else if (c === '\n' || c === ';' || c === '|' || c === '(' || c === ')') seg()
    else if (c === '&') {
      // `2>&1` and `&>file` are redirections; any other `&` ends the command.
      if (src[i - 1] === '>' || src[i - 1] === '<' || src[i + 1] === '>') { cur += c; has = true } else seg()
    } else if (/\s/.test(c)) word()
    else if (c === '#' && !has) { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e - 1 }
    else { cur += c; has = true }
  }
  seg()
}

// A base64 -EncodedCommand is UTF-16LE; the ASCII letters sit at the even bytes.
const decode = (b64: string): string => { try { return [...atob(b64)].filter((_, i) => i % 2 === 0).join('') } catch { return '' } }

// One command's words: strips redirections and prefixes, follows wrappers and shells, records a delete command.
function command(w: string[], ps: boolean, out: Cmd[], depth: number): void {
  const words: string[] = []
  for (let i = 0; i < w.length; i++) {
    const x = w[i]!
    // `>file`, `2>&1`, `> file` are not arguments.
    if (/^[\d*&]*[<>]/.test(x)) { if (/^[\d*&]*(>>?|<)&?$/.test(x)) i++; continue }
    words.push(x)
  }
  // A closing brace glued to the last word (`{ rm -rf x}`) ends a block, not an argument; `{}` is find's file.
  if (words.length && !words.at(-1)!.includes('{')) words[words.length - 1] = words.at(-1)!.replace(/\}$/, '')
  let at = 0
  const assigns: Cmd[] = []
  const assign = (name: string, value: string): void => { assigns.push({ name: '=', args: [name, value], ps }) }
  while (at < words.length) {
    const x = words[at]!
    if (/^(&|\{|\}|!|if|then|do|else|elif|while|until|)$/.test(x)) at++
    else if (/^\w+=/.test(x)) { assign(x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)); at++ }
    else if (x.length > 1 && x.startsWith('{')) words[at] = x.slice(1)
    // PowerShell captures output with `$x = Remove-Item ...`, which still deletes; `$x = 'dist'` is an assignment.
    else if (/^\$[\w:]+$/.test(x) && words[at + 1] === '=') {
      const value = special(words.slice(at + 2).join(' ')) ?? (words.length === at + 3 ? words[at + 2]! : '$()')
      out.push(mk('=', [x.slice(1), value], ps))
      at += 2
    } else if (WRAPPER.test(base(x))) {
      // `env -S "rm -rf .."` splits its one string into a command line.
      if (base(x) === 'env' && /^(-S|--split-string)$/.test(words[at + 1] ?? '')) nest(words.slice(at + 2).join(' '), ps, out, depth + 1)
      // A wrapper's own arguments (`timeout 60`, `sudo -u bob`) end where the command or a shell starts.
      const g = words.findIndex((y, k) => k > at && (DEL.has(base(y)) || SHELL.test(y) || base(y) === 'git'))
      if (g < 0) return
      at = g
      break
    } else break
  }
  const head = words[at] ?? '', b = base(head), rest = words.slice(at + 1)
  // `X=1 rm -rf $X` scopes X to that one command; alone (`X=dist; rm -rf $X`) it lasts, and later words read it.
  if (at >= words.length) out.push(...assigns)
  if (/^(export|local|declare|typeset|readonly)$/.test(b)) for (const a of rest) { const m = /^(\w+)=([\s\S]*)$/.exec(a); if (m) out.push({ name: '=', args: [m[1]!, m[2]!], ps }) }
  // `for d in dist build` (bash) and `$d in 'dist','build'` (PowerShell, after `foreach (`) bind d to each literal item.
  if (!ps && head === 'for' && rest[1] === 'in') out.push(mk('for', [rest[0]!, ...rest.slice(2)], ps))
  else if (ps && /^\$\w+$/.test(head) && rest[0] === 'in') out.push(mk('for', [head.slice(1), ...rest.slice(1).flatMap((y) => y.split(','))], ps))
  // A change of folder moves where later relative paths land. popd goes somewhere the line does not say.
  if (/^(cd|chdir|pushd|set-location|sl|push-location)$/.test(b)) out.push({ name: 'cd', args: [b, ...rest], ps })
  else if (/^(popd|pop-location)$/.test(b)) out.push({ name: 'cd', args: [b, '$()'], ps })
  if (b === 'nix-shell') { const r = rest.findIndex((y) => /^--(run|command)$/.test(y)); if (r >= 0 && rest[r + 1]) nest(rest[r + 1]!, ps, out, depth + 1) }
  if (SHELL.test(head)) {
    const inner = WINSH.test(head)
    const f = rest.findIndex((y) => SHELL_CMD.test(y))
    if (f >= 0 && rest[f + 1] !== undefined) nest(inner ? rest.slice(f + 1).join(' ') : rest[f + 1]!, inner, out, depth + 1)
    const e = rest.findIndex((y) => ENCODED.test(y))
    if (e >= 0 && rest[e + 1] !== undefined) nest(decode(rest[e + 1]!), true, out, depth + 1)
  } else if (/^(eval|iex|invoke-expression)$/.test(b)) lex(rest.join(' '), ps, out, depth + 1)
  else if (b === 'find') {
    // find -exec / -execdir runs the words after it, once per file.
    const x = rest.findIndex((y) => /^-(exec|execdir|ok|okdir)$/.test(y))
    if (x >= 0) nest(requote(rest.slice(x + 1), ps), ps, out, depth + 1)
  }
  if (DEL.has(b)) out.push({ name: b, args: rest, ps })
}

// Where `p` lands, absolute with `/` separators. The working directory's spelling decides Windows or POSIX rules;
// the Windows rules also read Git Bash's `/c/x` and Cygwin's `/cygdrive/c/x` as `C:/x`.
// shortcut: a Git Bash cwd given as `/c/Users/x` reads as a POSIX path; the engine reports the Windows spelling.
function resolve(p: string, cwd: string, win: boolean): string {
  let s = win ? p.replace(/\\/g, '/') : p
  const dir = win ? cwd.replace(/\\/g, '/') : cwd
  if (win) {
    s = s.replace(/^\/(?:cygdrive\/)?([A-Za-z])(?=\/|$)/, '$1:')
    if (/^[A-Za-z]:$/.test(s)) s += '/'
    if (!/^[A-Za-z]:\//.test(s)) s = s.startsWith('/') ? dir.slice(0, 2) + s : `${dir}/${s}`
  } else if (!s.startsWith('/')) s = `${dir}/${s}`
  const root = win ? s.slice(0, 2) : ''
  const stack: string[] = []
  for (const seg of s.slice(root.length).split('/')) {
    if (seg === '..') stack.pop()
    else if (seg && seg !== '.') stack.push(seg)
  }
  return `${root}/${stack.join('/')}`
}

// Bash names are case-sensitive, so a user's $tmp or $home is not the OS temp or home; PowerShell's env: names and its
// automatic $HOME are not.
const HOME_B = /^(~|\$\{?(?:HOME|USERPROFILE)\}?|%(?:HOME|USERPROFILE)%)(?=$|[\\/])/
const HOME_P = /^(~|\$\{?home\}?|\$env:(?:HOME|USERPROFILE)|%(?:HOME|USERPROFILE)%)(?=$|[\\/])/i
const TMP_B = /^(\$\{?(?:TMPDIR|TEMP|TMP)(?::-[^}]*)?\}?|%(?:TEMP|TMP)%)(?=$|[\\/])/
const TMP_P = /^(\$env:(?:TMPDIR|TEMP|TMP)|%(?:TEMP|TMP)%)(?=$|[\\/])/i
const PWD_B = /^\$\{?PWD\}?(?=$|[\\/])/
const PWD_P = /^\$pwd(?:\.(?:path|providerpath))?(?=$|[\\/])/i

// A variable holds a list: one value from an assignment, each item of a literal `for` list.
type Ctx = { env: Env; win: boolean; ps: boolean; cur: string | undefined; vars: Map<string, string[]> }

// The path as the shell will see it, one string per value its variables can take, as far as the line says: assigned
// variables, $PWD, $(mktemp), the project root, home and temp.
function expand(typed: string, x: Ctx): string[] {
  let all = [typed]
  for (let n = 0; n < 3; n++) {
    let changed = false
    all = all.flatMap((s) => {
      const m = /^\$\{?([A-Za-z_]\w*)\}?(?=$|[\\/])/.exec(s)
      const v = m ? x.vars.get(x.ps ? m[1]!.toLowerCase() : m[1]!) : undefined
      if (!m || v === undefined) return [s]
      changed = true
      return v.map((val) => val + s.slice(m[0].length))
    })
    if (!changed) break
  }
  return all.map((s) => {
    // After a cd to a computed folder $PWD is unknown and stays a variable.
    if (x.cur !== undefined) s = s.replace(x.ps ? PWD_P : PWD_B, () => x.cur!)
    return s.replace(x.ps ? HOME_P : HOME_B, () => x.env.home).replace(x.ps ? TMP_P : TMP_B, () => x.env.tmp)
      .replace(/^\$\(mktemp\)/, () => `${x.env.tmp}/mktemp.x`).replace(/^\$\(root\)/, () => x.env.cwd)
      .replace(x.ps ? /^\$psscriptroot|^\$\(inproj\)/i : /^\$\(inproj\)/, () => `${x.env.cwd}/\u0001`)
      .replace(/^\[(?:system\.)?io\.path\]::gettemppath\(\)/i, () => x.env.tmp)
      // Git Bash maps /tmp to the temp folder.
      .replace(x.win ? /^\/tmp(?=\/|$)/ : /^(?!)/, () => x.env.tmp)
  })
}

// Could this glob name `.git` or `..`? (`.*`, `.[!.]*`, `.??*`, `.g*`, `.{git,x}`, `.gi?`)
function globSource(g: string): string {
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!
    if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (c === '[' && g.indexOf(']', i + 2) > 0) {
      const e = g.indexOf(']', i + 2), body = g.slice(i + 1, e)
      re += `[${/^[!^]/.test(body) ? '^' + body.slice(1) : body}]`.replace(/\\/g, '\\\\'); i = e
    } else if (c === '{' && g.indexOf('}', i) > 0) {
      const e = g.indexOf('}', i)
      re += `(?:${g.slice(i + 1, e).split(',').map(globSource).join('|')})`; i = e
    } else re += c.replace(/[.+^$()|\\[\]{}]/g, '\\$&')
  }
  return re
}
function namesDotGit(seg: string): boolean {
  try { const re = new RegExp(`^${globSource(seg)}$`, 'i'); return re.test('.git') || re.test('..') } catch { return true }
}

// null = the target may go, else what deleting it destroys. `search`: a find root; `narrowed`: a find test limits what it
// deletes, which frees the working folder, the home folder and the temp folder as roots.
function target(typed: string, x: Ctx, narrowed: boolean): string | null {
  for (const s0 of expand(typed, x)) {
    const why = place(s0, x, narrowed)
    if (why) return why
  }
  return null
}

// What the project's own .git keeps that a repository cannot do without; .git/hooks and the rest may go.
const GIT_CORE = new Set(['objects', 'refs', 'logs', 'head', 'packed-refs', 'index', 'config', 'modules', 'worktrees'])
// Caches a person clears from home on purpose. Any other folder directly in home (.ssh, Documents, .config, a project) is
// theirs; below those is not this guard's business.
const HOME_CACHES = ['.cache', '.npm', '.pnpm-store', '.vite', '.turbo', '.expo', '.pub-cache']
// Scratch folders other tools use besides the session's own temp folder; below them may go, they themselves may not.
const SCRATCH = ['/var/tmp', '/dev/shm', '/private/tmp', 'C:/Windows/Temp', 'C:/temp', 'C:/tmp']

function place(s0: string, x: Ctx, narrowed: boolean): string | null {
  const { env, win } = x
  if (!s0) return null
  const free = narrowed
  // Only what can be shown dangerous is refused. A path that starts with a variable or substitution nobody resolved here
  // (`$f`, `$1`, `$(ls)`, `$_.FullName`), or a relative one after a cd to such a folder, is allowed.
  if (/^([^\\/]*\$|%\w+%)/.test(s0) || (x.cur === undefined && !/^([A-Za-z]:|[\\/]|~)/.test(s0))) return null
  const k = (a: string): string => (win ? a.toLowerCase() : a)
  const same = (a: string, b: string): boolean => k(a).replace(/\/$/, '') === k(b).replace(/\/$/, '')
  const under = (a: string, dir: string): boolean => k(a).startsWith(k(dir).replace(/\/$/, '') + '/')
  const home = resolve(env.home, env.cwd, win), cwd = resolve(env.cwd, env.cwd, win)
  const base0 = x.cur ?? env.cwd
  // A glob whose last segment starts with a dot can name .git (and ..) when it sits in the project folder.
  const cut = Math.max(s0.lastIndexOf('/'), s0.lastIndexOf('\\'))
  const last = s0.slice(cut + 1)
  if (last.startsWith('.') && /[*?[{]/.test(last) && namesDotGit(last) && same(resolve(cut < 0 ? '.' : s0.slice(0, cut + 1), base0, win), cwd))
    return `${last} can match .git and .., so it deletes the repository history and everything above this folder`
  const glob = /(^|[\\/])\*+$/.test(s0)
  const s = glob ? s0.replace(/[\\/]?\*+$/, '') || (/^[\\/]/.test(s0) ? '/' : '.') : s0
  const r = resolve(s, base0, win)
  const tmps = [env.tmp, ...(win ? [] : ['/tmp']), ...SCRATCH].map((t) => resolve(t, env.cwd, win))
  if (/^([A-Za-z]:)?\/$/.test(r)) return 'deletes the whole drive'
  if (same(r, home) && free) return null
  if (same(r, home) || under(home, r)) return 'deletes your whole home folder (or the folder that holds it)'
  // Only the project's own .git: a nested one (vendor/x/.git, node_modules/x/.git) is somebody else's checkout.
  const git = `${cwd.replace(/\/$/, '')}/.git`
  if (same(r, git)) return 'deletes .git, the whole history of the repository'
  // .git/modules and .git/worktrees hold one entry per submodule or worktree: one of those may go, the folders may not.
  const inGit = under(r, git) ? r.slice(git.length + 1).split('/') : []
  if (inGit.length && GIT_CORE.has(inGit[0]!.toLowerCase()) && !(inGit.length > 1 && /^(modules|worktrees)$/i.test(inGit[0]!)))
    return `deletes .git/${inGit[0]}, which the whole history of the repository lives in`
  if (same(r, cwd)) return free ? null : glob ? 'deletes everything in this folder' : 'deletes the whole project folder'
  if (under(cwd, r)) return 'deletes everything above this folder'
  if (tmps.some((t) => same(r, t)) && free) return null
  if (tmps.some((t) => same(r, t) || under(t, r))) return "deletes the whole temp folder, where other sessions' scratch files live"
  if (tmps.some((t) => under(r, t))) return null
  // Directly in home, a cache goes and anything else does not. Anywhere else the line settles nothing more: it runs
  // (a sibling project, C:\scratch, another drive), because only the project, home, a drive, temp and .git are shown dangerous.
  const inHome = under(r, home) ? r.slice(home.replace(/\/$/, '').length + 1) : ''
  if (inHome && !inHome.includes('/') && !HOME_CACHES.includes(inHome)) return 'deletes a folder directly in your home folder (.ssh, Documents, a project...): name a path inside it'
  return null
}

// The rm family: recursive when its flags say so; the operands are the targets.
function removal(c: Cmd): { rec: boolean; paths: string[]; narrowed: boolean } {
  // PowerShell's Remove-Item takes -Recurse and any prefix of it; its aliases rm/ri/del/rd come with the same flags.
  const psy = (c.ps && !NODE_DEL.has(c.name)) || c.name === 'remove-item' || c.name === 'ri'
  let rec = NODE_DEL.has(c.name), dry = false, ended = false, narrowed = false
  const paths: string[] = []
  for (let i = 0; i < c.args.length; i++) {
    const a = c.args[i]!
    if (!ended && a === '--') { ended = true; continue }
    if (!ended && a.length > 1 && a[0] === '-') {
      if (!psy) {
        if (/^-[a-zA-Z]+$/.test(a) ? /[rR]/.test(a) : a.length >= 3 && '--recursive'.startsWith(a.split('=')[0]!)) rec = true
        continue
      }
      const n = a.slice(1).split(':')[0]!.toLowerCase(), inline = a.includes(':') ? a.slice(a.indexOf(':') + 1) : undefined
      if ('recurse'.startsWith(n)) rec = !/^\$?(false|0)$/i.test(inline ?? '')
      else if (/^r[fiv]+$/i.test(n)) rec = true
      else if (n === 'wi' || (n.length >= 2 && 'whatif'.startsWith(n))) dry = !/^\$?(false|0)$/i.test(inline ?? '')
      else if ('path'.startsWith(n) || 'literalpath'.startsWith(n) || n === 'lp' || n === 'pspath') {
        const v = inline ?? c.args[++i]
        if (v) paths.push(...v.split(','))
      } else if (n.length >= 2 && ('include'.startsWith(n) || 'filter'.startsWith(n))) {
        // -Include/-Filter with a pattern other than `*` limits what goes, as a find test does.
        const v = inline ?? c.args[++i]
        if (v && !v.split(',').some((p) => /^\*+$/.test(p))) narrowed = true
      } else if (!['force', 'confirm', 'verbose', 'debug', 'usetransaction'].some((l) => l.startsWith(n)) && inline === undefined
        && (['ea', 'wa', 'ia', 'ev', 'wv', 'iv', 'ov', 'ob', 'pv'].includes(n) || ['include', 'exclude', 'filter', 'erroraction', 'warningaction', 'informationaction',
          'errorvariable', 'warningvariable', 'informationvariable', 'outvariable', 'outbuffer', 'pipelinevariable', 'credential', 'stream'].some((l) => l.startsWith(n)))) i++
      continue
    }
    if (!ended && CMD_SWITCH.has(c.name) && /^\/[a-z?](\/[a-z?])*$/i.test(a)) { if (/\/s/i.test(a)) rec = true; continue }
    paths.push(...(psy ? a.split(',') : [a]))
  }
  return { rec: rec && !dry, paths, narrowed }
}

// Where a cd leaves later relative paths, or undefined when the line does not say (`cd -`, `cd $dir`, popd).
function chdir(c: Cmd, x: Ctx): string | undefined {
  const [name, ...a] = c.args
  const arg = a.find((y) => !y.startsWith('-') && !/^\/d$/i.test(y))
  if (arg === undefined) return name === 'cd' && !c.ps ? resolve(x.env.home, x.env.cwd, x.win) : x.cur
  const all = expand(arg, x)
  const s = all[0]!
  if (all.length !== 1 || /[$%`]/.test(s) || (x.cur === undefined && !/^([A-Za-z]:|[\\/]|~)/.test(s))) return undefined
  return resolve(s, x.cur ?? x.env.cwd, x.win)
}

// null = let it run, otherwise what the command would destroy. `tool` is the tool the command runs in.
export function check(cmd: string, tool: string, env: Env): string | null {
  const cmds: Cmd[] = []
  lex(cmd, tool === 'PowerShell', cmds)
  const win = /^[A-Za-z]:|^\\\\/.test(env.cwd)
  const x: Ctx = { env, win, ps: false, cur: env.cwd, vars: new Map() }
  const scopes: { cur: string | undefined; vars: Map<string, string[]> }[] = []
  const stack: (string | undefined)[] = []
  let prev: string | undefined
  for (const c of cmds) {
    x.ps = c.ps
    // Past the nesting limit the rest is not read, only scanned for a word that is a dangerous target on its own.
    if (c.name === 'deep') {
      for (const w of c.args[0]!.split(/[\s"'`();|&]+/)) if (w && w[0] !== '-' && target(w, x, false)) return `the command nests too deeply to be read, and its rest names ${w}, which a delete must not reach: split it into separate calls`
      continue
    }
    if (c.name === 'scope') { scopes.push({ cur: x.cur, vars: new Map(x.vars) }); continue }
    if (c.name === 'end') { const s = scopes.pop(); if (s) { x.cur = s.cur; x.vars = s.vars } continue }
    const key = (n: string): string => (c.ps ? n.toLowerCase() : n)
    if (c.name === '=') { x.vars.set(key(c.args[0]!), [c.args[1]!]); continue }
    if (c.name === 'for') { x.vars.set(key(c.args[0]!), c.args.slice(1)); continue }
    if (c.name === 'cd') {
      // cd - goes back, pushd/popd keep a stack; a folder the line does not name is unknown (undefined).
      const [n, ...a] = c.args, old = x.cur
      if (/^(popd|pop-location)$/.test(n!)) x.cur = stack.pop()
      else { if (/^(pushd|push-location)$/.test(n!)) stack.push(old); x.cur = a.includes('-') ? prev : chdir(c, x) }
      prev = old
      continue
    }
    const shown = `\`${[c.name, ...c.args].join(' ')}\``
    if (c.name === 'find') {
      let i = 0
      while (i < c.args.length && /^-[HLP]$/.test(c.args[i]!)) i++
      const roots: string[] = []
      while (i < c.args.length && !/^(-|\(|!)/.test(c.args[i]!)) roots.push(c.args[i++]!)
      const rest = c.args.slice(i)
      // What runs the delete: -delete, or an -exec of a delete command. Only what comes before it can narrow it.
      const del = rest.findIndex((y, k) => y === '-delete' || (/^-(exec|execdir|ok|okdir)$/.test(y) && RM.has(base(rest[k + 1] ?? ''))))
      if (del < 0) continue
      const narrowed = findNarrowed(rest.slice(0, del))
      for (const p of roots.length ? roots : ['.']) {
        const why = target(p, x, narrowed)
        if (why) return `${shown} ${why}`
      }
      continue
    }
    const { rec, paths, narrowed } = removal(c)
    if (!rec) continue
    for (const p of paths) {
      const why = target(p, x, narrowed)
      if (why) return `${shown} ${why}`
    }
  }
  return null
}

// Worth lexing: names a delete command, a shell that may carry one, or eval.
const MAYBE = /\b(rm|rmdir|rd|del|erase|ri|remove-item|find|eval|iex|invoke-expression|sh|bash|zsh|dash|ksh|su|cmd|pwsh|powershell|nix-shell)\b|\s-e(c|nc)/i

const FIX = 'Name the folder you mean, inside this project (rm -rf dist, Remove-Item -Recurse .\\dist); a delete of the project, ' +
  'your home, a drive or .git cannot be undone. Or ask the user to run the command themselves with `!` if it is truly needed. ' +
  'MAKARASTY_DELETE_GUARD=off turns this off.'

// What a shell call is told, or null to let it run.
export function denial(command: string, tool: string, env: Env): string | null {
  const why = check(command, tool, env)
  return why && `Blocked by makarasty-tools delete-guard: ${why}. ${FIX}`
}

export const register: Register = on => {
  on('tool.call', { tool: /^(Bash|PowerShell)$/ }, async ($, e, next) => {
    const command = e.tool === 'Bash' || e.tool === 'PowerShell' ? e.command : ''
    if (!MAYBE.test(command)) return next(e)
    let deny: string | null = null
    try {
      if ((await $.env.get('MAKARASTY_DELETE_GUARD')) === 'off') return next(e)
      const cwd = await $.session.cwd()
      const win = /^[A-Za-z]:|^\\\\/.test(cwd)
      // An unknown home reads as the root, so `~` is refused rather than guessed.
      const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '/'
      const tmp = (await $.env.get('TMPDIR')) || (await $.env.get('TEMP')) || (await $.env.get('TMP')) || (win ? 'C:/Windows/Temp' : '/tmp')
      deny = denial(command, e.tool, { cwd, home, tmp })
    } catch {
      // shortcut: a bug in this guard (not a refusal) lets the call run rather than blocking every shell call.
    }
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => next(e))
}
