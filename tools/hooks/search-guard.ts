import type { Register } from 'claude-code'

// Refuses a Glob or Grep rooted at a drive root, the home folder or its Desktop (the path, or the working folder when the
// path is left out): ripgrep walks every project's node_modules and times out after 20 s, whatever the pattern. In 14 days
// of transcripts every such Glob that timed out (`*.bat`, `**/x.md`, `ll-runs/*`) was rooted there, narrow pattern or not.
// `LiveProjects` (the folder of all projects) is refused only for a recursive Glob or a Grep with no `glob`/`type` filter.

export const MESSAGE = 'this search starts at a home, Desktop or drive root and would time out after 20 s: name the narrower folder in `path` (the project, or `.claude/projects` for transcripts), or add a glob/type filter.'

// Forward slashes, a long-path prefix and the Git Bash (/c/...) or WSL (/mnt/c/...) drive spelling read as c:/..., lower-cased, no trailing slash.
const norm = (p: string): string => p.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/^\/(?:mnt\/)?([A-Za-z])(?=\/|$)/, '$1:').toLowerCase().replace(/(.)\/+$/, '$1')

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

type Search = { tool: string; pattern?: string; path?: string; glob?: string; type?: string }

const ABSOLUTE = /^([A-Za-z]:(?:[\\/]|$)|[\\/]|~(?:[\\/]|$)|\$\{?(?:env:)?(?:HOME|USERPROFILE)\}?(?:[\\/]|$)|%USERPROFILE%)/i

// The folder the search starts in, as norm() spells it: `~`, `$HOME`, `%USERPROFILE%` are the home, a relative path is
// under the working folder, `.` and `..` are resolved, and with no path an absolute pattern starts where its first glob does.
function start(s: Search, cwd: string, home: string): string {
  let p = s.path || ''
  if (!p && ABSOLUTE.test(s.pattern ?? '')) {
    const segs = (s.pattern ?? '').split(/[\\/]/), glob = segs.findIndex((x) => /[*?[\]{}]/.test(x))
    p = (glob < 0 ? segs.slice(0, -1) : segs.slice(0, glob)).join('/') || '/'
  }
  p = p.replace(/^~(?=[\\/]|$)|^\$\{?(?:env:)?(?:HOME|USERPROFILE)\}?|^%USERPROFILE%/i, () => home)
  const full = norm(ABSOLUTE.test(p) ? p : `${cwd}/${p}`), out: string[] = []
  for (const seg of full.split('/')) {
    if (seg === '..') { if (out.length > 1 || (out.length === 1 && !/^[a-z]:$/.test(out[0]!))) out.pop() }
    else if (seg && seg !== '.') out.push(seg)
  }
  return (full.startsWith('/') ? '/' : '') + out.join('/') || '/'
}

// null = let it run, otherwise the message the model is told.
export function check(s: Search, cwd: string, home: string): string | null {
  const p = norm(start(s, cwd, home)), h = norm(home)
  if (/^([a-z]:)?\/$/.test(p) || /^[a-z]:$/.test(p) || (h && (p === h || h.startsWith(`${p}/`) || p === `${h}/desktop`))) return MESSAGE
  if (h && p === `${h}/desktop/liveprojects`) {
    const narrow = s.tool === 'Grep' ? !!(s.glob || s.type) : !(s.pattern ?? '').includes('**')
    if (!narrow) return MESSAGE
  }
  return null
}

export const register: Register = on => {
  on('tool.call', { tool: /^(Glob|Grep)$/ }, async ($, e, next) => {
    let deny: string | null = null
    try {
      if ((await $.env.get('MAKARASTY_SEARCH_GUARD')) !== 'off') {
        const i = e as Record<string, unknown>
        const home = str(await $.env.get('USERPROFILE')) || str(await $.env.get('HOME'))
        deny = check({ tool: e.tool, pattern: str(i.pattern), path: str(i.path), glob: str(i.glob), type: str(i.type) }, await $.session.cwd(), home)
      }
    } catch {
      // A bug in this guard, not a refusal: the search runs.
    }
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => next(e))
}
