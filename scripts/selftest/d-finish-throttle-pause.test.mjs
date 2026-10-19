// d-finish-throttle-pause.test.mts - finish refusing an unproved fix, the memory throttle and the hook that
// refuses the whole machine, how the plugin finds itself, chips and lane gaps, the coordinator's context,
// worktree --create and clean, and the first half of pause: the run stopping, before the hooks enforce it.
import { readdirSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { setup, fleet, exec, sh, node, git, has, hp, nativePath, check, absent, code, starts, truthy, skip, write, read, exists, names, ls, mk, rm, touch, OLD, copyFleet, ROOT, SCRIPTS, HOOKS, POLL, CK, } from './lib.mjs';
const t = setup('d');
const run = t.run;
const tmp = t.tmp('fleet-gate');
const rb = basename(run);
// `sed -n 's/^path //p' <file>`: the path line of a worktree record.
const pathOf = (f) => read(f).split(/\r?\n/).filter((l) => l.startsWith('path ')).map((l) => l.slice(5)).join('\n');
// `ls <dir>/*` that exist as directories.
const dirsIn = (d) => {
    try {
        return readdirSync(d).map((n) => `${d}/${n}`).filter((p) => statSync(p).isDirectory());
    }
    catch {
        return [];
    }
};
const nowIso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d+Z$/, 'Z');
const fm = (lines) => `---\n${lines}\n---\n`;
// ---- finish refuses a fix nobody proved ------------------------------------------------------------------
if (has('git')) {
    const fg = `${tmp}/finishgate`;
    mk(`${fg}/r/tasks/ready`);
    git(fg, 'init', '-q', '.');
    git(fg, 'config', 'user.email', 't@t');
    git(fg, 'config', 'user.name', 't');
    write(`${fg}/r/tasks/ready/t1.md`, '---\ntask-id: t1\nkind: fix\nneeds: repo\nbudget: 5\n---\n\n# a fix task\n');
    fleet(['next', 'r', '07', 'repo'], { cwd: fg });
    let r = fleet(['finish', 'r', '07', 't1'], { cwd: fg });
    code('a fix task with no proof does not get its done marker', 1, r.code);
    check('and the worker is told how to record one', ' t1 before -- ', r.out);
    truthy('and no done marker was written', !exists(`${fg}/r/tasks/done/t1`), 'marker exists');
    // FLEET_REFUTED closes a task only over a `before` that passed, never past a missing or failed proof.
    const refuted = { cwd: fg, env: { FLEET_REFUTED: '1' } };
    r = fleet(['finish', 'r', '07', 't1'], refuted);
    code('FLEET_REFUTED with no before recorded does not close the task', 1, r.code);
    check('and the worker is told why', 'no `before` run was recorded', r.out);
    write(`${fg}/f.txt`, 'one\n');
    git(fg, 'add', '-A');
    git(fg, 'commit', '-qm', 'one');
    node([`${SCRIPTS}/fleet-gate.mjs`, 'prove', 'r', 't1', 'before', '--', 'grep -q two f.txt'], { cwd: fg });
    r = fleet(['finish', 'r', '07', 't1'], refuted);
    code('FLEET_REFUTED over a before that failed does not close the task', 1, r.code);
    check('and the worker is told the before failed', 'the last `before` run failed (exit 1)', r.out);
    truthy('and still no done marker was written', !exists(`${fg}/r/tasks/done/t1`), 'marker exists');
    write(`${fg}/f.txt`, 'two\n');
    git(fg, 'add', '-A');
    git(fg, 'commit', '-qm', 'two');
    node([`${SCRIPTS}/fleet-gate.mjs`, 'prove', 'r', 't1', 'after', '--', 'grep -q two f.txt'], { cwd: fg });
    r = fleet(['finish', 'r', '07', 't1'], { cwd: fg });
    code('the same task finishes once the reproduction has been run both ways', 0, r.code);
    check('and it says so', 'DONE t1', r.out);
    // A task of any other kind is not asked for a reproduction: the demand belongs to the fix kinds.
    write(`${fg}/r/tasks/ready/t2.md`, '---\ntask-id: t2\nkind: verify\nneeds: repo\nbudget: 5\n---\n\n# not a fix\n');
    fleet(['next', 'r', '07', 'repo'], { cwd: fg });
    r = fleet(['finish', 'r', '07', 't2'], { cwd: fg });
    code('a task that is not a fix finishes without one', 0, r.code);
    // A reproduction that passes before any change refutes the finding, and FLEET_REFUTED closes it as that.
    write(`${fg}/r/tasks/ready/t3.md`, '---\ntask-id: t3\nkind: fix\nneeds: repo\nbudget: 5\n---\n\n# already fine\n');
    fleet(['next', 'r', '07', 'repo'], { cwd: fg });
    node([`${SCRIPTS}/fleet-gate.mjs`, 'prove', 'r', 't3', 'before', '--', 'grep -q two f.txt'], { cwd: fg });
    r = fleet(['finish', 'r', '07', 't3'], refuted);
    code('FLEET_REFUTED over a before that passed closes the task', 0, r.code);
    check('as a refutation', 'closing t3 as a refutation', r.out);
    // A root ruled a coincidence fails before and after alike, so FLEET_REFUTED closes it on a written reason.
    write(`${fg}/r/tasks/ready/root1.md`, '---\ntask-id: root1\nkind: root\nneeds: repo\nbudget: 5\n---\n\n# a shared cause\n');
    fleet(['next', 'r', '07', 'repo'], { cwd: fg });
    write(`${fg}/r/07.notes.md`, 'refuted root1:\n');
    r = fleet(['finish', 'r', '07', 'root1'], refuted);
    code('FLEET_REFUTED on a root with no reason in the notes does not close it', 1, r.code);
    check('and the worker is told which line to write', 'no line `refuted root1: <why', r.out);
    truthy('and no done marker was written', !exists(`${fg}/r/tasks/done/root1`), 'marker exists');
    write(`${fg}/r/07.notes.md`, 'refuted root1: the two findings share a file name, not a mechanism\n');
    r = fleet(['finish', 'r', '07', 'root1'], refuted);
    code('FLEET_REFUTED on a root with a reason and no before closes it', 0, r.code);
    check('as a coincidence', 'closing root root1 as a coincidence', r.out);
    // A fix keeps the passing-before rule, whatever its notes say.
    write(`${fg}/r/tasks/ready/t4.md`, '---\ntask-id: t4\nkind: fix\nneeds: repo\nbudget: 5\n---\n\n# a fix\n');
    fleet(['next', 'r', '07', 'repo'], { cwd: fg });
    write(`${fg}/r/07.notes.md`, 'refuted t4: looks like a coincidence\n');
    r = fleet(['finish', 'r', '07', 't4'], refuted);
    code('FLEET_REFUTED on a fix with a reason but no before is still refused', 1, r.code);
    check('for the missing before', 'no `before` run was recorded', r.out);
}
else {
    skip('finish-gate cases', 'node or git missing');
}
// ---- the throttle that keeps a fleet off the page file ---------------------------------------------------
{
    const mt = `${tmp}/tight`;
    mk(`${mt}/r/tasks/ready`);
    copyFleet(`${mt}/scripts`, 'fleet-load.mjs');
    write(`${mt}/r/tasks/ready/t1.md`, '---\ntask-id: t1\nkind: fix\nneeds: repo\nbudget: 5\n---\n\n# a task\n');
    // The real census beside the copy, never the stub: the floor is what decides here.
    const tight = (args) => exec('sh', ['scripts/fleet.sh', ...args], { cwd: mt, env: { FLEET_LOAD: undefined } });
    // A floor no machine can meet: the refusal must fire whatever this box happens to have free. The copy
    // has no calibration.json of its own, so the one written beside its scripts/ is the whole file.
    write(`${mt}/calibration.json`, JSON.stringify({ memory_floor_gb: 99999, memory_clear_gb: 99999 }, null, 2));
    let r = tight(['next', 'r', '07', 'repo']);
    code('a claim is refused when the machine has no memory left', 6, r.code);
    check('and the worker is told the box is full, not that it did something wrong', 'MACHINE TIGHT', r.out);
    check('and is given the wait to background rather than an ending', 'until node', r.out);
    check('whose loader path is absolute, since a worktree worker has another working directory', '/scripts/fleet-load.mjs', r.out);
    check('and which ends itself when the run lands', 'FINISHED', r.out);
    check('and it is told the one thing it can do while waiting', 'give back what your browser holds', r.out);
    check('and to keep one tab, so the pane stays open', 'Keep one tab open', r.out);
    truthy('the held worker is on disk where status can find it', exists(`${mt}/r/tight/07`), 'no marker');
    truthy('and nothing was claimed', !exists(`${mt}/r/tasks/claimed/t1`), 'claimed anyway');
    // Floor back to a number any machine meets: the same call must now hand the task out and clear the mark.
    write(`${mt}/calibration.json`, JSON.stringify({ memory_floor_gb: 0, memory_clear_gb: 0 }, null, 2));
    r = tight(['next', 'r', '07', 'repo']);
    code('and with room again the same call claims', 0, r.code);
    truthy('and the held mark is cleared', !exists(`${mt}/r/tight/07`), 'still there');
    write(`${mt}/r/tasks/done/t1`, ''); // closed: drained refuses a chip holding a claim
    r = exec('sh', ['scripts/fleet.sh', 'drained', 'r', '07'], { cwd: mt });
    check('a drained worker is asked for its pane back', 'GIVE YOUR BROWSER MEMORY BACK', r.out);
    rm(mt);
}
// ---- the hook that refuses the whole machine -------------------------------------------------------------
{
    const M = exists(`${HOOKS}/fleet-memory.mjs`) ? `${HOOKS}/fleet-memory.mjs` : `${SCRIPTS}/fleet-memory.mjs`;
    if (exists(M)) {
        const mh = `${tmp}/memhook`;
        const r1 = `${mh}/.fleet/r1`;
        mk(`${r1}/chips`, `${r1}/tasks/claimed`, `${r1}/tasks/ready`);
        write(`${r1}/chips/sess-a`, '07');
        // The command as typed, handed to the hook as JSON: nothing on the way rewrites a "/x" argument.
        const bashcall = (session, cmd) => hp(M, mh, session, 'Bash', cmd);
        const browse = () => node([M], { input: JSON.stringify({ session_id: 'sess-a', cwd: nativePath(mh), tool_name: 'mcp__Claude_Browser__navigate', tool_input: { url: 'http://x' } }) });
        const unwarn = () => rm(`${r1}/chips/sess-a.memory-warned`);
        starts('an ordinary command is never gated', '0 ', bashcall('sess-a', 'git status'));
        starts('a scoped run is never gated', '0 ', bashcall('sess-a', 'npx vitest run src/auth/session.test.ts'));
        starts('and neither is one over the changed set', '0 ', bashcall('sess-a', 'npm test -- --changed'));
        starts('a session that is not a fleet worker is never gated', '0 ', bashcall('sess-zz', 'npx vitest run'));
        // A worker holding the verify lane is the one worker allowed to take the machine.
        write(`${r1}/tasks/claimed/t-verify/owner`, 'chip 07\nclaimed now\n');
        write(`${r1}/tasks/ready/t-verify.md`, '---\ntask-id: t-verify\nneeds: verify\nbudget: 30\n---\n\n# the suite\n');
        starts('a worker holding the verify lane may run the whole suite', '0 ', bashcall('sess-a', 'npx vitest run'));
        rm(`${r1}/tasks/claimed/t-verify`, `${r1}/tasks/ready/t-verify.md`);
        unwarn();
        // The refusal itself, with a census that always says the box is full. Without this the decisive case is
        // untestable, because whether the hook fires depends on what the machine happens to have free.
        write(`${mh}/tight-census.mjs`, `console.log(JSON.stringify({ when: new Date().toISOString(), totalGB: 31.2, freeGB: 0.9, tight: true,
  sessions: 4, panes: 3, groups: { 'browser pane or window': { n: 3, totalMB: 3200, maxMB: 2061 },
  'toolchain: typecheck': { n: 2, totalMB: 2100, maxMB: 1200 } } }));
`);
        process.env.FLEET_LOAD = `${mh}/tight-census.mjs`;
        let o = bashcall('sess-a', 'npx vitest run');
        starts('a full suite is refused when the machine is full', '2 ', o);
        check('and the worker is told what is already running', 'typecheck or test process', o);
        check('and offered the verify lane rather than only a refusal', 'claim the verify lane', o);
        o = bashcall('sess-a', 'npx vitest run');
        starts('and it is not raised a second time in one session', '0 ', o);
        // The usual spellings of a whole run count too; a config file or tsc's -p is no scope.
        for (const full of ['npm run typecheck', 'pnpm typecheck', 'npm t', 'npx tsc -p .', 'npx tsc --noEmit -p tsconfig.json',
            'npx vitest run --config ./vitest.config.ts', 'npx jest -c ./jest.config.js', 'npx tsc --noEmit 2>&1 | tail -20',
            'bash -c "cd app && npm test"', 'npm test -- -w 2', 'npx tsc --noEmit # check', 'pnpm -r test', 'npm run test:watch -- --run',
            "echo 'C:\\' ; npm test; echo 'done'", 'echo "$(npm test)"']) {
            unwarn();
            starts(`${full} is a full run`, '2 ', bashcall('sess-a', full));
        }
        for (const part of ['npx vitest run src/a.test.ts', 'npx tsc -p packages/a/tsconfig.json', 'npm test -w packages/a',
            'git commit -m "fix; npm t"', 'npm tsc', 'npm run test:watch', 'git commit -am "fix; npm test"', 'git commit -m"fix; npm test"',
            'git commit -m $"fix; npm t"', 'git commit -m "$(cat <<\'EOF\'\nfix auth; npm test is slow\nEOF\n)"', 'git commit -m "a `x` (vitest) b"']) {
            unwarn();
            starts(`${part} is not a full run`, '0 ', bashcall('sess-a', part));
        }
        unwarn();
        let r = browse();
        code('driving a browser on a full machine is refused too', 2, r.code);
        check('and the worker is told a reload will not help', 'reload returns none of it', r.out);
        process.env.FLEET_LOAD = t.loadstub; // back to the roomy census the rest of this file runs on
        // A census that cannot answer must never block work: this hook sits on the Bash path of every worker, so
        // failing closed would stop the fleet over a broken reading rather than over a full machine.
        write(`${mh}/broken-census.mjs`, 'process.exit(3)\n');
        write(`${mh}/garbage-census.mjs`, 'console.log("not json at all")\n');
        unwarn();
        process.env.FLEET_LOAD = `${mh}/broken-census.mjs`;
        starts('a census that exits non-zero lets the command through', '0 ', bashcall('sess-a', 'npx vitest run'));
        process.env.FLEET_LOAD = `${mh}/garbage-census.mjs`;
        starts('and so does one that answers with nonsense', '0 ', bashcall('sess-a', 'npx vitest run'));
        r = browse();
        code('a browser call is not gated when the census is unreadable', 0, r.code);
        process.env.FLEET_LOAD = t.loadstub;
        rm(mh);
    }
    else {
        skip('memory hook cases', 'no fleet-memory.mjs');
    }
}
// ---- the plugin finds itself the way the host records it -------------------------------------------------
// What rotted here was silent: the docs resolved `docs/` by sorting the plugin cache by modification time,
// the newest by mtime was nine days behind the newest by version, and sessions read a plugin they were not
// running. Nothing failed. So the shape is asserted rather than trusted.
// The glob is allowed, but only as a fallback after a `||` - never as the primary answer.
{
    // `grep -r` over a directory: every line of every file under it.
    const linesUnder = (d) => {
        let names;
        try {
            names = readdirSync(d, { recursive: true, encoding: 'utf8' });
        }
        catch {
            return [];
        }
        return names.map((n) => `${d}/${n}`).filter((p) => statSync(p).isFile()).flatMap((p) => read(p).split('\n'));
    };
    const commands = linesUnder(`${ROOT}/commands`);
    const badGlob = [...commands, ...linesUnder(`${ROOT}/docs`)]
        .filter((l) => /ls -d?t ~\/.claude\/plugins\/cache/.test(l) && !l.includes('||')).length;
    truthy('no document resolves this plugin by modification time', badGlob === 0, `${badGlob} line(s) still do`);
    truthy('and the commands take their root from the host instead', commands.some((l) => l.includes('${CLAUDE_PLUGIN_ROOT}')), 'no command names ${CLAUDE_PLUGIN_ROOT}');
}
// `beside` must return the copy next to the script, whatever any cache holds - and must survive a host with
// no install record at all. This used to call fleet.sh with no arguments, which exits at the usage line
// before `beside` ever runs; and a failed record lookup killed the whole script, silently, under `set -e`.
{
    const b = `${tmp}/beside`;
    mk(`${b}/home`, `${b}/r/tasks/ready`);
    copyFleet(`${b}/scripts`);
    write(`${b}/scripts/fleet-load.mjs`, 'if (process.argv.includes("--clear")) process.exit(1);\nconsole.log(JSON.stringify({freeGB:1.23}));\n');
    write(`${b}/r/tasks/ready/t1.md`, '---\ntask-id: t1\nneeds: repo\nbudget: 5\n---\n');
    const env = { FLEET_LOAD: undefined, HOME: `${b}/home`, USERPROFILE: `${b}/home` };
    let r = exec('sh', ['scripts/fleet.sh', 'status', 'r'], { cwd: b, env });
    code('a copy of fleet.sh on a host with no install record still runs', 0, r.code);
    r = exec('sh', ['scripts/fleet.sh', 'next', 'r', '07', 'repo'], { cwd: b, env });
    code('and asks the census beside it', 6, r.code);
    check('whose answer is the one it prints', '1.23 GB free', r.out);
    check('by the path beside the script', 'beside/scripts/fleet-load.mjs', r.out);
    rm(b);
}
// ---- chips -----------------------------------------------------------------------------------------------
{
    let r = fleet(['chips', run, '02-03', 'repo']);
    code('chips prints the workers of a queue run', 0, r.code);
    check('titled by the address every lookup uses', `title: fleet ${rb} 03`, r.out);
    check('with the lane', `of run ${rb}, lane repo.`, r.out);
    absent("and the run's absolute path, not a relative one", 'fleet-run .fleet/', r.out);
    check('and the path of the fleet-run beside it', 'commands/fleet-run.md', r.out);
    r = fleet(['chips', run, '04']);
    code('a queue worker with no lane is refused', 2, r.code);
    write(`${run}/brief-05.md`, '---\nbrief\n---\n');
    r = fleet(['chips', run, '05']);
    check('a brief worker gets its brief, no lane needed', `${rb}/brief-05.md by following`, r.out);
    truthy('and is recorded as a brief, not as a lane it never works', read(`${run}/offered/05`).replace(/\r?\n$/, '') === 'brief', read(`${run}/offered/05`));
    rm(`${run}/brief-05.md`);
    r = fleet(['chips', run, '06', 'opus']);
    code('a model name is refused as a lane', 2, r.code);
    check('and the refusal says what a lane is', 'use pane, repo or verify', r.out);
    const lane03 = () => read(`${run}/offered/03`).replace(/\r?\n$/, '');
    truthy('an offered chip is recorded with its lane', lane03() === 'repo', exists(`${run}/offered`) ? readdirSync(`${run}/offered`).join('\n') : 'no offered/');
    r = fleet(['chips', run, '02-03', 'pane']);
    code('a number already offered for another lane is refused', 2, r.code);
    check('and the refusal says lanes take disjoint ranges', 'disjoint ranges', r.out);
    absent('and nothing was printed before it', 'CHIP ', r.out);
    truthy('and the recorded lane is left alone', lane03() === 'repo', lane03());
    r = fleet(['chips', run, '02-03', 'repo']);
    code('the same numbers for the same lane are fine to offer again', 0, r.code);
    for (const range of ['5-3', 'x', '02-', '-02', '02-x']) {
        r = fleet(['chips', run, range, 'repo']);
        code(`chips refuses the range '${range}'`, 2, r.code);
    }
    const cz = `${tmp}/chipzero`;
    mk(cz);
    r = fleet(['chips', cz, '3', 'repo']);
    code('a single number is a chip, not a silent exit under set -e', 0, r.code);
    check('and the chip is printed', 'CHIP 03', r.out);
    check('the trailer says a chip is an offer the operator can decline', 'A chip is an offer the operator can decline with one click, so offer every one of them.', r.out);
    check('and that a rule forbidding chips is quoted, never swapped for paste lines', 'never replace chips with paste lines', r.out);
    absent('and the old precedence sentence is gone', 'does not cover them', r.out);
    absent('a repo chip does not ask for a pane on screen', 'browser pane on screen', r.out);
    r = fleet(['chips', cz, '01', 'pane']);
    check('a pane chip does', 'Keep its browser pane on screen', r.out);
}
// ---- lane gaps, workers, budgets; the coordinator's context ----------------------------------------------
{
    const lg = t.tmp('fleet-lanes');
    mk(`${lg}/tasks/ready`, `${lg}/tasks/done`, `${lg}/tasks/claimed`);
    write(`${lg}/tasks/ready/a.md`, fm('task-id: a\nneeds: pane\nbudget: 60'));
    write(`${lg}/tasks/ready/b.md`, fm('task-id: b\nneeds: opus\nbudget: 60'));
    write(`${lg}/tasks/ready/c.md`, fm('task-id: c\nbudget: 60'));
    let r = fleet(['chips', lg, '01', 'repo']);
    check('chips names the lane still without a worker', 'lane pane: 1 task(s) ready, no chip offered', r.out);
    check('and a lane that is no lane', 'needs: opus on 1 task(s) is not a lane', r.out);
    check('as a task to fix, not a chip to offer', 'FIX THE TASK, not the chips', r.out);
    absent('a lane with a chip is not reported', 'lane repo:', r.out);
    fleet(['whoami', lg, '01', 'claude-opus-5-5', 'medium'], { stdoutOnly: true });
    r = fleet(['status', lg]);
    check('status lists each offered worker with its model', '01  lane repo  started no  claude-opus-5-5 medium', r.out);
    check('status repeats the lane gap', '== lanes with work and no worker', r.out);
    write(`${lg}/01.done`, '');
    r = fleet(['status', lg]);
    check('a lane whose only chip wrote .done is a gap again', 'lane repo: 1 task(s) ready, no chip offered', r.out);
    rm(`${lg}/01.done`);
    write(`${lg}/01.blocked`, '');
    r = fleet(['status', lg]);
    check('and so is one whose chip wrote .blocked', 'lane repo: 1 task(s) ready, no chip offered', r.out);
    rm(`${lg}/01.blocked`);
    for (const id of ['d', 'e', 'f']) {
        write(`${lg}/tasks/claimed/${id}/owner`, `chip 01\nclaimed ${nowIso(4 * 60 * 1000)}\n`);
        write(`${lg}/tasks/ready/${id}.md`, fm(`task-id: ${id}\nbudget: 90`));
        write(`${lg}/tasks/done/${id}`, '');
    }
    r = fleet(['status', lg]);
    check('status measures work against budget', '3 tasks done: median', r.out);
    check('and calls loose budgets loose', 'BUDGETS TOO LOOSE', r.out);
    const ch = t.tmp('fleet-home');
    write(`${ch}/projects/p/sess-1.jsonl`, `{"type":"assistant","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":${CK * 1000},"cache_creation_input_tokens":0}}}\n`);
    write(`${lg}/coordinator`, 'sess-1\n');
    const asCh = { env: { CLAUDE_CONFIG_DIR: ch } };
    r = fleet(['ctx', lg], asCh);
    check('ctx speaks past the mark', `COORDINATOR CONTEXT ${CK}K`, r.out);
    r = fleet(['ctx', lg], asCh);
    truthy('and only once per mark', r.out === '', r.out);
    write(`${ch}/projects/p/sess-1.jsonl`, read(`${ch}/projects/p/sess-1.jsonl`)
        + '{"type":"assistant","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":120000}}}\n');
    r = fleet(['ctx', lg], asCh);
    truthy('and is silent under the mark', r.out === '', r.out);
    r = fleet(['status', lg], asCh);
    code('status exits 0 with the coordinator below the handoff mark', 0, r.code);
    check('and still prints its context', '== coordinator context: 120K', r.out);
    // A background command's output past runaway_log_gb is named once. Closed chats left 5 GB of these.
    const rl = `${tmp}/runaway`;
    copyFleet(`${rl}/scripts`);
    write(`${rl}/calibration.json`, '{\n  "runaway_log_gb": 0.000001\n}\n');
    write(`${rl}/tmp/claude/proj/sess-1/tasks/b1.output`, Buffer.alloc(4096));
    const rlEnv = { env: { TMPDIR: `${rl}/tmp`, TEMP: `${rl}/tmp`, TMP: `${rl}/tmp`, CLAUDE_CONFIG_DIR: ch } };
    r = exec('sh', [`${rl}/scripts/fleet.sh`, 'ctx', lg], rlEnv);
    check('ctx names a background log that keeps growing', 'RUNAWAY LOG: ', r.out);
    check('by its file', 'sess-1/tasks/b1.output', r.out);
    r = exec('sh', [`${rl}/scripts/fleet.sh`, 'ctx', lg], rlEnv);
    truthy('and only once', r.out === '', r.out);
    rm(rl, lg, ch);
}
// ---- a lane that is no lane, a branch on finish, a run seen from a worktree's cwd ------------------------
{
    const bl = `${tmp}/badlane`;
    write(`${bl}/tasks/ready/b.md`, fm('task-id: b\nneeds: opus\nbudget: 5'));
    let r = fleet(['drained', bl, '01', 'repo']);
    code('drained refuses over a ready task no lane can claim', 5, r.code);
    check("and names that task's lane", 'needs: opus on 1 task(s) is not a lane', r.out);
    truthy('and writes no .done', !exists(`${bl}/01.done`), '01.done exists');
    r = fleet(['next', bl, '01', 'repo']);
    code('next still reports the queue drained', 3, r.code);
    check('but says which task nobody can claim', 'is not a lane', r.out);
    const fb = `${tmp}/finishbr`;
    for (const id of ['t1', 't2'])
        write(`${fb}/tasks/ready/${id}.md`, fm(`task-id: ${id}\nneeds: repo\nbudget: 5`));
    fleet(['next', fb, '01', 'repo']);
    const fin = fleet(['finish', fb, '01', 't1', 'fleet/01/t1']);
    fleet(['next', fb, '01', 'repo']); // a chip holding a claim is refused a second, so t1 is finished first
    code('finish takes the branch the work was committed on', 0, fin.code);
    const done1 = () => read(`${fb}/tasks/done/t1`).replace(/\r?\n$/, '');
    truthy('and writes it into the done marker', done1() === 'branch fleet/01/t1', done1());
    fleet(['finish', fb, '01', 't2']);
    truthy('without one the marker is empty, as before', exists(`${fb}/tasks/done/t2`) && read(`${fb}/tasks/done/t2`) === '', read(`${fb}/tasks/done/t2`));
    check('a branch that does not resolve is warned about', 'does not resolve', fin.out);
    fleet(['finish', fb, '01', 't1']);
    truthy('a second finish without a branch keeps the branch line', done1() === 'branch fleet/01/t1', done1());
    r = fleet(['chips', run, '00', 'repo']);
    code('chips refuses worker 00', 2, r.code);
    r = fleet(['chips', run, '00-02', 'repo']);
    code('and a range that starts at 00', 2, r.code);
    absent('and prints no chip for it', 'CHIP ', r.out);
    if (exists(`${HOOKS}/run-dir.mjs`)) {
        const rd = `${tmp}/relhook`;
        mk(`${rd}/.claude/worktrees/w/.fleet/r`, `${rd}/plain/.fleet/r`);
        const relof = (cwd, dir) => node(['--input-type=module', '-e',
            'import {pathToFileURL} from "node:url"; const m = await import(pathToFileURL(process.argv[1]).href); process.stdout.write(m.rel(process.argv[2]))',
            `${HOOKS}/run-dir.mjs`, dir], { cwd }).out;
        const wcwd = nativePath(`${rd}/.claude/worktrees/w`);
        const plcwd = nativePath(`${rd}/plain`);
        let o = relof(`${rd}/plain`, `${plcwd}/.fleet/r`);
        truthy('a run under the cwd is printed relative', o === '.fleet/r', o);
        o = relof(`${rd}/.claude/worktrees/w`, `${wcwd}/.fleet/r`);
        truthy('but absolute from inside .claude/worktrees', o === `${wcwd}/.fleet/r`.split('\\').join('/'), o);
        o = relof(`${rd}/plain`, `${plcwd}/.fleet/nope`);
        truthy('and absolute when the relative form would not resolve', o === `${plcwd}/.fleet/nope`.split('\\').join('/'), o);
        rm(rd);
    }
}
// ---- worktree --create -----------------------------------------------------------------------------------
{
    const wr = t.tmp('fleet-wtc');
    const wm = `${wr}/main`;
    const gc = (cwd, ...args) => git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args);
    git(wr, 'init', '-q', 'main');
    gc(wm, 'commit', '-q', '--allow-empty', '-m', 'init');
    mk(`${wm}/node_modules/pkg/node_modules/y`, `${wm}/web/node_modules/x`, `${wm}/apps/web/node_modules/z`);
    write(`${wm}/node_modules/pkg/a`, 'keep\n');
    write(`${wm}/.gitignore`, 'node_modules/\n');
    write(`${wm}/web/index.js`, 'x\n');
    write(`${wm}/apps/web/index.js`, 'y\n');
    git(wm, 'add', '.gitignore', 'web/index.js', 'apps/web/index.js');
    gc(wm, 'commit', '-qm', 'two');
    mk(`${wm}/.fleet/r/tasks/ready`);
    write(`${wm}/.git/info/exclude`, 'foo');
    const main = git(wm, 'rev-parse', '--show-toplevel').out;
    const keep = () => read(`${wm}/node_modules/pkg/a`).replace(/\r?\n$/, '') === 'keep';
    // No global ignore file for this one call: a user whose own excludes already cover .claude/ never reaches the
    // append this case is about.
    let r = fleet(['worktree', '.fleet/r', '02', '--create', 'HEAD'], { cwd: wm, env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    code('a worker with no tree of its own gets one', 0, r.code);
    check('under .claude/worktrees', `WORKTREE ${main}/.claude/worktrees/fleet-`, r.out);
    check('with the dependencies linked', 'linked node_modules', r.out);
    check('and nested ones too', 'linked web/node_modules', r.out);
    check('three levels down, where a monorepo keeps them', 'linked apps/web/node_modules', r.out);
    absent('and never a package inside a node_modules', 'linked node_modules/pkg', r.out);
    check('and registered for clean', 'registered worktree', r.out);
    const ex = read(`${wm}/.git/info/exclude`);
    const exLines = ex.split(/\r?\n/);
    truthy('an exclude file with no final newline keeps its last line', exLines.includes('foo') && exLines.includes('.claude/worktrees/'), ex);
    const st = git(wm, 'status', '--porcelain').out.split('\n').filter((l) => l !== '' && !/.fleet/.test(l)).join('\n');
    truthy('the tree does not show as untracked work in the checkout', st === '', st);
    r = fleet(['worktree', '.fleet/r', '02', '--create', 'HEAD'], { cwd: wm });
    check('a second call reuses it', 'reusing', r.out);
    absent('and links nothing already linked', 'linked ', r.out);
    const wt2 = pathOf(`${wm}/.fleet/r/worktrees/02`);
    fleet(['unlink', wt2]);
    r = fleet(['worktree', '.fleet/r', '02', '--create', 'HEAD'], { cwd: wm });
    check('a tree unlinked before drained gets its links back on reuse', 'linked node_modules', r.out);
    truthy('and the main node_modules is untouched by the relink', keep(), ls(`${wm}/node_modules`));
    r = fleet(['status', '.fleet/r'], { cwd: wt2 });
    code('a relative run directory resolves against the main checkout from a worktree', 0, r.code);
    check('and reads that run', '== claims', r.out);
    r = fleet(['status', '.fleet/nope'], { cwd: wt2 });
    code('one that exists nowhere is still refused', 2, r.code);
    r = fleet(['clean', '.fleet/r'], { cwd: wm });
    check('the dry run names the tree', 'would remove  02', r.out);
    absent('and never a branch named HEAD', 'branch -d HEAD', r.out);
    r = fleet(['clean', '.fleet/r', '--remove'], { cwd: wm });
    check('clean removes a tree left on a commit a branch holds', 'removed  02', r.out);
    truthy("and the main checkout's node_modules survives it", keep(), ls(`${wm}/node_modules`));
    const want = git(wm, 'symbolic-ref', '--short', 'HEAD').out;
    r = fleet(['worktree', '.fleet/r', '03', '--create'], { cwd: wm });
    code('the base may be left out', 0, r.code);
    check("and is the main checkout's current branch", `at ${want}`, r.out);
    const wt3 = pathOf(`${wm}/.fleet/r/worktrees/03`);
    // Never with an empty path: `git -C ""` is this process's directory, and a failed --create once committed
    // "work" into the plugin's own checkout that way (the test runs from the run directory, this guard stays).
    if (wt3.includes('/.claude/worktrees/'))
        gc(wt3, 'commit', '-q', '--allow-empty', '-m', 'work');
    else
        truthy('worktree --create registered a tree', false, `path: '${wt3}'`);
    r = fleet(['clean', '.fleet/r', '--remove'], { cwd: wm });
    check('a detached tree holding a commit no branch has is kept', 'KEEP  03', r.out);
    absent('and its hint never says branch -D HEAD', 'branch -D HEAD', r.out);
    fleet(['worktree', '.fleet/r', '04', '--create', 'HEAD'], { cwd: wm });
    const wt4 = pathOf(`${wm}/.fleet/r/worktrees/04`);
    fleet(['unlink', wt4]);
    if (wt4)
        rm(wt4);
    r = fleet(['worktree', '.fleet/r', '04', '--create', 'HEAD'], { cwd: wm });
    code('a tree deleted by hand is made again', 0, r.code);
    check("rather than reused from git's stale record", `created ${wt4}`, r.out);
    git(wr, 'init', '-q', 'bare');
    gc(`${wr}/bare`, 'commit', '-q', '--allow-empty', '-m', 'init');
    rm(`${wr}/bare/.git/info`);
    mk(`${wr}/bare/.fleet/r`);
    r = fleet(['worktree', '.fleet/r', '01', '--create', 'HEAD'], { cwd: `${wr}/bare` });
    code('a clone with no .git/info still gets its tree', 0, r.code);
    // The links come off before anything is deleted: a removal that follows one empties the main checkout.
    for (const w of [...dirsIn(`${wm}/.claude/worktrees`), ...dirsIn(`${wr}/bare/.claude/worktrees`)])
        fleet(['unlink', w]);
    rm(wr);
}
// ---- clean during a run with an integration branch -------------------------------------------------------
{
    const ci = t.tmp('fleet-ci');
    const cm = `${ci}/main`;
    const gc = (cwd, ...args) => git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args);
    git(ci, 'init', '-q', 'main');
    gc(cm, 'commit', '-q', '--allow-empty', '-m', 'init');
    write(`${cm}/node_modules/p/a`, 'keep\n');
    write(`${cm}/.gitignore`, 'node_modules/\n');
    git(cm, 'add', '.gitignore');
    gc(cm, 'commit', '-qm', 'two');
    git(cm, 'branch', 'integ');
    mk(`${cm}/.fleet/r/tasks/ready`);
    fleet(['worktree', '.fleet/r', '05', '--create', 'integ'], { cwd: cm });
    const w5 = pathOf(`${cm}/.fleet/r/worktrees/05`);
    if (w5) {
        git(w5, 'switch', '-q', '-c', 'fleet/05/t1', 'integ');
        write(`${w5}/a.txt`, 'a\n');
        git(w5, 'add', 'a.txt');
        gc(w5, 'commit', '-qm', 't1');
        git(w5, 'switch', '-q', '-c', 'fleet/05/t2');
        write(`${w5}/b.txt`, 'b\n');
        git(w5, 'add', 'b.txt');
        gc(w5, 'commit', '-qm', 't2');
    }
    gc(cm, 'merge', '-q', '--no-edit', 'integ');
    git(cm, 'branch', '-f', 'integ', 'fleet/05/t2');
    let r = fleet(['clean', '.fleet/r', '--remove'], { cwd: cm });
    check('a tree whose branch is merged into the integration branch is removed mid-run', 'removed  05', r.out);
    truthy("and the main checkout's node_modules survives", read(`${cm}/node_modules/p/a`).replace(/\r?\n$/, '') === 'keep', r.out);
    gc(cm, 'merge', '-q', '--no-edit', 'integ');
    fleet(['worktree', '.fleet/r', '06', '--create', 'integ'], { cwd: cm });
    git(cm, 'branch', 'fleet/06/old', 'integ');
    r = fleet(['clean', '.fleet/r', '--remove'], { cwd: cm });
    check("and a worker's merged task branches are deleted with it", 'branch fleet/06/old deleted (merged)', r.out);
    for (const w of dirsIn(`${cm}/.claude/worktrees`))
        fleet(['unlink', w]);
    rm(ci);
}
// ---- pause: a hard stop the hooks enforce ----------------------------------------------------------------
const pr = t.tmp('fleet-pause');
const pc = `${pr}/config`; // the global paused/ marker lives under the config directory: never the real one
const R = `${pr}/.fleet/r1`;
mk(`${R}/tasks/ready`, pc);
process.env.CLAUDE_CONFIG_DIR = pc;
for (const id of ['t-a', 't-b'])
    write(`${R}/tasks/ready/${id}.md`, `---\ntask-id: ${id}\nneeds: repo\nbudget: 10\n---\nwork\n`);
write(`${R}/tasks/ready/t-c.md`, '---\ntask-id: t-c\nneeds: repo\nafter: t-a\nbudget: 10\n---\nwork\n');
fleet(['chips', R, '03-04', 'repo']);
let p = fleet(['next', R, '03', 'repo'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-w3' } });
check('worker 03 claims t-a', 'CLAIMED t-a', p.out);
p = fleet(['next', R, '04', 'repo'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-w4' } });
check('worker 04 claims t-b', 'CLAIMED t-b', p.out);
p = fleet(['next', R, '03', 'repo'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-w3' } });
code('next for a chip that already holds an open claim exits 2', 2, p.code);
check('and names the held task', 'HOLDING t-a', p.out);
absent('and claims nothing', 'CLAIMED', p.out);
p = fleet(['pause', R, 'operator asked']);
code('pause exits 0', 0, p.code);
check('it says the run is paused', 'PAUSED r1', p.out);
check('and how many workers hold claims', '2 worker(s) hold claims: 03 04', p.out);
check('and which line to watch for the acks', 'stopped/<chip>', p.out);
truthy('PAUSED is written', exists(`${R}/PAUSED`));
check('with the reason', 'operator asked', read(`${R}/PAUSED`));
// resume deletes PAUSED; pauses.log is how fleet-analyze tells a pause from an outage afterwards.
truthy('pauses.log keeps the window with its time and reason', /^paused \d{4}-\S+ operator asked$/m.test(read(`${R}/pauses.log`)), read(`${R}/pauses.log`));
const markers = names(`${pc}/makarasty/paused`).sort();
check("and the global marker holds the run's absolute path", '/.fleet/r1', markers.length ? read(`${pc}/makarasty/paused/${markers[0]}`) : '');
p = fleet(['pause', R]);
check('a second pause keeps the first', 'already paused', p.out);
truthy('and logs no second window', (read(`${R}/pauses.log`).match(/^paused /gm) ?? []).length === 1, read(`${R}/pauses.log`));
p = fleet(['pause', R, '-']);
code('pause - reads its reason from stdin and does not hang on an empty one', 0, p.code);
p = fleet(['next', R, '03', 'repo']);
code('next hands out nothing while paused', 8, p.code);
check('and says so', 'RUN PAUSED', p.out);
check('with the wake loop to background', 'until [ ! -e', p.out);
absent('and claims nothing', 'CLAIMED', p.out);
p = fleet(['drained', R, '03', 'repo']);
code('drained exits 8 while paused', 8, p.code);
truthy('and writes no .done', !exists(`${R}/03.done`), '03.done exists');
absent('and does not tell a paused worker to swap its tab first', 'GIVE YOUR BROWSER MEMORY BACK', p.out);
// A worker whose only calls are answered "paused" is still registered, so the hooks know it.
const chipOf = (s) => read(`${R}/chips/${s}`).replace(/\r?\n$/, '');
fleet(['next', R, '09', 'repo'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-w9' } });
truthy('next registers the session before its paused exit', chipOf('sess-w9') === '09', ls(`${R}/chips`));
fleet(['drained', R, '08', 'repo'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-w8' } });
truthy('and drained does too', chipOf('sess-w8') === '08');
// The coordinator is never registered as a worker, and cannot acknowledge a pause.
write(`${R}/coordinator`, 'sess-cd\n');
fleet(['next', R, '07', 'repo'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-cd' } });
truthy("the coordinator's own session is not registered by next", !exists(`${R}/chips/sess-cd`), 'chips/sess-cd exists');
p = fleet(['paused', R, '07'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-cd' } });
code('paused refuses when the session is the coordinator', 2, p.code);
check('and says why', 'this session is the coordinator', p.out);
rm(`${R}/coordinator`, `${R}/chips/sess-w9`, `${R}/chips/sess-w8`);
p = fleet(['landed', R, '2']);
check('landed refuses a paused run', 'the run is paused', p.out);
touch(`${R}/tasks/claimed/t-a/heartbeat`, OLD);
p = fleet(['sweep', R, '--release']);
code('sweep exits 0 while paused', 0, p.code);
check('and says it reports and reclaims nothing', 'no claim is reported or reclaimed', p.out);
truthy('so a quiet claim is not reclaimed', exists(`${R}/tasks/claimed/t-a`));
// The abort clock must not ring at a worker that was stopped on purpose: with the pause standing it never
// counts a round, so a short clock outlives the timeout; with the pause gone it rings.
const clk = fleet(['clock', R, '03', 't-a', '1'], { stdoutOnly: true }).out
    .split('\n').map((l) => l.replace(`sleep ${POLL}`, 'sleep 0')).join('\n');
p = sh('timeout 3 sh -c "$CLK" 2>&1', { env: { CLK: clk } });
code('the abort clock does not count paused time', 124, p.code);
check('the clock exits on a retired chip', '03.retired', clk);
p = fleet(['status', R]);
check('status names the pause and the count of stopped workers', '== PAUSED since', p.out);
check('as k of n holding claims', '0 of 2 workers holding claims have stopped', p.out);
check('a worker with no ack yet is not called silent early', 'worker 04: no ack yet', p.out);
