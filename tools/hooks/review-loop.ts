import type { Register } from 'claude-code'

// A chat that runs its own "fresh reviewer, score, fix, repeat" loop never loads the review skill, so its stopping
// rules never reach it: the Pulse chats of 11-19/20 spawned 57 hand-briefed reviewers with "Bar: 9+/10 with NO
// defect" and ran 39 rounds on one fix [M83]. The first scoring brief of a session, and the fourth, get a note
// (context, no turn, nothing denied). A brief that already carries a ledger is following section 10 and is left alone.
export const NOTE_FIRST = 'This looks like a review-and-score loop. makarasty-tools:review section 10 governs it: 9+/10 is a gate (all criteria pass, no blocking bug), a finder searches without the ledger and a judge sorts its lines against the ledger of earlier findings and their classes, a known class in new words reopens its finding instead of counting as new, fixes go per class, heuristic code (word lists, regex routing) is judged on a frozen labelled set with a pass line, a reopened class goes to a measured redesign, and the loop stops at a plateau or after six judge rounds. Read that section before the next round.'
export const NOTE_FOURTH = 'Fourth scoring review in this session. Check makarasty-tools:review section 10.6 before spawning another: if the same classes are open again, the next step is the redesign of 10.5 (build and measure up to three shapes), not another patch round.'

const SCORE = /\b(?:10|[1-9])\+?\s*\/\s*10\b|\bscor(?:e|ing)\b|оцен|балл/i
const REVIEW = /\breview|\bjudge|\bverdict|ревью|судь/i
const FOLLOWS = /\bledger\b|section 10\b|раздел 10\b/i

export const scoringBrief = (prompt: string): boolean => SCORE.test(prompt) && REVIEW.test(prompt) && !FOLLOWS.test(prompt)

export type State = { count: number }
// Counts one brief and says what to add, or null.
export function observe(st: State, prompt: string): string | null {
  if (!scoringBrief(prompt)) return null
  st.count++
  return st.count === 1 ? NOTE_FIRST : st.count === 4 ? NOTE_FOURTH : null
}

const SESSIONS = 50
const states = new Map<string, State>()
export function stateFor(id: string): State {
  const st = states.get(id) ?? { count: 0 }
  states.delete(id)
  states.set(id, st)
  if (states.size > SESSIONS) states.delete(states.keys().next().value!)
  return st
}

export const register: Register = on => {
  on('tool.call', { tool: /^(Agent|Task)$/ }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || (await $.env.get('MAKARASTY_REVIEW_LOOP')) === 'off') return ran
    const note = observe(stateFor(await $.session.id()), String((e as unknown as { prompt?: unknown }).prompt ?? ''))
    return note ? { ...ran, context: [...(ran.context ?? []), note] } : ran
  }).catch(($, e, next) => next(e))
}
