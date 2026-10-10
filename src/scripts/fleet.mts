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
// selftest refuses a stale copy (src/build.sha256 everywhere; a full rebuild where the compiler is installed).

import type { Command } from './fleet/lib.mjs';
import { context, err, registerChip, chipTakenBy, pipeClosed } from './fleet/lib.mjs';
import { commands as queue } from './fleet/queue.mjs';
import { commands as watch } from './fleet/watch.mjs';
import { commands as planner } from './fleet/planner.mjs';
import { commands as pause } from './fleet/pause.mjs';
import { commands as ops } from './fleet/ops.mjs';
import { commands as pane } from './fleet/pane.mjs';
import { commands as trees } from './fleet/trees.mjs';

const commands: Record<string, Command> = { ...queue, ...watch, ...planner, ...pause, ...ops, ...pane, ...trees };

// ---- entry -----------------------------------------------------------------------------------------------

// fleet.sh switched Git Bash's argument conversion off for its exec of node; what node runs (git, hooks,
// `sh fleet.sh <other>`) gets the setting the caller had.
function restoreArgConversion(): void {
  const prev = process.env.FLEET_ARG_CONV_PREV;
  if (prev === undefined) return;
  if (prev === '__unset__') delete process.env.MSYS2_ARG_CONV_EXCL; else process.env.MSYS2_ARG_CONV_EXCL = prev;
  delete process.env.FLEET_ARG_CONV_PREV;
}

function main(argv: string[]): number {
  restoreArgConversion();
  const [sh = 'fleet.sh', cmd = '', run = '', ...rest] = argv;
  if (!cmd || !run) { err('usage: fleet.sh <command> <run-dir> [args]\n'); return 2; }
  const c = context(sh, run);
  // Every worker-side call whose third argument is the worker's own chip registers the session, not only
  // `next`: a worker on an assigned brief never calls `next`. `integration` is the coordinator's own tree.
  // A chip names files in the run: `drained <run> ../esc` wrote esc.done beside the run.
  if (['whoami', 'find', 'beat', 'finish', 'clock', 'ask', 'pane-ask', 'worktree', 'next', 'drained'].includes(cmd) && rest[0] && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(rest[0])) {
    err(`chip id '${rest[0]}' is not a name (letters, digits, _ and -)\n`);
    return 2;
  }
  if (['whoami', 'find', 'beat', 'finish', 'clock', 'ask', 'pane-ask', 'worktree', 'next', 'drained'].includes(cmd) && rest[0] && rest[0] !== 'integration') {
    const other = chipTakenBy(c, rest[0]);
    if (other) {
      err(`CHIP TAKEN: chip ${rest[0]} already runs in another live session (${other.slice(0, 8)}), so its chip was clicked twice. Do nothing in this run: end this turn with one line saying so, and close this chat.\n`);
      return 2;
    }
    registerChip(c, rest[0]);
  }
  // Own keys only: `toString` or `__proto__` would otherwise resolve through the prototype.
  const run_ = Object.hasOwn(commands, cmd) ? commands[cmd] : undefined;
  if (!run_) { err(`unknown command: ${cmd}\n`); return 2; }
  const rc = run_(c, rest);
  return pipeClosed() ? 141 : rc;
}

process.exit(main(process.argv.slice(2)));
