// run-dir.mjs - where a hook finds the run it is standing in.
//
// Two hooks need this and they needed it slightly differently, which is how a rule stops having one
// spelling. It is here so both read the same one.
//
// Two things make it harder than reading `.fleet/` under the working directory. A hook can be handed a
// POSIX path on a machine whose node resolves Windows paths - Git Bash says `/c/Users/...` for what the
// harness calls `C:\Users\...`. And a worker that writes code runs inside a git worktree, where `.fleet/`
// does not exist at all: it is gitignored in every project that has run a fleet, so a fresh checkout never
// carries it. Looking only under the working directory is why the Stop hook has never once fired for a
// code worker, which is exactly the population it was written for.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

// Every spelling of one directory this host might hand us.
function spellings(dir) {
  const out = [dir];
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(dir);
  if (m) out.push(m[1].toUpperCase() + ':' + path.sep + m[2].split('/').join(path.sep));
  return out;
}

// The checkout a worktree belongs to. `--git-common-dir` is the main repository's `.git` in a worktree and
// the local one otherwise, so this returns the main checkout in both cases and costs one git call.
function mainCheckout(cwd) {
  for (const base of spellings(cwd)) {
    try {
      const common = execSync('git rev-parse --path-format=absolute --git-common-dir', {
        cwd: base, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (common) return path.dirname(common);
    } catch { /* not a checkout in this spelling */ }
  }
  return null;
}

// Every run directory reachable from here, main checkout included when this is a worktree. Never throws:
// a hook that cannot find a fleet has no work to do, and saying so with an exception would block a turn.
export function findRuns(cwd) {
  const look = (base) => {
    try {
      const dir = path.join(base, '.fleet');
      const runs = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(dir, e.name));
      if (runs.length) return { fleetDir: dir, runs };
    } catch { /* not here */ }
    return null;
  };

  // The common case first, and without asking git anything. These hooks sit on the Edit path, so a
  // subprocess spawned before the cheap check is one paid by every edit of every worker for the whole run.
  for (const base of spellings(cwd)) {
    const hit = look(base);
    if (hit) return hit;
  }

  // Only now is it worth a git call: no `.fleet/` under this directory is exactly the shape of a worktree,
  // where it never exists.
  const main = mainCheckout(cwd);
  if (main) {
    const hit = look(main);
    if (hit) return hit;
  }
  return { fleetDir: null, runs: [] };
}

// The chip this session is, in the first run that registered it, and the run it belongs to.
export function chipOf(runs, session) {
  for (const run of runs) {
    try {
      const chip = fs.readFileSync(path.join(run, 'chips', session), 'utf8').trim();
      if (chip) return { run, chip };
    } catch { /* not this run */ }
  }
  return { run: null, chip: null };
}
