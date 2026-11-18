#!/usr/bin/env node
// release.mjs - install the repo's plugin versions now, and check that the install matches the repo.
//
//   node release.mjs           release every plugin whose repo version differs from the installed one
//   node release.mjs --selftest
//
// Delivery never waits (the owner, 2026-11-18: «доставка должна быть независима от обновления»): a task bumps its
// version, writes the CHANGELOG entry and releases at once, as often as a day needs. Running chats keep their copy
// and move to the new one when /reload-plugins is typed in them by hand, or on restart.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HOME = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MARKET = 'makarasty';
const PLUGINS = { 'makarasty': '.claude-plugin/plugin.json', 'makarasty-tools': 'tools/.claude-plugin/plugin.json' };

// The plugins whose installed version is not the repo's.
export const waiting = s => s.filter(p => p.repo !== p.installed);

function state() {
    const j = JSON.parse(readFileSync(join(HOME, 'plugins', 'installed_plugins.json'), 'utf8')), rows = j.plugins ?? j;
    return Object.entries(PLUGINS).map(([name, file]) => ({
        name,
        repo: JSON.parse(readFileSync(join(REPO, file), 'utf8')).version,
        installed: (rows[`${name}@${MARKET}`] ?? []).find(x => x.scope === 'user')?.version,
    }));
}

function claude(args) {
    const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 };
    try { return execFileSync('claude', args, opts); } catch (e) {
        if (e.code === 'ENOENT' && process.platform === 'win32') return execFileSync('claude.cmd', args, { ...opts, shell: true });
        throw e;
    }
}

function main(argv) {
    if (argv.includes('--selftest')) return selftest();
    const w = waiting(state());
    if (!w.length) return console.log(`nothing to release: installed = repo (${state().map(p => `${p.name} ${p.repo}`).join(', ')})`);
    const list = w.map(p => `${p.name} ${p.installed ?? '-'} -> ${p.repo}`).join(', ');
    claude(['plugin', 'marketplace', 'update', MARKET]);
    for (const p of w) claude(['plugin', 'update', `${p.name}@${MARKET}`]);
    const bad = waiting(state());
    if (bad.length) { console.error(`release incomplete: ${bad.map(p => `${p.name} installed ${p.installed}, repo ${p.repo}`).join(', ')}`); process.exitCode = 1; return; }
    console.log(`released: ${list}. Check the change in the installed copy (node rules.mjs); a chat runs the new copy once /reload-plugins is typed in it by hand, or after a restart.`);
}

function selftest() {
    assert.deepEqual(waiting([{ name: 'a', repo: '1.2', installed: '1.2' }]), [], 'installed = repo: nothing to do');
    assert.deepEqual(waiting([{ name: 'a', repo: '1.3', installed: '1.2' }]).map(p => p.name), ['a'], 'a newer repo version is released');
    assert.deepEqual(waiting([{ name: 'a', repo: '1.3' }]).map(p => p.name), ['a'], 'a plugin never installed is released');
    console.log('release.mjs selftest done');
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) main(process.argv.slice(2));
