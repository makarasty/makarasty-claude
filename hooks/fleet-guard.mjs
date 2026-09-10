#!/usr/bin/env node
// fleet-guard.mjs - the one thing only the harness can see: a worker ending its turn while it still holds
// a task nobody closed.
//
// Measured across two runs [M03]: three workers ended a turn immediately after claiming, wrote a confident
// summary of what they were about to do, and sat dead for 169, 171 and 176 minutes each. Nothing in a
// fleet types into a worker's chat, so nothing could restart them. That failure is invisible to every
// script in this plugin - the disk looks identical whether the worker is thinking or gone - and visible to
// a Stop hook, which is why this file exists and why nothing else does.
//
// It is deliberately timid:
//   - no `.fleet/` under the working directory, or no chip registered for this session -> exit 0, no work
//   - the worker already wrote `.done` or `.blocked` -> exit 0
//   - `stop_hook_active` -> exit 0, so it can never block twice in a row
//   - it blocks a given claim once, ever, and records that it did
// Exit 2 with a sentence on stderr is Claude Code's "do not stop yet, here is why".

import fs from 'node:fs';
import path from 'node:path';
import { findRuns } from './run-dir.mjs';

const bail = () => process.exit(0);

// How long after a claim this hook still treats silence as death. Past it, a quiet claim is long work and
// belongs to the planner's sweep. Read from calibration.json so it has one spelling, like every other
// constant here.
const windowMin = (() => {
  for (const dir of [path.join(import.meta.dirname ?? '.', '..'), process.cwd()]) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(dir, 'calibration.json'), 'utf8')).hook_claim_window_minutes;
      if (typeof v === 'number') return v;
    } catch { /* fall through to the default */ }
  }
  return 10;
})();

let payload = {};
try {
  const raw = fs.readFileSync(0, 'utf8');
  payload = raw ? JSON.parse(raw) : {};
} catch { bail(); }

if (payload.stop_hook_active) bail();

const session = payload.session_id || process.env.CLAUDE_CODE_SESSION_ID || '';
const cwd = payload.cwd || process.cwd();
if (!session) bail();

const { fleetDir, runs } = findRuns(cwd);
if (!fleetDir) bail();

for (const run of runs) {
  const chipFile = path.join(run, 'chips', session);
  let chip;
  try { chip = fs.readFileSync(chipFile, 'utf8').trim(); } catch { continue; }
  if (!chip) continue;

  // A worker that has written its completion marker owes the disk nothing.
  if (fs.existsSync(path.join(run, `${chip}.done`)) || fs.existsSync(path.join(run, `${chip}.blocked`))) continue;

  let claimed = [];
  try { claimed = fs.readdirSync(path.join(run, 'tasks', 'claimed'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { continue; }

  for (const id of claimed) {
    if (/\.(dead|released)-/.test(id)) continue;
    if (fs.existsSync(path.join(run, 'tasks', 'done', id))) continue;
    const claimDir = path.join(run, 'tasks', 'claimed', id);
    let owner = '';
    try { owner = fs.readFileSync(path.join(claimDir, 'owner'), 'utf8'); } catch { continue; }
    if (!owner.split('\n').some((l) => l.trim() === `chip ${chip}`)) continue;

    // Holding a claim is not the failure. The failure is claiming as the closing act of a turn and never
    // touching it again [M03], and it has a signature: the heartbeat still equals the claim time, and the
    // claim is minutes old. A worker that has written a heartbeat is working, and a worker that armed a
    // clock and stopped is doing what the protocol asks - blocking either of those costs a turn and
    // teaches the next worker to distrust the hook.
    let beaten = false;
    try {
      const claimedAt = (/^claimed (.+)$/m.exec(owner) || [])[1];
      const beat = fs.readFileSync(path.join(claimDir, 'heartbeat'), 'utf8').trim();
      beaten = Boolean(beat) && beat !== (claimedAt || '').trim();
    } catch { beaten = false; }
    if (beaten) continue;

    let ageMin = 0;
    try { ageMin = (Date.now() - fs.statSync(claimDir).mtimeMs) / 60000; } catch { ageMin = 0; }
    if (ageMin > windowMin) continue;

    // Block this claim once. A second stop on the same claim is the worker's decision to make.
    const once = path.join(run, 'chips', `${session}.warned-${id}`);
    if (fs.existsSync(once)) continue;
    // If the marker cannot be written, this block would repeat on every turn end. A hook that cannot
    // remember what it has already said is worse than one that says nothing.
    try { fs.writeFileSync(once, new Date().toISOString()); } catch { continue; }

    process.stderr.write(
      `You still hold ${id} in run ${path.basename(run)} and it has no done marker. ` +
      `Act on it now, record what is left as unreached and finish it, or hand it back - ` +
      `a turn that ends here ends this session, and nothing in a fleet can restart it.\n`
    );
    process.exit(2);
  }
}

bail();
