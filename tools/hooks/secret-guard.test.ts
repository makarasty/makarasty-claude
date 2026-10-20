import { expect, test } from 'claude-code/testing'
import { KINDS, check, fields, find, type Env } from './secret-guard.ts'

// Every token is built from fragments at run time, with a random-looking body that holds none of the fake markers,
// so this file would pass the guard when written: the test below runs the guard over its own text.
const R = 'q8Zk3Lm9Vb2Nx7Wc5Rt1Yh4Js6Dg0Fa8Pe3Uo7Ik2Bn'
const TOKENS: [kind: string, value: string][] = [
  ['Anthropic API key', 'sk-ant-' + 'api03-' + R],
  ['OpenAI-style API key', 'sk-' + 'proj-' + R],
  ['OpenAI-style API key', 'sk-' + R],
  ['GitHub token', 'gh' + 'p_' + R.slice(0, 36)],
  ['GitHub token', 'gh' + 'o_' + R.slice(0, 40)],
  ['GitHub fine-grained token', 'github_' + 'pat_' + R.slice(0, 30)],
  ['AWS access key id', 'AK' + 'IA' + R.toUpperCase().slice(0, 16)],
  ['AWS access key id', 'AS' + 'IA' + R.toUpperCase().slice(0, 16)],
  ['Slack token', 'xox' + 'b-' + '8472019365-' + R.slice(0, 20)],
  ['Stripe key', 'sk_' + 'live_' + R.slice(0, 24)],
  ['Stripe key', 'sk_' + 'test_' + R.slice(0, 24)],
  ['npm token', 'npm' + '_' + R.slice(0, 36)],
  ['GitLab token', 'glpat' + '-' + R.slice(0, 20)],
  ['SendGrid API key', 'SG' + '.' + R.slice(0, 22) + '.' + R.slice(0, 43)],
  ['Telegram bot token', '123456789' + ':' + R.slice(0, 35)],
  ['Discord webhook URL', 'https://discord' + '.com/api/webhooks/' + '123456789012345678/' + R],
  ['Discord webhook URL', 'https://ptb.discordapp' + '.com/api/webhooks/' + '123456789012345678/' + R],
  ['private key (PEM)', '-----BEGIN ' + 'RSA PRIVATE' + ' KEY-----\n' + 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun\n'],
  ['private key (PEM)', '-----BEGIN ' + 'PRIVATE' + ' KEY-----\r\n' + 'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCzk3Lm\r\n'],
]
// A real value, not a placeholder, in a file of the project.
const one = (tok: string): string => `const k = '${tok}'\n`

const PROJ = 'C:\\Users\\dev\\proj'
const ENV: Env = { cwd: PROJ, safe: ['C:\\Users\\dev\\.claude'] }
const SRC = `${PROJ}\\src\\config.ts`

test('every token shape is refused in a project file, with file, kind and four characters, never the value', () => {
  for (const [kind, tok] of TOKENS) {
    const why = check(SRC, one(tok), ENV) ?? ''
    expect(why).toContain(kind)
    expect(why).toContain(SRC)
    expect(why).toContain(`(${tok.slice(0, 4)}...)`)
    expect(why).not.toContain(tok.slice(0, 12))
    expect(why).toContain(".env (gitignored)")
    expect(why).toContain("'fake' or 'example'")
    expect(why).toContain('The person can write')
    expect(why).toContain('MAKARASTY_SECRET_GUARD=off')
  }
})

test('files that are committed are scanned: README, .env.example, .env.production, a pem, a relative path, a path with dots', () => {
  const tok = TOKENS[0]![1]
  for (const p of [`${PROJ}\\README.md`, `${PROJ}\\.env.example`, `${PROJ}\\.env.production`, `${PROJ}\\certs\\id.pem`, 'src/a.ts',
    `${PROJ}\\sub\\..\\.\\a.ts`, `${PROJ}/docs/x.md`, `${PROJ}\\.claude\\settings.json`, `${PROJ}\\src\\tester\\a.ts`, `\\\\?\\${PROJ}\\a.ts`, `${PROJ.toUpperCase()}\\a.ts`]) {
    expect([p, check(p, one(tok), ENV) === null]).toEqual([p, false])
  }
})

test('files outside the project pass: the config dir, the notify json, scratch, a sibling folder with the same prefix', () => {
  const tok = TOKENS[12]![1]
  for (const p of ['C:\\Users\\dev\\.claude\\makarasty\\notify\\telegram.json', 'C:\\Users\\dev\\.claude\\makarasty\\notify.json',
    'C:\\Users\\dev\\AppData\\Local\\Temp\\claude\\scratchpad\\x.txt', 'C:\\Users\\dev\\proj2\\a.ts', 'C:\\Users\\dev\\other\\.env.example',
    `${PROJ}\\..\\elsewhere\\a.ts`, '/home/dev/.claude/makarasty/notify/ntfy.json', 'D:\\proj\\a.ts']) {
    expect([p, check(p, one(tok), ENV)]).toEqual([p, null])
  }
  expect(check('/home/dev/proj2/a.ts', one(tok), { cwd: '/home/dev/proj', safe: [] })).toBeNull()
  expect(check('/home/dev/proj/a.ts', one(tok), { cwd: '/home/dev/proj', safe: [] })).not.toBeNull()
})

test('the config dir passes even when the session runs in the home folder; the rest of home does not', () => {
  const home: Env = { cwd: 'C:\\Users\\dev', safe: ['C:\\Users\\dev\\.claude'] }
  const tok = TOKENS[12]![1]
  expect(check('C:\\Users\\dev\\.claude\\makarasty\\notify\\telegram.json', one(tok), home)).toBeNull()
  expect(check('C:\\Users\\dev\\notes.txt', one(tok), home)).not.toBeNull()
  expect(check('C:\\Users\\dev\\.claude\\makarasty\\notify\\telegram.json', one(tok), { cwd: 'C:\\Users\\dev', safe: [''] })).not.toBeNull()
})

test('the git-ignored env files and settings.local.json pass inside the project', () => {
  const tok = TOKENS[3]![1]
  for (const p of [`${PROJ}\\.env`, `${PROJ}\\.env.local`, `${PROJ}\\.env.production.local`, `${PROJ}\\apps\\web\\.env`, `${PROJ}\\.claude\\settings.local.json`]) {
    expect([p, check(p, one(tok), ENV)]).toEqual([p, null])
  }
  // Only those names: a look-alike is committed.
  for (const p of [`${PROJ}\\.environment`, `${PROJ}\\env.local`, `${PROJ}\\.env.local.bak`, `${PROJ}\\src\\settings.local.json`]) {
    expect([p, check(p, one(tok), ENV) === null]).toEqual([p, false])
  }
})

const FAKES = [
  'sk-ant-' + 'api03-' + 'x'.repeat(40),
  'sk-ant-' + 'api03-' + 'XXXX' + R,
  'gh' + 'p_' + 'a'.repeat(36),
  'AK' + 'IA' + 'IOSFODNN7' + 'EXAMPLE',
  'sk-' + 'your_api_key_goes_here_' + R,
  'sk-' + R + 'TEST',
  'sk_' + 'live_' + 'fake' + R.slice(0, 20),
  'npm' + '_' + 'fake' + R.slice(0, 32),
  'glpat' + '-' + '1234567890' + R.slice(0, 12),
  'sk-' + 'ABCDEFGHIJ' + R,
  '123456789' + ':' + 'dummy' + R.slice(0, 30),
  'xox' + 'p-' + 'test-' + R,
  'https://discord' + '.com/api/webhooks/' + '123456789012345678/' + R.slice(0, 20) + 'example' + R.slice(0, 8),
  '-----BEGIN ' + 'EC PRIVATE' + ' KEY-----\n' + 'EXAMPLE' + 'MHcCAQEEIIrYSSNQFaA2Hwf1duRSxKtLYX5CB04fSeQ6tF1aY\n',
]
// Not a token at all: pattern text, a prefix alone, a header alone, a kebab-case word, a word that ends in `sk-`.
const PLAIN = [
  'the pattern is sk-ant-[A-Za-z0-9_-]{20,}', 'sk-(proj-)?[A-Za-z0-9_-]{20,}', 'gh[pousr]_[A-Za-z0-9]{36,}', 'github_' + 'pat_[A-Za-z0-9_]{22,}',
  '(AK' + 'IA|AS' + 'IA)[0-9A-Z]{16}', 'sk_(live|test)_[A-Za-z0-9]{16,}', 'AI' + 'za[0-9A-Za-z_-]{35}', '\\d{8,10}:[A-Za-z0-9_-]{35}',
  'discord.com/api/webhooks/<id>/<token>', 'export OPENAI_API_KEY=sk-<your key>', 'sk-ant-', 'sk-',
  'sk-' + 'spinner-wave-container-wrapper', 'ta' + 'sk-' + R, 'ri' + 'sk-' + R, 'ghp_', 'xoxb-', 'git diff --stat | grep ' + 'AK' + 'IA',
  '-----BEGIN ' + 'PRIVATE' + ' KEY-----', '-----BEGIN ' + 'PRIVATE' + ' KEY-----\n-----END ' + 'PRIVATE' + ' KEY-----',
  'see the "-----BEGIN ' + 'RSA PRIVATE' + ' KEY-----" header', '12345678:short', '2026-10-20T10:20:30:' + R, 'AK' + 'IA' + R.toUpperCase() + 'ZZ',
]

test('obvious fakes, pattern text and look-alikes are not refused', () => {
  expect(FAKES.filter((t) => check(SRC, one(t), ENV) !== null)).toEqual([])
  expect(PLAIN.filter((t) => check(SRC, one(t), ENV) !== null)).toEqual([])
})

test('the same value without a marker is refused: the markers are judged on the token body, not the prefix', () => {
  // `sk_test_` carries the word test in its prefix and is still a key.
  expect(find('sk_' + 'test_' + R.slice(0, 24))).not.toBeNull()
  expect(find('sk_' + 'test_' + 'fake' + R.slice(0, 20))).toBeNull()
  // Nine of one character is not a run; ten is.
  expect(find('gh' + 'p_' + R.slice(0, 27) + 'a'.repeat(9))).not.toBeNull()
  expect(find('gh' + 'p_' + R.slice(0, 26) + 'a'.repeat(10))).toBeNull()
})

test('mock, sample, demo and placeholder count as fake in a test path only', () => {
  const mocked = 'xox' + 'b-' + 'mock-' + R
  expect(check(SRC, one(mocked), ENV)).not.toBeNull()
  for (const p of [`${PROJ}\\tests\\a.ts`, `${PROJ}\\src\\__tests__\\a.ts`, `${PROJ}\\fixtures\\a.json`, `${PROJ}\\src\\a.test.ts`, `${PROJ}\\src\\a.spec.ts`, `${PROJ}\\test\\x\\y.ts`]) {
    expect([p, check(p, one(mocked), ENV)]).toEqual([p, null])
  }
  // A real-looking value in a test is still refused.
  expect(check(`${PROJ}\\tests\\a.ts`, one(TOKENS[8]![1]), ENV)).not.toBeNull()
  expect(check(`${PROJ}\\src\\latest\\a.ts`, one(mocked), ENV)).not.toBeNull()
})

test('only the new text is read, from every write tool', () => {
  const tok = TOKENS[0]![1]
  expect(fields({ tool: 'Write', file_path: SRC, content: one(tok) })).toEqual({ path: SRC, text: one(tok) + '\n\n', old: '' })
  expect(find(fields({ file_path: SRC, old_string: one(tok), new_string: 'const k = process.env.KEY' }).text)).toBeNull()
  expect(find(fields({ file_path: SRC, old_string: 'x', new_string: one(tok) }).text)).not.toBeNull()
  expect(find(fields({ file_path: SRC, edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: one(tok) }] }).text)).not.toBeNull()
  expect(find(fields({ file_path: SRC, edits: [{ old_string: one(tok), new_string: 'b' }] }).text)).toBeNull()
  expect(fields({ notebook_path: `${PROJ}\\n.ipynb`, new_source: one(tok) }).path).toBe(`${PROJ}\\n.ipynb`)
  expect(find(fields({ notebook_path: `${PROJ}\\n.ipynb`, new_source: one(tok) }).text)).not.toBeNull()
  expect(fields({})).toEqual({ path: '', text: '\n\n', old: '' })
  // A PEM inside a notebook's JSON has escaped line breaks.
  expect(find('"-----BEGIN ' + 'RSA PRIVATE' + ' KEY-----\\n' + 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun\\n"')).not.toBeNull()
})

// The runner gives a test no file access (no $.fs, no node:fs, no text imports), so the files are not read here: the pattern text,
// which is all they hold that could look like a secret, is. Both files were also run through find/check from node when written.
test('the pattern text of the guard matches none of its own patterns, so docs and source that quote it pass', () => {
  for (const { re } of KINDS) {
    expect([re.source, find(re.source)]).toEqual([re.source, null])
    expect([String(re), find(String(re))]).toEqual([String(re), null])
    expect(check(SRC, `const re = ${re}\n// ${re.source}\n`, ENV)).toBeNull()
  }
})

test('an OpenAI-style body needs 32+ characters and no hyphen after its first 8; a sk-proj- key keeps its hyphens', () => {
  const css = ['sk-' + 'Fade2-Wrap-Container-Layer', 'sk-' + 'ProjectAlpha2024-Settings-Panel', 'sk-' + 'Spinner2Wave-Container-Large-Delay', 'sk-' + R.slice(0, 31)]
  expect(css.filter((t) => find(one(t)) !== null)).toEqual([])
  expect(find('sk-' + R.slice(0, 32))).not.toBeNull()
  expect(find('sk-' + 'proj-' + R.slice(0, 20) + '-' + R.slice(0, 20) + '_' + R.slice(0, 10))).not.toBeNull()
  expect(find('sk-' + R.slice(0, 7) + '-' + R)).not.toBeNull()
})

test('placeholder runs are fake everywhere; ascending runs, decoy and the Stripe docs key only in test paths', () => {
  for (const t of ['sk_' + 'live_' + '1234567890' + R.slice(0, 10), 'sk_' + 'live_' + R.slice(0, 8) + 'abcdefghij' + 'Zq', 'sk_' + 'live_' + 'ABCDEFGHIJ' + R.slice(0, 8), 'sk_' + 'live_' + '0123456789' + R.slice(0, 8), 'sk-ant-' + 'oat01-' + 'DECOY-' + R]) {
    expect([t, find(t)]).toEqual([t, null])
  }
  const T = `${PROJ}\\src\\a.test.ts`
  for (const t of ['sk_' + 'live_' + '9f8e7d6c5b4a3f2e1d0c', 'sk_' + 'live_' + 'abcdef' + R.slice(0, 10),'sk_' + 'live_' + '4eC39HqLyjWDarjtT1zdp7dc', 'sk_' + 'live_' + R.slice(0, 8) + 'fedcba' + 'Qm', 'sk_' + 'live_' + R.slice(0, 8) + '987654' + 'Qm']) {
    expect([t, check(T, one(t), ENV)]).toEqual([t, null])
    expect([t, check(SRC, one(t), ENV) === null]).toEqual([t, false])
  }
  // Five in a row is not a run.
  expect(check(T, one('sk_' + 'live_' + R.slice(0, 8) + 'abcde' + 'Qm9Zx3'), ENV)).not.toBeNull()
})

test('a token the change already holds is not new: Edit old_string, MultiEdit, a Write over the same file', () => {
  const tok = TOKENS[0]![1]
  expect(check(SRC, one(tok), ENV, one(tok))).toBeNull()
  expect(check(SRC, one(tok), ENV, `before\n${one(tok)}after`)).toBeNull()
  expect(check(SRC, one(tok), ENV, one('sk-ant-' + 'api03-' + R.slice(0, 30)))).not.toBeNull()
  const f = fields({ file_path: SRC, edits: [{ old_string: one(tok), new_string: one(tok) + '// kept' }] })
  expect(check(SRC, f.text, ENV, f.old)).toBeNull()
  expect(find(f.text, false, f.old)).toBeNull()
  expect(find(f.text)).not.toBeNull()
})

test('a Google API key (public by design) is not matched; npm, GitLab and SendGrid tokens are', () => {
  expect(find('const k = "' + 'AI' + 'za' + 'SyA3b9Zq1Lm5Vx7Nc2Rt8Yh4Js6Dg0Fa8Pe"')).toBeNull()
  expect(find('npm' + '_' + R.slice(0, 35))).toBeNull()
  expect(find('SG' + '.' + R.slice(0, 21) + '.' + R.slice(0, 43))).toBeNull()
  expect(find('glpat' + '-' + R.slice(0, 19))).toBeNull()
  // Not a hit inside a longer word.
  expect(find('my' + 'npm' + '_' + R.slice(0, 36))).toBeNull()
})

test('Git Bash and WSL spellings of a drive path count as inside the project, or outside it', () => {
  const tok = TOKENS[0]![1]
  const e: Env = { cwd: 'C:\\Users\\dev\\proj', safe: ['C:\\Users\\dev\\.claude'] }
  for (const p of ['/c/Users/dev/proj/a.ts', '/mnt/c/Users/dev/proj/a.ts', '/C/Users/dev/proj/src/b.ts']) expect([p, check(p, one(tok), e) === null]).toEqual([p, false])
  for (const p of ['/c/Users/dev/other/a.ts', '/mnt/c/Users/dev/.claude/makarasty/notify/t.json', '/mnt/d/Users/dev/proj/a.ts']) expect([p, check(p, one(tok), e)]).toEqual([p, null])
  // The cwd itself in Git Bash spelling.
  expect(check('C:\\Users\\dev\\proj\\a.ts', one(tok), { cwd: '/c/Users/dev/proj', safe: [] })).not.toBeNull()
})
