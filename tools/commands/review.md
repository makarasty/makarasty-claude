---
description: Evidence-only correctness review of a diff, branch, PR number or file, one line per finding, each naming the input that breaks it. Use when asked to review changes, a branch or a PR for bugs. Not for style, over-engineering or security audits.
argument-hint: [nothing | <branch> | <PR number> | <file path>] [--quick] [--fix]
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git status:*), Bash(git merge-base:*), Bash(git rev-parse:*), Bash(git ls-files:*), Bash(git symbolic-ref:*), Bash(gh pr diff:*), Bash(gh pr view:*), Read, Grep, Glob, Agent, Edit
---

Review what `$ARGUMENTS` names. Report findings only. No praise, no summary of the change, no restating
the diff.

## 1. Resolve the target

`<default>` is `origin/HEAD` if it resolves, else `main`, else `master`.

| Argument | What to review |
|---|---|
| nothing | `git diff $(git merge-base HEAD <default>)` for committed, staged and unstaged changes, plus every file in `git ls-files --others --exclude-standard`, read whole |
| a branch | `git diff <default>...<branch>` (three dots: the branch's own changes since it left the default branch) |
| a number | `gh pr diff <n>`; `gh pr view <n>` for the stated intent |
| a path | the whole file, as it is now |

An empty diff or a ref that does not resolve: say so in one line and stop.

## 2. Size gate

Run `git diff --stat` (or count the PR's files) first. Up to about 15 files and 800 changed lines: review
inline. Above that, split the files into groups of related files and give each group to a subagent with this
command's bar and format; each returns its findings as lines in the format below. Merge them and drop duplicates.

## 3. Find

Read every changed file in context, not only the hunk: the function around it, its callers, and any
guard that might already handle the case. Most wrong findings were written from the diff alone.

- **Check what the diff removed**: a deleted guard, a dropped `await`, an error branch that became a
  success path.
- **The two failures that survive review most often**: an empty string or empty array treated as absent
  (`??` and `||` disagree about it), and a `catch` that turns a failed query into an empty result the caller
  reports as "no data".
- **Match the repository's conventions**, not your own. What looks wrong is often house style: read a
  neighbouring file before calling it a mistake.

Out of scope: refactors nobody asked for, formatting that does not change meaning, style the repository
does not enforce.

## 4. Verify (skip with `--quick`)

Try to disprove each candidate before reporting it. Open the caller, the guard, the type, the test that
might already cover it, and look for the reason it cannot happen. Then:

- the failing input is reachable and nothing stops it: keep it as `bug` or `risk`;
- you cannot find the guard but cannot build the input either: report it as `q`;
- you found the guard: drop it.

## 5. Report

```
path:line: <bug|risk|q> [high|med]: <problem>. breaks on: <the input or sequence>. fix: <the change>.
```

- `bug`: a reachable input gives wrong behaviour now. `risk`: it breaks under a plausible change or load.
  `q`: a question the code alone cannot answer. No `nit`.
- `[high|med]` is how sure the verify pass left you. A low-confidence finding is a `q`.
- Order: `bug`, then `risk`, then `q`; high before med.
- Missing tests: at most one `risk` per review, and only where neighbouring code has tests. It still names
  the case that goes untested.
- Nothing survived: `LGTM` and stop.

## 6. `--fix`

After the report, apply the fix for each `bug [high]` finding with Edit, the smallest change that closes the
named input. Leave `risk` and `q` to the author. Then list the files changed. Without `--fix`, never edit.

## Done when

Every changed file was read in context, every reported finding survived the verify pass (unless
`--quick`), and every finding names the input that breaks it.
