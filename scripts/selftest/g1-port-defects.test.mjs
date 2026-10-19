// g1-port-defects - defects the TypeScript port found in the old sh, and fixed (first half): the pane broker,
// calibration numbers, owner lines, finish, recover, release, width, stranded, handback, clean and the watch.
import { spawn } from 'node:child_process';
import { rmdirSync, unlinkSync } from 'node:fs';
import { FLEET_SH, ROOT, absent, check, code, copyFleet, exec, execAsync, exists, fleet, git, has, junction, mk, read, rm, setup, sh, SHELL, skip, sleep, touch, OLD, truthy, watchLoop, write, } from './lib.mjs';
const t = setup('g1-port-defects');
const tmp = t.tmp('fleet-gate');
const ident = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const rg = `${tmp}/regress`;
mk(rg);
// The pane broker: a host is a name, not a pattern; null is no walk result; the queue holds files only.
const pb = `${rg}/pane`;
mk(`${pb}/pane/requests`, `${pb}/pane/results`, `${pb}/pane/running/02-1`);
write(`${pb}/pane/running/02-1/owner`, 'host 02\nclaimed 2026-01-01T00:00:00+00:00\n');
let r = fleet(['pane-serve', pb, '0.', '02-1'], { input: '{"gate":61,"conditions":"1440px 100%","observations":[]}' });
code("a host whose name reads as a pattern cannot serve another host's walk", 4, r.code);
r = fleet(['pane-serve', pb, '02', '02-1'], { input: 'null' });
code('a walk result of null is refused, not a crash', 1, r.code);
check('and says it is not one JSON object', 'REFUSED: not one JSON object', r.out);
mk(`${pb}/pane/requests/09-1.md`);
write(`${pb}/pane/requests/.09-2.md`, 'dot\n');
write(`${pb}/pane/requests/09 3.md`, 'spaced\n');
r = fleet(['pane-next', pb, '05']);
code('pane-next hands out a walk whose name has a space', 0, r.code);
check('whole, not split in two', 'WALK 09 3', r.out);
truthy('and never claims a directory', !exists(`${pb}/pane/running/09-1`), 'claimed');
r = fleet(['pane-next', pb, '05']);
code('nor a dotfile pane-status never counts', 3, r.code);
write(`${pb}/pane/results/a.json`, '{"claimed_at":"2026-01-01T00:00:00Z","served_at":"2026-01-01T00:10:00Z"}\n');
write(`${pb}/pane/results/b.json`, 'not json\n');
write(`${pb}/pane/results/c.json`, '{"claimed_at":"2026-01-01T00:00:00Z","served_at":"2026-01-01T00:30:00Z"}\n');
r = fleet(['pane-status', pb]);
check('an unreadable result does not drop the leases after it', 'median lease 30m', r.out);
// A number in the calibration is a number: 1.2.3 used to reach the gate as NaN, and every reading passed.
const cg = `${rg}/cal`;
mk(`${cg}/run/pane/running/02-1`, `${cg}/run/pane/results`, `${cg}/run/pane/requests`);
copyFleet(`${cg}/scripts`);
write(`${cg}/calibration.json`, '{\n  "frame_gate_min_fps": 1.2.3\n}\n');
write(`${cg}/run/pane/running/02-1/owner`, 'host 02\n');
r = exec('sh', [`${cg}/scripts/fleet.sh`, 'pane-serve', `${cg}/run`, '02', '02-1'], { input: '{"gate":4,"conditions":"1440px 100%","observations":[]}' });
code('a calibration value that is no number falls back to the default gate', 1, r.code);
check('which refuses a blind walk', 'blind below 10', r.out);
// Owner lines are matched whole: `achip 07` is not chip 07's claim.
const oc = `${rg}/owner`;
mk(`${oc}/tasks/claimed/t1`, `${oc}/tasks/ready`);
write(`${oc}/tasks/claimed/t1/owner`, 'achip 07\nclaimed x\n');
write(`${oc}/tasks/ready/t1.md`, '---\nkind: verify\n---\n');
r = fleet(['beat', oc, '07', 't1']);
code("a line that only ends in the chip is not that chip's claim", 4, r.code);
// finish without its task file writes no marker and says why; kind:fix with no space is still a fix.
const fm = `${rg}/finish`;
mk(`${fm}/tasks/claimed/t1`, `${fm}/tasks/claimed/t2`, `${fm}/tasks/ready`);
write(`${fm}/tasks/claimed/t1/owner`, 'chip 07\nclaimed x\n');
write(`${fm}/tasks/claimed/t2/owner`, 'chip 07\nclaimed x\n');
r = fleet(['finish', fm, '07', 't1']);
code('finish refuses when the task file is gone', 2, r.code);
check('and says so', 'done marker NOT written for t1', r.out);
truthy('and writes no done marker', !exists(`${fm}/tasks/done/t1`), 'written');
write(`${fm}/tasks/ready/t2.md`, '---\nkind:fix\nneeds: repo\n---\n');
r = fleet(['finish', fm, '07', 't2']);
truthy('kind:fix with no space still needs its proof', r.code !== 0 && !exists(`${fm}/tasks/done/t2`), `rc ${r.code}: ${r.out}`);
// recover: a claim with no chip line is UNKNOWN; a CRLF chip file is that chip; FINISHED keeps its lines.
const rv = `${rg}/recover`;
mk(`${rv}/chips`, `${rv}/tasks/claimed/t1`, `${rv}/tasks/claimed/t2`, `${rv}/tasks/ready`);
write(`${rv}/chips/sess-empty`, '');
write(`${rv}/chips/sess-59`, '59\r\n');
write(`${rv}/tasks/claimed/t1/owner`, 'claimed x\n');
write(`${rv}/tasks/claimed/t2/owner`, 'chip 59\nclaimed x\n');
write(`${rv}/FINISHED`, 'finished x\nworkers 1');
write(`${rg}/cfg/projects/p/another-session.jsonl`, ''); // a corpus, without these sessions
r = fleet(['recover', rv, '--release'], { env: { CLAUDE_CONFIG_DIR: `${rg}/cfg` } });
check('a claim whose owner names no chip is UNKNOWN, not released', 'UNKNOWN t1', r.out);
check('a chip file written with CRLF is that chip', 'holding: t2', r.out);
check('a FINISHED with no final newline keeps its last line apart', '  workers 1\n  Anything listed', r.out);
// One release line per dependent, however often its after: names the task.
const rd = `${rg}/release`;
mk(`${rd}/tasks/claimed/t1`, `${rd}/tasks/ready`);
write(`${rd}/tasks/claimed/t1/owner`, 'chip 01\nclaimed 2020-01-01T00:00:00+00:00\n');
write(`${rd}/tasks/claimed/t1/heartbeat`, '2020-01-01T00:00:00+00:00\n');
write(`${rd}/tasks/ready/t1.md`, '---\nbudget: 1\n---\n');
write(`${rd}/tasks/ready/t2.md`, '---\nafter: t1, t1\n---\n');
for (const p of ['owner', 'heartbeat', ''])
    touch(`${rd}/tasks/claimed/t1${p ? `/${p}` : ''}`, OLD);
r = fleet(['sweep', rd, '--release']);
const released = r.out.split('\n').filter((l) => l.includes('also released t2')).length;
truthy('a dependent named twice is released once', released === 1, `${released} lines: ${r.out}`);
// width: a reserve of 0 is 0, and a census with no number says so.
const wd = `${rg}/width`;
mk(`${wd}/run/tasks/ready`);
copyFleet(`${wd}/scripts`);
write(`${wd}/calibration.json`, '{\n  "operator_reserve_gb": 0\n}\n');
write(`${wd}/load5.mjs`, 'console.log(JSON.stringify({freeGB:5}))\n');
write(`${wd}/loadx.mjs`, 'console.log("{}")\n');
r = exec('sh', [`${wd}/scripts/fleet.sh`, 'width', `${wd}/run`], { env: { FLEET_LOAD: `${wd}/load5.mjs` } });
check('a reserve of 0 GB is kept at 0', 'machine cap 5 (free memory less the 0 GB', r.out);
r = exec('sh', [`${wd}/scripts/fleet.sh`, 'width', `${wd}/run`], { env: { FLEET_LOAD: `${wd}/loadx.mjs` } });
check('a census with no free-memory figure says so', 'the memory census gave no free-memory figure', r.out);
truthy('and prints no NaN', !r.out.includes('NaN') && !r.out.includes('integer expression'), r.out);
// stranded reads a marker's last line even without a newline.
if (has('git')) {
    const sd = `${rg}/stranded`;
    const g = `${sd}/repo`;
    mk(`${sd}/run/tasks/done`, `${sd}/run/worktrees`);
    exec('git', ['init', '-q', '-b', 'int', g]);
    git(g, ...ident, 'commit', '-q', '--allow-empty', '-m', 'root');
    git(g, 'switch', '-q', '-c', 'b1');
    git(g, ...ident, 'commit', '-q', '--allow-empty', '-m', 'w1');
    git(g, 'switch', '-q', 'int');
    write(`${sd}/run/worktrees/integration`, `path ${g}\n`);
    write(`${sd}/run/tasks/done/t1`, 'branch b1');
    r = fleet(['stranded', `${sd}/run`]);
    check('a marker whose only line has no newline is still read', 'not merged t1: branch b1', r.out);
}
// Free text that starts with / reaches the run as written: Git Bash used to turn it into a Windows path.
// Git for Windows' dash converts the argument before fleet.sh can stop it: it ignores MSYS2_ARG_CONV_EXCL.
const ps = `${rg}/slash`;
mk(`${ps}/tasks/ready`);
if (process.platform === 'win32' && SHELL.endsWith('dash')) {
    skip('a pause reason that starts with / is kept as typed', "Git for Windows' dash ignores MSYS2_ARG_CONV_EXCL");
}
else {
    fleet(['pause', ps, '/fix the login first'], { env: { CLAUDE_CONFIG_DIR: `${rg}/cfg` } });
    check('a pause reason that starts with / is kept as typed', '- /fix the login first', read(`${ps}/PAUSED`).split('\n')[0] ?? '');
    fleet(['resume', ps], { env: { CLAUDE_CONFIG_DIR: `${rg}/cfg` } });
}
rm(rg);
// A repository with one empty commit on master, whose .fleet/ and .claude/worktrees/ git never sees.
function repo(dir) {
    const m = `${dir}/main`;
    exec('git', ['init', '-q', '-b', 'master', m]);
    git(m, ...ident, 'commit', '-q', '--allow-empty', '-m', 'init');
    write(`${m}/.git/info/exclude`, `${read(`${m}/.git/info/exclude`)}.fleet/\n.claude/worktrees/\n`);
    return m;
}
// Writes stay inside a linked worktree of the run's own: handback never commits in the main checkout, and
// clean never removes a tree another worktree lives inside.
if (has('git')) {
    const hm = `${tmp}/handback-main`;
    mk(hm);
    let m = repo(hm);
    write(`${m}/operator-wip.txt`, 'x\n');
    git(m, 'add', 'operator-wip.txt');
    write(`${m}/operator-wip.txt`, 'x\ny\n');
    let r1 = `${m}/.fleet/r1`;
    mk(`${r1}/tasks/claimed/t1`, `${r1}/tasks/ready`);
    write(`${r1}/tasks/ready/t1.md`, '---\ntask-id: t1\n---\n');
    write(`${r1}/tasks/claimed/t1/owner`, 'chip 05\n');
    exec('git', ['worktree', 'add', '-q', '--detach', '.claude/worktrees/w1'], { cwd: m });
    fleet(['worktree', '.fleet/r1', '05', `${m}/.claude/worktrees/w1`], { cwd: m });
    rm(`${m}/.claude/worktrees/w1/.git`);
    const before = git(m, 'rev-parse', 'HEAD').out;
    r = fleet(['handback', '.fleet/r1', '05'], { cwd: m, env: { CLAUDE_CONFIG_DIR: `${hm}/cfg` } });
    truthy('handback never commits in the main checkout through a dead tree', git(m, 'rev-parse', 'HEAD').out === before, r.out);
    check('and says the tree is not a worktree of its own', 'is not a worktree of its own', r.out);
    const nm = `${tmp}/nested`;
    mk(nm);
    const n = repo(nm);
    mk(`${n}/.fleet/r1/tasks`);
    exec('git', ['worktree', 'add', '-q', '-b', 'fleet/01/a', '.claude/worktrees/A'], { cwd: n });
    exec('git', ['-C', '.claude/worktrees/A', 'worktree', 'add', '-q', '-b', 'fleet/02/b', `${n}/.claude/worktrees/A/.claude/worktrees/B`], { cwd: n });
    write(`${n}/.claude/worktrees/A/.claude/worktrees/B/work.txt`, 'precious\n');
    if (fleet(['worktree', '.fleet/r1', '01', `${n}/.claude/worktrees/A`], { cwd: n }).code === 0) {
        fleet(['worktree', '.fleet/r1', '02', `${n}/.claude/worktrees/A/.claude/worktrees/B`], { cwd: n });
    }
    r = fleet(['clean', '.fleet/r1', '--remove'], { cwd: n });
    truthy('clean never removes a tree another worktree lives inside', exists(`${n}/.claude/worktrees/A/.claude/worktrees/B/work.txt`), r.out);
    check('and says why it kept it', 'holds another worktree', r.out);
    // A finish that lands while handback commits the tree's unsaved work wins: the task is not filed again.
    const hd = `${tmp}/handback-done`;
    mk(hd);
    m = repo(hd);
    exec('git', ['worktree', 'add', '-q', '-b', 'fleet/01/t1', '.claude/worktrees/w'], { cwd: m });
    r1 = `${m}/.fleet/r1`;
    mk(`${r1}/tasks/claimed/t1`, `${r1}/tasks/ready`, `${r1}/worktrees`);
    write(`${r1}/tasks/ready/t1.md`, '---\ntask-id: t1\n---\n');
    write(`${r1}/tasks/claimed/t1/owner`, 'chip 01\nclaimed x\n');
    write(`${r1}/worktrees/01`, `path ${m}/.claude/worktrees/w\nbranch fleet/01/t1\nchip 01\n`);
    write(`${m}/.claude/worktrees/w/u.txt`, 'u\n');
    write(`${m}/.git/hooks/pre-commit`, `#!/bin/sh\nsh "${FLEET_SH}" finish "${r1}" 01 t1 >/dev/null 2>&1\nexit 0\n`);
    r = fleet(['handback', r1, '01'], { env: { CLAUDE_CONFIG_DIR: `${hd}/cfg` } });
    truthy("a task finished during handback's commit is not filed again", exists(`${r1}/tasks/done/t1`) && !exists(`${r1}/tasks/ready/t1-r1.md`), r.out);
    check('and handback says it was finished', 'finished it meanwhile', r.out);
    // A registered path that is a junction (a symlink off Windows) to a linked worktree is that worktree.
    const hj = `${tmp}/handback-junction`;
    mk(hj);
    m = repo(hj);
    exec('git', ['worktree', 'add', '-q', '-b', 'fleet/01/t1', '.claude/worktrees/real'], { cwd: m });
    const link = `${m}/.claude/worktrees/link`;
    if (junction(link, `${m}/.claude/worktrees/real`)) {
        r1 = `${m}/.fleet/r1`;
        mk(`${r1}/tasks/claimed/t1`, `${r1}/tasks/ready`, `${r1}/worktrees`);
        write(`${r1}/tasks/ready/t1.md`, '---\ntask-id: t1\n---\n');
        write(`${r1}/tasks/claimed/t1/owner`, 'chip 01\nclaimed x\n');
        write(`${r1}/worktrees/01`, `path ${link}\nbranch fleet/01/t1\nchip 01\n`);
        write(`${m}/.claude/worktrees/real/u.txt`, 'u\n');
        r = fleet(['handback', r1, '01'], { env: { CLAUDE_CONFIG_DIR: `${hj}/cfg` } });
        check('handback commits the unsaved work of a tree reached through a junction', 'COMMITTED the unsaved work of 01', r.out);
        const st = git(`${m}/.claude/worktrees/real`, 'status', '--porcelain').out;
        truthy('and the tree is clean after it', st === '', st);
        // The link itself goes, never what it points at: unlink, or rmdir for a junction that refuses unlink.
        try {
            unlinkSync(link);
        }
        catch {
            try {
                rmdirSync(link);
            }
            catch { /* gone already */ }
        }
    }
    else {
        const why = 'no junction or symlink could be made here';
        skip('handback commits the unsaved work of a tree reached through a junction', why);
        skip('and the tree is clean after it', why);
    }
    // clean keeps work the repository's config hides from a plain `git status`, and a tree a process stands in.
    const hc = `${tmp}/clean-hidden`;
    mk(hc);
    m = `${hc}/main`;
    const w = `${m}/.claude/worktrees/w1`;
    exec('git', ['init', '-q', '-b', 'master', m]);
    write(`${m}/conf`, 'base\n');
    git(m, 'add', 'conf');
    git(m, ...ident, 'commit', '-q', '-m', 'init');
    write(`${m}/.git/info/exclude`, `${read(`${m}/.git/info/exclude`)}.fleet/\n.claude/worktrees/\n`);
    mk(`${m}/.fleet/r1/tasks`);
    if (exec('git', ['worktree', 'add', '-q', '--detach', '.claude/worktrees/w1'], { cwd: m }).code === 0) {
        fleet(['worktree', '.fleet/r1', '01', w], { cwd: m });
    }
    git(m, 'config', 'status.showUntrackedFiles', 'no');
    write(`${w}/notes.txt`, 'x\n');
    r = fleet(['clean', '.fleet/r1', '--remove'], { cwd: m });
    truthy('clean keeps an untracked file status.showUntrackedFiles=no hides', exists(`${w}/notes.txt`), r.out);
    git(m, 'config', '--unset', 'status.showUntrackedFiles');
    rm(`${w}/notes.txt`);
    git(w, 'update-index', '--assume-unchanged', 'conf');
    write(`${w}/conf`, `${read(`${w}/conf`)}edited\n`);
    r = fleet(['clean', '.fleet/r1', '--remove'], { cwd: m });
    truthy('and an edit to a file marked assume-unchanged', read(`${w}/conf`).includes('edited'), r.out);
    git(w, 'update-index', '--no-assume-unchanged', 'conf');
    git(w, 'checkout', '-q', 'conf');
    if (has('cmd')) {
        const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { cwd: w, stdio: 'ignore' });
        const gone = new Promise((done) => { holder.on('close', () => done()); });
        sleep(1);
        r = fleet(['clean', '.fleet/r1', '--remove'], { cwd: m });
        holder.kill();
        await gone;
        check('clean leaves a tree a process stands in', 'is in use', r.out);
        truthy('with its files', exists(`${w}/conf`), exec('ls', ['-A', w]).out);
    }
    r = fleet(['clean', '.fleet/r1', '--remove'], { cwd: m });
    check('and removes it once nothing holds it', 'removed  01', r.out);
    // Ignored files are named even when status.showUntrackedFiles=no; a sparse checkout is not work.
    const w2 = `${m}/.claude/worktrees/w2`;
    write(`${m}/.gitignore`, 'secret.env\n');
    if (git(m, 'add', '.gitignore').code === 0 && git(m, ...ident, 'commit', '-q', '-m', 'ignore').code === 0
        && exec('git', ['worktree', 'add', '-q', '--detach', '.claude/worktrees/w2'], { cwd: m }).code === 0) {
        fleet(['worktree', '.fleet/r1', '02', w2], { cwd: m });
    }
    write(`${w2}/secret.env`, 'S\n');
    git(m, 'config', 'status.showUntrackedFiles', 'no');
    r = fleet(['clean', '.fleet/r1'], { cwd: m });
    check('clean names an ignored file under status.showUntrackedFiles=no', 'secret.env', r.out);
    git(m, 'config', '--unset', 'status.showUntrackedFiles');
    rm(`${w2}/secret.env`);
    git(w2, 'sparse-checkout', 'set', '--no-cone', '.gitignore');
    if (!exists(`${w2}/conf`)) {
        r = fleet(['clean', '.fleet/r1'], { cwd: m });
        check('and a sparse tree with nothing new is removable', 'would remove  02', r.out);
    }
    // A tree a killed removal left without its .git is named, never read through to the main checkout.
    const w3 = `${m}/.claude/worktrees/w3`;
    if (exec('git', ['worktree', 'add', '-q', '--detach', '.claude/worktrees/w3'], { cwd: m }).code === 0) {
        fleet(['worktree', '.fleet/r1', '03', w3], { cwd: m });
    }
    rm(`${w3}/.git`);
    r = fleet(['clean', '.fleet/r1', '--remove'], { cwd: m });
    check('clean names a tree a killed removal left half deleted', 'PARTLY removed  03', r.out);
    r = fleet(['unlink', w3]);
    code('unlink works on that tree, as clean tells the operator', 0, r.code);
    check('and unlinks the tree, not the main checkout', 'main/.claude/worktrees/w3', r.out);
    // A chip id is a name, never a path out of the run.
    r = fleet(['worktree', '.fleet/r1', '../FINISHED', w2], { cwd: m });
    code('worktree refuses a chip id with a path in it', 2, r.code);
    truthy('and writes nothing outside the run', !exists(`${m}/.fleet/FINISHED`), 'written');
    // A creation killed half way (locked 'initializing', files missing) is made again, not handed out.
    const wt5 = (/^WORKTREE (.*)$/m.exec(fleet(['worktree', '.fleet/r1', '05', '--create', 'HEAD'], { cwd: m }).out)?.[1] ?? '').replace(/\r$/, '');
    if (wt5 && exists(`${wt5}/conf`)) {
        git(m, 'worktree', 'lock', '--reason', 'initializing', wt5);
        rm(`${wt5}/conf`);
        r = fleet(['worktree', '.fleet/r1', '05', '--create', 'HEAD'], { cwd: m });
        check('a half-made tree is made again', 'a creation had stopped half way', r.out);
        truthy('with its files back', exists(`${wt5}/conf`), exec('ls', ['-A', wt5]).out);
    }
    else {
        truthy('worktree --create made a tree for the half-made case', false, `'${wt5}'`);
    }
    rm(hm, nm, hd, hj, hc);
}
// handback renames a dependency spelled with no space after the colon, rather than dropping it.
const hs = `${tmp}/handback-nospace`;
mk(`${hs}/tasks/claimed/t-a`, `${hs}/tasks/ready`);
write(`${hs}/tasks/claimed/t-a/owner`, 'chip 05\nclaimed x\n');
write(`${hs}/tasks/ready/t-a.md`, '---\ntask-id: t-a\nneeds: repo\n---\n');
write(`${hs}/tasks/ready/t-d.md`, '---\ntask-id: t-d\nafter:t-a\n---\n');
fleet(['handback', hs, '05'], { env: { CLAUDE_CONFIG_DIR: `${tmp}/hs-cfg` } });
const td = read(`${hs}/tasks/ready/t-d.md`);
truthy('handback renames after:t-a, written with no space', /^after: t-a-r1$/m.test(td), td);
rm(hs, `${tmp}/hs-cfg`);
// A run has one watch: arming a second ends the first, and the second does not repeat what the first said.
if (has('timeout')) {
    // A project with an empty run r, and the watch loop of fleet-wait.md pointed at it for n workers.
    const watchDir = (name, n, ...dirs) => {
        const dir = `${tmp}/${name}`;
        mk(...dirs.map((d) => `${dir}/.fleet/r/${d}`));
        write(`${dir}/loop.sh`, watchLoop().split('\n').map((l) => l.replace(/^run=RUNID; n=N/, `run=r; n=${n}`)).join('\n'));
        return dir;
    };
    const env = { CLAUDE_CODE_SESSION_ID: undefined, CLAUDE_PLUGIN_ROOT: ROOT };
    const watch = (dir, secs) => sh(`timeout ${secs} sh loop.sh`, { cwd: dir, env }).out;
    let ww = watchDir('twowatch', 99, 'tasks/done', 'tasks/ready');
    write(`${ww}/.fleet/r/tasks/done/d1`, '');
    const firstRun = execAsync('sh', ['-c', 'timeout 25 sh loop.sh > first.out 2>&1'], { cwd: ww, env });
    sleep(4);
    const second = watch(ww, 18);
    await firstRun;
    const first = read(`${ww}/first.out`);
    check('the first watch announces what nobody had', 'task finished: ', first);
    check('and ends once a second watch is armed on the run', 'watch superseded', first);
    absent('and the second does not announce it again', 'done/d1', second);
    rm(ww);
    // What an older watch marked seen, from the cwd (.fleet/r/...) or absolute, is not announced again.
    ww = watchDir('oldseen', 99, 'tasks/done', 'tasks/ready');
    write(`${ww}/.fleet/r/tasks/done/d1`, '');
    write(`${ww}/.fleet/r/tasks/done/d2`, '');
    // The absolute spelling sh's own pwd gives, as the loop sees it.
    const abs = (dir) => sh('pwd', { cwd: dir }).out;
    write(`${ww}/.fleet/r/.watch-seen`, `.fleet/r/tasks/done/d1\n${abs(ww)}/.fleet/r/tasks/done/d2\n`);
    absent("a watch armed over an older watch's seen file repeats nothing", 'task finished', watch(ww, 6));
    rm(ww);
    // A worker blind a second time writes .waiting again: the watch announces it again.
    ww = watchDir('rewait', 99, 'tasks/done', 'tasks/ready');
    write(`${ww}/.fleet/r/01.waiting`, 'blind again\n');
    write(`${ww}/.fleet/r/.watch-seen`, '01.waiting@1\n');
    check('a .waiting written again after the first was seen is announced again', 'NEEDS OPERATOR', watch(ww, 6));
    write(`${ww}/.fleet/r/.watch-seen`, `${abs(ww)}/.fleet/r/01.waiting\n`);
    absent('but not one an older watch announced already', 'NEEDS OPERATOR', watch(ww, 6));
    rm(ww);
    // A project path with a space in it: the watch still sees the run's files.
    ww = watchDir('space watch', 1, 'tasks/done', 'tasks/ready');
    write(`${ww}/.fleet/r/tasks/done/d1`, '');
    write(`${ww}/.fleet/r/01.done`, '');
    const spaced = watch(ww, 15);
    check('the watch in a path with a space sees a finished task', 'task finished', spaced);
    check('and the run complete', 'run complete: 1 of 1', spaced);
    rm(ww);
    // A retire's replacement counts at once: the old worker's .retired is no completion while it waits.
    ww = watchDir('replwatch', 1, 'tasks/ready', 'offered', 'replaced', 'chips');
    write(`${ww}/.fleet/r/offered/01`, 'repo\n');
    write(`${ww}/.fleet/r/offered/02`, 'repo\n');
    write(`${ww}/.fleet/r/chips/s1`, '01\n');
    const repl = execAsync('sh', ['-c', 'timeout 15 sh loop.sh > repl.out 2>&1'], { cwd: ww, env });
    sleep(3);
    write(`${ww}/.fleet/r/replaced/01`, '02\n');
    write(`${ww}/.fleet/r/01.retired`, 'retired\n'); // between two ticks
    await repl;
    absent("the watch waits for a retire's replacement", 'run complete', read(`${ww}/repl.out`));
    // Nor while the run is paused: a relaunch hands workers back before their replacements exist.
    rm(`${ww}/.fleet/r/replaced/01`, `${ww}/.fleet/r/offered/02`);
    write(`${ww}/.fleet/r/PAUSED`, 'relaunch\n');
    const paused = watch(ww, 6);
    absent('the watch calls no run complete while it is paused', 'run complete', paused);
    check('but says once that every worker landed under the pause', 'BUT THE RUN IS PAUSED', paused);
    rm(ww);
}
