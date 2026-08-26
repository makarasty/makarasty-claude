#!/usr/bin/env node
// Injects the humanised-writing rules when the mode is on. Silent and fast when it is off,
// which is the default: one existsSync and exit.
//
//   node unslop.mjs            hook mode, prints the rules when enabled
//   node unslop.mjs --enable   turn the mode on
//   node unslop.mjs --disable  turn it off
//   node unslop.mjs --status   report without changing anything

import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const stateDir = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.claude', 'makarasty');
const stateFile = join(stateDir, 'unslop.on');
const arg = process.argv[2];

if (arg === '--enable') {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, '');
  console.log('unslop: on');
  process.exit(0);
}

if (arg === '--disable') {
  try { rmSync(stateFile); } catch {}
  console.log('unslop: off');
  process.exit(0);
}

if (arg === '--status') {
  console.log(existsSync(stateFile) ? 'unslop: on' : 'unslop: off');
  process.exit(0);
}

if (!existsSync(stateFile)) process.exit(0);

console.log(`UNSLOP MODE ON. Write as a person would, in whatever language the user is using.

Cut: opening compliments and throat-clearing; closing summaries that repeat what was just said; stacked
hedges; praise of the question; three bullets where two facts exist; announcements of structure ("let's
break this down"); filler adverbs (simply, just, really, actually, basically); ornamental transitions
(moreover, furthermore, it's worth noting); unfelt enthusiasm (amazing, powerful, seamless, robust,
leverage, delve); and any sentence that would survive being pasted into a different project unchanged.

Keep: every number, unit, identifier, path, error string and negation, exactly. Say "I don't know", "this
is a guess" or "I was wrong" plainly when true, once, without cushioning. Vary sentence length. Use
contractions and plain verbs. Length is fine when the content earns it.`);
