#!/usr/bin/env node
// release.mjs - install the repo's plugin versions now, and check that the install matches the repo.
//
//   node release.mjs           release every plugin whose repo version differs from the installed one
//   node release.mjs --selftest
//
// Delivery never waits (the owner, 2026-11-18: «доставка должна быть независима от обновления»): a task bumps its
// version, writes the CHANGELOG entry and releases at once, as often as a day needs. Running chats keep their copy
// and move to the new one when /reload-plugins is typed in them by hand, or on restart.
// A plugin installed from this folder's marketplace loads in place from the repo (`claude plugin list --json` shows
// readFromFolder), so `plugin update` would only add an unused cache copy: 94 piled up by 2026-11-18. Those are skipped.
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

// The plugins whose installed version is not the repo's; one read in place from the repo is never waiting.
export const waiting = s => s.filter(p => !p.inPlace && p.repo !== p.installed);
const same = (a, b) => !!a && !!b && resolve(a).toLowerCase() === resolve(b).toLowerCase();

function inPlace() {
    try {
        const j = JSON.parse(claude(['plugin', 'list', '--json'])), rows = Array.isArray(j) ? j : j.plugins ?? [];
        return Object.fromEntries(Object.entries(PLUGINS).map(([name, file]) => {
            const row = rows.find(r => (r.id ?? r.name) === `${name}@${MARKET}`);
            return [name, same(row?.readFromFolder, join(REPO, dirname(dirname(file))))];
        }));
    } catch { return {}; }
}

function state() {
    const j = JSON.parse(readFileSync(join(HOME, 'plugins', 'installed_plugins.json'), 'utf8')), rows = j.plugins ?? j;
    const live = inPlace();
    return Object.entries(PLUGINS).map(([name, file]) => ({
        name,
        repo: JSON.parse(readFileSync(join(REPO, file), 'utf8')).version,
        installed: (rows[`${name}@${MARKET}`] ?? []).find(x => x.scope === 'user')?.version,
        inPlace: !!live[name],
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
    const s = state(), w = waiting(s);
    if (!w.length) return console.log(`nothing to release: ${s.map(p => `${p.name} ${p.repo}${p.inPlace ? ' (loads from the repo folder: live in new chats and after /reload-plugins)' : ''}`).join(', ')}`);
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
    assert.deepEqual(waiting([{ name: 'a', repo: '1.3', installed: '1.2', inPlace: true }]), [], 'a plugin read in place needs no copy');
    console.log('release.mjs selftest done');
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) main(process.argv.slice(2));
