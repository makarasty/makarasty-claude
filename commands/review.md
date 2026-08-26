---
description: Review a diff, branch or file and report only findings that carry evidence. Use to review changes, review a PR, review a branch, or audit a file.
argument-hint: [diff | branch | file path | nothing for the working tree]
allowed-tools: Bash, Read, Grep, Glob
---

Review what `$ARGUMENTS` names. Nothing given means the working tree against its merge base.

One line per finding. No praise, no summary of what the change does, no restating the diff.

## Format

```
path:line: <severity>: <problem>. <fix>.
```

Severity is `bug`, `risk`, `nit`, or `q` for a question you cannot answer from the diff alone.

Nothing wrong: say `LGTM` and stop. That is a complete review and it takes one line.

## The bar

**A finding names the input that breaks it.** "This could fail with unexpected input" is not a finding.
"Empty array reaches line 40, `arr[0]` is undefined, `.id` throws" is. If you cannot describe the case that
goes wrong, you have a feeling rather than a finding, and it belongs in a question instead.

**Read enough to be right.** A diff shows changed lines, not the function they live in. Before calling
something a bug, read the surrounding code, the caller, and any guard that might already handle it. Most
review findings that turn out wrong were written from the diff alone.

**Check what the diff removed**, not only what it added. A deleted guard, a dropped await, an error branch
that quietly became a success path.

**Look for the two failures that survive review most often**: an empty string or empty array treated as
absent, since `??` and `||` disagree about that; and a `catch` that turns a thrown query into an empty
result the caller then reports as no data.

## Scope

Review the change in front of you. Refactors the author did not ask for are not findings, and neither is
a style preference the repository does not enforce.

Skip formatting entirely unless it changes meaning: a moved brace that alters scope counts, a reordered
import does not.

Match the repository's conventions rather than your own. Read a few neighbouring files before calling
something wrong; what looks like a mistake is often this codebase's house style.

## Tests

A change to exported logic with no test is a `risk` finding, once, naming the file. A bugfix with no
reproducing test is a `bug` finding, because nothing stops it coming back.

## Done when

Every changed file has been read in context rather than as a diff hunk, and every finding names a concrete
failing case. Order the output by severity.
