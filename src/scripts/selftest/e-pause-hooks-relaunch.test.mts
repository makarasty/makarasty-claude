// e-pause-hooks-relaunch.test.mts - a paused run as the hooks hold it, a retired worker, relaunch (with and
// without the coordinator kept), the context marks, and brief workers registered for the pause.
// Port of fleet-selftest.sh lines 2085-2514. It rebuilds the pause run the sh version's earlier block left.

import { readdirSync, renameSync } from 'node:fs';
import {
  setup, fleet, sh, node, exec, git, hp as hpAt, nativePath, shPwd, check, absent, code, starts, truthy,
  write, read, exists, names, mk, rm, touch, OLD, ago, sleep, GRACE, HAT, WAT, CK, WK, FLEET_SH, HOOKS, ROOT, type RunOpts,
} from './lib.mts';

const t = setup('pause-hooks');

// ---- the pause run the earlier block left -----------------------------------------------------------------
const pr = t.tmp('fleet-pause');
const pc = `${pr}/config`; // the global paused/ marker lives under the config directory: never the real one
const R = `${pr}/.fleet/r1`;
mk(`${R}/tasks/ready`, pc);
process.env.CLAUDE_CONFIG_DIR = pc;
for (const id of ['t-a', 't-b']) write(`${R}/tasks/ready/${id}.md`, `---\ntask-id: ${id}\nneeds: repo\nbudget: 10\n---\nwork\n`);
write(`${R}/tasks/ready/t-c.md`, '---\ntask-id: t-c\nneeds: repo\nafter: t-a\nbudget: 10\n---\nwork\n');
fleet(['chips', R, '03-04', 'repo']);
fleet(['next', R, '03', 'repo'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-w3' } });
fleet(['next', R, '04', 'repo'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-w4' } });
fleet(['pause', R, 'operator asked']);
touch(`${R}/tasks/claimed/t-a/heartbeat`, OLD);

const sess = (id: string): RunOpts => ({ env: { CLAUDE_CODE_SESSION_ID: id } });
// hp <hook> <session> <tool> <command-or-json> [agent-id], every call standing in the pause run's root.
const hp = (hook: string, s: string, tool: string, input: string, agent = '', o: RunOpts = {}): string => hpAt(hook, pr, s, tool, input, agent, o);
const markers = (): string[] => names(`${pc}/makarasty/paused`);
const has = (file: string, re: RegExp): boolean => re.test(read(file));

// ---- pause: the hooks -------------------------------------------------------------------------------------
touch(`${R}/PAUSED`); // the steps above took a while, and the grace counts from this file
const MEM = `${HOOKS}/fleet-memory.mjs`, CON = `${HOOKS}/fleet-contract.mjs`, GRD = `${HOOKS}/fleet-guard.mjs`;
// an acknowledged worker is held to the list at once, grace or not
let r = fleet(['paused', R, '03'], sess('sess-w3'));
code('paused (the ack) exits 0', 0, r.code);
check('and says what the worker holds', 'STOPPED 03: holding t-a', r.out);
truthy('and writes stopped/03', exists(`${R}/stopped/03`));
check('and prints the wake loop', 'until [ ! -e', r.out);
check('that echoes resumed', 'echo resumed', r.out);
check('or retired', 'echo retired', r.out);
check('and says a resumed worker carries on with its claim', 'carry on with the claim you hold; call next only if you hold none', r.out);
check('and asks for a note where it stopped', '<where you stopped, what is next>', r.out);
const wake = r.out.split('\n').filter((l) => l.startsWith('  until')).join('\n');
r = fleet(['paused', R, '03', 'before the retry loop'], sess('sess-w3'));
check("a fourth argument is written into the chip's notes", 'noted in 03.notes.md', r.out);
check('as a line saying where it stopped', 'before the retry loop', read(`${R}/03.notes.md`));
let o = hp(MEM, 'sess-w3', 'Bash', 'npm test');
check("an acked worker's other commands are refused at once", '2 RUN PAUSED', o);
check('and told it has stopped', 'you have stopped: this call did not run', o);
o = hp(MEM, 'sess-w3', 'Bash', 'git -C /x add -A && git -C /x commit -m "wip: paused; again"');
starts('git, with a semicolon in its message, is allowed', '0 ', o);
o = hp(MEM, 'sess-w3', 'Bash', `sh "${FLEET_SH}" paused "${R}" 03 "where I stopped"`);
starts('fleet.sh by its exact path, quoted, is allowed', '0 ', o);
o = hp(MEM, 'sess-w3', 'Bash', `sh ${FLEET_SH} paused ${R} 03`);
starts('and unquoted', '0 ', o);
o = hp(MEM, 'sess-w3', 'Bash', wake);
starts('so is the wake loop it printed', '0 ', o);
o = hp(MEM, 'sess-w3', 'Bash', 'git status && npm test');
check('but a command chained after git is not', '2 RUN PAUSED', o);
o = hp(MEM, 'sess-w3', 'PowerShell', 'git status; npm test');
check('and the PowerShell tool is held to the same list', '2 RUN PAUSED', o);
// The allow-list is a drift guard, and it closes the holes a reviewer found in it.
for (const c of ['git status | head -5', 'git status 2>&1 | tail -3', 'time git status', 'git -C "/x/2026-10-06-do-over-fix" log --oneline -3',
  'git checkout fleet/01/do-it && git status', 'f=/a; sh "$f" paused /r 03', 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.sh" paused /r 03',
  'git log --oneline -3 > /dev/null 2>&1', 'git commit -m "fix -c flag; do it"']) {
  starts(`allowed while paused: ${c}`, '0 ', hp(MEM, 'sess-w3', 'Bash', c));
}
for (const c of ['git status & npm test', 'echo $(npm test)', 'echo `npm test`', 'git status > out.txt', 'git -c alias.x="!npm test" x',
  'git rebase -x "npm test" main', 'git bisect run npm test', 'git submodule foreach npm test', 'git diff --ext-diff',
  'sh ./fleet.sh next', 'sh /tmp/other/fleet.sh next', 'git status | npm test', 'git --exec-path=/x status', 'GIT_EXTERNAL_DIFF=x git diff',
  'git filter-branch --tree-filter x', 'bash -c "npm test"']) {
  check(`refused while paused: ${c}`, '2 RUN PAUSED', hp(MEM, 'sess-w3', 'Bash', c));
}
// Round 2: a quoted or escaped spelling, an abbreviation, a git program-runner, a PowerShell subexpression.
for (const c of ['git -C "/x y/wt" add -A; git -C "/x y/wt" commit -m "wip: paused"', 'git status 2>$null', 'git status 2>&1', '(git status)', 'git --git-dir /x/.git status']) {
  starts(`allowed while paused: ${c}`, '0 ', hp(MEM, 'sess-w3', 'Bash', c));
}
for (const c of ['git "-c" alias.x=y status', 'git "rebase" -x npm', 'git rebase -x"npm test" main', 'git rebase --exe "npm test" main', 'git rebase \\-x t',
  'git --git-dir x -c alias.x=y status', 'git config alias.x "!npm t"', 'git difftool -x npm', 'git grep -O less foo', 'git fetch --upload-pack=x',
  'PAGER=x git log', 'EDITOR=x git commit', 'VISUAL=x git commit', 'GIT_EDITOR=x git commit', 'HOME=/x git status', 'XDG_CONFIG_HOME=/x git status',
  'git log (npm t)', 'echo @(npm t)', 'echo (npm t)', 'git status; (npm t)', 'g\\it status']) {
  check(`refused while paused: ${c}`, '2 RUN PAUSED', hp(MEM, 'sess-w3', 'Bash', c));
}
check('the printed commit hint joins with a semicolon, not &&', 'add -A; git -C', hp(MEM, 'sess-w4', 'Bash', 'npm test'));
o = hp(MEM, 'sess-w3', 'Monitor', '{"command":"npm test"}');
check('Monitor is held like Bash', '2 RUN PAUSED', o);
o = hp(MEM, 'sess-w3', 'Monitor', '{"command":"git status"}');
starts('and passes what Bash passes', '0 ', o);
o = hp(CON, 'sess-w3', 'NotebookEdit', '{"notebook_path":"/x/a.ipynb","new_source":"x"}');
check('NotebookEdit is held like Edit', '2 RUN PAUSED', o);
o = hp(MEM, 'sess-w3', 'Skill', '{"skill":"x"}');
check('a Skill is held once the worker has stopped', '2 RUN PAUSED', o);
o = hp(CON, 'sess-w3', 'Edit', '{"file_path":"/x/a.txt","old_string":"a","new_string":"b"}');
check('an edit by an acked worker is refused', '2 RUN PAUSED', o);
o = hp(MEM, 'sess-w3', 'mcp__Claude_Browser__read_page', '{}');
check('so is any browser tool, not only the heavy three', '2 RUN PAUSED', o);
o = hp(MEM, 'sess-w3', 'Agent', '{"prompt":"x"}');
check('and a new subagent', '2 RUN PAUSED', o);

// an unacked worker has the grace
touch(`${R}/PAUSED`);
const agePause = (s: number): void => touch(`${R}/PAUSED`, ago(s));
o = hp(CON, 'sess-w4', 'NotebookEdit', '{"notebook_path":"/x/a.ipynb","new_source":"x"}');
check('a notebook edit by an unacked worker is the first call and gets the notice', '2 RUN PAUSED by the operator. This call did not run', o);
rm(`${R}/chips/sess-w4.pause-notice`);
// R2-1: the parent sits blocked inside Agent and has made no call, so the subagent's grace runs from the pause.
touch(`${R}/PAUSED`);
o = hp(MEM, 'sess-w4', 'Bash', 'npm test', 'agent-1');
starts('a subagent whose parent has not called yet is let through inside the grace', '0 ', o);
agePause(GRACE + 5);
o = hp(MEM, 'sess-w4', 'Bash', 'npm test', 'agent-1');
check('and is refused once pause + grace has passed, not at four graces', 'You are a subagent of worker 04', o);
touch(`${R}/PAUSED`);
o = hp(MEM, 'sess-w4', 'Bash', 'ls');
check("an unacked worker's first call is refused once with the notice", '2 RUN PAUSED by the operator. This call did not run; repeat it if it is part of finishing the step in hand.', o);
check('naming the seconds it has from now', `You have ${GRACE} s from now`, o);
check('and what to do first', 'stop your subagents and background shells (TaskStop each one', o);
check('saying the abort clock needs no stopping', 'the abort clock needs no stopping', o);
check('with the commit command and the ack, paths quoted', 'paused "', o);
o = hp(MEM, 'sess-w4', 'Bash', 'npm test');
starts('then calls pass for the rest of the grace', '0 ', o);
o = hp(CON, 'sess-w4', 'Edit', '{"file_path":"/x/a.txt","old_string":"a","new_string":"b"}');
starts('edits too, so the step in hand can be finished', '0 ', o);
o = hp(MEM, 'sess-w4', 'Agent', '{"prompt":"x"}');
check('a new subagent is refused even in the grace', '2 RUN PAUSED', o);
o = hp(MEM, 'sess-w4', 'Bash', 'npm test', 'agent-1');
starts("a subagent's calls pass inside the grace", '0 ', o);

// the grace over
// The grace starts at the worker's first call, not at the pause: a worker that was mid way through a long
// call a minute into the pause still gets its full grace.
agePause(GRACE * 2);
o = hp(MEM, 'sess-w4', 'Bash', 'ls');
check('a worker whose first call comes after the grace length still gets the grace', `You have ${GRACE} s from now`, o);
o = hp(MEM, 'sess-w4', 'Bash', 'npm test');
starts('and its next call passes', '0 ', o);
// ...but never later than four graces after the pause.
agePause(GRACE * 4 - 10);
o = hp(MEM, 'sess-w4', 'Bash', 'ls');
const left = /You have (\d+) s from now/.exec(o)?.[1];
const n = left === undefined ? NaN : Number(left);
truthy(left !== undefined && n <= 11 && n >= 5 ? `a first call near the ceiling gets only what is left of it (${n} s)` : 'a first call near the ceiling gets only what is left of it',
  left !== undefined && n <= 11 && n >= 5, o);
agePause(GRACE * 4 + 60);
o = hp(MEM, 'sess-w4', 'Bash', 'npm test');
check('a worker that never called is held four graces after the pause', '2 RUN PAUSED', o);
check('told the grace is over and the call did not run', 'the grace is over: this call did not run', o);
check('with the commit command', 'commit -m "wip: paused"', o);
check('and the TaskStop line', 'TaskStop each one', o);
o = hp(MEM, 'sess-w4', 'Bash', 'npm test', 'agent-1');
check("and a subagent's call carrying agent_id is refused with it", 'You are a subagent of worker 04', o);
o = hp(MEM, 'sess-w4', 'Bash', 'git log --oneline');
starts('git still passes', '0 ', o);
o = hp(CON, 'sess-w4', 'Write', '{"file_path":"/x/a.txt","content":"b"}');
check('a write is refused', '2 RUN PAUSED', o);
o = hp(MEM, 'sess-w4', 'Bash', 'cd /x && git commit -m "fix `x`"');
check('a line refused for a backtick says its syntax was the cause', 'refused for its shell syntax', o);
o = hp(MEM, 'sess-w4', 'Bash', 'git log && npm test');
truthy('a line refused for its commands does not blame its syntax', o.startsWith('2 ') && !o.includes('shell syntax'), o);
o = hp(MEM, 'sess-zz', 'Bash', 'npm test');
starts('a session that is not a worker is never held', '0 ', o);
o = hp(CON, 'sess-zz', 'Edit', '{"file_path":"/x/a.txt","old_string":"a","new_string":"b"}');
starts('not by the edit hook either', '0 ', o);
r = fleet(['status', R]);
check('status names a worker silent past pause_still_working_seconds as still working', 'worker 04: still working', r.out);
check('and counts the one that stopped', '1 of 2 workers holding claims have stopped', r.out);

// no paused run anywhere: the fast path
const emptyCfg: RunOpts = { env: { CLAUDE_CONFIG_DIR: `${pr}/empty-config` } };
o = hp(MEM, 'sess-w4', 'Bash', 'npm test', '', emptyCfg);
starts('with no paused run on the machine nothing is held', '0 ', o);
o = hp(CON, 'sess-w4', 'Edit', '{"file_path":"/x/a.txt","old_string":"a","new_string":"b"}', '', emptyCfg);
starts('and neither is an edit', '0 ', o);
check("the gate's matcher covers Monitor, Skill, subagent spawns, every browser tool and NotebookEdit",
  '/^(Bash|PowerShell|Monitor|Agent|Task|Skill|Edit|Write|MultiEdit|NotebookEdit)$|^mcp__(.*[Bb]rowser|claude-in-chrome)__/', read(`${HOOKS}/gate.ts`));
check("the gate is the plugin's hooks module", '"modules": ["./gate.ts"]', read(`${HOOKS}/hooks.json`));
// A command hook is a process on every tool call of every chat, fleet or not [M40]: the manifest declares none.
// A manifest that cannot be read fails, as grep -c on a missing file printed no count.
const manifest = `${ROOT}/.claude-plugin/plugin.json`;
code('and the manifest declares no command hook', 0, exists(manifest) ? read(manifest).split('\n').filter((l) => l.includes('"hooks"')).length : -1);
// O-2: the context reminder must not read as an order to a fleet coordinator.
write(`${pr}/ctx.jsonl`, '{"type":"assistant","message":{"usage":{"input_tokens":750000}}}\n');
r = node([`${ROOT}/tools/hooks/context.mjs`], {
  cwd: pr, env: { CLAUDE_CONFIG_DIR: `${pr}/ctxcfg` },
  input: '{"hook_event_name":"UserPromptSubmit","session_id":"s-ctx","transcript_path":"ctx.jsonl","prompt":"go on"}',
});
check('the context reminder says it is at 750k', 'context is at 750k tokens', r.out);
check('and that a fleet coordinator ignores it, its marks coming from the watch', 'a fleet coordinator ignores this line; its marks come from the watch (COORDINATOR CONTEXT)', r.out);
absent('and no longer tells a coordinator to relaunch at 400K', 'use the relaunch in fleet-plan 8b instead', r.out);

r = fleet(['resume', R]);
code('resume exits 0', 0, r.code);
check('and says so', 'RESUMED r1', r.out);
truthy('and closes the window in pauses.log', /^paused .*\r?\nresumed \d{4}-/m.test(read(`${R}/pauses.log`)), read(`${R}/pauses.log`));
check('and that a worker carries on with the claim it holds', 'resumed: carry on with the claim you hold, call next only if you hold none', r.out);
truthy('it removes PAUSED, the acks and the global marker', !exists(`${R}/PAUSED`) && !exists(`${R}/stopped/03`) && markers().length === 0,
  `${readdirSync(R).join(' ')} ${markers().join(' ')}`);
o = hp(MEM, 'sess-w4', 'Bash', 'npm test');
starts('after resume the worker is free again', '0 ', o);
r = fleet(['sweep', R]);
check('and the pause is not held against a claim: the sweep finds nothing quiet', 'no abandoned claims', r.out);
r = sh(wake);
check('a wake loop started during the pause says resumed once it lifts', 'resumed', r.out);

// ---- a retired worker is finished: guard, next, drained ---------------------------------------------------
const g1 = `${pr}/.fleet/g1`;
mk(`${g1}/chips`, `${g1}/tasks/claimed/task-05`, `${g1}/tasks/done`);
write(`${g1}/chips/sess-g`, '07');
write(`${g1}/tasks/claimed/task-05/owner`, 'chip 07\nclaimed now\n');
const guard = (): number => node([GRD], { input: JSON.stringify({ session_id: 'sess-g', cwd: nativePath(pr) }) }).code;
code('control: a worker with a fresh unfinished claim is stopped', 2, guard());
rm(`${g1}/chips/sess-g.warned-task-05`); write(`${g1}/07.retired`, '');
code('the same worker, retired, is not blocked from stopping', 0, guard());
rm(`${g1}/07.retired`, `${g1}/chips/sess-g.warned-task-05`); write(`${g1}/PAUSED`, '');
code('a worker holding a fresh claim is not blocked from stopping while the run is paused', 0, guard());
rm(`${g1}/PAUSED`, `${g1}/chips/sess-g.warned-task-05`);
code('and is again once the pause lifts', 2, guard());
rm(g1);

// ---- relaunch ---------------------------------------------------------------------------------------------
// A repository with one empty commit, on a new branch or a detached HEAD, with an unsaved file if asked.
const T = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
function mkwt(dir: string, branch: string, unsaved: boolean): void {
  mk(dir);
  exec('git', ['init', '-q', '.'], { cwd: dir });
  exec('git', [...T, 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  exec('git', branch === 'detach' ? ['checkout', '-q', '--detach'] : ['checkout', '-q', '-b', branch], { cwd: dir });
  if (unsaved) write(`${dir}/unsaved.txt`, 'unsaved\n');
}
// a registered worktree on a branch, so the hand-back has a branch to continue from
mkwt(`${pr}/wt03`, 'fleet/03/t-a', false);
write(`${R}/worktrees/03`, `path ${pr}/wt03\nbranch fleet/03/t-a\nchip 03\n`);
r = fleet(['relaunch', R, '--wait', '0', '03']);
code("relaunch's first call prints no chips with no STATE.md", 1, r.code);
check('and says why', 'STATE.md NOT CURRENT: ', r.out);
check('that it is missing', 'is missing. No chips are printed yet.', r.out);
check('and what to do: update it, then the same command again', 'run the same command again', r.out);
check('naming the ids it must list', 'it must list the handed-back ids above', r.out);
absent('and prints no chip', 'CHIP ', r.out);
check('it paused the run first', 'PAUSED r1', r.out);
check('named a worker that never stopped', 'NOT STOPPED after 0 min: 03 04', r.out);
check("handed the named chip's task back under a new id", 't-a -> t-a-r1  continue-from fleet/03/t-a', r.out);
check('and pointed the task waiting on it at the new id', 't-c: its after: now names t-a-r1', r.out);
truthy('03.retired is written', exists(`${R}/03.retired`));
truthy('the claim is renamed the way a release renames it', readdirSync(`${R}/tasks/claimed`).some((f) => f.startsWith('t-a.released-')));
const ar1 = `${R}/tasks/ready/t-a-r1.md`;
truthy('the new task carries its own id and continue-from', has(ar1, /^task-id: t-a-r1$/m) && has(ar1, /^continue-from: fleet\/03\/t-a$/m), read(ar1));
truthy('and the rest of the frontmatter', has(ar1, /^needs: repo$/m));
truthy('the old task file leaves the queue without entering released/', !exists(`${R}/tasks/ready/t-a.md`) && exists(`${R}/tasks/handed-back/t-a.md`));
truthy('a worker not named keeps its claim', exists(`${R}/tasks/claimed/t-b`));
r = fleet(['next', R, '03', 'repo']);
code('next for the retired chip exits 9', 9, r.code);
check('and tells it to end its turn', 'You were retired: end this turn with one line, commit nothing, start nothing.', r.out);
r = fleet(['paused', R, '03'], sess('sess-w3'));
code('paused for a retired chip exits 9', 9, r.code);
check("and says the same, not 'commit'", 'You were retired', r.out);
truthy('handback writes the second kind of global marker', markers().some((f) => f.endsWith('.retired')), markers().join(' '));
o = hp(MEM, 'sess-w3', 'Bash', 'git status');
check("the retired worker's hook refuses even git", '2 RETIRED', o);
o = hp(CON, 'sess-w3', 'Edit', '{"file_path":"/x/a.txt","old_string":"a","new_string":"b"}');
check('and an edit', '2 RETIRED', o);
check('with the one-line instruction', 'end this turn with one line, commit nothing, start nothing', o);
o = hp(MEM, 'sess-zz', 'Bash', 'npm test');
starts('a session that is not a worker is untouched by a retirement', '0 ', o);
r = fleet(['drained', R, '03', 'repo']);
code('drained for the retired chip exits 9', 9, r.code);
truthy('and writes no .done', !exists(`${R}/03.done`));
absent('and prints no pane line first', 'GIVE YOUR BROWSER MEMORY BACK', r.out);
check('the first relaunch call stops for STATE.md with an instruction', 'STATE.md NOT CURRENT', fleet(['relaunch', R, '--wait', '0', '03']).out);
sleep(1); write(`${R}/STATE.md`, '# state\n');
r = fleet(['relaunch', R, '--wait', '0', '03']);
code('with STATE.md written after the pause, relaunch prints the chips', 0, r.code);
check('the second call does not wait for the acks again', 'acks: 0 of 2 (not waited again)', r.out);
truthy('and prints no wait', !r.out.includes('NOT STOPPED') && !r.out.includes('waiting for:'), r.out);
check('a fresh worker numbered after the highest offered', 'CHIP 05', r.out);
check('titled like every worker', 'title: fleet r1 05', r.out);
check('for the lane the retired one had', 'lane repo', r.out);
check('and one coordinator chip', 'title: fleet r1 coordinator', r.out);
check('whose prompt reads STATE.md in full', 'STATE.md in full', r.out);
const Rw = shPwd(R);
check('and takes the seat with --take-over', `resume ${Rw} --take-over`, r.out);
check('then 3b and 8b of fleet-plan', 'sections 3b and 8b of the makarasty fleet-plan command', r.out);
check('then resumes the run', `resume ${Rw}`, r.out);
check('and arms the watch with every chip ever offered', 'arm /makarasty:fleet-wait r1 3', r.out);
check('the closing steps name TaskStop', 'TaskStop', r.out);
check('and say STATE.md was checked against the handbacks', 'newer than the pause and the handbacks', r.out);
check('and the order to click', 'click the coordinator chip first, then the worker chips', r.out);
check('05 is recorded as offered', 'repo', read(`${R}/offered/05`));
const r2 = fleet(['relaunch', R, '--wait', '0', '03']);
check('run again, the same chip has the same replacement', 'CHIP 05', r2.out);
absent('and no second replacement is minted', 'CHIP 06', r2.out);
r = fleet(['relaunch', R, '--wait', '0']);
code('with no chips only the coordinator is replaced', 0, r.code);
check('the coordinator chip is printed', 'title: fleet r1 coordinator', r.out);
absent('and no worker chip', 'CHIP 06', r.out);
code('a wait that is not minutes is refused', 2, fleet(['relaunch', R, '--wait', 'x']).code);
code('and so is a chip that was never offered', 2, fleet(['relaunch', R, '--wait', '0', '09']).code);
r = fleet(['relaunch', R, '1', '--wait', '1']);
code('a bare number before --wait is not a chip: it retired chip 01 once', 2, r.code);
check('and the refusal says chips are two digits', 'Chips are two digits', r.out);
truthy('and retires nothing', !exists(`${R}/01.retired`), '01.retired exists');
code('nor is a one-digit chip after it', 2, fleet(['relaunch', R, '--wait', '1', '3']).code);
code('--keep-coordinator with no chip is refused', 2, fleet(['relaunch', R, '--keep-coordinator', '--wait', '0']).code);

r = fleet(['resume', R], sess('sess-op'));
check('a plain resume from some other chat lifts the pause', 'RESUMED r1', r.out);
check('and says the seat is waiting for --take-over', 'coordinator-pending is set: the fresh coordinator takes the seat with:', r.out);
truthy('and does not take the coordinator seat', !read(`${R}/coordinator`).includes('sess-op'), read(`${R}/coordinator`));
truthy('coordinator-pending is still waiting', exists(`${R}/coordinator-pending`));
r = fleet(['resume', R, '--take-over'], sess('sess-new'));
check('only resume --take-over takes the seat', 'this session is now the coordinator', r.out);
check('recorded in the coordinator file', 'sess-new', read(`${R}/coordinator`));
truthy('and clears coordinator-pending', !exists(`${R}/coordinator-pending`));
code('an unknown resume flag is refused', 2, fleet(['resume', R, '--bogus']).code);
o = hp(MEM, 'sess-w3', 'Bash', 'git status');
check('after the resume the retired worker is still held', '2 RETIRED', o);
// R2-5: until the run lands, or its directory is gone.
touch(`${R}/FINISHED`);
o = hp(MEM, 'sess-w3', 'Bash', 'git status');
starts('a finished run holds no retired worker', '0 ', o);
rm(`${R}/FINISHED`);
renameSync(R, `${R}.moved`);
o = hp(MEM, 'sess-w3', 'Bash', 'git status');
starts('nor does a run directory that is gone', '0 ', o);
renameSync(`${R}.moved`, R);
o = hp(MEM, 'sess-w3', 'Bash', 'git status');
check('while a standing run still does', '2 RETIRED', o);
o = hp(MEM, 'sess-w4', 'Bash', 'npm test');
starts('while a worker that was not replaced is free', '0 ', o);
r = fleet(['paused', R, '05'], sess('sess-new'));
code('and the new coordinator cannot acknowledge a pause', 2, r.code);
r = fleet(['next', R, '05', 'repo'], sess('sess-w5'));
check('the fresh worker claims the re-filed task', 'CLAIMED t-a-r1', r.out);
check('whose body says where to continue from', 'continue-from: fleet/03/t-a', r.out);
fleet(['finish', R, '05', 't-a-r1']);
fleet(['finish', R, '04', 't-b']);
r = fleet(['next', R, '05', 'repo']);
check('t-c, which waited on t-a, opens once t-a-r1 is done', 'CLAIMED t-c', r.out);
fleet(['finish', R, '05', 't-c']);
fleet(['drained', R, '04', 'repo']); fleet(['drained', R, '05', 'repo']);
write(`${R}/backlog.jsonl`, '');
r = fleet(['landed', R, '3']);
code('landed passes on a run that went through a relaunch', 0, r.code);
check('counting the retired chip as finished', 'LANDED: 3 workers', r.out);
truthy('landed removes the retired marker', !markers().some((f) => f.endsWith('.retired')), markers().join(' '));
r = fleet(['status', R]);
check('status marks the retired worker', 'RETIRED', r.out);

// ---- relaunch --keep-coordinator: unsaved work, the branch, the proof -------------------------------------
const K = `${pr}/.fleet/k1`;
mk(`${K}/tasks/ready`, `${K}/worktrees`);
for (const id of ['t-k1', 't-k2', 't-k3']) write(`${K}/tasks/ready/${id}.md`, `---\ntask-id: ${id}\nneeds: repo\nkind: fix\nbudget: 10\n---\nwork\n`);
fleet(['chips', K, '01-02', 'repo']);
fleet(['next', K, '01', 'repo'], sess('sess-k1'));
fleet(['next', K, '02', 'repo'], sess('sess-k2'));
fleet(['next', K, '04', 'repo'], sess('sess-k4'));
mkwt(`${pr}/wtk1`, 'fleet/01/t-k1', true); write(`${K}/worktrees/01`, `path ${pr}/wtk1\nbranch fleet/01/t-k1\nchip 01\n`);
mkwt(`${pr}/wtk2`, 'detach', true);        write(`${K}/worktrees/02`, `path ${pr}/wtk2\nchip 02\n`);
mkwt(`${pr}/wtk4`, 'feature/x', true);     write(`${K}/worktrees/04`, `path ${pr}/wtk4\nchip 04\n`);
write(`${K}/tasks/claimed/t-k1/proof`, '{"phase":"before","exit":1,"cmd":"npm test -- login"}\n{"phase":"after","exit":0,"cmd":"npm test -- login"}\n');
r = fleet(['relaunch', K, '--keep-coordinator', '--wait', '0', '01']);
code('keep-coordinator: the first call stops for STATE.md', 1, r.code);
check("after handing the chip's work back", 'HANDED BACK 01', r.out);
check('committing what the worker never saved', "COMMITTED the unsaved work of 01 on fleet/01/t-k1 as 'wip: handed back'", r.out);
check('and listing the files', 'unsaved.txt', r.out);
const subj = git(`${pr}/wtk1`, 'log', '-1', '--format=%s').out;
truthy('the commit is on the task branch', subj === 'wip: handed back', subj);
truthy('and the tree is clean', git(`${pr}/wtk1`, 'status', '--porcelain').out === '');
const k1r1 = `${K}/tasks/ready/t-k1-r1.md`;
truthy('the new task carries continue-from, continued-from-chip and handback-of',
  has(k1r1, /^continue-from: fleet\/01\/t-k1$/m) && has(k1r1, /^continued-from-chip: 01$/m) && has(k1r1, /^handback-of: t-k1$/m), read(k1r1));
sleep(1); write(`${K}/STATE.md`, '# state\n');
r = fleet(['relaunch', K, '--keep-coordinator', '--wait', '0', '01']);
code('keep-coordinator: the same command again prints', 0, r.code);
check('and does not wait for the acks again', 'acks: 0 of 1 (not waited again)', r.out);
check('a fresh worker chip numbered after the highest offered', 'CHIP 03', r.out);
absent('and no coordinator chip', 'title: fleet k1 coordinator', r.out);
truthy('and no coordinator-pending', !exists(`${K}/coordinator-pending`));
truthy('and the run is resumed by the call itself', !exists(`${K}/PAUSED`));
check('saying the same coordinator carries on', '(same coordinator)', r.out);
check('and to re-arm the watch with the new count, which counts the retired chip', 'arm /makarasty:fleet-wait k1 3', r.out);
r = fleet(['relaunch', K, '--keep-coordinator', '--wait', '0', '01']);
code("a third call (the second's output lost) succeeds", 0, r.code);
check('printing the same chip again', 'CHIP 03', r.out);
truthy('without pausing the running fleet again', !exists(`${K}/PAUSED`), read(`${K}/PAUSED`));
r = fleet(['next', K, '03', 'repo'], sess('sess-k3'));
check('the fresh worker claims the re-filed task', 'CLAIMED t-k1-r1', r.out);
r = fleet(['relaunch', K, '--keep-coordinator', '--wait', '0', '01']);
check('a rerun once the replacement started offers nothing', '03 replaced 01 and has started', r.out);
check('and says there is nothing to do', 'RELAUNCH DONE already', r.out);
absent('and prints no chip', 'CHIP 0', r.out);
const proof = `${K}/tasks/claimed/t-k1-r1/proof`;
truthy('the old after is not carried over: the fresh worker proves its own tree', !read(proof).includes('"phase":"after"'), read(proof));
truthy("with the old claim's fix proof copied in", read(proof).includes('"phase":"before"'), read(proof));
r = fleet(['handback', K, '02']);
check('a worktree on a detached HEAD gets a branch first', 'was on a detached HEAD: its work is now on branch fleet/02/t-k2-handback', r.out);
check('the unsaved work is committed there', 'COMMITTED the unsaved work of 02 on fleet/02/t-k2-handback', r.out);
const k2r1 = `${K}/tasks/ready/t-k2-r1.md`;
truthy('and the new task continues from it', has(k2r1, /^continue-from: fleet\/02\/t-k2-handback$/m), read(k2r1));
r = fleet(['handback', K, '04']);
check('a tree on some other branch is committed too', 'COMMITTED the unsaved work of 04 on feature/x', r.out);
check('but the new task gets no continue-from, and says so', 'WARNING: 04 has no registered worktree on fleet/04/t-k3 (it is on feature/x)', r.out);
const k3r1 = `${K}/tasks/ready/t-k3-r1.md`;
truthy("continue-from only for the task's own branch", !has(k3r1, /^continue-from:/m), read(k3r1));
truthy('while the chip whose notes to read is still named', has(k3r1, /^continued-from-chip: 04$/m));
mk(`${pr}/wtk5`);
exec('git', ['init', '-q', '.'], { cwd: `${pr}/wtk5` });
exec('git', [...T, 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: `${pr}/wtk5` });
exec('git', ['checkout', '-q', '-b', 'fleet/05/zz'], { cwd: `${pr}/wtk5` });
write(`${pr}/wtk5/y.txt`, 'y\n');
write(`${K}/tasks/ready/t-k5.md`, '---\ntask-id: t-k5\nneeds: repo\nbudget: 10\n---\nwork\n');
write(`${K}/tasks/claimed/t-k5/owner`, 'chip 05\nclaimed now\n');
write(`${K}/worktrees/05`, `path ${pr}/wtk5\nchip 05\n`);
// The overrides go inside sh, as the sh version set them, so /dev/null keeps its sh meaning for git.
r = sh(`GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null HOME="${pr}/nohome" sh "${FLEET_SH}" handback "${K}" 05`);
check('a commit with no git identity configured still lands', 'COMMITTED the unsaved work of 05', r.out);

// ---- contexts ---------------------------------------------------------------------------------------------
const cx = `${pr}/.fleet/c1`;
mk(`${cx}/chips`, `${cx}/tasks/claimed/t-x`, `${cx}/tasks/done`);
write(`${cx}/tasks/claimed/t-x/owner`, 'chip 04\nclaimed now\n');
write(`${cx}/coordinator`, 'sess-co\n');
write(`${cx}/chips/sess-w4`, '04'); write(`${cx}/chips/sess-old`, '04'); write(`${cx}/chips/sess-w5`, '05');
touch(`${cx}/chips/sess-old`, OLD);
write(`${cx}/chips/sess-w4.warned-t-x`, '04 x'); write(`${cx}/chips/04.model`, 'm');
const tr = (s: string, cache: number): void =>
  write(`${pc}/projects/p/${s}.jsonl`, `{"type":"assistant","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":${cache}}}}\n`);
tr('sess-co', CK * 1000); tr('sess-w4', WK * 1000); tr('sess-old', 990000); tr('sess-w5', 120000);
r = fleet(['contexts', cx]);
code('contexts exits 0', 0, r.code);
check('the coordinator line carries its context and OVER', `${CK}K  OVER (mark ${HAT}K)`, r.out);
check('a worker over the mark is OVER, with its claim', `worker 04  sess-w4  ${WK}K  holds t-x  OVER (mark ${WAT}K)`, r.out);
check('a worker under it is not, and holds nothing', 'worker 05  sess-w5  120K  no claim', r.out);
truthy('and carries no OVER', !r.out.split('\n').some((l) => l.includes('worker 05') && l.includes('OVER')), r.out);
truthy("a reopened chip's older session is not read", !r.out.includes('sess-old') && !r.out.includes('900K'), r.out);
r = fleet(['ctx', cx]);
check('ctx speaks for the coordinator', `COORDINATOR CONTEXT ${CK}K`, r.out);
check('and for a worker past worker_relaunch_k, naming the chip', `WORKER CONTEXT 04 ${WK}K (mark ${WAT}K, holds t-x)`, r.out);
absent('and not for one under it', 'WORKER CONTEXT 05', r.out);
truthy('both point at the relaunch in fleet-plan 8b', r.out.includes('relaunch in fleet-plan') || r.out.includes('fleet-plan, 8b'), r.out);
absent('and neither sends a fleet coordinator to a handoff chip', 'makarasty-tools:handoff', r.out);
r = fleet(['ctx', cx]);
truthy('each only once per mark', r.out === '', r.out);
tr('sess-w4', 120000);
fleet(['ctx', cx]);
tr('sess-w4', WK * 1000);
r = fleet(['ctx', cx]);
check('a worker that fell back under the mark is named again when it crosses', 'WORKER CONTEXT 04', r.out);
write(`${cx}/05.done`, '');
tr('sess-w5', 900000);
r = fleet(['ctx', cx]);
absent('a finished worker is never named', 'WORKER CONTEXT 05', r.out);
const cal = read(`${ROOT}/calibration.json`);
check('the context marks are in calibration.json: coordinator, step and worker',
  '"coordinator_handoff_k": 700,\n  "coordinator_handoff_step_k": 100,\n  "worker_relaunch_k": 700,', cal);
check("with the operator's provenance", '"worker_relaunch_k": "operator, 2026-10-06', cal);
check('and the 150 s a worker may take to answer a pause', '"pause_still_working_seconds": 150', cal);

process.env.CLAUDE_CONFIG_DIR = t.cfg;
rm(pr);

// ---- brief workers are registered too ---------------------------------------------------------------------
const bw = t.tmp('fleet-bw');
mk(`${bw}/tasks/ready`); write(`${bw}/brief-01.md`, '---\nbrief\n---\n');
fleet(['whoami', bw, '01', 'm', 'x'], sess('sess-brief'));
truthy("a brief worker's whoami registers its session for the pause hooks", read(`${bw}/chips/sess-brief`).replace(/\n+$/, '') === '01',
  exists(`${bw}/chips`) ? readdirSync(`${bw}/chips`).join(' ') : 'no chips/');
const bwCfg: RunOpts = { env: { CLAUDE_CONFIG_DIR: `${bw}/cfg` } };
r = fleet(['pause', bw], bwCfg);
check('the pause counts a registered brief worker as holding work', '1 worker(s) hold claims: 01', r.out);
absent('a holder on this plugin is not called old', 'its hooks may not hold it', r.out);
touch(`${bw}/01.done`);
r = fleet(['pause', bw], bwCfg);
check('and stops counting it once it is done', '0 worker(s) hold claims', r.out);

// ---- one chat: the coordinator's subagents are its workers ------------------------------------------------
{
  const op = t.tmp('fleet-onechat');
  const OR = `${op}/.fleet/oc`;
  const ocfg: RunOpts['env'] = { CLAUDE_CONFIG_DIR: `${op}/cfg` };
  const as = (id: string): RunOpts => ({ env: { ...ocfg, CLAUDE_CODE_SESSION_ID: id } });
  mk(`${OR}/tasks/ready`);
  write(`${OR}/tasks/ready/t-o.md`, '---\ntask-id: t-o\nneeds: repo\nbudget: 10\n---\nwork\n');
  fleet(['chips', OR, '01', 'repo', '--agents'], as('sess-coord'));
  fleet(['next', OR, '01', 'repo'], as('sess-coord'));
  const oh = (hook: string, s: string, input: string, agent = '', env: RunOpts['env'] = {}): string =>
    hpAt(hook, op, s, 'Bash', input, agent, { env: { ...ocfg, ...env } });
  // The memory guard keys its once-marker by agent: two subagents of one chat are two workers.
  write(`${op}/tight.mjs`, "console.log(JSON.stringify({ when: new Date().toISOString(), totalGB: 31, freeGB: 0.9, tight: true, sessions: 1, panes: 0, groups: {} }));\n");
  const tightEnv = { FLEET_LOAD: `${op}/tight.mjs` };
  starts("a coordinator's subagent is a worker to the memory guard", '2 ', oh(MEM, 'sess-coord', 'npx vitest run', 'ag1', tightEnv));
  truthy('its once-marker is keyed by session and agent', exists(`${OR}/chips/sess-coord.ag1.memory-warned`), names(`${OR}/chips`).join(' '));
  starts('and the same subagent is not told twice', '0 ', oh(MEM, 'sess-coord', 'npx vitest run', 'ag1', tightEnv));
  starts('a second subagent of the same chat is told once itself', '2 ', oh(MEM, 'sess-coord', 'npx vitest run', 'ag2', tightEnv));
  starts('the coordinator itself is no worker to the guard', '0 ', oh(MEM, 'sess-coord', 'npx vitest run', '', tightEnv));
  // A kill-after wrapper in command position does not hide the runner behind it.
  starts('plain npm test is gated', '2 ', oh(MEM, 'sess-coord', 'npm test', 'agw0', tightEnv));
  ['timeout 600 npm test', 'timeout 600 npx vitest run', 'timeout 600 npx tsc --noEmit', 'timeout -k 10 600 npm test'].forEach((c, k) =>
    starts(`${c} is gated like plain npm test`, '2 ', oh(MEM, 'sess-coord', c, `agw${k + 1}`, tightEnv)));
  starts('a scoped run behind timeout passes', '0 ', oh(MEM, 'sess-coord', 'timeout 600 npx vitest run src/a.test.ts', 'agw9', tightEnv));
  // A wrapper's own flags are not the runner's scope, and a shell `-c` body or a PowerShell block is a command position.
  ['time -p npm test', 'time -p npx vitest run', 'timeout --signal KILL 600 npm test', 'timeout -s KILL -k 5 600 npm test', 'env -u FOO npm test',
    'bash -c "npm test"', "timeout 600 sh -c 'npm test'", 'cmd /c npm test', 'pwsh -c "npm test"', 'Measure-Command { npx vitest run }', 'Start-Job { npm test }',
    'bash -lc "npm test"', 'pwsh -Command "npm test"', 'pwsh -NoProfile -Command "npm test"', 'cmd /d /c npm test', '/bin/bash -c "git status; npm test"'].forEach((c, k) =>
    starts(`${c} is gated like plain npm test`, '2 ', oh(MEM, 'sess-coord', c, `agx${k}`, tightEnv)));
  // A flag ending in c is no shell, and quoted text naming a runner runs none. An allowed call writes no
  // once-marker: the guard warns once, so a false refusal would leave the real full run after it unwarned.
  ['rg -c "npm test" docs/', 'grep -ic "vitest" package.json', "grep -c 'npx jest' README.md", 'ls -c npm test',
    'gh pr create --body "fix; npm test passes"', "gh issue comment --body 'see; npm test'", 'rg -c "(npm test|vitest)"',
    'grep -E "jest|vitest" package.json', 'npx vitest run "src/a.test.ts"', 'npx jest "jest/setup.test.ts"', `npx vitest run 'tsc/a.test.ts'`,
    `bash -c "git commit -m 'fix; npm test'"`].forEach((c, k) => {
    starts(`not a full run: ${c}`, '0 ', oh(MEM, 'sess-coord', c, `agz${k}`, tightEnv));
    truthy(`and it writes no once-marker: ${c}`, !exists(`${OR}/chips/sess-coord.agz${k}.memory-warned`), names(`${OR}/chips`).join(' '));
  });
  starts('so a real full run after them is still warned', '2 ', oh(MEM, 'sess-coord', 'npm test', 'agz0', tightEnv));
  ['bash -c "npx vitest run src/a.test.ts"', 'time -p npx vitest run src/a.test.ts', 'Measure-Command { npx vitest run src/a.test.ts }', 'cmd /c npx tsc -p packages/a/tsconfig.json'].forEach((c, k) =>
    starts(`scoped: ${c} passes`, '0 ', oh(MEM, 'sess-coord', c, `agy${k}`, tightEnv)));
  // The coordinator claims verify as `chip 01` (its slot); the subagent doing it calls in as agent-<id>, new each spawn.
  write(`${op}/busy.mjs`, "console.log(JSON.stringify({ when: new Date().toISOString(), totalGB: 31, freeGB: 12, tight: false, sessions: 2, panes: 0, groups: { 'toolchain: typecheck': { n: 1, maxMB: 900 } } }));\n");
  const busyEnv = { FLEET_LOAD: `${op}/busy.mjs` };
  truthy('chips --agents registers slot 01', exists(`${OR}/slots/01`), names(OR).join(' '));
  write(`${OR}/tasks/claimed/t-v/owner`, 'chip 01\nclaimed now\n');
  write(`${OR}/tasks/ready/t-v.md`, '---\ntask-id: t-v\nneeds: verify\nbudget: 10\n---\nsuite\n');
  // t-o, the repo claim, done: verify is the only open claim.
  write(`${OR}/tasks/done/t-o`, '');
  starts("a subagent of a slot holding verify runs the suite while another session's tsc is live", '0 ', oh(MEM, 'sess-coord', 'npx vitest run', 'agv1', busyEnv));
  starts('and so does its re-spawn under a new agent id', '0 ', oh(MEM, 'sess-coord', 'npx vitest run', 'agv2', busyEnv));
  // A subagent's id does not say which slot it works: with a repo claim open too it may be the coder.
  rm(`${OR}/tasks/done/t-o`);
  starts("with a repo claim open beside verify a subagent's full run is refused", '2 ', oh(MEM, 'sess-coord', 'npx vitest run', 'agv4', busyEnv));
  // A pane walk runs after the code tasks, as verify does: an open pane claim keeps the exemption.
  write(`${OR}/tasks/done/t-o`, '');
  write(`${OR}/tasks/claimed/t-p/owner`, 'chip 02\nclaimed now\n');
  write(`${OR}/tasks/ready/t-p.md`, '---\ntask-id: t-p\nneeds: pane\nbudget: 10\n---\nwalk\n');
  starts('with a pane claim open beside verify a subagent still runs the suite', '0 ', oh(MEM, 'sess-coord', 'npx vitest run', 'agv5', busyEnv));
  rm(`${OR}/tasks/claimed/t-p`, `${OR}/tasks/ready/t-p.md`);
  rm(`${OR}/tasks/claimed/t-v`, `${OR}/tasks/ready/t-v.md`);
  starts('with no verify claim the same subagent is refused', '2 ', oh(MEM, 'sess-coord', 'npx vitest run', 'agv3', busyEnv));
  r = fleet(['paused', OR, '01'], as('sess-coord'));
  check('the coordinator acking a slot before any pause is told NOT PAUSED', 'NOT PAUSED', r.out);
  // A pause holds the subagents, never the coordinator that has to lift it.
  r = fleet(['pause', OR, 'line one\nline two'], as('sess-coord'));
  r = fleet(['paused', OR, '01', 'stopped at step 2'], as('sess-coord'));
  code('the coordinator acks for its slot', 0, r.code);
  truthy('which writes stopped/01', exists(`${OR}/stopped/01`));
  truthy('and registers the coordinator as no chip', !exists(`${OR}/chips/sess-coord`));
  write(`${OR}/offered/02`, 'repo\n');
  code('a number that is not a slot is still refused to the coordinator', 2, fleet(['paused', OR, '02'], as('sess-coord')).code);
  check('a pause reason with a newline is kept to one line', 'line one line two', read(`${OR}/PAUSED`).split('\n')[0] ?? '');
  truthy('and so is its pauses.log record', /^paused \S+ line one line two$/m.test(read(`${OR}/pauses.log`)), read(`${OR}/pauses.log`));
  touch(`${OR}/PAUSED`, ago(GRACE * 5));
  starts('the coordinator is never held by its own pause', '0 ', oh(MEM, 'sess-coord', 'npm test'));
  o = oh(MEM, 'sess-coord', 'npm test', 'ag1');
  check("a coordinator's subagent is held once the grace is over", '2 RUN PAUSED', o);
  check('and told to return what it has', 'You are a fleet subagent of the coordinator', o);
  starts('a subagent of a chat that is not the coordinator is not held', '0 ', oh(MEM, 'sess-other', 'npm test', 'ag1'));
  starts('and the contract hook holds the subagent too', '2 RUN PAUSED', hpAt(CON, op, 'sess-coord', 'Edit', '{"file_path":"/x/a.txt","old_string":"a","new_string":"b"}', 'ag1', { env: ocfg }));
  r = fleet(['resume', OR], as('sess-coord'));
  truthy('resume closes the window in pauses.log', /^resumed \d{4}-/m.test(read(`${OR}/pauses.log`)), read(`${OR}/pauses.log`));
  starts('after resume the subagent is free again', '0 ', oh(MEM, 'sess-coord', 'npm test', 'ag1'));
  // An unproven fix the coordinator gives up on: handback re-files it and the slot stays the coordinator's.
  write(`${OR}/tasks/ready/t-h.md`, '---\ntask-id: t-h\nneeds: repo\nkind: fix\nbudget: 10\n---\nfix\n');
  write(`${OR}/tasks/ready/t-a.md`, '---\ntask-id: t-a\nneeds: repo\nafter: t-h\nbudget: 10\n---\nnext\n');
  check('the slot claims the fix', 'CLAIMED t-h', fleet(['next', OR, '01', 'repo'], as('sess-coord')).out);
  r = fleet(['handback', OR, '01'], as('sess-coord'));
  check('handback of a slot re-files its claim', 't-h -> t-h-r1', r.out);
  check('and says the slot is still the coordinator\'s', 'RELEASED 01: 1 task(s) filed again', r.out);
  absent('without the worktree warning a chat worker gets', 'starts from base', r.out);
  truthy('it writes no 01.retired', !exists(`${OR}/01.retired`), names(OR).join(' '));
  truthy('the re-filed task names the old claim', has(`${OR}/tasks/ready/t-h-r1.md`, /^handback-of: t-h$/m), read(`${OR}/tasks/ready/t-h-r1.md`));
  truthy('and what waited on it now waits on the new id', has(`${OR}/tasks/ready/t-a.md`, /t-h-r1/), read(`${OR}/tasks/ready/t-a.md`));
  check('the same slot claims the re-filed task', 'CLAIMED t-h-r1', fleet(['next', OR, '01', 'repo'], as('sess-coord')).out);
}
