// b-hooks-pane-landing.test.mts - the stop hook, the documents and the measurement ledger, the pane broker,
// landing a run, the design canvas gate, the call script gate and worktree cleanup.
//
// The pane broker and the landing read a run that earlier sections filled, so the start of this file
// replays the minimum of that run through fleet.sh: one task still claimed, one worker drained, one major.
import { chmodSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { setup, fleet, node, git, exec, has, nativePath, ROOT, SCRIPTS, HOOKS, check, absent, code, truthy, skip, write, read, exists, mk, rm, touch, OLD, task, junction, } from './lib.mjs';
const t = setup('b');
const run = t.run;
// ---- the run state the earlier sections leave --------------------------------------------------------------
const good166 = '{"area":"lists","severity":"major","observed":"the Completed tab counts 12 and lists 7","evidence":"cases.page.vue:184 slices before counting","mechanism_status":"hypothesis"}';
task(run, 'task-01', 'pane', 20);
task(run, 'task-02', 'repo', 15);
fleet(['next', run, '07', 'repo']);
fleet(['finish', run, '07', 'task-02']);
// task-01 stays claimed by 08 with no done marker: the landing below has to name it.
fleet(['next', run, '08', 'pane']);
for (const line of [good166, '{"unreached":"steps 7-9","reason":"budget exceeded"}', '{"created":"user Ada Test, group QA-2","where":"sandbox company 41"}']) {
    fleet(['find', run, '07'], { input: line });
}
fleet(['drained', run, '07']);
let r = { out: '', code: 0 };
// ---- the hook that sees what no script can -----------------------------------------------------------------
const guard = `${HOOKS}/fleet-guard.mjs`;
if (exists(guard)) {
    mk(`${run}/chips`);
    r = node([guard], { input: JSON.stringify({ session_id: 'sess-1', cwd: dirname(run) }), stdoutOnly: true });
    code('a session with no chip registered is left alone', 0, r.code);
    // A worker holding an unfinished claim, ending its turn: the failure that cost 516 minutes.
    const hookrun = t.tmp('fleet-hook');
    const r1 = `${hookrun}/.fleet/r1`;
    mk(`${r1}/chips`, `${r1}/tasks/claimed/task-05`, `${r1}/tasks/done`);
    // The hook is handed whatever spelling the harness uses, and on Windows that is not the shell's: hand it
    // the operating system's own idea of the directory, which node reports on every platform.
    const hookcwd = nativePath(hookrun);
    write(`${r1}/chips/sess-2`, '07');
    write(`${r1}/tasks/claimed/task-05/owner`, 'chip 07\nclaimed now\n');
    // A Windows path carries backslashes, which have to be escaped inside JSON; JSON.stringify does, where a
    // printf would not and the hook would parse nothing and bail - passing this test for the wrong reason.
    const inJson = JSON.stringify({ session_id: 'sess-2', cwd: hookcwd });
    // stderr alone, as the sh version read it: a Stop hook that exits 2 hands the harness its stderr, so a
    // task id printed only on stdout would never reach the worker.
    const stopped = node([guard], { input: inJson, stderrOnly: true });
    code('a worker ending its turn on an unfinished claim is stopped', 2, stopped.code);
    check('and told which task it still holds', 'task-05', stopped.out);
    r = node([guard], { input: inJson });
    code('the same claim is never blocked twice', 0, r.code);
    // A worker that has written a heartbeat is working, not dying: the hook must leave it alone.
    rm(`${r1}/chips/sess-2.warned-task-05`);
    write(`${r1}/tasks/claimed/task-05/owner`, 'chip 07\nclaimed 2026-08-31T10:00:00\n');
    write(`${r1}/tasks/claimed/task-05/heartbeat`, '2026-08-31T10:04:00\n');
    r = node([guard], { input: inJson });
    code('a worker that has beaten its heartbeat is left alone', 0, r.code);
    // A claim older than the window is a worker doing long work, not one that claimed and walked away.
    rm(`${r1}/chips/sess-2.warned-task-05`, `${r1}/tasks/claimed/task-05/heartbeat`);
    write(`${r1}/tasks/claimed/task-05/owner`, 'chip 07\nclaimed 2026-08-31T10:00:00\n');
    touch(`${r1}/tasks/claimed/task-05`, OLD);
    r = node([guard], { input: inJson });
    code('a claim older than the window is left alone', 0, r.code);
    write(`${r1}/07.done`, '');
    rm(`${r1}/chips/sess-2.warned-task-05`);
    r = node([guard], { input: inJson });
    code('a finished worker is never stopped', 0, r.code);
    r = node([guard], { input: JSON.stringify({ session_id: 'sess-2', cwd: hookcwd, stop_hook_active: true }) });
    code('and it stands down when the harness says it already fired', 0, r.code);
    rm(hookrun);
}
else {
    skip('the hook that sees what no script can', 'no hook script');
}
// ---- the documents point at files that exist ---------------------------------------------------------------
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.name === '.git' || e.name === 'node_modules' ? [] : e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
const broken = [];
for (const f of walk(ROOT).filter((f) => f.endsWith('.md'))) {
    for (const m of read(f).matchAll(/\]\((?!https?:)([^)#]+)\)/g)) {
        const target = m[1] ?? '';
        if (!exists(resolve(dirname(f), target)))
            broken.push(`${basename(f)} -> ${target}`);
    }
}
truthy('every link between the documents resolves', broken.length === 0, broken.join(', '));
// ---- the measurement ledger --------------------------------------------------------------------------------
const led = `${ROOT}/docs/MEASUREMENTS.md`;
if (exists(led)) {
    const ledger = read(led);
    // grep -r over docs/ and commands/: every file, not only the markdown.
    const ruleText = [`${ROOT}/docs`, `${ROOT}/commands`].filter(exists).flatMap(walk).map(read).join('\n');
    const cited = [...new Set([...ruleText.matchAll(/\[(M\d\d)\]/g)].map((m) => m[1] ?? ''))].sort();
    const missing = cited.filter((id) => !new RegExp(`^## ${id} `, 'm').test(ledger));
    truthy('every measurement a rule cites exists in the ledger', missing.length === 0, `missing: ${missing.join(' ')}`);
    const entries = [...ledger.matchAll(/^## (M\d\d)/gm)].map((m) => m[1] ?? '');
    const uncited = entries.filter((id) => !ruleText.includes(`[${id}]`));
    truthy('every ledger entry is cited by a rule', uncited.length === 0, `uncited: ${uncited.join(' ')}`);
}
else {
    skip('the measurement ledger', 'no ledger beside this checkout');
}
// ---- the pane broker ---------------------------------------------------------------------------------------
r = fleet(['pane-ask', run, '07'], { input: 'Walk the Completed tab and report whether its count equals the rows it lists.\n' });
check('a paneless worker can file a browser walk', 'FILED', r.out);
check('and is told where the answer will appear', 'pane/results/07-1.json', r.out);
r = fleet(['pane-next', run, '02']);
code('a pane host claims the oldest walk', 0, r.code);
check('and receives the walk itself', 'Walk the Completed tab', r.out);
r = fleet(['pane-next', run, '03']);
code('a second host finds nothing left to claim', 3, r.code);
const blind = '{"gate":0,"conditions":"1440x900, zoom 100","observations":[]}';
r = fleet(['pane-serve', run, '02', '07-1'], { input: blind });
code('a walk measured through a blind pane is refused', 1, r.code);
check('and says the reading that refused it', 'which is blind', r.out);
const nogate = '{"conditions":"1440x900, zoom 100","observations":[]}';
r = fleet(['pane-serve', run, '02', '07-1'], { input: nogate });
code('a walk with no gate reading at all is refused', 1, r.code);
let good = '{"gate":301,"conditions":"1440x900, zoom 100","observations":[{"observed":"count says 12, rows list 7","evidence":"cases.page.vue:184"}]}';
r = fleet(['pane-serve', run, '02', '07-1'], { input: good });
code('a walk with its gate reading is served', 0, r.code);
const result1 = `${run}/pane/results/07-1.json`;
truthy('and the requester has a file to read', read(result1).length > 0);
truthy('the result names the host that produced it', read(result1).includes('"host":"02"'));
r = fleet(['pane-status', run]);
check('the broker reports its backlog', '0 pending', r.out);
check('and the lease it sizes hosts on, which survives the claim being removed', 'median lease', r.out);
truthy('the served walk carries the time it was claimed', read(result1).includes('"claimed_at"'));
// A walk is claimed with the same mkdir a task is, has no heartbeat, and nothing ever swept `pane/running`:
// a host that died holding one - or one whose result the gate refused - left it unclaimable by everybody
// while its requester waited for an answer nobody could produce.
fleet(['pane-ask', run, '07'], { input: 'Walk the Archived tab.\n' });
fleet(['pane-next', run, '02']);
touch(`${run}/pane/running/07-2/owner`, OLD);
r = fleet(['sweep', run]);
check('a walk nobody is advancing is named by the sweep', 'ABANDONED? walk 07-2', r.out);
fleet(['sweep', run, '--release']);
r = fleet(['pane-next', run, '03']);
code('and --release hands it back to the next host', 0, r.code);
check('which is the walk that was stuck', 'WALK 07-2', r.out);
good = '{"gate":301,"conditions":"1440x900, zoom 100","observations":[]}';
fleet(['pane-serve', run, '03', '07-2'], { input: good });
// "The oldest walk" was the glob's lexical order, which puts `09-10` before `09-2` whatever waited longest.
write(`${run}/pane/requests/09-10.md`, 'Walk the tenth thing.\n');
write(`${run}/pane/requests/09-2.md`, 'Walk the second thing.\n');
touch(`${run}/pane/requests/09-10.md`, new Date(2020, 0, 1, 1, 0));
touch(`${run}/pane/requests/09-2.md`, OLD);
r = fleet(['pane-next', run, '03']);
check('a host is handed the walk that has waited longest, not the first by name', 'WALK 09-2', r.out);
rm(`${run}/pane/requests/09-10.md`, `${run}/pane/requests/09-2.md`, `${run}/pane/running/09-10`, `${run}/pane/running/09-2`);
// ---- landing the run ---------------------------------------------------------------------------------------
r = fleet(['landed', run, '2']);
code('a run with an open claim has not landed', 1, r.code);
check('and the open claim is named', 'claim without a done marker: task-01', r.out);
fleet(['finish', run, '08', 'task-01']);
fleet(['drained', run, '08']);
r = fleet(['landed', run, '2']);
code('a run with no backlog has not landed', 1, r.code);
check('and says so', 'backlog.jsonl is missing', r.out);
fleet(['merge', run]);
truthy('merge writes a backlog from the findings', read(`${run}/backlog.jsonl`).length > 0);
fleet(['render', run]);
truthy('render writes the markdown backlog', read(`${run}/backlog.md`).length > 0);
// A line the merge cannot parse is a finding that would vanish from the backlog.
const findings = read(`${run}/07.jsonl`);
write(`${run}/07.jsonl`, `${findings}{"area":"x","severity":"minor","observed":"y","evidence":"file.ts:1 something long"\n`);
r = fleet(['merge', run]);
code('a torn line refuses the merge rather than vanishing', 1, r.code);
write(`${run}/07.jsonl`, findings);
fleet(['merge', run]);
write(`${run}/03.waiting`, '');
r = fleet(['landed', run, '2']);
check('a worker still waiting on the operator blocks the landing', 'waiting on the operator', r.out);
rm(`${run}/03.waiting`);
// A worker that went blind and then finished writes both markers, and counting the files made one worker
// look like two - a run reading as complete with somebody still out, and a phone told so.
write(`${run}/07.blocked`, '');
r = fleet(['landed', run, '3']);
code('a chip that wrote both a done and a blocked marker is one worker, not two', 1, r.code);
check('and the count says which', '2 of 3 workers finished', r.out);
rm(`${run}/07.blocked`);
r = fleet(['landed', run, '2']);
code('a finished run lands', 0, r.code);
truthy('and leaves the FINISHED file behind as the durable answer', exists(`${run}/FINISHED`));
r = fleet(['summary', run]);
check('the run banner carries a machine readable line', 'fleet-summary: {', r.out);
// The rows walked every chip file while the totals walked `[0-9]*.jsonl`, so a chip id that is not a
// number printed rows full of findings above a total of nothing - and that nothing went to the phone.
write(`${run}/cid-03.jsonl`, '{"area":"lists","severity":"major","observed":"the tab is empty","evidence":"cases.page.vue:184 slices before counting","mechanism_status":"unknown"}\n');
r = fleet(['summary', run]);
check('a chip id that is not a number is counted in the totals, not only in its own row', '"majors":2', r.out);
rm(`${run}/cid-03.jsonl`);
// ---- the design canvas -------------------------------------------------------------------------------------
// The canvas gate is a script for the same reason the finding gate is: an artboard that names no source,
// or claims a measurement through a blind pane, has to be refused somewhere a worker cannot route around.
const cv = `${SCRIPTS}/fleet-canvas.mjs`;
if (exists(cv)) {
    code('design-probe.js parses', 0, node(['--check', `${SCRIPTS}/design-probe.js`]).code);
    code('visual-probe.js parses', 0, node(['--check', `${SCRIPTS}/visual-probe.js`]).code);
    const cdir = t.tmp('fleet-canvas');
    mk(`${cdir}/src`, `${cdir}/design`);
    write(`${cdir}/src/Cases.vue`, 'x');
    const artboard = (p) => write(p, `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet><style>body { margin: 0; } a { color: #000; } a:hover { color: #333; }</style></helmet>
<div style="width: 1440px; height: 900px; background: #fff">Cases</div>
</x-dc>
</body>
</html>
`);
    const canvas = (...args) => node([cv, ...args], { cwd: cdir });
    artboard(`${cdir}/design/Cases.dc.html`);
    r = canvas('check', 'design');
    code('an artboard with no provenance is refused', 1, r.code);
    check('and told what is missing', 'no provenance block', r.out);
    // No `/route` here: Git Bash rewrites an argument that starts with `/` into a path under its own
    // install when sh runs a program, and this case is about the stamp itself. The guard against that
    // rewrite is tested on its own below, with an argument that never had the slash.
    r = canvas('stamp', 'design/Cases.dc.html', '--source', 'src/Cases.vue', '--viewport', '1440x900', '--frames', '301', '--frame', '1440x900');
    code('stamp writes the provenance block', 0, r.code);
    r = canvas('stamp', 'design/Cases.dc.html', '--frames', '4');
    code('a frame count under the gate is refused at the stamp', 1, r.code);
    r = canvas('stamp', 'design/Cases.dc.html', '--frames', '30');
    code('while 30, a live pane on a loaded machine, is not blind [M38]', 0, r.code);
    r = canvas('stamp', 'design/Cases.dc.html', '--route', 'cases');
    code('a route that lost its leading slash is refused at the stamp', 1, r.code);
    check('and the refusal names the Git Bash rewrite', 'MSYS_NO_PATHCONV', r.out);
    r = canvas('check', 'design');
    code('a stamped artboard passes the gate', 0, r.code);
    check('and the check says what it was measured at', 'measured 1440x900', r.out);
    artboard(`${cdir}/design/Ghost.dc.html`);
    canvas('stamp', 'design/Ghost.dc.html', '--source', 'src/Nope.vue');
    r = canvas('check', 'design');
    code('an artboard naming a source file that does not exist is refused', 1, r.code);
    check('by name', 'src/Nope.vue does not exist', r.out);
    rm(`${cdir}/design/Ghost.dc.html`);
    // A `$'` in a title is text, not a replacement pattern; a plain render never goes over its artboard.
    artboard(`${cdir}/Dollar.dc.html`);
    canvas('stamp', 'Dollar.dc.html', '--source', 'src/Cases.vue', '--title', 'Plan A');
    canvas('stamp', 'Dollar.dc.html', '--source', 'src/Cases.vue', '--title', "Pro $' tier");
    const n = read(`${cdir}/Dollar.dc.html`).split('\n').filter((l) => l.includes('<x-dc>')).length;
    truthy("stamp writes a title with $' as it is", n === 1, `${n} <x-dc> lines`);
    artboard(`${cdir}/Upper.DC.html`);
    r = canvas('plain', 'Upper.DC.html');
    truthy('plain on .DC.html writes beside the artboard', exists(`${cdir}/Upper.plain.html`) && read(`${cdir}/Upper.DC.html`).includes('<x-dc>'), `rc ${r.code}: ${r.out}`);
    rm(`${cdir}/Dollar.dc.html`, `${cdir}/Upper.DC.html`, `${cdir}/Upper.plain.html`);
    // `stamp` will not write a blind reading, so plant one by hand: the check has to refuse it on its own.
    write(`${cdir}/design/Blind.dc.html`, `<!doctype html>
<!-- fleet-canvas
source: src/Cases.vue
route: /cases
viewport: 1440x900
frames: 0
-->
<html><head><meta charset="utf-8"><script src="./support.js"></script></head>
<body><x-dc><div>x</div></x-dc></body></html>
`);
    r = canvas('check', 'design');
    code('a measurement claimed through a blind pane is refused', 1, r.code);
    check('with the reading that refused it', 'frames 0 is under the gate', r.out);
    rm(`${cdir}/design/Blind.dc.html`);
    write(`${cdir}/design/Cases.Proposed.dc.html`, read(`${cdir}/design/Cases.dc.html`));
    r = canvas('layout', 'design', '--title', 'Fixture');
    code('layout writes a canvas.json', 0, r.code);
    truthy('and a cover Main.dc.html when there is none', exists(`${cdir}/design/Main.dc.html`));
    check('proposals land on their own page', 'Proposed: Cases.Proposed', r.out);
    const cjson = `${cdir}/design/canvas.json`;
    let gaps = 0;
    try {
        const c = JSON.parse(read(cjson));
        const a = c.artboards;
        for (let i = 0; i < a.length && !gaps; i++)
            for (let j = i + 1; j < a.length; j++) {
                const p = a[i], q = a[j];
                if (!p || !q || (p.page ?? '') !== (q.page ?? ''))
                    continue;
                const gx = Math.max(p.x, q.x) - Math.min(p.x + p.w, q.x + q.w), gy = Math.max(p.y, q.y) - Math.min(p.y + p.h, q.y + q.h);
                if (gx < 80 && gy < 120) {
                    gaps = 1;
                    break;
                }
            }
        if (!gaps && (!c.pages || c.pages.length !== 2))
            gaps = 2;
    }
    catch {
        gaps = 1;
    }
    code('frames on one page keep the gaps the editor needs, and both pages exist', 0, gaps);
    try {
        const c = JSON.parse(read(cjson));
        const cases = c.artboards.find((b) => b.file === 'Cases.dc.html');
        if (cases)
            cases.x = 4321;
        write(cjson, JSON.stringify(c));
    }
    catch { /* the check below reports it */ }
    canvas('layout', 'design', '--title', 'Fixture');
    truthy('a second layout keeps a position the operator moved', read(cjson).includes('"x": 4321'));
    r = canvas('plain', 'design/Cases.dc.html', '--out', `${cdir}/plain.html`);
    code('plain renders a static artboard standalone', 0, r.code);
    absent('and the runtime line is gone from it', 'support.js', read(`${cdir}/plain.html`));
    write(`${cdir}/design/Hole.dc.html`, '<x-dc><div>{{ hole }}</div></x-dc>');
    r = canvas('plain', 'design/Hole.dc.html');
    code('an artboard that needs the runtime cannot be rendered plain', 1, r.code);
    rm(`${cdir}/design/Hole.dc.html`);
    // The seed needs the design skill's helper, which is on a machine only after that skill has run once.
    // Either outcome is asserted: the real helper seeds and checks the page, or the refusal names the reason.
    r = canvas('seed', 'design', '--title', 'Fixture screens', '--out', `${cdir}/fixture-screens.html`);
    if (r.out.includes('SEEDED')) {
        truthy("seed drives the design skill's helper and its check (the skill is on this machine)", true);
        truthy('and the seeded page exists', read(`${cdir}/fixture-screens.html`).length > 0);
    }
    else if (r.out.includes('is not on this machine')) {
        truthy('seed refuses with the reason when the design skill is absent (run /design once to exercise the rest)', true);
    }
    else {
        truthy('seed either seeds or says why it cannot', false, r.out.split('\n').slice(-3).join('\n'));
    }
    rm(cdir);
}
else {
    skip('the design canvas', 'no fleet-canvas.mjs');
}
// ---- the call script ---------------------------------------------------------------------------------------
// The call gate is a script for the reason the canvas gate is: a page that speaks a number no fact
// carries, or a digit in a line meant to be read aloud, has to be refused where a worker cannot route
// around it.
const cl = `${SCRIPTS}/fleet-call.mjs`;
if (exists(cl)) {
    const ldir = t.tmp('fleet-call');
    write(`${ldir}/call/CALL.md`, '# Call\n- Read: ru\n- Speak: en\n');
    write(`${ldir}/call/facts/02-northwind.md`, '## F02-1 · Northwind refuses a third of the second rate checks\n- how known: measured\n- evidence: select count(*) over 2026-07-24..08-12\n- when: 2020-01-01\n\n## F02-2 · the retry helps\n- how known: guess\n- evidence: nobody checked\n- when: 2026-08-20\n');
    // page <data-facts> <spoken line>
    const page = (facts, said) => write(`${ldir}/call/script.html`, `<article class="q" data-facts="${facts}"><div class="say"><span class="lbl">Say</span><p>${said}</p></div></article>\n<table><tr><td class="say-cell">about eight hundred</td></tr></table>\n`);
    const callCheck = (...extra) => node([cl, 'check', ldir, ...extra]);
    page('F02-1', 'About one Northwind check in three comes back with error forty three.');
    r = callCheck();
    code('a page whose every fact resolves and whose lines carry no digit passes', 0, r.code);
    check('and the report counts the facts by how they are known', '1 measured', r.out);
    r = callCheck('--stale', '14');
    check('a measured fact older than the window is listed as stale', 'STALE', r.out);
    code('and is not a refusal', 0, r.code);
    page('F02-1', 'About 1 Northwind check in 3 comes back with error 43.');
    r = callCheck();
    code('a digit in a spoken line is refused', 1, r.code);
    check('and the line is quoted', 'error 43', r.out);
    page('F02-9', 'About one Northwind check in three comes back with error forty three.');
    r = callCheck();
    code('a page citing a fact no file defines is refused', 1, r.code);
    check('by id', 'cites F02-9', r.out);
    page('', 'About one Northwind check in three comes back with error forty three.');
    r = callCheck();
    code('a page citing no fact at all is refused', 1, r.code);
    page('F02-1', 'About one Northwind check in three comes back with error forty three.');
    write(`${ldir}/call/facts/03-bare.md`, '## F03-1 · nothing behind it\n- how known: read\n- when: 2026-08-20\n');
    r = callCheck();
    code('a fact with no evidence is refused', 1, r.code);
    check('by name', 'F03-1 has no evidence', r.out);
    rm(`${ldir}/call/facts/03-bare.md`, `${ldir}/call/CALL.md`);
    r = callCheck();
    code('a run with no CALL.md is refused, because the live chat reads nothing else first', 1, r.code);
    rm(ldir);
}
else {
    skip('the call script', 'no fleet-call.mjs');
}
// ---- worktree cleanup --------------------------------------------------------------------------------------
// The one destructive path in the plugin outside its own scratch. A junction left inside a worktree is a
// hole a recursive delete follows into the main checkout (docs/WORKTREES.md [M32]), so these assert the
// gate: registration refuses a non-worktree path, dry run changes nothing, unpushed work is kept, and a
// clean worktree with a node_modules junction is removed with the main checkout left whole.
if (has('git')) {
    const wl = t.tmp('fleet-wt');
    const main = `${wl}/main`;
    git(wl, 'init', '-q', 'main');
    git(main, 'config', 'user.email', 'a@b');
    git(main, 'config', 'user.name', 't');
    git(main, 'config', 'core.autocrlf', 'false');
    write(`${main}/.gitignore`, 'node_modules\n');
    git(main, 'add', '.gitignore');
    git(main, 'commit', '-qm', 'init');
    // A .claude/worktrees path is the only shape the gate accepts. Make one and put a node_modules junction
    // (or a plain symlink off Windows) into the main checkout's node_modules, which carries a marker file.
    write(`${main}/node_modules/marker.txt`, 'KEEP\n');
    mk(`${main}/.claude/worktrees`);
    const wt = `${main}/.claude/worktrees/wtA`;
    git(main, 'worktree', 'add', '-q', wt, '-b', 'wtA');
    const linkmade = junction(`${wt}/node_modules`, `${main}/node_modules`);
    const wrun = `${main}/.fleet/run`;
    mk(wrun);
    const inMain = { cwd: main };
    // The path gate. Depth is the margin for error: each of these is a shape that a future careless edit
    // could turn into its own parent, and the floor is what stops that landing on a drive root.
    r = fleet(['worktree', wrun, '01', 'C:/wtmerge']);
    code('registering a worktree at a drive root is refused', 2, r.code);
    check('and the reason is its depth', 'too shallow to delete safely', r.out);
    check('and it names the floor', 'the floor is', r.out);
    r = fleet(['worktree', wrun, '01', 'some/relative/path/here']);
    code('registering a relative path is refused', 2, r.code);
    check('because what it points at depends on the cwd', 'is not absolute', r.out);
    r = fleet(['worktree', wrun, '01', '/a/b/../../../etc']);
    code('registering a path with .. is refused', 2, r.code);
    // registration refuses a deep path that is not in the directory this plugin owns
    r = fleet(['worktree', wrun, '01', main]);
    code('registering a non-worktree path is refused', 2, r.code);
    check('and says why', 'is not inside a .claude/worktrees directory', r.out);
    // registration accepts the worktree
    r = fleet(['worktree', wrun, '01', wt]);
    code('registering a worktree path is accepted', 0, r.code);
    truthy('and the registration file is written', exists(`${wrun}/worktrees/01`));
    // dry run lists and changes nothing
    r = fleet(['clean', wrun], inMain);
    check('dry run says it would remove the worktree', 'would remove', r.out);
    truthy('dry run left the worktree in place', exists(wt));
    // a worktree with unpushed commits (no remote at all) is kept, not removed
    write(`${wt}/x`, 'x\n');
    git(wt, 'add', 'x');
    git(wt, 'commit', '-qm', 'x');
    r = fleet(['clean', wrun, '--remove'], inMain);
    check('a worktree with unpushed work is kept', 'KEEP', r.out);
    truthy('and it is still on disk', exists(wt));
    // drop the commit so the branch is merged, then --remove really removes, main node_modules survives
    git(wt, 'reset', '-q', '--hard', 'HEAD~1');
    r = fleet(['clean', wrun, '--remove'], inMain);
    // Not bare "removed": the ignored-files line says "removed with the tree" before the removal is tried.
    check('a clean worktree is removed', 'removed  01:', r.out);
    truthy('and its directory is gone', !exists(wt));
    if (linkmade) {
        truthy("the main checkout's node_modules survived the junction", exists(`${main}/node_modules/marker.txt`), 'marker.txt was deleted through the link');
    }
    else {
        skip("the main checkout's node_modules survived the junction", 'could not create a junction/symlink on this host');
    }
    // A junction one level down is followed by `git worktree remove` exactly as a top-level one is [M32],
    // and the first version of the unlink walked only the top level. This is that bug's regression check.
    const wtN = `${main}/.claude/worktrees/wtN`;
    git(main, 'worktree', 'add', '-q', wtN, '-b', 'wtN');
    mk(`${wtN}/sub`);
    write(`${main}/victimNested/keep.txt`, 'KEEP\n');
    write(`${main}/.gitignore`, 'node_modules\nsub/\n');
    git(main, 'add', '.gitignore');
    git(main, 'commit', '-qm', 'ignore');
    if (junction(`${wtN}/sub/node_modules`, `${main}/victimNested`)) {
        fleet(['worktree', wrun, '03', wtN], inMain);
        r = fleet(['clean', wrun, '--remove'], inMain);
        // The removal has to have happened, or a surviving target proves nothing.
        truthy('the tree with a nested junction is actually removed', !exists(wtN), r.out.slice(0, 140));
        truthy('a junction nested below the top level is unlinked, not followed', exists(`${main}/victimNested/keep.txt`), 'the target was deleted through it');
    }
    else {
        skip('a junction nested below the top level is unlinked, not followed', 'could not create a nested junction on this host');
    }
    // A link that will not unlink is the hole itself, and `clean` used to count the attempt and remove the tree
    // anyway. Deny the unlink, and the tree has to be kept.
    const wtF = `${main}/.claude/worktrees/wtF`;
    git(main, 'worktree', 'add', '-q', wtF, '-b', 'wtF');
    write(`${main}/victimF/keep.txt`, 'KEEP\n');
    if (junction(`${wtF}/node_modules`, `${main}/victimF`)) {
        // A link that will not come off: deleting it is denied (an ACL on Windows, a read-only parent elsewhere),
        // so the unlink fails whatever tries it. A fake `rm` on PATH no longer reaches it: fleet.mjs unlinks in node.
        fleet(['worktree', wrun, '05', wtF], inMain);
        const icacls = has('icacls');
        if (icacls) {
            exec('icacls', [nativePath(`${wtF}/node_modules`), '/L', '/deny', '*S-1-1-0:(DE)']);
            exec('icacls', [nativePath(wtF), '/deny', '*S-1-1-0:(DC)']);
        }
        else {
            chmodSync(wtF, statSync(wtF).mode & ~0o222);
        }
        r = fleet(['clean', wrun, '--remove'], inMain);
        check('a link that would not unlink keeps its tree', 'would not unlink', r.out);
        truthy('and the tree is still on disk', exists(wtF) && statSync(wtF).isDirectory());
        truthy('and nothing was deleted through the link', exists(`${main}/victimF/keep.txt`));
        r = fleet(['unlink', wtF]);
        code('unlink says so with its exit rather than claiming success', 1, r.code);
        check('and names the link', 'STILL LINKED', r.out);
        if (icacls)
            exec('icacls', [nativePath(wtF), '/reset', '/T', '/C', '/L', '/Q']);
        else
            chmodSync(wtF, statSync(wtF).mode | 0o200);
        fleet(['clean', wrun, '--remove'], inMain);
    }
    else {
        skip('a link that would not unlink keeps its tree', 'could not create a junction for the unlink-failure case on this host');
    }
    // A detached-HEAD worktree has commits that belong to no branch, so `git branch -d` cannot object for
    // them. Removing the tree makes them unreachable; the guard has to keep it.
    const wtD = `${main}/.claude/worktrees/wtD`;
    git(main, 'worktree', 'add', '-q', '--detach', wtD);
    write(`${wtD}/d.txt`, 'd\n');
    git(wtD, 'add', 'd.txt');
    git(wtD, 'commit', '-qm', 'detached');
    fleet(['worktree', wrun, '04', wtD], inMain);
    r = fleet(['clean', wrun, '--remove'], inMain);
    check('a detached-HEAD worktree is kept, because nothing can vouch for its commits', 'detached HEAD', r.out);
    truthy('and it is still on disk', exists(wtD) && statSync(wtD).isDirectory());
    git(main, 'worktree', 'remove', '--force', wtD);
    // The unlink is a command a worker can run, and it is gated by the same path rule as everything else.
    r = fleet(['unlink', 'C:/wtmerge']);
    code('unlink refuses a path too shallow to be a worktree', 2, r.code);
    // Every document tells the worker to unlink from inside the tree it is about to leave, and the guard
    // against deleting this shell's own footing refused exactly that: the path and the working directory
    // were the same. `unlink` removes the links inside a tree and never the tree, so standing in it is
    // safe - and it is the step [M32] exists to enforce, which means a refusal here leaves the junctions in.
    const wtU = `${main}/.claude/worktrees/wtU`;
    git(main, 'worktree', 'add', '-q', wtU, '-b', 'wtU');
    mk(`${wtU}/sub`);
    r = fleet(['unlink', wtU], { cwd: `${wtU}/sub` });
    code('unlink runs from inside the tree, which is the only way the documents call it', 0, r.code);
    check('and says what it removed', 'unlinked', r.out);
    r = fleet(['worktree', wrun, '09'], { cwd: wtU });
    code("and a worker registers the tree it is standing in, which is that command's default argument", 0, r.code);
    // The same term still refuses to DELETE the directory this shell is standing in, which is what it is for.
    r = fleet(['clean', wrun, '--remove'], { cwd: wtU });
    check('but a deletion of the tree this shell stands in is still refused', 'working directory', r.out);
    absent('and a tree in its right place is not called STRAY for being the cwd', 'STRAY', r.out);
    truthy('and that tree is still on disk', exists(wtU) && statSync(wtU).isDirectory());
    git(main, 'worktree', 'remove', '--force', wtU);
    git(main, 'branch', '-D', 'wtU');
    // A worktree cleanup can never reach is named rather than ignored, because it sits there forever and
    // only the operator can move it. Build one that is too shallow and check it is reported, never touched.
    git(main, 'worktree', 'add', '-q', `${wl}/stray`, '-b', 'strayB');
    fleet(['worktree', wrun, '02', `${main}/.claude/worktrees/wtA`], inMain);
    r = fleet(['clean', wrun], inMain);
    check('a worktree outside .claude/worktrees is reported as a stray', 'STRAY', r.out);
    truthy('and the stray is left untouched', exists(`${wl}/stray`));
    git(main, 'worktree', 'remove', '--force', `${wl}/stray`);
    git(main, 'worktree', 'prune');
    rm(wl);
}
else {
    skip('worktree cleanup', 'no git');
}
