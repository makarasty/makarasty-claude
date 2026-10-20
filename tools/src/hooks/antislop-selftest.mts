#!/usr/bin/env node
// antislop-selftest.mjs - the antislop switch, its pointer and the vendored rule files, against a
// temporary config dir. No network, about a second.
//
//   node tools/hooks/antislop-selftest.mjs         the compiled test
//   node tools/src/hooks/antislop-selftest.mts     the same, the TypeScript run directly by node
//
// Both test the shipped tools/hooks/, never tools/src/: the .mjs is what a plugin user runs.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const fwd = (p: string): string => p.split('\\').join('/');
const self = resolve(import.meta.dirname);
const tools = fwd(basename(dirname(self)) === 'src' ? resolve(self, '..', '..') : resolve(self, '..'));
const hooks = `${tools}/hooks`;
const vendored = `${hooks}/antislop`;
const cfg = fwd(mkdtempSync(join(tmpdir(), 'antislop-selftest-')));
const flag = `${cfg}/makarasty/antislop.on`;
const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, CLAUDE_PLUGIN_ROOT: tools };

const read = (p: string): string => readFileSync(p, 'utf8').split('\r\n').join('\n');
const sha = (p: string): string => createHash('sha256').update(read(p)).digest('hex');
const run = (file: string, args: string[]) => {
  const r = spawnSync(file, args, { env, encoding: 'utf8' });
  return { out: (r.stdout ?? '').replace(/\n+$/, ''), err: r.stderr ?? '', code: r.status ?? 128 };
};
const node = (arg?: string) => run(process.execPath, [`${hooks}/antislop.mjs`, ...(arg ? [arg] : [])]);

interface Upstream { tag: string; commit: string; rules: { count: number; ids: string }; files: Record<string, { sha256: string }> }
const upstream = JSON.parse(read(`${vendored}/UPSTREAM.json`)) as Upstream;
const pointer = read(`${hooks}/antislop.txt`);
const BANNER = /^antislop: ON - rules v\d+\.\d+\.\d+ - UI work runs the hard gate - off: \/makarasty-tools:antislop off$/;

test('enable, status, disable print the state lines and move the flag', () => {
  rmSync(flag, { force: true });
  assert.match(node('--status').out, /^antislop: off - rules v\d+\.\d+\.\d+ \([0-9a-f]{7}\) - files ok$/);
  assert.equal(node().out, '', 'off: the bare call prints nothing');

  const on = node('--enable');
  assert.equal(on.code, 0);
  const lines = on.out.split('\n');
  assert.match(lines[0]!, BANNER);
  assert.equal(lines[0]!.includes(upstream.tag), true, 'the banner names the pinned tag');
  assert.ok(lines.includes(`antislop root: ${dirname(hooks).split('\\').join('/')}`), 'the root line is printed');
  assert.ok(on.out.endsWith(pointer.replace(/\n+$/, '')), 'the pointer follows the root line');
  assert.ok(existsSync(flag));
  assert.match(node('--status').out, /^antislop: on - rules v\d+\.\d+\.\d+ \([0-9a-f]{7}\) - files ok$/);
  assert.ok(node().out.startsWith('antislop root: '), 'on: the bare call prints the root line and the pointer');

  assert.equal(node('--disable').out, 'antislop: off');
  assert.ok(!existsSync(flag));
  assert.equal(node('--bogus').code, 1);
});

test('the SessionStart hook in plugin.json prints the pointer only while the flag exists', () => {
  const plugin = JSON.parse(read(`${tools}/.claude-plugin/plugin.json`));
  const entries = (plugin.hooks.SessionStart as { matcher: string; hooks: { command: string }[] }[])
    .filter((e) => e.hooks.some((h) => h.command.includes('antislop.on')));
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.matcher, 'startup|resume|clear|compact');
  const cmd = entries[0]!.hooks[0]!.command;
  assert.ok(!cmd.includes('node'), 'no node starts on session start');

  rmSync(flag, { force: true });
  assert.equal(run('sh', ['-c', cmd]).out, '');
  mkdirSync(dirname(flag), { recursive: true });
  node('--enable');
  const out = run('sh', ['-c', cmd]).out;
  assert.equal(out, `antislop root: ${tools}\n${pointer.replace(/\n+$/, '')}`);
  node('--disable');
});

test('the pointer is short and every file it names exists', () => {
  assert.ok(pointer.replace(/\n+$/, '').split('\n').length <= 8, 'at most 8 lines');
  assert.ok(Buffer.byteLength(pointer) <= 1200, 'at most 1,200 bytes');
  assert.ok(!pointer.includes('\u2014'), 'no em dash in our own text');
  const names = [...pointer.matchAll(/\b([a-z][a-z-]*\.md)\b/g)].map((m) => m[1]!);
  assert.ok(names.includes('gate-hard.md'));
  for (const n of names) assert.ok(existsSync(`${vendored}/${n}`), `${n} is named by the pointer but not vendored`);
  const ids = [...pointer.matchAll(/\bR-\d\d\b/g)].map((m) => m[0]);
  const index = read(`${vendored}/rule-index.md`);
  for (const id of ids) assert.ok(index.includes(`\n${id} |`), `${id} is named by the pointer but not in rule-index.md`);
});

test('UPSTREAM.json hashes match the vendored files, and nothing else sits in the folder', () => {
  const listed = Object.keys(upstream.files).sort();
  assert.deepEqual(readdirSync(vendored).filter((f) => f !== 'UPSTREAM.json').sort(), listed);
  for (const [name, f] of Object.entries(upstream.files)) {
    assert.equal(sha(`${vendored}/${name}`), f.sha256, `${name} was edited after the sync`);
    if (name.endsWith('.md')) {
      const first = read(`${vendored}/${name}`).split('\n')[0]!;
      assert.ok(first.includes('scripts/sync-antislop.mjs'), `${name}: header line`);
    }
  }
  assert.match(read(`${vendored}/LICENSE-antislop`), /Copyright \(c\) 20\d\d \S/);
  assert.match(upstream.commit, /^[0-9a-f]{40}$/);
});

test('rule-index.md lists exactly the R-IDs that rules.md defines', () => {
  const defined = [...read(`${vendored}/rules.md`).matchAll(/^#### (R-\d\d) /gm)].map((m) => m[1]!).sort();
  const indexed = [...read(`${vendored}/rule-index.md`).matchAll(/^(R-\d\d) \| (hard|purpose|quality) \| /gm)].map((m) => m[1]!);
  assert.equal(defined.length, upstream.rules.count);
  assert.deepEqual(indexed, defined);
  assert.equal(defined.join(','), upstream.rules.ids);
  const known = new Set(defined);
  for (const f of ['gate-hard.md', 'gate.md', 'ui.md', 'layoutmobile.md', 'human.md']) {
    for (const m of read(`${vendored}/${f}`).matchAll(/\bR-\d\d\b/g)) assert.ok(known.has(m[0]), `${f} cites ${m[0]}, which rules.md does not define`);
  }
});

test('the skill points at files that exist', () => {
  const skill = read(`${tools}/skills/antislop/SKILL.md`);
  for (const m of skill.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(hooks\/[\w./-]+)/g)) {
    const p = m[1]!.replace(/[.,]+$/, '');
    assert.ok(existsSync(`${tools}/${p}`), `SKILL.md names ${p}`);
  }
  assert.match(skill, /^description: .{40,400}$/m);
});

after(() => rmSync(cfg, { recursive: true, force: true }));
