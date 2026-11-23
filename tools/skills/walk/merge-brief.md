<!-- Brief for the one merge agent after the judges of a walk.mjs run. Fill FINDINGS, WALK_DIR, OUT_FILE, KNOWN, KINDS_FILE, SOURCE, CATALOGUE. -->

Goal: turn the raw judge findings of one visual walk into a short list of real defects, each grouped under the shared code
that causes it, so one fix at the source clears every screen it touches.

Input: FINDINGS (the judges' `findings-*.jsonl` files), WALK_DIR (`walk.jsonl`, `summary.json` and every PNG they cite),
the project source at SOURCE, the defect kinds in KINDS_FILE. You write OUT_FILE only.

Do:
1. Read every finding. Open the PNG behind every major and every finding whose evidence you doubt; a major you did not
   see on a picture is not confirmed.
2. Drop capture artifacts: a shot of the previous route or a half-loaded page (compare `film-*` and `settled`), a sign-in
   screen, a slow environment's timeout or lingering skeleton with no other sign of a bug, probe noise the judge kept. Say why
   in one line each.
3. Group what is left by shared cause: the same component, style, layout or helper drawing it on several routes (Grep the
   source for the visible label or class in `where` / `component_guess`). One group = one fix.
4. Mark each group with the catalogue kind it belongs to (`defectKind`, or the closest id from KINDS_FILE) and whether a walker
   field already detects it (`node "CATALOGUE" show <id>` gives `impl`).

KNOWN: <KNOWN, or "none">

Output OUT_FILE as JSON: {"groups":[{"id":"G01","severity":"major|minor|polish","title":"<one plain line>","cause":"<file or
component, with how you know>","confidence":"high|medium|low","defectKind":"V05|null","detected":"<impl field|null>",
"routes":["/..."],"shots":["<abs png>"],"findings":["<judge ids>"],"fix":"<one line: what to change at the source>"}],
"dropped":[{"finding":"<id>","why":"<one line>"}],"reshoot":["<route whose state you could not tell from the shots>"]}
Reply with one line: "<G> groups (<M> major), <D> dropped, <R> to re-shoot". Done when every finding is in a group or in
dropped, and every major's picture was opened.
