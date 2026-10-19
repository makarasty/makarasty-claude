import { expect, test } from 'claude-code/testing'
import { check, denial } from './git-guard.ts'

const BLOCK = ['git stash', 'git stash -u', 'git stash pop', 'cd x && git stash', 'git -C ../r stash', 'git reset --hard HEAD~1',
  'git clean -fd', 'git clean --force', 'git checkout -- a.ts', 'git checkout .', 'git checkout HEAD -- a.ts', 'git checkout -f main',
  'git switch --discard-changes main', 'git switch --force x', 'git rm -rf src', 'git rm -f a.ts', 'git restore a.ts', 'git restore --staged --worktree a.ts', '& git stash', 'X=1 git stash']
const ALLOW = ['git stash list', 'git stash show -p', 'git commit -m "fix git stash bug"', 'git reset', 'git reset --soft HEAD~1',
  'git clean -n', 'git clean -nfd', 'git checkout main', 'git checkout -b feat', 'git switch main', 'git restore --staged a.ts',
  'git switch --force-create x origin/main', 'git rm -rf --cached node_modules', 'git rm --cached -f a.ts', 'echo git stash', "git commit -F - <<'EOF'\nfix: stash\ngit stash\nEOF", 'npm run test -- stash']

test('refuses every command that throws work away and none that keeps it', () => {
  expect(BLOCK.filter((c) => !check(c))).toEqual([])
  expect(ALLOW.filter((c) => check(c))).toEqual([])
})

// Each of these once returned null.
const BYPASS = ['git stash 2>&1', 'git stash > /dev/null', 'git stash >/dev/null 2>&1', 'git stash &> /dev/null', 'git stash *> $null', 'git stash < /dev/null',
  '(git stash)', 'echo $(git stash)', 'echo `git stash`', 'echo "$(git stash)"', 'git commit -m "$(git stash)"', '{ git stash; }',
  'bash -c "git stash"', "sh -c 'git reset --hard'", 'bash -lc "cd x && git stash"', 'zsh -c "git stash"', 'cmd /c "git stash"',
  'powershell -Command "git stash"', 'eval "git stash"', "bash -c 'echo $(git stash)'", 'bash <<EOF\ngit stash\nEOF',
  'git stash & echo done', 'git stash | cat', 'env git stash', 'command git stash', 'sudo -n git stash', 'git.exe stash', '/usr/bin/git stash',
  'git --no-pager stash', 'git stash branch tmp', 'git stash push -m "x"', 'git stash -- a.ts', 'git stash;']
// Rules added with the bypass fix.
const NEW_BLOCK = ['git worktree remove ../wt', 'git worktree remove --force ../wt', 'git -C r worktree remove x',
  'git push --force', 'git push -f origin main', 'git push origin main --force', 'git push -fu origin main', 'git push origin +main', 'git push origin +HEAD:main',
  'git branch -D old', 'git branch -Df old', 'git branch --delete --force old', 'git branch -d -f old', 'git branch -fd old']
const NEW_ALLOW = ['git push', 'git push -u origin feat', 'git push --force-with-lease', 'git push --force-with-lease origin main',
  'git push origin feature-fix', 'git push --set-upstream origin x', 'git branch -d merged', 'git branch --delete merged', 'git branch', 'git branch -a',
  'git worktree add ../wt', 'git worktree list', 'git worktree prune', 'git stash list 2>&1', 'git stash show > out.txt',
  'git log > out.txt', 'git log --oneline 2>&1 | head', 'git commit -m "undo git reset --hard"', 'git commit -m "git stash and git push --force"',
  "git commit -m 'git branch -D x'", 'git commit -m "msg" && git log', 'echo "git stash"', "echo 'git reset --hard'", 'bash -c "echo git stash"',
  'bash -c "git status"', 'bash script.sh', 'sh -c "ls"', 'echo $(git rev-parse HEAD)', 'echo `git log -1`', '(git status)', 'git diff HEAD^ > x.patch',
  'bash <<EOF\ngit status\nEOF', "git commit -F - <<'EOF'\nbash -c 'git stash'\nEOF", 'git add -A && git commit -m "wip" 2>&1']

test('every redirection, subshell, nested shell and wrapper bypass is refused', () => {
  expect(BYPASS.filter((c) => !check(c))).toEqual([])
})

test('worktree remove, plain force push and branch -D are refused, with the reason', () => {
  expect(NEW_BLOCK.filter((c) => !check(c))).toEqual([])
  expect(check('git worktree remove x')).toContain('fleet.sh clean')
  expect(check('git worktree remove x')).toContain('unlink reparse points')
  expect(check('git push -f')).toContain('--force-with-lease')
  expect(check('git branch -D x')).toContain('unmerged')
})

test('reads, safe pushes and quoted text that merely names a command are not refused', () => {
  expect(NEW_ALLOW.filter((c) => check(c))).toEqual([])
})

// Red team round: line continuations, PowerShell's backtick, heredocs fed to a script, tree-ish checkouts.
test('a line continuation does not split a command in two', () => {
  expect(check('git checkout `\n -- .', 'PowerShell')).toContain('checkout')
  expect(check('git reset `\r\n --hard', 'PowerShell')).toContain('reset')
  expect(check('git reset \\\n --hard')).toContain('reset')
  expect(denial('git reset `\n --hard', false, 'PowerShell')).toContain('git reset')
})

test("in PowerShell a backtick is an escape, in Bash it is still code", () => {
  expect(check('git commit -m "explain `git stash` danger"', 'PowerShell')).toBeNull()
  expect(check('git -C "C:\\repo\\" status', 'PowerShell')).toBeNull()
  expect(check('git commit -m "a `" quote" ; git stash', 'PowerShell')).toContain('stash')
  expect(check('git commit -m "$(git stash)"', 'PowerShell')).toContain('stash')
  expect(check('git commit -m "explain `git stash` danger"', 'Bash')).toContain('stash')
})

test("only a heredoc on a shell's own stdin is code", () => {
  expect(check(`sh "$f" ask --why x <<'EOF'\nplease\ngit stash first\nEOF`)).toBeNull()
  expect(check(`bash ./x.sh <<EOF\ngit stash\nEOF`)).toBeNull()
  expect(check(`fleet.sh <<EOF\ngit stash\nEOF`)).toBeNull()
  expect(check(`bash -s <<'EOF'\ngit stash\nEOF`)).toContain('stash')
  expect(check(`cd x && /bin/sh <<EOF\ngit reset --hard\nEOF`)).toContain('reset')
})

test('checkout of a tree-ish and a path is refused, one bare name is not', () => {
  expect(['git checkout HEAD src/a.ts', 'git checkout HEAD~1 a.ts b.ts', 'git checkout main "my file.ts"'].filter((c) => !check(c))).toEqual([])
  expect(check('git checkout HEAD a.ts')).toContain('<tree-ish> <path>')
  expect(['git checkout main', 'git checkout -b feat main', 'git checkout -B feat origin/feat', 'git checkout --orphan gh-pages main',
    'git checkout --track origin/x', 'git checkout -'].filter((c) => check(c))).toEqual([])
})

test('a destroying call is told why, any other call and an opted-out guard are not', () => {
  expect(denial('cd x && git stash', false)).toContain('git stash')
  expect(denial('git status', false)).toBeNull()
  expect(denial('npm test', false)).toBeNull()
  expect(denial('git stash', true)).toBeNull()
  expect(denial('bash -c "git stash" 2>&1', false)).toContain('git stash')
  expect(denial('git push --force', false)).toContain('git push')
})

test('a quoted git binary is still git', () => {
  expect(check('"git" stash')).toContain('git stash')
  expect(check("'git' reset --hard")).toContain('git reset')
  expect(check('& "C:\\Program Files\\Git\\cmd\\git.exe" stash', 'PowerShell')).toContain('git stash')
  expect(check('"/usr/bin/git" stash')).toContain('git stash')
  expect(check('git "stash"')).toContain('git stash')
  expect(check('$null = git stash', 'PowerShell')).toContain('git stash')
  expect(check('& "C:\\Program Files\\Git\\cmd\\git.exe" status', 'PowerShell')).toBeNull()
})

// From dcg (Dicklesworthstone/destructive_command_guard).
test('history and object store rewrites are refused, their read-only forms are not', () => {
  expect(['git filter-branch --tree-filter x HEAD', 'git reflog expire --expire=now --all', 'git update-ref -d refs/heads/x',
    'git read-tree --reset HEAD', 'git read-tree -u --reset HEAD', 'git rm -f a.ts', 'git rm --force a.ts', 'git rm -rf dir',
    'git gc --prune=now', 'git gc --aggressive --prune=now'].filter((c) => !check(c))).toEqual([])
  expect(check('git rm -f a.ts')).toContain('uncommitted')
  expect(['git rm a.ts', 'git rm -r dir', 'git rm --cached x', 'git reflog', 'git reflog show', 'git gc', 'git gc --auto',
    'git update-ref refs/heads/x HEAD', 'git read-tree HEAD'].filter((c) => check(c))).toEqual([])
})

test('a variable in place of git or its subcommand fails closed', () => {
  expect(check('git $x')).toContain('variable')
  expect(check('git "$x" -f')).toContain('variable')
  expect(check('$g stash')).toContain('variable')
  expect(check('& $g reset --hard', 'PowerShell')).toContain('variable')
  expect(denial('$g stash', false)).toContain('variable')
  expect(check('$g stash')).toContain('variable')
  expect(check("git stash list | Where-Object { $_ -match 'stash' }", 'PowerShell')).toBeNull()
  expect(check('& "$env:ProgramFiles\\dotnet\\dotnet.exe" restore', 'PowerShell')).toBeNull()
  expect(check('"$DOCKER" rm -f web')).toBeNull()
  expect(['$g status', 'git log $sha', 'git checkout $branch', 'echo $x', '"$f" clean .fleet/r1 --remove', '"$f" worktree "$r" 01',
    '$env:X = "1"; npm test'].filter((c) => check(c, c.startsWith('$env') ? 'PowerShell' : 'Bash'))).toEqual([])
})

// Review round: a shell keyword or a glued brace once hid git, and PowerShell's eval went unread.
test('git behind a shell keyword, inside a block or in Invoke-Expression is still git', () => {
  expect(['for f in $(git diff --name-only); do git checkout -- "$f"; done', 'if git diff --quiet; then echo ok; else git stash; fi',
    'while read f; do git restore "$f"; done < list', 'until git stash; do sleep 1; done', 'if true; then git reset --hard; fi',
    'time git stash', '! git stash'].filter((c) => !check(c))).toEqual([])
  expect(['foreach ($f in $x) {git stash}', 'foreach ($f in $x) { git stash }', 'if ($y) {git reset --hard}',
    'Invoke-Expression "git stash"', 'iex "git reset --hard"', 'iex \'git stash\''].filter((c) => !check(c, 'PowerShell'))).toEqual([])
  expect(['if git diff --quiet; then echo clean; fi', 'for b in a b; do git log -1 $b; done'].filter((c) => check(c))).toEqual([])
  expect(['foreach ($f in $files) { git add -- $f }', 'foreach ($b in $x) {git checkout main}', 'iex "git status"']
    .filter((c) => check(c, 'PowerShell'))).toEqual([])
})

// Review round: a block behind a cmdlet, a shell given its command unquoted, a wrapper with its own arguments.
test('git in a block, an unquoted shell command or behind a wrapper with arguments is still git', () => {
  expect(['Get-ChildItem | ForEach-Object { git checkout -- $_.Name }', '$a | % { git stash }', 'try { git stash } catch {}',
    'cmd /c git stash', 'cmd.exe /c git checkout -- .', 'powershell -Command git stash', 'pwsh -NoProfile -Command git stash']
    .filter((c) => !check(c, 'PowerShell'))).toEqual([])
  expect(['function f { git stash; }; f', 'timeout 60 git checkout -- .', 'nice -n 10 git stash', 'sudo -u bob git stash',
    'env -C /x git stash', 'watch git stash', 'coproc git stash', 'xargs -I{} git checkout -- {}', 'cmd /c git stash push -m "x"']
    .filter((c) => !check(c))).toEqual([])
  expect(['timeout 60 git status', 'cmd /c git status', 'git log --format=%H@{u}'].filter((c) => check(c))).toEqual([])
  expect(['pwsh -Command git log -1', 'Get-ChildItem | ForEach-Object { git add -- $_.Name }'].filter((c) => check(c, 'PowerShell'))).toEqual([])
})

// Review round: a reversed patch, combined short flags, a command run by find or by every submodule.
test('a reversed apply, -qf, find -exec and submodule foreach are refused', () => {
  expect(['git diff | git apply -R', 'git apply --reverse p.patch', 'git apply -R --index p.patch', 'git apply -3R p.patch',
    'git checkout -qf main', 'git checkout -fq main', 'git switch -fq main', 'git switch -qf main',
    'find . -exec git checkout -- {} \\;', 'find . -name "*.ts" -execdir git restore {} +', "find . -exec sh -c 'git stash' \\;",
    'find . -exec git checkout -- {} ;',
    'git submodule foreach git reset --hard', "git submodule foreach 'git stash'", 'git submodule foreach --recursive git clean -fd']
    .filter((c) => !check(c))).toEqual([])
  expect(check('git apply -R p.patch')).toContain('--cached')
})

// Review round 6: a reversed apply that only reads the patch changes nothing; --apply makes it write again.
test('a read-only reversed apply passes, and --apply with it is refused', () => {
  expect(['git apply -R --check x.patch', 'git apply -R --stat x.patch', 'git apply --reverse --numstat x.patch',
    'git apply -R --summary x.patch'].filter((c) => check(c))).toEqual([])
  expect(['git apply -R --check --apply x.patch', 'git apply -R --stat --apply x.patch'].filter((c) => !check(c))).toEqual([])
})

test('a cached reversed apply, a trailing -- and stash create are not refused', () => {
  expect(['git apply -R --cached p.patch', 'git apply p.patch', 'git apply --check p.patch', 'git checkout main --',
    'git checkout -q main', 'git switch -q main', 'git stash create', 'git stash create "wip"',
    'find . -exec git log -1 -- {} \\;', 'find . -name x -print', 'git submodule foreach git status', 'git submodule update --init']
    .filter((c) => check(c))).toEqual([])
})
