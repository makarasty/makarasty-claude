# hold: formats and verbs

`node "${CLAUDE_SKILL_DIR}/hold.mjs" <verb> ...`. The folder is `$CLAUDE_CONFIG_DIR/makarasty/hold/<id>/`; the
id is `--sid`, else `$CLAUDE_CODE_SESSION_ID`, else `$CLAUDE_SESSION_ID`. An empty or unsubstituted id and the
hold root itself are refused. `--dir <path>` names a folder outright (tests). The script header has the same list.

| verb | does |
|------|------|
| `init [codeword]` | makes the folder (`img/`, `inbox/`, `project.txt`, `index.md` = `collecting <codeword>`), prints it with forward slashes; a folder reading `released` is first renamed `<id>-<YYYYMMDD-HHMM>` |
| `dir` | prints the folder |
| `add [--from FILE]` | FILE (else stdin) = optional header, `---`, the person's text. Reserves the next `NN` (no two adds share one), copies images, deletes the draft if it is in `inbox/`. Prints `NN chars=<n> img=<copied>/<seen> [missed: ...] where=<...> [dup=NN]` |
| `status NN <st> <evidence...>` | `st`: open, done, partial, not-done, unseen, dropped, `merged→NN` (also `merged->N`). Evidence after `--` may start with `--` |
| `edit NN --from FILE` | new text; the old one stays in the file under `previous (replaced <time>):`; status back to open |
| `drop NN <reason>` | status dropped (the person removed it) |
| `means NN <text> [--visual]` | adds a `means:` line (what done means); `--visual` adds `visual: yes`. `check` needs one on every `done`, `partial` and `unseen` item |
| `scope NN <n> <N>` | `scope: n of N` for a breadth item; `done` is refused while n < N |
| `table` | the closing table: `NN \| status \| quote \| evidence`, repeats marked `came back:`, done rows as `done: 01 02`, and `ask: ...` = every unfinished number |
| `cover <run dir>` | exit 1 listing the live items no file under `<run dir>/tasks/` names with a `hold: 03, 07` line |
| `check` | exit 1 and list: items not final or with thin evidence, strays (an `NN.md` not in the index) apart, an index not yet `released`, zero items |
| `release [--drop REASON]` | first line becomes `released <codeword>`; `--drop` first marks every unfinished item not-done with REASON |
| `carry <old id or dir> [--all]` | copies unfinished items (not-done, partial, open) with screenshots, prints `old/NN→NN`; `--all` only on request; the same source twice is refused |
| `last` | prints the newest earlier folder of this project when its check fails; nothing otherwise |
| `clean` | removes folders or files older than a day holding only a `collecting` line |

`index.md`: first line `collecting <codeword>` or `released <codeword>`, then `NN | status | short title | flags`.
Flags: `? "<heard>"`, `? route`, `+ to NN`.

`NN.md`: `# NN`, `time:`, `status: <st> | <evidence>`, `where:`, `img:` (path under `img/` and its source),
`reading (the chat's, not the person's):`, then the person's text with every line prefixed `> `. Only the
quote block is the person's. A carried item adds `carried: <old id>/NN` and `previous-status:` (the old
status line, unchanged).

Also in `NN.md`: `means:`, `visual: yes`, `scope: n of N`, and `back: <id>/NN` (written by `add` when an earlier
`done` item of the same project has the same `where:`, case ignored; `add` prints `back=<id>/NN`).

Statuses: `open` while collecting; `unseen` final, changed but never looked at (a screen item without its after-shot and judge); `done` fixed and checked against the record (a screen item: evidence names `img/NN-after.<ext>` and `judge: <agent>`); `partial` evidence
`<done>; left: <rest>`; `not-done` not fixed, evidence says why; `dropped` removed by the person, evidence
the reason; `merged→NN` the same as item NN, which must be final and not itself merged. Evidence: an existing
path (`file:line`) or at least three words.

Image paths in the text are found with spaces and parentheses, `/c/...` Git Bash form, and the extensions
png, jpg, jpeg, gif, webp, heic, bmp. An old-format hold (`<id>.md`, `N. text` lines) is never rewritten.
