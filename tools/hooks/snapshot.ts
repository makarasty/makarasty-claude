import type { Register } from 'claude-code'

// Saves the project's uncommitted files before a shell line that may overwrite or delete what no guard can read: `> file`,
// `mv`, `cp`, `sed -i`, `Set-Content`, an interpreter's code, a delete delete-guard let through. Several chats share one
// checkout, so a line meant for one file can take another chat's unsaved work; committed files git already keeps.
// What is saved: changed tracked files and the untracked ones .gitignore lets in, each under 20 MB, as one commit on
// refs/makarasty/snapshot (one reflog entry per save; a save equal to the last one is skipped). Nothing the person works
// with moves: a temporary index, the real index, branches, stash and working tree untouched, and GIT_OPTIONAL_LOCKS=0 so
// no lock another chat's git could trip on. A clean tree or a folder outside git saves nothing. gc drops entries after 30
// days (the reflog expiry of an unreachable entry). A failure or a timeout lets the call run: the save is a second chance,
// the guards are the first.
// Restore: `git log -g --format="%h %cr %gs" refs/makarasty/snapshot` lists the saves, newest first, each named by the
// line it ran before; `git show <hash>:<path> > <path>` brings a file back; `git diff <hash> -- <path>` shows the change.
// Not saved: ignored files (.env, build output; their content may be secrets, and a ref is pushed by `push --mirror`),
// files outside the project, a line this trigger does not read (a GUI, a script started by another script).

// A truncating redirect to a real file: `>`, `>|`, `2>`, not `>>`, `>&2`, `=>`, `->`, `>/dev/null`, `> $null`, `>nul`.
const REDIRECT = /(?<![<>=&|\d-])\d?>\|?(?![>&])(?!\s*(?:\/dev\/null|\$null|nul)(?![\w./\\-]))/i
// Commands that move, copy over, edit in place, truncate or delete; git that rewrites files; inline interpreter code and
// scripts, which may do any of these.
const WRITES = new RegExp([
  String.raw`\b(rm|rmdir|rd|del|erase|unlink|shred|truncate|mv|move|cp|copy|xcopy|robocopy|rsync|dd|tee|ln|rimraf|del-cli|trash|unzip|patch)\b`,
  String.raw`\bsed\s+(-[\w-]+\s+)*-[a-zA-Z]*i`, String.raw`\bperl\s+-[a-zA-Z]*i`, String.raw`\btar\s+-?[a-zA-Z]*x`,
  String.raw`\b(Remove-Item|ri|Move-Item|mi|Copy-Item|cpi|Rename-Item|rni|Set-Content|sc|Out-File|Clear-Content|clc|Expand-Archive)\b`,
  String.raw`\bNew-Item\b[^\n;|]*-Force`, String.raw`::(Delete|Move|Copy|WriteAll\w*)\(`,
  String.raw`\bgit\b[^;&|\n]*?\s(checkout|restore|reset|clean|stash|switch|rm|mv|apply|am|merge|rebase|pull|cherry-pick|revert|read-tree|checkout-index)\b`,
  String.raw`\b(python[\d.]*|py|pypy[\d.]*|node|nodejs|bun|deno|perl|ruby|php)(\.exe)?\s+(-\S+\s+)*(-[a-zA-Z]*[ce]|--eval|eval)\s`,
  String.raw`\b(python[\d.]*|py|node|bun|deno|perl|ruby|bash|sh|pwsh|powershell)(\.exe)?\s+(-\S+\s+)*[\w./\\:-]+\.(py|m?[jt]s|cjs|pl|rb|sh|ps1)\b`,
  String.raw`(^|[\s;&|(])\.?\.?[\w./\\-]*\.(sh|ps1|bat|cmd)\b`, String.raw`\b(python[\d.]*|py|node|bun|deno|perl|ruby)(\.exe)?(\s+-[\w-]*)*\s*<<`,
].join('|'), 'i')

export const risky = (command: string): boolean => REDIRECT.test(command) || WRITES.test(command)

type Run = (argv: readonly string[], init?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string }>
type Stat = (path: string) => Promise<{ size: number; mtimeMs: number }>
const MAX_FILE = 20 * 1024 * 1024
const MAX_FILES = 2000
const ID = { GIT_AUTHOR_NAME: 'makarasty snapshot', GIT_AUTHOR_EMAIL: 'snapshot@localhost', GIT_COMMITTER_NAME: 'makarasty snapshot', GIT_COMMITTER_EMAIL: 'snapshot@localhost' }
// Per project: where it is, and the changed files with their size and time at the last save. Unchanged since, a line costs
// one `git status` and no save: about a third of shell lines are risky, so the common case stays one process.
const known = new Map<string, { top: string; last?: string }>()

// Saves `cwd`'s project as described above; returns the new commit, or undefined when nothing was saved.
export async function snapshot(run: Run, stat: Stat, cwd: string, index: string, label: string): Promise<string | undefined> {
  const env = { GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' }
  let k = known.get(cwd)
  if (!k) {
    const r = await run(['git', 'rev-parse', '--show-toplevel'], { cwd, env, timeoutMs: 5000 })
    if (r.exitCode) return undefined
    k = { top: r.stdout.trim() }
    known.set(cwd, k)
  }
  const git = (args: string[], more: { env?: Record<string, string>; stdin?: string } = {}) =>
    run(['git', ...args], { cwd: k!.top, timeoutMs: 5000, stdin: more.stdin, env: { ...env, ...more.env } })
  const st = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])
  if (st.exitCode || !st.stdout) return undefined
  // `XY path`: a deleted file has no stat and stays in the list, so git records the delete.
  const all = st.stdout.split('\0').filter((e) => e.length > 3).slice(0, MAX_FILES)
  const stats = await Promise.all(all.map((e) => stat(`${k!.top}/${e.slice(3)}`).catch(() => undefined)))
  // A big new file is left out rather than copied into .git; a tracked one is in git's objects already.
  const keep = all.map((e, i) => ({ e, s: stats[i] })).filter(({ e, s }) => !e.startsWith('??') || (s !== undefined && s.size <= MAX_FILE))
  if (!keep.length) return undefined
  const key = keep.map(({ e, s }) => `${e}\u0001${s?.size}\u0001${s?.mtimeMs}`).join('\0')
  if (key === k.last) return undefined
  const idx = { GIT_INDEX_FILE: index }
  if ((await git(['read-tree', 'HEAD'], { env: idx })).exitCode) return undefined // no commit yet
  if ((await git(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { env: idx, stdin: keep.map(({ e }) => e.slice(3)).join('\0') })).exitCode) return undefined
  const tree = (await git(['write-tree'], { env: idx })).stdout.trim()
  if (!tree) return undefined
  const msg = label.replace(/\s+/g, ' ').slice(0, 200)
  const c = await git(['commit-tree', tree, '-p', 'HEAD', '-m', msg], { env: ID })
  const commit = c.stdout.trim()
  if (c.exitCode || !commit) return undefined
  // Another chat saving at the same moment holds the ref's lock: its save is as fresh as this one would be.
  if ((await git(['update-ref', '--create-reflog', '-m', msg, 'refs/makarasty/snapshot', commit])).exitCode) return undefined
  k.last = key
  return commit
}

export const register: Register = on => {
  on('tool.call', { tool: /^(Bash|PowerShell|mcp__terminal__run_in_terminal)$/ }, async ($, e, next) => {
    const command = String((e as unknown as { command?: unknown }).command ?? '')
    if (!risky(command)) return next(e)
    try {
      if ((await $.env.get('MAKARASTY_SNAPSHOT')) !== 'off') {
        const tmp = (await $.env.get('TEMP')) || (await $.env.get('TMPDIR')) || (await $.env.get('TMP')) || '/tmp'
        const index = `${tmp.replace(/[\\/]$/, '')}/makarasty-snapshot-${await $.session.id()}.index`
        await snapshot((a, i) => $.process.run(a, i), (p) => $.fs.stat(p), await $.session.cwd(), index, command)
      }
    } catch {
      // A failed save must not stop the call: the guards before this one already judged it.
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
