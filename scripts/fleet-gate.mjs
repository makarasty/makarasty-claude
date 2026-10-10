#!/usr/bin/env node
// fleet-gate.mjs - what stands between a finding and a change to the product.
//
// A run finds things well. Measured across seventeen runs on one application, 7 of 2,851 findings carried
// neither a file:line nor a single number, so the evidence contract holds. What the same runs show is that
// nothing decides. Three defects growing from one cause were filed as three findings, patched in three
// files, and the note saying so ("Three modules. A fourth turns this from three patches into one helper")
// was written in three separate run documents across three runs and acted on in none, because the fix
// queue splits by file cluster and the shared seam belongs to somebody else. And three changes that broke
// a consumer outside the application - two endpoints moved behind session auth, a history clear moved onto
// an event that also fires on a console load, a detector deleted rather than repaired - shipped without a
// question being asked, because asking was a matter of taste.
//
// So this file is the judgement stage, in the only form that has been shown to work. Adversarial review
// does not do it: a published campaign had ten reviewers unanimously endorse a vulnerability that did not
// exist, and it was killed by one empirical test (arXiv 2604.19049). More opinions correlate. A test does
// not. Everything here is therefore a refusal wired to an executed command or to a string match, never a
// paragraph asking a model to be careful.
//
//   node fleet-gate.mjs surface  <project-root>                      write the project's contract surface
//   node fleet-gate.mjs cluster  <run-dir> [--queue <fix-dir>]       candidate roots, and the tasks to gate them
//   node fleet-gate.mjs prove    <run-dir> <task> before|after -- cmd run it, record the exit and the tree
//   node fleet-gate.mjs check    <run-dir> <task>                    exit 1 unless the proof is complete
//   node fleet-gate.mjs asks     <run-dir>                           every open question as one round
//   node fleet-gate.mjs decide   <run-dir> <chip>  <json on stdin>   record a contract call nobody was asked
//
// Portable: node, git, and the run layout in PROTOCOL.md. No host assumptions, no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import { cal, FILE_RE } from '../hooks/run-dir.mjs';
const args = process.argv.slice(2);
const cmd = args[0];
const die = (msg, code = 2) => { console.error(msg); process.exit(code); };
const usage = () => die(`usage:
  fleet-gate.mjs surface <project-root>
  fleet-gate.mjs cluster <run-dir> [--queue <fix-dir>]
  fleet-gate.mjs prove   <run-dir> <task-id> before|after -- <command>
  fleet-gate.mjs check   <run-dir> <task-id>
  fleet-gate.mjs asks    <run-dir>
  fleet-gate.mjs decide  <run-dir> <chip>   with {"token":"...","why":"..."} on stdin`);
const readJsonl = (p) => {
    if (!fs.existsSync(p))
        return [];
    const out = [];
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        if (!line.trim())
            continue;
        try {
            out.push(JSON.parse(line));
        }
        catch { /* a torn last line is a worker still appending */ }
    }
    return out;
};
const append = (p, obj) => fs.appendFileSync(p, JSON.stringify(obj) + '\n');
const now = () => new Date().toISOString();
// ---------------------------------------------------------------------------------------------------
// surface - the list of names this project has promised to somebody outside it.
//
// A fix that changes one of these is the one class of change that looks correct from inside the repository
// and breaks something nobody in the run can see: a monitoring script polling an endpoint, an operator's
// config file, another service reading a field. It cannot be derived exactly, so this errs wide and the
// file is meant to be edited by hand - a token nobody depends on costs one line of noise, and a missing
// token costs the outage this whole file exists to prevent.
//
// ponytail: regex over tracked files, not a parse. It will miss a route built by concatenation and a key
// read through a variable. Replace the patterns per project in FLEET.md when that starts to matter.
const SURFACE_PATTERNS = [
    // A route or path literal: "/api/server/status", '/v1/users/:id'
    [/["'`](\/[a-z0-9][\w./:{}$-]*)["'`]/gi, 'route'],
    // An exported or public name, across the languages this has been run against
    [/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|const|class|interface|type|enum)\s+([A-Za-z_]\w*)/g, 'export'],
    [/\bpublic\s+(?:static\s+)?(?:final\s+)?(?:fun|void|class|interface|[A-Za-z_][\w<>.]*)\s+([A-Za-z_]\w*)\s*\(/g, 'export'],
    // A configuration key: a dotted or dashed key at the head of a line, or a yaml key one level deep
    [/^\s{0,4}([a-z][\w-]*(?:\.[a-z][\w-]*)+)\s*[:=]/gim, 'config'],
    // An event or channel name passed to something that emits or listens
    [/\b(?:emit|on|dispatch|publish|subscribe|addEventListener)\s*\(\s*["'`]([\w.:-]{3,})["'`]/g, 'event'],
];
const SURFACE_EXT = /\.(ts|tsx|js|mjs|cjs|jsx|vue|java|kt|kts|go|rb|py|php|cs|rs|yml|yaml|properties|toml|json|sql)$/i;
function surface(root) {
    if (!fs.existsSync(path.join(root, '.git')))
        die(`${root} is not the root of a git checkout`);
    let files;
    try {
        files = execSync('git ls-files', { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n');
    }
    catch (e) {
        die(`git ls-files failed in ${root}: ${e.message}`);
    }
    const hits = new Map(); // token -> {kind, files:Set}
    for (const rel of files) {
        if (!rel || !SURFACE_EXT.test(rel))
            continue;
        // A generated or vendored tree promises nothing; skip it before reading it.
        if (/(^|\/)(node_modules|dist|build|out|target|vendor|\.min\.)/.test(rel))
            continue;
        const abs = path.join(root, rel);
        let text;
        try {
            if (fs.statSync(abs).size > 2 * 1024 * 1024)
                continue;
            text = fs.readFileSync(abs, 'utf8');
        }
        catch {
            continue;
        }
        for (const [re, kind] of SURFACE_PATTERNS) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(text))) {
                const tok = m[1];
                if (!tok || tok.length < 4 || tok.length > 120)
                    continue;
                const cur = hits.get(tok) || { kind, files: new Set() };
                cur.files.add(rel);
                hits.set(tok, cur);
            }
        }
    }
    const dir = path.join(root, '.fleet');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, 'contract-surface.txt');
    const lines = [...hits.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        .map(([tok, v]) => `${v.kind}\t${tok}\t${[...v.files].slice(0, 3).join(',')}`);
    fs.writeFileSync(out, `# Names this project has promised to something outside it, generated by fleet-gate.mjs on ${now()}.
# Columns: kind, token, up to three files it was seen in. Edit this file freely: a token here that nothing
# depends on costs a worker one question, and a token missing from here costs an outage nobody in the run
# could have seen. Regenerate with: node fleet-gate.mjs surface <project-root>
${lines.join('\n')}\n`);
    console.log(`wrote ${lines.length} surface tokens to ${out}`);
}
// ---------------------------------------------------------------------------------------------------
// cluster - candidate roots, and the queue rewiring that makes acting on one possible.
//
// The merge deliberately refuses this: same symptom in different areas stays separate, because proving a
// shared cause is judgement and that pass is mechanical. Nothing then does the judgement, so a shared cause
// is patched once per surface. What is mechanical is the CANDIDATE: findings whose evidence names the same
// file, or whose prose names the same identifier, across areas that were owned by different workers. This
// generates those, gates the members behind one root task, and leaves the ruling to whoever works the root.
const STOPWORDS = new Set(('the this that with from into when then than which where what while have has had ' +
    'been being does did not and but for are was were will would should could there here their they them ' +
    'null true false undefined return function const class value string number object array error result ' +
    'request response server client user data list item index count total name type kind size length line ' +
    'file path page view state props style click event handler config default async await import export')
    .split(' '));
// A defect's cause is named in the mechanism if it is named anywhere. Reading the whole finding instead
// catches the vocabulary of the subsystem - `playerData`, `netServer`, `forEach` - which every finding in
// that subsystem shares and which explains none of them.
const identifiers = (f) => {
    const text = [f.mechanism, f.observed].filter(Boolean).join(' ');
    const out = new Set();
    for (const m of text.matchAll(/\b([a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+|[a-z][a-z0-9]+(?:_[a-z0-9]+)+)\b/g)) {
        const t = m[1];
        if (t.length >= 5 && !STOPWORDS.has(t.toLowerCase()))
            out.add(t);
    }
    return out;
};
// FILE_RE lives in hooks/run-dir.mjs, so the fix queue's twins and these clusters read one spelling.
const filesOf = (f) => new Set([...String(f.evidence || '').matchAll(FILE_RE)].map((x) => x[1].split('\\').join('/')));
// Two ceilings, both of them the difference between a cause and a neighbourhood.
//
// A token that half the run mentions is the project's vocabulary. Measured against a 436-finding backlog,
// no cut at all produced `forEach` and `playerData` as candidate causes.
const COMMON_TOKEN_SHARE = cal('root_common_token_share', 0.15);
// A candidate holding more than this is a file, not a defect: the same backlog offered one 51 findings
// wide because they all touched a 5,000-line command file. Gating 51 tasks behind one worker serialises
// the run and buys nothing - the fix queue already splits by file cluster, so a hotspot is reported and
// left alone.
const MAX_ROOT_MEMBERS = cal('root_max_members', 6);
function cluster(runDir, queueDir) {
    const backlog = readJsonl(path.join(runDir, 'backlog.jsonl'));
    if (!backlog.length)
        die(`no findings in ${path.join(runDir, 'backlog.jsonl')} - run merge first`, 1);
    const rank = { blocker: 0, major: 1, minor: 2, polish: 3 };
    const take = backlog.filter((f) => f.severity === 'blocker' || f.severity === 'major');
    // A candidate is a token seen in two or more findings that different areas reported. Same area, same
    // token is one defect described twice and the merge already owns it.
    const byToken = new Map();
    const add = (key, kind, f) => {
        const cur = byToken.get(key) || { kind, members: [] };
        cur.members.push(f);
        byToken.set(key, cur);
    };
    // Two workers cite one file at two depths - `Timer.java` and `.../arc/util/Timer.java` - and split the
    // cluster that was the point of doing this. One path ending in the other on a separator boundary is the
    // same file; the longest spelling seen is the one worth printing.
    const seen = [...new Set(take.flatMap((f) => [...filesOf(f)]))]
        .filter((f) => !/(^|\/)(node_modules|dist|build|out|target|vendor|generated)(\/|$)/.test(f))
        .sort((a, b) => b.length - a.length);
    const canon = new Map();
    for (const f of seen) {
        const longer = seen.find((x) => x.length > f.length && x.endsWith('/' + f));
        canon.set(f, longer ? canon.get(longer) || longer : f);
    }
    for (const f of take) {
        // Canonicalise before adding: one finding citing `Timer.java` and `util/Timer.java` is one member, not
        // two, or a two-finding root counts three and is filed as a hotspot.
        const files = new Set([...filesOf(f)].filter((x) => canon.has(x)).map((x) => canon.get(x)));
        for (const file of files)
            add(`file:${file}`, 'file', f);
        for (const id of identifiers(f))
            add(`name:${id}`, 'name', f);
    }
    const common = Math.max(3, Math.ceil(take.length * COMMON_TOKEN_SHARE));
    const clusters = [];
    const hotspots = [];
    for (const [key, v] of byToken) {
        const areas = new Set(v.members.map((m) => m.area));
        if (v.members.length < 2 || areas.size < 2)
            continue;
        const c = {
            key,
            kind: v.kind,
            shared: key.slice(key.indexOf(':') + 1),
            areas: [...areas],
            members: v.members.map((m) => m.id),
            severity: v.members.map((m) => m.severity).sort((a, b) => rank[a] - rank[b])[0],
        };
        if (v.members.length > MAX_ROOT_MEMBERS || v.members.length >= common) {
            hotspots.push(c);
            continue;
        }
        clusters.push(c);
    }
    // A finding belongs to one root, or the queue gates it twice and it can never run. Keep the widest
    // cluster each finding appears in and drop it from the rest.
    clusters.sort((a, b) => b.members.length - a.members.length || rank[a.severity] - rank[b.severity]);
    const claimed = new Set();
    const kept = [];
    for (const c of clusters) {
        const free = c.members.filter((id) => !claimed.has(id));
        if (free.length < 2)
            continue;
        const areas = new Set(free.map((id) => take.find((f) => f.id === id)?.area));
        if (areas.size < 2)
            continue;
        c.members = free;
        c.areas = [...areas];
        free.forEach((id) => claimed.add(id));
        kept.push(c);
    }
    for (const [i, c] of kept.entries())
        c.id = `root-${String(i + 1).padStart(3, '0')}`;
    fs.writeFileSync(path.join(runDir, 'clusters.jsonl'), kept.map((c) => JSON.stringify(c)).join('\n') + (kept.length ? '\n' : ''));
    const md = [`# Candidate roots for ${path.basename(runDir)}`, '',
        'Each row is a name or a file that findings from more than one area both reach. That is a candidate,',
        'not a diagnosis: the root task below it exists to prove or refute one cause, and refuting it is a',
        'complete result that releases the members to be fixed separately.', '',
        '| root | shared | severity | areas | findings |', '|---|---|---|---|---|',
        ...kept.map((c) => `| ${c.id} | \`${c.shared}\` | ${c.severity} | ${c.areas.length} | ${c.members.join(', ')} |`),
        ...(hotspots.length ? ['', '## Hotspots, gating nothing', '',
            `${hotspots.length} name(s) are reached by more findings than a single cause explains - over ${MAX_ROOT_MEMBERS}, or by more`,
            `than ${Math.round(COMMON_TOKEN_SHARE * 100)}% of this run's findings. A file that every worker touched is a place, not a defect, and`,
            'gating a wave behind one worker to prove otherwise costs more than it can return. They are listed',
            'because a file at the top of this table is worth someone reading whole, once, on its own terms.', '',
            '| shared | findings | areas |', '|---|---|---|',
            ...hotspots.sort((a, b) => b.members.length - a.members.length)
                .map((c) => `| \`${c.shared}\` | ${c.members.length} | ${c.areas.length} |`)] : [])].join('\n');
    fs.writeFileSync(path.join(runDir, 'clusters.md'), md + '\n');
    if (!queueDir) {
        console.log(`${kept.length} candidate root(s) over ${claimed.size} findings, ${hotspots.length} hotspot(s) -> clusters.md`);
        console.log('pass --queue <fix-dir> to write the root tasks and gate the members behind them');
        return;
    }
    // Wire the queue. `fixqueue` has already written one task per finding; this adds the root task and puts
    // `after:` on its members, which is the one ordering mechanism the queue already enforces - `fleet.sh
    // next` will not hand out a gated task until the root's done marker exists. A leaf that starts before
    // its root either patches a surface of a defect the root is about to remove, or edits the same seam
    // under it.
    const ready = path.join(queueDir, 'tasks', 'ready');
    if (!fs.existsSync(ready))
        die(`no task queue at ${ready} - run fixqueue first`);
    const taskFiles = fs.readdirSync(ready).filter((f) => f.endsWith('.md'));
    const findingOf = (file) => (fs.readFileSync(path.join(ready, file), 'utf8').match(/^finding-id:\s*(\S+)/m) || [])[1];
    const byFinding = new Map(taskFiles.map((f) => [findingOf(f), f]).filter(([id]) => id));
    let wired = 0;
    for (const c of kept) {
        const memberTasks = c.members.map((id) => byFinding.get(id)).filter(Boolean);
        if (memberTasks.length < 2)
            continue;
        const rootId = `task-${c.id}`;
        // The members' `base:` when they share one: a root with none was cut from whatever branch the main
        // checkout stood on, and every member then merged that branch's other work in with the root's.
        const bases = new Set(memberTasks.map((f) => (fs.readFileSync(path.join(ready, f), 'utf8').match(/^base:[ \t]*(\S+)/m) || [])[1] ?? ''));
        const base = bases.size === 1 ? [...bases][0] : '';
        const members = c.members.map((id) => {
            const f = take.find((x) => x.id === id);
            return `- **${id}** (${f.severity}, ${f.area}) ${f.observed}`;
        }).join('\n');
        fs.writeFileSync(path.join(ready, `${rootId}.md`), `---
task-id: ${rootId}
kind: root
severity: ${c.severity}
needs: repo
budget: 40
${base ? `base: ${base}\n` : ''}shared: ${c.shared}
gates: [${memberTasks.map((f) => f.replace(/\.md$/, '')).join(', ')}]
---

# One cause, or ${c.members.length} coincidences: \`${c.shared}\`

${c.members.length} findings from ${c.areas.length} different areas all reach \`${c.shared}\`. Those areas had different
owners, so nobody has looked at them together, and the fix queue would otherwise hand each of them to a
worker who may not touch the others' files.

${members}

**You own the shared seam.** The exclusive file ownership the rest of this queue runs on does not apply to
this task: every task listed in \`gates\` waits for your done marker before it can be claimed, so nothing is
editing beside you.

## What to do

1. **Rule on the cause first, and be willing to refute it.** Read all ${c.members.length} findings against the code. Either
   one defect explains them, or the shared name is a coincidence. Refuting is a complete result and the
   right one more often than it feels: measured across one application, roughly 15 findings in every 100
   were refuted the moment somebody tried to fix them, and the refutation was almost always of the
   mechanism rather than the symptom.
2. **If refuted:** write the refutation into your notes, finish this task, and say in the notes that the
   members are independent. They unblock on your done marker either way, and each is then fixed on its own
   evidence.
3. **If one cause holds:** fix it once, here, at the seam. Then say for each member whether it is now
   resolved, still needs a change of its own, or was never a defect. A member you resolve is still worked
   by its own task, which re-runs its reproduction and confirms - never by deleting the task.
4. **Prove it the way every fix in this queue is proved.** \`fleet-gate.mjs prove\` before your change with the
   reproduction failing, and after it with the reproduction passing. \`finish\` refuses this task otherwise.

## Done when

- Every member above is named as resolved here, still open, or refuted.
- The proof records a failing before and a passing after, over a tree that actually changed.
- If you changed a name on the project's contract surface, an \`ask/\` or a recorded decision says so.
`);
        for (const file of memberTasks) {
            const p = path.join(ready, file);
            let text = fs.readFileSync(p, 'utf8');
            if (/^after:/m.test(text))
                continue;
            text = text.replace(/^(task-id:.*)$/m, `$1\nafter: ${rootId}`);
            text = text.replace(/\n## Done when\n/, `
**A shared cause is being ruled on first.** \`${rootId}\` owns \`${c.shared}\`, which this finding and ${c.members.length - 1} other
finding(s) from other areas all reach. It has already finished by the time you can claim this. Re-run the
reproduction before you change anything: it may already pass, in which case your job is to confirm that and
say so, not to write a second fix for a defect that is gone.

## Done when
`);
            fs.writeFileSync(p, text);
            wired++;
        }
    }
    console.log(`${kept.length} root task(s) written, ${wired} task(s) gated behind them, in ${ready}`);
}
// ---------------------------------------------------------------------------------------------------
// prove / check - a fix arrives with a reproduction that failed before it and passes after it.
//
// That sentence has been in this plugin's documentation as a demand since the fix kind existed, and a run
// of 213 fix tasks landed 164 of them without anything checking. It is checkable, so it is checked here:
// the command is run by this file, its exit code is recorded rather than reported, and the state of the
// tree is recorded beside it. That last part is what catches the other failure - a build daemon that died
// mid-run once returned BUILD SUCCESSFUL over a tree whose fix had been reverted, and only a forced
// rebuild found it. A green whose tree is identical to the red's proves nothing at all.
// The content of the whole checkout as one git tree id: what `git add -A` would stage, written through a
// copy of the index so the real one is never touched (the copy keeps its stat cache: only changed files are
// hashed). Content, not HEAD: a commit between runs, or a fix reverted again, changes no byte and reads so.
// Not names either: `git status` says ` M src/a.ts` for a half-made change and the finished fix alike.
// The whole checkout, not the directory prove was run from: a fix one folder over was never seen. The run's
// own directory is excluded wherever it sits (`.fleet`, `app/.fleet/<run>`), or the proof file just written
// would be the change.
function treeState(from, runDir) {
    const run = (c, cwd, env) => {
        try {
            return execSync(c, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        }
        catch {
            return '';
        }
    };
    const top = run('git rev-parse --show-toplevel', from);
    if (!top)
        die(`${from} is not in a git checkout: prove compares the tree around a fix, and there is none here`);
    const head = run('git rev-parse HEAD', top) || 'no-head';
    const rel = path.relative(top, path.resolve(runDir)).split(path.sep).join('/');
    const scope = `-- . ":(exclude).fleet"${rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? ` ":(exclude)${rel}"` : ''}`;
    const index = path.resolve(top, run('git rev-parse --git-path index', top));
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-gate-')), 'index');
    try {
        if (fs.existsSync(index))
            fs.copyFileSync(index, tmp);
        const env = { ...process.env, GIT_INDEX_FILE: tmp };
        // A file another process holds open (a dev db, .vs/) is skipped and named, not the whole add lost: a
        // failed add left the index copy as it was and every fix read as no change. safecrlf would refuse a
        // file over its line endings, which say nothing about a fix.
        // ponytail: changed untracked files land in .git/objects as loose objects until gc prunes them.
        const add = spawnSync(`git -c core.safecrlf=false add -A --ignore-errors ${scope}`, { cwd: top, env, shell: true, encoding: 'utf8' });
        if (add.status !== 0)
            console.error(`prove: git could not read some files, which are left out of the tree:\n${(add.stderr || '').trim()}`);
        const tree = run('git write-tree', top, env);
        if (!tree)
            die(`could not read the content of ${top} (git add -A / write-tree failed there)`);
        // A submodule's own working tree is one gitlink here: a fix inside it is seen only from inside it.
        const subs = run('git status --porcelain=2', top).split('\n').filter((l) => /^[12] \S+ S.(M.|.U)/.test(l));
        if (subs.length)
            console.error(`prove: changes inside a submodule are not seen from here; prove and check from inside it:\n${subs.map((l) => `  ${l.split(' ').pop()}`).join('\n')}`);
        return { head, tree };
    }
    finally {
        fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
}
// One command line from what followed `--`. A single argument is a command the caller already quoted and
// runs as written; several are re-quoted, since joining them bare re-split `-t "login flow"` into two words.
const commandLine = (args) => (args.length === 1 ? args[0]
    : args.map((a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : JSON.stringify(a))).join(' '));
function prove(runDir, taskId, phase, command) {
    if (phase !== 'before' && phase !== 'after')
        usage();
    if (!command.length)
        die('nothing to run: put the reproduction after --');
    const claim = path.join(runDir, 'tasks', 'claimed', taskId);
    if (!fs.existsSync(claim))
        die(`no claim at ${claim} - claim the task before proving it`);
    const line = commandLine(command);
    // One prove at a time per claim: a second one running inside the first's window put its own output in a
    // gap between runs, which `check` reads as the fix.
    // A lock whose prove was killed (a Bash timeout, a closed terminal) is taken over at once: its pid is gone.
    const lock = path.join(claim, 'proof.lock');
    const alive = (pid) => { try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === 'EPERM';
    } };
    try {
        fs.mkdirSync(lock);
    }
    catch {
        let pid = 0, age = 0;
        try {
            pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8'));
        }
        catch { /* being written, or none */ }
        try {
            age = Date.now() - fs.statSync(lock).mtimeMs;
        }
        catch { /* gone meanwhile */ }
        // No pid yet: a prove in its first instant, or one killed in it (taken over after a minute).
        // ponytail: a pid Windows reused for another live process holds the lock until it is an hour old, and a
        // reproduction running longer than an hour loses its lock to a second prove.
        if (pid ? alive(pid) && age < 3600_000 : age < 60_000)
            die(`another prove is running on ${taskId} (${lock}): wait for it, one run at a time`);
    }
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
    try {
        // The tree just before the run and just after it: `check` looks for a change BETWEEN runs, so what the
        // reproduction writes itself (a log, a snapshot, a formatter's rewrite) is never taken for the fix, and
        // a fix in a file the command also rewrites still counts.
        const pre = treeState(process.cwd(), runDir);
        const r = spawnSync(line, { shell: true, stdio: 'inherit' });
        const post = treeState(process.cwd(), runDir);
        const rec = { phase, exit: r.status === null ? 124 : r.status, when: now(), head: post.head, digest: post.tree.slice(0, 16), cmd: line, pre: pre.tree, post: post.tree };
        append(path.join(claim, 'proof'), rec);
        console.log(`${phase}: exit ${rec.exit}, tree ${rec.digest}`);
        // A `before` that passes means the reproduction does not reproduce, which is a refutation and a result.
        if (phase === 'before' && rec.exit === 0)
            console.log('the reproduction passes already - this finding is refuted, not fixed. Record that and move on.');
    }
    finally {
        fs.rmSync(lock, { recursive: true, force: true });
    }
}
function check(runDir, taskId) {
    const claim = path.join(runDir, 'tasks', 'claimed', taskId);
    const proof = readJsonl(path.join(claim, 'proof'));
    const before = [...proof].reverse().find((p) => p.phase === 'before');
    const after = [...proof].reverse().find((p) => p.phase === 'after');
    const fail = (why) => { console.error(`NOT PROVEN ${taskId}: ${why}`); process.exit(1); };
    if (!before)
        fail('no reproduction was recorded before the change. `fleet-gate.mjs prove <run> <task> before -- <cmd>`');
    if (!after)
        fail('no reproduction was recorded after the change. `fleet-gate.mjs prove <run> <task> after -- <cmd>`');
    if (before.exit === 0)
        fail(`the reproduction passed before the change (exit 0), so it never reproduced the defect`);
    if (after.exit !== 0)
        fail(`the reproduction still fails after the change (exit ${after.exit})`);
    // The fix is a path that differs between the red run's end and the green run's start AND was changed in a
    // gap between runs (one run's end to the next one's start, from the last `before` to the last `after`).
    // A run's own output (a log, a flaky second `after` over the first one's log) changes only inside runs; a
    // fix made and reverted again changed in the gaps but is no difference at the end; a commit of nothing new
    // is neither. A formatter's rewrite of the fixed file still leaves the fix in a gap.
    const chain = proof.slice(proof.lastIndexOf(before), proof.lastIndexOf(after) + 1);
    const kinds = new Set(chain.map((p) => typeof p.pre === 'string' && typeof p.post === 'string'));
    if (kinds.size > 1)
        fail('the records were written by two versions of this gate, whose trees do not compare: record `before` again (revert the fix, prove before, re-apply it, prove after)');
    const diff = (a, b) => {
        if (a === b)
            return [];
        try {
            return execSync(`git diff-tree -r -z --name-only ${a} ${b}`, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
        }
        catch {
            return fail(`the recorded trees are not in this checkout's git (run check from the checkout the proofs were made in, or record \`before\` again here)`);
        }
    };
    // The green run's checkout grew from the red one's: a worktree on an older commit where the defect never
    // was, or another clone, passes with nobody fixing anything. A handed-back task's tree grows from the old
    // one's branch, so its carried `before` still holds.
    if (before.head !== after.head && before.head !== 'no-head') {
        const anc = spawnSync('git', ['merge-base', '--is-ancestor', before.head, after.head], { stdio: 'ignore' });
        // 1 is "not an ancestor"; anything else is git unable to answer here (no checkout, an unknown commit).
        if (anc.status !== 0 && anc.status !== 1)
            fail(`git cannot compare commits ${before.head.slice(0, 12)} and ${after.head.slice(0, 12)} here: run check from the checkout the proofs were made in, or record \`before\` again there`);
        if (anc.status !== 0)
            fail(`the passing run was on commit ${after.head.slice(0, 12)}, which does not grow from ${before.head.slice(0, 12)} where the failing one ran: record \`before\` again in this checkout`);
    }
    let moved, why = [];
    if (kinds.has(true)) {
        const gaps = new Set(chain.flatMap((p, i) => (i > 0 ? diff(chain[i - 1].post, p.pre) : [])));
        why = diff(before.post, after.pre).filter((p) => gaps.has(p));
        moved = why.length > 0;
    }
    else
        moved = before.digest !== after.digest;
    if (!moved)
        fail('the tree is byte for byte what it was before the change, so the passing run was made over the unfixed code. Not seen: a change saved while a prove was still running (save the fix between runs), files .gitignore leaves out, and the inside of a submodule (prove from inside it)');
    if (before.cmd !== after.cmd)
        fail(`the two runs are not the same command:\n  before: ${before.cmd}\n  after:  ${after.cmd}`);
    // Named, so a reviewer sees a scratch file that happened to appear between runs for what it is.
    console.log(`PROVEN ${taskId}: ${before.cmd} exit ${before.exit} -> ${after.exit}, tree ${before.digest} -> ${after.digest}${why.length ? `, changed between runs: ${why.slice(0, 10).join(', ')}${why.length > 10 ? `, and ${why.length - 10} more` : ''}` : ''}`);
}
// ---------------------------------------------------------------------------------------------------
// asks - every open question as one round.
//
// Measured over four runs on one project: 86 questions asked, 85 answered. The mechanism works and the
// operator answers. What costs them is the shape - a question arriving alone, in a chat they are not
// sitting in, is a context switch each time. Answering eight in one pass is one.
function asks(runDir) {
    const askDir = path.join(runDir, 'ask');
    const ansDir = path.join(runDir, 'answers');
    // The decisions are printed whatever the questions are: `decide` promises they show here.
    const open = !fs.existsSync(askDir) ? [] : fs.readdirSync(askDir).filter((f) => f.endsWith('.md'))
        .filter((f) => !fs.existsSync(path.join(ansDir, f)));
    if (!fs.existsSync(askDir))
        console.log('no questions have been filed');
    else if (!open.length)
        console.log('every question filed has an answer beside it');
    else
        console.log(`${open.length} open question(s). Answer them in one round; each answer goes to answers/<same name>.\n`);
    for (const [i, f] of open.entries()) {
        const body = fs.readFileSync(path.join(askDir, f), 'utf8').trim();
        const rec = body.match(/^recommend(?:ed|ation)?:\s*(.+)$/im);
        console.log(`Q${i + 1} - ${f}`);
        console.log(body.split('\n').slice(0, 12).map((l) => `     ${l}`).join('\n'));
        if (rec)
            console.log(`     -> the worker recommends: ${rec[1]}`);
        console.log('');
    }
    const decisions = readJsonl(path.join(runDir, 'decisions.jsonl'));
    if (decisions.length) {
        console.log(`${decisions.length} contract change(s) were decided without asking. They are listed in decisions.jsonl and`);
        console.log('each one is reversible; read them before landing the run:\n');
        for (const d of decisions)
            console.log(`     ${d.chip}  ${d.token}  ${d.why}`);
    }
}
// ---------------------------------------------------------------------------------------------------
// decide - the escape hatch that keeps the escape visible.
//
// A worker blocked on the contract surface has two ways forward: ask, and wait for a person, or decide and
// carry on. Both are legitimate; what is not is deciding silently, which is how two endpoints moved behind
// authentication and a monitoring script nobody in the run could see started getting 401s. This makes the
// second path cost one line, and puts that line in front of the operator at the end of the run.
// The token and the rationale arrive on stdin as JSON, the way a finding does. Not for symmetry: a
// contract token is usually a route, and Git Bash rewrites any argument beginning with a slash into a
// Windows path before the script ever sees it - `/api/server/status` arrived as
// `C:/Program Files/Git/api/server/status` the first time this was tested. Nothing reaching this through
// a pipe is rewritten.
function decide(runDir, chip) {
    let body = {};
    try {
        body = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
        if (!body || typeof body !== 'object')
            throw new Error();
    }
    catch {
        die('the decision is JSON on stdin: {"token":"...","why":"..."}');
    }
    const { token, why } = body;
    if (!token)
        die('name the token you changed: {"token":"...","why":"..."}');
    if (!why)
        die('a decision with no rationale is a silent one. Say what you decided and why.');
    fs.mkdirSync(runDir, { recursive: true });
    append(path.join(runDir, 'decisions.jsonl'), { chip, token, why, when: now() });
    console.log(`recorded: ${chip} changed ${token} - ${why}`);
    console.log('it will be listed in the run banner and in `fleet-gate.mjs asks`, so the operator sees it before landing.');
}
// ---------------------------------------------------------------------------------------------------
const runDirOf = (a) => { if (!a)
    usage(); if (!fs.existsSync(a))
    die(`no such run directory: ${a}`); return a; };
switch (cmd) {
    case 'surface':
        surface(args[1] || process.cwd());
        break;
    case 'cluster': {
        const q = args.indexOf('--queue');
        cluster(runDirOf(args[1]), q === -1 ? null : args[q + 1]);
        break;
    }
    case 'prove': {
        const sep = args.indexOf('--');
        if (sep === -1)
            usage();
        prove(runDirOf(args[1]), args[2], args[3], args.slice(sep + 1));
        break;
    }
    case 'check':
        check(runDirOf(args[1]), args[2] || usage());
        break;
    case 'asks':
        asks(runDirOf(args[1]));
        break;
    case 'decide':
        decide(runDirOf(args[1]), args[2] || usage());
        break;
    default: usage();
}
