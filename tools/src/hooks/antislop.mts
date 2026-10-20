#!/usr/bin/env node
// The antislop UI mode's switch. The pointer lives in antislop.txt, the one copy both this script and
// the SessionStart hook in plugin.json read; the hook is a shell test plus `cat`, so no node starts.
// The vendored rule text sits in hooks/antislop/ (see UPSTREAM.json there for the pinned tag).
//
//   node antislop.mjs --enable   turn the mode on; print the banner, the plugin root and the pointer
//   node antislop.mjs --disable  turn it off
//   node antislop.mjs --status   report without changing anything
//   node antislop.mjs            print the root line and the pointer when the mode is on
//
// The state file is ${CLAUDE_CONFIG_DIR:-~/.claude}/makarasty/antislop.on, the same path the hook tests.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const hooks = dirname(fileURLToPath(import.meta.url));
const vendored = join(hooks, 'antislop');
const stateFile = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'makarasty', 'antislop.on');
const pointer = () => readFileSync(join(hooks, 'antislop.txt'), 'utf8');
// What the SessionStart hook prints before the pointer: the pointer names files relative to this root.
const rootLine = () => `antislop root: ${dirname(hooks).split('\\').join('/')}`;
const arg = process.argv[2];

interface Upstream { tag?: string; commit?: string; files?: Record<string, { sha256: string }> }
function upstream(): Upstream {
  try { return JSON.parse(readFileSync(join(vendored, 'UPSTREAM.json'), 'utf8')) as Upstream; } catch { return {}; }
}
// Hashed with LF line ends, the way the sync wrote them, so a CRLF checkout does not read as an edit.
const sha = (p: string): string =>
  createHash('sha256').update(readFileSync(p, 'utf8').split('\r\n').join('\n')).digest('hex');

// The vendored files that are missing or no longer match UPSTREAM.json (a hand edit or a half-applied sync).
function broken(u: Upstream): string[] {
  const bad: string[] = [];
  for (const [name, f] of Object.entries(u.files ?? {})) {
    try { if (sha(join(vendored, name)) !== f.sha256) bad.push(`${name} changed`); } catch { bad.push(`${name} MISSING`); }
  }
  return u.files ? bad : ['UPSTREAM.json MISSING'];
}

const state = (on: boolean): string => {
  const u = upstream();
  const bad = broken(u);
  return `antislop: ${on ? 'on' : 'off'} - rules ${u.tag ?? 'unknown'} (${(u.commit ?? '?').slice(0, 7)}) - files ${bad.length ? bad.join(', ') : 'ok'}`;
};

if (arg === '--enable') {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, '');
  const u = upstream();
  console.log(`antislop: ON - rules ${u.tag ?? 'unknown'} - UI work runs the hard gate - off: /makarasty-tools:antislop off`);
  console.log(`\n${rootLine()}\n${pointer()}`);
} else if (arg === '--disable') {
  rmSync(stateFile, { force: true });
  console.log('antislop: off');
} else if (arg === '--status') {
  console.log(state(existsSync(stateFile)));
} else if (arg !== undefined) {
  console.error('usage: node antislop.mjs [--enable | --disable | --status]');
  process.exit(1);
} else if (existsSync(stateFile)) {
  process.stdout.write(`${rootLine()}\n${pointer()}`);
}
