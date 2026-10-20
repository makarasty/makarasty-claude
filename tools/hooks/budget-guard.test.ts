import { expect, test } from 'claude-code/testing'
import { check, heavy, isWindows, parse, STALE_SECONDS, WIN_LIST, type Proc } from './budget-guard.ts'

const NONE: Proc[] = []
const LIVE_VITEST: Proc[] = [{ pid: 4321, cmd: '"C:\\Program Files\\nodejs\\node.exe" C:\\work\\app\\node_modules\\vitest\\vitest.mjs run' }]

// Every one of these is a whole-repo typecheck or whole-suite run.
const HEAVY = ['vitest run', 'vitest', 'npx vitest run', 'npx --yes vitest run --coverage', 'bunx vitest run', 'pnpm exec vitest run', 'vitest run --reporter dot',
  'jest', 'npx jest --ci', 'mocha', 'playwright test', 'npx playwright test --reporter=list', 'tsc', 'tsc --noEmit', 'npx tsc --noEmit', 'vue-tsc --noEmit',
  'tsc -b', 'tsc --build --force', 'tsc --noEmit -p tsconfig.json', 'vue-tsc --noEmit -p tsconfig.app.json', 'tsc -p .', 'npm test', 'npm run test', 'npm t', 'pnpm test',
  'pnpm -r test', 'pnpm run typecheck', 'yarn test', 'yarn typecheck', 'bun test', 'bun run test', 'npm run test:all', 'npm run test:ci', 'pnpm run type-check', 'npm run test -- --run', 'npm test --silent', 'echo don\'t; npx vitest run',
  'npm test -- --coverage', 'nx run-many -t test', 'nx run-many --target=test', 'turbo run test', 'turbo test', './gradlew test', 'gradlew.bat build', './gradlew clean check',
  'cargo test', 'cargo +nightly test --release', 'cargo test -- --nocapture', 'pytest', 'python -m pytest', 'pytest -v', 'python3.14 -m pytest -x', 'node --test',
  'node scripts/fleet-selftest.mjs', 'node scripts/fleet-selftest.mjs --jobs 2', 'cd app && npm test', 'git status; npm test', 'env CI=1 npm test',
  'timeout 900 npm test', 'FOO=1 vitest run', 'bash -c "npm test"', 'sh -lc "cd x && vitest run"', 'cmd /c "npm test"', 'echo $(npm test)', '(npm test)', 'time npm run typecheck',
  'if true; then npm test; fi', 'tsc --noEmit 2>&1 | tail -5', 'npm test | tee out.log']

// Scoped, informational or not a verify run at all.
const SCOPED = ['vitest run src/x.test.ts', 'vitest run auth', 'vitest related src/a.ts', 'vitest run -t "login works"', 'vitest run --changed', 'vitest run --project unit', 'npx vitest run packages/a',
  'vitest --version', 'vitest --help', 'vitest list', 'jest --listTests', 'jest src/a.test.js', 'jest --onlyChanged', 'jest -t name', 'jest --findRelatedTests src/a.ts', 'mocha test/a.js', 'mocha --grep login',
  'playwright test e2e/a.spec.ts', 'playwright test --grep login', 'playwright test --project=chromium', 'playwright install', 'tsc --noEmit -p packages/a', 'tsc --noEmit -p packages/a/tsconfig.json',
  'vue-tsc --noEmit -p apps/web/tsconfig.app.json', 'tsc src/a.ts --noEmit', 'tsc -b packages/a', 'tsc --version', 'tsc -v', 'tsc --init', 'tsc --watch', 'tsc -w --noEmit', 'vue-tsc --watch',
  'npm test -- src/a.test.ts', 'npm run test -- --grep login', 'npm test -- -t foo', 'pnpm --filter web test', 'pnpm -F web run typecheck', 'npm test -w web', 'npm run test:watch',
  'npm test -- --watch', 'yarn test src/a.test.ts', 'bun test src/a.test.ts', 'bun test --watch', 'npm run typecheck -- -p packages/a', 'npm --version',
  'turbo run test --filter=web', 'turbo run build', 'nx run-many -t test --projects=a', 'nx run web:test', 'nx affected -t test', './gradlew :app:test', './gradlew test --tests FooTest', './gradlew tasks',
  'cargo test -p core', 'cargo test my_test', 'cargo test --lib', 'cargo build', 'cargo --version', 'pytest tests/test_a.py', 'pytest -k login', 'pytest tests/', 'pytest --co', 'python -m pytest tests/a.py',
  'node --test src/a.test.js', 'node --test --test-name-pattern=login', 'node x.js', 'node scripts/fleet-selftest.mjs --help', 'node -e "console.log(1)"',
  'git status', 'git commit -m "fix: test the check"', 'echo "npm test"', 'ls -la', 'npm install', 'npm ci', 'pnpm install', 'npm run dev', 'npm run build', 'npm run lint', 'npm run start',
  'yarn build', 'bun install', 'bun run dev', 'cat tsconfig.json', 'grep -r tsc src', 'python script.py', 'cargo run', 'gradlew assemble', 'timeout 60 node server.js']

test('heavy: finds every whole-repo run, wherever it hides in the line', () => {
  expect(HEAVY.filter((c) => !heavy(c).length)).toEqual([])
})

test('heavy: finds no run in a scoped, informational or unrelated command', () => {
  expect(SCOPED.filter((c) => heavy(c).length)).toEqual([])
})

test('PowerShell lines read the same way, with its own escape and no timeout prefix', () => {
  expect(['npm test', 'npx vitest run', 'tsc --noEmit', '& npm run typecheck', 'cd app; npm test', 'node scripts/fleet-selftest.mjs', 'timeout 900 npm test', 'npm test > out/log.txt 2>&1'].filter((c) => !heavy(c, 'PowerShell').length)).toEqual([])
  expect(['npx vitest run src\\a.test.ts', 'Get-ChildItem', 'git status', 'Write-Host "npm test"', 'tsc -p packages\\a'].filter((c) => heavy(c, 'PowerShell').length)).toEqual([])
  expect(heavy('timeout 900 npm test', 'PowerShell')[0]?.timeout).toBe(false)
})

// A heavy line with another heavy run live is refused.
test('a heavy run with another heavy run live is refused, and the refusal names the pid and the way out', () => {
  const why = check('npm test', 'Bash', {}, LIVE_VITEST)
  expect(why).toContain('budget-guard')
  expect(why).toContain('pid 4321')
  expect(why).toContain('vitest.mjs run')
  expect(why).toContain('Wait for it')
  expect(why).toContain('its result is yours to read')
  expect(why).toContain('scope your run to one file or project')
  expect(why).toContain('MAKARASTY_BUDGET_GUARD=off')
  for (const c of HEAVY) expect([c, !!check(c, 'Bash', {}, LIVE_VITEST)]).toEqual([c, true])
})

test('live runs of every kind count, and show shortened', () => {
  const live = (cmd: string): string | null => check('vitest run', 'Bash', {}, [{ pid: 7, cmd }])
  for (const cmd of [
    'node C:\\p\\node_modules\\typescript\\lib\\tsc.js --noEmit', '"C:\\Program Files\\nodejs\\node.exe" C:\\p\\node_modules\\vue-tsc\\bin\\vue-tsc.js --noEmit -p tsconfig.app.json',
    'node /usr/lib/node_modules/npm/bin/npm-cli.js test', 'node C:\\p\\node_modules\\jest\\bin\\jest.js --ci', 'node C:\\p\\node_modules\\@playwright\\test\\cli.js test',
    'node C:\\p\\scripts\\fleet-selftest.mjs', 'bun.exe test', 'python.exe C:\\p\\.venv\\Scripts\\pytest.exe', 'python -m pytest', 'cargo.exe test',
    'java -Xmx64m -classpath C:\\p\\gradle\\wrapper\\gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain test', 'node C:\\p\\node_modules\\vitest\\vitest.mjs --run',
  ]) expect([cmd, live(cmd) !== null]).toEqual([cmd, true])
  expect(live('"C:\\Program Files\\nodejs\\node.exe" C:\\work\\app\\node_modules\\vitest\\vitest.mjs run --coverage')).toContain('node.exe vitest.mjs run --coverage')
  const many = check('vitest run', 'Bash', {}, [1, 2, 3, 4, 5].map((pid) => ({ pid, cmd: 'node vitest.mjs run' })))
  expect(many).toContain('pid 1')
  expect(many).toContain('pid 3')
  expect(many).not.toContain('pid 4')
  expect(many).toContain('and 2 more')
})

test('watchers, scoped runs, servers and unrelated processes are not a live heavy run', () => {
  const quiet = (cmd: string): boolean => check('npm test', 'Bash', {}, [{ pid: 9, cmd }]) === null
  for (const cmd of [
    'node C:\\p\\node_modules\\typescript\\lib\\tsc.js --watch --noEmit', 'node tsc.js -w', 'node vue-tsc.js --watch', 'node C:\\p\\node_modules\\vitest\\vitest.mjs', 'node vitest.mjs --watch',
    'node vitest.mjs run src/a.test.ts', 'node vitest.mjs run -t login', 'node C:\\p\\node_modules\\typescript\\lib\\tsserver.js --useInferredProjectPerProjectRoot',
    'node C:\\p\\node_modules\\vite\\bin\\vite.js', 'node server.js', 'node x.js test', 'node npm-cli.js run dev', 'node npm-cli.js install', 'node C:\\p\\node_modules\\vitest\\dist\\workers\\forks.js',
    'node C:\\p\\node_modules\\@playwright\\test\\lib\\common\\process.js', 'java -classpath x org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.5', 'python script.py', 'bun.exe run dev',
    // command lines read from this machine (2026-10-20): a native tsc watcher, a scoped vitest, and a vitest worker
    '"node"   "C:\\p\\server\\node_modules\\.bin\\..\\@typescript\\native\\bin\\tsc" --watch',
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\p\\frontend\\node_modules\\vitest\\vitest.mjs" run --project frontend-dom',
    '"C:\\Program Files\\nodejs\\node.exe" --experimental-import-meta-resolve --require C:/p/frontend/node_modules/vitest/suppress-warnings.cjs --conditions node --conditions development --experimental-vm-modules C:\\p\\frontend\\node_modules\\vitest\\dist\\workers\\vmForks.js',
    'node C:\\Users\\mky\\.claude\\claude.js --print "run npm test"', 'node --test src/a.test.js', 'pytest tests/a.py',
  ]) expect([cmd, quiet(cmd)]).toEqual([cmd, true])
})

test('a scoped or unrelated line is never blocked, whatever is live', () => {
  for (const c of SCOPED) expect([c, check(c, 'Bash', { run_in_background: true }, LIVE_VITEST)]).toEqual([c, null])
})

test('a heavy run alone on the machine passes, and so does one when the listing failed', () => {
  for (const c of HEAVY) expect([c, check(c, 'Bash', {}, NONE)]).toEqual([c, null])
  for (const c of HEAVY) expect([c, check(c, 'Bash', {}, undefined)]).toEqual([c, null])
})

test('a heavy run in the background with no kill-after limit is refused; with one it passes', () => {
  const why = check('npm test', 'Bash', { run_in_background: true }, NONE)
  expect(why).toContain('no kill-after limit')
  expect(why).toContain('timeout <twice its usual seconds>')
  expect(why).toContain('MAKARASTY_BUDGET_GUARD=off')
  expect(check('npm test', 'Bash', { run_in_background: true }, undefined)).toContain('no kill-after limit')
  expect(check('npx vitest run', 'Bash', { run_in_background: true })).toContain('`npx vitest run`')
  for (const c of ['timeout 900 npm test', 'timeout -k 10 900 npx vitest run', 'timeout 1200 tsc --noEmit', 'FOO=1 timeout 900 npm test', 'cd app && timeout 900 npm test', 'gtimeout 60 vitest run', 'timeout 300 bash -c "npm test"', 'timeout 900 node scripts/fleet-selftest.mjs'])
    expect([c, check(c, 'Bash', { run_in_background: true }, NONE)]).toEqual([c, null])
  // each heavy command of a chain needs its own limit
  expect(check('timeout 900 npm test && npm run typecheck', 'Bash', { run_in_background: true }, NONE)).toContain('`npm run typecheck`')
  // a foreground run needs none: the tool call caps it
  expect(check('npm test', 'Bash', { run_in_background: false }, NONE)).toBeNull()
  expect(check('npm test', 'Bash', {}, NONE)).toBeNull()
})

test('a trailing & backgrounds a heavy run too, but 2>&1 and && do not', () => {
  expect(check('npm test &', 'Bash', {}, NONE)).toContain('no kill-after limit')
  expect(check('npm test > out.log 2>&1 &', 'Bash', {}, NONE)).toContain('no kill-after limit')
  expect(check('timeout 900 npm test > out.log 2>&1 &', 'Bash', {}, NONE)).toBeNull()
  expect(check('npm test 2>&1 | tail -5', 'Bash', {}, NONE)).toBeNull()
  expect(check('cd app && npm test', 'Bash', {}, NONE)).toBeNull()
})

test('PowerShell has no timeout prefix: the background refusal says what to do instead', () => {
  const why = check('npm test', 'PowerShell', { run_in_background: true }, NONE)
  expect(why).toContain('no kill-after limit')
  expect(why).toContain('Wait-Process -Timeout')
  expect(check('timeout 900 npm test', 'PowerShell', { run_in_background: true }, NONE)).toContain('no kill-after limit')
  expect(check('$p = Start-Process npm -ArgumentList test -PassThru; npm test; Wait-Process -Id $p.Id -Timeout 900', 'PowerShell', { run_in_background: true }, NONE)).toBeNull()
  expect(check('npm test', 'PowerShell', {}, NONE)).toBeNull()
})

test('both reasons are told at once', () => {
  const why = check('npm test', 'Bash', { run_in_background: true }, LIVE_VITEST)!
  expect(why).toContain('another heavy verify run is live')
  expect(why).toContain('no kill-after limit')
})

// Only a clearly whole-suite run counts, in the call and among the live processes alike: a project's own scoped scripts,
// a bare test name after `--`, a lookup, a heredoc's text and a variable that merely holds a path are not runs.
const NOT_WHOLE = ['npm run test -- twilioConference.store', 'npm run test -- a.test b.test', 'npm test twilio', 'pnpm test src/a', 'yarn test auth', 'npm run test:changed', 'npm run test:scope',
  'npm run test:dom', 'npm run test:rules', 'npm run test:tools', 'npm run test:ip-match', 'npm run test:unit', 'npm run test:e2e', 'npm run test:coverage', 'npm run check', 'bun run check', 'npm run check:types',
  'npm run typecheck:fast', 'npm run tsc', 'command -v tsc', 'command -v vitest', 'which vitest', 'type tsc', 'builtin command -v jest', 'vitest --ui', 'vitest dev', 'vitest serve', './gradlew test -t', './gradlew test --continuous',
  'jest --watchAll', "cat > README.md <<'EOF'\n# Dev\n\nnpm test\nnpx tsc --noEmit\nEOF", "git commit -F - <<'EOF'\nfix: tests\n\nnpm test passes\nEOF", 'cat <<-X\n\tnpm test\n\tX\n',
  'echo $((1 << 2)) && echo ok', 'FOO=1 BAR=2', 'turbo run build']
test('a scoped script, a lookup or a heredoc is no whole-suite run', () => {
  expect(NOT_WHOLE.filter((c) => heavy(c).length)).toEqual([])
  for (const c of NOT_WHOLE) expect([c, check(c, 'Bash', { run_in_background: true }, LIVE_VITEST)]).toEqual([c, null])
  expect(['$v="$fe\\node_modules\\vitest\\vitest.mjs"; & "$s\\measure.ps1" -Label x', '$env:LL_TEST_WORKERS=2; npm run test -- foo 2>&1 | Select-Object -Last 20', '$t = "tsc"; Write-Host $t',
    "@'\nnpm test\n'@ | Set-Content a.txt"].filter((c) => heavy(c, 'PowerShell').length)).toEqual([])
  // the same classifier on a live process
  for (const cmd of ['node C:/x/npm-cli.js run test -- twilioConference.store', 'node C:/x/npm-cli.js run test:changed', 'node C:/x/vitest.mjs --ui', 'java -classpath g.jar org.gradle.wrapper.GradleWrapperMain test --continuous', 'node C:/x/vitest.mjs dev'])
    expect([cmd, check('npm test', 'Bash', {}, [{ pid: 9, cmd }])]).toEqual([cmd, null])
  // a heredoc ends at its own terminator: what follows it still runs
  expect(heavy("cat <<EOF\nnpm test\nEOF\nnpx vitest run").map((r) => r.text)).toEqual(['npx vitest run'])
})

test('a group sent to the background with & keeps its limit rule; an apostrophe inside a word swallows nothing', () => {
  for (const c of ['(cd x && npm test) &', '{ npm test; } &', 'echo start && (cd x; npm test) &']) expect([c, check(c, 'Bash', {}, NONE)?.includes('no kill-after limit')]).toEqual([c, true])
  for (const c of ['(cd x && timeout 900 npm test) &', '{ timeout 900 npm test; } &', '(cd x && npm test)', '(npm test) && echo ok &']) expect([c, check(c, 'Bash', {}, NONE)]).toEqual([c, null])
  expect(heavy("echo don't; npx vitest run")).toHaveLength(1)
  expect(heavy("npx vitest run --grep='login works'")).toHaveLength(0)
  expect(heavy("echo it's fine && npm test")).toHaveLength(1)
})

test('parse reads the Windows listing and the ps listing, and skips what is no row', () => {
  expect(parse('20464\t125\t"C:\\Program Files\\nodejs\\node.exe" C:\\p\\vitest.mjs run\r\n20360\t\tnode a.js\r\n\r\nnot a row\r\n')).toEqual([
    { pid: 20464, age: 125, cmd: '"C:\\Program Files\\nodejs\\node.exe" C:\\p\\vitest.mjs run' }, { pid: 20360, cmd: 'node a.js' }])
  expect(parse('  912    01:02:03 node /usr/bin/vitest run\n 1033 2-00:00:05 bash -c x\n 77 00:09 node b.js\n', false)).toEqual([
    { pid: 912, age: 3723, cmd: 'node /usr/bin/vitest run' }, { pid: 1033, age: 172805, cmd: 'bash -c x' }, { pid: 77, age: 9, cmd: 'node b.js' }])
  // a row without the age column still reads, age unknown
  expect(parse('912 node /usr/bin/vitest run\n 1033 bash\n', false)).toEqual([{ pid: 912, cmd: 'node /usr/bin/vitest run' }, { pid: 1033, cmd: 'bash' }])
  expect(parse('')).toEqual([])
})

test('a live heavy run older than an hour is named as hung and never blocks; one of unknown age still does', () => {
  const stale: Proc = { pid: 55, age: STALE_SECONDS + 1, cmd: 'node C:/p/node_modules/vitest/vitest.mjs run' }
  const fresh: Proc = { pid: 66, age: 120, cmd: 'node C:/p/node_modules/vitest/vitest.mjs run' }
  expect(check('npm test', 'Bash', {}, [stale])).toBeNull()
  expect(check('npm test', 'Bash', {}, [{ ...stale, age: STALE_SECONDS }])).toContain('pid 55')
  const both = check('npm test', 'Bash', {}, [stale, fresh])!
  expect(both).toContain('another heavy verify run is live on this machine: pid 66')
  expect(both).toContain('pid 55')
  expect(both).toContain('looks hung: tell the user')
  expect(both.indexOf('pid 55')).toBeGreaterThan(both.indexOf('looks hung') - 200)
  expect(check('npm test', 'Bash', {}, [{ pid: 7, cmd: stale.cmd }])).toContain('pid 7')
  // the hung one is told along with any other refusal
  const bg = check('npm test', 'Bash', { run_in_background: true }, [stale])!
  expect(bg).toContain('no kill-after limit')
  expect(bg).toContain('pid 55')
  expect(bg).toContain('looks hung')
  expect(check('npm test', 'Bash', {}, [stale, { pid: 56, age: 99999, cmd: stale.cmd }])).toBeNull()
})

test('a host that strips OS from the environment is still told apart by ComSpec or SystemRoot', () => {
  expect(isWindows('Windows_NT')).toBe(true)
  expect(isWindows(undefined, 'C:\\Windows\\system32\\cmd.exe')).toBe(true)
  expect(isWindows(undefined, undefined, 'C:\\Windows')).toBe(true)
  expect(isWindows(undefined, undefined, undefined)).toBe(false)
  expect(isWindows('', '', '')).toBe(false)
})

test('the Windows listing is one -Command string with no double quote to be mangled in transit', () => {
  expect(WIN_LIST).not.toContain('"')
  expect(WIN_LIST).toContain('Win32_Process')
})

test('a long or odd line is lexed in a bounded time', () => {
  for (const input of ['npm test && '.repeat(5000), 'echo "a $(echo b)" test; '.repeat(4000), '(('.repeat(5000) + 'npm test', 'bash -c "'.repeat(2000) + 'npm test']) {
    const t0 = performance.now()
    heavy(input)
    expect(performance.now() - t0 < 500).toBe(true)
  }
})
