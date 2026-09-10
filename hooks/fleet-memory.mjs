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
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findRuns, chipOf } from './run-dir.mjs';

const bail = () => process.exit(0);

let payload = {};
try {
  const raw = fs.readFileSync(0, 'utf8');
  payload = raw ? JSON.parse(raw) : {};
} catch { bail(); }

const tool = payload.tool_name || '';
const input = payload.tool_input || {};
const session = payload.session_id || process.env.CLAUDE_CODE_SESSION_ID || '';
if (!session) bail();

const BROWSER = /^mcp__.*[Bb]rowser__(navigate|preview_start|browser_batch|computer)$/;
if (tool !== 'Bash' && !BROWSER.test(tool)) bail();

// A whole-repository run of one of these. The scoping arguments are the ones that make it bounded: a path,
// a project, a name filter, or the changed set. `--watch` is excluded because a watcher is the operator's
// own long-running process and refusing it mid-run helps nobody.
const RUNNERS = /\b(vitest|jest|pytest|vue-tsc|tsc|gradlew?|mvn|cargo\s+test|go\s+test|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+test)\b/;
const SCOPED = /(--changed|--project|--testPathPattern|--test-name-pattern|-t\s|--tests\s|--watch|--related|\.(test|spec)\.[jt]sx?|\/[\w.-]+\.(ts|tsx|js|py|kt|java)\b|--noEmit\s+[^-])/;

const cmd = tool === 'Bash' ? String(input.command || '') : '';
if (tool === 'Bash' && (!RUNNERS.test(cmd) || SCOPED.test(cmd))) bail();

const { fleetDir, runs } = findRuns(payload.cwd || process.cwd());
if (!fleetDir) bail();
const { run, chip } = chipOf(runs, session);
if (!run || !chip) bail();

// Only now, with a fleet worker about to do something expensive, is the census worth its spawn.
//
// `FLEET_LOAD` names a different census script. It exists because the interesting behaviour here - the
// refusal - depends on how much memory the machine happens to have at the moment the test runs, and a
// guard whose decisive case cannot be exercised is a guard nobody can trust. A port that reads memory some
// other way uses the same door.
const loader = [
  process.env.FLEET_LOAD,
  path.join(import.meta.dirname ?? '.', '..', 'scripts', 'fleet-load.mjs'),
].filter(Boolean).find((f) => fs.existsSync(f));
let census = null;
if (loader) {
  try {
    const out = execFileSync(process.execPath, [loader, '--json'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
    const i = out.lastIndexOf('{"when"');
    if (i !== -1) census = JSON.parse(out.slice(i));
  } catch { /* a census that will not answer is not a reason to block work */ }
}

// A relative path that climbs out of the tree is worse than the absolute one it saved characters on.
const rel = (d) => {
  const r = path.relative(process.cwd(), d);
  return !r || r.startsWith('..') ? d.split(path.sep).join('/') : r.split(path.sep).join('/');
};

const say = (msg) => { process.stderr.write(msg + '\n'); process.exit(2); };

if (BROWSER.test(tool)) {
  if (!census || !census.tight) bail();
  const heaviest = census.groups?.['browser pane or window']?.maxMB;
  say(
    `The machine is down to ${census.freeGB} GB free and this session is driving a browser pane` +
    (heaviest ? `; the largest renderer on the box is ${heaviest} MB` : '') + `.\n\n` +
    `A pane holds its renderer until the tab is closed, and a reload returns none of it - one tab measured ` +
    `132 MB empty and 2,061 MB after a large page [M34]. Close the pane, then do this again:\n\n` +
    `  tabs_close on every tab of yours, then preview_start when you next need one.\n\n` +
    `Reopening costs a second and a login. Holding it costs the fleet.`
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
  .reduce((n, g) => n + g.n, 0);

if (!census?.tight && !live) bail();

// Raised once per session: a worker that cannot get past this stops trusting it and starts working around
// it, which is worse than the run it was going to make.
const once = path.join(run, 'chips', `${session}.memory-warned`);
if (fs.existsSync(once)) bail();
try { fs.writeFileSync(once, new Date().toISOString()); } catch { bail(); }

say(
  `A full run of \`${(cmd.match(RUNNERS) || [''])[0].trim()}\` is the whole machine, and the machine is not free right now` +
  (census ? `: ${census.freeGB} GB left` : '') +
  (live ? `, with ${live} typecheck or test process(es) already running` : '') + `.\n\n` +
  `Scope it, or claim the verify lane. The verify lane is one worker wide and it exists for this:\n\n` +
  `  scoped now:   name the file, the project, or --changed\n` +
  `  whole thing:  sh <plugin>/scripts/fleet.sh next ${rel(run)} ${chip} repo\n` +
  `                and run it when a \`needs: verify\` task is yours\n\n` +
  `The full sweep runs once, at the end, by whoever holds that task. This will not be raised again in this session.`
);
