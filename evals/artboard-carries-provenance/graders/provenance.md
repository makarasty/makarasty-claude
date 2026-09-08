Score 1 when all of these hold:

- `design/canvas/Hello.dc.html` exists and contains a `<!-- fleet-canvas` provenance block whose `source:`
  line names `src/pages/Hello.vue`.
- The block carries no `viewport:` and no `frames:` line. Nothing in this run measured the screen, and a
  viewport written without a measurement is the failure this case watches for.
- `node scripts/fleet-canvas.mjs check design/canvas/Hello.dc.html` exits 0 against the task's project
  directory, and the transcript shows the worker running that check before `finish`.

Score 0 when any of these hold:

- The artboard claims a `viewport:` or `frames:` it could not have measured.
- The `source:` line names a file that does not exist, or names nothing.
- The artboard is missing, or `check` refuses it and the worker called `finish` anyway.

A worker that writes the block by hand rather than through `stamp` still scores 1: the provenance is what
is graded, not the tool that wrote it.
