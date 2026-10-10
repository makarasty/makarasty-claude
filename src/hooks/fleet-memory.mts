#!/usr/bin/env node
// fleet-memory.mjs - the third thing only the harness can see: a worker about to take the whole machine.
//
// A fleet's own appetite is what kills the box it runs on. `fleet.sh next` throttles new tasks against free
// memory, but two costs are invisible to it, because both happen inside a task that was already claimed:
//
//   A full test suite or a full typecheck. Gigabytes each, and several sessions firing them at the same
//   minute is what put the machine this was built on past physical memory and into the page file. The rule
//   against it has existed in prose - in the operator's own CLAUDE.md, and in this plugin's LANES.md - for
//   as long as the verify lane has, and prose in this system is obeyed at approximately zero.
//
//   A browser pane that grew. One tab holding 150,000 DOM nodes measured 2,061 MB, and a reload returned
//   none of it: only closing the tab did [M34]. A worker an hour into a heavy application is holding
//   gigabytes that no script can see and no script can free.
//
// So this refuses the call rather than asking for restraint. It is timid on the same principle as
// fleet-guard.mjs and fleet-contract.mjs: no fleet under the working directory, no chip registered for this
// session, or nothing heavy about the command, and it exits 0 without a word. It never runs the census
// unless the command already looks expensive, because it sits on the Bash path and every worker's every
// shell call would otherwise pay for a process spawn.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findRuns, chipOf, rel, pauseGate } from './run-dir.mjs';
import type { HookPayload } from './run-dir.mjs';

// What `fleet-load.mjs --json` prints, the fields this hook reads.
interface Census { tight?: boolean; freeGB?: number; groups?: Record<string, { n: number; totalMB?: number; maxMB?: number }> }

const bail: () => never = () => process.exit(0);

let payload: HookPayload = {};
try {
  const raw = fs.readFileSync(0, 'utf8');
  payload = (raw ? JSON.parse(raw) : null) || {};   // `null` is valid JSON with no fields
} catch { bail(); }

const tool = payload.tool_name || '';
const input = payload.tool_input || {};
const session = payload.session_id || process.env.CLAUDE_CODE_SESSION_ID || '';
if (!session) bail();

// The shell tools, Monitor (a command that runs for as long as it likes) included: on Windows the PowerShell tool is often the primary one, and a suite run through it
// costs the machine exactly what the same run through Bash does. `preview_start` is deliberately absent:
// a worker whose pane is gone needs it to start again, so refusing it would be a loop.
const SHELL = tool === 'Bash' || tool === 'PowerShell' || tool === 'Monitor';
const BROWSER = /^mcp__(.*[Bb]rowser|claude-in-chrome)__(navigate|browser_batch|computer)$/;
// A pause comes before everything below, and it is wider than the memory rules: every browser tool, not
// only the three that cost memory, Agent/Task, so a paused worker cannot start a subagent, and Skill, which
// loads a new instruction set into a session that was told to stop. The common
// case - no paused run anywhere - is one readdir inside pauseGate.
if (!SHELL && !BROWSER.test(tool) && !/^mcp__(.*[Bb]rowser|claude-in-chrome)__/.test(tool) && !/^(Agent|Task|Skill)$/.test(tool)) bail();
const held = pauseGate(payload);
if (held) { process.stderr.write(held + '\n'); process.exit(2); }
if (!SHELL && !BROWSER.test(tool)) bail();

// A whole-repository run of one of these, in command position: `cat vitest.config.ts`, `npm i -D vitest`
// and a commit message that mentions jest name a runner without running one. The scoping arguments are the
// ones that make it bounded: a path, a project, a name filter, or the changed set. `--watch` is excluded
// because a watcher is the operator's own long-running process - but `--watch=false` is a full run.
const RUNNERS = /(?:^|[;&|(]|\bthen|\bdo)\s*(?:[A-Z_][A-Z0-9_]*=\S*\s+)*(?:(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn(?:\s+run)?|python3?\s+-m)\s+(?:--?[\w-]+(?:=\S+)?\s+)*)?(vitest|jest|pytest|vue-tsc|tsc|(?:\.[\\/])?gradlew(?:\.bat)?|gradle|mvn|cargo\s+test|go\s+test|(?:npm|pnpm(?:\s+(?:-r|--recursive))?|yarn(?:\s+workspaces\s+foreach(?:\s+-\S+)*)?|bun)\s+(?:run\s+)?test|(?:npm\s+run|pnpm(?:\s+(?:-r|--recursive))?(?:\s+run)?|yarn(?:\s+run)?|bun\s+run)\s+(?:typecheck|type-check|tsc)|npm\s+t)(?![\w.-]|:watch(?![\w-]))/;
// A config file is not a scope (`--config ./vitest.config.ts` runs everything), and `--noEmit` is followed
// by a path only when the next word on its line is not a redirect, a pipe or a comment (`2>&1 | tail`).
const SCOPED = /(--changed|--project|--filter|--testPathPattern|--test-name-pattern|(?:^|\s)-[tp]\s|--tests\s|--watch(?:All)?(?!=false)\b|--related|\.(test|spec)\.[jt]sx?|[\\/](?![\w.-]*\.config\.)[\w.-]+\.(ts|tsx|js|py|kt|java)\b|--noEmit[ \t]+(?![|&;<>#]|\d*>)[^-\s])/;

const cmd = SHELL ? String(input.command || '') : '';
// A message names a runner without running one (`git commit -am "fix; npm t"`, `-m"..."`, `$'...'`), so its
// text is blanked; a `bash -c "npm test"` body is a command, so other quotes are not. `echo "npm test" | sh`
// is missed for the same reason. A `:watch` script given `--run` or `--watch=false` is a one-shot run.
// sh single quotes have no escapes; a double-quoted body holding `$(...)` runs a command, so it stays
// (`echo "$(npm test)"`) - except `$(cat <<'EOF'`, the usual way to pass a long commit message.
let shown = cmd.replace(/((?:^|\s)(?:-[a-z]*m|--message|echo|printf)(?:\s*|=))(\$?"(?:[^"\\]|\\.)*"|\$'(?:[^'\\]|\\.)*'|'[^']*')/g,
  (m: string, pre: string, body: string) => (/^\$?"/.test(body) && /\$\((?!\s*cat\s+<<)/.test(body) ? m : `${pre}""`));
if (/--run\b|--watch=false/.test(shown)) shown = shown.replace(/:watch\b/g, '');
const runner = SHELL ? RUNNERS.exec(shown) : null;
// To tsc, `-p .` or `-p tsconfig.json` is the whole project; `-p packages/a/tsconfig.json` is one package.
const scopeOf = runner && /tsc|typecheck|type-check/.test(runner[1]!)
  ? cmd.replace(/(?:^|\s)(?:-p|--project)(?:\s+|=)(?:\.\/)?[^\s/\\]+(?=\s|$)/g, ' ') : cmd;
// A workspace is a scope to the package manager, before any `--`; to jest after it, `-w 2` is --maxWorkers.
const workspace = !!runner && /^(npm|pnpm|yarn|bun)\b/.test(runner[1]!) && /(?:^|\s)(?:-w|-F|--workspace)[\s=]/.test(cmd.split(/\s--(?:\s|$)/)[0]!);
if (SHELL && (!runner || workspace || SCOPED.test(scopeOf))) bail();

const { fleetDir, runs } = findRuns(payload.cwd || process.cwd());
if (!fleetDir) bail();
const { run, chip } = chipOf(runs, session);
if (!run || !chip) bail();

// A browser action is not rare the way a full suite is: every click and screenshot lands here, and the
// census costs two PowerShell spawns - 0.7 s on an idle box, past its own timeout on a paging one. Free
// physical memory is one stdlib call, and the census cannot call the box tight while it is above the
// release line. `FLEET_LOAD` skips this, since a stub census is the only way to test the refusal.
// The census's release line: below 4 GB it calls the box tight when much is paged out, so this cannot be
// lower (2.25 let browser calls through on a box the census called tight).
const CLEAR_GB = 4;
if (BROWSER.test(tool) && !process.env.FLEET_LOAD && os.freemem() / 2 ** 30 >= CLEAR_GB) bail();

// A browser refusal is said once per session, like the one for a suite below: a worker refused on every
// click stops reading the reason and starts working around it.
const browserOnce = path.join(run, 'chips', `${session}.browser-warned`);
if (BROWSER.test(tool) && fs.existsSync(browserOnce)) bail();

// Only now, with a fleet worker about to do something expensive, is the census worth its spawn.
//
// `FLEET_LOAD` names a different census script. It exists because the interesting behaviour here - the
// refusal - depends on how much memory the machine happens to have at the moment the test runs, and a
// guard whose decisive case cannot be exercised is a guard nobody can trust. A port that reads memory some
// other way uses the same door.
const loader = [
  process.env.FLEET_LOAD!,
  path.join(import.meta.dirname ?? '.', '..', 'scripts', 'fleet-load.mjs'),
].filter(Boolean).find((f) => fs.existsSync(f));
let census: Census | null = null;
if (loader) {
  try {
    const out = execFileSync(process.execPath, [loader, '--json'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
    const i = out.lastIndexOf('{"when"');
    if (i !== -1) census = JSON.parse(out.slice(i));
  } catch { /* a census that will not answer is not a reason to block work */ }
}

const say = (msg: string) => { process.stderr.write(msg + '\n'); process.exit(2); };

if (BROWSER.test(tool)) {
  if (!census || !census.tight) bail();
  try { fs.writeFileSync(browserOnce, new Date().toISOString()); } catch { bail(); }
  const heaviest = census.groups?.['browser pane or window']?.maxMB;
  say(
    `The machine is down to ${census.freeGB} GB free and this session is driving a browser pane` +
    (heaviest ? `; the largest renderer on the box is ${heaviest} MB` : '') + `.\n\n` +
    `A tab holds its renderer until it is closed, and a reload returns none of it - one tab measured ` +
    `132 MB empty and 2,061 MB after a large page [M34]. Swap the heavy tab for an empty one - tabs_create, ` +
    `tabs_select the new tab, then tabs_close the heavy one - and load the heavy page again only once the ` +
    `machine has room.\n\n` +
    `Keep at least one tab open: closing the last tab closes the pane, and only the operator can put it back ` +
    `on screen [M35].\n\n` +
    `Loading the page again costs a second and a login. Holding it costs the fleet. This will not be raised again in this session.`
  );
}

// A full run, from a worker. Two things make it acceptable: holding the run's verify claim, which is the
// lane that exists for exactly this, or a machine with room and nobody else already running one.
const claimed = (() => {
  try {
    return fs.readdirSync(path.join(run, 'tasks', 'claimed'), { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }
})();
const holdsVerify = claimed.some((id) => {
  try {
    const owner = fs.readFileSync(path.join(run, 'tasks', 'claimed', id, 'owner'), 'utf8');
    if (!owner.split('\n').some((l) => l.trim() === `chip ${chip}`)) return false;
    const task = fs.readFileSync(path.join(run, 'tasks', 'ready', `${id}.md`), 'utf8');
    return /^needs:\s*verify/m.test(task);
  } catch { return false; }
});
if (holdsVerify) bail();

const live = ['toolchain: typecheck', 'toolchain: tests']
  .map((k) => census?.groups?.[k]).filter(Boolean)
  .reduce((n, g) => n + g!.n, 0);

if (!census?.tight && !live) bail();

// Raised once per session: a worker that cannot get past this stops trusting it and starts working around
// it, which is worse than the run it was going to make.
const once = path.join(run, 'chips', `${session}.memory-warned`);
if (fs.existsSync(once)) bail();
try { fs.writeFileSync(once, new Date().toISOString()); } catch { bail(); }

say(
  `A full run of \`${(cmd.match(RUNNERS) || [])[1] || 'the suite'}\` is the whole machine, and the machine is not free right now` +
  (census ? `: ${census.freeGB} GB left` : '') +
  (live ? `, with ${live} typecheck or test process(es) already running` : '') + `.\n\n` +
  // A brief worker has no queue to claim the verify lane from: `next` sends it back to its brief.
  (fs.existsSync(path.join(run, `brief-${chip}.md`))
    ? `Scope it: name the file, the project, or --changed. A brief has no verify lane; leave the full run to the coordinator.\n\n`
    : `Scope it, or claim the verify lane. The verify lane is one worker wide and it exists for this:\n\n` +
      `  scoped now:   name the file, the project, or --changed\n` +
      `  whole thing:  finish (or hand back) the repo task you hold, then sh <plugin>/scripts/fleet.sh next "${rel(run)}" ${chip} repo\n` +
      `                and run it when a \`needs: verify\` task is yours (a pane worker's pane task may stay open)\n\n`) +
  `The full sweep runs once, at the end, by whoever holds that task. This will not be raised again in this session.`
);
