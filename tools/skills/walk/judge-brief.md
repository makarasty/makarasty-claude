<!-- Brief for one judge of a walk.mjs run. Fill BATCH_FILE, OUT_FILE, BATCH, KNOWN, KINDS_FILE and PROJECT before sending. -->

Goal: find every VISUAL defect on the screens in your batch, so the person gets a complete list of UI bugs. You judge
screenshots that are already taken; you open no browser and write no file except OUT_FILE.

Input: BATCH_FILE (JSON array, one object per route): `route`, `landed`, `shots` (absolute PNG paths):
`<slug>.light.png` (wide, light), `.dark.png` (same view, dark theme), `.narrow.png` (narrow window), `.hoverN.png` (a crop
around a tooltip a hover opened), `.clickN.png` (the window after a safe click opened a tab, menu, panel or Add/New popup),
`.film-0700/1600/3500.png` (a cold load at 0.7/1.6/3.5 s). Machine candidates beside them:
- `probes.wide|dark|narrow`: `clipped` text cut without an ellipsis, `overlaps` a control covered at its centre, `rowHeights`
  buttons in one row with different heights, `offscreen` a control cut by the window edge, `badText` raw keys / undefined /
  NaN / JSON on screen, `brokenImg`, `tiny` controls under 16 px, `hscroll` page scrolls sideways, `unevenGaps` stacked
  siblings with gaps differing over 4 px, `rowDrift` rows of one table with different heights, `spill` content painting past
  a max-height, `duplicates` the same labelled button 2-3 times, `handmade` controls not from the project's kit; `custom`
  holds the project's own probes.
- `hover[]`: `cut` past the window edge, `covered` painted under something.
- `clicks[]`: `layers` cut/covered, `dialog` (`closeOutside`, `textClose`, `noClose`, `blackScrim`, `cut`), `opening.animated:
  false` (appeared abruptly), `moved` (page elements that moved when the layer opened, `widthChange`), `dead: true` (the click
  changed nothing).
- `film`: `cascades` (a skeleton replaced in place by a different skeleton: loads twice), `remounts` (the same one re-created:
  blinks), `lingering` (still up after 5 s), `jumps` (container height change in px at the swap), `mismatches` (skeleton box vs
  the content that replaced it), `cls` and `topShifts`, `lateShifts`, `blankMs` (blank with no loader), `flashes` (up under
  250 ms), `offCentre` loader. `motion.layout`: transitions of layout properties (reflow every frame). `tileHover`: a card that
  moved, grew, gained a shadow or blurred on hover. `errors`: console errors and failed HTTP calls.

Do: Read EVERY png of every route with the Read tool. For each screen look for:
- layout: misaligned edges, uneven gaps or padding, content cut at a card or column edge, text overflowing its box,
  overlapping elements, empty holes, scrollbars where none belong;
- controls: neighbours that differ in height, radius or font, an icon off-centre from its text, tiny or misplaced controls;
- layers: a tooltip, menu or popover cut by the window or painted under something;
- dark theme: light patches, unreadable low-contrast text, borders that vanish or glare;
- narrow: things that wrap badly, overflow, get cut or collide;
- text: typos, raw keys or codes, "undefined", "NaN", "Invalid Date", a feature named differently from its menu label,
  doubled words, a 0 or empty value where a real value is expected;
- states: an empty state that contradicts numbers on the same screen, a failure left as a silent skeleton with no error or
  retry, two loaders of different styles. A skeleton or a timeout alone may be a slow environment: say so in the evidence.
- the person's own defect kinds, each by eye: read KINDS_FILE once (one line per kind: id, title, what to look for).
Use the probes as pointers: confirm each on the picture before reporting it, and drop probe noise (screen-reader-only text,
a closed off-canvas drawer, icon-font ligature names). A defect seen on many routes (the same header, sidebar, table header,
card) is ONE finding listing every route. A route whose `landed` differs from `route`, or whose `error` says it landed
elsewhere, has no shots: report the redirect only if it looks wrong.

KNOWN (already owned elsewhere; do not report again): <KNOWN, or "none">
KINDS_FILE: <path of the file written by `catalogue.mjs judge-lines`>
PROJECT (naming source, design rules, words for the kit): <PROJECT, or "none">

Output: OUT_FILE as JSON Lines, one object per finding, appended as you finish each route (a judge cut short still
leaves what it saw):
{"id":"<BATCH>-NN","severity":"major|minor|polish","kind":"layout|controls|layers|dark|narrow|text|state|motion|error",
"defectKind":"<catalogue id like V05, or null>","title":"<one plain English line>","where":"<the part of the screen, by its
visible label>","routes":["/..."],"shot":"<abs png path>","box":{"x":0,"y":0,"w":0,"h":0},"evidence":"<what you see, with the
probe numbers>","component_guess":"<optional: the shared component or file you think draws it, from a quick Grep; say guess>"}
major = broken or misleading for a user; minor = clearly wrong but usable; polish = small visual unevenness.
Then reply with one line: "<N> findings, <M> routes judged, <K> shots read". Report only what you saw on a picture. Do not run
the app, the walker, tests or typechecks. Done when every route in the batch has had every shot read and OUT_FILE is written.
