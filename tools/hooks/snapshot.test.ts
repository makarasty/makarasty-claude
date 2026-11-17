import { expect, mock, test } from 'claude-code/testing'
import { risky, snapshot } from './snapshot.ts'

test('risky: lines that may overwrite or delete a file, and not reads, appends or /dev/null', () => {
  const yes = ['echo x > README.md', 'cat a 2> err.log', ': > src/a.ts', 'mv a b', 'cp x src/a.ts', 'sed -i s/a/b/ f', 'sed -E -i.bak s/a/b/ f',
    'perl -pi -e s/a/b/ f', 'tar -xf a.tar', 'rm -f a.txt', 'git checkout main', 'git -C x restore a', 'git stash', 'Set-Content a.txt x',
    "'' | Out-File a.txt", 'Move-Item a b', 'New-Item -ItemType File a.txt -Force', "[IO.File]::WriteAllText('a', 'b')", 'python -c "open(1)"',
    'node -e "x"', 'node scripts/build.mjs', 'bash tools/x.sh', './deploy.sh', 'python - <<EOF\nx\nEOF', 'pwsh -File a.ps1']
  const no = ['git status', 'ls -la', 'cat a.txt', 'echo x >> log.txt', 'npm test 2>&1', 'grep x f > /dev/null', 'x 2>/dev/null',
    'Get-ChildItem > $null', 'cmd /c dir >nul', 'node --version', 'git log --oneline -5', 'a => b', 'echo "->"', 'git commit -m x']
  expect(yes.filter((c) => !risky(c))).toEqual([])
  expect(no.filter((c) => risky(c))).toEqual([])
})

type Call = { argv: readonly string[]; env?: Record<string, string>; stdin?: string; cwd?: string }
// A fake git: `status` prints what the test gives; every other call succeeds and prints a hash.
function fakeGit(status: () => string) {
  const calls: Call[] = []
  const run = async (argv: readonly string[], i: { env?: Record<string, string>; stdin?: string; cwd?: string } = {}) => {
    calls.push({ argv, ...i })
    if (argv[1] === 'rev-parse') return { exitCode: 0, stdout: '/repo\n' }
    if (argv[1] === 'status') return { exitCode: 0, stdout: status() }
    return { exitCode: 0, stdout: `${argv[1]}-hash\n` }
  }
  return { calls, run }
}

test('a clean tree saves nothing and costs one status after the first look', async () => {
  const g = fakeGit(() => '')
  expect(await snapshot(g.run, async () => ({ size: 1, mtimeMs: 1 }), '/clean', '/tmp/i', 'rm x')).toBeUndefined()
  expect(await snapshot(g.run, async () => ({ size: 1, mtimeMs: 1 }), '/clean', '/tmp/i', 'rm x')).toBeUndefined()
  expect(g.calls.map((c) => c.argv[1])).toEqual(['rev-parse', 'status', 'status'])
})

test('a dirty tree is saved through a temporary index, with no optional locks, and the same state is not saved twice', async () => {
  let mtime = 1
  const g = fakeGit(() => ' M src/a.ts\0?? new.txt\0?? big.bin\0 D gone.ts\0')
  const stat = async (p: string) => {
    if (p.endsWith('gone.ts')) throw new Error('ENOENT')
    return { size: p.endsWith('big.bin') ? 50 * 1024 * 1024 : 10, mtimeMs: mtime }
  }
  expect(await snapshot(g.run, stat, '/dirty', '/tmp/i', 'echo x > src/a.ts')).toBe('commit-tree-hash')
  const add = g.calls.find((c) => c.argv[1] === 'add')!
  // The changed, the new and the deleted file; the 50 MB new file is left out.
  expect(add.stdin!.split('\0')).toEqual(['src/a.ts', 'new.txt', 'gone.ts'])
  expect(add.env).toMatchObject({ GIT_INDEX_FILE: '/tmp/i', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' })
  expect(g.calls.every((c) => c.env?.GIT_OPTIONAL_LOCKS === '0' && c.cwd === '/repo' || c.argv[1] === 'rev-parse')).toBe(true)
  expect(g.calls.find((c) => c.argv[1] === 'update-ref')!.argv).toEqual(['git', 'update-ref', '--create-reflog', '-m', 'echo x > src/a.ts', 'refs/makarasty/snapshot', 'commit-tree-hash'])
  // Nothing changed on disk: one status, no save. A file touched again: saved again.
  const n = g.calls.length
  expect(await snapshot(g.run, stat, '/dirty', '/tmp/i', 'mv a b')).toBeUndefined()
  expect(g.calls.slice(n).map((c) => c.argv[1])).toEqual(['status'])
  mtime = 2
  expect(await snapshot(g.run, stat, '/dirty', '/tmp/i', 'mv a b')).toBe('commit-tree-hash')
})

test('outside git, or with no commit yet, nothing is saved and nothing fails', async () => {
  const none = async () => ({ exitCode: 128, stdout: '' })
  expect(await snapshot(none, async () => ({ size: 1, mtimeMs: 1 }), '/nogit', '/tmp/i', 'rm x')).toBeUndefined()
  const g = fakeGit(() => '?? a\0')
  const unborn = async (argv: readonly string[], i?: object) => (argv[1] === 'read-tree' ? { exitCode: 128, stdout: '' } : g.run(argv, i))
  expect(await snapshot(unborn, async () => ({ size: 1, mtimeMs: 1 }), '/unborn', '/tmp/i', 'rm x')).toBeUndefined()
  expect(g.calls.some((c) => c.argv[1] === 'update-ref')).toBe(false)
})

test('hook: a risky line is saved for before it runs, a safe one is not, and a failing git never blocks the call', async ($, on) => {
  const order: string[] = []
  on('tool.call', async () => { order.push('ran'); return { result: 'ok' } })
  mock.env(on, { TEMP: '/tmp' })
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/hookrepo' }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 3, mtimeMs: 7, isLink: false } }))
  let broken = false
  on('process.run', (_$, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    order.push(argv[1]!)
    if (broken) return { deny: 'spawn git ENOENT' }
    return { value: { exitCode: 0, stdout: argv[1] === 'status' ? ' M a.ts\0' : argv[1] === 'rev-parse' ? '/hookrepo\n' : 'h\n', stderr: '' } }
  })
  expect(await $.tool.call({ tool: 'Bash', command: 'git status' } as never)).toEqual({ result: 'ok' })
  expect(order).toEqual(['ran'])
  order.length = 0
  expect(await $.tool.call({ tool: 'Bash', command: 'echo x > a.ts' } as never)).toEqual({ result: 'ok' })
  expect(order).toEqual(['rev-parse', 'status', 'read-tree', 'add', 'write-tree', 'commit-tree', 'update-ref', 'ran'])
  broken = true
  order.length = 0
  expect(await $.tool.call({ tool: 'PowerShell', command: 'Set-Content b.ts x' } as never)).toEqual({ result: 'ok' })
  expect(order.at(-1)).toBe('ran')
})
