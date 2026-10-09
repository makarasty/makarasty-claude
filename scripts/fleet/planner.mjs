// planner.mts - the planner's queue work: file, cleared, answer, broadcast, stranded, width, chips. Part of fleet.mjs; see src/scripts/fleet.mts.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isatty } from 'node:tty';
import { need, out, err, isDir, isFile, read, names, field, NEEDS, operatorOwed, now, slashes, configDir, cal, calint, loadScript, laneGaps, mtimeMs, nativePath, sub, AFTER } from './lib.mjs';
// ---- shared pieces ---------------------------------------------------------------------------------------
// sed's `.` takes a \r, JS's does not, so lib's AFTER misses `after:` on a CRLF line; this one does not.
// `$(...)`: trailing newlines cut, and Git Bash's bash takes the CR before each of them too.
// `head -1 <file>`: the first line with its newline, if it has one.
function headOne(p) { const t = read(p); const i = t.indexOf('\n'); return i < 0 ? t : t.slice(0, i + 1); }
// `cat` of stdin, as bytes. A closed or absent stdin reads as nothing.
function stdin() {
    try {
        return readFileSync(0);
    }
    catch {
        return Buffer.alloc(0);
    }
}
// The frontmatter value of `<key>:` as awk reads it: the first line from line 2 on that starts with the key,
// before a line starting `---`, with the key and the blanks after it cut. undefined when there is none.
function fmValue(text, key) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i] ?? '';
        if (i > 0 && l.startsWith('---'))
            return undefined;
        if (l.startsWith(`${key}:`))
            return l.slice(key.length + 1).replace(/^[ \t]*/, '');
    }
    return undefined;
}
// `absdir`: the directory in git's own spelling, or the argument as given when it cannot be entered.
function absdir(d) { return isDir(d) ? slashes(resolve(d)) : d; }
// `beside <rel> <pkg> <path in the plugin>`: a file beside fleet.sh, else under the copy the host says it
// installed, else the newest cached copy.
function beside(c, rel, pkg, inPkg) {
    const here = `${dirname(c.sh)}/${rel}`;
    if (existsSync(here))
        return here;
    let root = '';
    try {
        const rec = JSON.parse(readFileSync(`${homedir()}/.claude/plugins/installed_plugins.json`, 'utf8'));
        root = rec.plugins[`${pkg}@makarasty`][0].installPath.split('\\').join('/');
    }
    catch {
        root = '';
    }
    if (root && existsSync(`${root}/${inPkg}`))
        return `${root}/${inPkg}`;
    // `ls -t ~/.claude/plugins/cache/*/<pkg>/*/<path> | head -1`
    const cache = `${process.env.HOME || homedir()}/.claude/plugins/cache`;
    const hits = [];
    for (const m of names(cache))
        for (const v of names(`${cache}/${m}/${pkg}`)) {
            if (existsSync(`${cache}/${m}/${pkg}/${v}/${inPkg}`))
                hits.push(`${cache}/${m}/${pkg}/${v}/${inPkg}`);
        }
    hits.sort((a, b) => (mtimeMs(b) - mtimeMs(a)) || (a < b ? -1 : 1));
    return hits[0] ?? '';
}
// ---- file ------------------------------------------------------------------------------------------------
// The coordinator files a task: the file on stdin (or a path), checked before it reaches the queue.
// Measured 2026-10-05: a hand-made filing script ran its heredoc after a failed `&&` chain, so two tasks
// were never filed and nothing said so, and a cp1252 character broke another task file. One call per
// task, refused loudly, and `FILED` only when the file is in place.
function file(c, args) {
    const run = c.run;
    const id = need(c, args[0], 3, 'task id required');
    const src = args[1] || '-';
    if (/[^A-Za-z0-9._-]/.test(id) || id.startsWith('.')) {
        err(`REFUSED: task id '${id}' may hold only letters, digits, dot, dash and underscore\n`);
        return 2;
    }
    for (const p of [`${run}/tasks/ready/${id}.md`, `${run}/tasks/claimed/${id}`, `${run}/tasks/done/${id}`, `${run}/tasks/released/${id}.md`]) {
        if (existsSync(p)) {
            err(`REFUSED: ${id} already exists (${p}); a re-filed task takes a new id\n`);
            return 2;
        }
    }
    mkdirSync(`${run}/tasks/ready`, { recursive: true });
    if (src === '-' && (process.env.FLEET_STDIN_TTY === '1' || isatty(0))) {
        err(`REFUSED: ${id} NOT filed: nothing on stdin; pipe the task file in, or name its path\n`);
        return 2;
    }
    const tmp = `${run}/tasks/.filing-${id}-${process.pid}`;
    if (src === '-') {
        writeFileSync(tmp, stdin());
    }
    else {
        try {
            copyFileSync(src, tmp);
        }
        catch (e) {
            const code = e.code;
            err(code === 'EISDIR' || isDir(src) ? `cp: -r not specified; omitting directory '${src}'\n` : `cp: cannot stat '${src}': No such file or directory\n`);
            rmSync(tmp, { force: true });
            return 2;
        }
    }
    let why = '';
    let lane = '';
    // UTF-8 or refused; a UTF-8 byte order mark (what Windows PowerShell writes by default) is dropped, since
    // everything that reads a task matches `---` and `needs:` at the start of a line.
    let b = readFileSync(tmp);
    let text = '';
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(b);
    }
    catch {
        why = 'it is not valid UTF-8 (a cp1252 or UTF-16 write?): write the file as UTF-8 and file it again';
    }
    if (!why) {
        if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
            b = b.subarray(3);
            writeFileSync(tmp, b);
            text = b.toString('utf8');
        }
        const lines = text.split('\n');
        if ((lines[0] ?? '').split('\r').join('') !== '---') {
            why = 'it does not start with a --- frontmatter line';
        }
        else if (!lines.slice(1).some((l) => l.startsWith('---'))) {
            why = 'its frontmatter has no closing --- line';
        }
        else {
            // The lane as `next` reads it: the first word of the needs: line.
            const nv = fmValue(text, 'needs');
            lane = /^[a-z]+/.exec(nv ?? '')?.[0] ?? '';
            if (!['pane', 'repo', 'verify'].includes(lane)) {
                why = `its needs: line reads '${(nv ?? '').replace(/[ \t\r]+$/, '')}', and a lane is pane, repo or verify, in lower case`;
            }
            const tid = (fmValue(text, 'task-id') ?? '').replace(/[ \t\r]+$/, '');
            if (!why && tid && tid !== id)
                why = `its task-id: line says '${tid}', not '${id}'`;
        }
    }
    if (why) {
        rmSync(tmp, { force: true });
        err(`REFUSED: ${id} NOT filed: ${why}\n`);
        return 2;
    }
    const dest = `${run}/tasks/ready/${id}.md`;
    renameSync(tmp, dest);
    const filed = read(dest);
    const afterRaw = field(filed, AFTER).replace(/[,\r]/g, ' ');
    const after = afterRaw.split(/[ \t\n]+/).filter(Boolean);
    const miss = after.filter((d) => !existsSync(`${run}/tasks/ready/${d}.md`));
    out(`FILED ${id} lane ${lane}${afterRaw ? ` after ${after.join(' ')}` : ''}\n`);
    // Not refused: a queue filed whole can name a task filed a moment later. Said, because a typo here holds
    // this task for ever.
    if (miss.length)
        out(`  NOTE: after: names a task not filed yet:${miss.map((d) => ` ${d}`).join('')} - file it, or this task waits for ever\n`);
    if (operatorOwed(filed))
        out(`  waits on the operator: ask them now; next holds it until: fleet.sh cleared ${c.absrun} ${id}\n`);
    return 0;
}
// ---- cleared ---------------------------------------------------------------------------------------------
// The operator did what a task's `operator:` line asked: the line goes, and `next` hands the task out.
function cleared(c, args) {
    const id = need(c, args[0], 3, 'task id required');
    const f = `${c.run}/tasks/ready/${id}.md`;
    if (!existsSync(f)) {
        err(`no such task: ${id}\n`);
        return 2;
    }
    // Bytes in, bytes out, as awk passes them; every record ends in a newline on the way out. Git Bash's awk
    // reads a CR before a newline, or before the end of the file, as part of the line ending and drops it.
    const text = readFileSync(f, 'latin1').replace(/\r(?=\n|$)/g, '');
    const lines = text.split('\n');
    if (text.endsWith('\n') || !text)
        lines.pop();
    let fm = false;
    const kept = [];
    lines.forEach((l, i) => {
        if (i === 0 && l.startsWith('---')) {
            fm = true;
            kept.push(l);
            return;
        }
        if (fm && l.startsWith('---'))
            fm = false;
        if (fm && l.startsWith('operator:'))
            return;
        kept.push(l);
    });
    const t = `${f}.tmp-${process.pid}`;
    writeFileSync(t, kept.map((l) => `${l}\n`).join(''), 'latin1');
    renameSync(t, f);
    // A worker waiting on exit 7 wakes when the ready, done or cleared listing changes (fleet-run's wake
    // loop); rewriting the task in place changes none of them.
    mkdirSync(`${c.run}/tasks/cleared`, { recursive: true });
    writeFileSync(`${c.run}/tasks/cleared/${id}`, `${now()}\n`);
    out(`CLEARED ${id}: the operator's part is done; next hands it out\n`);
    return 0;
}
// ---- answer and broadcast --------------------------------------------------------------------------------
// One answer, addressed to every question it settles. The planner kept combining answers into one file with
// a name of its own - `05-1-2-3.md` - and then nothing found it: the worker looks for `answers/05-1.md`.
// Measured 2026-08-31: four questions answered, all four still listed as unanswered an hour later.
function answer(c, ids) {
    if (!ids.length) {
        err('usage: fleet.sh answer <run-dir> <question-id> [question-id...]\n');
        return 2;
    }
    mkdirSync(`${c.run}/answers`, { recursive: true });
    const body = stdin();
    if (!body.length) {
        err('refusing to write an empty answer\n');
        return 2;
    }
    for (let id of ids) {
        if (id.endsWith('.md'))
            id = id.slice(0, -3);
        if (!existsSync(`${c.run}/ask/${id}.md`))
            err(`warning: no question ${id}.md in ask/\n`);
        const dest = `${c.run}/answers/${id}.md`;
        try {
            writeFileSync(dest, body);
        }
        catch {
            err(`cp: cannot create regular file '${dest}': No such file or directory\n`);
            return 1;
        }
        out(`ANSWERED ${id}\n`);
    }
    return 0;
}
// Something every worker must read, rather than an answer to one of them, read at each task boundary.
// Every worker reads the whole file, including one that starts a day later, so each entry carries its time,
// and an order meant for named chips does not belong here: 2026-10-06, worker 20 retired at 420K on a
// "workers 01-05 retire" entry written eighteen hours before it started.
function broadcast(c) {
    mkdirSync(`${c.run}/answers`, { recursive: true });
    const b = sub(stdin().toString('latin1'));
    if (/[Rr][Ee][Tt][Ii][Rr][Ee]/.test(b)) {
        err('NOTE: a retire order in the broadcast is read by every worker, later ones too; retire chips with fleet.sh relaunch instead\n');
    }
    appendFileSync(`${c.run}/answers/00-broadcast.md`, `\n## ${now()}\n${b}\n`, 'latin1');
    out(`BROADCAST appended to ${c.run}/answers/00-broadcast.md\n`);
    return 0;
}
// ---- stranded --------------------------------------------------------------------------------------------
// Done tasks whose branch holds commits the integration branch does not. "partly merged" is the stranded
// kind: a commit made after the merge, which nothing would ever pick up (2026-10-05: three, found by hand).
// "not merged" is either a merge still to come or a task the review turned down; the coordinator knows
// which. Run it after each merge and before landing.
function git(args, showErr = false) {
    const r = spawnSync('git', args, { encoding: 'utf8', stdio: ['inherit', 'pipe', showErr ? 'inherit' : 'ignore'] });
    return { ok: r.status === 0, out: r.stdout || '' };
}
function stranded(c, args) {
    const run = c.run;
    // The integration branch: the integration checkout's current branch, or the argument.
    let ib = args[0] ?? '';
    const ip = sub(`${field(read(`${run}/worktrees/integration`), /^path ([\s\S]*)$/)}\n`);
    if (!ib && ip) {
        const r = git(['-C', nativePath(ip), 'rev-parse', '--abbrev-ref', 'HEAD']);
        ib = r.ok ? r.out.replace(/\n+$/, '') : '';
    }
    if (!ib) {
        err('no integration branch: register the integration checkout (fleet.sh worktree <run> integration --create <branch>) or name it: fleet.sh stranded <run> <branch>\n');
        return 2;
    }
    const g = ip ? nativePath(ip) : '.';
    if (!git(['-C', g, 'rev-parse', '--verify', '-q', ib], true).ok) {
        err(`integration branch '${ib}' does not resolve in ${ip || '.'}\n`);
        return 2;
    }
    // Two git calls up front instead of several per task: a 200-task run took about a minute the other way.
    const heads = ` ${git(['-C', g, 'for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads']).out.split('\n').join(' ')}`;
    const unm = ` ${git(['-C', g, 'for-each-ref', '--no-merged', ib, '--format=%(refname:lstrip=2)', 'refs/heads']).out.split('\n').join(' ')}`;
    const headList = heads.split(/[ \t\n]+/).filter(Boolean);
    let n = 0, gone = 0;
    let subj;
    for (const id of names(`${run}/tasks/done`)) {
        const m = `${run}/tasks/done/${id}`;
        if (!isFile(m))
            continue;
        let bs = '', tip = '';
        // `while IFS=' ' read -r k v`: only newline-terminated lines, blanks trimmed at both ends, one \r cut.
        const lines = read(m).split('\n');
        lines.pop();
        for (const line of lines) {
            const t = line.replace(/^ +| +$/g, '');
            const sp = t.indexOf(' ');
            const k = sp < 0 ? t : t.slice(0, sp);
            let v = sp < 0 ? '' : t.slice(sp).replace(/^ +/, '');
            if (v.endsWith('\r'))
                v = v.slice(0, -1);
            if (k === 'branch') {
                if (!bs)
                    bs = v;
            }
            else if (k === 'tip')
                tip = v;
        }
        // A marker with no branch line (a worker older than the branch line, or a task with no code) is looked
        // up by its id among the branches: `rm/<id>`, `fleet/<chip>/<id>`. ponytail: an id reused by an older
        // run's branch matches too; branch names carry no run id to tell them apart.
        if (!bs) {
            for (const h of headList)
                if (h.endsWith(`/${id}`))
                    bs += ` ${h}`;
            if (!bs)
                continue;
        }
        for (const b of bs.split(/[ \t\n]+/).filter(Boolean)) {
            // A branch that no longer exists was deleted, almost always after its merge: counted, not listed.
            if (!heads.includes(` ${b} `)) {
                gone++;
                continue;
            }
            if (!unm.includes(` ${b} `))
                continue;
            const r = git(['-C', g, 'rev-list', '--count', `${ib}..${b}`]);
            const miss = r.ok ? r.out.replace(/\n+$/, '') : '0';
            if (!(Number(miss || '0') > 0))
                continue;
            n++;
            // Merged once? Certain when `finish` recorded the tip and integration holds it. Without a tip (an
            // older marker), a merge commit on integration naming the branch says so; a squash or fast-forward
            // merge names nothing and reads as "not merged". The count is right either way.
            let merged = false;
            if (tip) {
                merged = git(['-C', g, 'merge-base', '--is-ancestor', tip, ib]).ok;
            }
            else {
                if (subj === undefined) {
                    const s = git(['-C', g, 'log', '--first-parent', '--merges', '--format=%s', ib]);
                    subj = s.ok ? s.out : '';
                }
                merged = [`'${b}'`, `Merge ${b}:`, `Merge ${b} `].some((p) => subj?.includes(p));
            }
            out(merged
                ? `  STRANDED ${id}: branch ${b} was merged, then got ${miss} more commit(s) that ${ib} lacks\n`
                : `  not merged ${id}: branch ${b}, ${miss} commit(s) not in ${ib}\n`);
        }
    }
    if (gone > 0)
        out(`  (${gone} done task branch(es) no longer exist: deleted, most likely after their merge)\n`);
    if (n === 0)
        out(`every done task's branch that still exists is in ${ib}\n`);
    return 0;
}
// ---- width -----------------------------------------------------------------------------------------------
// The repo lane's width, computed rather than retyped: how many repo tasks are ready, and what the machine
// has free. A formula in prose drifts every time somebody restates it; this one has a single spelling.
function width(c) {
    let ready = 0;
    for (const n of names(`${c.run}/tasks/ready`)) {
        if (!n.endsWith('.md'))
            continue;
        if (existsSync(`${c.run}/tasks/done/${n.slice(0, -3)}`))
            continue;
        if ((field(read(`${c.run}/tasks/ready/${n}`), NEEDS) || 'repo') === 'repo')
            ready++;
    }
    const per = calint(c, 'repo_tasks_per_worker', 3);
    const want = Math.max(1, Math.floor((ready + per - 1) / per));
    let cap = '';
    let reserve = '', ceil = '';
    const loader = loadScript();
    if (loader) {
        reserve = cal(c, 'operator_reserve_gb', '2');
        ceil = String(calint(c, 'repo_worker_ceiling', 12));
        const j = spawnSync(process.execPath, [loader, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).stdout || '';
        const RESERVE = Number(reserve) || 2, CEIL = Number(ceil) || 12;
        try {
            const o = JSON.parse(j);
            cap = String(Math.max(1, Math.min(Math.floor(o.freeGB - RESERVE), CEIL)));
        }
        catch {
            cap = '';
        }
    }
    if (!cap)
        cap = '6';
    let n = want;
    // `[ "$n" -gt "$cap" ]`: a census that answers no number leaves the cap unreadable and the width as wanted.
    if (/^[0-9]+$/.test(cap)) {
        if (n > Number(cap))
            n = Number(cap);
    }
    else
        err(`${c.sh}: [: ${cap}: integer expression expected\n`);
    out(`REPO_WORKERS ${n}\n`);
    out(`  ready repo tasks ${ready}, one worker per ${per} -> ${want}\n`);
    out(`  machine cap ${cap} (free memory less the ${reserve || '2'} GB the operator keeps, ceiling ${ceil || '12'})\n`);
    out(`  the pane lane starts at ${cal(c, 'pane_workers_default', '2')} and is bound by memory, not by the display [M33]; the verify lane is 1\n`);
    out('  every constant above comes from calibration.json\n');
    return 0;
}
// ---- chips -----------------------------------------------------------------------------------------------
// The worker chips, printed rather than described. Measured 2026-10-05: a coordinator that reached its run
// through a handoff never loaded fleet-plan, so the chip rules were not in its context - five paste lines
// instead of chips, then four chips titled "Fleet worker 02: ..." that no `fleet <run-id> NN` lookup finds.
// Every path that offers workers goes through here, so the title, the absolute run path and the command
// path have one spelling.
function chips(c, args) {
    const run = c.run;
    const range = args[0] ?? '';
    let lane = '', wmodel = '', weffort = '';
    const rest = args.slice(1);
    while (rest.length) {
        const a = rest.shift() ?? '';
        if (a === '--model' || a === '--effort') {
            const v = rest[0] ?? '';
            if (!v) {
                err(`${a} needs a value\n`);
                return 2;
            }
            if (a === '--model')
                wmodel = v;
            else
                weffort = v;
            rest.shift();
        }
        else
            lane = a;
    }
    if (!range) {
        err('worker range required, e.g. 02 or 02-05\n');
        return 2;
    }
    // The id the app's model menu uses, as `get_session` prints it. A tier alias never equals what a worker
    // reports, so every `whoami` would stop on it.
    if (wmodel && wmodel !== 'none' && !wmodel.startsWith('claude-')) {
        err(`--model '${wmodel}' is not a model id: pass it as get_session prints it (claude-opus-5-5), or none to drop the wish\n`);
        return 2;
    }
    // max is refused: the docs warn it overthinks, and the operator capped workers at xhigh (docs/MODELS.md).
    if (weffort === 'any')
        weffort = '';
    else if (weffort === 'max') {
        err('effort max is not for workers: use xhigh at most, and ultracode for one hard task (docs/MODELS.md, Reasoning effort)\n');
        return 2;
    }
    else if (!['', 'low', 'medium', 'high', 'xhigh'].includes(weffort)) {
        err(`effort '${weffort}' is not low, medium, high or xhigh\n`);
        return 2;
    }
    if (weffort && !wmodel) {
        err('--effort needs --model beside it\n');
        return 2;
    }
    const dash = range.lastIndexOf('-');
    const first = dash < 0 ? range : range.slice(0, dash); // ${range%-*}
    const last = range.includes('-') ? range.slice(range.indexOf('-') + 1) : range; // ${range#*-}
    // Numbers only, and a range that runs forwards: a reversed range printed no chip at all, only the trailer,
    // and the coordinator offered nothing believing it had.
    if (/[^0-9]/.test(first + last)) {
        err(`range '${range}' is not numeric: use 02 or 02-05\n`);
        return 2;
    }
    if (!first || !last) {
        err(`range '${range}' is empty at one end: use 02 or 02-05\n`);
        return 2;
    }
    let i = Number(first.replace(/^0*/, '') || '0');
    const end = Number(last.replace(/^0*/, '') || '0');
    // Worker numbers start at 1: every number elsewhere is a worker that exists.
    if (i < 1) {
        err(`range '${range}' starts below 1: worker numbers start at 01\n`);
        return 2;
    }
    if (i > end) {
        err(`range '${range}' runs backwards: no worker would be offered\n`);
        return 2;
    }
    // A lane is where a task can be done, never which model does it: a model name as a lane (`opus`, measured
    // 2026-10-05) made a queue of its own that four idle workers on the very same model could not touch.
    if (!['', 'pane', 'repo', 'verify'].includes(lane)) {
        err(`lane '${lane}' is not a lane: use pane, repo or verify. A lane says where a task can be done; the\n`);
        err('model goes in --model <id> [--effort <level>], and the coordinator switches each worker to it.\n');
        return 2;
    }
    const runid = basename(c.absrun);
    const runmd = `${absdir(dirname(beside(c, '../commands/fleet-run.md', 'makarasty', 'commands/fleet-run.md')))}/fleet-run.md`;
    const nnOf = (k) => String(k).padStart(2, '0');
    // Every number is checked before any chip is printed or recorded, so a refusal leaves nothing half
    // offered. A number already offered with another lane was a worker the operator may have opened.
    for (let j = i; j <= end; j++) {
        const nn = nnOf(j);
        let want;
        if (existsSync(`${run}/brief-${nn}.md`)) {
            want = 'brief';
            // A brief is one turn, and a switch lands on the next one.
            if (wmodel) {
                err(`worker ${nn} has a brief: a brief is one turn, which no switch reaches. Have the operator pick its model in the app's menu before the click (docs/MODELS.md, Switching a worker)\n`);
                return 2;
            }
        }
        else {
            if (!lane) {
                err(`no brief-${nn}.md in ${c.absrun}, so this is a queue worker and needs a lane: pane, repo or verify\n`);
                return 2;
            }
            want = lane;
        }
        const had = `${run}/offered/${nn}`;
        const lane0 = sub(headOne(had));
        if (existsSync(had) && lane0 !== want) {
            err(`worker ${nn} was already offered for lane ${lane0}, and this asks for ${want}. Use a number\n`);
            err('no chip has used: lanes take disjoint ranges (pane 01-02, repo 03-08), never the same number twice.\n');
            return 2;
        }
    }
    mkdirSync(`${run}/offered`, { recursive: true });
    if (wmodel)
        mkdirSync(`${run}/want`, { recursive: true });
    // The session that asks for chips is the coordinator. `status` and the watch read its transcript for its
    // context size, which is the one number that says when the run needs a fresh coordinator.
    const sid = process.env.CLAUDE_CODE_SESSION_ID || '';
    if (sid) {
        writeFileSync(`${run}/coordinator`, `${sid}\n`);
        try {
            mkdirSync(`${configDir()}/makarasty/fleet-sessions`, { recursive: true });
            writeFileSync(`${configDir()}/makarasty/fleet-sessions/${sid}`, `${c.absrun}\n`);
        }
        catch { /* the context hook's record is a courtesy */ }
    }
    for (; i <= end; i++) {
        const nn = nnOf(i);
        let seepane = '', prompt, what;
        // What this worker should run on; `whoami` checks it. A re-offer without --model keeps the wish a
        // respawn would otherwise lose; `none` drops it.
        if (wmodel === 'none')
            rmSync(`${run}/want/${nn}`, { force: true });
        else if (wmodel)
            writeFileSync(`${run}/want/${nn}`, `${wmodel} ${weffort || 'any'}\n`);
        if (existsSync(`${run}/brief-${nn}.md`)) {
            prompt = `Run the brief at ${c.absrun}/brief-${nn}.md by following the makarasty fleet-run command. Invoke it as /makarasty:fleet-run ${c.absrun}/brief-${nn}.md, and if that name does not resolve in this session, read the command file directly, at ${runmd}`;
            what = `brief ${nn}`;
            // A brief worker is not a queue worker: recording a lane made `lane_gaps` count it as covering it.
            writeFileSync(`${run}/offered/${nn}`, 'brief\n');
        }
        else {
            prompt = `You are worker ${nn} of run ${runid}, lane ${lane}. Work the queue by following the makarasty fleet-run command. Invoke it as /makarasty:fleet-run ${c.absrun}/, and if that name does not resolve in this session, read the command file directly, at ${runmd}`;
            what = `lane ${lane}`;
            writeFileSync(`${run}/offered/${nn}`, `${lane}\n`);
            if (lane === 'pane')
                seepane = ' Keep its browser pane on screen if it asks for one.';
        }
        out(`CHIP ${nn}\ntitle: fleet ${runid} ${nn}\ntldr: Worker ${nn} of fleet run ${runid}, ${what}. It works by itself and reports to the coordinator chat; open it.${seepane}\nprompt: ${prompt}\n\n`);
    }
    out('Offer every CHIP above now, each as its own mcp__ccd_session__spawn_task with exactly that title, tldr and prompt.\n');
    out('The title is the worker\'s address: fleet-wait, fleet-resume and send_message find it by that title and no other.\n');
    out('A chip is an offer the operator can decline with one click, so offer every one of them. If a project or memory rule seems to forbid chips for fleet workers, quote that rule to the operator in this same turn, with the chips already offered; never replace chips with paste lines.\n');
    // Every lane the queue already holds work for needs a worker from the first minute: tasks filed at 18:34
    // waited 19 minutes on 2026-10-05 for chips that were promised "for wave 3". A `needs:` that is not a
    // lane is fixed in the task file; no chip can cover it.
    const gap = laneGaps(c);
    const lanes = gap.filter((l) => !l.includes('is not a lane'));
    const bad = gap.filter((l) => l.includes('is not a lane'));
    if (lanes.length)
        out(`STILL WITHOUT A WORKER:\n${lanes.join('\n')}\nOffer chips for those lanes in this same turn.\n`);
    if (bad.length)
        out(`FIX THE TASK, not the chips:\n${bad.join('\n')}\n`);
    return 0;
}
export const commands = {
    file,
    cleared,
    answer: (c, a) => answer(c, a),
    broadcast: (c) => broadcast(c),
    stranded,
    width: (c) => width(c),
    chips,
};
