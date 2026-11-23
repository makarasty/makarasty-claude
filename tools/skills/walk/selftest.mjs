#!/usr/bin/env node
// Runs every *.test.mjs next to this file with node --test and exits with its status.
// The cases that drive a browser need WALK_PLAYWRIGHT (a folder with Playwright installed); without it they skip.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
    .filter((f) => f.endsWith('.test.mjs'))
    .sort()
    .map((f) => join(here, f));
console.log(process.env.WALK_PLAYWRIGHT ? `walk selftest: live browser cases run (WALK_PLAYWRIGHT=${process.env.WALK_PLAYWRIGHT})` : 'walk selftest: live browser cases skip (WALK_PLAYWRIGHT not set)');
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
