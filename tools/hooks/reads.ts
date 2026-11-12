import type { Register } from 'claude-code'

// Agents read files through the shell when a dedicated tool would answer in a twentieth of the time: on the
// operator's machine 84 K of 115 K shell calls in four weeks were grep, sed, cat, ls and the like, each one
// 0.1-1 s of harness before the command ran, against 0.02-0.07 s for Read and Grep [M40]. One line, every turn.
const list = (a: readonly string[]): string => (a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a.at(-1)}` : a[0]!)
const VERB: Record<string, string> = { Read: 'Read', Grep: 'search', Glob: 'list' }
// Names only the tools the agent has: one with [Read, Edit] and no Grep or Glob must not be sent to them.
export const readsFor = (tools: readonly string[]): string => {
  const have = ['Read', 'Grep', 'Glob'].filter(t => tools.includes(t))
  return `${list(have.map(t => VERB[t]!))} files with the ${list(have)} ${have.length > 1 ? 'tools' : 'tool'}, not with cat, head, tail, sed -n, grep, rg, find or ls through Bash or PowerShell: a dedicated tool answers in about 0.02-0.07 s, a shell call costs 0.1-1 s before its command even runs, and every agent pays that on every call. Use the shell for what only a shell does: running programs, git, builds and tests.`
}
export const READS = readsFor(['Read', 'Grep', 'Glob'])

type Section = { id: string; text: string; scope: 'shared' | 'session' }

// The prompt's sections with the line added last, or as they were.
export function withReads<S extends Section>(sections: readonly S[], tools: readonly string[], off: boolean): readonly (S | Section)[] {
  return off || !tools.includes('Read') ? sections : [...sections, { id: 'makarasty-tools:reads', text: readsFor(tools), scope: 'session' }]
}

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { ...composed, sections: withReads(composed.sections, e.tools, (await $.env.get('MAKARASTY_READS')) === 'off') }
  }).catch(($, e, next) => next(e))
}
