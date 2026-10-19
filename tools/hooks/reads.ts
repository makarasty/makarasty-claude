import type { Register } from 'claude-code'

// Agents read files through the shell when a dedicated tool would answer in a twentieth of the time: on the
// operator's machine 84 K of 115 K shell calls in four weeks were grep, sed, cat, ls and the like, each one
// 0.1-1 s of harness before the command ran, against 0.02-0.07 s for Read and Grep [M40]. One line, every turn.
export const READS = 'Read, search and list files with the Read, Grep and Glob tools, not with cat, head, tail, sed -n, grep, rg, find or ls through Bash or PowerShell: a dedicated tool answers in about 0.02-0.07 s, a shell call costs 0.1-1 s before its command even runs, and every agent pays that on every call. Use the shell for what only a shell does: running programs, git, builds and tests.'

type Section = { id: string; text: string; scope: 'shared' | 'session' }

// The prompt's sections with the line added last, or as they were.
export function withReads<S extends Section>(sections: readonly S[], tools: readonly string[], off: boolean): readonly (S | Section)[] {
  return off || !tools.includes('Read') ? sections : [...sections, { id: 'makarasty-tools:reads', text: READS, scope: 'session' }]
}

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { ...composed, sections: withReads(composed.sections, e.tools, (await $.env.get('MAKARASTY_READS')) === 'off') }
  }).catch(($, e, next) => next(e))
}
