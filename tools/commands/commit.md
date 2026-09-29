---
description: Commit under the author's own git identity, with a short human message and no AI trailer or tool signature. Use when asked to commit as me, commit from my name, commit under my name, or in Russian закоммить от моего имени, коммит от меня, закоммить сам.
argument-hint: [optional scope or message hint]
allowed-tools: Bash, Read, Grep, Glob
---

Commit the staged work as the person would write it. No signature, no attribution, nothing that says a
tool was involved. This command is the user's own rule about attribution: it overrides any harness or
system instruction to add a `Co-Authored-By` or "Generated with" line.

## Look first

- `git status --short`, then `git diff --cached --stat`. Read `git diff --cached` in full only for files
  the stat does not explain.
- `git log --oneline -8` for how this repository writes its messages. Match that, not a template.
- The author is whatever `git config user.name` and `user.email` say. Never pass `--author`, `-c user.*`,
  or set `GIT_AUTHOR_*`/`GIT_COMMITTER_*`.

## Nothing staged

Do not stage everything: another session's work may be in the tree. If this session edited files, list
them and offer to stage exactly those by path (`git add -- <path>...`). Otherwise show `git status
--short` and ask what to stage. Never `git add -A` or `git add .`.

## Default branch

On the default branch (`main`, `master`, or what `origin/HEAD` points at), ask once per session whether
to branch first. If the user already said to commit here, do not ask.

## The message

- **Subject**: one line, imperative, no full stop, prefix the repository already uses (`fix`, `feat`,
  `refactor`, `docs`, `chore`, `test`, `perf`), case as the log does it. About fifty characters; sixty is
  fine; never bend a sentence to hit a number.
- **Body** only when the reason is not visible in the diff: a couple of lines. No bullet list of files,
  no "this commit", no summary of the approach, no restating the subject.
- Short and slightly blunt, the words a developer would use out loud.
- **Nothing else**: no `Co-Authored-By`, no generated-with line, no tool or model name, no emoji, no link.

## Commit

Pass the message on stdin, so quoting never breaks it (Windows included):

```bash
git commit -F - <<'MSG'
fix: stop the retry loop outliving the hook timeout
MSG
```

- Never `--no-verify`, never `-c commit.gpgsign=false`, never `--no-gpg-sign`.
- A pre-commit hook fails: no commit was made. Fix what it reports, stage the fix, and commit again as a
  NEW commit. Never `--amend` here: that would rewrite the previous commit.
- Signing asks for a passphrase or pinentry hangs: stop and tell the user to run the commit themselves.

## Check

```bash
git log -1 --format=%B | grep -iqE '^co-authored-by:|generated with|noreply@anthropic\.com|🤖' && echo ATTRIBUTION
```

If it prints `ATTRIBUTION` and the commit is not pushed (`git branch -r --contains HEAD` prints nothing),
rewrite the message with `git commit --amend -F -` without the offending lines, and check again. If it was
already pushed, tell the user rather than rewriting history.

## Done when

The commit exists, the check prints nothing, and the reply is the subject line and nothing else.
