---
description: Prepare a project to run fleets: write FLEET.md, establish the agent login path, and size the machine
disable-model-invocation: true
---

The reference files named below (`docs/PROTOCOL.md` and its siblings) live in this plugin's own directory,
not in the project you are working on. Resolve that directory once, before following any pointer:

```bash
ls -dt ~/.claude/plugins/cache/*/makarasty/*/docs 2>/dev/null | head -1
```

Empty output means the plugin is running from a checkout instead of an install: look for `docs/` beside
the `commands/` directory holding this file.

Set this project up so a fleet can run against it. Everything here is discovered from the project and
confirmed with the operator; nothing is assumed.

Run it once per project, and again when the answers change.

## 1. Find out what the project is

Read the project's own index, its build scripts and its dev server configuration. You are looking for four
facts a worker cannot proceed without: the origin the application serves on, the services that must
already be running, how a person signs in, and what the project calls its features.

Report what you found and what you could not find. A missing answer is a question for the operator, not a
guess: an origin guessed wrong lands on an error page whose title still looks correct, and that failure
takes an hour to notice.

## 2. Establish an agent login path

A fleet worker signs itself in. It never asks the operator for a password, and it never has one typed for
it.

Look for an existing runbook first, conventionally `docs/HOW_TO_LOGIN_AS_AI.md`. When there is none, the
project needs one, and writing it is most of what this command exists for:

- **Ask the operator for a throwaway account** the fleet may use, on a local or sandbox environment only.
  Never a production account, and never their own. If the project has no such environment, say so and stop:
  a fleet against production is not a thing this plugin will help set up.
- **Ask them to put the credentials in a gitignored file** and tell you its path. You do not handle the
  values, you name the file.
- **Work out the sign-in path by reading the code**, and prove it from the browser once. Scripted form
  filling frequently fails in silence, because framework inputs ignore synthetic events and validation then
  blocks submit with no message, so a runbook that has never been executed is a guess.
- **Write the runbook**: the origin and its literal host, the probe that says whether this session is
  already authenticated, the sign in call, and the assertion that proves it worked. Assert an identity from
  application state rather than a URL, since landing routes differ per account and per role.

Test the probe against a signed-out session before you write it down. A probe that reads an empty string
as a signed-in session is the single most expensive defect a runbook can carry, and it is easy to write by
accident.

## 3. Write FLEET.md

At the project root, in the shape `docs/PROTOCOL.md` gives. It carries the origin, the services that must
be running, the login runbook path, the naming rules, the controls reserved for the operator, and the cost
of the project's verification commands.

**The reserved controls list is the part to get right.** Walk the project for anything that leaves the
machine: telephony, payments, email and messaging, shipping, any vendor API, production writes and
migrations. List those controls by the label a person sees, not by a general warning. Ask the operator
whether the list is complete, because they know what costs money and you are guessing from imports.

## 4. Create the run directory and ignore it

Create `.fleet/` and add it to the project's ignore file. Runs are scratch, not history.

## 5. Size the machine

Read total and free memory, core count, and whether the toolchain the project needs is present. Use the
command for this operating system from `docs/PROTOCOL.md`.

Then say a number: how many concurrent workers this machine supports, and how many the operator should
actually run.

**Those are two different numbers, and the second one is what matters.** A machine with memory compression
enabled will carry ten workers without complaint while leaving nothing for the person who owns it.
Measured 2026-08-26 on 32 GB with compression: ten workers ran, and five is what the operator chose so
they could keep using the computer. Recommend the number that leaves them their machine.

Also report the ceiling that is not about memory at all: five browser panes tile side by side at a
readable width, further ones stack below at half height, and ten is where panes stop being usable. Five or
ten, never six.

## 5b. Inventory the accelerators

Check which of these the machine has, and record the answer in `FLEET.md` so no worker spends a turn
re-detecting it.

The rule for what belongs here: **prefer a tool that removes a round trip, not one that is faster at the
same round trip.** Every tool call is a model turn, and a model turn is seconds. Saving milliseconds
inside one changes nothing; replacing four calls with one changes the run.

Worth having, in that order:

- **A structural search over the project's language.** `ast-grep` (`sg`) answers "where is this shape"
  in one call where grep plus three file reads answers it in four, and it does not match inside strings
  and comments.
- **A code knowledge graph**, where the project keeps one. One query returns a scoped subgraph instead of
  a fan of greps.
- **`rg`** for text search, which most harnesses already use underneath.
- **`fd`** for finding files by name.
- **`jq`** for reading a JSON result without writing a script.
- **`bun`**, when hooks are involved. Measured 2026-08-26: a node hook costs about 41 ms per prompt even
  when it does nothing, and that is paid on every prompt of every session.

Report the missing ones with the single command that installs each, and say plainly that none of them are
required. This is an offer, not a gate: a fleet runs fine without any of them, and a worker that stops
because `fd` is absent has invented a dependency.

Where the project already has its own faster path, that beats a general tool: record it in `FLEET.md` by
name, because a worker cannot guess that a repository ships a query tool of its own.

## 6. Prove it once

Sign in through the runbook you just wrote, in this session, and report the identity you read back. An
untested runbook is the thing every worker in every future run will trust blindly.

## Done when

`FLEET.md` exists and every fact in it was discovered or confirmed rather than assumed, the login runbook
exists and has been executed successfully once, `.fleet/` is created and ignored, and the operator has
both worker numbers with the reason for the gap between them.
