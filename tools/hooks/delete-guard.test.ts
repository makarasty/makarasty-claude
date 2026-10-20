import { expect, test } from 'claude-code/testing'
import { check, denial, type Env } from './delete-guard.ts'

const WIN: Env = { cwd: 'C:\\Users\\dev\\proj', home: 'C:\\Users\\dev', tmp: 'C:\\Users\\dev\\AppData\\Local\\Temp' }
const NIX: Env = { cwd: '/home/dev/proj', home: '/home/dev', tmp: '/tmp' }
const DEEP: Env = { ...WIN, cwd: 'C:\\Users\\dev\\work\\proj' }
const enc = (s: string): string => btoa([...s].map((c) => `${c}\0`).join(''))

// Every one of these deletes more than a named folder inside the project.
const BLOCK = ['rm -rf .', 'rm -rf ./', 'rm -rf ..', 'rm -rf ../x', 'rm -rf *', 'rm -rf ./*', 'rm -rf .*', 'rm -rf ~', 'rm -rf ~/', 'rm -rf ~/*',
  'rm -rf $HOME', 'rm -rf "$HOME"', 'rm -rf ${HOME}/x', 'rm -rf /', 'rm -rf /*', 'rm -rf .git', 'rm -rf ./.git/',
  'rm -rf src/../..', 'rm -R .', 'rm --recursive .', 'rm --rec .', 'rm -fr .', 'rm "-rf" .', "rm '-rf' ..", 'rm -r -f ..', 'rm -rf -- ..',
  'rm -rf dist ..', 'rm -rf node_modules ..', 'sudo rm -rf /', 'env rm -rf ..', 'timeout 5 rm -rf ..', '/bin/rm -rf ..', 'rm -rf .. 2>/dev/null',
  'bash -c "rm -rf .."', "sh -c 'cd x && rm -rf ~'", 'cd ..; rm -rf .','echo $(rm -rf ..)', 'echo "$(rm -rf ..)"', 'eval "rm -rf .."',
  'if true; then rm -rf ..; fi', 'bash <<EOF\nrm -rf ..\nEOF', 'rm -rf \\\n ..', 'X=1 rm -rf ..',
  'powershell -Command "Remove-Item -Recurse -Force .."', 'pwsh -c "ri -r ~"',
  'rm -rf "$TMPDIR"', 'rm -rf $TMPDIR/*', 'rm -rf ${TMPDIR:-/tmp}',
  ,
  'find . -delete', 'find / -name x -delete', 'find . -exec rm -rf {} \\;',
  'find . -execdir rm {} +', 'find -delete', 'find .git -delete', 'rmdir /s /q ..', 'del /s /q *']
const BLOCK2 = [
  // 2: a user variable in the same name as an OS one, bare, is still a computed path; the OS ones are exact-case in Bash
  'rm -rf $TMPDIR', 'rm -rf $HOME/x',
  // 4: unnarrowed finds at temp and home
  'find /tmp -delete', 'find "$TMPDIR" -delete', 'find ~ -delete', 'find $HOME -type f -delete', 'find /tmp -type f -delete',
  // 5
  'find . -maxdepth 1 -delete', 'find . -type f -delete', 'find . -maxdepth 1 -type d -delete',
  // 8: a glob whose last segment starting with a dot can name .git
  'rm -rf .[!.]*', 'rm -rf .??*', 'rm -rf .g*', 'rm -rf .{git,x}', 'rm -rf .gi?', 'rm -rf ./.*', 'rm -rf .git*', 'rm -rf .[g]it',
  // 9: the working folder or a computed path as the whole path
  'rm -rf $PWD', 'rm -rf "$PWD"', 'rm -rf "$(pwd)"', 'rm -rf `pwd`', 'rm -rf "$PWD/.."', 'rm -rf "$(pwd)"/*', ,
  , 'rm -rf $(git rev-parse --show-toplevel)', ,
  'x=$HOME; rm -rf $x', 'x=..; rm -rf $x',
  // 10: a cd earlier in the line moves where relative paths land
  'cd ~ && rm -rf proj', 'cd .. && rm -rf x', 'pushd .. ; rm -rf proj',
  'cd; rm -rf proj', 'cd ~/other && rm -rf .', 'cd ~ ; rm -rf *', 'cd / && cd ~ && rm -rf proj',
  // 11
  'busybox rm -rf ..', 'env -S "rm -rf .."', 'env -S rm\\ -rf\\ ..', 'nix-shell --run "rm -rf .."', 'sudo busybox rm -rf /',
  // 12: past the nesting limit a delete word is refused whatever it names
  'echo ' + '$(echo '.repeat(6) + 'rm -rf ..' + ')'.repeat(6)]

const ALLOW2 = [
  // 2
  'tmp=$(mktemp -d); rm -rf "$tmp"', 'tmp=$(mktemp -d)\nrm -rf $tmp/x', 'rm -rf "$tmp/x"', 'rm -rf $tmpdir/x', 'rm -rf $home/x', 'rm -rf $temp/x', 'rm -rf $userprofile/x',
  'export T=$(mktemp -d) && rm -rf "$T"', 'rm -rf "$(mktemp -d)"',
  // 4
  "find /tmp -name 'x*' -mtime +7 -delete", 'find "$TMPDIR" -name "claude-*" -delete', 'find $TMPDIR -type f -mtime +1 -delete', 'find ~ -name "*.bak" -delete',
  // 5
  'find . -maxdepth 1 -type f -delete', 'find . -maxdepth 2 -type f -name x -delete',
  // 8
  'rm -rf .cache*', 'rm -rf .c*', 'rm -rf .{cache,tmp}', 'rm -rf .github', 'rm -rf src/.cache', 'rm -rf .[c]ache',
  // 9
  'rm -rf "$PWD/dist"', 'rm -rf $PWD/dist', 'rm -rf "$(pwd)/dist"', 'rm -rf "$dir/build"', 'rm -rf "$dir"/build', 'rm -rf "${dir}/build"', 'dir=dist; rm -rf "$dir"',
  'dir=dist; rm -rf $dir/', 'x=a; y=$x; rm -rf $y', 'find "$d" -name x -delete',
  // 10
  'cd build && rm -rf .', 'cd src && rm -rf ../dist', 'cd dist && rm -rf node_modules', 'cd /tmp && rm -rf x', 'cd "$dir" && rm -rf /tmp/x', 'cd "$dir" && ls', 'cd ~ && ls && rm -f x',
  'cd build; cd ..; rm -rf dist', 'cd $PWD/build && rm -rf .', '(cd build && rm -rf .)',
  // 11
  'busybox ls', 'env -S "rm -rf dist"', 'nix-shell --run "rm -rf dist"', 'sudo busybox rm -f x',
  // 12
  'echo ' + '$(echo '.repeat(6) + 'ls' + ')'.repeat(6)]

for (const [name, env, tool] of [['Windows', WIN, 'Bash'], ['POSIX', NIX, 'Bash']] as const) {
  test(`${name} cwd: the red-team rows (variables, cd, dotted globs, find narrowing, wrappers, depth)`, () => {
    expect(BLOCK2.filter((c) => !check(c, tool, env))).toEqual([])
    expect(ALLOW2.filter((c) => check(c, tool, env))).toEqual([])
  })
}

test('find .. is the home folder in the shallow cwd and a folder above the project in the deep one', () => {
  expect(check('find .. -name "*.log" -delete', 'Bash', WIN)).toBeNull()
  expect(check('find .. -name "*.log" -delete', 'Bash', DEEP)).toContain('above this folder')
  expect(check('find / -name x -delete', 'Bash', DEEP)).toContain('whole drive')
  expect(check('find ~ -delete', 'Bash', DEEP)).toContain('home folder')
})

const PS_BLOCK2 = ['Remove-Item -Recurse $HOME', 'Remove-Item -Recurse $home\\x', 'Remove-Item -Recurse $env:temp', 'Remove-Item -Recurse $ENV:TMP',
  'Remove-Item -Recurse $PWD', 'Remove-Item -Recurse "$pwd\\.."', 'Remove-Item -Recurse (Get-Location)', 'Remove-Item -Recurse (Get-Location).Path', 'Remove-Item -Recurse .g*', 'Remove-Item -Recurse .[!.]*', 'rm -r .??*',
  'Set-Location ..; Remove-Item -Recurse proj', 'cd ~; Remove-Item -Recurse proj', 'cd \\; Remove-Item -Recurse Windows',
  'Push-Location ..; ri -r x', '$x = $env:USERPROFILE; Remove-Item -Recurse $x']
const PS_ALLOW2 = ['Remove-Item -Recurse $tmp\\x', 'Remove-Item -Recurse "$temp\\x"', 'Remove-Item -Recurse $env:TEMP\\x', 'Remove-Item -Recurse "$PWD\\dist"',
  '$x = "dist"; Remove-Item -Recurse $x', '$d = ".\\build"; Remove-Item -Recurse -Force $d', 'cd build; Remove-Item -Recurse .', 'Set-Location -Path build; Remove-Item -Recurse -Force .',
  'Remove-Item -Recurse .cache*', 'Remove-Item -Recurse .{cache,tmp}']

test('PowerShell: variables, cd, $PWD and dotted globs', () => {
  expect(PS_BLOCK2.filter((c) => !check(c, 'PowerShell', WIN))).toEqual([])
  expect(PS_ALLOW2.filter((c) => check(c, 'PowerShell', WIN))).toEqual([])
})

const ALLOW = ['rm -rf node_modules', 'rm -rf dist build', 'rm -rf ./dist', 'rm -rf dist/', 'rm -rf dist/*', 'rm -rf src/tmp', 'rm -rf "my dir"',
  'rm -rf -- dist', 'rm -rf .cache .github', 'rm -rf a..b ..foo', 'rm -rf "$TMPDIR/x"', 'rm -rf $TEMP/x', 'rm -rf /tmp/x', 'rm -rf $(mktemp -d)',
  'rm -f a.ts', 'rm a.ts', 'rm -f *', 'rm -f ..', 'rmdir empty', 'rm -r dist 2>&1', 'rm -rf dist > /dev/null', 'rm -rf dist; echo ..', 'rm -rf a && rm -rf b',
  'git rm -r dist', 'git rm -rf --cached node_modules', 'sudo git rm -r .', 'git commit -m "rm -rf /"', 'echo rm -rf ..', 'echo "rm -rf /"', "echo 'rm -rf ~'",
  'ls ..', 'cat .git/config', 'bash -c "rm -rf dist"', 'bash -c "echo rm -rf .."', 'xargs rm -f', 'find . -name x | xargs rm -f', 'xargs -I{} rm -rf dist/{}',
  'find . -name "*.log" -delete', 'find . -name "*.js" -exec rm {} \\;', 'find src -delete', 'find . -type f -name x', 'find .. -name x', 'find / -name x -print', 'find ~ -name x -delete', 'find ~ -name x -exec rm {} +',
  'find . -exec grep x {} \\;', 'rm -rf dist # not ..', 'bash script.sh', 'echo hi <<EOF\nrm -rf ..\nEOF',
  'rd /s /q dist', 'rmdir /s /q build', 'cmd /c rd /s /q dist', 'del /s /q *.log']

for (const [name, env, tool] of [['Windows', WIN, 'Bash'], ['POSIX', NIX, 'Bash']] as const) {
  test(`${name} cwd: refuses every recursive delete that reaches past a folder inside the project and none that stays inside`, () => {
    expect(BLOCK.filter((c) => !check(c, tool, env))).toEqual([])
    expect(ALLOW.filter((c) => check(c, tool, env))).toEqual([])
  })
}

test('Windows spellings: drive roots, Git Bash drive paths, home variables', () => {
  expect(['rm -rf C:\\', 'rm -rf C:/', 'rm -rf c:', 'rm -rf /c', 'rm -rf /c/', 'rm -rf /cygdrive/c/', 'rm -rf /c/Users/dev', 'rm -rf C:\\Users\\dev\\Desktop', 'rm -rf %USERPROFILE%', 'rm -rf C:\\Users',
    'rm -rf c:\\users\\DEV\\proj\\..', 'rm -rf C:\\', 'rm -rf /tmp', 'rd /s /q C:\\', 'cmd /c "rd /s /q C:\\"'].filter((c) => !check(c, 'Bash', WIN))).toEqual([])
  expect(['rm -rf C:\\Users\\dev\\proj\\dist', 'rm -rf c:/users/dev/proj/dist', 'rm -rf /c/Users/dev/proj/dist', 'rm -rf C:\\Users\\dev\\AppData\\Local\\Temp\\x',
    'rm -rf /tmp/x', 'rm -rf %TEMP%\\x', 'rm -rf $env:TEMP/x'].filter((c) => check(c, 'Bash', WIN))).toEqual([])
})

const PS_BLOCK = ['Remove-Item -Recurse -Force .', 'Remove-Item -Recurse -Force ..', 'Remove-Item -Force -Recurse *', 'Remove-Item -Recurse .\\*', 'ri . -r -fo',
  'rm -r ..', 'rm -rf ..', 'del -Recurse ..', 'rd -rec ..', 'rmdir -Recurse ..', 'Remove-Item -r -Path ..', 'Remove-Item -Path .. -Recurse', 'Remove-Item -Recurse -Path:..',
  'Remove-Item -LiteralPath C:\\ -Recurse', 'Remove-Item -Recurse $env:USERPROFILE', 'Remove-Item -Recurse ~', 'Remove-Item -Recurse ~\\Documents',
  'Remove-Item -Recurse -Force .git', 'Remove-Item -Recurse -Force .\\.git\\',  '& Remove-Item -Recurse ..', 'Remove-Item -Recurse -Force -Path .\\a,..', 'Remove-Item -Recurse -Recurse:$true ..', 'Remove-Item -Recurse $env:TEMP', 'Remove-Item -Recurse $env:TEMP\\*',
  'Remove-Item -Recurse "%USERPROFILE%"', 'Remove-Item -Recurse -ErrorAction SilentlyContinue ..', '$null = Remove-Item -Recurse ..',
  'rmdir /s /q ..', 'rd /s /q C:\\', 'del /s /q *', 'rd /q/s ..', 'cmd /c rd /s /q ..', 'cmd.exe /c "rmdir /s C:\\"', 'bash -c "rm -rf .."', 'sh -c "rm -rf /"',
  'iex "Remove-Item -Recurse .."', 'Invoke-Expression "ri -r ~"', 'pwsh -Command "Remove-Item -Recurse -Force ~"', 'powershell -Command Remove-Item -Recurse ..',
  `powershell -EncodedCommand ${enc('Remove-Item -Recurse ..')}`, `pwsh -enc ${enc('rd /s C:\\')}`, 'echo $(Remove-Item -Recurse ..)',
  'if ($true) { Remove-Item -Recurse .. }', 'foreach ($d in $x) {Remove-Item -Recurse ..}', 'Get-ChildItem | ForEach-Object { Remove-Item -Recurse .. }',
  'Remove-Item `\n -Recurse ..']
const PS_ALLOW = ['Remove-Item -Recurse -Force .\\tmp', 'Remove-Item -Recurse -Force .\\tmp -ErrorAction SilentlyContinue', 'Remove-Item -Recurse -Force tmp, dist',
  'Remove-Item -Recurse -Path dist, build', 'Remove-Item -Recurse -Include *.tmp -Path dist', 'Remove-Item -Recurse -Filter *.tmp dist', 'Remove-Item -r dist',
  'Remove-Item -rec dist', 'Remove-Item -Recurse "my dir"', 'Remove-Item -Recurse ".\\a b\\c"', 'Remove-Item .\\a.txt', 'Remove-Item -Force ..', 'Remove-Item -Force *',
  'Remove-Item -Recurse -WhatIf ..', 'Remove-Item -Recurse -Wi ..', 'Remove-Item -Recurse:$false ..', 'ri -r dist', 'rm -r dist', 'rm dist\\a.txt', 'del a.txt', 'del /q a.txt',
  'rd /s /q dist', 'rmdir /s /q build', 'cmd /c rd /s /q dist', 'del /s /q *.log', 'Remove-Item -Recurse "$env:TEMP\\x"', 'Remove-Item -Recurse $env:TEMP/x',
  'Remove-Item -Recurse -LiteralPath .git2', 'git rm -r dist', 'git rm -rf --cached node_modules', 'Write-Host "Remove-Item -Recurse .."', "echo 'rm -rf ..'",
  'Get-ChildItem | Where-Object { $_.Name -eq "x" }', 'pwsh -Command "Remove-Item -Recurse dist"',
  `powershell -EncodedCommand ${enc('Remove-Item -Recurse dist')}`, 'Remove-Item -Recurse "C:\\Users\\dev\\proj\\dist"', 'Remove-Item "C:\\Users\\dev\\proj" -Force']

test('PowerShell: Remove-Item and its aliases, any -Recurse prefix, cmd switches, nested shells', () => {
  expect(PS_BLOCK.filter((c) => !check(c, 'PowerShell', WIN))).toEqual([])
  expect(PS_ALLOW.filter((c) => check(c, 'PowerShell', WIN))).toEqual([])
})

test('a refusal names what is lost, and the fix is in the denial', async () => {
  expect(check('rm -rf ..', 'Bash', DEEP)).toBe('`rm -rf ..` deletes everything above this folder')
  expect(check('rm -rf ..', 'Bash', WIN)).toContain('home folder')
  expect(check('rm -rf .', 'Bash', WIN)).toContain('whole project folder')
  expect(check('rm -rf *', 'Bash', WIN)).toContain('everything in this folder')
  expect(check('rm -rf ~', 'Bash', WIN)).toContain('home folder')
  expect(check('rm -rf /', 'Bash', NIX)).toContain('whole drive')
  expect(check('rm -rf .git', 'Bash', NIX)).toContain('history')
  expect(check('rm -rf /etc/x', 'Bash', NIX)).toBeNull()
  expect(check('rm -rf "$TMPDIR"', 'Bash', NIX)).toContain('temp folder')
  expect(check('find / -delete', 'Bash', NIX)).toContain('whole drive')
  const d = await denial('rm -rf ..', 'Bash', WIN)
  expect(d).toContain('delete-guard')
  expect(d).toContain('Name the folder you mean, inside this project')
  expect(d).toContain('with `!`')
  expect(d).toContain('MAKARASTY_DELETE_GUARD=off')
  expect(await denial('rm -rf dist', 'Bash', WIN)).toBeNull()
  expect(await denial('git status', 'Bash', WIN)).toBeNull()
})

// Red team: Bash unlinks links (rm, find), PowerShell and cmd follow them; a link that stays in the project is fine for rm.

// Round 2 red team. A: rm unlinks links; B: project root; C: literal loop lists; D: home caches; E/G: .git; H-N: bypasses.
const BLOCK3 = [
  // G: the project's own .git, and what a repository cannot live without
  'rm -rf .git/objects', 'rm -rf .git/refs', 'rm -rf .git/HEAD', 'rm -rf .git/objects/*', 'rm -rf .git/packed-refs', 'rm -rf .git/logs', 'rm -rf ./.git/objects/pack',
  'rm -rf .git/*', 'rm -rf .git/index', 'rm -rf "$PWD/.git"', 'rm -rf .git/config',
  // H: a quoted -exec body keeps its quotes
  `find . -execdir bash -c 'rm -rf ..' \\;`,
  // J: a test after the delete, behind -o or !, or matching everything narrows nothing
  'find . -delete -name x', "find . -name '*' -delete", "find . -name '.*' -delete", "find . -regex '.*' -delete", 'find . -name x -o -type f -delete', 'find . -type d -delete', 'find . -name "*.o" -o -delete',
  // K
  '/usr/bin/env rm -rf ..', '/usr/bin/sudo rm -rf ..', 'env.exe rm -rf ..', '/usr/bin/env -S "rm -rf .."',
  // L: rimraf, del-cli, trash, behind npx and friends
  'rimraf ..', 'rimraf .', 'npx rimraf ..', 'npx rimraf .', 'del-cli ..', 'npx del-cli "../*"', 'pnpm dlx rimraf ~', 'bunx rimraf /', 'trash ..', 'rimraf -g "*"', 'npx --yes rimraf ..',
  // B: the project root itself, and a cd that leaves it
  'rm -rf "$(git rev-parse --show-toplevel)"', 'rm -rf $(git rev-parse --show-toplevel)/..',
  // C: one bad item in the list, or a list that is computed
  'for d in dist ..; do rm -rf "$d"; done', 'for d in dist build; do rm -rf "$d/.."; done',
  // D: home itself and everything in it that is not a cache
  'rm -rf ~', 'rm -rf ~/', 'rm -rf ~/Documents', 'rm -rf ~/.ssh', 'rm -rf ~/.gradle', 'rm -rf ~/.m2', 'rm -rf ~/.config', 'rm -rf ~/AppData', 'rm -rf ~/.m2/settings.xml/..',
  // F: the guarded form alone is still a computed path
  ]
const ALLOW3 = [
  // E: a nested .git is somebody else's checkout; the project's .git may lose its hooks
  'rm -rf packages/a/.git', 'rm -rf vendor/x/.git', 'rm -rf node_modules/x/.git', 'rm -rf sub/.git', 'rm -rf .git/hooks/pre-commit', 'rm -rf .git/hooks', 'rm -rf .git/hooks/*',
  'rm -rf src/.g*', 'rm -rf dist/.*', 'rm -rf .git/index.lock',
  // H
  `find . -exec sh -c 'ls "$1"' _ {} \\;`, 'find . -name x -exec rm {} \\;', `find . -name '*.tmp' -exec sh -c 'rm -f "$1"' _ {} \\;`,
  // J
  "find . -name '*.log' -delete", 'find . -mtime +7 -delete', 'find . -type f -name x -delete', 'find . -empty -delete', "find . -name '*.tmp' -type f -delete", "find . -iname 'x*' -delete",
  // K
  '/usr/bin/env ls', '/usr/bin/env rm -rf dist', '/usr/bin/sudo rm -rf build',
  // L
  'rimraf dist', 'npx rimraf dist build', 'del-cli dist', 'npx del-cli "dist/*"', 'trash dist', 'rimraf -g "dist/**"', 'pnpm dlx rimraf dist', 'pnpm install', 'yarn build', 'npx tsc',
  // B
  'cd "$(git rev-parse --show-toplevel)" && rm -rf dist', 'cd "$(dirname "$0")" && rm -rf dist', 'cd "$(cd "$(dirname "$0")" && pwd)" && rm -rf build',
  'rm -rf "$(git rev-parse --show-toplevel)/dist"', 'rm -rf $(git rev-parse --show-toplevel)/dist', 'cd `dirname $0` && rm -rf out', 'cd "$(dirname "${BASH_SOURCE[0]}")" && rm -rf out',
  'rm -rf "$(git rev-parse --show-toplevel 2>/dev/null)/dist"',
  // C
  'for d in dist build; do rm -rf "$d"; done', 'for d in dist build; do rm -rf $d; done', 'for d in dist build\ndo\n  rm -rf "$d/cache"\ndone', 'for d in packages/a packages/b; do rm -rf "$d/dist"; done',
  'for d in packages/*; do rm -rf "$d/dist"; done', 'for d in dist; do rm -rf "$d"; done',
  // D
  'rm -rf ~/.cache', 'rm -rf ~/.cache/*', 'rm -rf ~/.cache/pip', 'rm -rf ~/.npm/_cacache', 'rm -rf ~/.npm/*', 'rm -rf ~/.npm', 'rm -rf ~/.gradle/caches', 'rm -rf ~/.gradle/caches*', 'rm -rf ~/.m2/repository',
  'rm -rf ~/.m2/repository*', 'rm -rf ~/AppData/Local/pip/Cache', 'rm -rf "$HOME/.cache/x"', 'rm -rf $HOME/AppData/Local/NuGet/v3-cache',
  // F: a guarded variable followed by a literal segment is a plain name, as $dir/dist is
  'rm -rf "${OUT_DIR:?}/dist"', 'rm -rf ${OUT_DIR:?}/dist']

for (const [name, env] of [['Windows', WIN], ['POSIX', NIX]] as const) {
  test(`${name} cwd: round 2 rows (.git, find -exec bodies, find narrowing, wrappers, rimraf, project root, loops, home caches)`, () => {
    expect(BLOCK3.filter((c) => !check(c, 'Bash', env))).toEqual([])
    expect(ALLOW3.filter((c) => check(c, 'Bash', env))).toEqual([])
  })
}

test('Windows: the temp folder itself stays refused even under home, a cache beside it does not', () => {
  expect(check('rm -rf ~/AppData/Local/Temp', 'Bash', WIN)).toContain('temp folder')
  expect(check('rm -rf ~/AppData/Local/Temp/*', 'Bash', WIN)).toContain('temp folder')
  expect(check('rm -rf ~/AppData/Local/Temp/x', 'Bash', WIN)).toBeNull()
  expect(check('rm -rf $env:TEMP', 'PowerShell', WIN)).toContain('temp folder')
})

const PS_BLOCK3 = [
  // I: paths from the pipeline, and members or indexes of variables
  
  
  // G
  'Remove-Item -Recurse .git\\objects', 'Remove-Item -Recurse -Force .git\\refs', 'Remove-Item -Recurse .\\.git\\HEAD', 'rd /s /q .git\\objects', 'Remove-Item -Recurse -Force .git\\logs\\*',
  // M: -WhatIf:$false is not a dry run
  'Remove-Item -Recurse -WhatIf:$false ..', 'Remove-Item -Recurse -Wi:$false ..',
  // C
  "foreach ($d in 'dist','..') { Remove-Item -Recurse $d }", 
  // L, K
  'rimraf ..', 'npx rimraf ..', 'Remove-Item -Recurse ~\\Documents', 'Remove-Item -Recurse ~\\AppData\\Local']
const PS_ALLOW3 = [
  // C: literal lists, Join-Path of the working folder or temp, through an assignment too
  "foreach ($d in 'dist','build') { Remove-Item -Recurse $d }", "foreach ($d in 'dist','build') { Remove-Item -Recurse -Force $d }", 'Remove-Item -Recurse (Join-Path $PWD dist)',
  'Remove-Item -Recurse (Join-Path $env:TEMP x)', 'Remove-Item -Recurse (Join-Path ([IO.Path]::GetTempPath()) x)', 'Remove-Item -Recurse (Join-Path dist x)',
  '$p = Join-Path $PWD dist; Remove-Item -Recurse $p', '$p = Join-Path $env:TEMP x; Remove-Item -Recurse -Force $p', '$p = [IO.Path]::GetTempPath(); Remove-Item -Recurse "$p\\x"',
  '$p = (Join-Path $PWD dist); Remove-Item -Recurse $p', 'Remove-Item -Recurse -Force ([IO.Path]::GetTempPath() + "x")', 'Remove-Item -Recurse "$([IO.Path]::GetTempPath())x"',
  // D, E, M
  'Remove-Item -Recurse -Force ~\\.cache', 'Remove-Item -Recurse -Force ~\\AppData\\Local\\pip\\Cache', 'Remove-Item -Recurse packages\\a\\.git', 'Remove-Item -Recurse .git\\hooks\\pre-commit',
  'Remove-Item -Recurse -WhatIf:$true ..', 'Remove-Item -Recurse -WhatIf ..', 'rimraf dist']

test('PowerShell round 2: pipeline paths, members, .git, -WhatIf:$false, literal foreach, Join-Path', () => {
  expect(PS_BLOCK3.filter((c) => !check(c, 'PowerShell', WIN))).toEqual([])
  expect(PS_ALLOW3.filter((c) => check(c, 'PowerShell', WIN))).toEqual([])
})

test('a refusal inside .git names the part it protects', () => {
  expect(check('rm -rf .git/objects', 'Bash', NIX)).toContain('.git/objects')
  expect(check('rm -rf .git', 'Bash', NIX)).toContain('history')
})

// Round 3: the guard refuses only what it can show is dangerous. A computed path, a pipeline and an unknown folder are allowed.
const ALLOW4 = [
  // a variable, substitution, parameter or loop variable nobody resolved here
  'rm -rf "$tmp"', 'rm -rf $OLDPWD', 'rm -rf "${OLDPWD}"', 'rm -rf "$f"', 'rm -rf $1', 'rm -rf "$@"', 'rm -rf $(dirname $PWD)', 'rm -rf "$dir"/', 'rm -rf "$dir"/*', 'rm -rf "${OUT_DIR:?}"',
  'rm -rf "${OUT_DIR:?}"/*', 'rm -rf $(echo dist)', 'rm -rf $(ls -d */)', 'dir=$(foo); rm -rf "$dir"', 'for d in $(ls); do rm -rf "$d"; done', 'for d in a b; do rm -rf "$e"; done',
  'clean() { rm -rf "$1"; }; clean dist', 'while read f; do rm -rf "$f"; done < list', 'rm -rf $x/..', 'rm -rf "$(dirname "$0")"', 'rm -rf "$(dirname "$0")"/dist',
  'cd "$(dirname "$0")/.." && rm -rf x',
  // stdin and pipelines
  'xargs rm -rf', 'find . -name "*.ts" | xargs rm -rf', 'ls | xargs -I{} rm -rf {}', 'git status --porcelain | xargs rm -rf', 'find . -print0 | xargs -0 rm -rf',
  // a folder the line cannot name
  'cd "$dir" && rm -rf build', 'cd - && rm -rf x', 'popd && rm -rf x', 'cd $(mktemp -d) && rm -rf x',
  // a stack of folders is followed
  'pushd build && rm -rf . && popd', 'pushd .. && popd && rm -rf dist', 'cd build; cd -; rm -rf dist',
  // find
  'find . ! -name x -delete', 'find . -not -name x -delete', 'find . \\( -name a -o -name b \\) -delete', 'find . -type f ! -name x -delete', 'find . \\( -name a \\) -delete',
  // .git/modules/<x> and .git/worktrees/<x>
  'rm -rf .git/modules/x', 'rm -rf .git/worktrees/wt', 'rm -rf .git/modules/a/b',
  // home caches
  'rm -rf ~/.pnpm-store', 'rm -rf ~/.yarn/cache', 'rm -rf ~/.bun/install/cache', 'rm -rf ~/.nuget/packages/foo', 'rm -rf ~/.cargo/registry/cache', 'rm -rf ~/.local/share/pnpm/store',
  'rm -rf ~/.vite', 'rm -rf ~/.turbo', 'rm -rf ~/.expo', 'rm -rf ~/.pub-cache', 'rm -rf ~/Library/Caches/foo', 'rm -rf ~/Library/Caches/*',
  // scratch folders other tools use
  'rm -rf /var/tmp/x', 'rm -rf /dev/shm/x', 'rm -rf /private/tmp/x', 'rm -rf /var/tmp/claude-1/x',
  // heredoc bodies are text; a marker in a here-string or a shift is not a heredoc
  'cat <<EOF\nrm -rf ..\nEOF', 'cat <<< "rm -rf .."', 'cat <<EOF > f\nrm -rf /\nEOF\nrm -rf dist', 'echo $((1 << 2)) && rm -rf dist']
const BLOCK4 = [
  // what a literal path shows
  'pushd build; popd; rm -rf .', 'cd build; cd -; rm -rf .', 'cd build && cd .. && rm -rf .', 'pushd .. ; rm -rf proj',
  'find . \\( -name a -o -type f \\) -delete', 'find . -type f -delete',
  'rm -rf .git/modules', 'rm -rf .git/worktrees', 'rm -rf .git/modules/*',
  'rm -rf ~/.yarn', 'rm -rf ~/.cargo', 'rm -rf ~/.nuget', 'rm -rf ~/.local', 'rm -rf ~/Library', 'rm -rf ~/.pnpm',
  'rm -rf /var/tmp', 'rm -rf /dev/shm', 'rm -rf /private/tmp',
  // a shell's heredoc is code, and what follows the marker on its line still runs
  'bash <<EOF\nrm -rf ..\nEOF', 'cat <<EOF && rm -rf ..\nbody\nEOF', 'cat <<EOF\nbody\nEOF\nrm -rf ..',
  // past the nesting limit a literal dangerous target in the rest still counts
  'echo ' + '$(echo '.repeat(6) + 'rm -rf ..' + ')'.repeat(6), 'echo ' + '$(echo '.repeat(6) + 'rm -rf ~' + ')'.repeat(6)]

for (const [name, env] of [['Windows', WIN], ['POSIX', NIX]] as const) {
  test(`${name} cwd: round 3 rows (unknown is allowed, a literal danger is not)`, () => {
    expect(ALLOW4.filter((c) => check(c, 'Bash', env))).toEqual([])
    expect(BLOCK4.filter((c) => !check(c, 'Bash', env))).toEqual([])
  })
}

test('Windows scratch folders: below them may go, they themselves may not', () => {
  expect(['rm -rf C:\\temp\\x', 'rm -rf C:\\tmp\\x', 'rm -rf C:\\Windows\\Temp\\x', 'rm -rf /c/temp/x', 'rm -rf /c/tmp/x', 'rm -rf /c/Windows/Temp/x'].filter((c) => check(c, 'Bash', WIN))).toEqual([])
  expect(['rm -rf C:\\temp', 'rm -rf C:\\tmp', 'rm -rf C:\\Windows\\Temp', 'rm -rf /c/temp'].filter((c) => !check(c, 'Bash', WIN))).toEqual([])
})

const PS_ALLOW4 = ['Get-ChildItem | Remove-Item -Recurse -Force', "'.' | Remove-Item -Recurse", 'Get-ChildItem dist | Remove-Item -Recurse', 'ls | rm -r',
  'Get-ChildItem | ForEach-Object { Remove-Item -Recurse $_.FullName }', 'Remove-Item -Recurse $_', 'Remove-Item -Recurse $_.FullName', 'foreach ($d in $list) { Remove-Item -Recurse $d }',
  "foreach ($d in 'dist',$x) { Remove-Item -Recurse $d }", 'Remove-Item -Recurse $x.Path', 'Remove-Item -Recurse $x[0]', 'Set-Location $dir; Remove-Item -Recurse build', '$x = Get-Item foo; Remove-Item -Recurse $x',
  'Remove-Item -Recurse $PSScriptRoot', 'Remove-Item -Recurse "$PSScriptRoot\\dist"', 'Remove-Item -Recurse -Include *.log .', 'Remove-Item -Recurse -Filter *.tmp .',
  'Remove-Item -Path . -Recurse -Include "*.tmp","*.bak"', 'Remove-Item -Recurse -Force -Include bin,obj -Path .', 'Remove-Item -Recurse <# .. #> dist', 'Remove-Item -Recurse <#\n..\n#> dist',
  'Remove-Item -Recurse C:\\temp\\x', 'Remove-Item -Recurse -Force ~\\.nuget\\packages\\x']
const PS_BLOCK4 = ['Remove-Item -Recurse -Include * .', 'Remove-Item -Recurse -Exclude x .', 'Remove-Item -Recurse -Filter * .', '<# x #>Remove-Item -Recurse ..', 'Remove-Item -Recurse ..  # dist',
  'Remove-Item -Recurse C:\\temp', 'Remove-Item -Recurse -Force ~\\.nuget']

test('PowerShell round 3: unknown is allowed, -Include/-Filter narrow, block comments are comments', () => {
  expect(PS_ALLOW4.filter((c) => check(c, 'PowerShell', WIN))).toEqual([])
  expect(PS_BLOCK4.filter((c) => !check(c, 'PowerShell', WIN))).toEqual([])
})

test('a long input is lexed in a bounded time', () => {
  const inputs = ['cout << x << y; '.repeat(6500), 'cat <<EOF\nx\n'.repeat(4000), 'bash <<EOF\nx\n'.repeat(4000), ('echo ok && cat <<EOF\nsome text rm find\nEOF\n').repeat(2500), 'echo "a $(echo b)" rm; '.repeat(4000)]
  for (const input of inputs) {
    const t0 = performance.now()
    check(input, 'Bash', NIX)
    expect(performance.now() - t0 < 1500).toBe(true) // ~80 ms in the engine; a quadratic scan took seconds
  }
})

// The gaps Claude Code's own checks leave: `$PWD`, `cmd /c rd /s /q .`, and a delete by the name of the folder the session runs in.
test('the folder the session runs in is refused by name after a cd out of it, and so is any folder holding it', () => {
  for (const [env, up, name] of [[NIX, 'cd ..', 'proj'], [WIN, 'cd ..', 'proj'], [DEEP, 'cd ..', 'proj'], [DEEP, 'cd ../..', 'work/proj']] as const) {
    expect(check(`${up} && rm -rf ${name}`, 'Bash', env)).toContain('whole project folder')
    expect(check(`${up}; rm -rf ./${name}/`, 'Bash', env)).toContain('whole project folder')
  }
  expect(check('cd ../.. && rm -rf work', 'Bash', DEEP)).toContain('above this folder')
  expect(check('Set-Location .. ; Remove-Item -Recurse -Force proj', 'PowerShell', WIN)).toContain('whole project folder')
  expect(check('cd .. && rm -rf proj-backup', 'Bash', NIX)).toContain('directly in your home folder')
  expect(['cd .. && rm -rf proj/dist', 'cd .. && cd proj && rm -rf dist', 'pushd .. && popd && rm -rf dist'].filter((c) => check(c, 'Bash', NIX))).toEqual([])
})

test('$PWD, cmd /c rd /s /q . and find . -delete are refused', () => {
  expect(['rm -rf "$PWD"', 'rm -rf $PWD', 'cmd /c rd /s /q .', 'cmd.exe /c "rmdir /s /q ."', 'find . -delete', 'rm -rf .git', 'rm -rf .git/objects'].filter((c) => !check(c, 'Bash', WIN))).toEqual([])
  expect(check('cmd /c rd /s /q .', 'PowerShell', WIN)).toContain('whole project folder')
})

// Round 4: a sibling or unrelated folder runs; the project, what holds it, home and its folders, drives, temp and .git do not.
test('a folder outside the project runs, unless it is the project, holds it, or is home or a drive', () => {
  const run = ['rm -rf ../other', 'rm -rf ../other/dist', 'rm -rf /etc/x', 'rm -rf /opt/foo', 'rm -rf D:\\scratch\\x', 'rm -rf C:\\llq', 'cd / && rm -rf usr', 'rm -rf ~/proj2/dist', 'rm -rf ~/Documents/old/x']
  expect(run.filter((c) => check(c, 'Bash', DEEP))).toEqual([])
  expect(['Remove-Item -Recurse -Force C:\\llq', 'Remove-Item -Recurse D:\\scratch', 'Remove-Item -Recurse -Force ..\\other', 'Remove-Item -Recurse -Force "C:\\Program Files\\x"'].filter((c) => check(c, 'PowerShell', DEEP))).toEqual([])
  const stop = ['rm -rf ..', 'rm -rf ../..', 'rm -rf .', 'rm -rf ../../..', 'cd .. && rm -rf proj', 'rm -rf ~', 'rm -rf ~/Documents', 'rm -rf ~/.ssh', 'rm -rf ~/proj-sibling', 'rm -rf /', 'rm -rf .git', 'rm -rf .git/objects', 'rm -rf $TMPDIR']
  expect(stop.filter((c) => !check(c, 'Bash', DEEP))).toEqual([])
})
