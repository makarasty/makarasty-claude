// 00-lib.test.mts - the self-test's own harness, checked before any part leans on it: the run it sets up,
// fleet.sh through sh, the merged output order, and a check registered after an await still running.

import { setup, fleet, fleetAsync, sh, hp, task, check, absent, code, starts, truthy, exists, read, touch, OLD, watchLoop, MULT, HOOKS, shPwd } from './lib.mts';
import { statSync } from 'node:fs';

const t = setup('lib');

truthy('setup stands in the run directory', process.cwd().split('\\').join('/') === t.run, process.cwd());
truthy('and hides the session running the test', process.env.CLAUDE_CODE_SESSION_ID === undefined);

task(t.run, 'task-02', 'repo', 15);
let r = fleet(['next', t.run, '07', 'repo']);
code('fleet.sh runs through sh and claims', 0, r.code);
check('and its output is captured', 'CLAIMED task-02', r.out);
check('with the calibrated abort deadline', `ABORT_AFTER_SEC ${15 * MULT * 60}`, r.out);
r = fleet(['next', t.run, '09', 'repo']);
code('an exit code other than 0 comes back as it is', 3, r.code);

r = sh('echo one; echo two >&2; echo three');
check('stdout and stderr are merged in the order they were written', 'one\ntwo\nthree', r.out);
truthy('and trailing newlines are cut, as $(...) cuts them', !r.out.endsWith('\n'), r.out);
r = sh('echo kept; echo dropped >&2', { stdoutOnly: true });
absent('stdoutOnly drops stderr', 'dropped', r.out);
r = sh('printf %s "${FLEET_LOAD-unset}"', { env: { FLEET_LOAD: undefined } });
check('an env value of undefined unsets it', 'unset', r.out);
r = sh('cat', { input: 'from stdin' });
check('stdin reaches the child', 'from stdin', r.out);

touch(`${t.run}/old`, OLD);
truthy('touch takes a time', statSync(`${t.run}/old`).mtime.getFullYear() === 2020);
truthy('read of a missing file is empty', read(`${t.run}/nope`) === '' && !exists(`${t.run}/nope`));
check('shPwd spells the run as fleet.sh does', '/fleet-selftest-', shPwd(t.run));
check('the watch loop is cut out of fleet-wait.md', 'run=RUNID', watchLoop());

starts('hp runs a hook on a payload and answers from its exit', '0 ', hp(`${HOOKS}/fleet-memory.mjs`, t.run, 'sess-none', 'Bash', 'git status'));

// Claims at the same instant, then a check registered after the await: node:test must still run it.
task(t.run, 'task-03', 'repo', 10);
const both = await Promise.all([fleetAsync(['next', t.run, '20', 'repo']), fleetAsync(['next', t.run, '21', 'repo'])]);
const won = both.filter((x) => x.out.includes('CLAIMED task-03')).length;
truthy('two concurrent claimers, exactly one wins task-03', won === 1, `${won} won`);
