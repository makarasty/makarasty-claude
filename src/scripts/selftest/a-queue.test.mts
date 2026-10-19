// a-queue.test.mts - the queue and its lanes, the schema gate, the clocks, finishing, questions and answers,
// sizing, abandoned claims, waves and a cold start: lines 1-535 of the old fleet-selftest.sh.
//
// A fleet is expensive to test the honest way: fourteen chats, a live application, two hours. So the parts
// that are mechanical - the claim, the lane filter, the schema gate, the clocks, the completion markers -
// are tested here instead. What remains untested is judgement and the browser, which is the correct
// division: a script cannot check whether a finding was worth filing, and it can check that an invalid one
// was refused.

import { readFileSync } from 'node:fs';
import {
  setup, fleet, fleetAsync, exec, sh, task, check, absent, code, truthy, skip,
  write, read, exists, mk, rm, touch, OLD, sleep, copyFleet, shPwd, FLEET_SH, MULT, POLL,
} from './lib.mts';

const t = setup('a-queue');
const run = t.run;
// fleet.sh's `find` and friends read a finding from stdin, as `printf '%s' "$json" | sh "$fleet" find`.
const find = (dir: string, chip: string, json: string) => fleet(['find', dir, chip], { input: json });
// The clock is a shell loop printed for the worker to background; run it here at zero sleep, as the sh
// version's `eval "$(... | sed "s/sleep $poll/sleep 0/")"` did (sed replaces the first match per line).
const runClock = (text: string): string =>
  sh(text.split('\n').map((l) => l.replace(`sleep ${POLL}`, 'sleep 0')).join('\n')).out;

// ---- the queue and its lanes ------------------------------------------------------------------------------

task(run, 'task-01', 'pane', 20);
task(run, 'task-02', 'repo', 15);
task(run, 'task-03', 'repo', 10);

let r = fleet(['next', run, '07', 'repo'], { stdoutOnly: true });
code('a repo worker claims something', 0, r.code);
check('and it is not the pane task', 'CLAIMED task-02', r.out);
check('the claim prints its lane', 'LANE repo', r.out);
check('and its abort deadline in seconds', `ABORT_AFTER_SEC ${15 * MULT * 60}`, r.out);

r = fleet(['next', run, '08', 'pane'], { stdoutOnly: true });
check('a pane worker gets the pane task the repo worker skipped', 'CLAIMED task-01', r.out);

// Two claimers, one task, at the same time: exactly one may win. This is the property the whole queue
// rests on, and mkdir is the only reason it holds.
const both = await Promise.all([fleetAsync(['next', run, '20', 'repo']), fleetAsync(['next', run, '21', 'repo'])]);
const won = both.filter((o) => o.out.includes('CLAIMED task-03')).length;
truthy('two concurrent claimers, exactly one wins task-03', won === 1, `${won} won`);

const winner = /^chip (.*)$/m.exec(read(`${run}/tasks/claimed/task-03/owner`))?.[1] || '20'; // `${winner:-20}`: an empty match falls back too
fleet(['finish', run, winner, 'task-03']);
truthy('the winner can close the task it won', exists(`${run}/tasks/done/task-03`));

r = fleet(['next', run, '09', 'repo']);
code('an empty lane reports drained rather than handing out foreign work', 3, r.code);

// The verify lane is one worker wide and no chip is ever told to ask for it - a chip prompt carries `pane`
// or `repo` - so a `needs: verify` task was claimable by nobody and `landed` refused the run over it.
const vrun = t.tmp('fleet-verify');
mk(`${vrun}/tasks/ready`, `${vrun}/tasks/done`);
for (const n of [1, 2]) {
  write(`${vrun}/tasks/ready/task-0${n}-suite.md`,
    `---\ntask-id: task-0${n}-suite\nneeds: verify\nbudget: 10\n---\n## Steps\n1. Run the whole suite, which this machine has room for once.\n`);
}
r = fleet(['next', vrun, '41', 'repo'], { stdoutOnly: true });
code('a repo worker may take a verify task, because nobody else can', 0, r.code);
check('and is told it now holds the only verify lane there is', 'VERIFY LANE', r.out);
r = fleet(['next', vrun, '42', 'repo']);
code('a second worker is told to wait while that lane is held, not that the queue is empty', 7, r.code);
// A worker that names no lane used to skip the width check entirely and take the second suite.
r = fleet(['next', vrun, '44']);
code('a worker that named no lane is held by the verify lane too', 7, r.code);
absent('and is not handed a second verify task', 'CLAIMED', r.out);
fleet(['finish', vrun, '41', 'task-01-suite']);
r = fleet(['next', vrun, '42', 'repo'], { stdoutOnly: true });
check('and gets the next verify task once it lands', 'CLAIMED task-02-suite', r.out);
r = fleet(['next', vrun, '43', 'pane']);
code("a pane worker never takes one: it is the machine's lane, not the browser's", 3, r.code);

truthy('the run carries the layout version it was written under', exists(`${run}/RUN_FORMAT`));
const fmt = read(`${run}/RUN_FORMAT`);
write(`${run}/RUN_FORMAT`, '99\n');
r = fleet(['status', run]);
code('a run from a newer format is refused rather than misread', 2, r.code);
check('and it says which format it found', 'format 99', r.out);
write(`${run}/RUN_FORMAT`, fmt);

// ---- the schema gate --------------------------------------------------------------------------------------

const good = '{"area":"lists","severity":"major","observed":"the Completed tab counts 12 and lists 7","evidence":"cases.page.vue:184 slices before counting","mechanism_status":"hypothesis"}';
r = find(run, '07', good);
code('a finding with evidence is accepted', 0, r.code);
check('and the file says how many it now holds', 'FILED 1 lines', r.out);

r = find(run, '07', '{"area":"a","severity":"major","observed":"x","mechanism_status":"unknown"}');
code('a finding with no evidence is refused', 1, r.code);
check('and says which field was missing', 'missing evidence', r.out);

r = find(run, '07', '{"area":"a","severity":"catastrophic","observed":"x","evidence":"file.ts:1 something","mechanism_status":"unknown"}');
code('an invented severity is refused', 1, r.code);

r = find(run, '07', '{"area":"a","severity":"minor","what":"x","evidence":"file.ts:1 something","mechanism_status":"unknown"}');
check('the retired field name is refused by name', 'retired field', r.out);

r = find(run, '07', '{"area":"a","severity":"minor","observed":"overlap","evidence":"two rects that do not touch","mechanism_status":"unknown","conditions":"1440px, zoom 100","rects":{"a":{"x":0,"y":0,"w":10,"h":10},"b":{"x":50,"y":50,"w":10,"h":10}}}');
check('a visual claim whose rectangles miss each other is refused', 'do not intersect', r.out);

r = find(run, '07', '{"unreached":"steps 7-9","reason":"budget exceeded"}');
code('an unreached line is a legitimate line', 0, r.code);

// An auxiliary line records what this worker did to the environment, and it used to be the way past every
// check above: one extra key turned the gate off for the whole object.
r = find(run, '07', '{"created":"note","severity":"blocker","area":"","observed":"","evidence":"","what":"x"}');
code('an auxiliary key does not turn the gate off for the rest of the object', 1, r.code);
check('and a severity on an auxiliary line is refused by name', 'auxiliary line carries no severity', r.out);
r = find(run, '07', '{"created":"user Ada Test, group QA-2"}');
code('a created line with nowhere to look for the row is refused', 1, r.code);
r = find(run, '07', '{"state_changed":"active role a -> p"}');
check('and a state change with no window is refused, because every later sighting was measured inside it', 'state_changed needs when', r.out);
r = find(run, '07', '{"created":"user Ada Test, group QA-2","where":"sandbox company 41"}');
code('an auxiliary line in its own shape is filed', 0, r.code);

// A chip's file existing at all is the difference between "filed nothing" and "never filed", and the
// append used to create it before node had read a byte.
r = find(run, '88', '{"area":"a"}');
code("a chip whose first finding is refused files nothing", 1, r.code);
truthy('and leaves no empty file to be read later as a chip that found nothing', !exists(`${run}/88.jsonl`), '88.jsonl exists');

// ---- clocks that disarm themselves ------------------------------------------------------------------------

r = fleet(['clock', run, '07', 'task-02', '20']);
const clock = r.out;
code('a clock is printed for the worker to background', 0, r.code);
check('it watches for its own task closing', 'tasks/done/task-02', clock);
check('and for its worker finishing', '07.done', clock);
check('and for its worker going blind, which is as finished as done', '07.blocked', clock);
check('and it speaks only if the budget really elapsed', 'echo budget-elapsed-task-02', clock);
// The paths are read from a shell standing somewhere else - a worktree, where `.fleet/` is gitignored and
// so does not exist at all - which is where every one of these is backgrounded from.
// Through `sh`, because that is the interpreter fleet.sh itself is run under: `pwd -W` is a Git Bash
// extension, so node's own spelling would compare the run directory in two different spellings.
const absrun = shPwd(run);
check('and every path in it is absolute, so a worker in a worktree can meet its exit conditions', `${absrun}/tasks/done/task-02`, clock);
check('one landed run ends it wherever it is armed', `[ -e "${absrun}/FINISHED" ] && exit 0; i=0`, clock);
const rounds = /-lt ([0-9]+)/.exec(clock)?.[1] ?? '';
const wantRounds = Math.trunc(20 * MULT * 60 / POLL);
truthy('a 20 minute budget at the configured multiplier and poll interval', rounds === String(wantRounds), `${rounds} rounds, wanted ${wantRounds}`);
// The clock exits on the marker rather than on being stopped, so close the task first and let it run its
// whole budget at zero sleep: a clock that still speaks here is one that would wake a finished worker.
fleet(['finish', run, '07', 'task-02']);
absent('a closed task silences its clock', 'budget-elapsed', runClock(clock));

// And the same clock still fires when the task really is open, or it would be a clock that never rings.
task(run, 'task-09', 'repo', 1);
fleet(['next', run, '07', 'repo']);
const clock9 = fleet(['clock', run, '07', 'task-09', '1']).out;
check("an open task's clock still rings at twice its budget", 'budget-elapsed-task-09', runClock(clock9));
// And the same open task's clock stops the moment the run declares itself finished, which is the only way
// to reach a clock armed hours ago in a chat nobody is sitting in.
write(`${run}/FINISHED`, '');
absent('a landed run silences every clock still armed', 'budget-elapsed', runClock(clock9));
rm(`${run}/FINISHED`);
fleet(['finish', run, '07', 'task-09']);

// A project path with a space in it used to arm the clock on a different directory entirely.
const spacey = t.tmp('fleet space x');
write(`${spacey}/tasks/ready/task-09.md`, readFileSync(`${run}/tasks/ready/task-09.md`));
r = fleet(['next', spacey, '07', 'repo']);
check('the clock a run whose path has a space arms names that path in quotes', `clock "${shPwd(spacey)}" 07`, r.out);

r = fleet(['finish', run, '99', 'task-01']);
code("a worker cannot close somebody else's claim", 4, r.code);
check('and is told why', 'CLAIM LOST', r.out);

// ---- finishing, and the difference between empty and over -------------------------------------------------

write(`${run}/tasks/queue-open`, '');
r = fleet(['drained', run, '07']);
code('an empty queue the planner has not closed does not finish a worker', 5, r.code);
check('and it is told to poll instead', 'Poll again', r.out);
check('with a poll that stops itself when the run lands, like every other loop this prints', '/FINISHED" ] && { echo run-finished', r.out);
truthy('no done marker while the queue is open', !exists(`${run}/07.done`), '07.done exists');

rm(`${run}/tasks/queue-open`);
r = fleet(['drained', run, '07']);
truthy('closing the queue lets the worker finish', exists(`${run}/07.done`));
check('and finishing prints the end banner itself', 'WORKER 07 FINISHED', r.out);
check('and the exact session title to set', 'RENAME THIS SESSION TO: fleet', r.out);

r = fleet(['summary', run, '07']);
check('the worker banner names the worker', 'WORKER 07 FINISHED', r.out);
check('and counts the majors it filed', 'major 1', r.out);
check('and counts what it never reached', 'unreached 1', r.out);

// ---- questions and answers --------------------------------------------------------------------------------

fleet(['ask', run, '05'], { input: 'the gate refuses every commit\n' });
fleet(['ask', run, '06'], { input: 'the gate refuses every commit, again\n' });
r = fleet(['status', run]);
check('an unanswered question is listed', '05-1.md', r.out);

fleet(['answer', run, '05-1', '06-1'], { input: 'Fixed on the shared branch at 16:56. Rebase and use the gate normally.\n' });
r = fleet(['status', run]);
absent('one answer can close several questions at once', '05-1.md', r.out);
truthy('and it lands under every id it was addressed to', read(`${run}/answers/06-1.md`).length > 0);

r = fleet(['answer', run, '05-1'], { input: '' });
code('an empty answer is refused', 2, r.code);

fleet(['ask', run, '07'], { input: 'a question filed before the broadcast\n' });
sleep(1); // the flag compares mtimes, and both writes land in the same second otherwise
fleet(['broadcast', run], { input: 'the tool everybody is tripping over is fixed\n' });
r = fleet(['status', run]);
check('a question older than the broadcast is flagged rather than left silently open', 'broadcast landed after it', r.out);
// `date +%Y-%m-%d`: today in local time, as the broadcast stamps it.
const d = new Date();
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
check('each broadcast entry carries its time', `## ${today}`, read(`${run}/answers/00-broadcast.md`));
r = fleet(['broadcast', run], { input: 'workers 01-05 retire\n' });
check('and a retire order is warned about', 'read by every worker, later ones too', r.out);

// The heading used to be printed above nothing at all: its `|| echo none` hung off a pipeline whose exit
// status was sed's, and sed succeeds on empty input.
const bare = t.tmp('fleet-bare');
mk(`${bare}/tasks/ready`);
r = fleet(['status', bare]);
check('a run where no worker has finished says so under the markers heading', '  none', r.out);

// ---- sizing the repo lane ---------------------------------------------------------------------------------

r = fleet(['width', run]);
code('the width of the repo lane is computed, not retyped', 0, r.code);
check('and it answers with a number', 'REPO_WORKERS', r.out);
check('showing the queue term it came from', 'ready repo tasks', r.out);

// The constants are read once at startup by sed rather than by a node run per lookup, so this checks the
// reading itself: a copy of the script beside a calibration of our own, with a provenance sentence that
// must not become a constant. The copy beside the script wins over any installed one.
const calrun = t.tmp('fleet-cal');
mk(`${calrun}/run/tasks/ready`);
copyFleet(`${calrun}/scripts`);
const calFleet = (args: string[]) => exec('sh', [`${calrun}/scripts/fleet.sh`, ...args]);
write(`${calrun}/calibration.json`, '{\n  "budget_multiplier": 3,\n  "clock_poll_seconds": 7,\n  "_provenance": { "clock_poll_seconds": "a sentence carrying 99, which is not a constant" }\n}\n');
r = calFleet(['clock', `${calrun}/run`, '07', 'task-01', '20']);
check('a calibrated multiplier and poll interval are both read from the file', `-lt ${Math.trunc(20 * 3 * 60 / 7)}`, r.out);
check("and the poll is the file's, not the built-in default", 'sleep 7;', r.out);
// A decimal reached shell arithmetic after the claim was made: the claim stood and the task never printed.
write(`${calrun}/calibration.json`, '{\n  "budget_multiplier": 1.5,\n  "clock_poll_seconds": 0\n}\n');
write(`${calrun}/run/tasks/ready/task-01.md`, '---\ntask-id: task-01\nneeds: repo\nbudget: 5\n---\nBODY-OF-TASK\n');
r = calFleet(['next', `${calrun}/run`, '07', 'repo']);
code('a decimal multiplier in the calibration does not break a claim', 0, r.code);
check('which still prints its task', 'BODY-OF-TASK', r.out);
check('at the built-in multiplier', `ABORT_AFTER_SEC ${5 * 2 * 60}`, r.out);
check('and says which constant it could not use', 'budget_multiplier = 1.5 is not a whole number', r.out);
r = calFleet(['clock', `${calrun}/run`, '07', 'task-01', '5']);
code('and a zero poll interval does not divide by zero', 0, r.code);

// ---- abandoned claims -------------------------------------------------------------------------------------

write(`${run}/tasks/claimed/task-77/owner`, 'chip 99\nclaimed old\n');
task(run, 'task-77', 'repo', 1);
touch(`${run}/tasks/claimed/task-77/owner`, OLD);
r = fleet(['sweep', run]);
check('a claim nobody has advanced past its budget is named', 'ABANDONED? task-77', r.out);
check('and nothing is changed until asked', 'Nothing was changed', r.out);
truthy('the claim is still there after a listing sweep', exists(`${run}/tasks/claimed/task-77`));
fleet(['sweep', run, '--release']);
truthy('--release hands the task back', !exists(`${run}/tasks/claimed/task-77`), 'still claimed');
r = fleet(['status', run]);
absent('and status no longer lists it as a live claim', 'task-77.released', r.out);
r = fleet(['sweep', run]);
check('and a released claim is not swept twice', 'no abandoned claims', r.out);

// fleet.sh's commands run in node [M37]. Without it every command must refuse and say so, never guess: an
// empty mtime once made sweep call a dead fleet healthy. Build a PATH that still has the shell's own tools
// and nothing named node, inside sh (node's own lookup of sh would break on it); skip where none exists.
const nonode = sh('p=""; for d in /usr/bin /bin; do [ -x "$d/sed" ] && p="${p:+$p:}$d"; done; '
  + '[ -n "$p" ] && ! PATH="$p" command -v node >/dev/null 2>&1 && printf %s "$p"').out;
if (nonode) {
  r = sh(`PATH="${nonode}" sh "${FLEET_SH}" sweep "${run}" 2>&1`);
  code('with no node, sweep refuses rather than calling every claim fresh', 2, r.code);
  check('and says what it needs', 'needs Node.js', r.out);
  r = sh(`PATH="${nonode}" sh "${FLEET_SH}" next "${run}" 07 repo >/dev/null 2>&1`);
  code('and next refuses rather than handing out a task', 2, r.code);
} else {
  skip('with no node, sweep refuses rather than calling every claim fresh', 'every PATH on this host carries node, so the blind case cannot be built');
}
truthy('the released task leaves the queue with its claim', exists(`${run}/tasks/released/task-77.md`));
truthy('and cannot be handed straight back under the same id', !exists(`${run}/tasks/ready/task-77.md`), 'still in ready/');
r = fleet(['finish', run, '99', 'task-77']);
code('the worker whose claim was released cannot close the task', 4, r.code);
r = fleet(['landed', run, '2']);
check('and the run cannot land over it until somebody accounts for it', 'released and never accounted for', r.out);
rm(`${run}/tasks/released/task-77.md`);

// ---- a wave that has not landed yet -----------------------------------------------------------------------

// `after:` in a task's frontmatter holds it until the task it names is done. Built in its own directory,
// because the queue in run is already half claimed by the checks above.
const depsrun = t.tmp('fleet-deps');
mk(`${depsrun}/tasks/ready`, `${depsrun}/tasks/done`);
write(`${depsrun}/tasks/ready/task-01-primitives.md`,
  '---\ntask-id: task-01-primitives\nneeds: repo\nbudget: 20\n---\n## Steps\n1. Own the shared components for this wave.\n');
write(`${depsrun}/tasks/ready/task-02-screen.md`,
  '---\ntask-id: task-02-screen\nneeds: repo\nbudget: 20\nafter: task-01-primitives\n---\n## Steps\n1. Rework one screen, once the primitives have landed.\n');
r = fleet(['next', depsrun, '31', 'repo'], { stdoutOnly: true });
check("the first wave's task is claimable", 'CLAIMED task-01-primitives', r.out);
r = fleet(['next', depsrun, '32', 'repo']);
code('a task waiting on an unfinished dependency is not handed out, and the exit says waiting', 7, r.code);
check('and the worker is told to poll rather than that the queue is empty', 'QUEUE WAITING', r.out);
check('naming how many tasks are held', '1 task(s) held', r.out);
// A worker that took that answer for the end used to write `.done` here while its wave was still coming.
r = fleet(['drained', depsrun, '32']);
code('drained refuses while a ready task nobody holds is still waiting', 5, r.code);
check('and says why', 'QUEUE NOT EMPTY', r.out);
truthy('and writes no done marker', !exists(`${depsrun}/32.done`), '32.done exists');
r = fleet(['drained', depsrun, '32', 'repo']);
code('a worker in the lane that task needs is held open too', 5, r.code);
// The unheld task needs the repo lane, so a pane worker could never claim it and waiting would be for nothing.
r = fleet(['drained', depsrun, '33', 'pane']);
code('a worker in another lane is not held open by it', 0, r.code);
check('and drains', 'QUEUE DRAINED', r.out);
fleet(['finish', depsrun, '31', 'task-01-primitives']);
r = fleet(['next', depsrun, '32', 'repo'], { stdoutOnly: true });
code('once the dependency lands the task is claimable', 0, r.code);
check('and it is the task that was waiting', 'CLAIMED task-02-screen', r.out);

// `after: [t01, t02]`, the bracketed list `owns:` takes, was refused as naming '[t01'. It names both tasks.
{
  const lr = t.tmp('fleet-deps-list');
  mk(`${lr}/tasks/ready`, `${lr}/tasks/done`);
  for (const id of ['t01', 't02']) write(`${lr}/tasks/ready/${id}.md`, `---\ntask-id: ${id}\nneeds: repo\nbudget: 20\n---\nwork\n`);
  r = fleet(['file', lr, 't03'], { input: '---\nneeds: repo\nbudget: 20\nafter: [t01, t02]\n---\nwork\n' });
  code('an after: written as a bracketed list is filed', 0, r.code);
  absent('and no id in it is called impossible', "names '[t01'", r.out);
  fleet(['next', lr, '41', 'repo']);
  fleet(['next', lr, '42', 'repo']);
  fleet(['finish', lr, '41', 't01']);
  code('it waits for the second id in the brackets too', 7, fleet(['next', lr, '43', 'repo']).code);
  fleet(['finish', lr, '42', 't02']);
  check('and is handed out once both are done', 'CLAIMED t03', fleet(['next', lr, '43', 'repo'], { stdoutOnly: true }).out);
}

// One chat registers slots/: its pane lane is one subagent wide, not the chat default.
{
  const wr = t.tmp('fleet-width-onechat');
  mk(`${wr}/tasks/ready`, `${wr}/slots`);
  r = fleet(['width', wr]);
  check('width in one chat says the pane lane is 1', 'the pane lane is 1 in one chat', r.out);
  absent('and not that it starts at 2', 'it starts at', r.out);
}

// ONECHAT runs `width` before `chips --agents` creates slots/, so the first call names both cases.
{
  const wf = t.tmp('fleet-width-first');
  mk(`${wf}/tasks/ready`);
  r = fleet(['width', wf]);
  check('width before slots/ names the one-chat lane', 'pane lane: 1 in one chat', r.out);
  check('and the separate-chats start', 'with separate chats it starts at', r.out);
}

// A released task is work nobody finished, so the tasks whose `after:` named it are waiting on a done
// marker nobody will write: the wave answered QUEUE WAITING for the rest of the run and `landed` refused
// over it. The later stages go back to the planner with the stage that died.
write(`${depsrun}/tasks/ready/task-03-polish.md`,
  '---\ntask-id: task-03-polish\nneeds: repo\nbudget: 20\nafter: task-02-screen\n---\n## Steps\n1. Polish the screen, once it exists.\n');
touch(`${depsrun}/tasks/claimed/task-02-screen/owner`, OLD);
touch(`${depsrun}/tasks/claimed/task-02-screen/heartbeat`, OLD);
r = fleet(['sweep', depsrun, '--release']);
check('releasing a task takes the tasks waiting on it with it', 'also released task-03-polish', r.out);
r = fleet(['next', depsrun, '33', 'repo']);
code('so the wave does not wait forever on a marker nobody will write', 3, r.code);
check('and the queue says it is empty rather than waiting', 'QUEUE DRAINED', r.out);
truthy('the dependent waits in released/ to be re-filed with the wave', exists(`${depsrun}/tasks/released/task-03-polish.md`));

// ---- a cold start, after the machine died -----------------------------------------------------------------

// `recover` reads two things a crash leaves behind: the chip register written at the first claim, and
// whether that session still has a transcript to reopen. Point it at a project directory of our own so the
// test never depends on what is in the operator's ~/.claude/projects.
const proj = t.tmp('fleet-selftest-proj');
write(`${run}/chips/sess-alive`, '55');
write(`${run}/chips/sess-gone`, '56');
write(`${run}/chips/sess-still-running`, '57');
// The hooks keep their own once-only marks in the same directory, each holding a timestamp.
for (const m of ['memory-warned', 'contract-2f617069', 'browser-warned']) write(`${run}/chips/sess-alive.${m}`, '2026-09-29T10:00:00.000Z');
const line = '{"type":"user","cwd":"/tmp/some-worktree","timestamp":"2020-01-01T00:00:00Z"}\n';
write(`${proj}/some-cwd-slug/sess-alive.jsonl`, line);
write(`${proj}/some-cwd-slug/sess-still-running.jsonl`, line);
// A crashed session's transcript stopped being written when the machine did; a live one was written a
// moment ago. That difference is the only thing separating "reopen this" from "do not touch this".
touch(`${proj}/some-cwd-slug/sess-alive.jsonl`, OLD);
write(`${run}/tasks/claimed/task-88/owner`, 'chip 55\nclaimed old\n');
write(`${run}/tasks/claimed/task-89/owner`, 'chip 56\nclaimed old\n');
write(`${run}/tasks/claimed/task-90/owner`, 'chip 57\nclaimed old\n');
task(run, 'task-88', 'repo', 10);
task(run, 'task-89', 'repo', 10);
task(run, 'task-90', 'repo', 10);
r = fleet(['recover', run], { env: { CLAUDE_PROJECTS_DIR: proj } });
check('a chip whose session stopped being written is offered back', 'RESUME  chip 55', r.out);
check('with the command that reopens it', 'claude -r sess-alive', r.out);
check('in the directory that session was started in', 'cd "/tmp/some-worktree"', r.out);
check('and a first instruction, so it does not sit there waiting to be typed at', 'fleet.sh beat on task-88', r.out);
check('a chip with no transcript is a respawn, not a resume', 'RESPAWN chip 56', r.out);
check('a session written to a moment ago is not offered for reopening', 'LIVE?   chip 57', r.out);
check('and the report says what each chip is still holding', 'holding: task-88', r.out);
check('nothing is released by a report', 'nothing was changed', r.out);
absent("a hook's own mark is not read as a chip", 'chip 2026-09-29', r.out);
r = fleet(['recover', run, '--release'], { env: { CLAUDE_PROJECTS_DIR: proj } });
check("--release frees the dead chip's claim", 'released task-89', r.out);
truthy("and leaves the resumable chip's claim alone", exists(`${run}/tasks/claimed/task-88`), 'task-88 was released');
truthy("and the live chip's claim alone", exists(`${run}/tasks/claimed/task-90`), 'task-90 was released');
truthy('and retires the dead chip, so the watch does not wait for it', /^respawned/m.test(read(`${run}/56.retired`)), sh('ls').out);
rm(`${run}/56.retired`);
// A corpus that holds nothing is not evidence the workers are gone, and the one destructive path here must
// not run on that absence.
const empty = t.tmp('fleet-selftest-empty');
r = fleet(['recover', run, '--release'], { env: { CLAUDE_PROJECTS_DIR: empty } });
code('--release refuses when there are no transcripts to judge by', 2, r.code);
// The sh version cleaned this run up for the sections after it; here the run ends with the file.

// ---- one chat: subagent slots ----------------------------------------------------------------------------

{
  const oc = t.tmp('fleet-onechat');
  mk(`${oc}/tasks/ready`, `${oc}/tasks/done`, `${oc}/tasks/claimed`);
  task(oc, 'task-01', 'repo', 10);
  task(oc, 'task-02', 'pane', 10);
  const env = { CLAUDE_CODE_SESSION_ID: 'sess-coord' };
  let s = fleet(['chips', oc, '01-02', 'repo', '--agents'], { env });
  code('chips --agents registers slots', 0, s.code);
  check('one line per slot', 'SLOT 01 lane repo\nSLOT 02 lane repo', s.out);
  check('and one instruction line', 'spawn one background subagent per claimed task; see docs/ONECHAT.md', s.out);
  absent('and no chip prompt', 'CHIP ', s.out);
  absent('and no spawn_task trailer', 'spawn_task', s.out);
  truthy('a slot is recorded as offered with its lane', read(`${oc}/offered/02`).replace(/\r?\n$/, '') === 'repo', read(`${oc}/offered/02`));
  truthy('and writes no want/', !exists(`${oc}/want`));
  truthy('the asking session is recorded as the coordinator', read(`${oc}/coordinator`).trim() === 'sess-coord', read(`${oc}/coordinator`));
  truthy('and in fleet-sessions for the gate', read(`${t.cfg}/makarasty/fleet-sessions/sess-coord`).trim() !== '');
  check('a slot covers its lane: only the pane lane is still a gap', 'lane pane: 1 task(s) ready', s.out);
  absent('and the repo lane is not', 'lane repo:', s.out);
  check('the gap line asks for slots, not chips', 'Register slots', s.out);
  s = fleet(['chips', oc, '03', '--agents'], { env });
  code('a slot without a lane is refused', 2, s.code);
  s = fleet(['chips', oc, '03', 'repo', '--agents', '--model', 'claude-sonnet-5'], { env });
  code('--model on a slot is refused: the Agent call carries the model', 2, s.code);
  truthy('and nothing was offered for it', !exists(`${oc}/offered/03`));
  write(`${oc}/brief-04.md`, '---\nbrief\n---\n');
  s = fleet(['chips', oc, '04', 'repo', '--agents'], { env });
  code('a brief number is refused as a slot', 2, s.code);
  s = fleet(['chips', oc, '01', 'pane', '--agents'], { env });
  code('a slot already offered for another lane is refused', 2, s.code);
  s = fleet(['next', oc, '01', 'repo'], { env, stdoutOnly: true });
  check('the coordinator claims for slot 01', 'CLAIMED task-01', s.out);
  truthy('without registering itself as chip 01', !exists(`${oc}/chips/sess-coord`));
  task(oc, 'task-03', 'repo', 10);
  s = fleet(['next', oc, '02', 'repo'], { env, stdoutOnly: true });
  check('and claims for slot 02 from the same session, no CHIP TAKEN', 'CLAIMED task-03', s.out);
  truthy('slots are recorded for the coordinator to act for', exists(`${oc}/slots/01`) && exists(`${oc}/slots/02`));
  s = fleet(['status', oc]);
  check('status lists the slot as an offered worker', '01  lane repo', s.out);
}
