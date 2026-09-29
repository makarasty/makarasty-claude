---
description: Strip assistant tics out of writing so it reads as a person wrote it. Use for /unslop on or off (the humanised reply mode), or when asked to unslop, de-AI or humanise a given text, file or the last reply.
argument-hint: on | off | status | <text, file path, or nothing to rewrite the last reply>
---

The rules live in one file, `${CLAUDE_PLUGIN_ROOT}/hooks/unslop.txt`. The mode's hook and this command
both read it.

## `on`, `off`, `status`: only when the argument is exactly that one word

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/unslop.mjs" --enable    # or --disable, or --status
```

The switch is a file in the Claude config dir, so it holds for every session and project under that dir,
not only this one. A SessionStart hook injects the rules once per session (also after `/clear` and after
a compaction), never per prompt.

- `on`: `--enable` prints the rules. They are now in this session's context: follow them from the next
  reply on.
- `off`: the rules already injected stay in context. Stop following them from the next reply, and say so
  in one line.
- Reply with the script's state line only.

## Anything else: a one-shot rewrite

A file path, pasted text, or nothing, which means your previous reply. `/unslop on the README` is a rewrite
of the README, not the toggle.

1. `cat "${CLAUDE_PLUGIN_ROOT}/hooks/unslop.txt"` and apply its Cut and Keep lists.
2. Keep every number, unit, identifier, path, error string, code span and negation exactly as written.
   This is a style pass, never a fact pass: a rewrite that loses a "not" or rounds a measurement has failed.
3. Keep length where the content earns it. A dense technical explanation is not slop because it is long.
4. Keep the writer's own voice when the text is someone else's. Remove tics; do not impose a personality.
5. Return the rewritten text only, with no note about what changed. For a file, write it back and say
   which file in one line.

Lines someone will say aloud to a vendor or their support are a different register: use
`/makarasty-tools:say`.

## Done when

The text says the same things, keeps every fact, and no longer opens with a compliment, closes with a
summary, or announces its own structure. For the toggle, one state line.
