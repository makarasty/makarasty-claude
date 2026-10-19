// f-file-stranded-status.test.mts - filing tasks, what status names, model wishes and retire, stranded
// branches, and the leftovers census (fleet-selftest.sh "== file, stranded, and what status names").

import { setup, fleet, sh, node, git, exec, shPwd, check, absent, code, truthy, write, read, exists, mk, rm, touch, watchLoop, ROOT, SCRIPTS } from './lib.mts';
import { readdirSync, readFileSync } from 'node:fs';

const t = setup('file-stranded-status');

// The brief run the sh version made a section earlier: a brief worker registered under sess-brief, the run
// paused with its own config dir, and the worker done since.
const bw = t.tmp('fleet-bw');
mk(`${bw}/tasks/ready`);
write(`${bw}/brief-01.md`, '---\nbrief\n---\n');
fleet(['whoami', bw, '01', 'm', 'x'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-brief' } });
fleet(['pause', bw], { env: { CLAUDE_CONFIG_DIR: `${bw}/cfg` } });
touch(`${bw}/01.done`);
fleet(['pause', bw], { env: { CLAUDE_CONFIG_DIR: `${bw}/cfg` } });
fleet(['whoami', bw, '02', 'm', 'x'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-reg', CLAUDE_CONFIG_DIR: `${bw}/cfg` } });
truthy('a registered worker is recorded for the context hook', read(`${bw}/cfg/makarasty/fleet-sessions/sess-reg`) !== '',
  exists(`${bw}/cfg/makarasty`) ? readdirSync(`${bw}/cfg/makarasty`).join('\n') : 'no cfg/makarasty');

const fr = t.tmp('fleet-fr');
mk(`${fr}/tasks/ready`, `${fr}/tasks/done`, `${fr}/offered`, `${fr}/chips`);
const file = (id: string, body: string | Buffer) => fleet(['file', fr, id], { input: body });

let r = file('a1', '---\ntask-id: a1\nneeds: repo\noperator: grant the role\n---\nx\n');
code('file exits 0 on a good task', 0, r.code);
check('and says FILED with its lane', 'FILED a1 lane repo', r.out);
check('and says a task waiting on the operator is asked now', 'waits on the operator', r.out);
file('b1', '---\nneeds: repo\nafter: a1\n---\n');
file('c1', '---\nneeds: repo\nafter: b1\n---\n');
r = file('d1', '---\nneeds: repo\nafter: a1, zz\n---\n');
check('an after: naming nothing filed is noted', 'names a task not filed yet: zz', r.out);
r = file('e1', '---\nneeds: opus\n---\n');
code('a lane that is a model is refused', 2, r.code);
truthy('and nothing is filed', !exists(`${fr}/tasks/ready/e1.md`));
r = file('a1', '---\nneeds: repo\n---\n');
code('a used id is refused', 2, r.code);
// caf\351: an e-acute in cp1252, one byte that is no UTF-8 sequence.
r = file('u1', Buffer.concat([Buffer.from('---\nneeds: repo\n---\ncaf'), Buffer.from([0xe9, 0x0a])]));
code('a cp1252 file is refused', 2, r.code);
check('as not UTF-8', 'not valid UTF-8', r.out);
r = file('q2', '---\ntask-id: q\nneeds: repo\n---\n');
check('a task-id: that disagrees is refused', "says 'q', not 'q2'", r.out);
r = file('n1', 'needs: repo\n');
check('a file with no frontmatter is refused', 'does not start with a --- frontmatter', r.out);
truthy('a refused filing leaves no temp file', !readdirSync(`${fr}/tasks`).some((f) => f.startsWith('.filing-')));
write(`${fr}/offered/05`, 'repo\n'); write(`${fr}/offered/06`, 'repo\n');
write(`${fr}/chips/05.model`, 'opus high plugin 0.0.1\n'); write(`${fr}/chips/sess-06`, '06');
r = fleet(['status', fr]);
const d = new Date();
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
check("status starts with the machine's clock", `== now ${today}`, r.out);
check('names a task three open tasks wait behind', 'a1: 3 open task(s) wait behind it, ready, unclaimed, WAITS ON THE OPERATOR', r.out);
check('and lists what the operator must do', 'a1: grant the role (3 behind it', r.out);
check('names a worker on another plugin version', 'OTHER PLUGIN: worker 05 runs makarasty 0.0.1', r.out);
check('and one that started and never ran whoami', 'never ran whoami', r.out);
check('an after: naming nothing is a wait for ever', 'd1: after: zz, which is neither filed nor done', r.out);
write(`${fr}/tasks/ready/h1.md`, '---\nneeds: repo\n---\nbody\noperator: not in the frontmatter\n');
write(`${fr}/tasks/ready/h2.md`, '---\nneeds: opus\n---\n');
r = fleet(['status', fr]);
absent('an operator: line in the body is prose', 'h1: not in', r.out);
check('a hand-written task with a model for a lane is named', 'h2: needs: "opus" is not pane, repo or verify', r.out);
rm(`${fr}/tasks/ready/h1.md`, `${fr}/tasks/ready/h2.md`);
r = fleet(['next', fr, '09', 'repo']);
code('next holds a task the operator owes and the tasks after it', 7, r.code);
r = fleet(['cleared', fr, 'a1']);
check('cleared says so', 'CLEARED a1', r.out);
truthy('and removes the line', !/^operator:/m.test(read(`${fr}/tasks/ready/a1.md`)), read(`${fr}/tasks/ready/a1.md`));
r = fleet(['next', fr, '09', 'repo']);
check('then next hands it out', 'a1', r.out);
truthy('cleared leaves a mark the wake loop sees', exists(`${fr}/tasks/cleared/a1`));
r = file('bom1', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('---\nneeds: repo\n---\n')]));
check('a byte order mark is dropped, not refused', 'FILED bom1', r.out);
const bomHead = exists(`${fr}/tasks/ready/bom1.md`) ? readFileSync(`${fr}/tasks/ready/bom1.md`).subarray(0, 8) : Buffer.alloc(0);
truthy('and the filed task starts with its frontmatter', bomHead.subarray(0, 3).toString('latin1') === '---', [...bomHead].join(' '));
write(`${fr}/offered/08`, 'repo\n'); write(`${fr}/chips/sess-08`, '08'); write(`${fr}/chips/08.model`, 'opus high plugin 0.0.1\n');
r = fleet(['ctx', fr]);
check('the watch names a worker on an older plugin, for the one relaunch ask', 'WORKER PLUGIN 08 runs makarasty 0.0.1', r.out);
r = fleet(['ctx', fr]);
absent('once', 'WORKER PLUGIN 08', r.out);
write(`${fr}/chips/06.model`, 'opus high\n');
r = fleet(['status', fr]);
check('a 1.5.8 or 1.5.9 record, with no version, is named older', 'OTHER PLUGIN: worker 06 runs makarasty 1.5.8 or 1.5.9', r.out);
fleet(['whoami', fr, '07', 'm', 'x'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-v' } });
const version = /"version": "([^"]*)"/.exec(read(`${ROOT}/.claude-plugin/plugin.json`))?.[1] ?? '';
check('whoami records the plugin version', `plugin ${version}`, read(`${fr}/chips/07.model`));

// Model and effort wishes: chips records them, whoami stops a worker on the wrong one until the switch.
fleet(['chips', fr, '11-12', 'repo', '--model', 'claude-opus-5-5', '--effort', 'high']);
check('chips takes the model a worker should run on', 'claude-opus-5-5 high', read(`${fr}/want/11`));
r = fleet(['chips', fr, '13', 'repo', '--effort', 'high']);
code('an effort with no model is refused', 2, r.code);
r = fleet(['chips', fr, '13', 'repo', '--model', 'claude-x', '--effort', 'huge']);
code('an effort that is not a level is refused', 2, r.code);
r = fleet(['chips', fr, '13', 'repo', '--model', 'opus']);
code('a tier alias is refused, since no worker reports one', 2, r.code);
r = fleet(['chips', fr, '13', 'repo', '--model']);
code('an empty --model is refused', 2, r.code);
const s11 = { env: { CLAUDE_CODE_SESSION_ID: 'sess-11' } };
r = fleet(['whoami', fr, '11', 'claude-sonnet-5-5', 'high'], s11);
code('whoami on the wrong model ends the turn', 10, r.code);
check('and says what to wait for', 'waiting for the coordinator to switch my model', r.out);
r = fleet(['next', fr, '11', 'repo'], s11);
code('next claims nothing while a switch is pending', 10, r.code);
r = fleet(['ctx', fr]);
check('the watch tells the coordinator which worker to switch', 'WORKER MODEL 11: runs claude-sonnet-5-5 at high, wants claude-opus-5-5 at high', r.out);
check('with the one call it needs', 'set_session_model claude-opus-5-5, then', r.out);
r = fleet(['ctx', fr]);
absent('once', 'WORKER MODEL 11', r.out);
check('status shows the worker waiting', 'WAITS FOR A MODEL SWITCH', fleet(['status', fr]).out);
r = fleet(['whoami', fr, '11', 'claude-sonnet-5-5', 'high'], s11);
code('a wake that was not the switch keeps the worker waiting', 10, r.code);
check('the watch line tells the worker it was switched', 'with switched as its last argument', fleet(['ctx', fr]).out);
r = fleet(['whoami', fr, '11', 'claude-sonnet-5-5', 'high', 'switched'], s11);
code('the same mismatch after the switch goes on rather than loops', 0, r.code);
check('and says the switch did not take', 'SWITCH DID NOT TAKE', r.out);
check('the coordinator is told once', 'WORKER MODEL 11 DID NOT TAKE', fleet(['ctx', fr]).out);
check('and status keeps it', 'SWITCH DID NOT TAKE', fleet(['status', fr]).out);
r = fleet(['whoami', fr, '11', 'claude-opus-5-5[1m]', 'unknown'], s11);
code('after the switch whoami passes, an unreadable effort included', 0, r.code);
truthy('and the wait is cleared', !exists(`${fr}/chips/11.switch`) && !exists(`${fr}/chips/11.switch-failed`));
r = fleet(['whoami', fr, '12', 'claude-opus-5-5', 'medium'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-12' } });
code('a known effort below the wish also stops', 10, r.code);
check('and only the effort is asked for', 'set_session_effort high, then', fleet(['ctx', fr]).out);
fleet(['chips', fr, '12', 'repo']);
truthy('a re-offer with no --model keeps the wish', exists(`${fr}/want/12`));
r = fleet(['chips', fr, '13', 'repo', '--model', 'claude-opus-5-5', '--effort', 'any']);
code('--effort any is accepted, as status prints it', 0, r.code);
fleet(['chips', fr, '12', 'repo', '--model', 'none']);
truthy('and --model none drops it', !exists(`${fr}/want/12`));
write(`${fr}/want/14`, 'claude-opus-5-5\r\n');
r = fleet(['whoami', fr, '14', 'claude-opus-5-5', 'high'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-14' } });
code('a CRLF want file with one field matches', 0, r.code);

// The wake loop a paused worker gets names its chat's session record, so it ends when that chat does.
const wg = t.tmp('fleet-wg');
mk(`${wg}/cfg/sessions`, `${wg}/run/tasks/ready`);
write(`${wg}/cfg/sessions/1.json`, '{"pid":1,"sessionId":"sid-wg"}');
fleet(['chips', `${wg}/run`, '01', 'repo']);
fleet(['pause', `${wg}/run`, 't'], { env: { CLAUDE_CONFIG_DIR: `${wg}/cfg` } });
const wl = fleet(['paused', `${wg}/run`, '01', 'x'], { env: { CLAUDE_CONFIG_DIR: `${wg}/cfg`, CLAUDE_CODE_SESSION_ID: 'sid-wg' } })
  .out.split('\n').filter((l) => l.includes('until')).join('\n');
check("the wake loop ends when its chat's session record is gone", 'sessions/1.json', wl);
const okHook = node(['--input-type=module', '-e', "import {allowedWhilePaused} from './hooks/run-dir.mjs'; console.log(allowedWhilePaused(process.argv[1]))", wl], { cwd: ROOT });
check('and the pause hook lets that loop run', 'true', okHook.out);
fleet(['resume', `${wg}/run`], { env: { CLAUDE_CONFIG_DIR: `${wg}/cfg` } });
rm(wg);

// retire: the replacement chip, offered once, even when a kill cut the first retire short.
const rt = t.tmp('fleet-rt');
mk(`${rt}/tasks/ready`);
write(`${rt}/tasks/ready/u1.md`, '---\nneeds: repo\n---\n'); write(`${rt}/tasks/ready/u2.md`, '---\nneeds: repo\n---\n');
const sr1 = { env: { CLAUDE_CODE_SESSION_ID: 'sr1' } };
fleet(['chips', rt, '01-02', 'repo', '--model', 'claude-opus-5-5', '--effort', 'high']);
fleet(['whoami', rt, '01', 'claude-opus-5-5', 'high'], sr1);
fleet(['next', rt, '01', 'repo'], sr1);
r = fleet(['retire', rt, '01']);
check('retire offers the replacement in the same lane', 'CHIP 03', r.out);
check('with its model wish', 'claude-opus-5-5 high', read(`${rt}/want/03`));
r = fleet(['retire', rt, '01']);
absent('a second retire offers nothing again', 'CHIP ', r.out);
rm(`${rt}/01.retiring`); // as a retire killed between making the chip and marking the worker leaves it
r = fleet(['retire', rt, '01']);
check('a retire run again after a kill finishes with the same chip', 'CHIP 03', r.out);
truthy('and offers no second number', !exists(`${rt}/offered/04`), 'offered/04');
r = fleet(['next', rt, '01', 'repo'], sr1);
code('a retiring worker holding a task finishes it first', 2, r.code);
fleet(['finish', rt, '01', 'u1'], sr1);
r = fleet(['next', rt, '01', 'repo'], sr1);
code('then leaves at its next claim', 9, r.code);
check('told to close what it started', 'tabs_close every tab', r.out);
check('and recorded with its replacement', 'replaced by 03', read(`${rt}/01.retired`));
r = fleet(['relaunch', rt, '--keep-coordinator', '--wait', '0', '01']);
absent('a first relaunch of a chip retire replaced is not taken for a rerun', 'already relaunched', r.out);
fleet(['resume', rt]);
write(`${rt}/chips/02.model`, 'm high plugin 1.5.13\n');
r = fleet(['retire', rt, '02']);
code('a worker on an older plugin is left to the relaunch ask', 2, r.code);
r = fleet(['chips', rt, '09', 'repo', '--model', 'claude-opus-5-5', '--effort', 'max']);
code('effort max is refused for workers', 2, r.code);
rm(rt);
write(`${fr}/brief-15.md`, '---\nbrief\n---\n');
r = fleet(['next', fr, '15', 'repo']);
code('a brief worker is sent back to its brief by next', 2, r.code);
rm(`${fr}/brief-15.md`);
write(`${fr}/FINISHED`, 'finished x\n');
r = fleet(['next', fr, '16', 'repo']);
code('a landed run hands out nothing', 9, r.code);
rm(`${fr}/FINISHED`);

// stranded: done task branches against the integration tree, merged or not, and commits made after.
const g = `${fr}/repo`;
const gc = (...a: string[]) => git(g, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a);
exec('git', ['init', '-q', '-b', 'int', g]); gc('commit', '-q', '--allow-empty', '-m', 'root');
git(g, 'switch', '-q', '-c', 'b1'); gc('commit', '-q', '--allow-empty', '-m', 'w1');
git(g, 'switch', '-q', 'int'); gc('merge', '-q', '--no-ff', '--no-edit', 'b1');
git(g, 'switch', '-q', 'b1'); gc('commit', '-q', '--allow-empty', '-m', 'late');
git(g, 'switch', '-q', '-c', 'b2', 'int'); gc('commit', '-q', '--allow-empty', '-m', 'w2');
git(g, 'switch', '-q', '-c', 'b3', 'int'); git(g, 'switch', '-q', 'int'); gc('merge', '-q', '--no-ff', 'b2', '-m', 'm2');
write(`${fr}/worktrees/integration`, `path ${g}\n`);
write(`${fr}/tasks/done/t1`, 'branch b1\n'); write(`${fr}/tasks/done/t2`, 'branch b2\n');
git(g, 'switch', '-q', '-c', 'b4', 'int'); gc('commit', '-q', '--allow-empty', '-m', 'w4'); git(g, 'switch', '-q', 'int');
write(`${fr}/tasks/done/t4`, 'branch b4\n');
git(g, 'switch', '-q', '-c', 'b5', 'int'); gc('commit', '-q', '--allow-empty', '-m', 'w5');
write(`${fr}/tasks/done/t5`, `branch b5\ntip ${git(g, 'rev-parse', 'b5').out}\n`);
git(g, 'switch', '-q', 'int'); gc('merge', '-q', '--no-ff', 'b5', '-m', 'squashed-looking message');
git(g, 'switch', '-q', 'b5'); gc('commit', '-q', '--allow-empty', '-m', 'late5'); git(g, 'switch', '-q', 'int');
git(g, 'branch', '-q', 'gone6', 'int'); write(`${fr}/tasks/done/t6`, 'branch gone6\n'); git(g, 'branch', '-q', '-D', 'gone6');
git(g, 'branch', '-q', 'rm/t7', 'b4'); write(`${fr}/tasks/done/t7`, '');
r = fleet(['stranded', fr]);
check('stranded names a commit made after the merge', 'STRANDED t1: branch b1 was merged, then got 1 more', r.out);
check('and a branch never merged as not merged', 'not merged t4: branch b4, 1 commit(s)', r.out);
absent('and stays quiet about a branch fully merged', 't2', r.out);
check('the tip finish recorded proves a merge whatever the merge message says', 'STRANDED t5: branch b5 was merged, then got 1 more', r.out);
check('a deleted branch is counted, not listed', '1 done task branch(es) no longer exist', r.out);
check('a marker with no branch line is matched by its task id', 'not merged t7: branch rm/t7', r.out);

// landed and chips keep the session records the context hook reads, per run.
const lr = t.tmp('fleet-lr');
const sessDir = `${lr}/cfg/makarasty/fleet-sessions`;
mk(`${lr}/run/tasks/ready`, sessDir);
write(`${lr}/run/backlog.jsonl`, '');
write(`${sessDir}/sx`, `${shPwd(`${lr}/run`)}\n`);
write(`${sessDir}/sy`, '/some/other/run\n');
r = fleet(['landed', `${lr}/run`, '0'], { env: { CLAUDE_CONFIG_DIR: `${lr}/cfg` } });
truthy("landed removes this run's session records and no other run's", !exists(`${sessDir}/sx`) && exists(`${sessDir}/sy`), r.out);
fleet(['chips', `${lr}/run`, '01', 'repo'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-c', CLAUDE_CONFIG_DIR: `${lr}/cfg` } });
truthy('chips records the coordinator for the context hook', read(`${sessDir}/sess-c`) !== '', readdirSync(sessDir).join('\n'));
rm(lr);
r = file('none1', '---\nneeds: repo\noperator: None\n---\n');
absent('operator: None owes nothing', 'waits on the operator', r.out);
r = file('open1', '---\nneeds: repo\nno closing line\n');
check('a frontmatter with no closing --- is refused', 'no closing --- line', r.out);
r = file('case1', '---\nneeds: Repo\n---\n');
check('a lane in the wrong case is named as read', "reads 'Repo'", r.out);

// The leftovers census, fed a process list through FLEET_PROCS_JSON.
interface Proc { Name: string; ProcessId: number; ParentProcessId: number; WorkingSetSize: number; CommandLine: string; Cpu: number; Created: number }
const procs = (name: string, list: Proc[]): string => { const p = `${fr}/${name}`; write(p, JSON.stringify(list)); return p; };
const leftovers = (procsFile: string, env: Record<string, string> = {}) =>
  node([`${SCRIPTS}/fleet-load.mjs`, '--leftovers'], { env: { FLEET_PROCS_JSON: procsFile, ...env } });
const p = (ProcessId: number, ParentProcessId: number, Name: string, CommandLine: string, Created: number, WorkingSetSize = 1): Proc =>
  ({ Name, ProcessId, ParentProcessId, WorkingSetSize, CommandLine, Cpu: 5, Created });
const snap = (stamp: number | string, rest: string) => `bash -c "source /c/Users/u/.claude/shell-snapshots/snapshot-bash-${stamp}${rest}"`;

let n = Date.now();
r = leftovers(procs('procs.json', [
  p(100, 200, 'node.exe', 'node C:/x/node_modules/vitest/vitest.mjs run', n - 600000, 104857600),
  p(200, 100, 'node.exe', 'node C:/x/node_modules/vitest/dist/worker.js', n - 500000, 52428800),
  p(300, 999, 'node.exe', 'node C:/x/node_modules/vite/bin/vite.js', n - 600000, 52428800),
  p(400, 401, 'node.exe', 'node C:/x/node_modules/vitest/vitest.mjs run', n - 600000, 52428800),
  p(401, 1, 'bash.exe', 'bash', n - 700000)]));
check("leftovers names an orphaned test run, its reused-pid child counted once", 'ORPHANED RUN  pid 100  toolchain: tests  150 MB', r.out);
check('and lists an orphaned dev server without offering to kill it', 'pid 300  toolchain: vite', r.out);
absent('and never lists a run whose parent is alive', 'pid 400', r.out);

const cs = t.tmp('fleet-cs');
write(`${cs}/sessions/600.json`, '{"pid":600,"sessionId":"aaaaaaaa-1111-2222-3333-444444444444"}');
write(`${cs}/sessions/601.json`, '{"pid":601,"sessionId":"bbbbbbbb-1111-2222-3333-444444444444"}');
const census = { FLEET_LISTEN_PIDS: '', CLAUDE_CONFIG_DIR: cs };
n = Date.now();
r = leftovers(procs('procs2.json', [
  p(600, 1, 'claude.exe', 'claude', n - 9000000),
  p(500, 999, 'bash.exe', snap(1, '.sh; cd .fleet/run-x"'), n - 1800000, 1048576),
  p(501, 500, 'python.exe', 'python poll.py', n - 1700000, 2097152),
  p(510, 998, 'sh.exe', 'sh C:/Users/u/AppData/Local/Temp/claude/proj/aaaaaaaa-1111-2222-3333-444444444444/tasks/watch.sh', n - 1800000),
  p(520, 997, 'bash.exe', snap(2, '.sh"'), n - 120000)]), census);
check('leftovers names the shell a closed chat left, with what runs under it', 'CLOSED CHAT  pid 500  shell whose chat process ended: python', r.out);
absent("and never a live chat's script whose parent link Git Bash broke", 'pid 510', r.out);
absent('and not one younger than ten minutes', 'pid 520', r.out);
n = Date.now();
const f3 = procs('procs3.json', [
  p(600, 1, 'claude.exe', 'claude', n - 9000000),
  p(530, 996, 'bash.exe', snap(n - 8993000, '-abcdef.sh; npm run dev &"'), n - 1800000)]);
write(`${cs}/sessions/600.json`, `{"pid":600,"sessionId":"aaaaaaaa-1111-2222-3333-444444444444","startedAt":${Date.now() - 9000000}}`);
r = leftovers(f3, census);
code("leftovers reads a live chat's snapshot without failing", 0, r.code);
absent("a live chat's own detached shell is never a leftover", 'pid 530', r.out);
n = Date.now();
r = leftovers(procs('procs4.json', [
  p(540, 995, 'bash.exe', snap('1700000000001', '-bb.sh; y"'), n - 1800000),
  p(541, 540, 'python.exe', 'python -m http.server 5199', n - 1700000)]), census);
check("a closed chat's tree that serves something is left for the operator", 'CLOSED CHAT SERVING, left alone', r.out);
n = Date.now();
r = leftovers(procs('procs5.json', [
  p(550, 994, 'bash.exe', snap('1700000000002', '-cc.sh; z"'), n - 1800000),
  p(551, 550, 'node.exe', 'node server.js', n - 1700000)]), { ...census, FLEET_LISTEN_PIDS: '551' });
check('and so is one holding a listening socket, whatever its command line', 'CLOSED CHAT SERVING, left alone', r.out);
n = Date.now();
let st = n - 9000000;
r = leftovers(procs('procs6.json', [
  p(600, 1, 'claude.exe', 'claude', st),
  p(560, 600, 'bash.exe', snap(st + 7000, '-live01.sh; w"'), n - 60000),
  p(561, 993, 'bash.exe', snap(st + 9000, '-gone01.sh; w"'), n - 1800000)]), census);
check("after a restart, an ended chat's shell is found even when a live chat started in the same minute", 'CLOSED CHAT  pid 561', r.out);
n = Date.now(); st = n - 9000000;
r = leftovers(procs('procs7.json', [
  p(600, 1, 'claude.exe', 'claude', st),
  p(570, 992, 'bash.exe', snap(st + 3600000, '-late01.sh; npm run build &"'), n - 1800000)]), census);
absent("a live idle chat's shell from a first Bash call an hour in is still its own", 'pid 570', r.out);
n = Date.now(); st = n - 9000000;
r = leftovers(procs('procs8.json', [
  p(600, 1, 'claude.exe', 'claude', st),
  p(580, 600, 'bash.exe', snap(st - 3500000, '-old01.sh; w"'), st - 3600000),
  p(581, 991, 'bash.exe', snap(st + 60000, '-new01.sh; npm run build &"'), n - 1800000)]), census);
absent("a reused pid does not make a live chat's shell look ended", 'pid 581', r.out);
// In jest -w is --maxWorkers: a one-shot suite, counted as tests; in vitest it is watch.
const w = (pid: number, cmd: string): Proc => ({ Name: 'node.exe', ProcessId: pid, ParentProcessId: 9999, WorkingSetSize: 9, CommandLine: cmd, Cpu: 5, Created: 1 });
r = leftovers(procs('procs9.json', [
  w(590, 'node node_modules/jest/bin/jest.js -w 2'),
  w(591, 'node node_modules/vitest/vitest.mjs -w'),
  w(592, 'node node_modules/jest/bin/jest.js -w 2 --config /r/tsc/jest.config.js'),
  w(593, '"C:\\Program Files\\nodejs\\node.exe" C:/work/jest/node_modules/vitest/vitest.mjs -w'),
  w(594, 'node --require C:/x/hook.cjs C:/x/npm/bin/npx-cli.js tsc -w'),
  w(595, 'node C:/x/pnpm/bin/pnpm.cjs exec vitest -w'),
  w(596, 'node --env-file .env C:/x/node_modules/typescript/lib/tsc.js -w'),
  w(597, 'node C:/x/pnpm/bin/pnpm.cjs -w exec vitest run'),
  w(598, 'node C:/x/pnpm/bin/pnpm.cjs --filter app exec tsc -w'),
  w(599, 'node C:/x/pnpm/bin/pnpm.cjs --dir C:/work/tsc exec jest -w 2'),
  w(589, 'node C:/x/yarn/bin/yarn.js workspace app tsc -w'),
  w(588, 'node C:/x/npm/bin/npm-cli.js -w app --loglevel silent exec -- tsc -w'),
  w(587, 'node C:/p/.yarn/releases/yarn-4.5.0.cjs run vitest -w'),
  w(586, 'node C:/u/pnpm.cjs --filter jest exec tsc -w'),
  w(585, 'node C:/u/npm-cli.js exec --package typescript -- tsc -w'),
  w(584, 'node C:/u/npx-cli.js vitest run --dir C:/work/tsc')]), census);
check('jest -w 2 is a test run, not a watcher', 'pid 590  toolchain: tests', r.out);
check('vitest -w is a watcher', 'pid 591  toolchain: resident', r.out);
check('jest -w with a tsc folder in its line is a test run', 'pid 592  toolchain: tests', r.out);
check('vitest -w inside a folder named jest is still a watcher', 'pid 593  toolchain: resident', r.out);
check('npx tsc -w behind a --require is a watcher', 'pid 594  toolchain: resident', r.out);
check('pnpm exec vitest -w is a watcher', 'pid 595  toolchain: resident', r.out);
check("tsc -w behind node's --env-file is a watcher", 'pid 596  toolchain: resident', r.out);
check("pnpm's own -w is not vitest's", 'pid 597  toolchain: tests', r.out);
check('a runner flag with a value does not hide tsc -w', 'pid 598  toolchain: resident', r.out);
check('nor does its value name the program', 'pid 599  toolchain: tests', r.out);
check('yarn workspace <name> tsc -w is a watcher', 'pid 589  toolchain: resident', r.out);
check('npm flags with values do not hide tsc -w', 'pid 588  toolchain: resident', r.out);
check("yarn's own release file is a runner too", 'pid 587  toolchain: resident', r.out);
check("a runner flag's value is not the program", 'pid 586  toolchain: resident', r.out);
check('nor one after its subcommand', 'pid 585  toolchain: resident', r.out);
check('npx vitest run is a test run', 'pid 584  toolchain: tests', r.out);
rm(cs, fr);

fleet(['find', bw, 'integration'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-coord' } });
truthy("the coordinator's integration tree is never registered as a worker", !exists(`${bw}/chips/sess-coord`), read(`${bw}/chips/sess-coord`));
rm(bw);

// The watch loop lives in fleet-wait.md, where nothing else parses it: a stray quote there once broke it.
const wlFile = `${t.base}/fleet-watch.sh`;
const loop = watchLoop();
write(wlFile, loop);
code("fleet-wait's watch loop parses", 0, loop.length > 0 ? sh(`sh -n "${wlFile}"`).code : 1);

