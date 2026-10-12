import type { Register } from 'claude-code'

// Picks a cheaper model for a subagent only where the caller says it is safe.
// Untagged work keeps the parent's model: on three replayed ports Sonnet tied twice
// and once closed a task the shell left open, which its own tests did not catch [M39].
export type Route = { to?: 'sonnet' | 'haiku'; why: string }

export type SpawnFacts = {
  model?: string
  parentModel: string
  subagentType: string
  description: string
  builtIn: boolean
  workflow: boolean
  fork: boolean
}

const TOP = /opus|fable/i

export function route(f: SpawnFacts): Route {
  if (f.model) return { why: 'model named' }
  if (!f.builtIn || f.workflow || f.fork) return { why: 'not a plain built-in spawn' }
  if (!TOP.test(f.parentModel)) return { why: 'parent below the top tier' }
  if (f.subagentType === 'Explore') return { to: 'haiku', why: 'locator' }
  if (f.subagentType !== 'general-purpose') return { why: 'other agent' }
  if (/^\s*\[mech\]/i.test(f.description)) return { to: 'haiku', why: 'tagged mech' }
  if (/^\s*\[exec\]/i.test(f.description)) return { to: 'sonnet', why: 'tagged exec' }
  return { why: 'untagged' }
}

type Stats = { routed: Record<string, number>; kept: Record<string, number>; last: string[] }

export const register: Register = on => {
  // Parallel spawns would each read the old stats and overwrite each other: one writer at a time.
  let writes = Promise.resolve()
  // A user's own Explore.md or general-purpose.md also reports provider "engine"; only the offer says where it came from.
  const ownNames = new Set<string>()
  on('agent.offer', ($, e, next) => {
    if (e.source !== 'built-in') ownNames.add(e.agent)
    return next(e)
  })
  on('agent.spawn', async ($, e, next) => {
    if ((await $.env.get('MAKARASTY_ROUTER')) === 'off') return next(e)
    const r = route({
      model: e.model,
      parentModel: e.parentModel,
      subagentType: e.subagentType,
      description: e.description,
      builtIn: e.provider.plugin === 'engine' && !ownNames.has(e.subagentType),
      workflow: e.workflow !== undefined,
      fork: e.fork,
    })
    const line = `${new Date().toISOString().slice(0, 16)} ${r.to ?? 'keep'} (${r.why}) ${e.subagentType}: ${e.description}`
    writes = writes.then(async () => {
      const s = ((await $.store.get('stats')) as Stats | undefined) ?? { routed: {}, kept: {}, last: [] }
      if (r.to) s.routed[r.to] = (s.routed[r.to] ?? 0) + 1
      else s.kept[r.why] = (s.kept[r.why] ?? 0) + 1
      s.last = [line, ...s.last].slice(0, 50)
      await $.store.set('stats', s)
    }).catch(() => {})
    return next(r.to ? { ...e, model: r.to } : e)
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'router', description: 'What the model router changed: counts and the last 50 spawns' })
    return next(e)
  })

  on('command.run', { command: 'router' }, async $ => {
    const s = (await $.store.get('stats')) as Stats | undefined
    if (!s) return { text: 'The router has not seen a spawn yet.' }
    return { text: `routed ${JSON.stringify(s.routed)}, kept ${JSON.stringify(s.kept)}\n${s.last.join('\n')}` }
  })
}
