import type { Register } from 'claude-code'

// Refuses a Write/Edit/MultiEdit/NotebookEdit of a compiled file. `<cwd>/src/build.sha256` (this plugin's build
// manifest, lines `<64 hex>  <relpath>`) lists every source AND every output; an edit of an output (.mjs, .js) is
// lost at the next build and leaves the manifest check STALE. Sources (.mts, .ts) are listed too and stay editable.
// No manifest in the folder (any other repo) = allow. A function hook: one small file read, only for these tools.
// shortcut: the path match is case-insensitive on every OS (over-refuses a case alias on Linux, never lets one by).

export const MESSAGE = 'compiled output (listed in src/build.sha256): edit the .mts/.ts source, then npm run build --prefix src'

// Forward slashes, a long-path prefix and the Git Bash (/c/...) or WSL (/mnt/c/...) drive spelling read as c:/..., lower-cased.
const norm = (p: string): string => p.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/^\/(?:mnt\/)?([A-Za-z])(?=\/|$)/, '$1:').toLowerCase()

// `path` relative to `cwd`, `..` and `.` resolved; null when it lies outside.
function rel(path: string, cwd: string): string | null {
  const c = norm(cwd).replace(/\/+$/, '')
  const w = norm(path)
  const out: string[] = []
  for (const s of (/^(?:[a-z]:)?\//.test(w) ? w : `${c}/${w}`).split('/')) {
    if (s === '..') out.pop()
    else if (s && s !== '.') out.push(s)
  }
  const root = c.split('/').filter(Boolean)
  return root.length <= out.length && root.every((s, i) => out[i] === s) ? out.slice(root.length).join('/') : null
}

// null = let it be written, otherwise the message the model is told. `manifest`: the file's text, null when there is none.
export function check(path: string, cwd: string, manifest: string | null): string | null {
  if (!manifest || !/\.m?js$/i.test(path)) return null
  const r = rel(path, cwd)
  if (!r) return null
  for (const line of manifest.split(/\r?\n/)) {
    const m = /^[0-9a-f]{64}\s+(.+?)\s*$/i.exec(line)
    if (m && norm(m[1]!) === r) return MESSAGE
  }
  return null
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export const register: Register = on => {
  on('tool.call', { tool: /^(Write|Edit|MultiEdit|NotebookEdit)$/ }, async ($, e, next) => {
    let deny: string | null = null
    try {
      const i = e as Record<string, unknown>
      const path = str(i.file_path) || str(i.notebook_path)
      if (/\.m?js$/i.test(path)) {
        const cwd = await $.session.cwd()
        const manifest = await $.fs.read(`${cwd}/src/build.sha256`).catch(() => null)
        deny = check(path, cwd, typeof manifest === 'string' ? manifest : null)
      }
    } catch {
      // shortcut: a bug in this guard (not a refusal) lets the write through rather than blocking every edit.
    }
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => next(e))
}
