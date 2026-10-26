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
  expect(check('git worktree remove x')).toContain('/makarasty-tools:prune')
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
  expect(['git checkout main', 'git checkout -b feat main', 'git checkout -B feat origin/feat', 'git switch -C x origin/main', 'git checkout --orphan gh-pages main',
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

// History and object store rewrites.
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

// Review round 7: quoted and abbreviated flags, path-like checkouts, remote deletes, branch overwrites, stash by another name.
const ROUND7_BLOCK = ['git reset "--hard"', "git reset '--hard' HEAD~1", 'git clean "-fd"', 'git push "--force"', 'git push origin "+main"', 'git "-C" . stash',
  "git st''ash", 'git "st"ash', 'git reset --har', 'git reset --ha', 'git reset --mer', 'git reset --kee', 'git clean --for', 'git clean --forc', 'git checkout --forc main',
  'git switch --discard main', 'git apply --rev p.patch',
  'git checkout src/', 'git checkout ./', 'git checkout "."', 'git checkout :/', 'git checkout ../x', 'git checkout *', 'git checkout --ours a.ts', 'git checkout --theirs a.ts',
  'git push origin --delete main', 'git push -d origin x', 'git push origin :main', 'git push --mirror', 'git push --prune', 'git push --dele origin x',
  'git branch -f main HEAD~5', 'git branch --force main HEAD~5', 'git branch -M a b', 'git branch -C a b', 'git branch -fm a b',
  'git pull --autostash', 'git rebase --autostash main', 'git merge --autostash x', 'git pull --autos', 'git -c rebase.autoStash=true pull', 'git -c merge.autostash=true merge x',
  'git reflog delete HEAD@{0}', 'git gc --prune=all', 'git gc --prune now', 'git gc --prune=now', 'git prune', 'git prune --expire now',
  'git --attr-source HEAD stash', 'git --config-env a=B stash', 'git --super-prefix x/ stash',
  'git -c alias.x="reset --hard" x', 'git -calias.x=stash x', 'git --config-env alias.x=V x', 'git config alias.nuke "reset --hard"', 'git config --global alias.co checkout',
  'wsl git stash', 'wsl -e git stash', 'wsl.exe bash -c "git stash"', 'doas git stash', 'runuser -u x git stash', 'flock x git stash', 'taskset 1 git stash',
  'strace git stash', 'chronic git stash', 'su -c "git stash"', 'env -S "git stash"']
const ROUND7_ALLOW = ['git checkout main', 'git checkout feature/x', 'git checkout origin/main', 'git checkout -b x', 'git switch -c x', 'git push origin main',
  'git push --force-with-lease', 'git push --force-with-lease=main:abc origin main', 'git push --force-if-includes', 'git push -u origin feat', 'git push origin HEAD:main',
  'git pull --rebase', 'git pull --no-autostash', 'git rebase main', 'git rebase --abort', 'git branch -d merged', 'git branch --list', 'git branch --set-upstream-to=origin/x',
  'git config user.name x', 'git config --get alias.co', 'git config --get-regexp ^alias', 'git config --global user.email a@b.c', 'git gc', 'git gc --auto',
  'git prune --dry-run', 'git prune -n', 'git reflog show', 'git reset --soft HEAD~1', 'git reset --mixed', 'git -c core.x=y status', 'git -c rebase.autoStash=false pull',
  'git -C . status', 'git "-C" . status', 'git --attr-source HEAD status', 'git commit -m "git reset --hard"', 'git commit -m "git push --force origin :main"',
  'wsl ls', 'doas ls', 'su -c "ls"', 'env -S "git status"', 'flock x ls', 'git log --format="%H --hard"']

test('quoted and abbreviated flags, path checkouts, remote deletes and branch overwrites are refused; their safe forms are not', () => {
  expect(ROUND7_BLOCK.filter((c) => !check(c))).toEqual([])
  expect(ROUND7_ALLOW.filter((c) => check(c))).toEqual([])
  expect(check('git -c alias.x="reset --hard" x')).toContain('hide the real subcommand')
  expect(check('git config alias.x stash')).toContain('hide the real subcommand')
})

// Review round 8: option values are not flags, config keys ignore case, hooks and signing stay on.
test('a value after a long option is not read as a flag, and config keys match without case', () => {
  expect(['git branch --sort -refname', 'git branch --sort=-refname', 'git branch --format -x', 'git branch --format=%(refname)', 'git branch --contains HEAD',
    'git branch --merged main', 'git branch --no-merged main', 'git branch --points-at HEAD', 'git branch --color=always', 'git branch --column',
    'git branch -u origin/x', 'git branch --set-upstream-to origin/x', 'git branch -vv --sort -committerdate'].filter((c) => check(c))).toEqual([])
  expect(['git branch --sort -refname -D old', 'git branch -u origin/x -f x', 'git -c Alias.x="reset --hard" x', 'git -c ALIAS.x=stash x', 'git config Alias.x stash',
    'git -c Rebase.AutoStash=true pull', 'git --config-env Alias.x=V x'].filter((c) => !check(c))).toEqual([])
  expect(['git -C alias.d status', 'git -C Alias.d log'].filter((c) => check(c))).toEqual([])
})

test('skipping hooks or signing is refused, the reads and unrelated -n are not', () => {
  expect(['git commit --no-verify -m x', 'git commit -n -m x', 'git commit -nm "x"', 'git commit -anm x', 'git commit -m x -n', 'git commit --no-ver -m x',
    'git push --no-verify', 'git merge --no-verify x', 'git am --no-verify p.mbox', 'git am -n p.mbox', 'git rebase --no-verify main',
    'git commit --no-gpg-sign -m x', 'git merge --no-gpg-sign x', 'git rebase --no-gpg-sign main', 'git cherry-pick --no-gpg-sign x', 'git tag --no-gpg-sign v1',
    'git -c core.hooksPath=/dev/null commit -m x', 'git -c core.hookspath=x status', 'git -c commit.gpgsign=false commit -m x', 'git -c Commit.GpgSign=no commit -m x',
    'git --config-env core.hooksPath=V commit -m x', 'git --config-env=commit.gpgsign=V commit -m x'].filter((c) => !check(c))).toEqual([])
  expect(check('git commit --no-verify -m x')).toContain('run it themselves with `!`')
  expect(['git commit -m "--no-verify mentioned"', 'git commit -m "-n"', 'git commit -am x', 'git commit -m x --amend', 'git commit --dry-run', 'git log -n 5', 'git rev-list -n 1 HEAD',
    'git config core.hooksPath', 'git config --get core.hooksPath', 'git -c core.autocrlf=false commit -m x', 'git -c commit.gpgsign=true commit -m x',
    'git push -n', 'git push --dry-run', 'git merge -n x', 'git rebase -n main', 'git cherry-pick -n x', 'git revert -n x', 'git clean -n', 'git rm -n a.ts',
    'git add -n .', 'git mv -n a b', 'git prune -n', 'git commit -S -m x', 'git tag -s v1'].filter((c) => check(c))).toEqual([])
})

// Review round 9 (red team): a message glued to -m is not -n, nothing after `--` is a flag, config reads stay reads.
test('a short cluster stops at its value, and nothing after -- is a flag', () => {
  expect(['git commit -m"init"', "git commit -m'init'", 'git commit -minit', 'git commit -am"init"', 'git commit -am x', 'git commit -m x -uno', 'git commit -uno -m x',
    'git commit -m x -- -n', 'git commit -m x -- --no-verify', 'git commit -m "x" -S', 'git am -p1 p.mbox', 'git commit -C HEAD', 'git commit -F -n.txt',
    'git commit -m --no-verify', 'git commit --message -n', 'git commit --message "-n"', 'git commit --author "A <a@b.c>" -m x', 'git pull -n', 'git pull --no-stat'].filter((c) => check(c))).toEqual([])
  expect(['git commit -nm"init"', 'git commit -anm x', 'git commit -n -m x', 'git commit -m x -n', 'git commit -qn', 'git am -qn p.mbox', 'git commit -m x --no-verify',
    'git pull --no-verify', 'git pull --no-gpg-sign', 'git revert --no-gpg-sign x'].filter((c) => !check(c))).toEqual([])
})

test('git config alias and hook writes are refused, reads and other keys are not', () => {
  expect(['git config alias.co', 'git config user.name alias.foo', 'git config --global core.hooksPath', 'git config --get alias.co', 'git config get alias.co',
    'git config --unset alias.co', 'git config --list', 'git config --global --get commit.gpgsign', 'git config commit.gpgsign',
    'git config commit.gpgsign true', 'git config --global commit.gpgsign true', 'git config -f x.cfg user.name y'].filter((c) => check(c))).toEqual([])
  expect(['git config alias.co checkout', 'git config --global alias.x "reset --hard"', 'git config --add alias.x y', 'git config set alias.x y',
    'git config --global core.hooksPath /dev/null', 'git config --local core.hookspath /x', 'git config --system CORE.HOOKSPATH NUL', 'git config --worktree core.hooksPath /dev/null',
    'git config commit.gpgsign false', 'git config --global tag.gpgsign no', 'git config commit.gpgSign OFF', 'git config gpg.program true'].filter((c) => !check(c))).toEqual([])
})

test('inline config is read without case or spelling tricks, env config is refused', () => {
  expect(['git -c commit.gpgsign=FALSE commit -m x', 'git -c commit.gpgsign=No commit -m x', 'git -c commit.gpgsign=0 commit -m x', 'git -c commit.gpgsign= commit -m x',
    'git -c gpg.program=true commit -m x', 'git -c GPG.Program=True tag v1', 'git -c rebase.autostash=TRUE pull',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x', "GIT_CONFIG_PARAMETERS=\"'core.hooksPath=x'\" git commit -m x",
    'env GIT_CONFIG_COUNT=1 git status'].filter((c) => !check(c))).toEqual([])
  expect(['git -c commit.gpgsign=true commit -m x', 'git -c rebase.autostash=false pull', 'git -c rebase.autostash=OFF pull', 'git -c rebase.autostash= pull', 'FOO=1 git status'].filter((c) => check(c))).toEqual([])
})

test('rm, read-tree and gc are refused by abbreviated and dated flags', () => {
  expect(['git rm --forc a.ts', 'git rm --fo a.ts', 'git read-tree --res HEAD', 'git gc --prune=NOW', 'git gc --prune=0', 'git gc --prune=1.hour.ago', 'git gc --prune=3.days.ago', 'git gc --prune=all']
    .filter((c) => !check(c))).toEqual([])
  expect(['git rm --cach a.ts', 'git rm --cached -f a.ts', 'git gc', 'git gc --prune', 'git gc --no-prune', 'git read-tree HEAD'].filter((c) => check(c))).toEqual([])
})

// Review round 10 (red team, false blocks): rename of the current branch, -qb, other tools' subcommand words, git's default prune age, hooks setup.
test('everyday setups pass: first-push rename, clustered -b, other tools behind a variable, default gc age, relative hooksPath', () => {
  expect(['git branch -M main', 'git branch -m main', 'git init && git add . && git commit -m init && git branch -M main',
    'git checkout -qb feature origin/main', 'git checkout -tb feat origin/feat', 'git checkout -b feat',
    '$DOTNET restore', '"$DOTNET" restore', '$NUGET restore', '$SVN checkout url dir', '$MAKE clean -f build.mk', '$G apply p.patch', '$G branch -D x',
    'git gc --aggressive --prune=2.weeks.ago', 'git gc --prune=1.month.ago', 'git gc --prune=2.years.ago', 'git gc --prune=2020-01-01', 'git gc --prune', 'git gc --no-prune',
    'git config core.hooksPath .husky', 'git config core.hooksPath .githooks', 'git config --local core.hooksPath tools/hooks', 'git config --global core.hooksPath hooks',
    "git config --global gpg.program 'C:/Program Files/Git/usr/bin/gpg.exe'", 'git config gpg.program gpg2', 'git config gpg.program /usr/bin/gpg',
    "git -c gpg.program='C:/Program Files/Git/usr/bin/gpg.exe' commit -S -m x", 'git -c gpg.program=gpg2 tag -s v1'].filter((c) => check(c))).toEqual([])
  expect(['git branch -M a b', 'git branch -C a b', 'git branch -f main HEAD~5', 'git branch -D x', 'git branch -Mf main', '$g stash', '$g reset --hard',
    'git gc --prune=NOW', 'git gc --prune=0', 'git gc --prune=1.hour.ago', 'git gc --prune=3.days.ago', 'git gc --prune=yesterday', 'git gc --prune now', 'git gc --prune=ALL',
    'git config core.hooksPath ""', 'git config core.hooksPath /dev/null', 'git config core.hooksPath NUL', 'git config core.hooksPath nul', 'git config --global core.hooksPath /opt/hooks',
    'git config core.hooksPath C:/hooks', 'git config alias.x stash', 'git -c core.hooksPath=.husky commit -m x', 'git -c core.hooksPath=/dev/null commit -m x',
    'git config gpg.program true', 'git config gpg.program false', 'git config gpg.program :', 'git config gpg.program echo', 'git config gpg.program cat',
    'git config gpg.program /bin/true', 'git config gpg.program /usr/bin/true', 'git -c gpg.program=true commit -m x', 'git -c gpg.program=/bin/true commit -S -m x',
    'git -c gpg.program=: tag -s v1'].filter((c) => !check(c))).toEqual([])
})

// Review round 11: a discard in a private tree (own worktree, temp clone) runs; the rest is refused in every tree.
const MAIN = { cwd: 'C:/Users/mky/Desktop/LiveProjects/app' }
const WT = { cwd: 'C:\\Users\\mky\\Desktop\\LiveProjects\\app\\.claude\\worktrees\\fleet-1' }
const TMP = { cwd: 'C:\\Users\\mky\\AppData\\Local\\Temp\\claude\\essp', tmp: ['C:\\Users\\mky\\AppData\\Local\\Temp'] }
test('a discard in a private tree runs, the same in the shared tree and every non-discard rule do not', () => {
  expect(['cd C:/x/.claude/worktrees/fleet-1 && git checkout -- a.ts', 'git -C /tmp/clone reset --hard', 'cd "C:/x/.claude/worktrees/fleet-1/frontend"; git checkout --ours -- a.ts',
    'cd /tmp/llwt-rost || exit 1; git checkout --ours -- docs/a.md', 'cd /c/Users/mky/AppData/Local/Temp/claude/essp && git stash', 'pushd .claude/worktrees/w && git clean -fd',
    'Set-Location C:\\x\\.claude\\worktrees\\w; git restore .', 'cd $TMPDIR/c && git reset --hard', 'cd /x/.claude/worktrees/w && bash -c "git reset --hard"',
    'cd /x/.claude/worktrees/w && git rm -f a.ts && git apply -R p.patch && git pull --autostash',
    'cd /x/.claude/worktrees/w/sub && cd .. && git stash', 'git -C /x/.claude/worktrees/w stash', 'git -C /tmp/a -C ../b reset --hard'].filter((c) => check(c))).toEqual([])
  expect(['cd /x/main && git checkout -- a.ts', 'git -C /x/main reset --hard', 'git -C /tmp reset --hard', 'cd /tmp && git stash', 'cd /x/.claude/worktrees/w && cd ../.. && git stash',
    'cd /tmp/c && git -C /x/main reset --hard', 'cd /tmp/c && cd /x/main && git stash', 'cd /tmp/c/../../x/main && git stash', 'cd "$P" && git reset --hard', 'cd - && git stash',
    'cd /x/.claude/worktrees && git stash', 'GIT_DIR=/x/main/.git git reset --hard', 'git --work-tree=/x/main reset --hard', 'git stash'].filter((c) => !check(c))).toEqual([])
  expect(['cd .claude/worktrees/w && git worktree remove .', 'cd /tmp/c && git commit --no-verify -m x', 'cd /tmp/c && git commit -nm x', 'cd /tmp/c && git push --force',
    'cd /tmp/c && git push origin :main', 'cd /tmp/c && git branch -D x', 'cd /tmp/c && git filter-branch -f x', 'cd /tmp/c && git reflog expire --all', 'cd /tmp/c && git update-ref -d refs/x',
    'cd /tmp/c && git gc --prune=now', 'cd /tmp/c && git -c core.hooksPath=/dev/null commit -m x', 'cd /tmp/c && git config alias.x stash', 'cd /tmp/c && git read-tree --reset HEAD',
    'GIT_CONFIG_COUNT=1 git -C /tmp/c status', 'cd /tmp/c && git commit --no-gpg-sign -m x'].filter((c) => !check(c))).toEqual([])
})

test('the session directory decides when no cd or -C names the tree', () => {
  expect(['git stash', 'git reset --hard', 'git checkout -- a.ts', 'git clean -fd', 'git restore .'].filter((c) => check(c, 'Bash', WT))).toEqual([])
  expect(['git stash', 'git reset --hard'].filter((c) => check(c, 'Bash', TMP))).toEqual([])
  expect(check('cd /c/Users/mky/AppData/Local/Temp/claude/x && git stash', 'Bash', MAIN)).toBeNull()
  expect(check('cd C:/Users/mky/AppData/Local/Temp/claude/x && git stash', 'Bash', { cwd: '/x', tmp: [] })).toBeNull()
  expect(check('git stash', 'Bash', { cwd: '/x/y', tmp: ['/var/t'] })).toContain('stash')
  expect(check('cd /var/t/c && git stash', 'Bash', { cwd: '/x/y', tmp: ['/var/t'] })).toBeNull()
  expect(['git stash', 'git reset --hard', 'git checkout -- a.ts', 'git push --force', 'git worktree remove x', 'git commit --no-verify -m x'].filter((c) => !check(c, 'Bash', MAIN))).toEqual([])
  expect(['git push --force', 'git worktree remove x', 'git commit --no-verify -m x', 'git branch -D x'].filter((c) => !check(c, 'Bash', WT))).toEqual([])
})

test('the refusal says why and names no other way to discard', () => {
  const m = denial('git checkout -- a.ts', false, 'Bash', MAIN)!
  expect(m).toContain("other chats' uncommitted work")
  expect(m).toContain('ask them to run it themselves with `!`')
  expect(m).toContain('copy the file aside')
  expect(m.includes('git show') || m.includes('HEAD:')).toEqual(false)
  expect(denial('git checkout -- a.ts', false, 'Bash', WT)).toBeNull()
  expect(denial('git push --force', false, 'Bash', WT)).toContain('git push')
})
