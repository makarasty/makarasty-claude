#!/usr/bin/env node
// The humanised-writing mode's switch. The rules live in unslop.txt, the one copy both this script and
// the SessionStart hook in plugin.json read; the hook is a shell test plus `cat`, so no node starts.
//
//   node unslop.mjs --enable   turn the mode on and print the rules, so this session gets them now
//   node unslop.mjs --disable  turn it off
//   node unslop.mjs --status   report without changing anything
//   node unslop.mjs            print the rules when the mode is on
//
// The state file is ${CLAUDE_CONFIG_DIR:-~/.claude}/makarasty/unslop.on, the same path the hook tests.

import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const stateFile = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'makarasty', 'unslop.on');
const rules = () => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'unslop.txt'), 'utf8');
const arg = process.argv[2];

if (arg === '--enable') {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, '');
  console.log(`unslop: on\n\n${rules()}`);
} else if (arg === '--disable') {
  rmSync(stateFile, { force: true });
  console.log('unslop: off');
} else if (arg === '--status') {
  console.log(existsSync(stateFile) ? 'unslop: on' : 'unslop: off');
} else if (existsSync(stateFile)) {
  process.stdout.write(rules());
}
