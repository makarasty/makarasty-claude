---
description: How to refactor, remove duplication and write tests so the code gets simpler and stays protected - behaviour pinned before a change, an abstraction only where knowledge repeats, tests seen failing before they are trusted. Use on "отрефактори", "сделай dry", "без костылей", "покрой тестами", "закрой тестом, чтобы не повторилось", "тупые тесты", "refactor", "DRY this", "add unit tests for X", or when judging whether tests are worth keeping. Tests for existing code and regression tests are craft; a new feature built red-green is tdd.
---

These are the points where a capable model still slips on this kind of work. Everything else, use your
own judgement and the project's conventions; where the project has a rule, it wins over this file, and
when the `tdd` skill is in play, its agreement on test seams comes first.

## Refactor

- **Pin behaviour first.** Run the tests that cover the code you will move before you start. None: write
  a characterization test through the public entry point that records what the code does today, odd
  results included, and keep it until the refactor is done.
- **Behaviour and structure in separate commits.** A reviewer can then check the refactor commit for
  "nothing changed" and the other for what did.
- **A bug found on the way gets its own fix and test**, not a silent change inside the move.

## Duplication

- **Duplicated knowledge, not duplicated text, is the problem.** Two pieces that look alike but change
  for different reasons stay separate. Two that must always change together are one piece, even if they
  look different.
- **Extract on the third copy**, or on the second when both already changed together once.
- **The wrong abstraction costs more than the copy.** A shared helper growing flags and branches for each
  caller is the sign: inline it back into the callers, then extract what is really common.

## Tests

- **A test must be able to fail.** Before you keep it, break the code it guards (flip the condition,
  return early, drop the fix) and watch it go red, then restore. A test that stays green is deleted or
  rewritten. A test that passes for a reason other than the code being right (a fixture that happens to
  match, a regex that strips the thing it checks) is the same case.
- **Assert what a caller can observe.** A test that reads private state or counts internal calls breaks
  on every refactor and catches nothing.
- **Not worth writing**: asserting that a mock returns what it was told to; a snapshot of whatever the
  code prints today with nobody reading it; testing the framework or the language; one test per getter.
- **A bug fix starts with the failing test** that reproduces the report; it passes only after the fix.
- **One reason to fail per test**, a name that says the behaviour (`rejects an expired token`), inputs at
  the edges that matter here: empty, one, many, the boundary value, Unicode, a time zone, two callers.
- **Deterministic**: no real clock, network or sleep; inject them. A flaky test is a failing test.

## Done when

The pinned behaviour still passes, every new test was seen failing once, the diff holds no change the
task did not need, and shared pieces were checked at every use.

Status: written from the owner's chats and published testing practice; not yet measured against a
baseline with `forge/ab.mjs`.
