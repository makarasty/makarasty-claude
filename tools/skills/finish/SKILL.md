---
description: The end of a task in one command - review this chat's change until a round finds nothing, red team it, fix what holds, run the narrow tests, then commit under the person's own name and push. Use on "проведи ревью, красную команду, по кругу, закоммить от меня и запушь", "доведи до идеала и запушь", "финализируй", "finish this". A review alone is /makarasty-tools:review; a commit alone is /makarasty-tools:commit; a bare push, or "fix the tests and push" with no review asked, is /makarasty-tools:ship.
argument-hint: [--no-push] [--no-redteam]
---

The person ends almost every task with the same sentence: review in a loop, red team, fix everything,
commit as me, push only mine. Each step is its own skill; this runs them in order and stops where one
cannot go on. Keep the steps below as a task list, and run each skill with the Skill tool
(`skill: makarasty-tools:review`, `args: --loop`), so the list survives a long nested step.

First write down the files this chat changed; every step works on that list and nothing else, since other
chats may have uncommitted work in the same checkout.

1. **Review**: `makarasty-tools:review` with `--loop`, on the list.
2. **Red team**: `makarasty-tools:redteam` with `--fix`, on the list, unless `--no-redteam` or the change
   is only a typo, a comment, a README line or a version bump. A changed skill or hook is a prompt for a
   model and gets the red team. When the red team changed files, run `makarasty-tools:review` once more,
   without `--loop`, on those files.
3. **Tests**: the test files that cover the changed files, never the whole suite, once, after checking no
   other test or typecheck is live on the machine, with a hard timeout of about twice their normal time.
   No covering test (a skill, a doc): say so and run nothing. A failure re-enters step 1 for the failing
   files only, once; a second failure stops here and is reported. Nothing is committed after a failing test.
4. **Ship**: `makarasty-tools:ship` with `mine` commits only the listed files under the person's name.
   Before it pushes, `git log --oneline @{u}..HEAD`: commits this run did not make would be pushed too, so
   name them and ask once. Invoking finish without `--no-push` is the request to push, on the default
   branch too. A protected-branch rejection is reported with ship's pull-request offer, never retried.
   With `--no-push` or "без пуша", `makarasty-tools:commit` instead.

Steps 2 and 4 run once per finish. The questions and medium risks that review or the red team leave go into the report; they do not stop the run. A step that stops (a finding that needs a decision, a rejected push)
is asked or reported right there; the steps after it do not run on a half-finished change.

## Report

A change to UI files with a pane at hand gets a `/makarasty-tools:proof` report of before and after, linked here.
One block, in the person's language: review rounds and what they fixed, red-team findings kept and
fixed, the test command and its result, the commit hash and where it was pushed. Then what was not run.

## Done when

Every step ran or the report says which stopped and why, nothing outside the list was edited or
committed, and nothing was committed after a failing test.
