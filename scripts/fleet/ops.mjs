// ops.mts - recovery and landing: sweep, recover, procs, summary, landed, merge, render, fixqueue. Part of fleet.mjs; see src/scripts/fleet.mts.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { posix, resolve } from 'node:path';
import { need, out, err, isDir, isFile, read, firstLine, names, field, operatorOwed, now, calint, live, indent, mtimeMs, slashes, configDir, lf, cksum, shellPath, HERE, lockToRelease, afterIds, budgetOf, refiledAs, walksOf, openAsks } from './lib.mjs';
// ---- shared pieces ---------------------------------------------------------------------------------------
// fleet.sh's `mtime`: whole seconds, NaN when unreadable.
const mtimeSec = (p) => Math.floor(mtimeMs(p) / 1000);
const nowSec = () => Math.floor(Date.now() / 1000);
// `$(( (a - b) / 60 ))`: shell division truncates toward zero.
const minutes = (a, b) => Math.trunc((a - b) / 60);
// Git Bash's sed, grep and awk read text mode: a CRLF line ends at the \n with no \r left over.
// `$(head -1 <f>)`: the substitution there strips the \r of a CRLF ending, not a lone one.
// `head -1 <f> 2>/dev/null || echo <fallback>`
const headOr = (p, fb) => (isFile(p) ? firstLine(p) : fb);
// `basename "$run"`, which splits on / only.
const base = (p) => posix.basename(p);
// `grep -c <re>` over text. `.` in sh's C locale crosses \r, so the regexes here carry the s flag.
const countLines = (text, re) => lf(text).split('\n').filter((l) => re.test(l)).length;
// `grep -c <re> <file> 2>/dev/null || true`: '' when the file cannot be read.
const grepC = (p, re) => (isFile(p) ? String(countLines(read(p), re)) : '');
const ANY = /./s;
const SEV = (s) => new RegExp(`"severity"[ \\t\\v\\f\\r]*:[ \\t\\v\\f\\r]*"${s}"`);
// `grep -q "chip $c\$" <owner>`: a line ending in the chip.
const ownedBy = (p, chip) => lf(read(p)).split('\n').some((l) => l.endsWith(`chip ${chip}`));
// `ls <dir>/*<suffix> | wc -l`
const countGlob = (dir, suffix) => names(dir).filter((n) => n.endsWith(suffix)).length;
// `date +%Y%m%dT%H%M%S`
function stampSuffix() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
// POSIX `cksum`: CRC-32 (0x04C11DB7, MSB first) over the bytes and then the length.
// Where this plugin is, from the inside: beside fleet.sh, else under the copy the host says it installed,
// else the newest cache snapshot (only for a checkout that was never installed).
function beside(c, rel, pkg, sub) {
    const here = `${HERE}/${rel}`; // where fleet.mjs is, however fleet.sh was spelled
    if (existsSync(here))
        return here;
    try {
        const rec = JSON.parse(readFileSync(`${configDir()}/plugins/installed_plugins.json`, 'utf8'));
        const ip = rec.plugins[`${pkg}@makarasty`]?.[0]?.installPath;
        if (ip !== undefined) {
            const root = slashes(ip);
            if (root && existsSync(`${root}/${sub}`))
                return `${root}/${sub}`;
        }
    }
    catch { /* no install record */ }
    // `ls -t ~/.claude/plugins/cache/*/<pkg>/*/<sub> | head -1`: newest by mtime, by name on a tie.
    const cache = `${configDir()}/plugins/cache`;
    const hits = [];
    for (const a of names(cache))
        for (const v of names(`${cache}/${a}/${pkg}`)) {
            const p = `${cache}/${a}/${pkg}/${v}/${sub}`;
            if (existsSync(p))
                hits.push([p, mtimeMs(p)]);
        }
    hits.sort((x, y) => (y[1] - x[1]) || (x[0] < y[0] ? -1 : 1));
    return hits[0]?.[0] ?? '';
}
// release_task: the ready file leaves the queue, and so does every task whose `after:` waited on it, one
// line per dependent taken along.
// Every released id is scanned for dependents, not only the one moved now: a release killed between moving
// a file and scanning for what waited on it left those dependents in ready for ever.
function releaseTask(c, first) {
    const run = c.run;
    // The earlier ones are only scanned, never moved, and not at all once a planner put the id back in play.
    const earlier = new Set(names(`${run}/tasks/released`).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)));
    earlier.delete(first);
    const todo = [first, ...earlier];
    const seen = new Set();
    while (todo.length) {
        const id = todo.shift() ?? '';
        if (seen.has(id))
            continue;
        seen.add(id);
        if (earlier.has(id) && (existsSync(`${run}/tasks/ready/${id}.md`) || isDir(`${run}/tasks/claimed/${id}`) || existsSync(`${run}/tasks/done/${id}`)))
            continue;
        if (!earlier.has(id) && existsSync(`${run}/tasks/ready/${id}.md`)) {
            mkdirSync(`${run}/tasks/released`, { recursive: true });
            renameSync(`${run}/tasks/ready/${id}.md`, `${run}/tasks/released/${id}.md`);
        }
        else if (!existsSync(`${run}/tasks/released/${id}.md`))
            continue;
        for (const n of names(`${run}/tasks/ready`)) {
            if (!n.endsWith('.md'))
                continue;
            const b = n.slice(0, -3);
            // A dependent somebody is already working is theirs: taking its file away mid-task is the failure
            // this whole graveyard exists to avoid.
            if (isDir(`${run}/tasks/claimed/${b}`) || existsSync(`${run}/tasks/done/${b}`))
                continue;
            // Once per dependent, however many times its `after:` names the id.
            if (afterIds(read(`${run}/tasks/ready/${n}`)).includes(id)) {
                out(`  also released ${b}: its \`after:\` named ${id}, which nobody finished\n`);
                todo.push(b);
            }
        }
    }
}
// ---- sweep -----------------------------------------------------------------------------------------------
// Abandoned claims: a worker that dies holding a task leaves a claim nothing else cleans up. Conservative
// on purpose: it names candidates and releases them only when told to.
function sweep(c, a) {
    const run = c.run;
    const release = a[0] === '--release';
    // Heartbeats stop during a pause on purpose; reading that silence as death would reclaim every claim.
    if (existsSync(`${run}/PAUSED`)) {
        out(`run paused (${firstLine(`${run}/PAUSED`)}): no claim is reported or reclaimed while a pause stands\n`);
        return 0;
    }
    const nowsec = nowSec();
    let found = 0;
    for (const id of names(`${run}/tasks/claimed`, '/')) {
        const d = `${run}/tasks/claimed/${id}`;
        if (!isDir(d) || !live(id) || existsSync(`${run}/tasks/done/${id}`))
            continue;
        const owner = headOr(`${d}/owner`, 'NO OWNER');
        let hb = mtimeSec(`${d}/heartbeat`);
        if (Number.isNaN(hb))
            hb = mtimeSec(`${d}/owner`);
        // A `next` that died between its mkdir and its owner line left only the directory: its age is the claim's.
        if (Number.isNaN(hb))
            hb = mtimeSec(d);
        const age = !Number.isNaN(hb) && nowsec > 0 ? minutes(nowsec, hb) : 0;
        const budget = budgetOf(read(`${run}/tasks/ready/${id}.md`));
        // All three terms, as PULL.md requires: no done marker, quiet past one budget, the claim standing.
        if (age > Number(budget)) {
            found++;
            out(`ABANDONED? ${id}  ${owner}  quiet ${age}m against a ${budget}m budget\n`);
            const again = release ? refiledAs(run, id) : '';
            const lk = release && !again ? lockToRelease(run, id) : '';
            if (again) {
                out(`  not released: a handback already filed it again as ${again} and stopped before closing it; run handback for its chip again\n`);
            }
            else if (lk === 'closing') {
                out('  not released: its worker is closing it with finish right now\n');
            }
            else if (lk === 'done') {
                out('  not released: its worker finished it meanwhile (done marker written)\n');
            }
            else if (release) {
                const stamp = stampSuffix();
                // The task file goes FIRST, so a `next` in between cannot re-claim the same id; the task returns
                // under a new id.
                out('  released; the task file is in tasks/released/ - re-file it under a NEW id, never this one\n');
                releaseTask(c, id);
                renameSync(d, `${run}/tasks/claimed/${id}.released-${stamp}`);
            }
        }
    }
    // A pane walk is claimed by mkdir with no heartbeat, and a refused one stays claimed forever. The lease
    // has to outlast a slow walk, because there is no beat to refresh it.
    const lease = calint(c, 'pane_walk_lease_minutes', 30);
    for (const id of names(`${run}/pane/running`, '/')) {
        const d = `${run}/pane/running/${id}`;
        if (!isDir(d) || existsSync(`${run}/pane/results/${id}.json`))
            continue;
        let hb = mtimeSec(`${d}/owner`);
        // A pane-next killed between its mkdir and its owner line: the claim's own age.
        if (Number.isNaN(hb))
            hb = mtimeSec(d);
        const age = !Number.isNaN(hb) && nowsec > 0 ? minutes(nowsec, hb) : 0;
        if (age > lease) {
            found++;
            out(`ABANDONED? walk ${id}  ${headOr(`${d}/owner`, 'NO OWNER')}  claimed ${age}m ago against a ${lease}m lease\n`);
            if (release) {
                rmSync(d, { recursive: true, force: true });
                out("  released; the walk is pending again and the next 'pane-next' will hand it out\n");
            }
        }
    }
    if (found === 0)
        out('no abandoned claims\n');
    if (!release && found !== 0)
        out('Nothing was changed. Add --release once you have checked the workers are really gone.\n');
    return 0;
}
// ---- recover ---------------------------------------------------------------------------------------------
// The first `n` lines of a file without reading all of it: a transcript runs to tens of megabytes.
function headLines(p, n) {
    let fd;
    try {
        fd = openSync(p, 'r');
    }
    catch {
        return [];
    }
    const chunks = [];
    let nl = 0;
    try {
        const b = Buffer.alloc(65536);
        for (;;) {
            const k = readSync(fd, b, 0, b.length, null);
            if (k <= 0)
                break;
            const piece = Buffer.from(b.subarray(0, k));
            chunks.push(piece);
            for (const x of piece)
                if (x === 10)
                    nl++;
            if (nl >= n)
                break;
        }
    }
    catch { /* what was read is what there is */ }
    finally {
        closeSync(fd);
    }
    return Buffer.concat(chunks).toString('utf8').split('\n').slice(0, n);
}
// A cold start, after the machine died: what survived is on disk. Three lists - RESUME (a transcript to
// reopen), RESPAWN (no transcript), LANDED (done, nothing open) - and claims released only when asked.
function recover(c, a) {
    const run = c.run;
    const release = a[0] === '--release';
    const nowsec = nowSec();
    // The host lets an operator move its configuration directory: honour its variable, and the plugin's own
    // as the override. Spelled as the shell spells it, since it is printed.
    const proj = process.env.CLAUDE_PROJECTS_DIR || `${configDir()}/projects`;
    // Printed as the shell spelled it: Git Bash hands node $HOME and the like converted (/c/Users/x -> C:\Users\x).
    const projShown = process.platform === 'win32' && /^[A-Za-z]:/.test(proj) ? shellPath(proj) : proj;
    // Search rather than reconstruct the slug: one run can span worktrees.
    const transcript = (sid) => {
        const d = names(proj).find((p) => existsSync(`${proj}/${p}/${sid}.jsonl`));
        return d === undefined ? '' : `${proj}/${d}/${sid}.jsonl`;
    };
    // The directory a session was started in, from the first of its first lines that has one.
    const sessionCwd = (t) => {
        for (const l of headLines(t, 20)) {
            const m = /^.*"cwd":"([^"]*)"/s.exec(l);
            if (m)
                return (m[1] ?? '').split('\\\\').join('\\');
        }
        return '';
    };
    // An empty corpus is evidence of the wrong machine or directory, not that the workers are gone.
    const haveCorpus = names(proj).some((d) => names(`${proj}/${d}`).some((n) => n.endsWith('.jsonl')));
    if (!haveCorpus) {
        out(`== no session transcripts under ${projShown}\n`);
        out('  Every chip below will read as RESPAWN, and that is this command\'s blindness rather than a fact\n');
        out('  about the workers. Set CLAUDE_CONFIG_DIR or CLAUDE_PROJECTS_DIR if they live elsewhere.\n');
        if (release) {
            err('REFUSED: --release with no transcripts to judge by would free live workers\' claims.\n');
            err("  Use 'fleet.sh sweep --release', which asks the heartbeat question instead.\n");
            return 2;
        }
    }
    const livemin = calint(c, 'hook_claim_window_minutes', 10);
    // A worker that died before writing its marker is invisible to `landed`'s count: say both facts.
    if (existsSync(`${run}/FINISHED`)) {
        out('== this run declared itself finished\n');
        const fin = lf(read(`${run}/FINISHED`));
        out(indent(fin && !fin.endsWith('\n') ? `${fin}\n` : fin));
        out('  Anything listed as RESUME or RESPAWN below was open when that was written.\n');
    }
    // What a retired chip still waits on, for the coordinator to pass to its replacement (fleet-wait.md).
    const unanswered = (ch) => { const a = openAsks(c, ch); return a ? `, unanswered:${a}` : ''; };
    // The chip a session registered as; a CRLF file's \r is not part of it.
    const chipOf = (f) => read(f).replace(/[ \r\n]/g, '');
    // Claims standing: live, not done.
    const openClaims = () => names(`${run}/tasks/claimed`, '/').filter((id) => isDir(`${run}/tasks/claimed/${id}`) && live(id) && !existsSync(`${run}/tasks/done/${id}`));
    out('== chips this run registered\n');
    let any = 0;
    const idleDead = [], deadWalks = [], withTranscript = new Set();
    for (const sid of names(`${run}/chips`)) {
        const f = `${run}/chips/${sid}`;
        // A session id carries no dot; every dotted name is a hook's own bookkeeping.
        if (sid.includes('.'))
            continue;
        const chip = chipOf(f);
        if (!chip)
            continue;
        any++;
        const marker = ['done', 'blocked', 'waiting', 'retired'].filter((m) => existsSync(`${run}/${chip}.${m}`)).join('+');
        const claims = openClaims().filter((id) => ownedBy(`${run}/tasks/claimed/${id}/owner`, chip)).join(' ');
        // A pane walk it claimed is held work too: unnamed, a dead host's walk sat claimed until its lease.
        const walks = walksOf(c, chip);
        const open = [claims, ...walks.map((w) => `walk ${w}`)].filter(Boolean).join(' ');
        const t = transcript(sid);
        let quiet = '';
        if (t && nowsec > 0) {
            const m = mtimeSec(t);
            if (!Number.isNaN(m))
                quiet = String(minutes(nowsec, m));
        }
        const findings = existsSync(`${run}/${chip}.jsonl`) ? (grepC(`${run}/${chip}.jsonl`, /"severity"/) || '0') : '0';
        // .waiting is a question to the operator, not an end: a dead chip that left only that has not landed.
        const landedAs = ['done', 'blocked', 'retired'].some((m) => existsSync(`${run}/${chip}.${m}`));
        if (!open && landedAs) {
            // The session id belongs here too: a follow-up run wants a landed worker's context most.
            out(`  LANDED  chip ${chip}  ${marker}, ${findings} findings  (${sid})\n`);
        }
        else if (t && quiet && Number(quiet) < livemin) {
            // Reopening a session still running puts a second writer on an open file: no command.
            out(`  LIVE?   chip ${chip}  ${marker || 'no marker'}, ${findings} findings, holding: ${open || 'nothing'}, written ${quiet}m ago\n`);
            out(`          Wrote to its transcript inside the last ${livemin}m, so it may still be alive. Message it, or wait.\n`);
        }
        else if (t) {
            out(`  RESUME  chip ${chip}  ${marker || 'no marker'}, ${findings} findings, holding: ${open || 'nothing'}${quiet ? `, quiet ${quiet}m` : ''}\n`);
            // The right directory and a first instruction: a session reopened with no prompt sits there idle.
            const cwd = sessionCwd(t);
            const fst = claims.split(' ')[0] ?? '';
            out(`          ${cwd ? `cd "${cwd}" && ` : ''}claude -r ${sid} "Resumed after a crash. ${fst ? `Run fleet.sh beat on ${fst}, then ` : ''}continue the run."\n`);
            if (!cwd)
                out('          (its working directory is not in the transcript - run this from the directory the chip was started in)\n');
        }
        else {
            out(`  RESPAWN chip ${chip}  ${marker || 'no marker'}, ${findings} findings, holding: ${open || 'nothing'}\n`);
            const brief = existsSync(`${run}/brief-${chip}.md`);
            out(brief
                ? `          no transcript under ${projShown} - its context is gone. Its brief is unworked: 'fleet.sh relaunch ${c.absrun} --keep-coordinator --wait 0 ${chip}' copies it to a fresh chip and retires this one\n`
                : `          no transcript under ${projShown} - its context is gone, so re-file the task and spawn a fresh chip\n`);
            // Not a brief worker: it holds no claim while it works, and its brief would be dropped unworked.
            if (!claims && !landedAs && !brief)
                idleDead.push(chip);
            deadWalks.push(...walks.map((w) => [chip, w]));
        }
        if (t)
            withTranscript.add(chip);
    }
    if (any === 0)
        out('  none: no chip ever claimed through fleet.sh in this run\n');
    // A dead chip holding nothing is retired too under --release: nobody will write its marker, and the watch
    // counts every chip that ever registered.
    if (release) {
        // Not a chip another of its sessions can resume: that session's subagent may be walking it.
        const done = new Set();
        for (const [ch, w] of deadWalks) {
            // Two dead sessions of one chip list its walk twice.
            if (withTranscript.has(ch) || done.has(w))
                continue;
            done.add(w);
            try {
                rmSync(`${run}/pane/running/${w}`, { recursive: true, force: true });
                out(`  walk ${w} is pending again: its host's session is gone\n`);
            }
            catch { /* the sweep's lease frees it */ }
        }
        for (const ch of new Set(idleDead)) {
            if (withTranscript.has(ch) || existsSync(`${run}/${ch}.retired`))
                continue;
            writeFileSync(`${run}/${ch}.retired`, `respawned: session gone, nothing held, retired by recover ${stampSuffix()}${unanswered(ch)}\n`);
            out(`  retired chip ${ch}: its session is gone and it held nothing\n`);
        }
    }
    // Work nobody is holding decides how many chips to open after a cold start.
    let free = 0;
    for (const n of names(`${run}/tasks/ready`)) {
        if (!n.endsWith('.md'))
            continue;
        const id = n.slice(0, -3);
        if (existsSync(`${run}/tasks/done/${id}`) || isDir(`${run}/tasks/claimed/${id}`))
            continue;
        free++;
    }
    out('== queue\n');
    out(`  ${free} ready tasks nobody holds\n`);
    if (isDir(`${run}/tasks/released`))
        out(`  ${countGlob(`${run}/tasks/released`, '.md')} released tasks waiting to be re-filed under a new id\n`);
    if (release) {
        out('== releasing claims held by chips that cannot be resumed\n');
        let freed = 0, openclaims = 0;
        for (const id of openClaims()) {
            const d = `${run}/tasks/claimed/${id}`;
            openclaims++;
            // A resumable worker keeps its claim: taking it is how a live worker's work lands in the graveyard.
            const ochip = field(lf(read(`${d}/owner`)), /^chip (.*)$/s);
            let keep = false, known = false;
            // An owner with no chip line matches no session: it is UNKNOWN, never the empty chip file's.
            for (const s of ochip ? names(`${run}/chips`) : []) {
                if (s.includes('.') || chipOf(`${run}/chips/${s}`) !== ochip)
                    continue;
                known = true;
                if (transcript(s))
                    keep = true;
            }
            if (keep)
                continue;
            // A chip with no registered session is evidence of nothing; `sweep` asks the heartbeat question.
            if (!known) {
                out(`  UNKNOWN ${id} (chip ${ochip || 'unknown'}) - no session id was ever registered for that chip, so\n`);
                out("          this cannot tell a dead worker from a live one. Use 'fleet.sh sweep --release'.\n");
                continue;
            }
            // A heartbeat inside the task's budget may be a worker alive somewhere this machine cannot see (another
            // config dir, a cloud session), or one that died a minute ago in the crash this cold start answers.
            // Released either way, as recover is for; said, so the coordinator knows a live one would get CLAIM LOST.
            let hb = mtimeSec(`${d}/heartbeat`);
            if (Number.isNaN(hb))
                hb = mtimeSec(`${d}/owner`);
            const age = !Number.isNaN(hb) && nowsec > 0 ? minutes(nowsec, hb) : Infinity;
            const budget = budgetOf(read(`${run}/tasks/ready/${id}.md`));
            const fresh = age <= budget ? `\n          WARNING: it beat ${age}m ago, inside its ${budget}m budget. A worker still alive elsewhere gets CLAIM LOST at its next beat and stops.` : '';
            const again = refiledAs(run, id);
            if (again) {
                out(`  not released ${id}: a handback already filed it again as ${again} and stopped before closing it; run handback ${ochip} again\n`);
                continue;
            }
            const lk = lockToRelease(run, id);
            if (lk !== 'ok') {
                out(`  not released ${id}: ${lk === 'done' ? 'its worker finished it meanwhile (done marker written)' : 'its worker is closing it with finish right now'}\n`);
                continue;
            }
            const stamp = stampSuffix();
            freed++;
            out(`  released ${id} (chip ${ochip || 'unknown'}) - re-file it under a NEW id, never this one${fresh}\n`);
            // Task file first, claim second, as in sweep.
            releaseTask(c, id);
            renameSync(d, `${run}/tasks/claimed/${id}.released-${stamp}`);
            // Its session is gone and it will be respawned under a new number: retired, so the watch's count of
            // workers that must land does not wait on it for ever.
            if (ochip && !existsSync(`${run}/${ochip}.retired`))
                writeFileSync(`${run}/${ochip}.retired`, `respawned: session gone, claims released by recover ${stamp}${unanswered(ochip)}\n`);
        }
        if (freed === 0) {
            out(openclaims === 0 ? '  nothing to release: no claim is open\n'
                : `  nothing to release: all ${openclaims} open claims belong to chips that can be resumed\n`);
        }
    }
    else {
        out('== nothing was changed\n');
        out('  Resume what you can first. Add --release once you have reopened the resumable chips, so a\n');
        out('  worker that comes back does not find its own task handed to somebody else.\n');
    }
    return 0;
}
// ---- procs -----------------------------------------------------------------------------------------------
// Leftover test runs and typechecks (fleet-load.mjs --leftovers says what counts); `--kill` ends only those.
function procs(c, a) {
    const fl = process.env.FLEET_LOAD || '';
    let l = fl && existsSync(fl) ? fl : beside(c, 'fleet-load.mjs', 'makarasty', 'scripts/fleet-load.mjs');
    if (!l) {
        err('procs needs node and fleet-load.mjs\n');
        return 2;
    }
    l = resolve(l);
    // A closed chat's tree serving a port FLEET.md names is the run's service, not a leftover.
    const fm = `${posix.dirname(posix.dirname(c.absrun))}/FLEET.md`;
    const ports = [...new Set(read(fm).split('\n').filter((x) => x.startsWith('- Services:'))
            .flatMap((x) => x.replace(/^- Services: */, '').match(/:[0-9]{2,5}/g) ?? []).map((p) => p.slice(1)))].sort().join(',');
    const r = spawnSync(process.execPath, [l, '--leftovers', ...(a[0] === '--kill' ? ['--kill'] : [])], { stdio: 'inherit', env: { ...process.env, FLEET_KEEP_PORTS: ports } });
    return r.status ?? 1;
}
// ---- summary ---------------------------------------------------------------------------------------------
// The run's chips: every `*.jsonl` but what the merge writes beside them.
const chipIds = (c) => names(c.run).filter((n) => n.endsWith('.jsonl')).map((n) => n.slice(0, -6))
    .filter((n) => !['backlog', 'skipped', 'unreached', 'clusters', 'decisions'].includes(n));
// `chipcat`: one stream. A file with no last newline gets one: run into the next, its last finding went
// uncounted in the totals while its own row counted it.
const chipCat = (c) => chipIds(c).map((i) => read(`${c.run}/${i}.jsonl`)).map((t) => (t && !t.endsWith('\n') ? `${t}\n` : t)).join('');
// The end banner, from disk rather than anyone's memory, plus a JSON line a later script can read back.
function summary(c, a) {
    const run = c.run;
    const one = a[0] ?? '';
    const row = (ch) => {
        const f = `${run}/${ch}.jsonl`;
        const n = (existsSync(f) ? grepC(f, /"severity"/) : '0') || '0';
        // 0, not blank, for a worker with no findings file.
        const [b, m, mi, po] = ['blocker', 'major', 'minor', 'polish'].map((s) => grepC(f, SEV(s)) || '0');
        const u = grepC(f, /"unreached"/) || '0';
        let t = 0;
        for (const id of names(`${run}/tasks/claimed`)) {
            const o = `${run}/tasks/claimed/${id}/owner`;
            if (existsSync(o) && ownedBy(o, ch) && existsSync(`${run}/tasks/done/${id}`))
                t++;
        }
        let st = 'running';
        if (existsSync(`${run}/${ch}.retired`))
            st = 'RETIRED';
        if (existsSync(`${run}/${ch}.done`))
            st = 'done';
        if (existsSync(`${run}/${ch}.blocked`))
            st = 'BLIND';
        if (existsSync(`${run}/${ch}.waiting`))
            st = 'WAITING';
        out(`  ${ch.padEnd(4)} ${st.padEnd(8)} tasks ${String(t).padEnd(3)} findings ${n.padEnd(4)}  blocker ${(b ?? '').padEnd(3)} major ${(m ?? '').padEnd(3)} minor ${(mi ?? '').padEnd(3)} polish ${(po ?? '').padEnd(3)} unreached ${u}\n`);
    };
    const bar = '==============================================================\n';
    out(bar);
    if (one) {
        out(` WORKER ${one} FINISHED - ${base(c.absrun)}\n`);
        out(bar);
        row(one);
        if (existsSync(`${run}/${one}.blocked`))
            out(`  blind: ${firstLine(`${run}/${one}.blocked`)}\n`);
        out(`  findings: ${run}/${one}.jsonl     notes: ${run}/${one}.notes.md\n`);
    }
    else {
        out(` RUN FINISHED - ${base(c.absrun)}\n`);
        out(bar);
        // One row per worker: a pane host or a retired worker that filed no finding has no .jsonl, and its tasks
        // went missing from the rows while the totals counted them.
        const ends = names(run).filter((n) => /\.(done|blocked|retired|waiting)$/.test(n)).map((n) => n.replace(/\.[^.]*$/, ''));
        for (const ch of [...new Set([...chipIds(c), ...ends])].sort())
            row(ch);
        out('--------------------------------------------------------------\n');
        // The same files the rows were built from: a chip id that is not a number once printed rows full of
        // findings above a total of 0, which `landed` then paged to the phone.
        const all = chipCat(c);
        const tot = countLines(all, /"severity"/), tb = countLines(all, SEV('blocker')), tm = countLines(all, SEV('major'));
        const dn = countGlob(run, '.done'), bl = countGlob(run, '.blocked'), wt = countGlob(run, '.waiting');
        const rd = countGlob(`${run}/tasks/ready`, '.md'), td = names(`${run}/tasks/done`).length;
        out(`  workers done ${dn}, blind ${bl}, waiting on the operator ${wt}\n`);
        out(`  tasks ${td} of ${rd} finished, findings ${tot}, blockers ${tb}, majors ${tm}\n`);
        // Contract changes workers took without asking: what an operator most needs to see before landing.
        const dec = grepC(`${run}/decisions.jsonl`, ANY) || '0';
        if (Number(dec) > 0)
            out(`  contract changes decided without asking: ${dec}, in ${run}/decisions.jsonl - read them before landing\n`);
        out(`  backlog: ${run}/backlog.md\n`);
        out(`fleet-summary: {"run":"${base(c.absrun)}","workers_done":${dn},"blind":${bl},"waiting":${wt},"tasks_done":${td},"tasks_total":${rd},"findings":${tot},"blockers":${tb},"majors":${tm},"decisions":${dec}}\n`);
    }
    out(bar);
    return 0;
}
// ---- landed ----------------------------------------------------------------------------------------------
function landed(c, a) {
    const run = c.run;
    const want = need(c, a[0], 3, 'expected chip count required');
    let fail = 0;
    // Chips, not markers: a worker that went blind and then finished writes both, and counting files made
    // one worker look like two.
    const have = new Set(names(run).filter((n) => ['.done', '.blocked', '.retired'].some((s) => n.endsWith(s)))
        .map((n) => n.replace(/\.[^.]*$/, ''))).size;
    // `[ "$have" -ge "$want" ]`: a count that is not a number fails the test, with the shell's complaint.
    if (!/^[ \t]*[-+]?[0-9]+[ \t]*$/.test(want))
        err(`${c.sh}: [: ${want}: integer expression expected\n`);
    if (!(/^[ \t]*[-+]?[0-9]+[ \t]*$/.test(want) && have >= Number(want))) {
        out(`NOT LANDED: ${have} of ${want} workers finished\n`);
        fail = 1;
    }
    if (existsSync(`${run}/PAUSED`)) {
        out(`NOT LANDED: the run is paused (${firstLine(`${run}/PAUSED`)})\n`);
        fail = 1;
    }
    for (const id of names(`${run}/tasks/claimed`, '/')) {
        // A claim the planner took back is renamed, not deleted: closed, not open.
        if (!isDir(`${run}/tasks/claimed/${id}`) || !live(id))
            continue;
        if (!existsSync(`${run}/tasks/done/${id}`)) {
            out(`NOT LANDED: claim without a done marker: ${id}\n`);
            fail = 1;
        }
    }
    const claimed = names(`${run}/tasks/claimed`);
    for (const n of names(`${run}/tasks/ready`)) {
        if (!n.endsWith('.md'))
            continue;
        const id = n.slice(0, -3);
        // A released or dead claim still proves somebody took the task.
        const taken = isDir(`${run}/tasks/claimed/${id}`) || claimed.some((g) => (g.startsWith(`${id}.released-`) || g.startsWith(`${id}.dead-`)) && isDir(`${run}/tasks/claimed/${g}`));
        if (!taken) {
            const op = operatorOwed(read(`${run}/tasks/ready/${n}`));
            out(`NOT LANDED: task nobody ever claimed: ${id}${op ? ` (it waits on the operator: ${op}; fleet.sh cleared ${c.absrun} ${id} once done)` : ''}\n`);
            fail = 1;
        }
    }
    // A released task left the queue: re-filed under a new id, or the run is landing over abandoned work.
    for (const n of names(`${run}/tasks/released`)) {
        if (!n.endsWith('.md'))
            continue;
        const id = n.slice(0, -3);
        out(`NOT LANDED: ${id} was released and never accounted for. Either re-file its work under a NEW id\n`);
        out(`            and delete tasks/released/${id}.md, or delete that file alone to write the task off.\n`);
        fail = 1;
    }
    // Exists, not non-empty: a run that filed nothing has still ended.
    if (!existsSync(`${run}/backlog.jsonl`)) {
        out('NOT LANDED: backlog.jsonl is missing: run merge first\n');
        fail = 1;
    }
    if (countGlob(run, '.waiting') > 0) {
        out('NOT LANDED: a worker is waiting on the operator\n');
        fail = 1;
    }
    if (existsSync(`${run}/tasks/queue-open`)) {
        out('NOT LANDED: the planner has not closed the queue\n');
        fail = 1;
    }
    // Said, not refused: the coordinator decides what a late commit is.
    if (existsSync(`${run}/worktrees/integration`)) {
        const r = spawnSync('sh', ['-c', 'sh "$0" stranded "$1" 2>&1', c.sh, run], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
        const so = (r.stdout || '').replace(/\n+$/, '');
        if (r.status === 0) {
            const s = so.split('\n').filter((l) => l.startsWith('  STRANDED'));
            if (s.length)
                out(`WARNING: commits made after their branch was merged, which integration lacks:\n${s.join('\n')}\n`);
        }
        else {
            out(`WARNING: the stranded-commit check could not run: ${so.split('\n')[0] ?? ''}\n`);
        }
    }
    if (fail === 0) {
        // The run ends by declaration: FINISHED is the durable answer to "did it finish".
        const first = !existsSync(`${run}/FINISHED`);
        writeFileSync(`${run}/FINISHED`, `finished ${now()}\nworkers ${have}\n`);
        const cfg = configDir();
        rmSync(`${cfg}/makarasty/paused/${cksum(c.absrun)}.retired`, { force: true });
        const fs = `${cfg}/makarasty/fleet-sessions`;
        for (const s of names(fs)) {
            if (isFile(`${fs}/${s}`) && firstLine(`${fs}/${s}`).split('\r').join('') === c.absrun)
                rmSync(`${fs}/${s}`, { force: true });
        }
        out(`LANDED: ${have} workers, every claim closed, backlog written, FINISHED written\n`);
        // Then the phone, the first time only: the headline, never a finding. FINISHED is already on disk.
        const nf = beside(c, '../tools/hooks/notify.mjs', 'makarasty-tools', 'hooks/notify.mjs');
        if (first && nf) {
            const all = chipCat(c);
            const tot = countLines(all, /"severity"/), tb = countLines(all, SEV('blocker'));
            const bl = countGlob(run, '.blocked');
            spawnSync(process.execPath, [nf, 'send', `fleet ${base(c.absrun)} FINISHED: ${tot} findings, ${tb} blockers, ${bl} blind, backlog at ${run}/backlog.md`], { stdio: 'inherit' });
        }
    }
    return fail;
}
// ---- merge, render, fixqueue: fleet-merge.mjs --------------------------------------------------------------
function merge(c, cmd) {
    const m = beside(c, 'fleet-merge.mjs', 'makarasty', 'scripts/fleet-merge.mjs');
    if (!m) {
        err('fleet-merge.mjs not found beside fleet.sh\n');
        return 2;
    }
    return spawnSync(process.execPath, [m, cmd, c.run], { stdio: 'inherit' }).status ?? 1;
}
export const commands = {
    sweep,
    recover,
    procs,
    summary,
    landed,
    merge: (c) => merge(c, 'merge'),
    render: (c) => merge(c, 'render'),
    fixqueue: (c) => merge(c, 'fixqueue'),
};
