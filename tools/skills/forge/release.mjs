#!/usr/bin/env node
// release.mjs - the batch release: the installed plugins move to the repo's versions at most twice a day.
//
//   node release.mjs           release if this half-day (00-12, 12-24 local) has had none, else say it is queued
//   node release.mjs --urgent "<reason>"   release now, no question: a guard or hook wrongly blocks work, a crash, a
//                                          broken hook (the owner, 2026-11-18). Anything else waits for the batch.
//   node release.mjs --now     release now (the owner asked for it)
//   node release.mjs --selftest
//
// A task still commits, bumps its plugin's version and writes the CHANGELOG entry; only the install waits. The time
// of the last release is the install record Claude Code already keeps (installed_plugins.json lastUpdated), so there
// is no state file and no model call. Running chats keep their copy: `/reload-plugins` typed by hand in a chat moves it.
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

// The half-day a moment falls in, local time: "2026-11-18 pm".
export const slot = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.getHours() < 12 ? 'am' : 'pm'}`;
export const nextSlot = d => { const n = new Date(d); if (n.getHours() < 12) n.setHours(12, 0, 0, 0); else { n.setDate(n.getDate() + 1); n.setHours(0, 0, 0, 0); } return n; };

// What to do: 'none' (installed = repo), 'release', or 'queued' (a release already ran in this half-day).
export function decide(waiting, lastRelease, now, forced) {
    if (!waiting.length) return 'none';
    if (forced || !lastRelease || slot(lastRelease) !== slot(now)) return 'release';
    return 'queued';
}

// The reason an urgent release states; a missing one, or a flag taken for it, is no reason.
export const urgentReason = r => typeof r === 'string' && r.trim().length >= 10 && !r.startsWith('--') ? r.trim() : undefined;

function state() {
    const j = JSON.parse(readFileSync(join(HOME, 'plugins', 'installed_plugins.json'), 'utf8')), rows = j.plugins ?? j;
    const out = [];
    for (const [name, file] of Object.entries(PLUGINS)) {
        const r = (rows[`${name}@${MARKET}`] ?? []).find(x => x.scope === 'user');
        const repo = JSON.parse(readFileSync(join(REPO, file), 'utf8')).version;
        out.push({ name, repo, installed: r?.version, at: r?.lastUpdated ? new Date(r.lastUpdated) : undefined });
    }
    return out;
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
    const s = state(), now = new Date(), waiting = s.filter(p => p.repo !== p.installed);
    const last = s.map(p => p.at).filter(Boolean).sort((a, b) => b - a)[0];
    const u = argv.indexOf('--urgent'), reason = u < 0 ? undefined : urgentReason(argv[u + 1]);
    if (u >= 0 && !reason) { console.error('--urgent needs the reason in quotes: what is blocked or broken (a guard or hook wrongly blocking work, a crash, a broken hook)'); process.exitCode = 2; return; }
    if (reason) console.log(`urgent release: ${reason}`);
    const what = decide(waiting, last, now, argv.includes('--now') || !!reason);
    const list = waiting.map(p => `${p.name} ${p.installed ?? '-'} -> ${p.repo}`).join(', ');
    if (what === 'none') return console.log(`nothing to release: installed = repo (${s.map(p => `${p.name} ${p.repo}`).join(', ')})`);
    if (what === 'queued') return console.log(`queued: ${list}. This half-day already had a release (${last.toLocaleString()}); the next one runs from ${nextSlot(now).toLocaleString()}, or now with --now if the owner asks.`);
    claude(['plugin', 'marketplace', 'update', MARKET]);
    for (const p of waiting) claude(['plugin', 'update', `${p.name}@${MARKET}`]);
    const after = state(), bad = after.filter(p => p.repo !== p.installed);
    if (bad.length) { console.error(`release incomplete: ${bad.map(p => `${p.name} installed ${p.installed}, repo ${p.repo}`).join(', ')}`); process.exitCode = 1; return; }
    console.log(`released: ${list}. Check the change in the installed copy (node rules.mjs); a chat runs the new copy once /reload-plugins is typed in it by hand, or after a restart.`);
}

function selftest() {
    const at = (h, day = 18) => new Date(2026, 10, day, h, 30);
    assert.equal(slot(at(9)), '2026-11-18 am');
    assert.equal(slot(at(15)), '2026-11-18 pm');
    assert.equal(decide([], at(9), at(15), false), 'none', 'nothing waiting');
    assert.equal(decide([1], undefined, at(15), false), 'release', 'never released');
    assert.equal(decide([1], at(9), at(15), false), 'release', 'last release in the morning, now afternoon');
    assert.equal(decide([1], at(13), at(15), false), 'queued', 'same half-day');
    assert.equal(decide([1], at(13), at(15), true), 'release', '--now or --urgent');
    assert.equal(urgentReason('ask-guard refuses every question with a link'), 'ask-guard refuses every question with a link', 'urgent with its reason');
    assert.equal(urgentReason(undefined), undefined, '--urgent with no reason');
    assert.equal(urgentReason('--now'), undefined, 'a flag is no reason');
    assert.equal(urgentReason('fix'), undefined, 'a word is no reason');
    assert.equal(decide([], at(13), at(15), true), 'none', 'urgent with nothing waiting releases nothing');
    assert.equal(decide([1], at(23, 17), at(1), false), 'release', 'past midnight is a new half-day');
    assert.deepEqual([nextSlot(at(9)).getHours(), nextSlot(at(15)).getDate(), nextSlot(at(15)).getHours()], [12, 19, 0], 'next slot');
    console.log('release.mjs selftest done');
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) main(process.argv.slice(2));
