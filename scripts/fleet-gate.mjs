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
import crypto from 'node:crypto';
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
shared: ${c.shared}
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
function treeState(cwd) {
    const git = (c, input) => {
        try {
            return execSync(c, { cwd, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'] });
        }
        catch {
            return '';
        }
    };
    const head = git('git rev-parse HEAD').trim() || 'no-head';
    // The run's own directory is excluded, or this never compares equal: recording the `before` proof writes
    // a file, so the tree has always moved by the time `after` reads it and the check that catches a green
    // built over unfixed code would pass every time.
    //
    // Contents, not names. `git status --porcelain` says ` M src/a.ts` for a half-made change and for the
    // finished fix alike, so a fix landing in a file that was already dirty at `before` read as a tree that
    // never moved. The diff against HEAD covers tracked files, and untracked ones are hashed without being
    // written to the object store.
    const scope = '-- . ":(exclude).fleet"';
    const diff = git(`git diff HEAD --binary ${scope}`);
    const untracked = git(`git ls-files -o --exclude-standard ${scope}`);
    const blobs = untracked.trim() ? git('git hash-object --stdin-paths', untracked) : '';
    const digest = crypto.createHash('sha256').update([head, diff, untracked, blobs].join('\n\0')).digest('hex').slice(0, 16);
    return { head, digest };
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
    const r = spawnSync(line, { shell: true, stdio: 'inherit' });
    const st = treeState(process.cwd());
    const rec = { phase, exit: r.status === null ? 124 : r.status, when: now(), head: st.head, digest: st.digest, cmd: line };
    append(path.join(claim, 'proof'), rec);
    console.log(`${phase}: exit ${rec.exit}, tree ${rec.digest}`);
    // A `before` that passes means the reproduction does not reproduce, which is a refutation and a result.
    if (phase === 'before' && rec.exit === 0)
        console.log('the reproduction passes already - this finding is refuted, not fixed. Record that and move on.');
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
    if (before.digest === after.digest)
        fail('the tree is byte for byte what it was before the change, so the passing run was made over the unfixed code');
    if (before.cmd !== after.cmd)
        fail(`the two runs are not the same command:\n  before: ${before.cmd}\n  after:  ${after.cmd}`);
    console.log(`PROVEN ${taskId}: ${before.cmd} exit ${before.exit} -> ${after.exit}, tree ${before.digest} -> ${after.digest}`);
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
    if (!fs.existsSync(askDir))
        return console.log('no questions have been filed');
    const open = fs.readdirSync(askDir).filter((f) => f.endsWith('.md'))
        .filter((f) => !fs.existsSync(path.join(ansDir, f)));
    if (!open.length)
        return console.log('every question filed has an answer beside it');
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
        decide(args[1], args[2]);
        break;
    default: usage();
}
