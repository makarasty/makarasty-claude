---
description: "Builds an HTML report of UI work with numbered before and after screenshot blocks. before and after screenshots / покажи скриншотами, как было как стало, отчёт со скриншотами. Not text summaries (report)."
argument-hint: [what UI change to document]
---

The person reviews UI work as a report of numbered blocks, each with "как было / как стало" shots, and
answers "блок 23 сделано плохо, переделай". The pane's own screenshot goes only into your context and
cannot be saved. So the pane renders the page to PNG itself (html-to-image) and POSTs it to a local
receiver, and you get back one small JSON line. A report of 30 blocks costs no image tokens.

Shell variables do not survive between calls, so every command spells the full path: `node "${CLAUDE_SKILL_DIR}/proof.mjs" <cmd> <dir> ...`. `<dir>` is a fresh
folder under the system temp dir for this task (it holds the PNGs, `blocks.jsonl`, `report.md`).

## Flow

1. Start the receiver in the background: `node "${CLAUDE_SKILL_DIR}/proof.mjs" serve <dir>`. It prints `PORT=<n>`, writes `<dir>/.port`,
   and stops itself after 2 h without a valid shot, or on `stop`. It binds 127.0.0.1 only. `.port` holds
   `<port> <token>`: `/shot`, `/lib.js` and `/ping` answer 403 without that token (no web page can write
   into `<dir>`), and a Host other than `127.0.0.1:<port>` or `localhost:<port>` is refused. `snippet` bakes
   the token in, so always take the snippet from the command, never type the URL yourself. A dir holds at
   most 300 images and 500 MB. The html-to-image build is pinned by sha256; a mismatch deletes the cache
   and `/lib.js` answers 502.
2. Gate the pane before the first shot and again before each batch (`docs/BROWSER.md`, "The gate"): run the
   frame count twice, a second apart, and believe the second. Under ten frames the pane is blind and its
   render is a photo of a stopped page; ask the operator to display it, as that doc says.
3. For each UI change, number it `NN` and:
   - `node "${CLAUDE_SKILL_DIR}/proof.mjs" snippet <dir> NN-before ['css-selector']` (single-quote the selector: a bare `#app` is a bash comment) prints one JS expression. Run it in the pane's
     `javascript_tool` BEFORE you edit. No selector: the visible viewport (the body clipped to
     innerWidth x innerHeight, scroll undone). With a selector: that whole element, however tall.
   - Edit. Wait on the condition that means rendered (a selector present, a flag flipped), not on a sleep.
   - The before-shot must come before the edit. If the edit is already made (a caller such as `finish`, or
     "покажи скриншотами" after the fact), do not fake a baseline: take the after-shot only and record
     `block ... --note "no baseline: the edit came before the shot"`. A baseline from a second dev server
     on a clean worktree is out of scope for this skill.
   - Run `snippet ... NN-after` the same way, in the same viewport and theme.
   - `node "${CLAUDE_SKILL_DIR}/proof.mjs" block <dir> --title "..." --what "one line of what changed" --files a.vue,b.css --before NN-before --after NN-after --viewport 1280x720 --theme light --box 40,120,360,180`.
     Read the viewport from `innerWidth x innerHeight`; for a dark shot emulate the scheme first. `--box
     x1,y1,x2,y2[;x1,y1,x2,y2]` (image pixels of the shot) marks the changed spot on both shots; every before/after
     block gets one. Image pixels are CSS pixels times the shot's scale: take the rect with `getBoundingClientRect()`
     (as is for a viewport shot, minus the shot element's own rect for a selector shot) and multiply by
     `w / innerWidth` (the snippet returns `w`; on a 150 % display the PNG is 1.5x the CSS size). A shot the box does
     not fit gets no box and a warning.
4. After the work, write the page to the person's Desktop (`[Environment]::GetFolderPath('Desktop')`):
   `node "${CLAUDE_SKILL_DIR}/proof.mjs" report <dir> --title "..." --out "<Desktop>/<Topic>.html" --chat-id ${CLAUDE_SESSION_ID}`
   (`--chat "<sidebar title>"` instead when the id has no Desktop title; neither flag is an error). It writes
   `<dir>/report.md` and renders it with the report skill, so the page has the same fixed shape as every report
   page: this chat's name on top, one question per block with its shots (embedded, so the file stands alone) and
   the buttons «Принять» / «Переделать», «Скопировать ответы», and «Чем проверено» at the bottom. Give the person
   the path. `--inline` is accepted and does nothing; a page over 15 MB prints a warning.
5. "блок N переделай ...": redo only that block, take a new `NN-after`, `block <dir> --id N` with the changed
   fields, rebuild with the same `report` command to the same `--out`. Block numbers never change, so the
   person's references stay valid.
6. `node "${CLAUDE_SKILL_DIR}/proof.mjs" stop <dir>` when the task is done.

## When the shot fails

The snippet returns `{"ok":false,"error":...}` when the page's CSP blocks the script, a cross-origin image
taints the canvas, the page is too large, or the render or upload takes over 20 s (it always returns JSON,
never hangs). Take one pane screenshot to look at it, and record the block
without an image: `block ... --note "no shot: <the error>"`. The report says the block has no image and
shows the note. Do not retry in a loop.

Fonts and images from another origin without CORS headers may render blank or fall back; the shot is a
re-render by html-to-image, not a pixel capture, so a pixel-exact claim needs the pane screenshot.

## Related

`/makarasty-tools:hold` (step 7), `blindtest` and `finish` can call this skill for UI changes; the caller
wires that. The report is in the person's language: `report --lang en` for a person who does not write Russian
(the default is Russian), and the titles and notes you write in that language too.

## Done when

Every UI change has a numbered block (shots, or the reason there are none), the report page is on the
Desktop and its path given, and the receiver is stopped.
