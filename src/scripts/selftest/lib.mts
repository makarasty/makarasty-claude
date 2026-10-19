// lib.mts - what every part of the fleet self-test shares: an isolated run directory, fleet.sh run through
// sh the way a worker runs it, the check helpers, the calibration readers and the fixture writers.
//
// The self-test used to be one sh file of 3,700 lines, every case leaning on state the cases above it left.
// Here each test file builds its own state from setup(), so `node --test` can run the files at once; a
// file is its own process, which is why setup() may set this process's env and cwd for the whole file.
//
//   node --test src/scripts/selftest/            every file, the TypeScript run directly by node
//   node --test scripts/selftest/                the same files as tsc compiled them
//
// A check is a node:test test named exactly as the sh check was. Its actual value is taken when check() is
// called, so the actions run in the order they are written and the tests only compare what was captured.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Forward slashes everywhere: sh, git and node all take C:/x, and a backslash path pasted into a sh
// command line or a JSON payload is the escaping bug the sh version kept meeting.
export const fwd = (p: string): string => p.split('\\').join('/');

// The plugin root, from either src/scripts/selftest/ (run by node directly) or scripts/selftest/ (compiled).
// Both test the shipped scripts/, never src/: the .mjs beside fleet.sh is what a worker runs.
const up2 = resolve(import.meta.dirname, '..', '..');
export const ROOT = fwd(basename(up2) === 'src' ? dirname(up2) : up2);
// The sh version's $here.
export const SCRIPTS = `${ROOT}/scripts`;
export const FLEET_SH = `${SCRIPTS}/fleet.sh`;
export const HOOKS = `${ROOT}/hooks`;

// ---- calibration -----------------------------------------------------------------------------------------

// The abort deadline, the clock's rounds, the context marks and the pause grace come from calibration.json,
// so an operator who edits it must not see a red self-test on a healthy install: read what the script reads.
const CAL = `${ROOT}/calibration.json`;
export function calk(key: string, def: number): number {
  try {
    const v: unknown = (JSON.parse(readFileSync(CAL, 'utf8')) as Record<string, unknown>)[key];
    return typeof v === 'number' ? v : def;
  } catch { return def; }
}
export const MULT = calk('budget_multiplier', 2);
export const POLL = calk('clock_poll_seconds', 30);
export const HAT = calk('coordinator_handoff_k', 700);
export const WAT = calk('worker_relaunch_k', 700);
export const GRACE = calk('pause_grace_seconds', 30);
export const CK = HAT + 40;
export const WK = WAT + 50;

// ---- the run ---------------------------------------------------------------------------------------------

export interface Ctx {
  base: string;     // this file's private temp directory; everything below lives in it
  run: string;      // the sh version's $run, with tasks/ready made; the cwd of this process
  cfg: string;      // CLAUDE_CONFIG_DIR, never the real one
  loadstub: string; // FLEET_LOAD: a census that always has room
  tmp: (name: string) => string; // a fresh directory under base, the sh version's ${TMPDIR}/<name>-$$
}

let scratch = '';
let outN = 0;

// One per test file. It also puts this process where the sh version stood: in the run directory (a fleet
// path that comes back empty then finds no repository at all), with no session id of the chat running the
// test (fleet.sh would record it as a coordinator), and with a census that never refuses a claim.
export function setup(name: string): Ctx {
  const base = fwd(mkdtempSync(join(tmpdir(), `fleet-${name}-`)));
  scratch = `${base}/.out`;
  mkdirSync(scratch);
  const run = `${base}/fleet-selftest-${process.pid}`;
  mkdirSync(`${run}/tasks/ready`, { recursive: true });
  const cfg = `${base}/fleet-cfg`;
  mkdirSync(cfg);
  const loadstub = `${base}/fleet-load-stub.mjs`;
  writeFileSync(loadstub, "if (process.argv.includes('--clear')) process.exit(0);\n"
    + 'console.log(JSON.stringify({ when: new Date().toISOString(), totalGB: 64, freeGB: 60, tight: false, sessions: 0, panes: 0, groups: {} }));\n');
  process.env.LC_ALL = 'C';
  process.env.CLAUDE_CONFIG_DIR = cfg;
  process.env.FLEET_LOAD = loadstub;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  process.chdir(run);
  process.on('exit', () => {
    process.chdir(tmpdir()); // Windows will not remove the directory a process stands in
    if (process.env.FLEET_SELFTEST_KEEP) console.log(`run directory kept: ${base}`);
    else rmSync(base, { recursive: true, force: true });
  });
  const tmp = (n: string): string => { const d = `${base}/${n}`; mkdirSync(d, { recursive: true }); return d; };
  return { base, run, cfg, loadstub, tmp };
}

// ---- running things --------------------------------------------------------------------------------------

export interface Out { out: string; code: number }
export interface RunOpts {
  cwd?: string;
  // Merged over process.env; undefined removes a variable (`unset FLEET_LOAD`, `env -u ...`).
  env?: Record<string, string | undefined>;
  // stdin. A pipe from node is not a file Git Bash can open again as /dev/stdin, so a case that hands
  // fleet.sh the path /dev/stdin redirects inside sh() instead: sh(`sh "$FLEET_SH" file ... /dev/stdin < f`).
  input?: string | Buffer;
  // Only stdout, as `out=$(cmd)` with no 2>&1 kept it; stderr is dropped. The default is both, in order.
  stdoutOnly?: boolean;
  // Only stderr, as `2>&1 >/dev/null` kept it: what a hook that exits 2 hands the harness.
  stderrOnly?: boolean;
}

function envOf(o: RunOpts): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(o.env ?? {})) {
    // Windows keeps one Path under any case, so remove every spelling before setting it.
    for (const have of Object.keys(e)) if (have.toUpperCase() === k.toUpperCase()) delete e[have];
    if (v !== undefined) e[k] = v;
  }
  return e;
}

// What `$(...)` does to a command's output: trailing newlines go, and Git Bash cuts CRLF pairs as well.
const cut = (s: string): string => s.replace(/(\r?\n)+$/, '');

function outFile(): string {
  if (!scratch) throw new Error('selftest lib: call setup() before running anything');
  return `${scratch}/${++outN}`;
}

// stdout and stderr into one file through one descriptor, so a refusal printed to stderr between two
// stdout lines lands between them, as `2>&1` put it. Two pipes read after the exit cannot say the order.
function stdioFor(file: string, o: RunOpts): { fd: number; outFd: number | 'ignore'; errFd: number | 'ignore' } {
  const fd = openSync(file, 'w');
  return { fd, outFd: o.stderrOnly ? 'ignore' : fd, errFd: o.stdoutOnly ? 'ignore' : fd };
}

const exitOf = (status: number | null, signal: string | null): number =>
  status ?? (signal === 'SIGPIPE' ? 141 : signal === 'SIGTERM' ? 143 : signal === 'SIGKILL' ? 137 : 1);

export function exec(cmd: string, args: string[], o: RunOpts = {}): Out {
  const file = outFile();
  const { fd, outFd, errFd } = stdioFor(file, o);
  try {
    const r = spawnSync(cmd, args, { cwd: o.cwd, env: envOf(o), input: o.input ?? '', stdio: ['pipe', outFd, errFd] });
    if (r.error) throw r.error;
    return { out: cut(readFileSync(file, 'utf8')), code: exitOf(r.status, r.signal) };
  } finally { closeSync(fd); }
}

// The same, not waiting: for the cases that start several claimers at the same instant.
export function execAsync(cmd: string, args: string[], o: RunOpts = {}): Promise<Out> {
  const file = outFile();
  const { fd, outFd, errFd } = stdioFor(file, o);
  return new Promise((done, fail) => {
    const c = spawn(cmd, args, { cwd: o.cwd, env: envOf(o), stdio: ['pipe', outFd, errFd] });
    c.stdin?.end(o.input ?? '');
    c.on('error', (e) => { closeSync(fd); fail(e); });
    c.on('close', (status, signal) => {
      closeSync(fd);
      done({ out: cut(readFileSync(file, 'utf8')), code: exitOf(status, signal) });
    });
  });
}

// The shell every fleet.sh call and sh -c snippet runs under. FLEET_SELFTEST_SH=dash checks the strict
// POSIX claim, as `dash scripts/fleet-selftest.sh` did; the default is the sh a worker gets.
export const SHELL = process.env.FLEET_SELFTEST_SH || 'sh';
// fleet.sh through sh, exactly as a worker calls it: the sh entry is the contract under test, so a case
// the sh version ran as `sh "$fleet" ...` never calls fleet.mjs directly.
export const fleet = (args: string[], o: RunOpts = {}): Out => exec(SHELL, [FLEET_SH, ...args], o);
export const fleetAsync = (args: string[], o: RunOpts = {}): Promise<Out> => execAsync(SHELL, [FLEET_SH, ...args], o);
// A command line for sh -c, for what only a shell can say: a pipe that closes, `timeout`, an eval'd clock.
export const sh = (script: string, o: RunOpts = {}): Out => exec(SHELL, ['-c', script], o);
export const node = (args: string[], o: RunOpts = {}): Out => exec(process.execPath, args, o);
export const git = (cwd: string, ...args: string[]): Out => exec('git', ['-C', cwd, ...args]);
// Whether sh finds a program (`command -v cmd`, icacls, timeout): the sh version's platform switches.
export const has = (prog: string): boolean => exec(SHELL, ['-c', 'command -v "$0" >/dev/null 2>&1', prog]).code === 0;

// A directory as fleet.sh spells it: `pwd -W` under Git Bash (C:/x), `pwd` elsewhere. Always through `sh`,
// not SHELL: fleet.sh hands the path to fleet.mjs, which spells it C:/x under any shell, and dash has no -W.
export const shPwd = (dir: string): string => exec('sh', ['-c', 'pwd -W 2>/dev/null || pwd'], { cwd: dir }).out;
// A directory as a hook is handed it: the operating system's own spelling, which node's cwd reports.
export const nativePath = (dir: string): string => resolve(dir);

// ---- hooks -----------------------------------------------------------------------------------------------

// A hook run on a payload, answered as "<exit> <output>" - the shape every hook case reads from its start.
export function hook(hookPath: string, payload: Record<string, unknown>, o: RunOpts = {}): string {
  const r = node([hookPath], { ...o, input: JSON.stringify(payload) });
  return `${r.code} ${r.out}`;
}

// hp <hook> <cwd> <session> <tool> <command-or-json> [agent-id]: a tool call by a session standing in cwd.
// A tool input that starts with { is the input itself; anything else is a Bash command.
export function hp(hookPath: string, cwd: string, session: string, tool: string, input: string, agentId = '', o: RunOpts = {}): string {
  const p: Record<string, unknown> = {
    session_id: session, cwd: nativePath(cwd), tool_name: tool,
    tool_input: input.startsWith('{') ? JSON.parse(input) as unknown : { command: input },
  };
  if (agentId) p.agent_id = agentId;
  return hook(hookPath, p, o);
}

// ---- checks ----------------------------------------------------------------------------------------------

// The `got:` line the sh version printed: one line, newlines as |, cut at 160 characters.
const flat = (s: string): string => s.split('\n').join('|').slice(0, 160);

// check <name> <expected-substring> <actual>
export function check(name: string, want: string, got: string): void {
  test(name, () => { if (!got.includes(want)) assert.fail(`got: ${flat(got)}`); });
}
// The `case "$out" in *x*) bad ...` cases: the actual must not hold the text.
export function absent(name: string, unwanted: string, got: string): void {
  test(name, () => { if (got.includes(unwanted)) assert.fail(`got: ${flat(got)}`); });
}
// code <name> <expected-exit> <actual-exit>
export function code(name: string, want: number, got: number): void {
  test(name, () => { if (got !== want) assert.fail(`exit ${got}, wanted ${want}`); });
}
// starts <name> <expected-prefix> <actual>: a hook's "<exit> <stderr>", read from its start
// (a substring "0 " also matched the "30 s from now" inside a refusal).
export function starts(name: string, want: string, got: string): void {
  test(name, () => { if (!got.startsWith(want)) assert.fail(`got: ${flat(got)}`); });
}
// The `[ -e x ] && ok ... || bad ... "<detail>"` cases.
export function truthy(name: string, cond: boolean, detail = ''): void {
  test(name, () => { if (!cond) assert.fail(detail ? `got: ${flat(detail)}` : 'failed'); });
}
// The sh version's `echo "  skip  ..."`.
export function skip(name: string, reason: string): void {
  test(name, { skip: reason }, () => {});
}

// ---- fixtures --------------------------------------------------------------------------------------------

// printf > file, making the parent first.
export function write(p: string, s: string | Buffer): void { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); }
// `cat file 2>/dev/null`, untrimmed.
export function read(p: string): string { try { return readFileSync(p, 'utf8'); } catch { return ''; } }
export const exists = (p: string): boolean => existsSync(p);
// A directory's names, or none when it is missing; ls() is the same as a failure detail, the error kept.
export function names(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } }
export const ls = (...dirs: string[]): string => dirs.map((d) => { try { return readdirSync(d).join('\n'); } catch (e) { return String(e); } }).join('\n');
export function mk(...dirs: string[]): void { for (const d of dirs) mkdirSync(d, { recursive: true }); }
export function rm(...paths: string[]): void { for (const p of paths) rmSync(p, { recursive: true, force: true }); }

// touch, or `touch -t` / `touch -d` with a time: makes the file when missing, like touch.
export const OLD = new Date(2020, 0, 1, 0, 0); // touch -t 202001010000, local time
export const ago = (seconds: number): Date => new Date(Date.now() - seconds * 1000);
export function touch(p: string, when: Date = new Date()): void {
  if (!existsSync(p)) writeFileSync(p, '');
  utimesSync(p, when, when);
}

// `sleep 1`, blocking: the cases that need two writes in different mtime seconds stay straight-line code.
export function sleep(seconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

// task <run> <id> <lane> <budget>: a task that exists to be claimed.
export function task(run: string, id: string, needs: string, budget: number | string): void {
  write(`${run}/tasks/ready/${id}.md`, `---\ntask-id: ${id}\nneeds: ${needs}\nbudget: ${budget}\n---\n## Steps\n1. Nothing. This task exists to be claimed.\n`);
}

// `cp -r "$here/fleet.sh" "$here/fleet.mjs" "$here/fleet" <dir>/`, plus any other script named: a copy of
// fleet.sh that reads the calibration.json put beside its parent directory.
export function copyFleet(dir: string, ...extra: string[]): void {
  mkdirSync(dir, { recursive: true });
  for (const f of ['fleet.sh', 'fleet.mjs', 'fleet', ...extra]) cpSync(`${SCRIPTS}/${f}`, `${dir}/${f}`, { recursive: true });
}

// A directory junction on Windows (what `mklink /J` makes), a symlink elsewhere. False when the host
// refuses, which the sh version reported as a skip.
export function junction(link: string, target: string): boolean {
  try { symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); return true; } catch { return false; }
}

// The watch loop in commands/fleet-wait.md: the first ```sh block, as the sh version's awk cut it out.
export function watchLoop(): string {
  const lines = readFileSync(`${ROOT}/commands/fleet-wait.md`, 'utf8').split('\n');
  const fence = /^```(sh|bash)?$/;
  const start = lines.findIndex((l) => fence.test(l));
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && fence.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).map((l) => `${l}\n`).join('');
}
