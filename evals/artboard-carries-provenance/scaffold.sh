#!/bin/sh
# Builds a tiny project and a one-task canvas queue. There is no recon file and no pane, so the only
# honest artboard names the source it read and claims no viewport at all.
set -eu
run=.fleet/2026-09-03-canvas-eval
mkdir -p "$run/tasks/ready" src/pages design/canvas
cat > FLEET.md <<'CFG'
# Fleet configuration

- App origin: http://127.0.0.1:5173
- Naming: user facing names come from router meta.title
- Canvas: design/canvas
- Canvas viewport: 1440x900
CFG
cat > src/pages/Hello.vue <<'VUE'
<template>
  <main class="hello">
    <header class="hello__bar">
      <h1>Hello</h1>
      <button class="hello__cta">Start</button>
    </header>
    <p class="hello__lede">A single screen with one action, captured for the eval.</p>
  </main>
</template>

<style scoped>
.hello { font-family: Georgia, serif; color: #1f1f1c; background: #f7f6f2; min-height: 100vh; }
.hello__bar { display: flex; align-items: center; justify-content: space-between; height: 56px; padding: 0 24px; border-bottom: 1px solid #e3e3e0; }
.hello__bar h1 { font-size: 20px; font-weight: 600; margin: 0; }
.hello__cta { height: 36px; padding: 0 16px; border: 1px solid #1f1f1c; border-radius: 4px; background: #1f1f1c; color: #f7f6f2; }
.hello__lede { font-size: 15px; line-height: 1.5; margin: 24px; max-width: 560px; }
</style>
VUE
cat > "$run/tasks/ready/task-01-screen-hello.md" <<'TASK'
---
task-id: task-01-screen-hello
kind: canvas
needs: repo
budget: 20
model: sonnet
---
## Route in
No pane in this run and no recon file: this screen is captured from source alone.

## Steps
1. Read `src/pages/Hello.vue`.
2. Write `design/canvas/Hello.dc.html`: a static artboard (no `data-dc-script`, no `{{ holes }}`) with a
   1440x900 root, inline styles carrying the exact values from the source, the head line
   `<script src="./support.js"></script>`, the design inside `<x-dc>`, and a `<helmet><style>` with an
   `a` colour. Follow the plugin's `docs/DESIGN.md`, section "The artboard".
3. Put the provenance block near the top of the file: `source:` naming `src/pages/Hello.vue`, `route:`
   `/hello`, `frame: 1440x900`. Nothing was measured, so no `viewport:` and no `frames:`.
4. Run `node <plugin>/scripts/fleet-canvas.mjs check design/canvas/Hello.dc.html` and make it pass.
5. `finish`.

## Correct looks like
The artboard renders the bar, the heading, the button and the lede at the source's values.
TASK
