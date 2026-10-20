---
description: Antislop mode for UI work, plus an audit of existing UI. Use on "antislop on", "антислоп", "включи антислоп", "сделай UI без слопа", "проверь UI на слоп", or to audit a screen or path for AI-looking UI.
argument-hint: on | off | status | audit <path or url>
allowed-tools: Bash(node:*), Read, Grep, Glob
---

The rules are a pinned snapshot in `${CLAUDE_PLUGIN_ROOT}/hooks/antislop/`; its license sits beside it.
`UPSTREAM.json` there holds the tag and hashes; `rule-index.md` lists every R-ID in one line. The mode's hook
and this command read the pointer `${CLAUDE_PLUGIN_ROOT}/hooks/antislop.txt`. Nothing loads while the mode is
off, and no one is ever asked a mode question.

## `on`, `off`, `status`: only when the argument is exactly that one word

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/antislop.mjs" --enable    # or --disable, or --status
```

The switch is a file in the Claude config dir, so it holds for every session and project under that dir. A
SessionStart hook injects the pointer once per session (also after `/clear` and a compaction), never per prompt.

- `on`: `--enable` prints the banner line, then the pointer. The pointer is now in this session's context:
  follow it from the next reply on. Reply with the banner line only.
- `off`: the pointer already injected stays in context. Stop following it from the next reply, and say so in
  one line.
- `status`: reply with the state line only.

## `audit <path or url>`: look at UI that already exists

Works whether the mode is on or off. It reads and reports; it changes nothing until the person picks numbers.

1. Read `${CLAUDE_PLUGIN_ROOT}/hooks/antislop/gate-hard.md` and `rules.md`. Add `ui.md` for a whole screen,
   `layoutmobile.md` when the width matters, `human.md` for contrast, keys, focus and states.
2. A path: read its UI files. A URL or a running app: open it in the browser pane and read the page; if no
   browser tool exists, say so and audit the source only.
3. Check the hard-gate list, then the purpose-gate and quality-lock blocks in `gate.md`. Look for the
   tell, never for taste: a finding names the place it breaks.
4. Print a numbered list, worst first: `n. R-xx [HIGH|MED|LOW] where - what breaks - fix`. Hard-gate rule =
   HIGH, purpose-gate = MEDIUM, quality lock = LOW. `where` is a file:line or a selector.
5. End with one question: which numbers to fix. Fix only those, then re-run the hard gate. Write no audit
   file unless asked.

## While the mode is on: the end of every UI build

Read `gate-hard.md`, check each item against what was built, fix every FAIL, and finish with this and nothing
longer (at most 10 lines):

```
antislop gate: 17/17 (N/A counts as pass)
R-25: <the worst text/background pair and its ratio>
R-26: <what every control does>
R-35: <what was run and clicked, or why the code was read instead>
```

A remaining FAIL is listed by R-ID with the reason, and the work is not called done.
