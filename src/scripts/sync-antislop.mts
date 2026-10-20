#!/usr/bin/env node
// sync-antislop.mts - keeps tools/hooks/antislop/ a pinned, reviewable slice of the rule text.
// pinned upstream: see UPSTREAM.json and LICENSE-antislop. Dev-only: nothing here ships to a plugin user.
//
//   node scripts/sync-antislop.mjs --check                 latest release tag vs UPSTREAM.json; offline-safe, exit 0
//   node scripts/sync-antislop.mjs --apply <tag> [--rules <n>]
//                                                          shallow clone that tag, verify its commit, slice, write
//
// --apply is all or nothing: a heading that moved, a forbidden leftover, or an R-ID set that changed (unless
// --rules <n> accepts the new count) stops with exit 1 and writes nothing. The upstream clone is read as data,
// never executed. The slice is by heading text, not by line number, so upstream line shifts do not matter.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const self = resolve(import.meta.dirname);
const ROOT = basename(dirname(self)) === 'src' ? resolve(self, '..', '..') : resolve(self, '..');
const OUT = join(ROOT, 'tools', 'hooks', 'antislop');
const REPO = 'https://github.com/miqdadbadjuber/anti-slop';
const API = 'https://api.github.com/repos/miqdadbadjuber/anti-slop';
const TAG_RE = /^v\d+\.\d+\.\d+$/;
const DEFAULT_RULES = 38;

interface FileInfo { sha256: string; bytes: number; from: string }
interface Upstream { source: string; tag: string; commit: string; fetched: string; rules: { count: number; ids: string }; files: Record<string, FileInfo> }

const lf = (s: string): string => s.split('\r\n').join('\n');
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const readUp = (): Upstream | undefined => {
  try { return JSON.parse(readFileSync(join(OUT, 'UPSTREAM.json'), 'utf8')) as Upstream; } catch { return undefined; }
};
class Fail extends Error {}
const fail = (msg: string): never => { throw new Fail(msg); };

async function api(path: string): Promise<any> {
  const r = await fetch(`${API}/${path}`, {
    headers: { 'User-Agent': 'makarasty-sync-antislop', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`GitHub answered ${r.status} for ${path}`);
  return r.json();
}

async function check(): Promise<void> {
  const have = readUp()?.tag ?? 'none';
  try {
    const latest = String((await api('releases/latest')).tag_name);
    console.log(latest === have ? `antislop: up to date ${have}` : `antislop: ${latest} available (you have ${have})`);
  } catch (e) {
    console.log(`antislop: could not reach GitHub (${(e as Error).message}); you have ${have}`);
  }
}

// ---- slicing by heading -------------------------------------------------------------------------------------

// Index of the first line at or after `from` that starts with `prefix`, ignoring lines inside ``` fences.
function find(lines: string[], prefix: string, from = 0): number {
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('```')) fence = !fence;
    if (i >= from && !fence && lines[i]!.startsWith(prefix)) return i;
  }
  return fail(`heading missing: "${prefix}"`);
}
// Lines from `start` up to (not including) `end`, or to the file end; a trailing --- rule and blank lines go.
function slice(text: string, start: string, end?: string): string {
  const lines = lf(text).split('\n');
  const a = find(lines, start);
  const b = end === undefined ? lines.length : find(lines, end, a + 1);
  const out = lines.slice(a, b);
  while (out.length && (out[out.length - 1]!.trim() === '' || out[out.length - 1]!.trim() === '---')) out.pop();
  return out.join('\n');
}
function replaceAll(text: string, from: string, to: string, where: string): string {
  if (!text.includes(from)) fail(`${where}: expected text not found: ${from.slice(0, 70)}`);
  return text.split(from).join(to);
}
// Drops the YAML frontmatter and everything before the `# ` title line.
const body = (text: string): string => slice(text, '# ');

// ---- the transform ------------------------------------------------------------------------------------------

const TIER: Record<string, string> = { '1': 'hard', '2': 'purpose', '3': 'quality' };

function ruleIndex(rules: string): { text: string; ids: string[] } {
  const rows: { id: string; line: string }[] = [];
  let tier = '';
  const lines = rules.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const g = /^### Group (\d)/.exec(lines[i]!);
    if (g) tier = TIER[g[1]!] ?? fail(`unknown rule group ${g[1]}`);
    const m = /^#### (R-\d\d) — (.+)$/.exec(lines[i]!);
    if (!m) continue;
    if (!tier) fail(`${m[1]} appears before any group heading`);
    const first = lines.slice(i + 1).find((l) => l.startsWith('- ')) ?? '';
    const gist = first.slice(2).split('**').join('').split('|').join('/').replace(/\s+/g, ' ').trim();
    rows.push({ id: m[1]!, line: `${m[1]} | ${tier} | ${m[2]} | ${gist.length > 90 ? `${gist.slice(0, 87)}...` : gist}` });
  }
  rows.sort((x, y) => x.id.localeCompare(y.id));
  const ids = rows.map((r) => r.id);
  if (new Set(ids).size !== ids.length) fail('a rule id appears twice in Part 2');
  const head = 'One line per rule: id | tier | title | first requirement. Tiers: hard = absolute, purpose = technique allowed with a written reason, quality = consistency lock. The full text of a rule is in rules.md.';
  return { text: `${head}\n\n${rows.map((r) => r.line).join('\n')}`, ids };
}

interface Piece { text: string; from: string }

function build(src: string): { pieces: Record<string, Piece>; ids: string[] } {
  const r = (p: string): string => lf(readFileSync(join(src, p), 'utf8'));
  const CORE = 'skills/antislop/SKILL.md';
  const core = r(CORE);

  const rules = replaceAll(slice(core, '## Part 2:', '## Part 3:'),
    '(`skills/antislop-copywriting/SKILL.md`)', '(not vendored here)', 'rules.md');
  const gate = `${slice(core, '## Core Principle', '## Part 1:')}\n\n---\n\n${slice(core, '## Part 3:')}`;
  const hard = `${slice(core, '### Design Read', '## Functional Patterns')}\n\n---\n\n${slice(core, '### Block 1:', '### Block 2:')}`;

  const pointTo = (t: string, where: string): string => replaceAll(t, '`antislop.md`', '`rules.md` and `gate.md`', where);
  const ui = pointTo(body(r('skills/antislop-ui/SKILL.md')), 'ui.md');
  const mobile = pointTo(body(r('skills/antislop-layoutmobile/SKILL.md')), 'layoutmobile.md');

  // No python in the plugin: the contrast checker script and its section go, the formula and table stay.
  let human = pointTo(body(r('skills/antislop-human/SKILL.md')), 'human.md');
  const cutFrom = human.indexOf('**The script.**');
  const cutTo = human.indexOf('**The formula (WCAG 2.x).**');
  if (cutFrom < 0 || cutTo < cutFrom) fail('human.md: contrast checker script section not found');
  human = human.slice(0, cutFrom) + human.slice(cutTo);
  human = replaceAll(human, 'Three layers, from most to least convenient:', 'No script ships in this copy, so the formula and the table are the checker:', 'human.md');
  human = replaceAll(human, '(formula + reference table + script)', '(formula + reference table)', 'human.md');
  const left = /python|contrast-check|contrast-mcp|\.py\b/i.exec(human);
  if (left) fail(`human.md: leftover "${left[0]}" after the cut; the transform needs a look`);

  const { text: index, ids } = ruleIndex(rules);
  return {
    ids,
    pieces: {
      'gate-hard.md': { text: hard, from: `${CORE} (Design Read, Delivery Gate Block 1)` },
      'rules.md': { text: rules, from: `${CORE} (Part 2)` },
      'gate.md': { text: gate, from: `${CORE} (Core Principle to Craftsmanship Standard, Part 3 to the end)` },
      'ui.md': { text: ui, from: 'skills/antislop-ui/SKILL.md' },
      'layoutmobile.md': { text: mobile, from: 'skills/antislop-layoutmobile/SKILL.md' },
      'human.md': { text: human, from: 'skills/antislop-human/SKILL.md' },
      'rule-index.md': { text: index, from: `${CORE} (Part 2 headings)` },
    },
  };
}

// ---- apply --------------------------------------------------------------------------------------------------

const git = (args: string[], cwd?: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// +added/-removed lines of new vs old, by git's own diff; the old file may not exist yet.
function lineDiff(oldPath: string, newPath: string): string {
  if (!existsSync(oldPath)) return `new, +${readFileSync(newPath, 'utf8').split('\n').length}`;
  const r = spawnSync('git', ['diff', '--no-index', '--numstat', oldPath, newPath], { encoding: 'utf8' });
  const m = /^(\d+)\s+(\d+)/.exec(r.stdout);
  return !m || (m[1] === '0' && m[2] === '0') ? 'same' : `+${m[1]}/-${m[2]}`;
}

async function apply(tag: string, rulesArg: string | undefined): Promise<void> {
  if (!TAG_RE.test(tag)) fail(`"${tag}" is not a release tag like v3.2.21`);
  const old = readUp();
  const expected = rulesArg !== undefined ? Number(rulesArg) : old?.rules.count ?? DEFAULT_RULES;
  if (!Number.isInteger(expected) || expected < 1) fail(`--rules wants a count, got "${rulesArg}"`);

  // What GitHub says the tag points at; an annotated tag is followed to its commit.
  let want: string;
  try {
    let o = (await api(`git/ref/tags/${tag}`)).object as { sha: string; type: string };
    if (o.type === 'tag') o = (await api(`git/tags/${o.sha}`)).object as { sha: string; type: string };
    want = o.sha;
  } catch (e) { return fail(`could not verify ${tag} with GitHub: ${(e as Error).message}`); }

  const tmp = mkdtempSync(join(tmpdir(), 'sync-antislop-'));
  try {
    const src = join(tmp, 'repo');
    try { git(['clone', '--quiet', '--depth', '1', '--branch', tag, '-c', 'core.autocrlf=false', REPO, src]); }
    catch (e) { return fail(`clone of ${tag} failed: ${(e as Error).message.split('\n')[0]}`); }
    const got = git(['rev-parse', 'HEAD'], src);
    if (got !== want) fail(`${tag} is ${got} in the clone but GitHub says ${want}; refusing`);

    const { pieces, ids } = build(src);
    const idStr = ids.join(',');
    const idsOld = old?.rules.ids.split(',') ?? [];
    const added = ids.filter((x) => !idsOld.includes(x));
    const removed = idsOld.filter((x) => !ids.includes(x));
    if (ids.length !== expected) fail(`found ${ids.length} rule ids, expected ${expected} (pass --rules ${ids.length} to accept)`);
    if (old && (added.length || removed.length) && rulesArg === undefined) {
      fail(`the rule id set changed (added ${added.join(' ') || 'none'}, removed ${removed.join(' ') || 'none'}); pass --rules ${ids.length} to accept`);
    }

    const header = '<!-- generated by scripts/sync-antislop.mjs - edit the sync, not this file -->\n\n';
    const files: Record<string, string> = {};
    const info: Record<string, FileInfo> = {};
    for (const [name, p] of Object.entries(pieces)) { files[name] = `${header}${p.text}\n`; }
    files['LICENSE-antislop'] = lf(readFileSync(join(src, 'LICENSE'), 'utf8'));
    if (!/Permission is hereby granted/.test(files['LICENSE-antislop']) || !/Copyright/.test(files['LICENSE-antislop'])) fail('LICENSE is not the MIT text the copy needs');
    const from: Record<string, string> = { 'LICENSE-antislop': 'LICENSE' };
    for (const [name, p] of Object.entries(pieces)) from[name] = p.from;
    for (const [name, text] of Object.entries(files)) info[name] = { sha256: sha(text), bytes: Buffer.byteLength(text), from: from[name]! };

    // Every check passed: stage, diff against the vendored copy, then write.
    const stage = join(tmp, 'new');
    mkdirSync(stage);
    const summary: string[] = [];
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(stage, name), text);
      summary.push(`  ${name.padEnd(18)} ${String(info[name]!.bytes).padStart(6)} B  ${lineDiff(join(OUT, name), join(stage, name))}`);
    }
    const next: Upstream = { source: REPO, tag, commit: got, fetched: new Date().toISOString().slice(0, 10), rules: { count: ids.length, ids: idStr }, files: info };
    mkdirSync(OUT, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(OUT, name), text);
    writeFileSync(join(OUT, 'UPSTREAM.json'), `${JSON.stringify(next, null, 2)}\n`);

    console.log(`antislop: ${old ? `${old.tag} -> ` : ''}${tag} (${got.slice(0, 7)}), ${ids.length} rules`);
    console.log(summary.join('\n'));
    console.log(`  rule ids: added ${added.length ? added.join(' ') : 'none'}, removed ${removed.length ? removed.join(' ') : 'none'}`);
    console.log('antislop: read the diff, run tools/hooks/antislop-selftest.mjs, bump the plugin version');
  } finally { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); }
}

const [cmd, a, b, c] = process.argv.slice(2);
try {
  if (cmd === '--check') await check();
  else if (cmd === '--apply' && a) await apply(a, b === '--rules' ? c : undefined);
  else throw new Fail('usage: node scripts/sync-antislop.mjs --check | --apply <tag> [--rules <count>]');
} catch (e) {
  if (!(e instanceof Fail)) throw e;
  console.error(`antislop: ${e.message}
antislop: nothing written`);
  process.exitCode = 1;
}
