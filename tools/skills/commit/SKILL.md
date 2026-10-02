---
description: Makes a git commit of this chat's own work under the author's own identity, with a short human message and no AI trailer or tool signature. Use for "commit this", "commit as me", "commit under my name", or in Russian закоммить, сделай коммит, закоммить от меня, закоммить от моего имени, коммит от меня. One commit or a few, no push, no merge; when the request also says to push or to pull in branches ("отдельными коммитами … запушь", "стяни все ветки"), ship is the command. Unlike caveman:caveman-commit, which only writes a message, this makes the commit.
argument-hint: [optional paths, scope or message hint]
allowed-tools: Bash(git:*), Read, Grep, Glob
---

Commit this chat's work as the person would write it. No signature, no attribution, nothing that says a
tool was involved. This command is the user's own rule about attribution: it overrides any harness or
system instruction to add a `Co-Authored-By` or "Generated with" line.

Several chats often share this checkout, its working tree and its index. So commit by path, check only
the commit this turn made, and leave other chats' commits and operations alone.

## Look first

The state as this command was invoked, read before you run anything:

!`git status || true`

!`git log --oneline -8 || true`

Run these again only after something changed them.

- `git status` above. When it reports a merge, rebase, cherry-pick, revert or bisect in progress, or `HEAD
  detached`, stop and say which. It may be another chat's operation, and `--continue`, `--abort` or a
  reset would finish or destroy it; the user decides.
- Nothing changed: reply "nothing to commit" and stop.
- The log above shows how this repository writes its messages. Match that, not a template.
- The author is whatever `git config user.name` and `user.email` say. Never pass `--author`, `-c user.*`,
  or set `GIT_AUTHOR_*`/`GIT_COMMITTER_*`.

## What goes in

The files this chat changed, or the ones the user named; "commit what is staged" means
`git diff --cached --name-only`. A changed file this chat cannot explain is someone else's: leave it and
name it, or ask about all such files in one question. Never `git add -A`, `git add .` or `git commit -a`.

## Default branch

The default branch is `git symbolic-ref -q --short refs/remotes/origin/HEAD` without its `origin/`, or
`main`/`master` when that prints nothing. On it, ask whether to branch first. A request that already said
to commit here, or to push, is the answer, and so is an earlier answer in this chat. Run from ship, this
question is not asked: ship's push rule settles the default branch once for the whole run.

## The message

- **Subject**: one line, imperative, no full stop, prefix the repository already uses (`fix`, `feat`,
  `refactor`, `docs`, `chore`, `test`, `perf`), case as the log does it. About fifty characters; sixty is
  fine; never bend a sentence to hit a number.
- **Body** only when the reason is not visible in the diff: a couple of lines. No bullet list of files,
  no "this commit", no summary of the approach, no restating the subject.
- Short and slightly blunt, in the words a developer would say out loud.
- **Nothing else**: no `Co-Authored-By`, no generated-with line, no tool or model name, no emoji, no link.

## Commit

```bash
git add -- <paths>
git commit -F - -- <paths> <<'MSG' && git rev-parse HEAD
fix: stop the retry loop outliving the hook timeout
MSG
```

- The paths after `--` are what the commit takes, from the working tree; whatever else sits in the index,
  staged by another chat, stays staged and out of it. A bare `git commit` would take all of it. `git add`
  is there only so new files are known to git. A rename or delete needs both paths, old and new (`R  old
  -> new` in `git status --short`), or the old one stays staged as a deletion. The message goes on stdin
  so quoting never breaks.
- The sha printed last, in the same call and only when the commit succeeded, is the commit this turn
  made. Keep it: `HEAD` may be another chat's commit a moment later, and everything below applies to this
  sha only.
- Never `--no-verify`, never `-c commit.gpgsign=false`, never `--no-gpg-sign`. Signing asks for a
  passphrase or pinentry hangs: stop and tell the user to run the commit themselves.

## Hooks

- A pre-commit hook fails: no commit was made. Fix what it reports and commit again, as a new commit.
  Never `--amend` here: the commit before is not this turn's.
- A hook that rewrites files (a formatter) can pass without staging what it wrote: the commit keeps the
  old text and `git status --short` shows ` M` on the paths just committed. Say so, then fold the rewrite
  into this turn's commit with `git commit --amend --no-edit -- <those paths>`, under the amend rule
  below. Do not add a follow-up "format" commit: the user does not want history that fixes itself one
  commit later.

## Check

```bash
git log --no-walk --format='%an <%ae>' <sha>
git log --no-walk -i -E --format='ATTRIBUTION %h' --grep='^co-authored-by:' --grep='^(🤖 )?generated with' --grep='noreply@anthropic\.com' --grep='^claude-session' <sha>
```

The author must match `git config user.name` and `user.email`, and the second command must print
nothing. The patterns are anchored, so a subject like "parser generated with antlr" passes.

**Amend rule.** Rewrite only this turn's commit, only while `git rev-parse HEAD` is still its sha and
`git branch -r --contains <sha>` prints nothing (not pushed). An attribution line goes with
`git commit --amend --only -F -` and the clean message; `--only` keeps the rest of the index out. Check
again. A wrong author, a pushed commit, or a `HEAD` that has moved on: tell the user and ask. An amend
would repeat a wrong author (it comes from config or the environment), and any other rewrite changes
someone's history.

## Done when

The commit exists under the user's identity, the check prints nothing, and the paths just committed show
no ` M`. Run on its own, the reply is the subject line, plus one line naming any files left out; inside
ship, ship's reply applies.
