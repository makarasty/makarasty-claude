import { expect, test } from 'claude-code/testing'
import { NOTE_FIRST, NOTE_FOURTH, observe, scoringBrief } from './review-loop.ts'

// The opening and bar lines of a real hand-run reviewer brief (Pulse, 2026-11-20, review 27).
const PULSE = 'Fresh review 27 (round 23f) of the uncommitted Pulse answer fix. Write the verdict to b36-calls-chart.review27.md.\nBar: 9+/10 with NO defect. Return the score, defects (if any) with fix shape, and the verdict path.'

test('a hand-run scoring review brief is recognised, in English and Russian', () => {
  expect(scoringBrief(PULSE)).toBe(true)
  expect(scoringBrief('Свежее ревью диффа, поставь оценку из 10 и перечисли дефекты')).toBe(true)
})

test('a brief that already carries the ledger, a plain review and a scoring task that is no review stay quiet', () => {
  expect(scoringBrief(PULSE + '\nLedger: C:\\tmp\\ledger.md (classes and status of every earlier finding).')).toBe(false)
  expect(scoringBrief('Review this diff for bugs and report finding lines.')).toBe(false)
  expect(scoringBrief('Score the bench run: 7/10 rows pass. Write the table.')).toBe(false)
})

test('the note comes on the first and the fourth scoring brief only', () => {
  const st = { count: 0 }
  const got = [1, 2, 3, 4, 5].map(() => observe(st, PULSE))
  expect(got).toEqual([NOTE_FIRST, null, null, NOTE_FOURTH, null])
  expect(observe(st, 'Coder brief: fix the three findings in pulseTask.ts. Done when the tests pass.')).toBe(null)
  expect(st.count).toBe(5)
})
