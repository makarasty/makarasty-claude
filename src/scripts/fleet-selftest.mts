#!/usr/bin/env node
// fleet-selftest.mts - run a whole fleet's protocol against temporary directories, with no sessions, no
// browser and no tokens, and assert every boundary behaves.
//
// A fleet is expensive to test the honest way: fourteen chats, a live application, two hours. So the parts
// that are mechanical - the claim, the lane filter, the schema gate, the clocks, the completion markers,
// the landing check - are tested here instead. When this passes, what remains untested is judgement and
// the browser, which is the correct division: a script cannot check whether a finding was worth filing,
// and it can check that an invalid one was refused.
//
//   node scripts/fleet-selftest.mjs            run every check
//   node scripts/fleet-selftest.mjs --keep     keep each part's temporary directory and print its path
//   node scripts/fleet-selftest.mjs --jobs N   run N parts at once, --jobs=N too (env FLEET_SELFTEST_JOBS; default 3)
//   env FLEET_SELFTEST_TIMEOUT_MS              kill a part that runs longer (default 600000, 10 min): a FAIL, not a retry
//
// Exit 0 = every check passed. Exit 1 = at least one failed, and the failing check names what it expected.
//
// The checks live in selftest/*.test.mjs, one file per part of the protocol, each building its own state
// (selftest/lib.mjs says how). The parts are independent, so they run at once, one process each.

import { readdirSync } from 'node:fs';
import { freemem } from 'node:os';
import { spawnSync } from 'node:child_process';
import { run } from 'node:test';
import type { TestEvent } from 'node:test/reporters';

// Run from scripts/ the compiled parts are .mjs; run by node straight from src/scripts/ they are .mts.
const ext = import.meta.filename.endsWith('.mts') ? '.test.mts' : '.test.mjs';
const dir = `${import.meta.dirname}/selftest`;
const files = readdirSync(dir).filter((f) => f.endsWith(ext)).sort();
if (!files.length) { process.stderr.write(`fleet-selftest: no ${ext} files in ${dir}\n`); process.exit(2); }

// lib.mjs reads this in every test process, which inherits this process's env.
if (process.argv.includes('--keep')) process.env.FLEET_SELFTEST_KEEP = '1';

// The failure detail check() wrote: assert.fail's message, which a child process hands back as the cause.
function detail(e: Error): string {
  const c: unknown = e.cause;
  return (c instanceof Error ? c.message : e.message).split('\n')[0] ?? '';
}

// A kill-after limit per part: a part that hangs is ended and reported as a failure, never retried.
const traw = process.env.FLEET_SELFTEST_TIMEOUT_MS || '600000';
if (!/^[1-9][0-9]*$/.test(traw)) { process.stderr.write(`fleet-selftest: FLEET_SELFTEST_TIMEOUT_MS '${traw}' is not a whole number above 0\n`); process.exit(2); }
const limit = Number(traw);

let pass = 0, fail = 0, hung = false;
// One part's checks, one line each as the sh version printed them. A part runs in a run() of its own
// because an event names the file test() was called in, which for every check is lib.mjs.
function part(file: string): Promise<string[]> {
  const lines: string[] = [];
  return new Promise((done) => {
    const stop = new AbortController();
    let late = false;
    const timer = setTimeout(() => {
      late = hung = true; fail++;
      lines.push(`  FAIL  ${file}: timed out`, `        no end after ${limit} ms (FLEET_SELFTEST_TIMEOUT_MS); the part was killed, not retried`);
      stop.abort();
      done(lines);
    }, limit);
    // The abort kills the part's test process; what it reports after that is not counted.
    const stream = run({ files: [`${dir}/${file}`], signal: stop.signal });
    stream.on('data', (ev: TestEvent) => {
      if (late) return;
      if (ev.type === 'test:pass' && ev.data.details.type !== 'suite') {
        if (ev.data.skip !== undefined && ev.data.skip !== false) lines.push(`  skip  ${ev.data.name}: ${String(ev.data.skip)}`);
        else { pass++; lines.push(`  ok    ${ev.data.name}`); }
      } else if (ev.type === 'test:fail' && ev.data.details.type !== 'suite') {
        fail++;
        lines.push(`  FAIL  ${ev.data.name}`, `        ${detail(ev.data.details.error)}`);
      } else if (ev.type === 'test:stdout' || ev.type === 'test:stderr') {
        lines.push(ev.data.message.replace(/\n$/, ''));
      }
    });
    stream.on('end', () => { clearTimeout(timer); done(lines); });
  });
}

// Three at once by default, never more than there are parts: each part starts its own fleet.sh children, and
// several sessions on one box running every CPU's worth at once pushed it into the pagefile.
const ji = process.argv.indexOf('--jobs');
const jeq = process.argv.find((a) => a.startsWith('--jobs='));
const jraw = jeq !== undefined ? jeq.slice(7) : ji >= 0 ? process.argv[ji + 1] ?? '' : process.env.FLEET_SELFTEST_JOBS || '3';
if (!/^[1-9][0-9]*$/.test(jraw)) { process.stderr.write(`fleet-selftest: --jobs '${jraw}' is not a whole number above 0\n`); process.exit(2); }
const jobs = Math.min(Number(jraw), files.length);

// What the box has before this adds to it: a run already live elsewhere is a reason to wait.
function nodeCount(): string {
  const r = process.platform === 'win32'
    ? spawnSync('tasklist', ['/FI', 'IMAGENAME eq node.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8' })
    : spawnSync('ps', ['-A', '-o', 'comm='], { encoding: 'utf8' });
  if (r.status !== 0 || typeof r.stdout !== 'string') return 'unknown';
  // tasklist: `"node.exe","1234",...`; ps: `node` or `/usr/bin/node`.
  return String(r.stdout.split('\n').filter((l) => /(^|\/)node(\.exe)?$/i.test((l.split(',')[0] ?? '').replace(/"/g, '').trim())).length);
}
console.log(`fleet-selftest: ${(freemem() / 2 ** 30).toFixed(1)} GB free RAM, ${nodeCount()} node process(es) live, ${jobs} part(s) at once`);

// Printed in file order once all are done, so parts running at once do not interleave.
const out: string[][] = files.map(() => []);
let next = 0;
async function lane(): Promise<void> {
  for (let i = next++; i < files.length; i = next++) out[i] = await part(files[i] ?? '');
}
await Promise.all(Array.from({ length: jobs }, lane));
files.forEach((f, i) => {
  const l = out[i] ?? [];
  if (l.length) console.log(`\n${f.replace(/\.test\.m[jt]s$/, '')}\n${l.join('\n')}`);
});
console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
// A killed part can leave a handle open; the report is out, so do not wait on it.
if (hung) setTimeout(() => process.exit(1), 1000).unref();
