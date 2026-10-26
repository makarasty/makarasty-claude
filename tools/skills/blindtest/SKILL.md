---
description: Usability check by first-time users who never saw the app - agents with no access to the code try plain-language tasks on the live screen, and fixes are re-run to prove the screen got easier. Use on "проверь тупым агентом", "слепой агент", "как тупой пользователь", "пусть новичок разберётся", "blind test the UI", "is this screen understandable".
argument-hint: [screen or route] [tasks in plain words] [--fix]
---

The people who build a screen know what every element is for, so they cannot see where a newcomer gets
lost. A model that read the code is the same. A user who has only the screen is not, and two different
users stumbling at the same place is a fact about the screen. One of them alone is often noise, and a
screen fixed for every single complaint fills up with hints, banners and buttons, which is worse. These
are usability observations, not design findings: the design gate in the fleet's DESIGN.md still applies.

## 1. Set it up

Needs the makarasty plugin (its `fleet-naive-user` agent) and a browser pane.

- **Tasks**: three by default, at most five: goals a real user of this screen has, in their words, with no
  label from the UI ("find the phone number of a patient", not "open the Contacts tab"), each with one
  line of what done looks like (the screen and heading it ends on). Take them from the argument or the
  conversation; otherwise write them from what the screen is for and show them before running. A task
  that would change data ends before the final confirm, on a seed account or data the person says is
  disposable.
- **Role**: the job the real users have ("clinic receptionist"). Users know the job, not the app.
- **Screen**: the route, reached logged in (`/makarasty:fleet-login` first when the pane is not), with the
  data a user would see, in this chat's foreground tab.
- **Users**: three fresh `makarasty:fleet-naive-user` agents, one `sonnet` and two `haiku`, each call with
  its `model`, `effort: medium` and `run_in_background: false`, one after another, since one chat has one
  live pane. Each gets only the start URL, the `tabId`, the viewport, the role and the tasks, the order
  rotated per user; never a file path, the code or another user's results.
- **Before each user**: navigate to the start URL, reload, and run the frame check twice a second apart
  (`docs/BROWSER.md` in the makarasty plugin): under ten frames, stop. Name any first-visit state a reload
  does not reset (dismissed tips, remembered filters) in the report. Read the viewport with
  `innerWidth`/`innerHeight` and pass it. After each user, check the frames once more; a user who ran on a
  dead pane, or returned `blocked`, is replaced and not counted.

## 2. Judge

On the top model of the chat (`fable`, else `opus`), which also writes the proposals and makes the edits.

1. Check every quote a user gave against the page (`document.body.innerText.includes(...)`); a quote that
   is not there is dropped. Check each `done` against the task's done-looks-like; a wrong end screen is
   `gave_up`.
2. An observation counts when users on two different models hit the same quoted place (lost at it,
   misread the same label, looked for the same missing thing). A single `gave_up` counts only when the
   other users needed more than ten actions on that task. A "misread" of a term the role uses every day is
   dropped. Everything else is listed as single, not acted on.
3. For each counted observation, the smallest change that answers it, in this order: reword the label
   they misread; move the thing to where they looked; hide or remove the noise they named; merge two
   things they confused. Add an element only when two users looked for something that does not exist.
   Explanatory text, tooltips, banners and onboarding are a last resort, named as such. Every change uses
   the project's own components and style and names the observation it answers.

## 3. Fix and re-run

Before the fix, read in one expression the count of visible interactive elements and visible text
characters on each task's screens. Ask in one AskUserQuestion (multi-select, strongest evidence first)
which proposals to apply; `--fix` applies renames and moves without asking, never removals, merges or
additions. After the fix, re-run only the tasks a change touched, plus one untouched task as a control,
with fresh users on the same models, and read the same counts.

A task got worse when fewer users finished and the median actions rose by more than half, or two users on
different models now share a new place they got lost; its changes are reverted and it is re-run once. If
the element or text count rose and no fewer users got lost, the change that added them is reverted. A
changed result on the control task means the difference is noise: say so instead of claiming a gain.

## Report

With a pane, `/makarasty-tools:proof` records each task's screen before and after the fix as numbered blocks.
Per task, before and after: users who finished out of N, median actions, where they got lost. Then the
changes made, each with its observation; the single observations left alone; the control task's result;
and what was not checked (a theme, a viewport, a role, first-visit state).

## Done when

Every task was tried by every counted user before, and the touched ones after; each change answers an
observation two users on different models shared; nothing got worse or added clutter without a gain; and
the report names what was left alone.
