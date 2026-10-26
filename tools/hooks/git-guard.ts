import type { Register } from 'claude-code'

// Refuses git commands that throw away uncommitted work. Several sessions often share one working tree, so
// "my changes" is never all the changes: a stash once wiped 171 files of other sessions' work. A function
// hook, so the check is a few regexes inside the engine and no shell call pays a process for it.
// Allowed on purpose: commit, branch switch without force, reset (mixed/soft), stash list/show, clean -n,
// restore --staged, push --force-with-lease, switch/checkout -c/-b/-C/-B (the reflog keeps an overwritten branch tip;
// this guard is about uncommitted work). The person can still run anything themselves with `!`.
// A discard (third element `true`) is allowed in a private tree: a fleet worker's own worktree under `.claude/worktrees/`
// or a clone under the OS temp dir, which no other session shares. Everything else is refused in every tree.
type Rule = [RegExp | ((s: string) => boolean), string, boolean?]
// Git takes any unambiguous prefix of a long option (`reset --har` is --hard); an ambiguous prefix fails in git,
// so over-matching it is harmless. `opt('force')` matches --force and its prefixes, never --force-with-lease.
const pre = (w: string): string => w[0] + [...w.slice(1)].reduceRight((a, c) => `(?:${c}${a})?`, '')
const opt = (...names: string[]): string => `--(?:${names.map(pre).join('|')})(?=[\\s=]|$)`
// Config keys are case-insensitive in section and name (`-c Alias.x=..`); `-c` itself is not `-C`.
const ci = (w: string): string => [...w].map((c) => (c === '.' ? '\\.' : `[${c}${c.toUpperCase()}]`)).join('')
// Words after an option that takes a value are that value, not flags: `branch --sort -refname`, `commit -m -n`.
// shortcut: only the exact flag words, not a cluster ending in the flag (`-am -n`); upgrade if that bites.
const noValues = (s: string, ...flags: string[]): string => s.replace(new RegExp(`\\s(?:${flags.join('|')})\\s+\\S+`, 'g'), '')
// Hooks and signing are the repo owner's checks; the commit and ship skills forbid skipping them only in prose.
const SKIP = "hooks and signing are the repo owner's checks, and skipping them is the person's call: ask them to run it themselves with `!`"
// Where git runs. `cwd` is the session directory, `tmp` the OS temp dirs ($TMPDIR, $TEMP, $TMP).
export type Where = { cwd?: string; tmp?: string[] }
// A directory a path leads to from `base`: '?' when it cannot be read (a variable, `~`, `cd -`), which counts as shared.
const TMPVAR = /^(\$\{?(TMPDIR|TEMP|TMP)\}?|\$env:(TMPDIR|TEMP|TMP)|%(TEMP|TMP)%)(?=\/|$)/i
const resolveDir = (base: string, path: string): string => {
  let p = path.replace(/\\/g, '/')
  const v = TMPVAR.exec(p)
  if (v) p = '/tmp' + p.slice(v[0].length)
  else if (/[$%`~*?]/.test(p)) return '?'
  const root = /^(?:[a-zA-Z]:)?\//.exec(p)?.[0] ?? ''
  if (!root && base === '?') return '?'
  const full = root || !base ? p : `${base}/${p}`
  const top = /^(?:[a-zA-Z]:)?\//.exec(full)?.[0] ?? ''
  const out: string[] = []
  for (const seg of full.slice(top.length).split('/')) {
    if (!seg || seg === '.') continue
    if (seg !== '..') out.push(seg)
    else if (out.length && out[out.length - 1] !== '..') out.pop()
    else if (!top) out.push('..')
  }
  return top + out.join('/')
}
// A private tree: under `.claude/worktrees/<name>` or inside the OS temp dir, as Windows, Git Bash or /tmp spell it.
const isPrivate = (dir: string, tmp: string[] = []): boolean => {
  const d = dir.toLowerCase()
  if (!d || d === '?') return false
  if (/(^|\/)\.claude\/worktrees\/[^/]/.test(d) || /^(\/[a-z]|[a-z]:)\/users\/[^/]+\/appdata\/local\/temp\/[^/]/.test(d)) return true
  const roots = ['/tmp']
  for (const t of tmp) if (t) { const r = t.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); roots.push(r, r.replace(/^([a-z]):/, '/$1')) }
  return roots.some((r) => d.startsWith(r + '/') && d.length > r.length + 1)
}
const operands = (s: string): string[] => s.split(' ').slice(1).filter((w) => w && !w.startsWith('-'))
// A boolean config value spelled false: false/no/off/0, or empty (`-c commit.gpgsign=`), in any case.
const FALSY = `=(?:${['false', 'no', 'off'].map(ci).join('|')}|0|)(?=\\s|$)`
// A short-flag cluster holds `c` before its first value-taking letter: in `-minit` the rest is the message, in
// `-m x` the next word is. `valued` letters take the next word, `attached` ones only the rest of the cluster.
// Nothing after a bare `--` is a flag.
const hasShort = (s: string, c: string, valued: string, attached: string): boolean => {
  const w = s.split(' ').slice(1)
  for (let k = 0; k < w.length; k++) {
    if (w[k] === '--') return false
    if (/^--(message|file|author|reuse-message|reedit-message|template|date|trailer|cleanup|fixup|squash)$/.test(w[k]!)) { k++; continue }
    if (!/^-[a-zA-Z]/.test(w[k]!)) continue
    for (let j = 1; j < w[k]!.length; j++) {
      const l = w[k]![j]!
      if (l === c) return true
      if (valued.includes(l) || attached.includes(l)) { if (valued.includes(l) && j === w[k]!.length - 1) k++; break }
    }
  }
  return false
}
// The flags of a hook or signing check: no pathspec after `--`, no message text.
const flagsOf = (s: string): string => {
  const t = s.split(/\s--(?:\s|$)/)[0]!
  return /^(commit|merge|tag)\b/.test(t) ? noValues(t, '-m', '--message', '-F', '--file') : t
}
// The key and value of `git config [options] <key> <value>`, or null for a read, an unset or an edit.
const cfgWrite = (s: string): [string, string] | null => {
  if (!/^config\b/.test(s) || /\s(--get\S*|--list|-l|--unset\S*|--remove-section|--rename-section|--edit|-e|--name-only)(\s|$)/.test(s)) return null
  let o = operands(noValues(s, '-f', '--file', '--blob', '--type', '--default', '--comment'))
  if (o[0] === 'set') o = o.slice(1)
  else if (/^(get|list|unset|edit|remove-section|rename-section)$/.test(o[0] ?? '')) return null
  return o.length >= 2 ? [o[0]!, o[1]!] : null
}
// A lone checkout operand that can only be a path: `.`, `src/`, `./x`, `:/`, `C:\x`, a glob. `feature/x` may be a branch.
// -b/-B (alone or in a cluster: `-qb`, `-tb`) and --orphan take a start point as their second word.
const NEW_BRANCH = /\s(-[a-zA-Z]*[bB]|--orphan)(\s|$)/
const PATHISH = /^(\.\.?|\.\.?[\\/].*|.*[\\/]|:.*|[\\/].*|[A-Za-z]:[\\/].*|.*[*?[].*)$/
// gpg.program set to a stand-in that signs nothing; a real gpg path (`C:/Program Files/Git/usr/bin/gpg.exe`) is a setup.
const GPG_BAD = `(?:${['true', 'false', 'echo', 'cat'].map(ci).join('|')}|:|(?:/usr)?/bin/(?:${['true', 'false', 'echo', 'cat'].map(ci).join('|')}))`
// core.hooksPath that empties or leaves the repo's hooks (a relative `.husky` or `.githooks` only swaps them).
const HOOKS_BAD = /^(\u0003|\/.*|\\.*|~.*|[A-Za-z]:[\\/].*|nul)$/i
// `git config [options] <key> <value>` that turns the repo's hooks or signing off for good.
const skipsConfig = (s: string): boolean => {
  const w = cfgWrite(s)
  if (!w) return false
  const [k, v] = w as [string, string]
  return (new RegExp(`^${ci('core.hookspath')}$`).test(k) && HOOKS_BAD.test(v))
    || (new RegExp(`^${ci('gpg.program')}$`).test(k) && new RegExp(`^(${GPG_BAD}|\\u0003)$`).test(v))
    || (new RegExp(`^(${ci('commit')}|${ci('tag')})${ci('.gpgsign')}$`).test(k) && /^(false|no|off|0|\u0003)$/i.test(v))
}
const RULES: Rule[] = [
  // Read-only stash subcommands pass, and create, which only writes a commit object; branch applies and
  // drops the stash, so it is refused too.
  [(s) => /^stash(\s|$)/.test(s) && !/^stash\s+(list|show|create)(\s|$)/.test(s), "git stash pulls every uncommitted change out of the tree, other sessions' included", true],
  [new RegExp(`^reset\\b.*\\s${opt('hard', 'merge', 'keep')}`), 'git reset --hard/--merge/--keep overwrites uncommitted changes', true],
  [(s) => /^clean\b/.test(s) && new RegExp(`\\s(-\\w*f|${opt('force')})`).test(s) && !new RegExp(`\\s(-[a-z]*n[a-z]*|${opt('dry-run')})`).test(s),
    "git clean -f deletes untracked files, other sessions' new files included", true],
  // A trailing `--` with no path after it (`checkout main --`) only ends the options.
  [/^checkout\b.*\s(--\s+\S|\.(\s|$))/, 'git checkout -- <path> / . discards uncommitted changes', true],
  [new RegExp(`^checkout\\b.*\\s(-[a-zA-Z]*f[a-zA-Z]*(?=\\s|$)|${opt('force')})`), 'git checkout -f discards uncommitted changes', true],
  // --ours/--theirs rewrite the conflicted file from one side.
  [new RegExp(`^checkout\\b.*\\s${opt('ours', 'theirs')}`), 'git checkout --ours/--theirs overwrites the conflicted file in the tree', true],
  // A tree-ish then a path (`checkout HEAD a.ts`) overwrites the file. One bare name could be a branch or a
  // path and stays allowed, unless it can only be a path (`src/`, `./`, `:/`); -b/-B/--orphan take a start point
  // as their second word.
  [(s) => /^checkout\b/.test(s) && !NEW_BRANCH.test(s) && operands(s).length >= 2,
    'git checkout <tree-ish> <path> discards uncommitted changes', true],
  [(s) => /^checkout\b/.test(s) && !NEW_BRANCH.test(s) && operands(s).length === 1 && PATHISH.test(operands(s)[0]!),
    'git checkout <path> (src/, ./, :/) discards uncommitted changes', true],
  [new RegExp(`^switch\\b.*\\s(-[a-zA-Z]*f[a-zA-Z]*(?=\\s|$)|${opt('force', 'discard-changes')})`), 'git switch --discard-changes discards uncommitted changes', true],
  [(s) => /^restore\b/.test(s) && !(/\s(--staged|-S)\b/.test(s) && !/\s(--worktree|-W)\b/.test(s)), 'git restore without --staged discards uncommitted changes', true],
  // A reversed patch (`git diff | git apply -R`) undoes every uncommitted change it lists in the tree;
  // only --cached keeps it to the index. --check, --stat, --numstat and --summary apply nothing, unless --apply.
  [(s) => /^apply\b/.test(s) && new RegExp(`\\s(-[a-zA-Z0-9]*R[a-zA-Z0-9]*(\\s|$)|${opt('reverse')})`).test(s) && !/\s--cached(\s|$)/.test(s)
    && (!/\s--(check|stat|numstat|summary)(\s|$)/.test(s) || /\s--apply(\s|$)/.test(s)),
    'git apply -R reverses uncommitted changes in the tree (git apply -R --cached, --check or --stat is allowed)', true],
  [/^worktree\s+remove\b/, 'git worktree remove follows a node_modules junction and empties the main checkout: use /makarasty-tools:prune, or fleet.sh clean for the worktree of a fleet run'],
  [(s) => /^push\b/.test(s) && (/\s--force(\s|$)/.test(s) || /\s-[a-zA-Z]*f[a-zA-Z]*(\s|$)/.test(s) || /\s\+\S/.test(s)), 'git push --force overwrites commits on the remote (--force-with-lease is allowed)'],
  // A remote ref deleted (`--delete`, `-d`, `:ref`) or every ref overwritten (`--mirror`, `--prune`) is gone for everyone.
  [(s) => /^push\b/.test(s) && (new RegExp(`\\s${opt('delete', 'mirror', 'prune')}`).test(s) || /\s-[a-zA-Z]*d[a-zA-Z]*(\s|$)/.test(s) || /\s:\S/.test(s)),
    'git push --delete/-d/:ref/--mirror/--prune deletes or overwrites remote branches, and the commits only they reach'],
  // -f/-M/-C move or overwrite an existing branch; -d and -m refuse when the target is unmerged or taken.
  // `-M main` with one name renames the current branch (GitHub's own first-push step); -M with two names overwrites.
  [(s) => /^branch\b/.test(s) && ((t) => /\s-[a-zA-Z]*[DfC]/.test(t) || (/\s-[a-zA-Z]*M/.test(t) && operands(t).length >= 2) || new RegExp(`\\s${opt('force')}`).test(t))(noValues(s, '--sort', '--format', '--points-at', '--set-upstream-to', '-u')), 'git branch -D/-f/-M/-C deletes or overwrites a branch with commits that may be unmerged'],
  // --autostash is git stash plus pop, the same loss by another name.
  [new RegExp(`^(pull|rebase|merge)\\b.*\\s${opt('autostash')}`), "git pull/rebase/merge --autostash stashes every uncommitted change, other sessions' included", true],
  // An alias hides what runs from this guard, so none may be defined (a read of one passes).
  [(s) => new RegExp(`^${ci('alias.')}`).test(cfgWrite(s)?.[0] ?? ''), 'git config alias.* defines an alias, and aliases hide the real subcommand from this guard'],
  [(s) => /^(commit|push|merge|am|rebase|pull)\b/.test(s) && new RegExp(`\\s${opt('no-verify')}`).test(flagsOf(s)), SKIP],
  // Only commit and am read -n as --no-verify; on push, merge, rebase, clean, prune it means something else.
  [(s) => /^commit\b/.test(s) && hasShort(s, 'n', 'mFCctU', 'uS'), SKIP],
  [(s) => /^am\b/.test(s) && hasShort(s, 'n', '', 'CpS'), SKIP],
  [(s) => /^(commit|merge|rebase|cherry-pick|tag|pull|revert)\b/.test(s) && new RegExp(`\\s${opt('no-gpg-sign')}`).test(flagsOf(s)), SKIP],
  // The same switches written into the config for good: hooksPath, gpg.program, signing off.
  [skipsConfig, SKIP],
  [/^-c hooks$/, SKIP],
  [/^-c env$/, 'GIT_CONFIG_* variables set config (hooksPath, gpgsign, aliases) where this guard cannot read it: ask the person to run it themselves with `!`'],
  [/^-c alias$/, '-c alias.* defines an alias inline, and aliases hide the real subcommand from this guard'],
  [/^-c autostash$/, "-c rebase.autoStash stashes every uncommitted change on pull/rebase, other sessions' included", true],
  // History and object store rewrites.
  [/^filter-branch\b/, 'git filter-branch rewrites every commit of the branch and checks the rewritten tree out'],
  [/^reflog\s+(expire|delete)\b/, 'git reflog expire/delete drops the reflog entries that are the only way back to a lost commit'],
  [/^update-ref\b.*\s(-d|--delete)(\s|$)/, 'git update-ref -d deletes a ref, and the commits only it reaches'],
  [new RegExp(`^read-tree\\b.*\\s${opt('reset')}`), 'git read-tree --reset overwrites the index, and with -u the files too'],
  // Plain `git rm` refuses a file with local changes; -f removes it anyway.
  [(s) => /^rm\b/.test(s) && !new RegExp(`\\s${opt('cached')}`).test(s) && new RegExp(`\\s(-[a-zA-Z]*f[a-zA-Z]*(\\s|$)|${opt('force')})`).test(s), 'git rm -f deletes files with uncommitted changes (plain git rm and git rm --cached are allowed)', true],
  // Git's own default is two weeks, so weeks, months, years and absolute dates pass.
  [new RegExp(`^gc\\b.*\\s--${pre('prune')}(=(now|all|0|yesterday|\\d+[.\\u0002](seconds?|minutes?|hours?|days?)[.\\u0002]ago)|\\s+(now|all))(?=\\s|$)`, 'i'),
    'git gc --prune=now (or a date under a week) deletes unreachable objects at once, the last copy of a dropped stash or reset commit (plain git gc keeps two weeks)'],
  [(s) => /^prune(\s|$)/.test(s) && !new RegExp(`\\s(-[a-zA-Z]*n[a-zA-Z]*|${opt('dry-run')})`).test(s), 'git prune deletes unreachable objects at once, the last copy of a dropped stash or reset commit (git prune -n only lists them)'],
]
// In place of git or its subcommand, a variable hides what runs; refused rather than guessed.
const VARIABLE = 'the command or its subcommand is a variable, so what it runs cannot be read before it runs: write git and the subcommand out'
// Global options that sit between `git` and the subcommand; these take a value.
// (--exec-path and --list-cmds only take `=value`, so they are one word.)
const GLOBAL_WITH_VALUE = /^(-C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--attr-source|--config-env)$/
// `su -c "..."` takes its command line like a shell does.
const SHELL = /(^|[\\/])((ba|z|da|k)?sh|pwsh|powershell|cmd|su)(\.exe)?$/i
const WRAPPER = /^(env|command|sudo|nohup|time|exec|builtin|nice|xargs|timeout|watch|coproc|ionice|stdbuf|setsid|wsl(\.exe)?|doas|runuser|flock|taskset|strace|chronic)$/
// Subcommands a variable head is refused on. Words other tools share stay out (`"$DOCKER" rm -f web`, `$DOTNET restore`,
// `$SVN checkout url`, `$MAKE clean`): the cost is that `$g checkout -- .` and `$g restore .` through a variable run.
const VIA_GUARDED = /^(stash|reset|worktree|push|filter-branch|reflog|update-ref|read-tree|gc|submodule)$/
const ENV_CONFIG = /^(\$env:)?GIT_CONFIG_(PARAMETERS|COUNT|KEY_\d+|VALUE_\d+)=/
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
type Sub = { sub: string; via?: string; dir: string }
// `cwd` is the tree a command runs in until a `cd`, `pushd` or `Set-Location` before it moves it.
// shortcut: a cd inside a subshell `(cd x; git ..)` is read as lasting to the end of the line; upgrade if that bites.
function subcommands(cmd: string, ps: boolean, depth = 0, cwd = ''): Sub[] {
  if (depth > 4) return []
  // A line continuation (PowerShell backtick, Bash backslash before the newline) is one command, not two.
  cmd = cmd.replace(ps ? /`\r?\n/g : /\\\r?\n/g, ' ')
  const lits: string[] = [], nested: string[] = [], nestedDir: string[] = []
  let cur = cwd = cwd.replace(/\\/g, '/') // the session directory in Windows spelling too
  // A heredoc on a shell's own stdin (`bash <<EOF`, flags only) is code; one fed to a script (`sh x.sh <<EOF`)
  // or any other command (commit messages) is that command's text.
  for (const m of cmd.matchAll(/(?:^|[\s;&|(/\\])(?:ba|z|da|k)?sh(?:\.exe)?(?:[ \t]+-[\w-]+)*[ \t]*<<-?\s*['"]?(\w+)['"]?\n([\s\S]*?)\n\s*\1\b/g)) nested.push(m[2]!)
  const cleaned = lex(cmd
    .replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\s*\1\b/g, ' ') // heredoc bodies (commit messages)
    .replace(/@'[\s\S]*?'@|@"[\s\S]*?"@/g, ' '), lits, nested, ps) // PowerShell here-strings
    .replace(REDIR, ' ')
  const out: Sub[] = []
  // A quoted word as the shell hands it on: `"git"`, `& "C:\Program Files\Git\cmd\git.exe"`.
  // Spliced quotes (`st''ash`, `"st"ash`) are one word to the shell.
  const unq = (w: string): string => w.replace(/\u0001(\d+)\u0001/g, (_, n) => lits[+n]!)
  // A word of the subcommand line: unquoted, its inner whitespace kept from splitting it into words.
  const arg = (w: string): string => unq(w).replace(/\s/g, '\u0002') || '\u0003' // an empty quoted word stays a word
  // Words another command runs as a command line: one quoted word is a command line of its own; unquoted,
  // the words are, their quoted words put back in quotes.
  const handOn = (rest: string[]): void => {
    const from = nested.length
    if (rest[0] && !MARK.test(rest[0])) nested.push(rest.map((w) => { const m = MARK.exec(w); return m ? `'${lits[+m[1]!]}'` : w }).join(' '))
    else for (const w of rest) { const m = MARK.exec(w); if (m) nested.push(lits[+m[1]!]!) }
    for (let k = from; k < nested.length; k++) nestedDir[k] = cur
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
        // `env -S "git stash"` splits its one string into a command line.
        if (w === 'env' && /^(-S|--split-string)$/.test(words[at + 1] ?? '')) handOn(words.slice(at + 2))
        const g = words.findIndex((x, k) => k > at && (GIT.test(unq(x)) || SHELL.test(unq(x))))
        if (g > 0) { at = g; break }
        wrapped = true; at++
      }
      else break
    }
    const head = unq(words[at] ?? '')
    // cd / pushd / Set-Location moves the tree the git commands after it act on.
    if (/^(cd|pushd|chdir|set-location|sl|push-location)$/i.test(head)) {
      let a = at + 1
      while (a < words.length && /^--?[a-zA-Z-]*$/.test(unq(words[a]!)) && unq(words[a]!) !== '-') a++
      cur = a < words.length && unq(words[a]!) !== '-' ? resolveDir(cur, unq(words[a]!)) : '?'
      continue
    }
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
    // GIT_CONFIG_* in front of git sets config out of sight: hooksPath, gpgsign, aliases.
    let dir = cur
    if (words.slice(0, at).some((w) => /^GIT_(DIR|WORK_TREE)=/.test(w))) dir = '?'
    if (!via && words.slice(0, at).some((w) => ENV_CONFIG.test(w))) out.push({ sub: '-c env', dir })
    let i = at + 1
    if (via) { if (!VIA_GUARDED.test(unq(words[i] ?? ''))) continue }
    else {
      while (i < words.length && unq(words[i]!).startsWith('-')) {
        const o = unq(words[i]!)
        if (o === '-C' && i + 1 < words.length) dir = resolveDir(dir, unq(words[i + 1]!))
        else if (/^--(git-dir|work-tree)/.test(o)) dir = '?'
        i += GLOBAL_WITH_VALUE.test(o) ? 2 : 1
      }
      // Global options are not part of the subcommand line; the two that hide or add a stash are read here.
      const glob = words.slice(at + 1, i).map(arg).join(' ')
      if (new RegExp(`(^|\\s)(-c\\s*|--config-env[=\\s])${ci('alias.')}`).test(glob)) out.push({ sub: '-c alias', dir })
      if (/^(pull|rebase|merge)$/.test(unq(words[i] ?? '')) && new RegExp(`(^|\\s)-c\\s*(${ci('rebase')}|${ci('merge')})${ci('.autostash')}(?!${FALSY})`).test(glob)) out.push({ sub: '-c autostash', dir })
      // core.hooksPath or a switched-off signing, set inline, skips the repo's hooks and signing on any subcommand.
      // Inline, hooksPath of any value is a one-off skip; gpg.program only when it is a stand-in.
      const hooks = `${ci('core.hookspath')}|${ci('gpg.program')}`, sign = `(${ci('commit')}|${ci('tag')})${ci('.gpgsign')}`
      if (new RegExp(`(^|\\s)(-c\\s*(${ci('core.hookspath')}|${ci('gpg.program')}=(${GPG_BAD}|\\u0003|)(?=\\s|$)|${sign}${FALSY})|--config-env[=\\s](${hooks}|${sign}))`).test(glob)) out.push({ sub: '-c hooks', dir })
    }
    if (i < words.length) out.push({ sub: words.slice(i).map(arg).filter(Boolean).join(' '), via, dir })
    // `git submodule foreach [--recursive] <command>` runs that command in every submodule.
    if (unq(words[i] ?? '') === 'submodule') {
      let f = words.findIndex((w, k) => k > i && unq(w) === 'foreach')
      if (f > 0) { f++; while (f < words.length && words[f]!.startsWith('-')) f++; handOn(words.slice(f)) }
    }
  }
  // shortcut: a string one shell hands another (`powershell -Command` from Bash) is lexed by the outer shell's
  // escapes; lex nested by the inner shell if that ever hides a command.
  nested.forEach((n, k) => out.push(...subcommands(n, ps, depth + 1, nestedDir[k] ?? cwd)))
  return out
}

// null = let it run, otherwise why it would destroy work. `tool` is the tool the command runs in.
// shortcut: with no tool the command is read as Bash, so a PowerShell backtick counts as a substitution
// (over-blocks) and a backtick continuation is not joined; the hook always passes it, guess only for a new caller.
export function check(cmd: string, tool = 'Bash', where: Where = {}): string | null {
  for (const { sub, via, dir } of subcommands(cmd, tool === 'PowerShell', 0, where.cwd ?? '')) {
    const name = sub.split(' ')[0]!
    const own = isPrivate(dir, where.tmp)
    if (!via && name.startsWith('$')) return `git ${name}: ${VARIABLE}`
    // shortcut: a bare `$var` before a guarded subcommand word is read as git, so `$pkg restore` is refused too.
    for (const [rule, why, discard] of RULES) if (!(own && discard) && (typeof rule === 'function' ? rule(sub) : rule.test(sub))) return via ? `${via} ${name}: ${VARIABLE}` : `git ${name}: ${why}`
  }
  return null
}
// Worth lexing: names git, or holds a variable that may stand in for it.
const MAYBE = /\bgit\b|\$/i

// What a shell call is told, or null to let it run.
export function denial(command: string, off: boolean, tool = 'Bash', where: Where = {}): string | null {
  if (off || !MAYBE.test(command)) return null
  const why = check(command, tool, where)
  // No command is named as a way round: a discard by another route (`git show HEAD:f > f`) loses the same work.
  return why && `Blocked by makarasty-tools git-guard: ${why}. It is refused because it cannot be undone and other chats' uncommitted work may share this tree. ` +
    'Safe ways: commit your own change or copy the file aside first; undo your own edit by changing only the lines you edited; ' +
    'ask the user; or ask them to run it themselves with `!`. A discard in your own `.claude/worktrees/` worktree or a temp clone is not guarded. ' +
    'MAKARASTY_GIT_GUARD=off turns this off.'
}

export const register: Register = on => {
  on('tool.call', { tool: /^(Bash|PowerShell)$/ }, async ($, e, next) => {
    const command = e.tool === 'Bash' || e.tool === 'PowerShell' ? e.command : ''
    const off = (await $.env.get('MAKARASTY_GIT_GUARD')) === 'off'
    let deny = MAYBE.test(command) && denial(command, off, e.tool)
    // Only a refused command needs to know whether its tree is private.
    if (deny) {
      const tmp = [await $.env.get('TMPDIR'), await $.env.get('TEMP'), await $.env.get('TMP')].filter((t): t is string => !!t)
      deny = denial(command, off, e.tool, { cwd: await $.session.cwd(), tmp })
    }
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => next(e))
}
