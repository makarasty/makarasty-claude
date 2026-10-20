import type { Register } from 'claude-code'

// Refuses a Write/Edit/MultiEdit/NotebookEdit that puts a live-looking secret (API key, bot token, webhook URL,
// private key) into a file inside the project. A file in the project is committed, pasted into chats and read by
// every other session on the tree; the same value in the config dir or an environment variable is not. A function
// hook: a few regexes over the NEW text only (Write content, Edit new_string, each MultiEdit edit's new_string,
// NotebookEdit new_source), no process. The person can still write the value themselves.
//
// Every pattern needs a real value body after its prefix, so the pattern text in docs and source does not match
// itself (the commit skill's scan works the same way); a test runs this file and its test through `check`.
//
// Allowed on purpose:
//  - any file outside the working directory tree: the config dir (notify keeps its real tokens in
//    ${CLAUDE_CONFIG_DIR:-~/.claude}/makarasty/notify/*.json, and that folder passes even when the session runs in ~),
//    scratch and temp folders;
//  - inside the tree, the files git ignores by convention: `.env`, `.env.local`, `.env.<name>.local` and
//    `.claude/settings.local.json`. The project's own .gitignore is NOT read (no $.fs call, so a custom
//    ignore list is not honoured); `.env.example`, `.env.production`, `*.pem` and the rest are scanned, because
//    they are committed;
//  - a value that is obviously fake, judged on the token body after the prefix (a prefix like `sk_test_` is
//    not a marker): it contains xxxx, your_, example, dummy, fake, decoy or test (any case), a placeholder run
//    (123456789, abcdefghij) or ten of one character (AAAAAAAAAA). In a test path (a test, tests, __tests__, spec,
//    fixtures folder, or a *.test.* / *.spec.* file) mock, sample, demo, placeholder, abcdef, 123456,
//    987654, 9f8e7d, six ascending or descending characters in a row and Stripe's public docs key count too.
//    `<` and `>` are not markers: they never occur in a token body, so `sk-<your key>` is no token to begin
//    with. The markers stay few: a real key containing one by chance is a one-in-a-million event;
//  - a token that is not new: an Edit/MultiEdit whose old_string already holds it, or a Write/NotebookEdit over a
//    file that already holds it (read with $.fs after a hit; unreadable or missing = new). The guard stops NEW
//    secrets, not edits near an old fixture.
// Deviations from the plain patterns: an OpenAI-style `sk-` body must be 32+ characters with a digit and an
// upper-case letter, and without a hyphen after its first 8 (a `sk-proj-` key keeps its hyphens), so a kebab-case
// CSS class or word is no key. A Google API key (AIza prefix) is NOT matched: Firebase and Maps web keys are
// public by design and sit in committed config. A Twilio SK SID is NOT matched either: it is an identifier, and
// its secret is a bare 32-hex string no pattern can tell from a hash. No Bearer or JWT pattern: too noisy.
// Git Bash (/c/...) and WSL (/mnt/c/...) paths are read as c:/... for the inside-the-project test.
// shortcut: a secret split over two edits, or encoded, is not seen; upgrade if that bites.

export type Kind = { kind: string; re: RegExp; ok?: (body: string, whole: string) => boolean }
// The first group of each pattern is the token body, the part the fake markers are judged on.
const NL = String.raw`(?:\r?\n|(?:\\r)?\\n)` // a real line break, or one escaped inside a notebook's JSON
export const KINDS: Kind[] = [
  { kind: 'Anthropic API key', re: /(?<![A-Za-z0-9])sk-ant-([A-Za-z0-9_-]{20,})/g },
  { kind: 'OpenAI-style API key', re: /(?<![A-Za-z0-9])sk-(?:proj-)?([A-Za-z0-9_-]{20,})/g, ok: (b, w) => b.length >= 32 && /\d/.test(b) && /[A-Z]/.test(b) && (w.startsWith('sk-proj-') || !b.slice(8).includes('-')) },
  { kind: 'GitHub token', re: /(?<![A-Za-z0-9])gh[pousr]_([A-Za-z0-9]{36,})/g },
  { kind: 'GitHub fine-grained token', re: /(?<![A-Za-z0-9])github_pat_([A-Za-z0-9_]{22,})/g },
  { kind: 'AWS access key id', re: /(?<![0-9A-Z])(?:AKIA|ASIA)([0-9A-Z]{16})(?![0-9A-Z])/g },
  { kind: 'Slack token', re: /(?<![A-Za-z0-9])xox[abposr]-([A-Za-z0-9-]{10,})/g },
  { kind: 'Stripe key', re: /(?<![A-Za-z0-9])sk_(?:live|test)_([A-Za-z0-9]{16,})/g },
  { kind: 'npm token', re: /(?<![A-Za-z0-9])npm_([A-Za-z0-9]{36})(?![A-Za-z0-9])/g },
  { kind: 'GitLab token', re: /(?<![A-Za-z0-9])glpat-([A-Za-z0-9_-]{20,})/g },
  { kind: 'SendGrid API key', re: /(?<![A-Za-z0-9])SG\.([A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})/g },
  { kind: 'Telegram bot token', re: /(?<!\w)\d{8,10}:([A-Za-z0-9_-]{35})(?![A-Za-z0-9_-])/g },
  { kind: 'Discord webhook URL', re: /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/([A-Za-z0-9_-]{30,})/g },
  // The header, then (after optional `Proc-Type: ...` lines) a first base64 line.
  { kind: 'private key (PEM)', re: new RegExp(String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[ \t]*${NL})+(?:[A-Za-z-]+: [^\r\n\\]*${NL})*([A-Za-z0-9+/=]{32,})`, 'g') },
]

const FAKE = /xxxx|your_|example|dummy|fake|decoy|test|123456789|abcdefghij/i
const FAKE_IN_TESTS = /mock|sample|demo|placeholder|abcdef|123456|987654|9f8e7d|4eC39HqLyjWDarjtT1zdp7dc/i
// Six or more ascending or descending characters in a row (abcdef, 654321).
function stepped(body: string): boolean {
  const b = body.toLowerCase()
  for (let i = 1, up = 1, dn = 1; i < b.length; i++) {
    const d = b.charCodeAt(i) - b.charCodeAt(i - 1)
    up = d === 1 ? up + 1 : 1
    dn = d === -1 ? dn + 1 : 1
    if (up >= 6 || dn >= 6) return true
  }
  return false
}
const RUN = /(.)\1{9}/
const TEST_DIR = /^(tests?|__tests__|__fixtures__|fixtures?|specs?)$/i
const IGNORED = /^(\.env(\.local|\.[^/]*\.local)?)$/i

// A path with forward slashes only, a long-path prefix (backslash, backslash, ?, backslash) dropped: it is not a folder.
const slash = (p: string): string => p.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/^\/(?:mnt\/)?([A-Za-z])(?=\/|$)/, '$1:')
// Segments of `p` resolved against `base`, lower-cased (a case alias is read as the same folder: over-refuses, never lets one by).
function segs(p: string, base: string): string[] {
  const w = slash(p)
  const out: string[] = []
  for (const s of (/^(?:[A-Za-z]:)?\//.test(w) ? w : `${slash(base)}/${w}`).split('/')) {
    if (s === '..') out.pop()
    else if (s && s !== '.') out.push(s.toLowerCase())
  }
  return out
}
const under = (root: string[], p: string[]): boolean => root.length > 0 && root.length <= p.length && root.every((s, i) => p[i] === s)

// The first live-looking secret in `text`, or null. `inTests`: the file is a test or fixture. `old`: text the
// change replaces or overwrites; a token it already holds is not new.
export type Hit = { kind: string; mask: string }
export function find(text: string, inTests = false, old = ''): Hit | null {
  for (const { kind, re, ok } of KINDS) {
    for (const m of text.matchAll(re)) {
      const body = m[1] ?? ''
      if (FAKE.test(body) || RUN.test(body) || (inTests && (FAKE_IN_TESTS.test(body) || stepped(body))) || (ok && !ok(body, m[0])) || (old && old.includes(m[0]))) continue
      return { kind, mask: `${m[0].slice(0, 4)}...` }
    }
  }
  return null
}

// Where a write lands: `cwd` the session's folder, `safe` folders that always pass (the config dir).
export type Env = { cwd: string; safe: string[] }

// null = let it be written, otherwise the message the model is told.
export function check(path: string, text: string, env: Env, old = ''): string | null {
  const p = segs(path, env.cwd)
  const name = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const inTests = p.slice(0, -1).some((s) => TEST_DIR.test(s)) || /\.(test|spec)\./i.test(name)
  const hit = find(text, inTests, old)
  if (!hit) return null
  if (!under(segs(env.cwd, env.cwd), p) || env.safe.some((s) => s && under(segs(s, env.cwd), p))) return null
  if (IGNORED.test(name) || (name.toLowerCase() === 'settings.local.json' && p.at(-2) === '.claude')) return null
  return `Blocked by makarasty-tools secret-guard: ${path} would get a ${hit.kind} (${hit.mask}). A file in the project is committed, ` +
    'pasted and read by other chats. Put the value in .env (gitignored) or the config dir and read it from the environment; ' +
    "if this is a fake test value, mark it fake: include 'fake' or 'example' in it. The person can write the real value " +
    'themselves, by hand or with `!`. MAKARASTY_SECRET_GUARD=off turns this off.'
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
// The path, the new text and the replaced text of each tool: Write content, Edit new_string/old_string,
// MultiEdit edits[].new_string/old_string, NotebookEdit new_source.
export function fields(e: object): { path: string; text: string; old: string } {
  const i = e as Record<string, unknown>
  const edits = Array.isArray(i.edits) ? i.edits.map((x) => x as Record<string, unknown> | null) : []
  return {
    path: str(i.file_path) || str(i.notebook_path),
    text: [str(i.content), str(i.new_string), str(i.new_source), ...edits.map((x) => str(x?.new_string))].join('\n'),
    old: [str(i.old_string), ...edits.map((x) => str(x?.old_string))].join('\n'),
  }
}

export const register: Register = on => {
  on('tool.call', { tool: /^(Write|Edit|MultiEdit|NotebookEdit)$/ }, async ($, e, next) => {
    let deny: string | null = null
    try {
      const { path, text, old } = fields(e)
      // Cheap first: no hit even under the strictest reading (not a test path), no env or cwd call.
      if (path && find(text, false, old) && (await $.env.get('MAKARASTY_SECRET_GUARD')) !== 'off') {
        const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
        const cfg = (await $.env.get('CLAUDE_CONFIG_DIR')) || (home && `${home}/.claude`) || ''
        const file = path.startsWith('~') && home ? home + path.slice(1) : path
        // A Write or notebook edit over a file that already holds the token adds nothing new.
        const was = e.tool === 'Write' || e.tool === 'NotebookEdit' ? await $.fs.read(file).catch(() => '') : ''
        deny = check(file, text, { cwd: await $.session.cwd(), safe: [cfg] }, `${old}\n${typeof was === 'string' ? was : ''}`)
      }
    } catch {
      // shortcut: a bug in this guard (not a refusal) lets the write through rather than blocking every edit.
    }
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => next(e))
}
