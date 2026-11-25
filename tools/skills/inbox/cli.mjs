// Where the Claude CLI that runs the inbox's own sessions lives: shared by inbox.mjs and the Telegram watcher. Not in
// core.mjs, which the hook engine imports and which must stay free of node:fs.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Several accounts run side by side as separate app windows, one profile folder each (launched with --user-data-dir).
export const profilesDir = () => process.env.INBOX_PROFILES_DIR || join(process.env.LOCALAPPDATA || '', 'Claude-Profiles')
export const bundledCli = (/** @type {{name: string, dir: string}} */ prof) => {
  if (process.env.INBOX_CLAUDE) return process.env.INBOX_CLAUDE
  const top = join(prof.dir, 'claude-code'), ver = (/** @type {string} */ v) => v.split('.').map((n) => Number(n) || 0)
  try {
    const vs = readdirSync(top).sort((a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0); return 0 }) // newest first
    for (const v of vs) for (const h of readdirSync(join(top, v))) { const exe = join(top, v, h, 'claude.exe'); if (existsSync(exe)) return exe }
  } catch { /* no bundled CLI */ }
  return 'claude'
}
// The profile whose CLI runs the inbox's own sessions: main, else the first real profile (one with claude-code or claude-code-sessions
// inside; a folder like apps, holding app copies, is not one). Undefined: no app profiles, the CLI on PATH.
export const mainProf = () => { /** @type {string[]} */ let p = []; try { p = readdirSync(profilesDir()) } catch { /* no app profiles */ } return p.includes('main') ? 'main' : p.find((n) => existsSync(join(profilesDir(), n, 'claude-code')) || existsSync(join(profilesDir(), n, 'claude-code-sessions'))) }
export const mainCli = () => bundledCli({ name: mainProf() ?? '', dir: join(profilesDir(), mainProf() ?? '') })
