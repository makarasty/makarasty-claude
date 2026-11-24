import type { Register } from 'claude-code'

// The owner, 2026-11-24: a coordinator held the push and the report of three finished items behind a fourth item's
// 16:00 shots, scheduled three wakeups in that time, and started both only after «Предлагаю параллельно что-то
// делать». The parallel line reaches a chat once, at its start; a wait is where it was lost, so the note rides on the
// wait itself (context on the result, nothing denied) [M89].
export const WAIT =
  'Before this wait: list the open steps that do not need what you are waiting for (a finished piece\'s commit, push, ' +
  'report or review; the next independent piece) and start them now, in one message, before ending the turn. A piece ' +
  'that is done moves on alone; it never waits for the slowest one.'

export const register: Register = on => {
  on('tool.call', { tool: 'ScheduleWakeup' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || (e as unknown as { stop?: boolean }).stop === true || (await $.env.get('MAKARASTY_PACE')) === 'off') return ran
    return { ...ran, context: [...(ran.context ?? []), WAIT] }
  }).catch(($, e, next) => next(e))
}
