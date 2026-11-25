import type { Register } from 'claude-code'

// The owner, 2026-11-24: a coordinator held the push and the report of three finished items behind a fourth item's
// 16:00 shots, scheduled three wakeups in that time, and started both only after «Предлагаю параллельно что-то
// делать». The parallel line reaches a chat once, at its start; a wait is where it was lost, so the note rides on the
// wait itself (context on the result, nothing denied) [M89].
export const WAIT =
  'Before this wait: list the open steps that do not need what you are waiting for (a finished piece\'s commit, push, ' +
  'report or review; the next independent piece) and start them now, in one message, before ending the turn. A piece ' +
  'that is done moves on alone; it never waits for the slowest one.'

// 2026-11-25: a chat that had the parallel line wrote five items as one serial plan, did them alone for six minutes
// («так как браузер один») and wrote the two briefs in 40 s once the owner asked; no chat wrote the shape line [M90].
// The plan is where the shape is chosen, so the note rides on the first plan of three or more steps.
export const PLAN =
  'Shape this plan now, before its first step: steps that need nothing from each other and not the one browser, test ' +
  'run or file another step holds go to subagents, all launched in one message, while you do the step that needs the ' +
  'shared thing. A shared browser, test run or another chat orders only the steps that use it, never the rest. Say the ' +
  'shape in one line: which steps run where. A step that names several items (03/07/09) is that many pieces.'
export const PLAN_MIN = 3

export const register: Register = on => {
  on('tool.call', { tool: /^(mcp__ccd_turn__update_plan|TodoWrite)$/ }, async ($, e, next) => {
    const ran = await next(e)
    const n = ((e as unknown as { items?: unknown[]; todos?: unknown[] }).items ?? (e as unknown as { todos?: unknown[] }).todos ?? []).length
    if (ran.deny !== undefined || n < PLAN_MIN || (await $.env.get('MAKARASTY_PACE')) === 'off') return ran
    return { ...ran, context: [...(ran.context ?? []), PLAN] }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'ScheduleWakeup' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || (e as unknown as { stop?: boolean }).stop === true || (await $.env.get('MAKARASTY_PACE')) === 'off') return ran
    return { ...ran, context: [...(ran.context ?? []), WAIT] }
  }).catch(($, e, next) => next(e))
}
