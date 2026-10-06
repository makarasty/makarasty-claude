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
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

// ---------------------------------------------------------------------------------------------------
// The helpers the hooks and the scripts beside them share, so each rule keeps one spelling.

const pluginRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// A number this plugin acts on, from calibration.json. The copy beside this code comes first: a cache
// snapshot or a working directory never outranks the plugin that is actually running (e774c09).
export function cal(key, fallback) {
  for (const dir of [pluginRoot, process.cwd()]) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(dir, 'calibration.json'), 'utf8'))[key];
      if (typeof v === 'number') return v;
    } catch { /* fall through to the next copy, then the default */ }
  }
  return fallback;
}

// A path as a person should type it: relative when it sits under the working directory, absolute with
// forward slashes when a relative one would have to climb out of the tree.
//
// A relative spelling is only an answer where it resolves. From a worktree under `.claude/worktrees/` the
// run lives in the main checkout's `.fleet/`, which the worktree does not carry, so a worker that copied
// the printed relative path got "no such run directory" on its first call. There the path is absolute, and
// so is any relative form that does not name an existing directory from here.
export function rel(d) {
  const abs = d.split(path.sep).join('/');
  const r = path.relative(process.cwd(), d);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) return abs;
  if (process.cwd().split(path.sep).join('/').includes('/.claude/worktrees/')) return abs;
  if (!fs.existsSync(path.resolve(process.cwd(), r))) return abs;
  return r.split(path.sep).join('/');
}

// A source file named in evidence. A path, not any dotted word: `scope.launch` is a call and `Commands.kt`
// is a file, and only an extension this list knows separates them. Either separator, and the extension has
// to end the name, or `Button.tsx` reads as `Button.ts` and `app.json` as `app.js`.
export const FILE_RE = /\b((?:[\w-]+[/\\])*[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|vue|svelte|java|kt|kts|scala|go|rb|py|php|cs|rs|swift|sql|rules|graphql|proto|ya?ml|toml|json|properties|css|scss|html))\b(?::\d+)?/gi;

// ---------------------------------------------------------------------------------------------------
// A pause the harness enforces, and a retirement it enforces. `fleet.sh pause <run>` writes `<run>/PAUSED`
// and a marker naming the run in ~/.claude/makarasty/paused/; `fleet.sh handback` writes `<run>/<chip>.retired`
// and a second kind of marker in the same directory (`<cksum>.retired`), which stays after the pause lifts.
// Measured 2026-10-05/06: "pause the fleet" was a sentence the coordinator sent to the workers, and they kept
// working for a long time - nothing stopped a worker mid-task, because nothing could: only a hook sits on the
// tool call. Both PreToolUse hooks call this one function so the rule has one spelling.
//
// Cost for everything that is not a paused or relaunched fleet is one readdir of a directory that usually does
// not exist, before the payload is looked at any further. Only then is a chip resolved, and it is resolved from
// the markers' own run paths rather than the working directory, so a worker in a worktree costs no git call.
//
// Not an instant wall. A worker mid-edit gets `pause_grace_seconds` (30) from its FIRST tool call after the
// pause - the mark is written with the notice, so a worker deep in a long call is not charged for the time it
// could not act - to finish the step in hand: that first call is refused once with the notice, calls during
// the rest of the grace pass, and after the grace only git, fleet.sh and the wake loop pass until the pause
// lifts. A worker that never calls is held at PAUSED + 4 x grace regardless. An ack (`fleet.sh paused`) skips
// the grace: a worker that has said it stopped is held to the list at once.
//
// Subagents: a subagent's hook payload is assumed to carry the PARENT's session_id (the chip map is keyed by
// it) and agent_id beside it. Neither is verified against a live harness payload: the field name `agent_id` is
// taken from the harness's documented hook input, and a harness that omits it falls back to the parent's rules,
// which only means a subagent is told what the parent is told. The same check covers a subagent's own tool
// calls after the grace, which is what stops a worker from pausing "itself" while three subagents carry on.
// The one-time notice is left for the parent: a subagent that consumed it would hide it from the session that
// has to run `fleet.sh paused`. New subagents (Agent/Task) are refused outright, in the grace too: a new
// subagent is never "finishing the step in hand".
//
// What is gated: Bash, PowerShell and Monitor (by the command allow-list below), Edit/Write/MultiEdit/
// NotebookEdit, Agent/Task, Skill and every browser tool. Other MCP tools - a database, a connector - are NOT
// gated: no matcher names them, and a blanket mcp__ matcher would put a node spawn on every call of every
// session. A worker's SQL or API write during a pause is a drift this does not stop.

const pausedRoot = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'makarasty', 'paused');

const FLEETSH = path.join(pluginRoot, 'scripts', 'fleet.sh').split(path.sep).join('/');
// Compared case-insensitively and with `/c/x` spelled `c:/x`, because Git Bash and node spell one path twice.
const normPath = (p) => p.trim().replace(/^\/([a-zA-Z])\//, (_, d) => `${d}:/`).replace(/\\/g, '/').toLowerCase();
const FLEETSH_N = normPath(FLEETSH);
const ALLOWED_FIRST = new Set(['git', 'sleep', 'echo', 'printf', 'exit', 'done', 'fi', 'cd', 'test', '[', '[[', 'true', 'false', 'date']);
const PIPE_TO = new Set(['head', 'tail', 'cat', 'wc', 'grep']);

// One pass over the raw command, quote-aware. Returns null when it holds anything this guard will not reason
// about - `$(`, a backtick, a single `&`, a redirect other than `2>&1`, `/dev/null` and `$null`, a `(` that is
// not at the start of a segment, a backslash before a quote, `<(`, an unbalanced quote - or the list of segments, each as {raw, flat, pipe}: `raw` as written and
// `flat` with every quoted string blanked to `Q`, so a `;` in a commit message does not start a "segment" and
// a `-c` in one is not a flag. `pipe` marks a segment that follows a single `|`.
function scan(cmd) {
  const segs = [];
  let raw = '', flat = '', q = null, pipe = false;
  const push = (nextPipe) => { segs.push({ raw: raw.trim(), flat: flat.trim(), pipe }); raw = ''; flat = ''; pipe = nextPipe; };
  for (let i = 0; i < cmd.length;) {
    const c = cmd[i], n = cmd[i + 1];
    if (q === "'") { raw += c; if (c === "'") q = null; i++; continue; }
    if (q === '"') {
      if (c === '\\') { raw += c + (n ?? ''); i += 2; continue; }
      if (c === '`' || (c === '$' && n === '(')) return null;
      raw += c; if (c === '"') q = null; i++; continue;
    }
    if (c === "'" || c === '"') { q = c; raw += c; flat += 'Q'; i++; continue; }
    if (c === '\\') {
      if (n === '"' || n === "'") return null;
      if (n === '\n' || n === '\r') { raw += ' '; flat += ' '; i += 2; continue; }
      raw += c + (n ?? ''); flat += 'x'; i += 2; continue;
    }
    if (c === '`' || (c === '$' && n === '(') || (c === '<' && n === '(')) return null;
    // PowerShell `(npm t)` and `@(npm t)` run what is inside, so a `(` is only a subshell at the start of a segment.
    if (c === '(' && !/^[\s(]*$/.test(raw)) return null;
    if (c === '>') {
      const m = /^>(?:&1|\s*\/dev\/null(?![\w./-])|\s*\$null(?!\w))/.exec(cmd.slice(i));
      if (!m) return null;
      raw += m[0]; i += m[0].length; continue;
    }
    if (c === '&') { if (n !== '&') return null; push(false); i += 2; continue; }
    if (c === '|') { if (n === '|') { push(false); i += 2; } else { push(true); i++; } continue; }
    if (c === ';' || c === '\n' || c === '\r') { push(false); i++; continue; }
    raw += c; flat += c; i++;
  }
  if (q) return null;
  push(false);
  return segs;
}

// Quote-aware words of one segment's raw text: {t: the word with its quotes and backslashes taken out, q:
// whether it had any}. The flat text blanks a quoted word to `Q`, which is how `git "-c" x` and `-x"cmd"` passed.
function words(raw) {
  const out = [];
  let t = '', q = false, inq = null, any = false;
  const end = () => { if (any) out.push({ t, q }); t = ''; q = false; any = false; };
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inq) {
      if (c === inq) inq = null;
      else if (c === '\\' && inq === '"') { t += raw[i + 1] ?? ''; i++; } else t += c;
      continue;
    }
    if (c === '"' || c === "'") { inq = c; q = true; any = true; continue; }
    if (c === '\\') { q = true; any = true; t += raw[i + 1] ?? ''; i++; continue; }
    if (/\s/.test(c)) { end(); continue; }
    t += c; any = true;
  }
  end();
  return out;
}

// `git` with its global options and subcommand read off the raw words. Refused: anything that makes git run
// some other program - `-c` (alias.x='!cmd', core.pager, core.sshCommand), --exec-path, --ext-diff, rebase
// -x/--exec, bisect run, submodule foreach, filter-branch, config, difftool, --upload-pack, grep -O - and any
// option or subcommand spelled with a quote or a backslash (`git "-c" ...`, `git "rebase" -x`), which is how a
// word hid from the flat text. A quoted ARGUMENT (`-C "dir"`, `-m "msg"`) is fine. Prefixes count: git takes
// `--exe` for `--exec`, and `-x"cmd"` is `-xcmd`.
function gitAllowed(raw) {
  const t = words(raw).slice(1);
  let i = 0;
  while (i < t.length && t[i].t.startsWith('-')) {
    const o = t[i];
    if (o.q) return false;
    if (o.t === '-C' || /^--(git-dir|work-tree|namespace|super-prefix)$/.test(o.t)) { i += 2; continue; }
    if (/^-c/.test(o.t) || /^--(ex|config-env)/.test(o.t)) return false;
    i++;
  }
  if (t[i]?.q) return false;
  const sub = t[i]?.t || '', rest = t.slice(i + 1).map((x) => x.t);
  if (rest.some((x) => /^--(ext|up|receive-pack)/.test(x))) return false;
  if (sub === 'filter-branch' || sub === 'config' || sub === 'difftool') return false;
  if (sub === 'rebase' && rest.some((x) => /^(-x|--ex)/.test(x))) return false;
  if (sub === 'grep' && rest.some((x) => /^(-[A-Za-z]*O|--op)/.test(x))) return false;
  if (sub === 'bisect' && rest[0] === 'run') return false;
  if (sub === 'submodule' && rest.includes('foreach')) return false;
  return true;
}

// The script argument of `sh <word>`: this plugin's fleet.sh by its exact path (quoted or not), the documented
// `"${CLAUDE_PLUGIN_ROOT}/scripts/fleet.sh"`, or the variable `"$f"` a worker set to it. Never a basename match:
// `sh ./fleet.sh` in a worktree is somebody's file.
function fleetScriptWord(word, direct) {
  const w = word.replace(/^(["'])(.*)\1$/, '$2');
  if (!direct && /^\$\{?f\}?$/.test(w)) return true;
  if (/^\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/fleet\.sh$/.test(w)) return true;
  return normPath(w) === FLEETSH_N;
}

// Is this shell command only git, fleet.sh and a wake loop? A drift guard, not a sandbox: the worker is not
// adversarial, it is a model that has been told to stop and might not. It refuses what it cannot reason about
// (see `scan`), then checks every command position: one `npm test` chained after a `git status` is still an
// `npm test`. Loop keywords are stripped only at the start of a segment, so a path or a branch called
// `fleet/01/do-it` is never split. A trailing `| head|tail|cat|wc|grep` is fine; VAR=value on its own is fine.
export function allowedWhilePaused(cmd) {
  const segs = scan(String(cmd || ''));
  if (!segs) return false;
  const lead = /^(?:(?:do|then|else|elif|if|while|until|time|!|\{)(?=\s|$)\s*|\(\s*)/;
  let any = false;
  for (const seg of segs) {
    let s = seg.flat, r = seg.raw;
    for (let k = 0; k < 6; k++) { const s2 = s.replace(lead, ''); if (s2 === s) break; s = s2; r = r.replace(lead, ''); }
    s = s.replace(/\s*[)}]+$/, '').trim();
    if (s === '}' || (s === '' && r === '')) continue;
    // Assignments before the command. Names that change what a program runs are refused.
    for (;;) {
      const m = /^(\w+)=(?:"[^"]*"|'[^']*'|\S*)\s*/.exec(r);
      if (!m) break;
      if (/^(GIT_|XDG_|LD_|PATH$|BASH_ENV$|ENV$|IFS$|SHELLOPTS$|PAGER$|EDITOR$|VISUAL$|HOME$)/.test(m[1])) return false;
      r = r.slice(m[0].length); s = s.replace(/^\w+=\S*\s*/, '');
    }
    if (!s) { any = true; continue; }
    any = true;
    const first = s.split(/\s+/)[0];
    if (seg.pipe) { if (PIPE_TO.has(first)) continue; return false; }
    if (/[\\/]/.test(first) || first === 'Q') {
      const word = /^("[^"]*"|'[^']*'|\S+)/.exec(r)?.[1] || '';
      if (fleetScriptWord(word, true)) continue;
      return false;
    }
    const tok = first.replace(/\.exe$/i, '').toLowerCase();
    if (tok === 'git') { if (gitAllowed(r.replace(/\s*[)}]+$/, ''))) continue; return false; }
    if (/^(sh|bash|zsh)$/.test(tok)) {
      const word = /^\S+\s+(?:-\w+\s+)*("[^"]*"|'[^']*'|\S+)/.exec(r)?.[1] || '';
      if (fleetScriptWord(word)) continue;
      return false;
    }
    if (ALLOWED_FIRST.has(tok)) continue;
    return false;
  }
  return any;
}

const q = (p) => `"${p}"`;

// null = let the call through, otherwise the sentence to refuse it with (the caller exits 2).
export function pauseGate(payload) {
  let markers;
  try { markers = fs.readdirSync(pausedRoot()); } catch { return null; }
  if (!markers.length) return null;

  const session = payload.session_id || process.env.CLAUDE_CODE_SESSION_ID || '';
  if (!session) return null;
  const tool = payload.tool_name || '';
  const input = payload.tool_input || {};

  const seen = new Set();
  for (const m of markers) {
    let run;
    try { run = fs.readFileSync(path.join(pausedRoot(), m), 'utf8').trim(); } catch { continue; }
    if (!run || seen.has(run)) continue;
    seen.add(run);
    let chip;
    try { chip = fs.readFileSync(path.join(run, 'chips', session), 'utf8').trim(); } catch { continue; } // not a worker of this run
    if (!chip) continue;

    // A chip a relaunch replaced is held whether or not the run is paused: the pause lifts, the retirement
    // does not. Checked first, because a retired worker has nothing in hand worth protecting.
    // Until the run lands: a finished run holds nobody, and a retired chat is never reused.
    if (fs.existsSync(path.join(run, `${chip}.retired`)) && !fs.existsSync(path.join(run, 'FINISHED'))) {
      return `RETIRED: a relaunch replaced worker ${chip} and handed its task back to a fresh worker. ` +
        `You were retired: end this turn with one line, commit nothing, start nothing.`;
    }

    let pausedAt;
    try { pausedAt = fs.statSync(path.join(run, 'PAUSED')).mtimeMs; } catch { continue; } // not paused, or a stale marker
    // A worker that finished has nothing in hand to protect.
    if (fs.existsSync(path.join(run, `${chip}.done`)) || fs.existsSync(path.join(run, `${chip}.blocked`))) continue;

    const subagent = Boolean(payload.agent_id);
    const acked = fs.existsSync(path.join(run, 'stopped', chip));
    const graceMs = cal('pause_grace_seconds', 30) * 1000;
    const ceiling = pausedAt + 4 * graceMs;
    const runAbs = run.split(path.sep).join('/');
    let wt = '<wt>';
    try { wt = (/^path (.+)$/m.exec(fs.readFileSync(path.join(run, 'worktrees', chip), 'utf8')) || [])[1] || wt; } catch { /* no tree registered */ }
    const ack = `sh ${q(FLEETSH)} paused ${q(runAbs)} ${chip} "<where you stopped, what is next>"`;
    const stopLine = `stop your subagents and background shells (TaskStop each one; the abort clock needs no stopping, it stands still on its own)`;

    if (/^(Agent|Task)$/.test(tool)) {
      return `RUN PAUSED by the operator: this call did not run. No new subagent starts while the run is paused, grace or not. ` +
        `Finish the step in hand yourself, then run \`${ack}\`, background the wake loop it prints and end your turn.`;
    }

    // The grace starts at this session's first call after PAUSED, and is remembered beside the notice.
    const mark = path.join(run, 'chips', `${session}.pause-notice`);
    const since = String(pausedAt);
    let first = 0;
    try { const [s, f] = fs.readFileSync(mark, 'utf8').split(' '); if (s === since) first = Number(f) || 0; } catch { /* not shown yet */ }
    const now = Date.now();
    // A session that has not called yet is held at the ceiling - except a subagent whose parent has not called
    // either, which is the normal case (the parent sits blocked inside Agent): its grace runs from the pause.
    const endMs = first ? Math.min(first + graceMs, ceiling) : subagent ? pausedAt + graceMs : ceiling;

    if (acked || now >= endMs) {
      const shell = tool === 'Bash' || tool === 'PowerShell' || tool === 'Monitor';
      if (shell && allowedWhilePaused(input.command)) return null;
      // A line refused for its syntax (scan gave up), most often backticks around a name in a note or a
      // commit message: say why, or the worker retries the same line and its ack never lands. A line scan
      // read but refused for its commands (npm, git -c) gets no such text, since its syntax was not the cause.
      const why = shell && !scan(String(input.command || ''))
        ? ' This line was refused for its shell syntax, not its commands: a backtick, $(, <(, a lone &, a > redirect other than 2>&1 or /dev/null, a ( in mid-line, an escaped quote or an unbalanced quote. Put a note or message in single quotes, without backticks, and run it again.'
        : '';
      if (subagent) {
        return `RUN PAUSED by the operator${acked ? '' : ' and the grace is over'}: this call did not run. You are a subagent of worker ${chip}: stop now and return what you have; your parent commits it and stops.`;
      }
      if (acked) {
        return `RUN PAUSED by the operator and you have stopped: this call did not run. Only git, fleet.sh and the wake loop run now.${why} ` +
          `Background the wake loop your \`paused\` call printed (it ends when the pause lifts or you are retired), end your turn and start nothing else.`;
      }
      return `RUN PAUSED by the operator and the grace is over: this call did not run. Only git, fleet.sh and the wake loop run now.${why} ` +
        `Commit work in progress on your task branch (\`git -C ${q(wt)} add -A; git -C ${q(wt)} commit -m "wip: paused"\`, skip if clean), ` +
        `${stopLine}, run \`${ack}\`, background the wake loop it prints, end your turn and start nothing else.`;
    }

    // Inside the grace, unacknowledged. A subagent's call passes (the parent owns the notice); the parent's
    // first call is refused once, then calls pass so it can finish what it was doing.
    if (subagent || first) return null;
    try { fs.writeFileSync(mark, `${since} ${now}`); } catch { return null; } // a notice that cannot be remembered would repeat on every call
    const left = Math.max(1, Math.ceil((Math.min(now + graceMs, ceiling) - now) / 1000));
    return `RUN PAUSED by the operator. This call did not run; repeat it if it is part of finishing the step in hand. ` +
      `You have ${left} s from now: save the step, commit work in progress on your task branch ` +
      `(\`git -C ${q(wt)} add -A; git -C ${q(wt)} commit -m "wip: paused"\`, skip if clean), ${stopLine}, ` +
      `then run \`fleet.sh paused\`, background the wake loop it prints, and end your turn. ` +
      `After that every call except git, fleet.sh and the wake loop is refused.\n` +
      `  ${ack}`;
  }
  return null;
}
