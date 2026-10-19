import type { Register } from 'claude-code'

// Refuses git commands that throw away uncommitted work. Several sessions often share one working tree, so
// "my changes" is never all the changes: a stash once wiped 171 files of other sessions' work. A function
// hook, so the check is a few regexes inside the engine and no shell call pays a process for it.
// Allowed on purpose: commit, branch switch without force, reset (mixed/soft), stash list/show, clean -n,
// restore --staged, push --force-with-lease. The person can still run anything themselves with `!`.
type Rule = [RegExp | ((s: string) => boolean), string]
const RULES: Rule[] = [
  // Read-only stash subcommands pass, and create, which only writes a commit object; branch applies and
  // drops the stash, so it is refused too.
  [(s) => /^stash(\s|$)/.test(s) && !/^stash\s+(list|show|create)(\s|$)/.test(s), "git stash pulls every uncommitted change out of the tree, other sessions' included"],
  [/^reset\b.*\s--(hard|merge|keep)\b/, 'git reset --hard/--merge/--keep overwrites uncommitted changes'],
  [(s) => /^clean\b/.test(s) && /\s(-\w*f|--force)/.test(s) && !/\s(-[a-z]*n[a-z]*|--dry-run)\b/.test(s), "git clean -f deletes untracked files, other sessions' new files included"],
  // A trailing `--` with no path after it (`checkout main --`) only ends the options.
  [/^checkout\b.*\s(--\s+\S|\.(\s|$))/, 'git checkout -- <path> / . discards uncommitted changes'],
  [/^checkout\b.*\s(-[a-zA-Z]*f[a-zA-Z]*|--force)(?=\s|$)/, 'git checkout -f discards uncommitted changes'],
  // A tree-ish then a path (`checkout HEAD a.ts`) overwrites the file. One bare name could be a branch or a
  // path and stays allowed; -b/-B/--orphan take a start point as their second word.
  [(s) => /^checkout\b/.test(s) && !/\s(-[bB]|--orphan)(\s|$)/.test(s) && s.split(' ').slice(1).filter((w) => !w.startsWith('-')).length >= 2,
    'git checkout <tree-ish> <path> discards uncommitted changes'],
  [/^switch\b.*\s(-[a-zA-Z]*f[a-zA-Z]*|--force|--discard-changes)(?=\s|$)/, 'git switch --discard-changes discards uncommitted changes'],
  [(s) => /^restore\b/.test(s) && !(/\s(--staged|-S)\b/.test(s) && !/\s(--worktree|-W)\b/.test(s)), 'git restore without --staged discards uncommitted changes'],
  // A reversed patch (`git diff | git apply -R`) undoes every uncommitted change it lists in the tree;
  // only --cached keeps it to the index. --check, --stat, --numstat and --summary apply nothing, unless --apply.
  [(s) => /^apply\b/.test(s) && /\s(-[a-zA-Z0-9]*R[a-zA-Z0-9]*|--reverse)(\s|$)/.test(s) && !/\s--cached(\s|$)/.test(s)
    && (!/\s--(check|stat|numstat|summary)(\s|$)/.test(s) || /\s--apply(\s|$)/.test(s)),
    'git apply -R reverses uncommitted changes in the tree (git apply -R --cached, --check or --stat is allowed)'],
  [/^worktree\s+remove\b/, 'git worktree remove follows a node_modules junction and empties the main checkout: unlink reparse points first and clean only through fleet.sh clean'],
  [(s) => /^push\b/.test(s) && (/\s--force(\s|$)/.test(s) || /\s-[a-zA-Z]*f[a-zA-Z]*(\s|$)/.test(s) || /\s\+\S/.test(s)), 'git push --force overwrites commits on the remote (--force-with-lease is allowed)'],
  [(s) => /^branch\b/.test(s) && (/\s-[a-zA-Z]*D/.test(s) || (/\s(-[a-zA-Z]*d[a-zA-Z]*|--delete)(\s|$)/.test(s) && /\s(-[a-zA-Z]*f[a-zA-Z]*|--force)(\s|$)/.test(s))), 'git branch -D deletes a branch with commits that may be unmerged'],
  // From dcg (Dicklesworthstone/destructive_command_guard): history and object store rewrites.
  [/^filter-branch\b/, 'git filter-branch rewrites every commit of the branch and checks the rewritten tree out'],
  [/^reflog\s+expire\b/, 'git reflog expire drops the reflog entries that are the only way back to a lost commit'],
  [/^update-ref\b.*\s(-d|--delete)(\s|$)/, 'git update-ref -d deletes a ref, and the commits only it reaches'],
  [/^read-tree\b.*\s--reset\b/, 'git read-tree --reset overwrites the index, and with -u the files too'],
  // Plain `git rm` refuses a file with local changes; -f removes it anyway.
  [(s) => /^rm\b/.test(s) && !/\s--cached(\s|$)/.test(s) && /\s(-[a-zA-Z]*f[a-zA-Z]*|--force)(\s|$)/.test(s), 'git rm -f deletes files with uncommitted changes (plain git rm and git rm --cached are allowed)'],
  [/^gc\b.*\s--prune=now\b/, 'git gc --prune=now deletes unreachable objects at once, the last copy of a dropped stash or reset commit'],
]
// In place of git or its subcommand, a variable hides what runs; refused rather than guessed.
const VARIABLE = 'the command or its subcommand is a variable, so what it runs cannot be read before it runs: write git and the subcommand out'
// Global options that sit between `git` and the subcommand; these take a value.
const GLOBAL_WITH_VALUE = /^(-C|-c|--git-dir|--work-tree|--namespace)$/
const SHELL = /(^|[\\/])((ba|z|da|k)?sh|pwsh|powershell|cmd)(\.exe)?$/i
const WRAPPER = /^(env|command|sudo|nohup|time|exec|builtin|nice|xargs|timeout|watch|coproc|ionice|stdbuf|setsid)$/
// Subcommands a variable head is refused on; `rm` stays out so `"$DOCKER" rm -f web` runs.
const VIA_GUARDED = /^(stash|reset|checkout|switch|restore|clean|worktree|push|branch|filter-branch|reflog|update-ref|read-tree|gc|apply|submodule)$/
const GIT = /(^|[\\/])git(\.exe)?$/i
// The flag after which a shell takes its command line: bash -c / -lc, powershell -Command, cmd /c.
const SHELL_CMD = /^-\w*c$|^-command$|^\/c$/i
const MARK = /^\u0001(\d+)\u0001$/
// Redirections (2>&1, > /dev/null, &>f, *> $null, < f) are not part of the command.
const REDIR = /[\d*]*(?:>>?|<)&?\s*[^\s;&|()<>]+|&>>?\s*[^\s;&|()<>]+/g

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

// Code hidden inside a double-quoted string runs too: $(...), and in Bash `...`. In PowerShell a backtick is
// the escape character, never a substitution.
function substs(body: string, into: string[], ps: boolean): void {
  const esc = ps ? '`' : '\\'
  for (let i = 0; i < body.length; i++) {
    if (body[i] === esc) i++
    else if (body[i] === '$' && body[i + 1] === '(') { const e = closing(body, i + 2, esc); into.push(body.slice(i + 2, e)); i = e }
    else if (!ps && body[i] === '`') { const e = body.indexOf('`', i + 1); if (e < 0) break; into.push(body.slice(i + 1, e)); i = e }
  }
}

// Replaces every quoted string with a numbered mark (kept in `lits`), pulls $(...) and backticks into `nested`,
// and turns subshell parens into separators.
// shortcut: quotes inside a $( ) that hold parens can mis-pair; upgrade to a real shell parser if that bites.
function lex(src: string, lits: string[], nested: string[], ps: boolean): string {
  const esc = ps ? '`' : '\\'
  let out = ''
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (c === esc) { out += src.slice(i, i + 2); i++ }
    else if (c === "'") {
      const e = src.indexOf("'", i + 1), end = e < 0 ? src.length : e
      out += `\u0001${lits.push(src.slice(i + 1, end)) - 1}\u0001`; i = end
    } else if (c === '"') {
      let end = i + 1
      while (end < src.length && src[end] !== '"') end += src[end] === esc ? 2 : 1
      const body = src.slice(i + 1, end)
      substs(body, nested, ps)
      out += `\u0001${lits.push(ps ? body.replace(/`(.)/g, '$1') : body.replace(/\\(["\\$`])/g, '$1')) - 1}\u0001`; i = end
    } else if (c === '$' && src[i + 1] === '(') { const e = closing(src, i + 2, esc); nested.push(src.slice(i + 2, e)); out += ' ; '; i = e }
    else if (!ps && c === '`') { const e = src.indexOf('`', i + 1), end = e < 0 ? src.length : e; nested.push(src.slice(i + 1, end)); out += ' ; '; i = end }
    else out += c === '(' || c === ')' ? ';' : c
  }
  return out
}

// A git subcommand line, and the variable that stood in for git when one did.
type Sub = { sub: string; via?: string }
function subcommands(cmd: string, ps: boolean, depth = 0): Sub[] {
  if (depth > 4) return []
  // A line continuation (PowerShell backtick, Bash backslash before the newline) is one command, not two.
  cmd = cmd.replace(ps ? /`\r?\n/g : /\\\r?\n/g, ' ')
  const lits: string[] = [], nested: string[] = []
  // A heredoc on a shell's own stdin (`bash <<EOF`, flags only) is code; one fed to a script (`sh x.sh <<EOF`)
  // or any other command (commit messages) is that command's text.
  for (const m of cmd.matchAll(/(?:^|[\s;&|(/\\])(?:ba|z|da|k)?sh(?:\.exe)?(?:[ \t]+-[\w-]+)*[ \t]*<<-?\s*['"]?(\w+)['"]?\n([\s\S]*?)\n\s*\1\b/g)) nested.push(m[2]!)
  const cleaned = lex(cmd
    .replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\s*\1\b/g, ' ') // heredoc bodies (commit messages)
    .replace(/@'[\s\S]*?'@|@"[\s\S]*?"@/g, ' '), lits, nested, ps) // PowerShell here-strings
    .replace(REDIR, ' ')
  const out: Sub[] = []
  // A quoted word as the shell hands it on: `"git"`, `& "C:\Program Files\Git\cmd\git.exe"`.
  const unq = (w: string): string => { const m = MARK.exec(w); return m ? lits[+m[1]!]! : w }
  // Words another command runs as a command line: one quoted word is a command line of its own; unquoted,
  // the words are, their quoted words put back in quotes.
  const handOn = (rest: string[]): void => {
    if (rest[0] && !MARK.test(rest[0])) nested.push(rest.map((w) => { const m = MARK.exec(w); return m ? `'${lits[+m[1]!]}'` : w }).join(' '))
    else for (const w of rest) { const m = MARK.exec(w); if (m) nested.push(lits[+m[1]!]!) }
  }
  // A brace standing alone opens or closes a block (`% { git stash }`, `try { ... }`); `@{u}` and `-I{}` stay words.
  for (const seg of cleaned.split(/&&|\|\||[;|&\n]|(?:^|\s)[{}](?=\s|$)/)) {
    const words = seg.trim().split(/\s+/)
    // A closing brace glued to the last word (`{git stash}`) or standing alone ends a block, not an argument.
    // `{}` (find -exec's file, xargs -I{}) is a word, not a block.
    const last = words.pop()!.replace(/(?<!\{)\}$/, '')
    if (last) words.push(last)
    let at = 0, wrapped = false
    // PS call operator, VAR=x prefixes, shell keywords before a command, env/command/sudo and their flags
    while (at < words.length) {
      const w = words[at]!
      if (/^(&|\{|!|if|then|do|else|elif|while|until|\w+=\S*)$/.test(w) || (wrapped && w.startsWith('-'))) at++
      // An opening brace glued to the command (`{git stash}`) opens a block.
      else if (w.length > 1 && w.startsWith('{')) words[at] = w.slice(1)
      // PowerShell captures output with `$x = git stash`, which still runs git.
      else if (/^\$[\w:]+$/.test(w) && words[at + 1] === '=') at += 2
      // A wrapper's own arguments (`timeout 60`, `sudo -u bob`, `nice -n 10`) end where git or a shell starts.
      else if (WRAPPER.test(w)) {
        const g = words.findIndex((x, k) => k > at && (GIT.test(unq(x)) || SHELL.test(unq(x))))
        if (g > 0) { at = g; break }
        wrapped = true; at++
      }
      else break
    }
    const head = unq(words[at] ?? '')
    // bash -c "..." / eval "..." / iex "...": the string is a command line of its own.
    // Unquoted (`cmd /c git stash`), the rest of the line is that command, its quoted words put back in quotes.
    const flag = /^(eval|iex|invoke-expression)$/i.test(head) ? at : SHELL.test(head) ? words.findIndex((w, k) => k > at && SHELL_CMD.test(w)) : -1
    if (flag >= 0) handOn(words.slice(flag + 1))
    // find -exec / -execdir runs the words after it, up to `\;` or `+`, once per file.
    const exec = words.findIndex((w, k) => k > at && /^-exec(dir)?$/.test(w))
    if (exec >= 0) handOn(words.slice(exec + 1))
    // A bare variable head (`$g`, `"$DOCKER"`) may stand for git: only the very next word is read, as a subcommand,
    // so `$_ -match 'x'` or `"$d" rm -f web` pass. A path to a tool (`$env:X\dotnet.exe`) is that tool, not git.
    const via = head.startsWith('$') && !GIT.test(head) ? head : undefined
    if (via ? !/^\$\{?[\w:]+\}?$/.test(via) : !GIT.test(head)) continue
    let i = at + 1
    if (via) { if (!VIA_GUARDED.test(unq(words[i] ?? ''))) continue }
    else while (i < words.length && words[i]!.startsWith('-')) i += GLOBAL_WITH_VALUE.test(words[i]!) ? 2 : 1
    if (i < words.length) out.push({ sub: [unq(words[i]!), ...words.slice(i + 1)].join(' '), via })
    // `git submodule foreach [--recursive] <command>` runs that command in every submodule.
    if (unq(words[i] ?? '') === 'submodule') {
      let f = words.findIndex((w, k) => k > i && unq(w) === 'foreach')
      if (f > 0) { f++; while (f < words.length && words[f]!.startsWith('-')) f++; handOn(words.slice(f)) }
    }
  }
  // shortcut: a string one shell hands another (`powershell -Command` from Bash) is lexed by the outer shell's
  // escapes; lex nested by the inner shell if that ever hides a command.
  for (const n of nested) out.push(...subcommands(n, ps, depth + 1))
  return out
}

// null = let it run, otherwise why it would destroy work. `tool` is the tool the command runs in.
// shortcut: with no tool the command is read as Bash, so a PowerShell backtick counts as a substitution
// (over-blocks) and a backtick continuation is not joined; the hook always passes it, guess only for a new caller.
export function check(cmd: string, tool = 'Bash'): string | null {
  for (const { sub, via } of subcommands(cmd, tool === 'PowerShell')) {
    const name = sub.split(' ')[0]!
    if (!via && name.startsWith('$')) return `git ${name}: ${VARIABLE}`
    // shortcut: a bare `$var` before a guarded subcommand word is read as git, so `$pkg restore` is refused too.
    for (const [rule, why] of RULES) if (typeof rule === 'function' ? rule(sub) : rule.test(sub)) return via ? `${via} ${name}: ${VARIABLE}` : `git ${name}: ${why}`
  }
  return null
}
// Worth lexing: names git, or holds a variable that may stand in for it.
const MAYBE = /\bgit\b|\$/i

// What a shell call is told, or null to let it run.
export function denial(command: string, off: boolean, tool = 'Bash'): string | null {
  if (off || !MAYBE.test(command)) return null
  const why = check(command, tool)
  return why && `Blocked by makarasty-tools git-guard: ${why}. Other sessions share this tree. ` +
    'Revert only your own edits with Edit/Write, save work with a commit or `git diff > file`; ' +
    'to see pre-fix code, `git show HEAD:<path>` into the scratchpad or use a worktree; ' +
    'or ask the user to run the command themselves with `!` if it is truly needed. MAKARASTY_GIT_GUARD=off turns this off.'
}

export const register: Register = on => {
  on('tool.call', { tool: /^(Bash|PowerShell)$/ }, async ($, e, next) => {
    const command = e.tool === 'Bash' || e.tool === 'PowerShell' ? e.command : ''
    const deny = MAYBE.test(command) && denial(command, (await $.env.get('MAKARASTY_GIT_GUARD')) === 'off', e.tool)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => next(e))
}
