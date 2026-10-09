// fleet.mts - the commands of fleet.sh that moved to TypeScript, compiled to scripts/fleet.mjs.
//
// fleet.sh forks a process for nearly every line, and on Git Bash a fork costs about 25 ms: measured
// 2026-10-08 on a 62-task queue, `next` took 6-11 s and fleet.sh's preamble alone 0.4-0.6 s before any
// command ran. Here node starts once and reads the run directory itself.
//
// fleet.sh stays the interface: it hands a ported command to `node fleet.mjs <fleet.sh path> <cmd> <run>
// [args]` before its own preamble, and runs its shell branch only where node is absent. Every printed
// line and exit code matches the shell branch it replaces; fleet-selftest.sh pins them.
//
// Compiled rather than run as .ts: node strips types again on every start, measured +14 ms for a small
// file and +82 ms for a 3,400-line one, on a path every worker walks before every task.
// Edit src/scripts/fleet.mts, never scripts/fleet.mjs: `npm run build --prefix src` writes the .mjs, and the
// selftest refuses a stale copy wherever the pinned compiler is installed (`npm install --prefix src`).

import type { Command } from './fleet/lib.mjs';
import { context, err, registerChip } from './fleet/lib.mjs';
import { commands as queue } from './fleet/queue.mjs';
import { commands as watch } from './fleet/watch.mjs';
import { commands as planner } from './fleet/planner.mjs';
import { commands as pause } from './fleet/pause.mjs';
import { commands as ops } from './fleet/ops.mjs';
import { commands as pane } from './fleet/pane.mjs';
import { commands as trees } from './fleet/trees.mjs';

const commands: Record<string, Command> = { ...queue, ...watch, ...planner, ...pause, ...ops, ...pane, ...trees };

// ---- entry -----------------------------------------------------------------------------------------------

function main(argv: string[]): number {
  const [sh = 'fleet.sh', cmd = '', run = '', ...rest] = argv;
  if (!cmd || !run) { err('usage: fleet.sh <command> <run-dir> [args]\n'); return 2; }
  const c = context(sh, run);
  // Every worker-side call whose third argument is the worker's own chip registers the session, not only
  // `next`: a worker on an assigned brief never calls `next`. `integration` is the coordinator's own tree.
  if (['whoami', 'find', 'beat', 'finish', 'clock', 'ask', 'pane-ask', 'worktree'].includes(cmd) && rest[0] && rest[0] !== 'integration') {
    registerChip(c, rest[0]);
  }
  // Own keys only: `toString` or `__proto__` would otherwise resolve through the prototype.
  const run_ = Object.hasOwn(commands, cmd) ? commands[cmd] : undefined;
  if (!run_) { err(`unknown command: ${cmd}\n`); return 2; }
  return run_(c, rest);
}

process.exit(main(process.argv.slice(2)));
