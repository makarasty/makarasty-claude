---
description: "Turns a UI complaint (this jumps, a screenshot) into a detector, sweeps the whole app for it and fixes the source; runs a parallel visual walk of every page judged by agents. UI bug hunt, fix it everywhere / обойди всё приложение, визуальные баги, жалоба на UI. Not one screen or flow (fleet-design-eye, fleet-scenario), a diff (review), proof, antislop, blindtest."
argument-hint: [walk | a UI complaint, text or screenshot]
---

Two jobs, one tool. A **walk** finds every visual defect of a running app: a script drives N headless Chromium
windows that share one sign-in (headless windows paint whether anyone looks or not, so they run side by side;
one browser pane is one window, and a pane walk of a few hundred routes takes hours), then one judge agent per
batch of shots reads every picture. A **complaint** ("this popup jumps", a screenshot) becomes a defect kind
with a detector in the person's catalogue, the whole app is swept for that pattern, and the fix goes to the
shared source, not the one page.

A full walk runs only when the person asks for one. A complaint is itself the ask for a `--quick` sweep of its
pattern. Every command spells the full path: `node "${CLAUDE_SKILL_DIR}/walk.mjs" ...`; run it from the project
root (or pass `--project <dir>`). Give each run a new, empty folder under the system temp dir: the walker refuses a
folder with anything in it, so an earlier run stays intact for a before/after diff.

## 1. Point it at the project (once)

`node "${CLAUDE_SKILL_DIR}/walk.mjs" config` prints what the walker will use. The origin comes from `--origin`, the
config, or FLEET.md (`- App origin:` or the first `- Services:` URL, as fleet-init writes them); a path on it (an app
served under `/app/`) is the base every route is relative to. The config is `<project>/.claude/walk.json`, or
`<config dir>/makarasty/walk/<project folder>.json` for a project you may not edit; every key is optional:

- `signIn`: `visit` (URLs that sign the session in, such as a dev login), `check` (a JS expression true when signed
  in; read the app's state, not the URL), `screen` (selector of the sign-in screen). With none of these and a
  sign-in screen showing, run `walk.mjs login`: a visible window opens, the person signs in by hand, the session is
  saved under the config dir. Never type a password for them.
- `routes`: `source` auto (the app's Vue router, else `/sitemap.xml`, else a crawl of links from `start`), `list`
  (extra routes; a query is kept, e.g. `/?seed=1`), `skip` (regex), `maxRoutes`, `perShape` (records of one URL
  shape walked, default 1). A crawled or listed URL whose segment names an action (logout, delete, cancel, pay,
  export, ...) is never loaded: a GET can act on a server.
- Class names: `pageSelector` (page content box), `barSelector` (a toolbar outside it), `busySelector`,
  `skeletonSelector`, `loaderClass`, `tileSelector`, `kit.controlClasses` (root classes of the project's own buttons
  and selects: turns on the hand-made-control probe), `hover.hostSelector` / `hover.symbol` (tooltip triggers),
  `dark` (`media`, `htmlClass`, `attr` such as `data-theme=dark`), `viewports`, `fullPage`.
- `unsafe`: extra labels never pressed, on top of the built-in list (send, save, delete, pay, order, cart, call, ...).
  Copy the controls FLEET.md reserves for the operator here, by their visible label.
- `guard.allow`: a regex of request URLs a click may still send with POST/PUT/DELETE (reads an app makes by POST, a
  live-data channel). Every other write a click or a row open starts is blocked and listed as `blocked` on that click.
- `probes`: the project's own in-page probe modules, relative to the project root (each export is a self-contained
  function taking the probe options and returning candidates); results land in `custom.<name>`.

Then `node "${CLAUDE_SKILL_DIR}/catalogue.mjs" init` once per person (a no-op when the catalogue exists): their defect
kinds, seeded from `kinds.json`.

Use the dev server that answers on the origin. Nothing answers: start the project's own dev command if FLEET.md or
the project says how and nobody else owns it, else ask; never a second copy on another port. The walker refuses a
non-local origin unless `--allow-remote` is passed for a test environment the person named.

## 2. Walk

`node "${CLAUDE_SKILL_DIR}/walk.mjs" run <dir> --workers 8` in the background, with `--max-minutes` at about twice the
expected time (about 6-12 routes a minute with 8 windows, slower with `--film` and on a busy machine [M87]). Per
route: wide light, dark and narrow shots, tooltip crops, safe clicks (tabs, menus, Filters/Columns/Layouts, Add/New
popups outside table rows and forms; each shot, probed, closed, writes blocked), the probes, console errors and
failed calls, one line in `walk.jsonl`. Record routes (`:id`) are filled from links. Flags: `--film` (cold load under a
50 ms recorder: skeleton cascades, remounts, jumps, mismatches, blank, shifts), `--quick` (light shot and probes only;
add `--film`, `--hover` or `--clicks` for a detector that needs them), `--routes /a,/b` (exactly these) or
`--filter <s>` (only matching routes), `--no-hover`, `--no-clicks`. It ends with `summary.json` and `batch-NN.json`
files (ceil(routes / 20) routes, at least 5, at most 150 pictures each). A run cut off by `--max-minutes` writes them
for what it finished; `walk.mjs batches <dir>` rebuilds them from any `walk.jsonl`. A lost session stops the walk and
`summary.json` names the last action before it.

## 3. Judge, merge, check

1. `catalogue.mjs judge-lines > <dir>/kinds.txt`. One judge per batch, launched in one message, at most 20 at a time
   (a 21st is refused; start the rest as judges finish): `model: "sonnet"`, `effort: "high"`, the brief
   `judge-brief.md` beside this file with BATCH_FILE, OUT_FILE (`<dir>/judge/findings-NN.jsonl`), BATCH (the batch
   number, the prefix of its finding ids), KNOWN (what another chat already owns), KINDS_FILE and PROJECT (the
   project's naming source and UI rules) filled in.
2. One merge agent on the strongest model, brief `merge-brief.md` with FINDINGS, WALK_DIR, OUT_FILE
   (`<dir>/merged.json`), KNOWN, KINDS_FILE, SOURCE (the project folder) and CATALOGUE (the full path of
   `catalogue.mjs`): groups by shared cause, drops capture artifacts, lists routes to re-shoot.
3. Read the picture of every major yourself. Re-shoot the doubtful ones with `--routes` into a new folder (several
   runs side by side are fine), and drop what the re-shoot shows was a state, not a defect.
4. Report: routes walked, shot, with an error; raw findings, groups, majors; each group with its cause, routes and one
   shot. Fixing them is the person's call unless they asked for it with the walk.

Before and after a fix: `node "${CLAUDE_SKILL_DIR}/diff.mjs" <beforeDir> <afterDir> <outDir>` marks changed pixels red
per shot and writes `diff.json` (changed share and boxes, biggest first); `<outDir>` is a new folder.

## 4. A complaint becomes a detector

1. Say back the defect in one plain line and find the screen (a screenshot: read it; a route or label: open it).
2. `node "${CLAUDE_SKILL_DIR}/catalogue.mjs" find <the defect in plain English words>` (the kinds are written in
   English; a complaint in another language is matched by its translation). Same defect: `hit <id> --quote "<the
   person's words>" --project <folder>`. New: `add --title ... --category ... --kind PROBE|FILM|CLICK|HOVER|PIXEL|JUDGE
   --spec ...`.
3. No detector yet (`impl` empty): write one. Generic to any web app: a probe in this skill's `probes.mjs` (a plugin
   change: its own test, version and changelog). Specific to this project: an export in the project's probe module
   (`probes` in the config). Then `catalogue.mjs impl <id> <field>` (`probes.x`, `custom.x`, `clicks.x`, `film.x`).
   It must fire on the complained screen first: `walk.mjs run <dir> --quick --routes <that route>` plus the flag its
   field needs (`--film` for `film.*`, `--clicks` for `clicks.*`, `--hover` for `hover.*`). A kind only an eye can
   see stays JUDGE and reaches every later walk through `judge-lines`.
4. Sweep: `walk.mjs run <dir> --quick` with that same flag, then `catalogue.mjs sweep <dir> <id>` lists every route
   where it fires.
5. Fix at the source: the shared component, style or helper behind the hits, once. Sweep again into a new folder until
   it fires nowhere or each remaining hit is explained.
6. Report: the kind id, its detector, hits before and after, the file fixed, what the sweep cannot see.

## Traps

- A dev-server reload (another chat's edit) unmounts every window at once: the walker waits for the app to come back
  signed in and retries a route whose page reloaded mid-shots. A crashed or wedged window is rebuilt. A refused
  navigation, a redirect or another host leaves another page on screen: such a route is recorded as "landed on ..."
  with no shots.
- Probes are pointers, not verdicts: screen-reader text, a closed drawer and icon-font names look like defects to a
  script. A state shot in a slow environment (an empty list beside a count) may be mid-load: re-shoot first. A blocked
  write (`blocked` on a click) can leave its shot showing an error the app would not show.
- The walk uses one account: it never switches roles. Another role is a separate run, one at a time.
- A walk cannot reach forms after input, popups behind an unsafe label, row menus, live calls or sends: those stay a pane
  scenario (`makarasty:fleet-scenario`), one at a time, after the walk.
- The run folder holds the signed-in session (`login.json`): keep it out of reports and repositories.
- Playwright comes from the project (root or one folder down), `WALK_PLAYWRIGHT`, or `<config dir>/makarasty/walk-deps`;
  a missing browser build falls back to the newest installed one (`WALK_CHROMIUM` overrides).

Checked by `node "${CLAUDE_SKILL_DIR}/selftest.mjs"` (unit cases always; the live and end-to-end cases when
`WALK_PLAYWRIGHT` points at a folder with Playwright).
