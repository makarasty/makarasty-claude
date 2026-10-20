// g2-port-defects-parity.test.mts - the defects the TypeScript port of fleet.mjs turned up, second half (the
// queue under concurrency and odd task files, handback, recover, the pane walks, merge, find, summary),
// procs --kill, and last the proof that every shipped .mjs is what today's sources compile to.
//
// The sh version ran this part in $tmp/queue-edge after everything above it; here it starts from an empty
// queue-edge directory of its own, with CLAUDE_CONFIG_DIR the run's config (the session records of the
// double-click cases are written into it) and the FLEET_LOAD stub kept, so a busy machine never refuses a claim.

import { setup, fleet, fleetAsync, exec, sh, node, has, shPwd, nativePath, check, absent, code, truthy, skip, write, read, exists, ls, fwd, mk, rm, touch, ago, sleep, SCRIPTS, HOOKS, FLEET_SH, ROOT } from './lib.mts';
import type { Out } from './lib.mts';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { copyFileSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const t = setup('g2-port-defects-parity');

// The queue under concurrency and odd task files.
const q = t.tmp('fleet-gate/queue-edge');
const r = `${q}/r`;
const QC = { CLAUDE_CONFIG_DIR: `${q}/cfg` };
function mkq(): void { rm(r); mk(`${r}/tasks/ready`, `${r}/tasks/done`); }
const ready = (id: string, text: string): void => write(`${r}/tasks/ready/${id}.md`, text);
const plain = (id: string, needs = 'repo'): void => ready(id, `---\ntask-id: ${id}\nneeds: ${needs}\n---\n`);
const owner = (dir: string, chip: string): void => write(`${dir}/owner`, `chip ${chip}\nclaimed x\n`);
// `cat outputs | grep -c '^CLAIMED'`.
const claims = (outs: Out[]): number => outs.reduce((n, o) => n + o.out.split('\n').filter((l) => l.startsWith('CLAIMED')).length, 0);
// A pid that belonged to a node process which has already exited: what a killed holder leaves in its lock.
const deadPid = (): string => String(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
// A live node holding a lock: it writes its pid file and sleeps. A Git Bash $$ is not a Windows pid.
function holder(script: string, file: string): ChildProcess {
  const c = spawn(process.execPath, ['-e', `${script}; setTimeout(() => {}, 30000)`, file], { stdio: 'ignore' });
  for (let i = 0; i < 50 && !(exists(file) && statSync(file).size > 0); i++) sleep(0.2);
  return c;
}
function stop(c: ChildProcess): Promise<void> {
  return new Promise((done) => { if (c.exitCode !== null || c.signalCode !== null) done(); else { c.on('exit', () => done()); c.kill(); } });
}
// The sh `{ sh "$fleet" ...; echo $? > rc; } 2>/dev/null | true`: a reader gone before the first line.
function closedPipe(args: string, env = ''): number {
  sh(`{ ${env} sh "${FLEET_SH}" ${args}; echo $? > "${q}/rc"; } 2>/dev/null | true`);
  return parseInt(read(`${q}/rc`), 10);
}

// The verify lane is one worker wide even when six workers ask at the same instant.
mkq(); for (const id of ['v1', 'v2']) ready(id, `---\ntask-id: ${id}\nneeds: verify\n---\n`);
let n = claims(await Promise.all(['10', '11', '12', '13', '14', '15'].map((i) => fleetAsync(['next', r, i, 'repo']))));
truthy('six workers at once take the verify lane once', n === 1, `${n} claims`);
// One chip, one claim, from ten calls at once.
mkq(); for (const id of ['t1', 't2', 't3', 't4', 't5']) plain(id);
n = claims(await Promise.all(Array.from({ length: 10 }, () => fleetAsync(['next', r, '07', 'repo']))));
truthy('ten next calls from one chip claim one task', n === 1, `${n} claims`);
// A lane is a word next knows.
mkq(); plain('t1');
code('next refuses a lane it does not know rather than calling the queue drained', 2, fleet(['next', r, '01', 'Repo']).code);
code('and so does drained, writing no .done', 2, fleet(['drained', r, '01', 'Repo']).code);
truthy('no .done for a mistyped lane', !exists(`${r}/01.done`), 'written');
// Spellings a planner might write by hand hold the task as the exact one does.
mkq(); plain('d0'); write(`${r}/tasks/done/d0`, '');
ready('bom', '\uFEFF---\r\ntask-id: bom\r\nneeds: repo\r\noperator: approve deploy\r\n---\r\n');
ready('two', '---\ntask-id: two\nneeds: repo\nafter: d0\nafter: base\n---\n');
ready('list', '---\ntask-id: list\nneeds: repo\nafter:\n  - base\n---\n');
ready('up', '---\ntask-id: up\nneeds: repo\nAfter: base\nOperator: approve\n---\n');
let o = fleet(['next', r, '01', 'repo']);
code('a BOM, a second after: line, a YAML list and a capitalised key all hold their task', 7, o.code);
check('and next says how many wait', 'QUEUE WAITING for lane repo: 4 task(s)', o.out);
// A directory where a task file belongs is never claimed.
mkq(); mk(`${r}/tasks/ready/d.md`);
o = fleet(['next', r, '01', 'repo']);
code('a directory named like a task is not claimed', 3, o.code);
truthy('and leaves no claim behind', !exists(`${r}/tasks/claimed/d`), 'claimed');
// Every spelling of a fix is held to its proof.
const fixMiss: string[] = [];
for (const k of ['Kind: fix', 'kind: Fix', 'KIND: FIX', 'kind: "fix"', "kind: 'root'", ' kind: fix', 'kind : fix']) {
  mkq(); owner(`${r}/tasks/claimed/t1`, '01');
  ready('t1', `---\ntask-id: t1\nneeds: repo\n${k}\n---\n`);
  const rc = fleet(['finish', r, '01', 't1']).code;
  if (!(rc !== 0 && !exists(`${r}/tasks/done/t1`))) fixMiss.push(`a fix spelled '${k}' still needs its proof: rc ${rc}`);
}
truthy('a fix spelled any way still needs its proof before its done marker', fixMiss.length === 0, fixMiss.join('\n'));
// finish and a handback at the same moment: whoever holds the claim's closing lock goes on, the other backs off.
mkq(); mk(`${r}/tasks/claimed/t1/.closing`); owner(`${r}/tasks/claimed/t1`, '01'); plain('t1');
o = fleet(['handback', r, '01'], { env: QC });
check('handback leaves a claim alone while its worker closes it', 'SKIPPED t1', o.out);
truthy('and files no second copy of it', !exists(`${r}/tasks/ready/t1-r1.md`), 'filed');
rm(`${r}/tasks/claimed/t1/.closing`, `${r}/01.retired`);
code('with the lock free, finish closes it', 0, fleet(['finish', r, '01', 't1']).code);
// A reader that is gone before the first line ends the command with 141, and the locks it took go with it.
mkq(); plain('t1'); plain('t2');
code('next into a closed pipe ends with 141', 141, closedPipe(`next "${r}" 01 repo`));
truthy('and leaves its claim, but not the chip\'s lock', exists(`${r}/tasks/claimed/t1`) && !exists(`${r}/tasks/claimed/.chip-01`), ls(`${r}/tasks/claimed`));
let rc = closedPipe(`finish "${r}" 01 t1`);
truthy('finish into a closed pipe leaves its marker and drops the closing lock', exists(`${r}/tasks/done/t1`) && !exists(`${r}/tasks/claimed/t1/.closing`), `rc ${rc}; ${ls(`${r}/tasks/claimed/t1`)}`);
o = fleet(['next', r, '01', 'repo']);
code('so the next next claims at once', 0, o.code);
check('the next task', 't2', o.out);
// A lock whose holder was killed is taken over at once, not after its stale age.
mkq(); mk(`${r}/tasks/claimed/t1/.closing`); owner(`${r}/tasks/claimed/t1`, '01'); plain('t1');
write(`${r}/tasks/claimed/t1/.closing/pid`, deadPid());
code('a closing lock left by a dead finish does not hold the retry', 0, fleet(['finish', r, '01', 't1']).code);
mkq(); mk(`${r}/tasks/claimed/.chip-01`); plain('t1');
// The holder is a live node: a Git Bash $$ is not a Windows pid.
let h = holder('require("fs").writeFileSync(process.argv[1], String(process.pid))', `${r}/tasks/claimed/.chip-01/pid`);
rc = fleet(['next', r, '01', 'repo']).code;
await stop(h);
code('while a chip lock whose holder lives still holds', 2, rc);
// A closing lock that names the finishing chip is its own, even if its pid now belongs to another process.
mkq(); mk(`${r}/tasks/claimed/t1/.closing`); owner(`${r}/tasks/claimed/t1`, '01'); plain('t1');
h = holder('require("fs").writeFileSync(process.argv[1], process.pid + "\\nchip 01\\n")', `${r}/tasks/claimed/t1/.closing/pid`);
o = fleet(['finish', r, '01', 't1']);
code('a fresh closing lock of the same chip may be its other finish still running', 2, o.code);
check('and is called busy, never CLAIM LOST', 'BUSY: another finish of t1', o.out);
touch(`${r}/tasks/claimed/t1/.closing`, ago(120));
rc = fleet(['finish', r, '01', 't1']).code;
await stop(h);
code('an older one is a killed finish whose pid was reused: the chip takes it back', 0, rc);
code('and a finish of a task already done is done', 0, fleet(['finish', r, '01', 't1']).code);
// Six next calls from one chip over a lock its dead holder left: one claim, every time.
const deadRounds: string[] = [];
for (const k of [1, 2, 3, 4, 5]) {
  mkq(); for (const id of ['t1', 't2', 't3', 't4', 't5', 't6']) plain(id);
  write(`${r}/tasks/claimed/.chip-07/pid`, deadPid());
  n = claims(await Promise.all(Array.from({ length: 6 }, () => fleetAsync(['next', r, '07', 'repo']))));
  if (n !== 1) deadRounds.push(`${n} claims in round ${k}`);
}
truthy('six next calls over a dead chip lock claim once (5 rounds)', deadRounds.length === 0, deadRounds.join('\n'));
// A leading-zero budget is decimal for the clock as for next: 09 arms a nine-minute clock.
mkq(); ready('t9', '---\ntask-id: t9\nneeds: repo\nbudget: 09\n---\n');
o = fleet(['next', r, '01', 'repo']);
check('next hands the clock the budget in decimal', `clock "${shPwd(r)}" 01 t9 9`, o.out);
code('and the clock takes 09', 0, fleet(['clock', r, '01', 't9', '09']).code);
// A claim left with no owner and no heartbeat (next died after its mkdir) ages from the claim itself.
mkq(); mk(`${r}/tasks/claimed/t0`); plain('t0');
touch(`${r}/tasks/claimed/t0`, ago(3 * 3600));
check('sweep releases a claim that never got its owner line', 'released', fleet(['sweep', r, '--release']).out);
// file refuses after: ids that can never be met: not an id, the task itself, a cycle.
mkq(); fleet(['file', r, 'a'], { input: '---\nneeds: repo\n---\n' });
fleet(['file', r, 'b'], { input: '---\nneeds: repo\nafter: c\n---\n' });
const afterMiss: string[] = [];
for (const v of ['[a', '"a", "b"', 'c']) {
  o = fleet(['file', r, 'c'], { input: `---\nneeds: repo\nafter: ${v}\n---\n` });
  if (!(o.code === 2 && !exists(`${r}/tasks/ready/c.md`))) afterMiss.push(`file refuses after: ${v} in task c: rc ${o.code}: ${o.out}`);
}
truthy('file refuses an after: that names no possible id, or the task itself', afterMiss.length === 0, afterMiss.join('\n'));
o = fleet(['file', r, 'c'], { input: '---\nneeds: repo\nafter: b\n---\n' });
code('file refuses an after: chain back to the task (c after b after c)', 2, o.code);
check('and says it is a cycle', 'a cycle', o.out);
o = fleet(['file', r, 'd'], { input: '---\nNeeds: repo\n---\n' });
check('a miscased Needs: is named as miscased, not missing', "write the key as 'needs:'", o.out);
code('a quoted task-id is the id', 0, fleet(['file', r, 'e'], { input: '---\ntask-id: "e"\nneeds: repo\n---\n' }).code);
// file notes, never refuses, two tasks on the same files with no after: between them (one checkout), and a code task with no owns:.
const own = (v: string, extra = ''): string => `---\nneeds: repo\n${extra}owns: ${v}\n---\n`;
const note = (id: string, text: string): string => fleet(['file', r, id], { input: text }).out;
mkq(); fleet(['file', r, 'o1'], { input: own('[src/lib/, docs/a.md]') });
check('file notes an owns: that overlaps an open task with no after: between them', 'NOTE: owns: overlaps o1 (src/lib/) with no after: between them', note('o2', own('./src\\lib\\a.ts')));
absent('and none when after: names it', 'overlaps', note('o3', own('src/lib/', 'after: o1, o2\n')));
absent('nor when the chain runs through another task (o4 after o3 after o1)', 'overlaps', note('o4', own('src/lib/b.ts', 'after: o3\n')));
absent('nor for a disjoint owns:', 'overlaps', note('o5', own('tests/')));
absent('nor for src/li against src/lib/a.ts', 'overlaps', note('o6', own('src/li')));
absent('and a done task is not an overlap', 'overlaps', (write(`${r}/tasks/done/o2`, ''), note('o8', own('src/lib/a.ts', 'after: o3\n'))));
check('a fix with no owns: gets a NOTE', 'NOTE: a fix task has no owns:', note('o9', '---\nneeds: repo\nkind: fix\n---\n'));
absent('a research task with no owns: gets none', 'no owns:', note('o10', '---\nneeds: repo\nkind: research\n---\n'));
fleet(['file', r, 'o11'], { input: own('zz/', 'after: o12\n') });
absent('nor when the earlier task names the new one in its after:', 'overlaps', note('o12', own('zz/a')));
// The same check reads globs, ../ and ./ spellings, absolute paths under the project root, quoted paths, and only a top-level owns:.
const clash = (first: string, second: string, id = 'p2'): string => { mkq(); fleet(['file', r, 'p1'], { input: own(first) }); return note(id, own(second)); };
check('a glob holds the directory before its first wildcard (src/**/*.ts vs src/lib/a.ts)', 'overlaps p1 (src/**/*.ts)', clash('src/**/*.ts', 'src/lib/a.ts'));
absent('and a glob does not reach a sibling directory (src/a*.ts vs tests/)', 'overlaps', clash('src/a*.ts', 'tests/'));
check('a bare *.md is the whole tree', 'overlaps p1 (*.md)', clash('*.md', 'docs/x.txt'));
check('src/x/../lib/a.ts is src/lib/a.ts', 'overlaps p1', clash('src/lib/', 'src/x/../lib/a.ts'));
check('./s2/./lib holds s2/lib/a', 'overlaps p1', clash('./s2/./lib', 's2/lib/a'));
absent('and src/x/../lib/a.ts is not src/x/', 'overlaps', clash('src/x/', 'src/x/../lib/a.ts'));
const proj = `${q}/proj`, r2 = `${proj}/.fleet/r2`;
mk(`${r2}/tasks/ready`); write(`${r2}/tasks/ready/p1.md`, own('src/lib/'));
check('an absolute path under the project root (the folder holding .fleet) is relative to it', 'overlaps p1 (src/lib/)', fleet(['file', r2, 'p2'], { input: own(`${proj}/src/lib/a.ts`) }).out);
absent('and one outside it is left as it is', 'overlaps', fleet(['file', r2, 'p3'], { input: own('/elsewhere/src/lib/a.ts') }).out);
absent('an indented owns: inside another key\'s block is no owns:', 'overlaps', (mkq(), fleet(['file', r, 'p1'], { input: '---\nneeds: repo\nnotes: |\n  owns: tests/\nowns: docs/\n---\n' }), note('p2', own('tests/'))));
check('a quoted owns: path may hold a blank', 'overlaps p1 (q1/a b.ts)', clash('["q1/a b.ts", q2/x]', '"q1/a b.ts"'));
absent('and is not split at it (q1/a is another file)', 'overlaps', clash('["q1/a b.ts", q2/x]', 'q1/a'));
// More than five clashes are five NOTE lines and a count; a code kind spelled with a vowel reads "an".
mkq(); for (let i = 1; i <= 7; i++) fleet(['file', r, `p${i}`], { input: own('big/') });
o = fleet(['file', r, 'p8'], { input: own('big/a') });
truthy('seven clashes are five NOTE lines and "and 2 more"', (o.out.match(/NOTE: owns: overlaps/g) ?? []).length === 5 && o.out.includes('NOTE: owns: and 2 more tasks overlap'), o.out);
check('an implement task with no owns: reads "an implement"', 'NOTE: an implement task has no owns:', note('p9', '---\nneeds: repo\nkind: implement\n---\n'));
// 300 chained tasks: each filing reads each ready file once.
mkq(); for (let i = 1; i <= 300; i++) ready(`c${i}`, `---\nneeds: repo\nowns: dir${i}/\n${i > 1 ? `after: c${i - 1}\n` : ''}---\n`);
const t0 = Date.now();
note('c301', own('dir1/', 'after: c300\n'));
truthy('filing at the end of a 300-task chain takes under 3 s', Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
// A cycle written past file is named where status lists what waits for ever.
ready('x', '---\ntask-id: x\nneeds: repo\nafter: y\n---\n'); ready('y', '---\ntask-id: y\nneeds: repo\nafter: x\n---\n');
check('status names a cycle among the tasks that wait for ever', 'x: its after: chain comes back to it', fleet(['status', r]).out);
// handback of a chip never offered and holding nothing (a typo, 2 for 02) writes no .retired.
mkq(); write(`${r}/offered/02`, 'repo\n');
code('handback refuses a chip that was never offered', 2, fleet(['handback', r, '2'], { env: QC }).code);
truthy('and writes no 2.retired', !exists(`${r}/2.retired`), 'written');
// A fleet.sh copied away from scripts/ says so, rather than a node stack trace.
mk(`${q}/bin`); copyFileSync(FLEET_SH, `${q}/bin/fleet.sh`);
o = exec('sh', [`${q}/bin/fleet.sh`, 'status', r]);
code('a fleet.sh with no fleet.mjs beside it exits 2', 2, o.code);
check('and says why', 'no fleet.mjs beside it', o.out);
// handback renames a quoted after: and a list item, and leaves an After: line in the body alone.
mkq(); write(`${r}/offered/01`, 'repo\n');
plain('a');
ready('b', '---\ntask-id: b\nneeds: repo\nafter: "a"\n---\nAfter: the login works, check it\n');
ready('c', '---\ntask-id: c\nneeds: repo\nafter:\n  - a\n---\n');
fleet(['next', r, '01', 'repo']);
fleet(['handback', r, '01'], { env: QC });
let b = read(`${r}/tasks/ready/b.md`), c = read(`${r}/tasks/ready/c.md`);
truthy('handback renames a quoted after: and a list item', /^after: a-r1$/m.test(b) && /^ {2}- a-r1$/m.test(c), b + c);
truthy('and leaves the body\'s prose alone', /^After: the login works, check it$/m.test(b), b);
code('file refuses an id that was handed back', 2, fleet(['file', r, 'a'], { input: '---\nneeds: repo\n---\n' }).code);
// A handback whose reader is gone still finishes: the old claim closed, every dependent renamed.
mkq(); write(`${r}/offered/01`, 'repo\n'); plain('t1');
for (let i = 1; i <= 12; i++) ready(`d${i}`, `---\ntask-id: d${i}\nneeds: repo\nafter: t1\n---\n`);
fleet(['next', r, '01', 'repo']);
code('handback into a closed pipe ends with 141', 141, closedPipe(`handback "${r}" 01`, `CLAUDE_CONFIG_DIR="${q}/cfg"`));
const renamed = readdirSync(`${r}/tasks/ready`).filter((f) => /^d.*\.md$/.test(f) && /^after: t1-r1$/m.test(read(`${r}/tasks/ready/${f}`))).length;
truthy('and still closes the claim and renames all 12 dependents',
  !exists(`${r}/tasks/ready/t1.md`) && !exists(`${r}/tasks/claimed/t1`) && renamed === 12, ls(`${r}/tasks/ready`, `${r}/tasks/claimed`));
// A handback that died after filing t1-r1 is finished by the next one, not filed a third time.
mkq(); write(`${r}/offered/01`, 'repo\n'); owner(`${r}/tasks/claimed/t1`, '01'); plain('t1');
ready('t1-r1', '---\ntask-id: t1-r1\ncontinued-from-chip: 01\nhandback-of: t1\nneeds: repo\n---\n');
code('finish refuses a claim a half-made handback already filed again', 4, fleet(['finish', r, '01', 't1']).code);
truthy('and writes no done marker for it', !exists(`${r}/tasks/done/t1`), 'written');
touch(`${r}/tasks/claimed/t1/owner`, ago(5 * 3600));
check('sweep leaves a claim a half-made handback filed again to handback', 'already filed it again as t1-r1', fleet(['sweep', r, '--release']).out);
truthy('and does not release it', exists(`${r}/tasks/claimed/t1`), ls(`${r}/tasks/claimed`));
fleet(['handback', r, '01'], { env: QC });
truthy('a half-made handback is finished, not repeated as t1-r2', !exists(`${r}/tasks/ready/t1-r2.md`) && exists(`${r}/tasks/ready/t1-r1.md`), ls(`${r}/tasks/ready`));
// A dependent with no frontmatter, and a list item with a comment, are renamed and released too.
mkq(); write(`${r}/offered/01`, 'repo\n');
plain('z');
ready('y', 'needs: repo\nafter: z\nhi\n');
ready('w', '---\ntask-id: w\nneeds: repo\nafter:\n  - z  # waits for z\n---\n');
fleet(['next', r, '01', 'repo']);
fleet(['handback', r, '01'], { env: QC });
const y = read(`${r}/tasks/ready/y.md`), w = read(`${r}/tasks/ready/w.md`);
truthy('handback renames a dependent with no frontmatter and a commented list item', /^after: z-r1$/m.test(y) && /^ {2}- z-r1$/m.test(w), y + w);
write(`${r}/tasks/done/z-r1`, ''); owner(`${r}/tasks/claimed/z-r1`, '02');
check('and the one with a comment is released once z-r1 is done', 'CLAIMED w', fleet(['next', r, '03', 'repo']).out);
// A handback run again after one that stopped past moving the task file names what it filed.
mkq(); mk(`${r}/tasks/handed-back`); write(`${r}/offered/01`, 'repo\n'); owner(`${r}/tasks/claimed/t`, '01');
write(`${r}/tasks/handed-back/t.md`, '---\ntask-id: t\nneeds: repo\n---\n');
ready('t-r1', '---\ntask-id: t-r1\nhandback-of: t\nneeds: repo\n---\n');
o = fleet(['handback', r, '01'], { env: QC });
check('a handback finishing an earlier one names the task it filed', 't -> t-r1  (filed by an earlier handback', o.out);
absent('and does not ask the planner to file it again', 're-files it', o.out);
// Two file calls for one id at once: one is filed, the other refused.
const fileRounds: string[] = [];
for (const k of [1, 2, 3, 4, 5]) {
  mkq();
  n = (await Promise.all([
    fleetAsync(['file', r, 'x'], { input: '---\nneeds: repo\n---\nA\n' }),
    fleetAsync(['file', r, 'x'], { input: '---\nneeds: repo\n---\nB\n' }),
  ])).reduce((s, x) => s + x.out.split('\n').filter((l) => l.startsWith('FILED')).length, 0);
  if (n !== 1) fileRounds.push(`${n} FILED in round ${k}`);
}
truthy('two file calls for one id at once file it once (5 rounds)', fileRounds.length === 0, fileRounds.join('\n'));
const onWindows = has('cmd');
if (onWindows) {
  o = fleet(['file', r, 'y'], { input: '---\nneeds: repo\nafter: X\n---\n' });
  code('on Windows an after: spelled in another case than the filed task is refused', 2, o.code);
  check('and names the filed spelling', "filed as 'x'", o.out);
}
// A quoted kind with a # in it is still a fix; an indented key does not hide the top-level one; an
// operator: line that starts with # is still owed.
mkq(); owner(`${r}/tasks/claimed/k1`, '01');
ready('k1', '---\ntask-id: k1\nneeds: repo\nkind: "fix #1"\n---\n');
rc = fleet(['finish', r, '01', 'k1']).code;
truthy('kind: "fix #1" still needs its proof', rc !== 0 && !exists(`${r}/tasks/done/k1`), `rc ${rc}`);
ready('o1', '---\ntask-id: o1\nneeds: repo\nmeta:\n  operator: none\noperator: approve the deploy\n---\n');
ready('o2', '---\ntask-id: o2\nneeds: repo\noperator: #12 approve\n---\n');
code('both operator holds stand (an indented none above, a value starting with #): next hands neither out', 7, fleet(['next', r, '02', 'repo']).code);
// A quote inside a trailing comment does not reopen the value; cleared removes the operator line however
// it is spelled.
mkq(); owner(`${r}/tasks/claimed/k2`, '01');
ready('k2', '---\ntask-id: k2\nneeds: repo\nkind: "fix" # reproduced in "app"\n---\n');
rc = fleet(['finish', r, '01', 'k2']).code;
truthy('kind: "fix" # a comment with "quotes" still needs its proof', rc !== 0 && !exists(`${r}/tasks/done/k2`), `rc ${rc}`);
mkq(); ready('o3', '\uFEFF---\ntask-id: o3\nneeds: repo\nOperator: approve\nnotes:\n  operator : bob\n---\n');
fleet(['cleared', r, 'o3']);
code('cleared removes Operator: under a BOM, and an operator : nested in notes holds nothing', 0, fleet(['next', r, '02', 'repo']).code);
const o3 = read(`${r}/tasks/ready/o3.md`);
truthy('and the nested line is left as written', /^ {2}operator : bob$/m.test(o3), o3);
// A released task a planner put back in play under the same id is not released again, nor its dependents.
mkq(); mk(`${r}/tasks/released`);
owner(`${r}/tasks/claimed/A`, '01'); owner(`${r}/tasks/claimed/Z`, '02');
plain('A'); plain('Z');
ready('B', '---\ntask-id: B\nneeds: repo\nafter: A\n---\n'); copyFileSync(`${r}/tasks/ready/A.md`, `${r}/tasks/released/A.md`);
touch(`${r}/tasks/claimed/Z/owner`, ago(5 * 3600));
fleet(['sweep', r, '--release']);
truthy('sweep leaves a re-filed id and its dependents alone', exists(`${r}/tasks/ready/A.md`) && exists(`${r}/tasks/ready/B.md`), ls(`${r}/tasks/ready`));
// A served walk is not an unanswered question; a walk claimed with no owner line can still be swept.
mkq(); mk(`${r}/pane/running/07-9`);
write(`${r}/pane/requests/07-1.md`, 'walk\n'); write(`${r}/pane/results/07-1.json`, '{}\n'); write(`${r}/07.retiring`, '08\n');
fleet(['next', r, '07', 'repo']);
check('a retiring chip with nothing open is retired with its replacement named', 'replaced by 08', read(`${r}/07.retired`));
absent('a retired chip\'s served walk is not named unanswered', 'unanswered', read(`${r}/07.retired`));
write(`${r}/pane/requests/07-9.md`, 'walk\n'); touch(`${r}/pane/running/07-9`, ago(2 * 3600));
check('sweep releases a walk claimed with no owner line', 'walk 07-9', fleet(['sweep', r, '--release']).out);
truthy('and the walk is pending again', !exists(`${r}/pane/running/07-9`), 'still running');
// Two chips choosing the same finding id are two findings, not one reconciled across severities.
mkq();
for (const [chip, area, sev] of [['07', 'cart', 'blocker'], ['08', 'nav', 'polish']] as const) {
  fleet(['find', r, chip], { input: `{"id":"F-001","area":"${area}","severity":"${sev}","observed":"${area} breaks","evidence":"${area}.ts:40 shows it","mechanism_status":"unknown"}` });
}
const MG = `${SCRIPTS}/fleet-merge.mjs`;
o = node([MG, 'merge', r]);
code('merge takes two chips\' F-001 as two findings', 0, o.code);
truthy('and keeps both rows', read(`${r}/backlog.jsonl`).split('\n').filter((l) => l !== '').length === 2, o.out);
// What fleet-gate writes into the run is not read back as a chip's findings.
write(`${r}/clusters.jsonl`, '{"id":"C-1","severity":"blocker","area":"x","observed":"o","evidence":"e.ts:1"}\n');
o = node([MG, 'merge', r]);
check('merge does not read clusters.jsonl as a chip file', 'chip files read  2: 07.jsonl, 08.jsonl', o.out);
truthy('and lists it among the files not read', !(o.out.includes('07.jsonl, 08.jsonl, clusters') || /clusters\.jsonl, [\s\S]*chip files/.test(o.out)), o.out);
// A decision shows in asks with no question filed, and decide refuses a run that does not exist.
const G = `${SCRIPTS}/fleet-gate.mjs`;
node([G, 'decide', r, '03'], { input: '{"token":"/api/x","why":"w"}\n' });
check('asks lists a decision when nobody asked anything', 'decided without asking', node([G, 'asks', r]).out);
o = node([G, 'decide', `${q}/no such run`, '03'], { input: '{"token":"/api/x","why":"w"}\n' });
truthy('decide refuses a run directory that does not exist', o.code !== 0 && !exists(`${q}/no such run`), `rc ${o.code}: ${o.out}`);
absent('decide answers null with its usage, not a stack trace', '    at ', node([G, 'decide', r, '03'], { input: 'null\n' }).out);
const loud: string[] = [];
for (const hk of ['fleet-guard', 'fleet-contract', 'fleet-memory']) {
  o = node([`${HOOKS}/${hk}.mjs`], { input: 'null' });
  if (!(o.code === 0 && o.out === '')) loud.push(`hook ${hk} stays silent on a null payload: rc ${o.code}: ${o.out}`);
}
truthy('the hooks stay silent on a null payload', loud.length === 0, loud.join('\n'));
// A pane worker takes one repo task beside its pane task, and no more; drained refuses while a claim is held.
mkq(); plain('p1', 'pane'); plain('r1'); plain('r2');
fleet(['next', r, '01', 'pane']);
code('a pane worker claims one repo task in its idle window', 0, fleet(['next', r, '01', 'repo']).code);
code('but not a second', 2, fleet(['next', r, '01', 'repo']).code);
code('drained refuses while the chip holds a claim', 2, fleet(['drained', r, '01', 'pane']).code);
truthy('and writes no .done', !exists(`${r}/01.done`), 'written');
// The other order: the pane task closed first, and the pane chip takes its next walk beside the repo task.
mkq(); write(`${r}/offered/01`, 'pane\n'); write(`${r}/offered/02`, 'repo\n');
plain('p1', 'pane'); plain('p2', 'pane'); plain('r1'); plain('r2');
fleet(['next', r, '01', 'pane']); fleet(['next', r, '01', 'repo']); fleet(['finish', r, '01', 'p1']);
code('a pane chip holding its repo task takes the next pane task', 0, fleet(['next', r, '01', 'pane']).code);
fleet(['next', r, '02', 'repo']);
code('while a repo chip asking for pane beside its task is refused', 2, fleet(['next', r, '02', 'pane']).code);
// drained names a task a finished chip still claims instead of sending the worker back to next.
mkq(); ready('p-1', '---\nneeds: pane\n---\nx\n');
fleet(['next', r, '03', 'pane']); write(`${r}/03.blocked`, 'b\n');
check('drained names a task a finished chip still claims', 'still claimed by a chip that has finished: p-1 (chip 03). next cannot hand it out', fleet(['drained', r, '05', 'pane']).out);
mk(`${r}/tasks/ready/dd.md`);
code('cleared on a directory named like a task says no such task', 2, fleet(['cleared', r, 'dd']).code);
// A task id never reaches outside the run, and is always a name git can make a branch of.
write(`${q}/evil.md`, '---\nneeds: repo\noperator: x\n---\nbody\n');
o = fleet(['cleared', r, '../../../evil']);
code('cleared refuses an id with a path in it', 2, o.code);
check('by its id check, not for a missing file', 'is not a task id', o.out);
code('a worker command refuses a chip id with a path in it', 2, fleet(['drained', r, '../esc', 'repo']).code);
truthy('and writes nothing beside the run', !exists(`${q}/esc.done`), 'esc.done written');
check('and the file outside the run keeps its operator line', 'operator: x', read(`${q}/evil.md`));
for (const bad of ['a..b', 'c.', 'x.lock']) {
  code(`file refuses ${bad}, which no git branch can be`, 2, fleet(['file', r, bad], { input: '---\nneeds: repo\n---\nq\n' }).code);
}
mkq(); plain('p1', 'pane'); plain('r1');
fleet(['next', r, '01', 'pane']); write(`${r}/01.retiring`, '02\n');
code('a retiring pane worker gets no repo task in its idle window', 2, fleet(['next', r, '01', 'repo']).code);
// A relaunch of a chip retire already replaced offers no second chip of that number; recover counts the
// retired chip as landed.
const rr = `${q}/rr`; mk(`${rr}/tasks/ready`);
for (const id of ['t1', 't2', 't3', 't4']) write(`${rr}/tasks/ready/${id}.md`, `---\ntask-id: ${id}\nneeds: repo\n---\n`);
fleet(['chips', rr, '01-03', 'repo', '--model', 'claude-opus-5-5', '--effort', 'high']);
for (const c3 of ['01', '02', '03']) {
  const env = { CLAUDE_CODE_SESSION_ID: `s${c3}` };
  fleet(['whoami', rr, c3, 'claude-opus-5-5', 'high'], { env });
  fleet(['next', rr, c3, 'repo'], { env });
}
fleet(['finish', rr, '03', 't3'], { env: { CLAUDE_CODE_SESSION_ID: 's03' } });
fleet(['retire', rr, '03']);
fleet(['relaunch', rr, '--keep-coordinator', '--wait', '0', '03'], { env: QC });
sleep(1); write(`${rr}/STATE.md`, '# state\n');
o = fleet(['relaunch', rr, '--keep-coordinator', '--wait', '0', '03'], { env: QC });
check('relaunch of a chip retire replaced says its chip was offered before', 'was offered before: offer its chip below only if it is not on screen', o.out);
// A chip clicked twice: the second live session as that chip is refused before it claims anything.
const nw = read(`${rr}/replaced/03`).replace(/\s+$/, '');
const sessions = `${t.cfg}/sessions`; mk(sessions);
// The live session's record names a live process, as Claude Code's does.
h = holder('require("fs").writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, sessionId: "sA" }))', `${sessions}/1.json`);
fleet(['next', rr, nw, 'repo'], { env: { CLAUDE_CODE_SESSION_ID: 'sA' } });
o = fleet(['next', rr, nw, 'repo'], { env: { CLAUDE_CODE_SESSION_ID: 'sB' } });
code('a second live session as one chip is refused', 2, o.code);
check('and told it is a double click', 'CHIP TAKEN', o.out);
// Two sessions whose first calls overlapped both registered: the one that took the chip first keeps it.
write(`${rr}/chips/sB`, nw); touch(`${rr}/chips/sB`, new Date(Date.now() + 60000));
write(`${sessions}/2.json`, read(`${sessions}/1.json`).replace('"sA"', '"sB"'));
o = fleet(['beat', rr, nw, 'none'], { env: { CLAUDE_CODE_SESSION_ID: 'sA' } });
check('the session that registered first keeps its chip (beat runs past the gate)', 'CLAIM LOST none', o.out);
o = fleet(['beat', rr, nw, 'none'], { env: { CLAUDE_CODE_SESSION_ID: 'sB' } });
check('and the later one is refused', 'CHIP TAKEN', o.out);
rm(`${rr}/chips/sB`, `${sessions}/2.json`);
await stop(h);
write(`${sessions}/1.json`, `{"pid":${deadPid()},"sessionId":"sA"}`);
o = fleet(['beat', rr, nw, 'none'], { env: { CLAUDE_CODE_SESSION_ID: 'sB' } });
check('a record left by a killed session does not hold the chip (beat runs past the gate)', 'CLAIM LOST none', o.out);
rm(`${sessions}/1.json`);
// relaunch never hands a replacement the number of a brief written for a later wave.
const lastOffered = readdirSync(`${rr}/offered`).sort().at(-1) ?? '0';
const bn = String(parseInt(lastOffered, 10) + 1).padStart(2, '0'); write(`${rr}/brief-${bn}.md`, '---\nbrief\n---\n');
fleet(['relaunch', rr, '--keep-coordinator', '--wait', '0', '01']); sleep(1); write(`${rr}/STATE.md`, '# state\n');
fleet(['relaunch', rr, '--keep-coordinator', '--wait', '0', '01']);
const rep01 = read(`${rr}/replaced/01`);
truthy('relaunch skips a number a brief file holds', rep01.length > 0 && rep01.replace(/\s+$/, '') !== bn, `brief ${bn}, replaced by ${rep01}`);
o = fleet(['recover', rr]);
truthy('recover counts a retired chip as landed', !(o.out.includes('RESPAWN chip 03') || o.out.includes('RESUME chip 03')), o.out);
// recover --release retires a dead chip that held nothing, so the watch does not wait for its marker.
const PJ = { CLAUDE_PROJECTS_DIR: `${q}/proj` };
mkq(); write(`${r}/chips/sDead`, '08\n'); write(`${q}/proj/p/other.jsonl`, '{}\n');
fleet(['recover', r, '--release'], { env: PJ });
truthy('recover --release retires a dead chip that held nothing', /^respawned/m.test(read(`${r}/08.retired`)), ls(r));
// A dead host's walk is named as held and given back, not left claimed until its lease.
mk(`${r}/pane/results`); write(`${r}/offered/11`, 'pane\n'); write(`${r}/chips/sHost`, '11\n');
write(`${r}/pane/requests/07-1.md`, 'walk\n'); fleet(['pane-next', r, '11']);
check('recover names a dead host\'s walk as held', 'holding: walk 07-1', fleet(['recover', r, '--release'], { env: PJ }).out);
truthy('and --release puts it back to pending', !exists(`${r}/pane/running/07-1`), 'still running');
// Not when another session of that chip can still be resumed; a retired dead chip keeps its open question.
write(`${r}/offered/13`, 'pane\n'); write(`${r}/chips/sOld13`, '13\n'); write(`${r}/chips/sLive`, '13\n'); write(`${q}/proj/p/sLive.jsonl`, '{}\n');
fleet(['pane-next', r, '13']);
fleet(['recover', r, '--release'], { env: PJ });
truthy('recover keeps the walk of a chip with a live session', exists(`${r}/pane/running/07-1`), 'released');
write(`${r}/chips/sGone`, '12\n'); write(`${r}/ask/12-1.md`, 'Which port?\n');
fleet(['recover', r, '--release'], { env: PJ });
check('recover records a retired chip\'s open question', 'unanswered: ask/12-1.md', read(`${r}/12.retired`));
// A requester handed back by relaunch or recover keeps its unanswered walk on record.
mkq(); write(`${r}/offered/07`, 'repo\n'); write(`${r}/pane/requests/07-1.md`, 'walk\n');
fleet(['handback', r, '07'], { env: QC });
check('handback records the walk its chip asked for', 'unanswered: pane/requests/07-1.md', read(`${r}/07.retired`));
// A host waiting on a model switch is not idle while its walk runs: retire leaves the walk alone.
mkq(); mk(`${r}/pane/results`); write(`${r}/offered/02`, 'pane\n'); write(`${r}/offered/03`, 'pane\n');
write(`${r}/chips/02.model`, 'opus high plugin 1.6.0\n'); ready('t1', '---\nneeds: pane\n---\n');
write(`${r}/pane/requests/07-1.md`, 'walk\n'); fleet(['pane-next', r, '02']); write(`${r}/chips/02.switch`, 'x -> y\n');
fleet(['retire', r, '02'], { env: QC });
truthy('retire waits for a switching host\'s walk', exists(`${r}/pane/running/07-1`) && !exists(`${r}/02.retired`), ls(r, `${r}/pane/running`));
write(`${r}/chips/sBrief`, '09\n'); write(`${r}/brief-09.md`, '---\nbrief\n---\n');
fleet(['recover', r, '--release'], { env: PJ });
truthy('but never a dead brief worker, whose brief is unworked', !exists(`${r}/09.retired`), 'retired');
write(`${r}/chips/sWait`, '10\n'); write(`${r}/10.waiting`, 'blind\n');
o = fleet(['recover', r, '--release'], { env: PJ });
check('a dead brief worker is pointed at relaunch', "--keep-coordinator --wait 0 09' copies it to a fresh chip", o.out);
truthy('and a dead chip that left only .waiting is retired, not called landed', exists(`${r}/10.retired`), o.out);
// A pause does not eat a pane walk's lease, and a host mid-walk counts as holding work.
mkq(); write(`${r}/pane/running/07-1/owner`, 'host 02\nclaimed x\n'); write(`${r}/pane/requests/07-1.md`, 'walk\n');
check('a pause counts a host mid-walk as holding work', '1 worker(s) hold claims', fleet(['pause', r, 'lunch'], { env: QC }).out);
touch(`${r}/pane/running/07-1/owner`, ago(40 * 60));
fleet(['resume', r], { env: QC });
absent('a walk in progress survives a long pause', 'walk 07-1', fleet(['sweep', r, '--release']).out);
// A finished host's walk holds no pause; a handed-back host's walk is pending again at once.
mkq(); write(`${r}/offered/02`, 'pane\n');
write(`${r}/pane/running/05-1/owner`, 'host 02\nclaimed x\n'); write(`${r}/pane/requests/05-1.md`, 'walk\n'); write(`${r}/02.retired`, '');
check('a retired host\'s walk does not count as work held', '0 worker(s) hold claims', fleet(['pause', r, 't'], { env: QC }).out);
fleet(['resume', r], { env: QC }); rm(`${r}/02.retired`);
check('handback of a host puts its walk back to pending', 'walk 05-1 is pending again', fleet(['handback', r, '02'], { env: QC }).out);
// The early stop docs/PULL.md describes lands: unclaimed tasks parked in tasks/stopped/ count for nothing.
mkq(); for (const id of ['t1', 't2', 't3']) plain(id);
fleet(['next', r, '01', 'repo']); mk(`${r}/tasks/stopped`);
for (const id of ['t2', 't3']) renameSync(`${r}/tasks/ready/${id}.md`, `${r}/tasks/stopped/${id}.md`);
fleet(['finish', r, '01', 't1']); fleet(['drained', r, '01', 'repo']);
node([MG, 'merge', r]);
code('a run stopped early as PULL.md says lands', 0, fleet(['landed', r, '1'], { env: QC }).code);
// An answer is never filed ahead of its question, and ask never takes a number an answer holds.
mkq();
code('answer refuses an id that names no question', 2, fleet(['answer', r, '15-1'], { input: 'Use staging\n' }).code);
truthy('and writes nothing', !exists(`${r}/answers/15-1.md`), 'written');
write(`${r}/answers/15-1.md`, 'stale\n');
check('ask skips a number an answer already holds', 'ask/15-2.md', fleet(['ask', r, '15'], { input: 'Which port?\n' }).out);
// An answer id is a name in ask/, never a path that reaches the question itself.
mkq(); write(`${r}/ask/05-1.md`, 'Which port?\n');
code('answer refuses an id with a path in it', 2, fleet(['answer', r, '../ask/05-1'], { input: 'Use 8080\n' }).code);
check('and the question is left as it was', 'Which port?', read(`${r}/ask/05-1.md`));
truthy('and makes no answers/ for a refused id', !exists(`${r}/answers`), 'made');
// A retiring host still serving a walk is not retired by next, nor given another walk; the walk survives.
mkq(); mk(`${r}/pane/results`); write(`${r}/offered/03`, 'pane\n');
write(`${r}/pane/requests/03-1.md`, 'walk\n'); write(`${r}/pane/requests/04-1.md`, 'walk\n');
fleet(['pane-next', r, '03']); write(`${r}/03.retiring`, '08\n');
code('a retiring host takes no new walk', 2, fleet(['pane-next', r, '03']).code);
o = fleet(['next', r, '03', 'repo']);
code('next does not retire a host mid-walk', 2, o.code);
check('and names the walk it holds', 'HOLDING walk 03-1', o.out);
truthy('and writes no retired marker', !exists(`${r}/03.retired`), 'written');
write(`${r}/PAUSED`, 'lunch\n'); rc = fleet(['next', r, '03', 'repo']).code; rm(`${r}/PAUSED`);
code('under a pause a retiring host mid-walk gets the pause and its wake loop', 8, rc);
code('drained refuses a host mid-walk', 2, fleet(['drained', r, '03', 'pane']).code);
truthy('and writes no done marker', !exists(`${r}/03.done`), 'written');
code('the host still serves its walk', 0, fleet(['pane-serve', r, '03', '03-1'], { input: '{"gate":30,"conditions":"1280x800 zoom 100","observations":[]}' }).code);
code('then next retires it', 9, fleet(['next', r, '03', 'repo']).code);
// A host that cannot serve its walk gives it back at once, and only its own.
mkq(); mk(`${r}/pane/results`); write(`${r}/offered/03`, 'pane\n');
write(`${r}/pane/requests/04-1.md`, 'walk\n'); fleet(['pane-next', r, '03']);
code('another host cannot release a walk', 4, fleet(['pane-serve', r, '05', '04-1', '--release']).code);
check('a host releases a walk it cannot serve', 'RELEASED 04-1', fleet(['pane-serve', r, '03', '04-1', '--release']).out);
truthy('and it is pending again', !exists(`${r}/pane/running/04-1`), 'still running');
// A chip recover retired is still handed back in full (its tree's commit, the pause hooks' marker).
mkq(); write(`${r}/offered/56`, 'repo\n'); write(`${r}/56.retired`, 'respawned: session gone\n');
check('handback runs for a chip recover retired', 'HANDED BACK 56', fleet(['handback', r, '56'], { env: QC }).out);
// A failed merge removes its own output only, never the workers' decisions; an object id is a string.
mkq(); write(`${r}/01.jsonl`, '{"id":{"x":1},"severity":"major","area":"a","observed":"o","evidence":"e.ts:1"}\n{"torn\n');
write(`${r}/decisions.jsonl`, '{"chip":"01","token":"/x","why":"w"}\n');
rc = node([MG, 'merge', r]).code;
truthy('a failed merge keeps decisions.jsonl', rc !== 0 && exists(`${r}/decisions.jsonl`), `rc ${rc}; ${ls(r)}`);
write(`${r}/01.jsonl`, '{"id":{"x":1},"severity":"major","area":"a","observed":"o","evidence":"e.ts:1"}\n');
code('a finding whose id is an object still reconciles', 0, node([MG, 'merge', r]).code);
// Two different Cyrillic observations in one area are two rows; a torn line is named by its real number.
mkq(); write(`${r}/01.jsonl`, '{"id":"A1","severity":"blocker","area":"checkout","observed":"Оплата падает с ошибкой","evidence":"src/pay.ts:10","mechanism_status":"unknown"}\n');
write(`${r}/02.jsonl`, '{"id":"B1","severity":"major","area":"checkout","observed":"Сумма заказа считается без скидки","evidence":"src/sum.ts:4","mechanism_status":"unknown"}\n');
check('findings in another script are not merged into one', 'merged entries   2', node([MG, 'merge', r]).out);
write(`${r}/02.jsonl`, '{"id":"B1","severity":"major","area":"x","observed":"ok","evidence":"e.ts:1","mechanism_status":"unknown"}\n\n\n{"id":"B2", torn\n');
check('a torn line after blank ones is named by its own number', '02:4', node([MG, 'merge', r]).out);
// The totals count a chip file with no last newline as its row does.
mkq(); write(`${r}/a.jsonl`, '{"severity":"blocker"}'); write(`${r}/b.jsonl`, '{"severity":"blocker"}\n');
check('summary totals count a file with no last newline', 'blockers 2', fleet(['summary', r]).out);
// One row per worker, a finished pane host and a retired worker with no findings file too.
write(`${r}/03.done`, ''); write(`${r}/01.retired`, 'retired x\n');
check('summary has a row for a worker with no findings file', '03   done', fleet(['summary', r]).out);
write(`${r}/06.jsonl`, '{"unreached":"step 3","reason":"budget exceeded"}\n');
o = fleet(['summary', r]);
check('an unreached line is no finding in a row either', '06   running  tasks 0   findings 0', o.out);
check('and one for a retired worker', '01   RETIRED', o.out);
// The installed version is read from CLAUDE_CONFIG_DIR's plugin record, not always from ~/.claude.
write(`${q}/cfgv/inst/.claude-plugin/plugin.json`, '{"version":"9.9.9"}\n');
write(`${q}/cfgv/plugins/installed_plugins.json`, JSON.stringify({ plugins: { 'makarasty@makarasty': [{ installPath: nativePath(`${q}/cfgv/inst`) }] } }));
o = node(['--input-type=module', '-e', `import { installedVersion } from '${pathToFileURL(`${SCRIPTS}/fleet/lib.mjs`).href}'; console.log(installedVersion())`], { env: { CLAUDE_CONFIG_DIR: `${q}/cfgv` } });
check('the installed version comes from CLAUDE_CONFIG_DIR', '9.9.9', o.out);
// A file:line is evidence however short.
code('find takes a short file:line as evidence', 0, fleet(['find', r, '05'], { input: '{"area":"a.txt","severity":"major","observed":"x","repro":"grep -q fixed a.txt","evidence":"a.txt:1","mechanism":"m","mechanism_status":"established","conditions":"c"}' }).code);
code('but not a short text that only has a colon and a number', 1, fleet(['find', r, '05'], { input: '{"area":"a.txt","severity":"major","observed":"x","repro":"r","evidence":"http://x:1","mechanism":"m","mechanism_status":"established","conditions":"c"}' }).code);
for (const ev of ['a.ts:10:5', 'a.ts#L10', 'C:/a.ts:1']) {
  code(`find takes ${ev} as evidence`, 0, fleet(['find', r, '05'], { input: `{"area":"a.txt","severity":"major","observed":"x","repro":"r","evidence":"${ev}","mechanism":"m","mechanism_status":"established","conditions":"c"}` }).code);
}
// fixqueue writes its queue beside a README already in tasks/ready.
const fx = `${q}/runs`; mk(`${fx}/r1`); write(`${fx}/fix-r1/tasks/ready/README.txt`, 'hi\n');
write(`${fx}/r1/backlog.jsonl`, '{"id":"f1","severity":"major","area":"a","observed":"o","repro":"r","evidence":"e.ts:1","mechanism":"m","mechanism_status":"x","confirmation":"confirmed","workers":["01"]}\n'
  + '{"id":"f2","severity":"major","area":"b","observed":"o","repro":"Open the export dialog and wait.","evidence":"b.ts:1","mechanism":"m","mechanism_status":"x","confirmation":"confirmed","workers":["01"]}\n'
  + '{"id":"f3","severity":"major","area":"c","observed":"o","repro":"CI=1 npm test -- c","evidence":"c.ts:1","mechanism":"m","mechanism_status":"x","confirmation":"confirmed","workers":["01"]}\n'
  + '{"id":"f4","severity":"major","area":"d","observed":"o","repro":"npm test -- d # flaky on CI","evidence":"d.ts:1","mechanism":"m","mechanism_status":"x","confirmation":"confirmed","workers":["01"]}\n'
  + '{"id":"f5","severity":"major","area":"e","observed":"o","repro":"performance.getEntriesByType(\'navigation\')[0].duration","evidence":"e2.ts:1","mechanism":"m","mechanism_status":"x","confirmation":"confirmed","workers":["01"]}\n'
  + '{"id":"f6","severity":"major","area":"f","observed":"o","repro":"node sub\\\\x.mjs","evidence":"f.ts:1","mechanism":"m","mechanism_status":"x","confirmation":"confirmed","workers":["01"]}\n'
  + '{"id":"f7","severity":"major","area":"g","observed":"o","repro":".\\\\gradlew.bat test","evidence":"g.ts:1","mechanism":"m","mechanism_status":"x","confirmation":"confirmed","workers":["01"]}\n');
o = node([MG, 'fixqueue', `${fx}/r1`]);
code('fixqueue writes beside a README in tasks/ready', 0, o.code);
truthy('keeping the README', exists(`${fx}/fix-r1/tasks/ready/README.txt`) && readdirSync(`${fx}/fix-r1/tasks/ready`).some((f) => f.startsWith('task-001')), o.out);
// The coordinator reads only the frontmatter, so a shell reproduction goes there; prose stays in the body.
check('fixqueue puts a command reproduction in the frontmatter', '\nrepro: r\n---', read(`${fx}/fix-r1/tasks/ready/task-001-a.md`));
check('one led by an environment variable too', '\nrepro: CI=1 npm test -- c\n---', read(`${fx}/fix-r1/tasks/ready/task-003-c.md`));
check('and leaves it empty for prose', '\nrepro:\n---', read(`${fx}/fix-r1/tasks/ready/task-002-b.md`));
check('which stays in the body', 'Open the export dialog and wait.', read(`${fx}/fix-r1/tasks/ready/task-002-b.md`));
// A ` #` comment would swallow whatever a root task joins after it, and a JS expression is no command.
check('a reproduction with a # comment is left empty', '\nrepro:\n---', read(`${fx}/fix-r1/tasks/ready/task-004-d.md`));
check('and a JS member-call expression too', '\nrepro:\n---', read(`${fx}/fix-r1/tasks/ready/task-005-e.md`));
// prove runs a repro in bash, where a backslash path loses its backslash: those are left to the coordinator.
check('a backslash path is left empty', '\nrepro:\n---', read(`${fx}/fix-r1/tasks/ready/task-006-f.md`));
check('and a .\\gradlew.bat one too', '\nrepro:\n---', read(`${fx}/fix-r1/tasks/ready/task-007-g.md`));
// A retire killed while retiring an idle worker finishes the retirement when run again.
mkq(); mk(`${r}/replaced`); write(`${r}/offered/05`, 'repo\n'); write(`${r}/offered/06`, 'repo\n');
write(`${r}/replaced/05`, '06\n'); write(`${r}/05.retiring`, '06\n'); write(`${r}/stopped/05`, '');
fleet(['retire', r, '05'], { env: QC });
truthy('a retire run again finishes retiring an idle worker', exists(`${r}/05.retired`), ls(r));
// A release killed after moving its file still takes the dependents along when run again.
mkq(); owner(`${r}/tasks/claimed/tx`, '03');
write(`${r}/tasks/released/tx.md`, '---\ntask-id: tx\nneeds: repo\n---\n');
ready('d1', '---\ntask-id: d1\nneeds: repo\nafter: tx\n---\n');
touch(`${r}/tasks/claimed/tx/owner`, ago(3 * 3600));
check('a sweep run again after a killed one releases the dependents it left', 'also released d1', fleet(['sweep', r, '--release']).out);
// The new task of a handback that has not closed the old claim yet still carries the before proof.
mkq(); owner(`${r}/tasks/claimed/tf`, '01');
write(`${r}/tasks/claimed/tf/proof`, '{"phase":"before","exit":1}\n');
ready('tf', '---\ntask-id: tf\nneeds: repo\nkind: fix\n---\n');
ready('tf-r1', '---\ntask-id: tf-r1\ncontinued-from-chip: 01\nhandback-of: tf\nneeds: repo\nkind: fix\n---\n');
fleet(['next', r, '02', 'repo']);
truthy('next copies the before proof from a claim handback has not closed yet', read(`${r}/tasks/claimed/tf-r1/proof`).includes('"phase":"before"'), ls(`${r}/tasks/claimed/tf-r1`));
// A chip that is not a number is refused before it names anything.
code('handback refuses ./01 for 01', 2, fleet(['handback', r, './01'], { env: QC }).code);
// A task with no task-id: line is handed back with the lines that carry its branch and proof.
mkq(); write(`${r}/offered/01`, 'repo\n');
fleet(['file', r, 'n'], { input: '---\nneeds: repo\nkind: fix\n---\nA\n' });
fleet(['next', r, '01', 'repo']);
fleet(['handback', r, '01'], { env: QC });
const nr1 = read(`${r}/tasks/ready/n-r1.md`);
truthy('a task filed with no task-id: keeps its handback-of', /^handback-of: n$/m.test(nr1), nr1);
// file: `after: .` and a budget the clock cannot use are refused; a path in /dev is read by the shell.
for (const v of ['after: .', 'budget: 0', 'budget: abc', 'budget: 99999999999']) {
  code(`file refuses '${v}'`, 2, fleet(['file', r, 'v'], { input: `---\nneeds: repo\n${v}\n---\n` }).code);
}
write(`${q}/in.md`, '---\nneeds: repo\nbudget: 30\n---\n');
// The redirect is the shell's own: node hands a child a Windows pipe for stdin, which Git Bash cannot open as
// /dev/stdin, while a file redirected by sh is what a planner's `< task.md` gives fleet.sh.
code('file reads /dev/stdin as the shell does', 0, sh(`sh "${FLEET_SH}" file "${r}" s /dev/stdin < "${q}/in.md"`).code);
if (onWindows) {
  code('on Windows an after: naming the task in another case is the task itself', 2, fleet(['file', r, 's2'], { input: '---\nneeds: repo\nafter: S2\n---\n' }).code);
}
// drained does not count a claim whose worker has already finished as held.
mkq(); write(`${r}/offered/01`, 'pane\n'); write(`${r}/offered/02`, 'pane\n');
owner(`${r}/tasks/claimed/t1`, '01'); plain('t1', 'pane');
write(`${r}/01.blocked`, 'blind\n');
code('a task held by a worker that already wrote .blocked keeps the lane open', 5, fleet(['drained', r, '02', 'pane']).code);
// pane-next hands nothing out on a paused or landed run, or to a retired host.
mkq(); write(`${r}/pane/requests/02-1.md`, 'walk\n');
write(`${r}/06.retired`, '');
code('a retired host claims no walk', 9, fleet(['pane-next', r, '06']).code);
fleet(['pause', r, 'x'], { env: QC });
code('a paused run hands out no walk', 8, fleet(['pane-next', r, '05']).code);
fleet(['resume', r], { env: QC });
write(`${r}/FINISHED`, '');
code('nor a run that landed', 9, fleet(['pane-next', r, '05']).code);
// A value whose own toString is not a function is refused, not a crash.
mkq();
o = fleet(['find', r, '07'], { input: '{"area":"a","severity":"minor","observed":{"toString":1},"evidence":"file.ts:1 something long","mechanism_status":"unknown"}' });
truthy('find refuses a field whose toString is not a function', !(o.out.includes('TypeError') || o.out.includes('at ')), o.out);
code('rects with string coordinates are refused', 1, fleet(['find', r, '07'], { input: '{"area":"a","severity":"minor","observed":"overlap","evidence":"two boxes that overlap","mechanism_status":"unknown","conditions":"1440px","rects":{"a":{"x":"10","y":0,"w":"5","h":10},"b":{"x":12,"y":0,"w":5,"h":10}}}' }).code);
// file refuses keys the queue acts on when they are spelled another way.
mkq();
code('file refuses a capitalised key', 2, fleet(['file', r, 'k1'], { input: '---\ntask-id: k1\nneeds: repo\nKind: fix\n---\n' }).code);
code('and an after: written as a list', 2, fleet(['file', r, 'k2'], { input: '---\ntask-id: k2\nneeds: repo\nafter:\n  - base\n---\n' }).code);
code('but not a list under a key the queue never reads', 0, fleet(['file', r, 'k3'], { input: '---\ntask-id: k3\nneeds: repo\nfiles:\n  - a.ts\n---\n' }).code);
// Two spellings of one run are one pause marker.
if (sh('uname -o 2>/dev/null').out === 'Msys') {
  mkq(); const low = shPwd(r).toLowerCase();
  const C2 = { CLAUDE_CONFIG_DIR: `${q}/cfg2` };
  fleet(['pause', low, 'x'], { env: C2 });
  fleet(['resume', r], { env: C2 });
  let left = 0;
  try { left = readdirSync(`${q}/cfg2/makarasty/paused`).filter((f) => !f.endsWith('.retired')).length; } catch { left = 0; }
  truthy('a run paused under one spelling resumes under another', left === 0, `${left} markers left`);
}
rm(q);

// procs --kill picks only what nobody uses. A test process list never ends anything (WOULD KILL).
{
  const pk = t.tmp('procs-kill'); mk(`${pk}/cfg/sessions`);
  const now = Date.now();
  const row = (pid: number, cmd: string): Record<string, unknown> => ({ Name: 'node.exe', ProcessId: pid, ParentProcessId: 9999990 + pid % 7, WorkingSetSize: 1048576, CommandLine: cmd, Cpu: 5, Created: now - 600000 });
  write(`${pk}/p1.json`, JSON.stringify([
    row(9100001, 'node C:/x/node_modules/typescript/bin/tsc -w -p tsconfig.json'),
    row(9100002, 'node C:/x/node_modules/.bin/tsc -b -w'),
    row(9100003, 'node C:/x/node_modules/vitest/vitest.mjs watch'),
    row(9100004, 'node C:/x/node_modules/vitest/vitest.mjs run'),
    row(9100005, 'node C:/x/node_modules/vitest/vitest.mjs --ui --api 51204')]));
  const st = now - 1500000;
  write(`${pk}/p2.json`, JSON.stringify([
    { Name: 'bash.exe', ProcessId: 9200001, ParentProcessId: 9299999, WorkingSetSize: 1, CommandLine: 'bash -c "source /c/Users/u/.claude/shell-snapshots/snapshot-bash-1700000000001-dead01.sh; claude --continue"', Cpu: 5, Created: now - 1800000 },
    { Name: 'claude.exe', ProcessId: 9300000, ParentProcessId: 9200001, WorkingSetSize: 1, CommandLine: 'claude --continue', Cpu: 5, Created: st },
    { Name: 'bash.exe', ProcessId: 9300001, ParentProcessId: 9300000, WorkingSetSize: 1, CommandLine: `bash -c "source /c/Users/u/.claude/shell-snapshots/snapshot-bash-${st + 60000}-live01.sh; sleep 9"`, Cpu: 5, Created: st + 60000 }]));
  write(`${pk}/cfg/sessions/9300000.json`, JSON.stringify({ pid: 9300000, sessionId: 'cccccccc-1111-2222-3333-444444444444', startedAt: st }));
  const LOAD = `${SCRIPTS}/fleet-load.mjs`;
  o = node([LOAD, '--leftovers', '--kill'], { env: { FLEET_LISTEN_PIDS: '9100005', CLAUDE_CONFIG_DIR: `${pk}/cfg`, FLEET_PROCS_JSON: `${pk}/p1.json` } });
  truthy('a watcher (tsc -w, tsc -b -w, vitest watch) is never taken for a finished run', !/WOULD KILL[\s\S]*(9100001|9100002|9100003)/.test(o.out), o.out);
  check('while a finished one-shot run still is', 'WOULD KILL (a test process list: nothing was ended)  pid 9100004', o.out);
  check('and a run holding a port is left for the operator', 'holding a port: left alone (ask the operator)  pid 9100005', o.out);
  o = node([LOAD, '--leftovers', '--kill'], { env: { FLEET_LISTEN_PIDS: '', CLAUDE_CONFIG_DIR: `${pk}/cfg`, FLEET_PROCS_JSON: `${pk}/p2.json` } });
  truthy('a closed chat\'s shell that a live chat runs under is never ended', !(o.out.includes('WOULD KILL') || o.out.includes('KILLED')), o.out);
  rm(pk);
}
{
  const fd = t.tmp('file-dead'); mk(`${fd}/tasks/ready`);
  code('file refuses an id that names a closed claim', 2, fleet(['file', fd, 'x.dead-1'], { input: '---\nneeds: repo\n---\nb\n' }).code);
  rm(fd);
}

// The TypeScript sources under src/ compile to the .mjs files that run: fleet-analyze's own test, then, once
// `npm install --prefix src` has put the pinned compiler there, the type check and the proof that every
// committed .mjs is what its source compiles to - a copy compiled from an older source would run old
// behaviour behind every check above, and another compiler version prints other bytes. That now includes
// these test files themselves (scripts/selftest/*.mjs).
// Without the compiler too: the build recorded a hash of every source and every .mjs it wrote.
o = node([`${SCRIPTS}/fleet-manifest.mjs`, 'check']);
code('every .mjs is what the build wrote from today\'s sources (npm run build --prefix src)', 0, o.code);
if (o.code !== 0) console.log(o.out.split('\n').map((l) => `        ${l}`).join('\n'));
o = node([`${SCRIPTS}/fleet-analyze-test.mjs`]);
code('fleet-analyze\'s own test passes', 0, o.code);
check('with nothing failed', ' 0 failed', o.out);
// The compiler is a sh shim in node_modules/.bin on every platform, so it runs through sh.
const tsc = `${ROOT}/src/node_modules/.bin/tsc`;
if (exists(tsc)) {
  // Every tsconfig the build runs, with the directory its outDir points at and what it writes: the browser
  // probes are plain scripts, compiled to .js beside the other scripts.
  for (const [p, outRoot, ext] of [['src', '', '.mjs'], ['tools/src', 'tools', '.mjs'], ['src/probes', 'scripts', '.js']] as const) {
    const tso = t.tmp(`fleet-tsout-${p.split('/').join('-')}`);
    o = sh(`"${tsc}" -p "${ROOT}/${p}" --outDir "${tso}"`);
    code(`the TypeScript sources in ${p} type-check and compile`, 0, o.code);
    const built = readdirSync(tso, { recursive: true, encoding: 'utf8' }).map(fwd).filter((f) => f.endsWith(ext)).sort();
    const stale: string[] = built.length ? [] : ['(tsc wrote nothing)'];
    for (const f of built) {
      const shipped = `${ROOT}/${outRoot ? `${outRoot}/` : ''}${f}`;
      if (!exists(shipped) || !readFileSync(shipped).equals(readFileSync(`${tso}/${f}`))) stale.push(f);
    }
    // The sh named the failure "... current (npm run build --prefix src)"; the fix rides in the detail here.
    truthy('and every .mjs compiled from them is current', stale.length === 0, `${stale.join(' ')} (npm run build --prefix src)`);
    rm(tso);
  }
} else {
  skip('type check and build parity', 'no compiler in src/node_modules (npm install --prefix src)');
}
