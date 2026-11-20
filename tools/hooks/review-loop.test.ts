import { expect, test } from 'claude-code/testing'
import { note, observe, scoringBrief } from './review-loop.ts'

const SKILL = 'C:/plugins/makarasty-tools/skills/review/SKILL.md'
// The opening and bar lines of a real hand-run reviewer brief (Pulse, 2026-11-20, review 27).
const PULSE = 'Fresh review 27 (round 23f) of the uncommitted Pulse answer fix. Write the verdict to b36-calls-chart.review27.md.\nBar: 9+/10 with NO defect. Return the score, defects (if any) with fix shape, and the verdict path.'

test('hand-run scoring review briefs are recognised in their usual wordings, English and Russian', () => {
  expect(scoringBrief(PULSE)).toBe(true)
  expect(scoringBrief('Свежее ревью диффа, поставь оценку из 10 и перечисли дефекты')).toBe(true)
  expect(scoringBrief('Audit the change and grade it out of 10.')).toBe(true)
  expect(scoringBrief('The judge scores each criterion; aim for 10 из 10.')).toBe(true)
})

test('a brief naming its ledger file, a plain review and a scoring task that is no review stay quiet', () => {
  expect(scoringBrief(PULSE + '\nLedger: C:\\tmp\\scratch\\ledger.md (classes and status of every earlier finding).')).toBe(false)
  expect(scoringBrief(PULSE + '\nKeep a ledger in mind.')).toBe(true)
  expect(scoringBrief('Review this diff for bugs and report finding lines.')).toBe(false)
  expect(scoringBrief('Score the bench run: 7/10 rows pass. Write the table.')).toBe(false)
  expect(scoringBrief('You are a FINDER: find defects in the code under review. Write your report. No score.')).toBe(false)
})

test('the note comes on scoring briefs 1, 2, 4 and 8, names the skill file, and skips other briefs', () => {
  const st = { count: 0 }
  const got = Array.from({ length: 9 }, () => observe(st, PULSE, SKILL))
  expect(got.map(g => g !== null)).toEqual([true, true, false, true, false, false, false, true, false])
  expect(got[0]).toBe(note(1, SKILL))
  expect(got[0]!.includes(SKILL)).toBe(true)
  expect(observe(st, 'Coder brief: fix the three findings in pulseTask.ts. Done when the tests pass.', SKILL)).toBe(null)
  expect(st.count).toBe(9)
})
