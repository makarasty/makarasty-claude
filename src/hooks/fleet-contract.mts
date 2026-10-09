#!/usr/bin/env node
// fleet-contract.mjs - the second thing only the harness can see: a worker about to change a name
// something outside this repository depends on.
//
// Measured on one project's runs: three changes shipped to `main` that were correct inside the repository
// and broke somebody outside it. Two endpoints moved behind session authentication, so every unauthenticated
// caller - including monitoring nobody in the run could see - started getting 401 instead of data. A history
// clear moved onto an event that also fires on a console `load`, so a restart followed by loading an
// autosave began truncating history that had survived it before. A detector was deleted rather than
// repaired, and the config comment rewritten with it forced six servers to rewrite their configuration file
// on next boot, dropping the operator's own comments. All three were reasoned about carefully. None was
// asked about, because asking was a matter of taste - and the same runs asked 86 questions and got 85
// answers, so the operator was there and answering the whole time.
//
// Taste is not the missing piece. A refusal is. This blocks the edit and gives the worker two ways past it,
// both of which take one command: file the question, or record the decision. What it will not allow is the
// third thing, which is the change going in with nobody outside the worker's own context knowing.
//
// Deliberately timid, on the same principle as fleet-guard.mjs:
//   - not an edit, no fleet, no chip registered, or no contract surface generated -> exit 0
//   - the worker already asked about this name, or already recorded a decision on it -> exit 0
//   - it blocks a given name once per session, ever, and records that it did
// Exit 2 with a sentence on stderr is Claude Code's "do not run this tool, here is why".

import fs from 'node:fs';
import path from 'node:path';
import { findRuns, chipOf, rel, pauseGate } from './run-dir.mjs';
import type { HookPayload } from './run-dir.mjs';

interface EditInput { file_path?: string; content?: string; old_string?: string; new_string?: string; replace_all?: boolean; edits?: EditInput[] }
interface Surface { kind: string; token: string }

const bail: () => never = () => process.exit(0);

let payload: HookPayload = {};
try {
  const raw = fs.readFileSync(0, 'utf8');
  payload = raw ? JSON.parse(raw) : {};
} catch { bail(); }

const tool = payload.tool_name || '';
if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) bail();

const session = payload.session_id || process.env.CLAUDE_CODE_SESSION_ID || '';
if (!session) bail();

// A pause first: it is one readdir when nothing is paused, and an edit is exactly what a paused worker must
// not make once its grace is over.
const held = pauseGate(payload);
if (held) { process.stderr.write(held + '\n'); process.exit(2); }

// A notebook edit is held by a pause like any other edit; it names a notebook, not a file on the contract
// surface, so past the pause there is nothing for the rest of this hook to compare.
if (tool === 'NotebookEdit') bail();

const input: EditInput = payload.tool_input || {};
const target = input.file_path || '';

const { fleetDir, runs } = findRuns(payload.cwd || process.cwd());
if (!fleetDir) bail();
const { run, chip } = chipOf(runs, session);
if (!run || !chip) bail();

// The surface is generated per project and edited by hand. Absent means this project has not opted in, and
// a hook that invents a contract surface would block on names nobody promised anything about.
let surface: Surface[] = [];
try {
  surface = fs.readFileSync(path.join(fleetDir, 'contract-surface.txt'), 'utf8')
    .split(/\r?\n/) // the file is committed, and a checkout with autocrlf hands it back with CRLF
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => { const [kind, token] = l.split('\t'); return { kind, token }; })
    .filter((s) => s.token);
} catch { bail(); }
if (!surface.length) bail();

// A name is at risk when the edit removes it from the text it was in. Present on both sides is a line being
// worked around it; present on neither is an edit that never touched it.
//
// Whole files are compared, not the edit's two fragments: a narrow `old_string` - `/status'` becoming
// `/statistics'` - never holds the whole token, so its fragments say nothing was removed. The fragments are
// only the fallback, for a file this cannot read or one that does not hold the text the edit names.
let existing: string | null = null;
try { existing = fs.readFileSync(path.resolve(payload.cwd || process.cwd(), target), 'utf8'); } catch { /* new, or unreadable */ }

// One replacement the way the Edit tool makes it; null when the text does not hold `old_string`.
const apply = (text: string | null, { old_string: o = '', new_string: n = '', replace_all: all }: EditInput = {}): string | null => {
  if (text === null || !o || !text.includes(o)) return null;
  return all ? text.split(o).join(n) : text.replace(o, () => n);
};

const sides: [string | null, string][] = [];
if (tool === 'Write') {
  if (existing === null) bail(); // a new file promises nothing yet
  sides.push([existing, input.content || '']);
} else {
  const edits = tool === 'Edit' ? [input] : input.edits || [];
  const after = edits.reduce(apply, existing);
  if (after !== null) sides.push([existing, after]);
  else for (const e of edits) sides.push([e.old_string || '', e.new_string || '']);
}

// Every kind needs its end guarded, not only identifiers. A plain substring count says `/api/server/status`
// survived an edit that replaced it with `/api/server/statistics`, which is the rename most likely to be
// made and the one this exists to catch.
const escape = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const occurrences = (hay: string | null, { kind, token }: Surface): number => {
  if (!hay) return 0;
  const re = kind === 'export' || kind === 'event'
    ? new RegExp(`\\b${escape(token)}\\b`, 'g')
    : new RegExp(`${escape(token)}(?![\\w./:-])`, 'g');
  let n = 0;
  while (re.exec(hay)) n++;
  return n;
};

const atRisk: Surface[] = [];
for (const s of surface) {
  for (const [before, after] of sides) {
    const was = occurrences(before, s);
    if (was && occurrences(after, s) < was) { atRisk.push(s); break; }
  }
}
if (!atRisk.length) bail();

// Already accounted for. Both channels count: a question filed for a person to answer, and a decision the
// worker recorded and carried on from. Either way the name is visible outside this session.
const accountedFor = (token: string): boolean => {
  const hunt = (p: string): boolean => { try { return fs.readFileSync(p, 'utf8').includes(token); } catch { return false; } };
  try { for (const f of fs.readdirSync(path.join(run, 'ask'))) if (hunt(path.join(run, 'ask', f))) return true; } catch { /* none filed */ }
  if (hunt(path.join(run, 'decisions.jsonl'))) return true;
  return false;
};
const unaccounted = atRisk.filter((s) => !accountedFor(s.token));
if (!unaccounted.length) bail();

// Once per name per session. A hook that cannot remember what it has already said repeats itself every turn,
// and a worker that cannot get past it stops trusting it and starts working around it.
const first = unaccounted.find((s) => {
  const mark = path.join(run, 'chips', `${session}.contract-${Buffer.from(s.token).toString('hex').slice(0, 40)}`);
  if (fs.existsSync(mark)) return false;
  try { fs.writeFileSync(mark, new Date().toISOString()); } catch { return false; }
  return true;
});
if (!first) bail();

const runPath = rel(run);
process.stderr.write(
  `This edit removes \`${first.token}\` from ${path.basename(target) || 'the file'}, and that name is on this project's ` +
  `contract surface as a ${first.kind}: something outside this repository may be reading it. ` +
  `Nothing here says you are wrong - it says nobody outside your context knows yet.\n\n` +
  `Take one of the two, then make the edit again:\n\n` +
  `  Ask, if a person's answer would change what you do:\n` +
  `    write ${runPath}/ask/${chip}-<n>.md naming ${first.token}, what breaks, and your recommendation, then take another task\n\n` +
  `  Decide, if it would not:\n` +
  `    echo '{"token":"${first.token}","why":"<why this is safe, and what would have to be true for it not to be>"}' |\n` +
  `      node <plugin>/scripts/fleet-gate.mjs decide ${runPath} ${chip}\n\n` +
  `Both are one line and both put the change in front of the operator before the run lands. ` +
  `Either one lets this edit through; this name will not be raised again in this session.\n`
);
process.exit(2);
