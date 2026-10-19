// c-gate-contract-merge.test.mts - the stage between a finding and a change: fleet-gate.mjs (clusters, proof,
// asks, surface), the fleet-contract.mjs PreToolUse gate, then the merge, the retro and the canvas seed.

import { setup, SCRIPTS, HOOKS, node, git, hp, nativePath, check, absent, code, starts, truthy, skip, write, read, exists, mk, rm } from './lib.mts';
import { readFileSync, utimesSync } from 'node:fs';

const t = setup('c-gate-contract-merge');

// These cases build their own fixtures rather than reusing $run: the proof gate compares the state of a
// git tree before a change against its state after one, so they need a checkout of their own to move.
const tmp = t.tmp('fleet-gate');

// --- fleet-gate.mjs: the judgement stage -----------------------------------------------------------
// G is the gate script beside fleet.sh, run from the checkout it judges.

const G = `${SCRIPTS}/fleet-gate.mjs`;
const gate = `${tmp}/gate`;
const gn = (args: string[], cwd = gate, env?: Record<string, string | undefined>) => node([G, ...args], { cwd, env });

// A run whose backlog holds one real cluster - two areas reaching one file - and one finding that reaches
// nothing else. The cluster is what a root task is for; the loner must be left alone.
const gr = `${gate}/.fleet/r1`;
write(`${gr}/backlog.jsonl`,
  '{"id":"f-1","severity":"blocker","area":"login","observed":"session drops on refresh","mechanism":"the sessionStore write is not awaited","evidence":"src/auth/session.ts:42","repro":"npm test -- session"}\n'
  + '{"id":"f-2","severity":"major","area":"export","observed":"export loses the last row","mechanism":"the sessionStore write is not awaited","evidence":"src/auth/session.ts:51","repro":"npm test -- export"}\n'
  + '{"id":"f-3","severity":"major","area":"billing","observed":"invoice total rounds down","mechanism":"integer division","evidence":"src/billing/total.ts:9","repro":"npm test -- billing"}\n');

let out = gn(['cluster', '.fleet/r1']).out;
check('two areas reaching one file are one candidate root', '1 candidate root', out);
out = read(`${gr}/clusters.md`);
check('and the root names the file they share', 'src/auth/session.ts', out);
absent('a finding nothing else reaches is not put under a root', 'f-3', out);

// The queue. One task per finding, as fixqueue writes them, then the gate wires the root in front.
const q = `${gate}/.fleet/fix-r1/tasks/ready`;
for (const f of ['1', '2', '3']) {
  write(`${q}/task-00${f}-area.md`, `---\ntask-id: task-00${f}-area\nkind: fix\nfinding-id: f-${f}\nseverity: major\nneeds: repo\nbase: main\nbudget: 25\nrepro: npm test -- f${f}\n---\n\n# area\n\n## Done when\n\n- something\n`);
}
out = gn(['cluster', '.fleet/r1', '--queue', '.fleet/fix-r1']).out;
check('the root task is written into the queue', '1 root task(s) written', out);
check('and its members are gated behind it', '2 task(s) gated', out);
check('the root task owns the shared seam', 'kind: root', read(`${q}/task-root-001.md`));
check('and says which tasks wait on it', 'gates: [task-001-area, task-002-area]', read(`${q}/task-root-001.md`));
check('and starts from the base its members share', 'base: main', read(`${q}/task-root-001.md`));
check('a member waits for the root', 'after: task-root-001', read(`${q}/task-001-area.md`));
check('and is told to re-run its reproduction first', 'it may already pass', read(`${q}/task-001-area.md`));
absent('an ungrouped task is not gated', 'after:', read(`${q}/task-003-area.md`));
// A root proves its seam fix: before fails only while every member reproduces, after passes once one is resolved.
check('the root joins its members with ||', '\nrepro: (npm test -- f1) || (npm test -- f2)\n---', read(`${q}/task-root-001.md`));
check('and its brief says the proof is of the seam fix', 'It proves the seam fix, not each member', read(`${q}/task-root-001.md`));

// A second run over the same queue must not gate a task twice, or it can never be claimed.
// One member here has no command reproduction, so the rewritten root has none either.
write(`${q}/task-002-area.md`, read(`${q}/task-002-area.md`).replace(/^repro: .*$/m, 'repro:'));
out = gn(['cluster', '.fleet/r1', '--queue', '.fleet/fix-r1']).out;
check('running the gate twice does not gate a task twice', '0 task(s) gated', out);
check('a root whose member has no command reproduction gets none', '\nrepro:\n---', read(`${q}/task-root-001.md`));
// A member's ` # note` would comment out every member joined after it, so that root gets none either.
write(`${q}/task-002-area.md`, read(`${q}/task-002-area.md`).replace(/^repro:.*$/m, 'repro: npm test -- f2 # flaky'));
gn(['cluster', '.fleet/r1', '--queue', '.fleet/fix-r1']);
check('a root whose member repro has a # comment gets none', '\nrepro:\n---', read(`${q}/task-root-001.md`));

// prove / check: a fix arrives with a reproduction that failed before it and passes after it.
mk(`${gate}/.fleet/r1/tasks/claimed/task-001-area`);
git(gate, 'init', '-q', '.');
git(gate, 'config', 'user.email', 't@t');
git(gate, 'config', 'user.name', 't');
write(`${gate}/f.txt`, 'one\n');
git(gate, 'add', '-A');
git(gate, 'commit', '-qm', 'one');

const prove = (task: string, phase: string, ...cmd: string[]) => gn(['prove', '.fleet/r1', task, phase, '--', ...cmd]);
const gcheck = (task: string) => gn(['check', '.fleet/r1', task]).out;

out = gcheck('task-001-area');
check('a task with no proof is refused', 'no reproduction was recorded before', out);

out = prove('task-001-area', 'before', 'grep -q two f.txt').out;
check('a failing reproduction is recorded', 'before: exit 1', out);
out = gcheck('task-001-area');
check('and the task is still refused until there is an after', 'no reproduction was recorded after', out);

prove('task-001-area', 'after', 'grep -q two f.txt');
out = gcheck('task-001-area');
check('a reproduction that still fails is refused', 'still fails after the change', out);

// The tree has to have moved. A green over the same bytes that were red is the false green a dead build
// daemon produced on a real run: BUILD SUCCESSFUL over a tree whose fix had been reverted.
write(`${gate}/f.txt`, 'two\n');
git(gate, 'add', '-A');
git(gate, 'commit', '-qm', 'two');
prove('task-001-area', 'after', 'grep -q two f.txt');
out = gcheck('task-001-area');
check('red before, green after, over a tree that changed', 'PROVEN task-001-area', out);

git(gate, 'revert', '--no-edit', '-q', 'HEAD');
write(`${gate}/f.txt`, 'two\n');
out = prove('task-001-area', 'before', 'grep -q two f.txt').out;
check('a reproduction that passes before the change is a refutation', 'refuted, not fixed', out);

// A green whose tree is identical to the red one proves nothing, whatever the exit code says. This is the
// false green a dead build daemon produced on a real run - BUILD SUCCESSFUL over a tree whose fix had been
// reverted - and only a forced rebuild found it. Nothing here touches the checkout between the two runs.
const marker = `${tmp}/outside-marker`;
rm(marker);
mk(`${gate}/.fleet/r1/tasks/claimed/task-002-area`);
prove('task-002-area', 'before', `test -f "${marker}"`);
write(marker, '');
prove('task-002-area', 'after', `test -f "${marker}"`);
out = gcheck('task-002-area');
check('a pass over an unchanged tree proves nothing', 'byte for byte what it was', out);
// Nor does one whose only change is a file the reproduction wrote itself (a log, a snapshot); a real fix
// beside such a file still proves.
rm(marker); mk(`${gate}/.fleet/r1/tasks/claimed/task-004-area`);
const rep = `${tmp}/rep.js`;
write(rep, 'const fs = require("fs"); fs.writeFileSync("run.log", String(process.hrtime.bigint())); process.exit(fs.existsSync(process.argv[2]) ? 0 : 1);\n');
prove('task-004-area', 'before', 'node', rep, marker);
write(marker, '');
prove('task-004-area', 'after', 'node', rep, marker);
out = gcheck('task-004-area');
check('a log the reproduction writes is not a change', 'byte for byte what it was', out);
write(`${gate}/fix.txt`, 'fixed\n');
prove('task-004-area', 'after', 'node', rep, marker);
out = gcheck('task-004-area');
check('a real change beside that log still proves', 'PROVEN task-004-area', out);
rm(`${gate}/run.log`, `${gate}/fix.txt`);
// A fix in a file the reproduction also rewrites (a formatter, codegen) still proves.
mk(`${gate}/.fleet/r1/tasks/claimed/task-005-area`);
const fmt = `${tmp}/fmt.js`;
write(fmt, 'const fs = require("fs"); const s = fs.readFileSync("fmt.txt", "utf8"); fs.writeFileSync("fmt.txt", s.trim() + "\\n"); process.exit(/good/.test(s) ? 0 : 1);\n');
write(`${gate}/fmt.txt`, 'bad  ');
prove('task-005-area', 'before', 'node', fmt);
write(`${gate}/fmt.txt`, 'good  ');
prove('task-005-area', 'after', 'node', fmt);
out = gcheck('task-005-area');
check('a fix in a file the reproduction rewrites proves', 'PROVEN task-005-area', out);
rm(`${gate}/fmt.txt`);
// Run from a subdirectory, prove still sees a fix made outside it.
mk(`${gate}/sub`, `${gate}/.fleet/r1/tasks/claimed/task-006-area`); rm(marker);
gn(['prove', '../.fleet/r1', 'task-006-area', 'before', '--', 'node', rep, marker], `${gate}/sub`);
write(marker, ''); write(`${gate}/other.txt`, 'fixed\n');
gn(['prove', '../.fleet/r1', 'task-006-area', 'after', '--', 'node', rep, marker], `${gate}/sub`);
out = gn(['check', '../.fleet/r1', 'task-006-area'], `${gate}/sub`).out;
check('prove from a subdirectory sees a fix outside it', 'PROVEN task-006-area', out);
rm(`${gate}/sub`, `${gate}/other.txt`, `${gate}/run.log`);
// A second `after` is not a fix because the first one wrote a log: only a change between runs counts.
mk(`${gate}/.fleet/r1/tasks/claimed/task-007-area`);
const flaky = `${tmp}/flaky.js`;
write(flaky, 'const fs = require("fs"); fs.appendFileSync("run.log", "x\\n"); process.exit(fs.readFileSync("run.log", "utf8").length >= 6 ? 0 : 1);\n');
for (const ph of ['before', 'after', 'after']) prove('task-007-area', ph, 'node', flaky);
out = gcheck('task-007-area');
check('a flaky pass on a second after over no change proves nothing', 'byte for byte what it was', out);
rm(`${gate}/run.log`);
// A fix made and reverted again leaves the green run on the red one's bytes; so does a commit of nothing new.
mk(`${gate}/.fleet/r1/tasks/claimed/task-010-area`); rm(marker); write(`${gate}/rv.txt`, 'orig\n');
prove('task-010-area', 'before', 'node', rep, marker);
write(`${gate}/rv.txt`, 'fixed\n');
prove('task-010-area', 'after', 'node', rep, marker);
write(`${gate}/rv.txt`, 'orig\n'); write(marker, '');
prove('task-010-area', 'after', 'node', rep, marker);
out = gcheck('task-010-area');
check('a fix reverted before the green run proves nothing', 'byte for byte what it was', out);
mk(`${gate}/.fleet/r1/tasks/claimed/task-011-area`); rm(marker);
prove('task-011-area', 'before', 'node', rep, marker);
git(gate, 'add', 'rv.txt'); git(gate, 'commit', '-qm', 'checkpoint'); write(marker, '');
prove('task-011-area', 'after', 'node', rep, marker);
out = gcheck('task-011-area');
check('a commit that changes no byte proves nothing', 'byte for byte what it was', out);
mk(`${gate}/.fleet/r1/tasks/claimed/task-011-area/proof.lock`);
let rc = prove('task-011-area', 'after', 'node', rep, marker).code;
code('a second prove on one claim at once is refused', 2, rc);
// The pid of a node that has already exited: a lock whose owner is dead.
write(`${gate}/.fleet/r1/tasks/claimed/task-011-area/proof.lock/pid`, node(['-e', 'process.stdout.write(String(process.pid))']).out);
rc = prove('task-011-area', 'after', 'node', rep, marker).code;
code("a killed prove's lock is taken over at once", 0, rc);
// In the one shared checkout another task's edit lands between the runs too: with `owns:`, only the task's
// own paths count as its fix.
mk(`${gate}/.fleet/r1/tasks/claimed/task-012-area`); rm(marker);
write(`${gate}/.fleet/r1/tasks/ready/task-012-area.md`, '---\ntask-id: task-012-area\nkind: fix\nowns: [own/, "./mine.txt"]\n---\n\n# a fix\n');
prove('task-012-area', 'before', 'node', rep, marker);
write(`${gate}/theirs.txt`, 'another task\n'); write(marker, '');
prove('task-012-area', 'after', 'node', rep, marker);
out = gcheck('task-012-area');
check("another task's edit outside owns: is not this task's fix", 'nothing the task owns changed', out);
check('and the edit is named', 'theirs.txt', out);
write(`${gate}/own/a.txt`, 'fixed\n');
prove('task-012-area', 'after', 'node', rep, marker);
out = gcheck('task-012-area');
check('an edit inside owns: proves', 'PROVEN task-012-area', out);
absent('and only the owned path is named', 'theirs.txt', out);
rm(`${gate}/own`, `${gate}/theirs.txt`, `${gate}/run.log`);
// A green run on a commit that does not grow from the red one's is no fix: an older checkout never had the defect.
const an = `${tmp}/anc`; mk(`${an}/.fleet/r/tasks/claimed/t`); rm(marker);
git(an, 'init', '-q', '.');
write(`${an}/v.txt`, 'a\n'); git(an, 'add', 'v.txt'); git(an, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a');
write(`${an}/v.txt`, 'b\n'); git(an, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'b');
gn(['prove', '.fleet/r', 't', 'before', '--', 'node', rep, marker], an);
git(an, 'checkout', '-q', '--detach', 'HEAD~1'); write(marker, '');
gn(['prove', '.fleet/r', 't', 'after', '--', 'node', rep, marker], an);
out = gn(['check', '.fleet/r', 't'], an).out;
check('a pass on an older commit than the failure proves nothing', 'does not grow from', out);
// A gitignored .fleet: excluding it made `git add` fail with "paths are ignored" on every prove, and the
// noise buried the verdict line a `| tail -1` reads.
const ig = `${tmp}/ignored-run`; mk(`${ig}/.fleet/r/tasks/claimed/t`); rm(marker);
git(ig, 'init', '-q', '.');
write(`${ig}/.gitignore`, '.fleet\n'); write(`${ig}/v.txt`, 'a\n');
git(ig, 'add', '-A'); git(ig, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a');
out = gn(['prove', '.fleet/r', 't', 'before', '--', 'node', rep, marker], ig).out;
absent('prove in a run whose .fleet is gitignored says nothing about ignored paths', 'could not read some files', out);
write(`${ig}/v.txt`, 'b\n'); write(marker, '');
out = gn(['prove', '.fleet/r', 't', 'after', '--', 'node', rep, marker], ig).out;
absent('nor on the after run', 'could not read some files', out);
check('and the gate still sees the fix', 'PROVEN t', gn(['check', '.fleet/r', 't'], ig).out);
// A run directory below the top of the checkout is left out too: its own proof file is no fix.
mk(`${gate}/app/.fleet/r2/tasks/claimed/t8`); rm(marker);
gn(['prove', '.fleet/r2', 't8', 'before', '--', 'node', rep, marker], `${gate}/app`);
write(marker, '');
gn(['prove', '.fleet/r2', 't8', 'after', '--', 'node', rep, marker], `${gate}/app`);
out = gn(['check', '.fleet/r2', 't8'], `${gate}/app`).out;
check('a run dir in app/.fleet is not counted as a change', 'byte for byte what it was', out);
// `owns:` of a run in app/.fleet is relative to app/, while git names the change app/src/a.ts.
mk(`${gate}/app/.fleet/r2/tasks/claimed/t10`); rm(marker);
write(`${gate}/app/.fleet/r2/tasks/ready/t10.md`, '---\ntask-id: t10\nkind: fix\nowns: [src/a.ts]\n---\n\n# a fix\n');
gn(['prove', '.fleet/r2', 't10', 'before', '--', 'node', rep, marker], `${gate}/app`);
write(`${gate}/theirs.txt`, 'another task\n'); write(marker, '');
gn(['prove', '.fleet/r2', 't10', 'after', '--', 'node', rep, marker], `${gate}/app`);
check('below the git top an edit outside owns: is still not the fix', 'nothing the task owns changed', gn(['check', '.fleet/r2', 't10'], `${gate}/app`).out);
write(`${gate}/app/src/a.ts`, 'fixed\n');
gn(['prove', '.fleet/r2', 't10', 'after', '--', 'node', rep, marker], `${gate}/app`);
check('and owns: src/a.ts of app/.fleet matches app/src/a.ts', 'PROVEN t10', gn(['check', '.fleet/r2', 't10'], `${gate}/app`).out);
rm(`${gate}/app`, `${gate}/run.log`, `${gate}/theirs.txt`);
// A POSIX line as the agent's Git Bash writes it: on Windows cmd.exe read `CI=1` as a program and exited 1,
// so a reproduction that passes was recorded as red.
mk(`${gate}/.fleet/r1/tasks/claimed/task-013-area`);
out = prove('task-013-area', 'before', `CI=1 node -e "process.exit(process.env.CI==='1'?0:3)"`).out;
check('a VAR=x reproduction runs in a POSIX shell', 'before: exit 0', out);
// Several words are re-quoted for that shell: in double quotes bash expanded `$5` to nothing.
mk(`${gate}/.fleet/r1/tasks/claimed/task-014-area`);
out = prove('task-014-area', 'before', 'node', '-e', `process.exit(process.argv[1]==='price $5'?0:3)`, 'price $5').out;
check('a multi-word reproduction keeps $5 and quotes as written', 'before: exit 0', out);
// A one-argument line reaches the shell byte for byte: on Windows MSYS read bash's command line and collapsed `\\` to `\`.
mk(`${gate}/.fleet/r1/tasks/claimed/task-015-area`);
out = prove('task-015-area', 'before', String.raw`node -e "process.exit(process.argv[1].length===4?0:3)" 'a\\b'`).out;
check("a one-argument reproduction keeps 'a\\\\b' as written", 'before: exit 0', out);
// Outside any checkout there is no tree to compare, and prove says so instead of recording an empty one.
mk(`${tmp}/nogit/.fleet/r/tasks/claimed/t9`);
rc = gn(['prove', '.fleet/r', 't9', 'before', '--', 'node', rep, marker], `${tmp}/nogit`, { GIT_CEILING_DIRECTORIES: tmp }).code;
code('prove outside a git checkout is refused', 2, rc);

// asks: the open questions as one round, and the decisions nobody was asked about beside them.
write(`${gr}/ask/07-2.md`, 'The peace-mode ordering fix is a live behaviour change on a flag an operator may already have set.\nrecommend: fix it, and note it in the release\n');
write(`${gr}/answers/07-1.md`, 'answered\n');
write(`${gr}/ask/07-1.md`, 'closed one\n');
out = gn(['asks', '.fleet/r1']).out;
check('an unanswered question is in the round', '07-2.md', out);
check("and the worker's recommendation is shown with it", 'the worker recommends', out);
absent('a question with an answer beside it is not re-asked', '07-1.md', out);

out = node([G, 'decide', '.fleet/r1', '07'], { cwd: gate, input: '{"token":"/api/server/status","why":"no caller outside the bundled frontend, checked the access log"}\n' }).out;
check('a contract call taken without asking is recorded', 'recorded: 07 changed /api/server/status', out);
out = gn(['asks', '.fleet/r1']).out;
check('and it is shown to the operator with the questions', '1 contract change(s) were decided without asking', out);
out = node([G, 'decide', '.fleet/r1', '07'], { cwd: gate, input: '{"token":"/api/thing"}\n' }).out;
check('a decision with no rationale is refused', 'a silent one', out);

// surface: the names this project promised something outside it.
out = gn(['surface', '.']).out;
check('the contract surface is generated from the checkout', 'surface tokens to', out);

// --- fleet-contract.mjs: the PreToolUse gate -------------------------------------------------------
// The hook is handed a payload on stdin and answers with an exit code: 0 lets the edit through, 2 refuses
// it with a sentence. Its cwd is handed over in the operating system's own spelling, as the harness does.

const H = exists(`${HOOKS}/fleet-contract.mjs`) ? `${HOOKS}/fleet-contract.mjs` : `${SCRIPTS}/fleet-contract.mjs`;
if (!exists(H)) {
  skip('fleet-contract cases', `no ${H}`);
} else {
  const hpd = t.tmp('fleet-contract');
  mk(`${hpd}/.fleet/r9/chips`, `${hpd}/.fleet/r9/ask`);
  const chips = (...ss: number[]) => { for (const s of ss) write(`${hpd}/.fleet/r9/chips/sess-${s}`, String(s)); };
  const surface = (s: string) => write(`${hpd}/.fleet/contract-surface.txt`, s);
  const clearAsks = () => { rm(`${hpd}/.fleet/r9/ask`); mk(`${hpd}/.fleet/r9/ask`); };
  chips(9, 10, 11, 12);
  surface('route\t/api/server/status\tsrc/web/Controller.kt\nexport\tgetProgressNote\tsrc/api.ts\n');

  // <session> <old> <new> -> "<exit> <stderr>". The payload carries "/api/..." as typed: node hands it over
  // untouched, where Git Bash used to rewrite it into a path under its install.
  const edit = (s: string, o: string, n: string) => hp(H, hpd, s, 'Edit', JSON.stringify({ file_path: 'src/web/Controller.kt', old_string: o, new_string: n }));

  let o = edit('sess-9', 'get("/api/server/status") { roster() }', 'authed("/api/private") { roster() }');
  starts('an edit that drops a promised route is refused', '2 ', o);
  check('and it names the route', '/api/server/status', o);
  check('and offers the question as one of two ways past it', 'ask/9-', o);
  check('and the recorded decision as the other', 'fleet-gate.mjs decide', o);

  // A substring count says the name survived this. It is the rename most likely to be made.
  o = edit('sess-12', 'get("/api/server/status")', 'get("/api/server/statistics")');
  starts('renaming a route to a longer name that contains it is still a removal', '2 ', o);

  o = edit('sess-10', 'get("/api/server/status") { roster() }', 'get("/api/server/status") { roster().sorted() }');
  starts('an edit that leaves the route where it was is allowed', '0 ', o);

  o = edit('sess-9', 'get("/api/server/status")', 'gone');
  starts('the same name is not raised twice in one session', '0 ', o);

  write(`${hpd}/.fleet/r9/ask/10-1.md`, 'Moving /api/server/status behind auth. recommend: do it, note it in the release.\n');
  o = edit('sess-10', 'get("/api/server/status")', 'authed("/x")');
  starts('a name already asked about is allowed through', '0 ', o);

  o = edit('sess-11', 'const a = 1', 'const a = 2');
  starts('an edit touching no promised name is allowed', '0 ', o);
  o = edit('unregistered', 'get("/api/server/status")', 'gone');
  starts('a session that is not a fleet worker is never gated', '0 ', o);

  rc = node([H], { input: JSON.stringify({ session_id: 'sess-11', cwd: nativePath(hpd), tool_name: 'Read', tool_input: { file_path: 'x' } }) }).code;
  code('reading is never gated', 0, rc);

  // A prefix, a dotted suffix, a YAML key and a decision about a longer name are no way past the gate.
  chips(13, 14, 15, 16, 17);
  surface('route\t/api/server/status\tsrc/web/Controller.kt\nconfig\tserver.port\tsrc/app.yml\nevent\torder.created\tsrc/bus.ts\n');
  clearAsks();
  o = edit('sess-13', 'get("/api/server/status")', 'get("/v1/api/server/status")');
  starts('a route given a prefix is a removal', '2 ', o);
  o = edit('sess-14', 'server.port: 80', 'server.ports: 80');
  starts('a renamed YAML key is a removal', '2 ', o);
  o = edit('sess-15', "emit('order.created')", "emit('order.created.v2')");
  starts('an event given a dotted suffix is a removal', '2 ', o);
  write(`${hpd}/.fleet/r9/decisions.jsonl`, '{"chip":"16","token":"/api/server/status/:id","why":"x"}\n');
  o = edit('sess-16', 'get("/api/server/status")', 'gone');
  starts('a decision about a longer name does not pass this one', '2 ', o);
  rm(`${hpd}/.fleet/r9/decisions.jsonl`);
  // A name at the end of a sentence is still that name; a `$` belongs to a JS name.
  chips(18, 19, 20);
  surface('route\t/api/x\tsrc/a.ts\nexport\t$api\tsrc/a.ts\n');
  o = edit('sess-18', '// see /api/x.', '// see /api/z.');
  starts('a route ending a sentence is still counted', '2 ', o);
  chips(21);
  o = edit('sess-21', 'get("/api/x") {}', 'get("/api/x.{format}") {}');
  check('a route given a templated suffix is a removal', '2 ', o);
  chips(22, 23);
  surface('route\t/api/x\tsrc/a.ts\nevent\torder.created\tsrc/bus.ts\n');
  o = edit('sess-22', 'fetch("https://h.com/api/x")', 'fetch("gone")');
  starts('a route inside a full URL is still the route', '2 ', o);
  o = edit('sess-23', 'topic:order.created', 'topic:gone');
  starts('an event after a namespace is still the event', '2 ', o);
  surface('route\t/api/x\tsrc/a.ts\nexport\t$api\tsrc/a.ts\n');
  o = edit('sess-19', 'export const $api = 1;', 'export const q = 1;');
  starts('an export named with a dollar is counted', '2 ', o);
  write(`${hpd}/.fleet/r9/ask/20-1.md`, 'Moving /api/x. Recommend: do it.\n');
  o = edit('sess-20', "'/api/x'", "'/z'");
  starts("a question naming the route at a sentence's end lets the edit through", '0 ', o);
  clearAsks();
  surface('route\t/api/server/status\tsrc/web/Controller.kt\nconfig\tserver.port\tsrc/app.yml\nevent\torder.created\tsrc/bus.ts\n');
  // On a CRLF file, moving a route within the file is no removal.
  write(`${hpd}/src/crlf.ts`, 'get("/api/server/status")\r\nz = 3\r\n');
  rc = node([H], { input: JSON.stringify({ session_id: 'sess-17', cwd: nativePath(hpd), tool_name: 'MultiEdit', tool_input: { file_path: 'src/crlf.ts', edits: [
    { old_string: 'get("/api/server/status")\nz = 3', new_string: 'z = 3' },
    { old_string: 'z = 3', new_string: 'z = 3\nget("/api/server/status")' },
  ] } }) }).code;
  code('moving a route within a CRLF file is allowed', 0, rc);

  // One chat: the coordinator's subagent is a worker, and nothing has made chips/ yet. The once-marker
  // write threw there and the hook let the rename through.
  {
    const oc = t.tmp('fleet-contract-onechat');
    mk(`${oc}/.fleet/oc/slots`);
    write(`${oc}/.fleet/oc/coordinator`, 'sess-coord\n');
    write(`${oc}/.fleet/contract-surface.txt`, 'route\t/api/server/status\tsrc/web/Controller.kt\n');
    o = hp(H, oc, 'sess-coord', 'Edit', JSON.stringify({ file_path: 'src/web/Controller.kt', old_string: 'get("/api/server/status")', new_string: 'get("/api/server/statistics")' }), 'a1b2');
    starts('in one chat with no chips/ a subagent renaming a promised route is refused', '2 ', o);
    check('and is told to return and report it, not to take another task', 'return and report it', o);
    truthy('its once-marker is written under a chips/ the hook made', exists(`${oc}/.fleet/oc/chips`));
  }

  rm(`${hpd}/.fleet/contract-surface.txt`);
  o = edit('sess-11', 'get("/api/server/status")', 'gone');
  starts('a project that generated no contract surface is never gated', '0 ', o);
}

// --- the merge, and the reconciliation that has to be able to fail ---------------------------------

const mg = `${SCRIPTS}/fleet-merge.mjs`;
if (!exists(mg)) {
  skip('fleet-merge cases', 'no fleet-merge.mjs');
} else {
  const mrun = `${t.tmp('fleet-merge')}/2026-09-08-full-audit`;
  mk(mrun);
  const backlog = () => read(`${mrun}/backlog.jsonl`);
  // Two chips see one thing independently. One of them decided its own sighting was its dev server's fault;
  // the other reproduced it three times. A third chip is called `cid-03`, which fleet.sh find accepts.
  write(`${mrun}/07.jsonl`, '{"chip":"07","area":"auth","severity":"blocker","observed":"login loops forever","evidence":"my dev server was on the wrong port","mechanism_status":"unknown","skip_reason":"my dev server was misconfigured"}\n');
  write(`${mrun}/08.jsonl`, '{"chip":"08","area":"auth","severity":"blocker","observed":"login loops forever","evidence":"auth/session.ts:44 refreshes the cookie it just cleared, reproduced three times","mechanism_status":"established","confirmation":"confirmed"}\n');
  write(`${mrun}/cid-03.jsonl`, '{"chip":"cid-03","area":"billing","severity":"blocker","observed":"invoice total ignores tax","evidence":"billing/total.ts:12 sums before tax","mechanism_status":"established"}\n'
    + '{"chip":"cid-03","area":"nav","severity":"minor","observed":"back button skips a page","evidence":"router/history.ts:9 pops twice","mechanism_status":"hypothesis"}\n');

  let r = node([mg, 'merge', mrun]);
  code('a merge whose files add up finishes', 0, r.code);
  check('a chip id that is not a bare number is read like any other', 'cid-03.jsonl', r.out);
  check('and its findings are counted', 'input findings   4', r.out);
  check('the reconciliation names both halves it compared', '4 findings off 3 chip file(s)', r.out);
  truthy('a blocker filed by cid-03 reaches the backlog', backlog().includes('billing/total.ts:12'));

  // One worker's skip reason is a statement about that worker, not about the finding.
  truthy("an independently reproduced blocker survives another worker's skip", backlog().includes('reproduced three times'));
  truthy('and the row keeps the stronger evidence', !backlog().includes('on the wrong port'), "the skipped sighting's evidence won");
  truthy('with the skip reason carried on the row rather than deleted with it', backlog().includes('my dev server was misconfigured'));
  truthy('and nothing was set aside', read(`${mrun}/skipped.jsonl`) === '', 'skipped.jsonl is not empty');

  // A group every one of whose sightings was skipped does leave the backlog.
  write(`${mrun}/09.jsonl`, '{"chip":"09","area":"perf","severity":"major","observed":"the list takes nine seconds","evidence":"measured on a laptop that was compiling","mechanism_status":"unknown","skip_reason":"the machine was busy"}\n');
  node([mg, 'merge', mrun]);
  truthy('a group every sighting of which was skipped is set aside', read(`${mrun}/skipped.jsonl`).includes('"area":"perf"'));
  rm(`${mrun}/09.jsonl`);

  // The merge's own output is output. Reading backlog.jsonl back as a chip file would let a second merge
  // count its own rows as findings.
  out = node([mg, 'merge', mrun]).out;
  check('the files this merge writes are named as not-input', 'backlog.jsonl (written by this merge, never read back as input)', out);
  check('and a second merge over the same run counts the same findings', 'input findings   4', out);

  // Both halves of the reconciliation have to be able to disagree. Break the merge on purpose: the halves
  // that stood here before were the arrays the grouping had just built, and agreed by construction.
  const src = readFileSync(mg, 'utf8');
  write(`${mrun}/short-write.mjs`, src.split("w('backlog.jsonl', merged);").join("w('backlog.jsonl', merged.slice(0, -1));"));
  truthy('the sabotaged copy really is sabotaged', read(`${mrun}/short-write.mjs`).includes('merged.slice(0, -1)'));
  r = node([`${mrun}/short-write.mjs`, 'merge', mrun]);
  code('a merge that writes fewer rows than it grouped is refused', 1, r.code);
  check('and names the finding that reached no row', 'reach no row on disk', r.out);
  truthy('and leaves no backlog for the run to land over', !exists(`${mrun}/backlog.jsonl`), 'backlog.jsonl is still there');

  // A file that was never opened files no findings, so nothing downstream of the read can miss it.
  write(`${mrun}/unread.mjs`, src.split('if (GENERATED.includes(f))').join('if (/^cid-/.test(f)) continue; if (GENERATED.includes(f))'));
  r = node([`${mrun}/unread.mjs`, 'merge', mrun]);
  code('a chip file the merge never opened is refused', 1, r.code);
  check('by name', 'never opened: cid-03.jsonl', r.out);

  rc = node([mg, 'merge', mrun]).code;
  code('and the honest merge still reconciles afterwards', 0, rc);
  node([mg, 'render', mrun]);
  truthy('the rendered backlog shows that a worker had skipped the row', read(`${mrun}/backlog.md`).includes('one worker skipped this'));
}

// --- the retro, and which run a session belongs to -------------------------------------------------

const rt = `${SCRIPTS}/fleet-retro.mjs`;
if (!exists(rt)) {
  skip('fleet-retro cases', 'no fleet-retro.mjs');
} else {
  const rdir = t.tmp('fleet-retro');
  const runDir = `${rdir}/.fleet/2026-09-08-full-audit`;
  // Two sessions with the same chip number: one worked the run, one worked the fix run named after it. As
  // a substring the parent run id matches both, and the child's hours were charged against the parent's
  // completion marker. The timestamps are written exactly, minutes after 10:00 UTC on 2026-09-08.
  const at = (m: number): string => new Date(Date.UTC(2026, 8, 8, 10, m)).toISOString();
  const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
  const sess = (seed: string, t0: number, step: number): string => {
    let s = line({ type: 'user', timestamp: at(t0), message: { role: 'user', content: seed } });
    for (let i = 1; i < 6; i++) s += line({ type: 'assistant', timestamp: at(t0 + i * step), message: { usage: { output_tokens: 100 }, content: [] } });
    return s;
  };
  write(`${rdir}/tx/sess-parent.jsonl`, sess('Work .fleet/2026-09-08-full-audit/brief-07.md; your chip id is `07`', 0, 10));
  write(`${rdir}/tx/sess-child.jsonl`, sess('Work .fleet/fix-2026-09-08-full-audit/brief-07.md; your chip id is `07`', 120, 60));
  write(`${rdir}/tx/sess-nochip.jsonl`, sess('Have a look at .fleet/2026-09-08-full-audit and tell me what it holds', 0, 2));
  write(`${runDir}/chips/sess-parent`, '07');
  write(`${runDir}/07.done`, '');
  const done = new Date(Date.UTC(2026, 8, 8, 10, 30));
  utimesSync(`${runDir}/07.done`, done, done);

  out = node([rt, '2026-09-08-full-audit', '--dir', `${rdir}/tx`], { cwd: rdir }).out;
  check('a run collects its own sessions', '1 sessions, 5 turns', out);
  out = node([rt, '--dir', `${rdir}/tx`, '2026-09-08-full-audit'], { cwd: rdir }).out;
  check("the run id is found after a flag's value too", '1 sessions, 5 turns', out);
  check('and not the sessions of the fix run named after it', '20 minutes and 2 turns', out);
  check('counting the sessions it declined to attribute rather than guessing', 'no chip id: left out', out);
  out = node([rt, 'fix-2026-09-08-full-audit', '--run-dir', `${rdir}/.fleet/fix-2026-09-08-full-audit`, '--dir', `${rdir}/tx`], { cwd: rdir }).out;
  check('and the fix run collects its own', '1 sessions, 5 turns', out);
  check("without borrowing the parent run's completion marker", 'NOT MEASURED', out);

  // A run directory that is not there is not a run that wasted nothing, and the zero it used to print was
  // indistinguishable from one. The sh version stood in $TMPDIR; an empty directory of its own is surer.
  const r = node([rt, '2026-09-08-full-audit', '--dir', `${rdir}/tx`], { cwd: t.tmp('fleet-retro-norun') });
  code('a retro with no run directory still reports', 0, r.code);
  check('and says the markers were never found', 'no run directory at', r.out);
  check('rather than printing a zero that reads as a clean run', 'NOT MEASURED', r.out);
  out = node([rt, '2026-09-08-full-audit', '--dir', `${rdir}/tx`, '--json'], { cwd: rdir, stdoutOnly: true }).out;
  let parsed = 1;
  try { const j: unknown = JSON.parse(out); parsed = Array.isArray(j) && j.length === 1 ? 0 : 1; } catch { parsed = 1; }
  code('the warnings stay off stdout, so --json still parses', 0, parsed);
}

// --- the canvas seed, and the cover it writes on the way -------------------------------------------

const cv2 = `${SCRIPTS}/fleet-canvas.mjs`;
if (!exists(cv2)) {
  skip('fleet-canvas cases', 'no fleet-canvas.mjs');
} else {
  const sdir = t.tmp('fleet-seed');
  write(`${sdir}/src/Cases.vue`, 'x');
  write(`${sdir}/design/Cases.dc.html`, '<!doctype html>\n'
    + '<html><head><meta charset="utf-8"><script src="./support.js"></script></head>\n'
    + '<body><x-dc><helmet><style>body { margin: 0; } a { color: #000; }</style></helmet>\n'
    + '<div style="width: 1440px; height: 900px">Cases</div></x-dc></body></html>\n');
  // A stand-in for the design skill's helper, so this asserts on every machine rather than only on one
  // where /design has run. It answers the only question that matters: was every artboard canvas.json names
  // actually handed to it.
  write(`${sdir}/skill/payload.template.html`, '<!-- template -->\n');
  write(`${sdir}/skill/seed-canvas.mjs`, "import fs from 'node:fs';\n"
    + 'const a = process.argv.slice(2);\n'
    + "if (a[0] === '--check') { console.log('CHECK ok'); process.exit(0); }\n"
    + "const sent = a.filter((x, i) => a[i - 1] === '--artboard');\n"
    + "const named = JSON.parse(fs.readFileSync(a[a.indexOf('--canvas') + 1], 'utf8')).artboards.map((x) => x.file);\n"
    + 'const miss = named.filter((n) => !sent.some((s) => s.endsWith(n)));\n'
    + "console.log(miss.length ? 'MISSING FROM PAYLOAD: ' + miss.join(', ') : 'PAYLOAD COMPLETE: ' + named.join(', '));\n"
    + "fs.writeFileSync(a[a.indexOf('--out') + 1], 'seeded');\n");
  node([cv2, 'stamp', 'design/Cases.dc.html', '--source', 'src/Cases.vue', '--frame', '1440x900'], { cwd: sdir });
  const r = node([cv2, 'seed', 'design', '--title', 'Fixture', '--out', `${sdir}/out.html`, '--skill-dir', `${sdir}/skill`], { cwd: sdir });
  code('the first seed of a canvas finishes', 0, r.code);
  check('the cover the layout wrote is in the payload it shipped', 'PAYLOAD COMPLETE: Main.dc.html', r.out);
  check('and the count it reports is the count it sent', 'seeding 2 artboards', r.out);
}
