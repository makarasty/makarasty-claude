import type { Register } from 'claude-code'

// A chat that runs its own "fresh reviewer, score, fix, repeat" loop never loads the review skill, so its stopping
// rules never reach it: the Pulse chats of 11-19/20 spawned 57 hand-briefed reviewers with "Bar: 9+/10 with NO
// defect" and ran 39 rounds on one fix [M83]. Scoring briefs 1, 2, 4, 8 and 16 of a session get a note (context,
// no turn, nothing denied); a brief that names its ledger file is following section 10 and is left alone.
export const note = (count: number, skill: string): string =>
  `${count === 1 ? 'This looks like a review-and-score loop.' : `Scoring review brief number ${count} in this session with no ledger file named.`} Section 10 of ${skill} governs it (Grep "^## 10" and read it; do not invoke the skill with empty arguments). Next steps: 1) round 0: freeze the criteria, start <scratchpad>/ledger.md, and for heuristic code (word lists, regex routing) a labelled set with a pass line; findings of rounds already run become the ledger's first lines; 2) each round: finders WITHOUT the ledger, then one judge WITH it that sorts their lines as new, reopened or refuted; fix per class; 3) a class that comes back after its fix gets a measured redesign, built, not proposed; stop when no blocking line is open (then one confirm round), at a plateau, or after eight rounds.`

const SCORE = /\b(?:10|[1-9])\+?\s*\/\s*10\b|\bout of 10\b|\b1\s*(?:-|to)\s*10\b|10 из 10|(?<!\bno )\bscor(?:e[sd]?|ing)\b|оцен|балл/i
const REVIEW = /\breview|\bjudge|\bverdict|\bgrade|\baudit|\bcritique|ревью|судь|провер/i
const FOLLOWS = /ledger[^\n]{0,80}\.(?:md|tsv|json)\b/i

export const scoringBrief = (prompt: string): boolean => SCORE.test(prompt) && REVIEW.test(prompt) && !FOLLOWS.test(prompt)

export type State = { count: number }
// Counts one brief and says what to add, or null.
export function observe(st: State, prompt: string, skill: string): string | null {
  if (!scoringBrief(prompt)) return null
  st.count++
  return [1, 2, 4, 8, 16].includes(st.count) ? note(st.count, skill) : null
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
    const text = observe(stateFor(await $.session.id()), String((e as unknown as { prompt?: unknown }).prompt ?? ''), `${$.plugin.root}/skills/review/SKILL.md`)
    return text ? { ...ran, context: [...(ran.context ?? []), text] } : ran
  }).catch(($, e, next) => next(e))
}
