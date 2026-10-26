---
description: Builds an HTML report of UI work with numbered before/after screenshot blocks, saved to files so the images never enter the context. Use on "покажи скриншотами", "как было как стало", "перепроверь визуально скриншотами", "отчёт со скриншотами", "html отчёт по UI", "before and after screenshots", and on the follow-up "блок N переделай".
argument-hint: [what UI change to document]
---

The person reviews UI work as a report of numbered blocks, each with "как было / как стало" shots, and
answers "блок 23 сделано плохо, переделай". The pane's own screenshot goes only into your context and
cannot be saved. So the pane renders the page to PNG itself (html-to-image) and POSTs it to a local
receiver, and you get back one small JSON line. A report of 30 blocks costs no image tokens.

`P="${CLAUDE_SKILL_DIR}/proof.mjs"`; every command is `node "$P" <cmd> <dir> ...`. `<dir>` is a fresh
folder under the system temp dir for this task (it holds the PNGs, `blocks.jsonl`, `report.html`).

## Flow

1. Start the receiver in the background: `node "$P" serve <dir>`. It prints `PORT=<n>`, writes `<dir>/.port`,
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
   - `node "$P" snippet <dir> NN-before [css-selector]` prints one JS expression. Run it in the pane's
     `javascript_tool` BEFORE you edit. No selector: the visible viewport (the body clipped to
     innerWidth x innerHeight, scroll undone). With a selector: that whole element, however tall.
   - Edit. Wait on the condition that means rendered (a selector present, a flag flipped), not on a sleep.
   - The before-shot must come before the edit. If the edit is already made (a caller such as `finish`, or
     "покажи скриншотами" after the fact), do not fake a baseline: take the after-shot only and record
     `block ... --note "no baseline: the edit came before the shot"`. A baseline from a second dev server
     on a clean worktree is out of scope for this skill.
   - Run `snippet ... NN-after` the same way, in the same viewport and theme.
   - `node "$P" block <dir> --title "..." --what "one line of what changed" --files a.vue,b.css --before NN-before --after NN-after --viewport 1280x720 --theme light`.
     Read the viewport from `innerWidth x innerHeight`; for a dark shot emulate the scheme first.
4. After the work: `node "$P" report <dir> --title "..." --inline`. Publish `<dir>/report.html` with the
   Artifact tool as a private artifact; if there is none, give the local path. Without `--inline` the file
   links the PNGs beside it and must stay with them. `--out` outside `<dir>` copies the PNGs next to the
   out file. If the inline file would pass 15 MB, `report --inline` writes the linked variant instead and
   prints a warning saying so; publish the local file then, not an artifact.
5. "блок N переделай ...": redo only that block, take a new `NN-after`, `block <dir> --id N` with the changed
   fields, rebuild with `report --inline`, and republish to the same artifact or path. Block numbers never
   change, so the person's references stay valid.
6. `node "$P" stop <dir>` when the task is done.

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
wires that. Reports are in Russian, because the person reads them that way.

## Done when

Every UI change has a numbered block (shots, or the reason there are none), the report is published or its
path given, and the receiver is stopped.
