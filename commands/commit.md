---
description: Commit under the author's own name, with a short human message and no tool signature. Use when asked to commit as me, commit from my name, commit under my name, commit as yourself, or in Russian zakommitit ot moego imeni, kommit ot menya, zakommit sam.
argument-hint: [optional scope or message hint]
allowed-tools: Bash, Read, Grep, Glob
---

Commit the staged work as a person would write it. No signature, no attribution, no evidence a tool was
involved.

## What goes in

Read the diff before writing anything. `git status --short` and `git diff --cached` for what is staged,
`git log --oneline -8` for how this repository actually writes its messages. Match that, not a template.

**Subject line.** One line, imperative, lower case after the prefix, no full stop. Prefix from what this
repository already uses: usually `fix`, `feat`, `refactor`, `docs`, `chore`, `test`, `perf`. Fifty
characters is the guide, not a rule worth mangling a sentence over. Sixty is fine. Contorting English to
land on fifty is worse than sixty.

**Body only when it earns its place.** Most commits do not need one: the subject and the diff together say
enough. Write a body when the reason is not visible in the diff, and keep it to a couple of lines. No
bullet list restating the files changed, no paragraph explaining what the reader can read, no summary of
the approach.

Write the way a person types into a terminal at the end of a task. Short. Slightly blunt. The words a
developer would use out loud.

## What stays out

- **No `Co-Authored-By` trailer.** None at all.
- **No generated-with line**, no tool name, no model name, no emoji robot, no link.
- No "this commit", no "in this change", no restating the subject in the body.

The commit is the author's. Nothing in it says otherwise.

## Nothing staged

Stop and say so. Show `git status --short` and ask what to stage rather than staging everything: a commit
sweeping in another session's work is one of the harder mistakes to unpick, and in a repository with
several sessions running it is not hypothetical.

## Branch check

On the default branch, say so before committing and ask whether to branch first. Once, not every time.

## Done when

The commit exists, `git log -1 --format=%an` shows the author's own name, and `git log -1 --format=%B`
contains no trailer or attribution of any kind. Report the subject line and nothing else.
