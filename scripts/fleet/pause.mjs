// pause.mts - stopping and replacing workers: pause, resume, paused, retire, handback, relaunch. Part of fleet.mjs; see src/scripts/fleet.mts.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readSync, renameSync, rmdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { need, out, err, isDir, isFile, read, firstLine, names, field, NEEDS, now, slashes, configDir, calint, live, laneGaps, wakeLoop, openAsks, indent, noCr, mtimeMs, newer, chipFinished, recordedVersion, versionReadable, versionOlder, claimHolders, registerChip, coordinatorSid, STOP_WHAT_YOU_STARTED, nativePath, cksum, sub, lf, claimsOf, started, AFTER } from './lib.mjs';
// ---- the shared pieces -----------------------------------------------------------------------------------
// The global marker is how hooks/run-dir.mjs finds a paused run without looking at the working directory:
// one file per paused run, named by a checksum of its absolute path and holding that path.
const pausedRoot = () => `${configDir()}/makarasty/paused`;
const pauseMark = (c) => `${pausedRoot()}/${cksum(c.absrun)}`;
// "This run has retired a chip": unlike the pause marker it outlives the pause. `landed` removes it.
const retiredMark = (c) => `${pauseMark(c)}.retired`;
// `rm -f a b ... 2>/dev/null || true`: each file on its own, a directory left standing.
function rmf(...ps) { for (const p of ps) {
    try {
        unlinkSync(p);
    }
    catch { /* gone or a directory */ }
} }
// `sed -n 's/^after:[[:space:]]*\(.*\)/\1/p'`: lib's AFTER ends in `(.*)$`, and JS `.` stops at a \r.
// This session belongs to a fleet run, recorded where the tools plugin's context hook looks.
function fleetSession(c) {
    const sid = process.env.CLAUDE_CODE_SESSION_ID || '';
    if (!sid)
        return;
    try {
        mkdirSync(`${configDir()}/makarasty/fleet-sessions`, { recursive: true });
        writeFileSync(`${configDir()}/makarasty/fleet-sessions/${sid}`, `${c.absrun}\n`);
    }
    catch { /* a courtesy */ }
}
// A brief worker holds no claim; it has something in hand until its .done, .blocked or .retired.
const briefBusy = (c, chip) => existsSync(`${c.run}/brief-${chip}.md`) && !chipFinished(c, chip);
// Git Bash differs from node in three ways these commands meet: `$(...)` cuts trailing \r\n pairs as well as
// newlines, its awk, sed and grep read a CRLF line as if the \r were not there, and a shell glob `<dir>/*/`
// sorts `t-a-r2/` before `t-a/` ('-' < '/'). Ported as Git Bash does it, the shell fleet.sh runs under.
// `grep -lx <chip> <run>/chips/*`: some session registered as this chip.
// `$(awk '/^path /{sub(/^path /,""); print; exit}' worktrees/<chip>)`
function worktreeOf(c, chip) {
    for (const l of lf(read(`${c.run}/worktrees/${chip}`)).split('\n'))
        if (l.startsWith('path '))
            return sub(`${l.slice(5)}\n`);
    return '';
}
// `git -C <tree> ... 2>/dev/null`, the tree already native.
function git(wt, args) {
    return spawnSync('git', ['-C', wt, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}
const dirty = (wt) => (git(wt, ['status', '--porcelain']).stdout || '').split('\n')[0] !== '';
// The mtime in whole seconds, or '' (fleet.sh's `mtime`).
function mtimeS(p) { const m = mtimeMs(p); return Number.isNaN(m) ? '' : String(Math.floor(m / 1000)); }
// `sed -n '/^CHIP /,/^$/p'`: each chip block, from its CHIP line to the blank line that ends it.
function chipBlocks(text) {
    const lines = text.replace(/\n$/, '').split('\n');
    let inside = false, o = '';
    for (const l of lines) {
        if (!inside && !l.startsWith('CHIP '))
            continue;
        o += `${l}\n`;
        inside = !inside || l !== '';
    }
    return text ? o : '';
}
// `sed 's/ max$/ xhigh/' want/<old> > want/<new>`: the wish travels with the lane, an effort above the
// ceiling written before 1.5.14 does not.
function copyWant(c, from, to) {
    writeFileSync(`${c.run}/want/${to}`, lf(read(`${c.run}/want/${from}`)).split('\n').map((l) => l.replace(/ max$/, ' xhigh')).join('\n'));
}
// `date +%Y%m%dT%H%M%S`
function stamp() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
// `head -c <max>` of stdin.
function readStdin(max) {
    const b = new Uint8Array(max);
    let n = 0;
    while (n < max) {
        let r = 0;
        try {
            r = readSync(0, b, n, max - n, null);
        }
        catch (e) {
            if (e.code === 'EAGAIN')
                continue;
            break;
        }
        if (r <= 0)
            break;
        n += r;
    }
    return new TextDecoder().decode(b.subarray(0, n));
}
const sleepS = (s) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000); };
const pad2 = (n) => String(n).padStart(2, '0');
// `$(absdir "$(dirname "$0")")`: the directory in git's spelling, or as given when it cannot be entered.
const absdir = (d) => isDir(d) ? slashes(resolve(d)) : d;
// ---- pause -----------------------------------------------------------------------------------------------
// A real pause. A message from the coordinator left workers going for a long time (2026-10-05/06): only a
// hook can stop a session mid-task. This writes the two files the hooks read (`<run>/PAUSED` and the global
// marker) and changes what `next`, `drained`, `sweep`, `clock` and `landed` do; the hooks do the stopping,
// one tool call at a time, after a grace period (hooks/run-dir.mjs).
//
// The acks live in `stopped/`, never `paused/`: on NTFS a directory `paused` and the file `PAUSED` are the
// same name. The reason comes from the argument, or from stdin when it is `-` - never by default: a call
// from a tool with an open, silent stdin would wait on it forever.
function pause(c, a) {
    const run = c.run;
    let reason = a[0] ?? '';
    if (reason === '-')
        reason = readStdin(500).split('\n').join(' ').replace(/ *$/, '');
    if (existsSync(`${run}/PAUSED`)) {
        out(`already paused: ${firstLine(`${run}/PAUSED`)}\n`);
    }
    else {
        // Acks left by an earlier pause would read as workers that have already stopped this time.
        rmf(...names(`${run}/stopped`).map((n) => `${run}/stopped/${n}`), `${run}/relaunch-waited`);
        mkdirSync(`${run}/stopped`, { recursive: true });
        writeFileSync(`${run}/PAUSED`, `${now()}${reason ? ` - ${reason}` : ''}\n`);
    }
    mkdirSync(pausedRoot(), { recursive: true });
    writeFileSync(pauseMark(c), `${c.absrun}\n`);
    const hold = claimHolders(c);
    const g = calint(c, 'pause_grace_seconds', 30);
    out(`PAUSED ${basename(c.absrun)}: ${firstLine(`${run}/PAUSED`)}\n`);
    out(`  ${hold.length} worker(s) hold claims${hold.length ? `: ${hold.join(' ')}` : ''}\n`);
    // The pause is enforced by the hooks of the plugin each worker runs, and only 1.5.9 and later have them.
    for (const h of hold) {
        const wv = recordedVersion(c, h);
        if (!existsSync(`${run}/chips/${h}.model`)) {
            out(`  worker ${h} never recorded its plugin (no whoami): if it is older than 1.5.9 its hooks will not hold it; check that it acks\n`);
        }
        else if (!wv || (versionReadable(wv) && versionOlder(wv, '1.5.9'))) {
            out(`  worker ${h} runs makarasty ${wv || '1.5.8 or 1.5.9'}: its hooks may not hold it; message it by its title (fleet ${basename(c.absrun)} ${h}) to stop\n`);
        }
    }
    out(`  Each worker gets ${g} s from its first call after this to finish the step in hand (${g * 4} s from now at the latest, for one that never calls); then the hooks refuse everything but git, fleet.sh and the wake loop.\n`);
    out(`  ACK: a worker that has stopped writes ${c.absrun}/stopped/<chip>. The watch prints 'worker NN stopped'; status shows\n`);
    out("  '== PAUSED since <time>: <k> of <n> workers holding claims have stopped', says 'no ack yet' for a worker that holds a claim,\n");
    out(`  and names it 'still working' after ${calint(c, 'pause_still_working_seconds', 150)} s.\n`);
    return 0;
}
// ---- resume ----------------------------------------------------------------------------------------------
// The pause lifted. Heartbeats first, then the marker that lets the workers go: a claim's age is its
// heartbeat's mtime, which did not move for the whole pause, so without the touch the first `sweep` after a
// long pause would call every claim abandoned. Only the mtime changes: `status` reads the content.
//
// The coordinator seat: a relaunch leaves `coordinator-pending`, and ONLY the fresh coordinator takes it, by
// saying `--take-over`. A plain `resume` from some other chat would otherwise become the coordinator whose
// context `ctx` measures, and the real one would never be asked again.
function resume(c, a) {
    const run = c.run;
    const arg = a[0] ?? '';
    if (arg && arg !== '--take-over') {
        err('usage: fleet.sh resume <run-dir> [--take-over]\n');
        return 2;
    }
    const take = arg === '--take-over';
    const takeSeat = () => {
        if (!existsSync(`${run}/coordinator-pending`)) {
            if (take)
                out('no coordinator-pending: the coordinator seat is not waiting for anyone\n');
            return;
        }
        if (!take) {
            out(`coordinator-pending is set: the fresh coordinator takes the seat with: sh "${c.sh}" resume "${c.absrun}" --take-over\n`);
            return;
        }
        const sid = process.env.CLAUDE_CODE_SESSION_ID || '';
        if (!sid) {
            out('coordinator-pending is still set: no session id here, so no coordinator was recorded\n');
            return;
        }
        writeFileSync(`${run}/coordinator`, `${sid}\n`);
        fleetSession(c);
        rmf(`${run}/coordinator-pending`, `${run}/.ctx-warned`, `${run}/chips/${sid}`);
        out(`this session is now the coordinator of ${basename(c.absrun)}\n`);
    };
    if (!existsSync(`${run}/PAUSED`)) {
        rmf(pauseMark(c));
        out('not paused\n');
        takeSeat();
        return 0;
    }
    for (const d of names(`${run}/tasks/claimed`)) {
        const hb = `${run}/tasks/claimed/${d}/heartbeat`;
        if (!live(d) || !isDir(`${run}/tasks/claimed/${d}`) || !existsSync(hb))
            continue;
        try {
            const t = new Date();
            utimesSync(hb, t, t);
        }
        catch { /* as touch 2>/dev/null */ }
    }
    rmf(`${run}/PAUSED`, pauseMark(c), ...names(`${run}/stopped`).map((n) => `${run}/stopped/${n}`), `${run}/relaunch-waited`);
    try {
        rmdirSync(`${run}/stopped`);
    }
    catch { /* not empty, or absent */ }
    takeSeat();
    out(`RESUMED ${basename(c.absrun)}: workers wake within ${calint(c, 'clock_poll_seconds', 30)} s; resumed: carry on with the claim you hold, call next only if you hold none\n`);
    return 0;
}
// ---- paused ----------------------------------------------------------------------------------------------
// A worker's acknowledgement: it has committed, stopped its subagents and background tasks, and waits on the
// printed loop, woken by the pause lifting, by being retired, or by the run landing. It registers the session
// too: a worker never handed a task (so never ran `next`) is otherwise unknown to the hooks.
function paused(c, a) {
    const run = c.run;
    const chip = need(c, a[0], 3, 'chip id required');
    // The coordinator is never paused: having run this to see what it does, it would register as the chip and
    // every hook would then hold the session that runs the run.
    const sid = process.env.CLAUDE_CODE_SESSION_ID || '';
    if (sid && coordinatorSid(c) === sid) {
        err(`REFUSED: this session is the coordinator of ${basename(c.absrun)}, not worker ${chip}. The coordinator is never paused; nothing to acknowledge.\n`);
        return 2;
    }
    registerChip(c, chip);
    // A retired chip commits nothing: its work was handed back (and any unsaved part committed) by `handback`.
    if (existsSync(`${run}/${chip}.retired`)) {
        out(`RETIRED: chip ${chip} was replaced by a fresh worker. You were retired: end this turn with one line, commit nothing, start nothing. ${STOP_WHAT_YOU_STARTED}\n`);
        return 9;
    }
    if (!existsSync(`${run}/PAUSED`)) {
        out('NOT PAUSED: nothing to acknowledge. Carry on.\n');
        return 1;
    }
    mkdirSync(`${run}/stopped`, { recursive: true });
    const held = claimsOf(c, chip).join(' ');
    writeFileSync(`${run}/stopped/${chip}`, `paused ${now()}\nclaims ${held}\n`);
    const wt = worktreeOf(c, chip);
    if (wt && dirty(nativePath(wt))) {
        out(`WARNING: ${wt} has uncommitted work. Commit it now so a fresh worker can continue from it:\n`);
        out(`  git -C "${wt}" add -A; git -C "${wt}" commit -m "wip: paused"\n`);
    }
    out(`STOPPED ${chip}: holding ${held || 'no claim'}\n`);
    // Where the worker stopped goes in its notes through this call, not a shell redirect: after the ack the
    // hook allows git, fleet.sh and the wake loop only, and a fresh worker reads these notes first.
    const note = a[1] ?? '';
    if (note) {
        appendFileSync(`${run}/${chip}.notes.md`, `stopped (paused ${now()}): ${note}\n`);
        out(`noted in ${chip}.notes.md: ${note}\n`);
    }
    else {
        out(`No note given: a fresh worker will not know where you stopped. Say it with a fourth argument: sh "${c.sh}" paused "${c.absrun}" ${chip} "<where you stopped, what is next>"\n`);
    }
    out('Background this wake loop now, end your turn, and start nothing else:\n');
    out(wakeLoop(c, chip));
    out('It prints resumed (carry on with the claim you hold; call next only if you hold none), retired (end with one line, nothing else) or run-finished.\n');
    return 0;
}
// ---- retire ----------------------------------------------------------------------------------------------
// A queue worker past its context mark is replaced without a pause: it leaves at its next `next`, where it
// holds no claim, so nothing goes back to the queue. The coordinator's context stays the operator's call
// (fleet-plan, 8b), and so does a brief worker's: a brief has no boundary.
function retire(c, a) {
    const run = c.run;
    const ch = need(c, a[0], 3, 'chip id required');
    if (!existsSync(`${run}/offered/${ch}`)) {
        err(`chip ${ch} was never offered in this run\n`);
        return 2;
    }
    const lane = noCr(firstLine(`${run}/offered/${ch}`));
    if (lane === 'brief') {
        err(`chip ${ch} works a brief, which has no task boundary to leave at: use the relaunch ask (docs/RELAUNCH.md)\n`);
        return 2;
    }
    if (chipFinished(c, ch)) {
        err(`chip ${ch} has already finished: nothing to retire\n`);
        return 2;
    }
    if (existsSync(`${run}/replaced/${ch}`)) {
        if (noCr(firstLine(`${run}/replaced/${ch}`)) === 'none') {
            out(`already retiring: chip ${ch} leaves at its next claim, and its lane had nothing left, so no chip replaces it.\n`);
        }
        else {
            out(`already retiring: chip ${ch} is replaced by ${sub(read(`${run}/replaced/${ch}`))}. Its chip was offered already: do not offer it again.\n`);
        }
        return 0;
    }
    // A worker on 1.5.13 or older never reads `.retiring` and would never leave.
    const wv = recordedVersion(c, ch);
    if (!wv || !versionReadable(wv) || versionOlder(wv, '1.5.14')) {
        err(`chip ${ch} runs makarasty ${wv || 'older than 1.5.8'}, which does not leave on its own: use the relaunch ask (docs/RELAUNCH.md, 'Replace workers ${ch} only')\n`);
        return 2;
    }
    // No replacement for a lane with nothing left to do: its chip would start, find the lane drained and end.
    let left = existsSync(`${run}/tasks/queue-open`);
    for (const n of names(`${run}/tasks/ready`)) {
        if (left)
            break;
        if (!n.endsWith('.md'))
            continue;
        const id = n.slice(0, -3);
        if (isDir(`${run}/tasks/claimed/${id}`) || existsSync(`${run}/tasks/done/${id}`))
            continue;
        // The lane as `next` reads it: the first word, a missing one being repo, and a repo worker also takes verify.
        const nd = field(read(`${run}/tasks/ready/${n}`), NEEDS) || 'repo';
        if (nd === lane || (lane === 'repo' && nd === 'verify'))
            left = true;
    }
    mkdirSync(`${run}/replaced`, { recursive: true });
    if (!left) {
        writeFileSync(`${run}/replaced/${ch}`, 'none\n');
        writeFileSync(`${run}/${ch}.retiring`, '\n');
        out(`RETIRING ${ch}: it leaves at its next claim. Lane ${lane} has nothing left to claim, so no chip replaces it.\n`);
        return 0;
    }
    // The number, taken atomically: two retires in one minute must not both print chip 09. A number a brief
    // file already names belongs to that brief's chip.
    let n = Math.max(0, ...names(`${run}/offered`).map((o) => o.replace(/^0*/, '')).filter((o) => /^[0-9]+$/.test(o)).map(Number)) + 1;
    let nw = '', tries = 0;
    while (!nw && tries < 50) {
        const nn = pad2(n);
        tries++;
        let made = false;
        if (!existsSync(`${run}/brief-${nn}.md`)) {
            try {
                writeFileSync(`${run}/offered/${nn}`, `${lane}\n`, { flag: 'wx' });
                made = true;
            }
            catch { /* taken */ }
        }
        if (made)
            nw = nn;
        else if (!existsSync(`${run}/offered/${nn}`) && !existsSync(`${run}/brief-${nn}.md`)) {
            err(`cannot write ${run}/offered/${nn}\n`);
            return 2;
        }
        n++;
    }
    if (!nw) {
        err(`no free chip number found after ${tries} tries\n`);
        return 2;
    }
    // `$(sh "$0" chips ... 2>&1)`: both streams, in their order.
    const r = spawnSync('sh', ['-c', 'sh "$0" chips "$1" "$2" "$3" 2>&1', c.sh, run, nw, lane], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
    const chipOut = sub(r.stdout || '');
    if (r.status !== 0) {
        rmf(`${run}/offered/${nw}`);
        err(`chips refused worker ${nw}, so nothing was retired: ${chipOut}\n`);
        return 2;
    }
    writeFileSync(`${run}/replaced/${ch}`, `${nw}\n`);
    writeFileSync(`${run}/${ch}.retiring`, `${nw}\n`);
    if (existsSync(`${run}/want/${ch}`)) {
        mkdirSync(`${run}/want`, { recursive: true });
        copyWant(c, ch, nw);
    }
    out(`RETIRING ${ch}: it finishes the task it holds and leaves at its next claim, its tree committed. Worker ${nw} takes lane ${lane}:\n`);
    out(chipBlocks(`${chipOut}\n`));
    out(`Offer that chip now, as its own spawn_task, then PushNotification the operator to click 'fleet ${basename(c.absrun)} ${nw}'. A watch armed from 1.5.14's fleet-wait counts it from now on, clicked or not; one armed earlier (a saved watch.sh pinned to an older plugin) must be re-armed from the current fleet-wait first.\n`);
    // A worker waiting on a model switch or acked into a pause holds nothing and may not call next for hours.
    if (!claimsOf(c, ch).length && (existsSync(`${run}/chips/${ch}.switch`) || existsSync(`${run}/stopped/${ch}`))) {
        let hb = '';
        handback(c, ch, (s) => { hb += s; });
        out(indent(hb));
        rmf(`${run}/${ch}.retiring`);
        const open = openAsks(c, ch);
        appendFileSync(`${run}/${ch}.retired`, `context, replaced by ${nw}, idle when retired${open ? `, unanswered:${open}` : ''}\n`);
        out(`  ${ch} was idle (waiting on a switch or a pause), so it is retired now.\n`);
    }
    return 0;
}
// ---- handback --------------------------------------------------------------------------------------------
// One worker leaves and its work stays. Each open claim is released the way the sweep releases one - renamed
// `<id>.released-<ts>`, so a late write from the old session lands in the graveyard - and the task is filed
// again as `<id>-r<n>` with three more lines: `continue-from: <branch>` (only when the worker's registered
// tree is on fleet/<chip>/<id>; any other branch is not this task's work), `continued-from-chip: <NN>` (whose
// notes to read) and `handback-of: <id>` (where `next` finds the old claim's fix proof).
//
// Unsaved work is committed as `wip: handed back` on the tree's branch; a detached HEAD first gets branch
// fleet/<chip>/<id>-handback. The old task file goes to tasks/handed-back/, not released/: `landed` refuses
// a released/ file nobody accounted for. Tasks whose `after:` named the old id are pointed at the new one.
function handback(c, chip, o = out) {
    const run = c.run;
    const ids = claimsOf(c, chip);
    if (existsSync(`${run}/${chip}.retired`) && !ids.length) {
        o(`already retired: ${chip}\n`);
        return 0;
    }
    const wt = worktreeOf(c, chip), nwt = wt ? nativePath(wt) : '';
    let br = '';
    if (wt && isDir(nwt)) {
        const h = git(nwt, ['rev-parse', '--abbrev-ref', 'HEAD']);
        br = h.status === 0 ? (h.stdout || '').replace(/\n+$/, '') : '';
        const firstid = ids[0] ?? '';
        if (br === 'HEAD') {
            br = '';
            if (firstid) {
                const k = git(nwt, ['checkout', '-q', '-b', `fleet/${chip}/${firstid}-handback`]);
                o(k.stdout || '');
                if (k.status === 0) {
                    br = `fleet/${chip}/${firstid}-handback`;
                    o(`  ${wt} was on a detached HEAD: its work is now on branch ${br}\n`);
                }
            }
        }
        if (dirty(nwt)) {
            const gid = git(nwt, ['config', 'user.email']).status === 0 ? [] : ['-c', 'user.name=fleet', '-c', 'user.email=fleet@localhost'];
            if (br && git(nwt, ['add', '-A']).status === 0 && git(nwt, [...gid, 'commit', '-q', '-m', 'wip: handed back']).status === 0) {
                o(`  COMMITTED the unsaved work of ${chip} on ${br} as 'wip: handed back'. Files:\n`);
                const f = git(nwt, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).stdout || '';
                if (f)
                    o(f.replace(/\n$/, '').split('\n').map((l) => `    ${l}\n`).join(''));
            }
            else {
                o(`  WARNING: ${wt} has uncommitted work and it could NOT be committed${br ? ` on ${br}` : ''}. It is not saved: commit it by hand before the fresh worker starts:\n`);
                o(`    git -C "${wt}" add -A; git -C "${wt}" commit -m "wip: handed back"\n`);
            }
        }
    }
    let n = 0;
    for (const id of ids) {
        const base = id.replace(/-r[0-9]+$/, '');
        let k = 1;
        while (existsSync(`${run}/tasks/ready/${base}-r${k}.md`) || existsSync(`${run}/tasks/handed-back/${base}-r${k}.md`))
            k++;
        const nw = `${base}-r${k}`;
        const src = `${run}/tasks/ready/${id}.md`;
        const cf = br === `fleet/${chip}/${id}` || br === `fleet/${chip}/${id}-handback` ? br : '';
        if (isFile(src)) {
            // sed rewrites the id and drops the three lines, awk adds them after the (first) task-id line.
            let t = lf(read(src));
            if (t.endsWith('\n'))
                t = t.slice(0, -1);
            let done = false, body = '';
            for (let l of t ? t.split('\n') : []) {
                if (/^(continue-from|continued-from-chip|handback-of):/.test(l))
                    continue;
                if (l.startsWith('task-id:'))
                    l = `task-id: ${nw}`;
                body += `${l}\n`;
                if (l.startsWith('task-id:') && !done) {
                    if (cf)
                        body += `continue-from: ${cf}\n`;
                    body += `continued-from-chip: ${chip}\nhandback-of: ${id}\n`;
                    done = true;
                }
            }
            writeFileSync(`${run}/tasks/ready/${nw}.md`, body);
            for (const fn of names(`${run}/tasks/ready`)) {
                if (!fn.endsWith('.md') || fn === `${nw}.md`)
                    continue;
                const f = `${run}/tasks/ready/${fn}`;
                const deps = field(read(f), AFTER).replace(/[,\r]/g, ' ');
                if (!` ${deps} `.includes(` ${id} `))
                    continue;
                // awk: every `after:` line re-split on blanks, its first field dropped (so `after:x` with no space
                // loses x), the old id swapped for the new one.
                let ft = lf(read(f));
                if (ft.endsWith('\n'))
                    ft = ft.slice(0, -1);
                writeFileSync(f, (ft ? ft.split('\n') : []).map((l) => {
                    if (!l.startsWith('after:'))
                        return `${l}\n`;
                    const parts = l.split(',').join(' ').split(/[ \t]+/).filter(Boolean).slice(1);
                    return `after:${parts.map((p) => ` ${p === id ? nw : p}`).join('')}\n`;
                }).join(''));
                o(`  ${fn.slice(0, -3)}: its after: now names ${nw}\n`);
            }
            mkdirSync(`${run}/tasks/handed-back`, { recursive: true });
            renameSync(src, `${run}/tasks/handed-back/${id}.md`);
            o(`  ${id} -> ${nw}${cf ? `  continue-from ${cf}` : ''}\n`);
            if (!cf)
                o(`  WARNING: ${chip} has no registered worktree on fleet/${chip}/${id}${br ? ` (it is on ${br})` : ''}, so ${nw} has no continue-from: the fresh worker starts from base and reads the notes of chip ${chip}\n`);
        }
        else {
            o(`  WARNING: ${id} has no task file in tasks/ready/ to file again; its claim is released and the planner re-files it\n`);
        }
        renameSync(`${run}/tasks/claimed/${id}`, `${run}/tasks/claimed/${id}.released-${stamp()}`);
        n++;
    }
    rmf(`${run}/tight/${chip}`);
    writeFileSync(`${run}/${chip}.retired`, `retired ${now()}\n`);
    // The hooks hold a retired chip after the pause lifts, and find the run through this marker.
    mkdirSync(pausedRoot(), { recursive: true });
    writeFileSync(retiredMark(c), `${c.absrun}\n`);
    o(`HANDED BACK ${chip}: ${n} task(s) filed again, ${chip}.retired written (its wake loop ends with: retired)\n`);
    return 0;
}
// ---- relaunch --------------------------------------------------------------------------------------------
// ONE controlled relaunch instead of a chain of handoff chips, each hop of which lost what was only in
// context (2026-10-05/06). It pauses, waits for the stops, hands the named workers' tasks back, then prints a
// fresh worker chip per retired one and - unless --keep-coordinator - one for a fresh coordinator.
//
//   fleet.sh relaunch <run> [--wait N] [--keep-coordinator] [NN ...]
//
// TWO calls, the same command twice: the first stops with an instruction while STATE.md is not newer than
// the pause and the handbacks (only the coordinator can say what replaced them); the second repeats nothing -
// every step is idempotent and a chip already given a replacement gets the same one - and prints the chips.
// With no chips only the coordinator is replaced. With --keep-coordinator only the named workers are, no
// coordinator chip or coordinator-pending is written, and this call resumes the run. Chips are two digits:
// a bare 1 was once read as chip 01 and retired it.
function relaunch(c, a) {
    const run = c.run;
    let waitMin = '5', keep = false;
    const list = [];
    for (let i = 0; i < a.length; i++) {
        const x = a[i] ?? '';
        if (x === '--wait') {
            if (i + 1 >= a.length) {
                err('--wait takes minutes: --wait 5\n');
                return 2;
            }
            waitMin = a[++i] ?? '';
        }
        else if (x.startsWith('--wait='))
            waitMin = x.slice(7);
        else if (x === '--keep-coordinator')
            keep = true;
        else if (/^[0-9]{2,3}$/.test(x))
            list.push(x);
        else {
            err(`not a chip number: ${x}. Chips are two digits (03); --wait takes minutes (--wait 5); --keep-coordinator keeps this coordinator.\n`);
            return 2;
        }
    }
    if (!/^[0-9]+$/.test(waitMin)) {
        err(`--wait takes whole minutes, got '${waitMin}'\n`);
        return 2;
    }
    if (keep && !list.length) {
        err('--keep-coordinator replaces workers: name at least one chip (03)\n');
        return 2;
    }
    for (const ch of list)
        if (!existsSync(`${run}/offered/${ch}`)) {
            err(`chip ${ch} was never offered in this run: nothing to replace\n`);
            return 2;
        }
    const runid = basename(c.absrun);
    // The second call does not wait again: the first collected the acks (and left `relaunch-waited`, which the
    // resume removes) and every chip being replaced is retired. A silent worker then is still silent.
    const nowait = existsSync(`${run}/PAUSED`) && existsSync(`${run}/relaunch-waited`) && list.every((ch) => existsSync(`${run}/${ch}.retired`));
    // 1. pause
    if (existsSync(`${run}/PAUSED`))
        out(`already paused: ${firstLine(`${run}/PAUSED`)}\n`);
    else
        pause(c, ['relaunch']);
    // 2. wait for every worker holding a claim to stop, naming the ones that never do. With --keep-coordinator
    //    only the workers being replaced matter: the others are resumed within a minute.
    const waitSet = () => keep ? list.filter((ch) => claimsOf(c, ch).length > 0 || briefBusy(c, ch)) : claimHolders(c);
    const nowS = () => Math.floor(Date.now() / 1000);
    const deadline = nowS() + Number(waitMin) * 60;
    let lastSilent = '-';
    if (nowait) {
        const seen = new Set([...waitSet(), ...list]);
        const k = [...seen].filter((ch) => existsSync(`${run}/stopped/${ch}`)).length;
        out(`acks: ${k} of ${seen.size} (not waited again)\n`);
    }
    while (!nowait) {
        const silent = waitSet().filter((ch) => !existsSync(`${run}/stopped/${ch}`)).map((ch) => ` ${ch}`).join('');
        if (!silent) {
            out('every worker holding a claim has stopped\n');
            break;
        }
        const left = deadline - nowS();
        if (left <= 0) {
            out(`NOT STOPPED after ${waitMin} min:${silent}. Message each by its title (fleet ${runid} <NN>) or go on without it:\n`);
            out('  its hooks refuse its work now, and a chip you replace is handed back whether it stopped or not.\n');
            break;
        }
        if (silent !== lastSilent) {
            out(`waiting for:${silent} (up to ${left}s)\n`);
            lastSilent = silent;
        }
        sleepS(5);
    }
    writeFileSync(`${run}/relaunch-waited`, '');
    // 3. hand back the chips being replaced
    for (const ch of list)
        handback(c, ch);
    // 4. the chips - only from a STATE.md written after the pause and the handbacks, which is what makes the
    //    first call end here and the second one print.
    let ref = mtimeS(`${run}/PAUSED`);
    for (const ch of list) {
        const m = mtimeS(`${run}/${ch}.retired`);
        if (m && Number(ref || 0) < Number(m))
            ref = m;
    }
    const sm = mtimeS(`${run}/STATE.md`);
    let stale = '';
    if (!isFile(`${run}/STATE.md`))
        stale = 'missing';
    else if (ref && sm) {
        if (Number(sm) < Number(ref))
            stale = 'older than the pause and the handbacks';
    }
    else if (!newer(`${run}/STATE.md`, `${run}/PAUSED`))
        stale = 'older than the pause';
    if (stale) {
        out('\n');
        out(`STATE.md NOT CURRENT: ${c.absrun}/STATE.md is ${stale}. No chips are printed yet.\n`);
        out('  Now update STATE.md - it must list the handed-back ids above and what replaced them (what is in flight,\n');
        out('  branches awaiting review, decisions pending) - then run the same command again. It is idempotent:\n');
        out('  nothing already done is repeated, and the second call prints the chips.\n');
        return 1;
    }
    let maxn = 0;
    for (const o of names(`${run}/offered`)) {
        const v = o.replace(/^0*/, '') || '0';
        if (/^[0-9]+$/.test(v) && Number(v) > maxn)
            maxn = Number(v);
    }
    mkdirSync(`${run}/replaced`, { recursive: true });
    out('\n');
    for (const ch of list) {
        let nw = noCr(firstLine(`${run}/replaced/${ch}`));
        // `retire` may have written `none`, or a replacement that is already running as its own worker.
        if (!nw || nw === 'none' || started(c, nw))
            nw = pad2(++maxn);
        const lane = firstLine(`${run}/offered/${ch}`);
        if (lane === 'brief') {
            if (!existsSync(`${run}/brief-${nw}.md`)) {
                try {
                    copyFileSync(`${run}/brief-${ch}.md`, `${run}/brief-${nw}.md`);
                }
                catch {
                    err(`cp: cannot stat '${run}/brief-${ch}.md': No such file or directory\n`);
                    return 1;
                }
                appendFileSync(`${run}/brief-${nw}.md`, `\n## Continuing\nThis brief was begun by worker ${ch}, which a relaunch retired. Read ${ch}.jsonl and ${ch}.notes.md first and continue from where they stop; do not redo what they filed.\n`);
            }
            out(chipBlocks(spawnSync('sh', [c.sh, 'chips', run, nw], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] }).stdout || ''));
        }
        else {
            out(chipBlocks(spawnSync('sh', [c.sh, 'chips', run, nw, lane], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] }).stdout || ''));
            // The replacement runs on what its predecessor was meant to run on.
            if (existsSync(`${run}/want/${ch}`))
                copyWant(c, ch, nw);
        }
        writeFileSync(`${run}/replaced/${ch}`, `${nw}\n`);
    }
    // How many workers the watch counts as finished at the end: every chip ever offered, retired included.
    const total = names(`${run}/offered`).length;
    const fsh = `${absdir(dirname(c.sh))}/fleet.sh`;
    const gap = laneGaps(c).filter((l) => !l.includes('is not a lane')).join('\n');
    if (keep) {
        if (gap)
            out(`STILL WITHOUT A WORKER:\n${gap}\n`);
        resume(c, []);
        out(`RELAUNCH READY for ${runid} (same coordinator): the run is resumed, the workers not replaced carry on.\n`);
        out('Do these now, in this order, in this one turn:\n');
        out(`  1. Re-arm the watch for the new worker count: TaskStop the fleet-wait monitor, then arm /makarasty:fleet-wait ${runid} ${total}.\n`);
        out('  2. Offer every CHIP above, each as its own mcp__ccd_session__spawn_task with exactly that title, tldr and prompt.\n');
        out('  3. Tell the operator in one line: click the worker chips; nothing else to do, the run is already running.\n');
        return 0;
    }
    writeFileSync(`${run}/coordinator-pending`, '');
    out(`CHIP coordinator\ntitle: fleet ${runid} coordinator\ntldr: Fresh coordinator of fleet run ${runid}, taking over after a relaunch. Click this one first; it reads STATE.md and resumes the run.\nprompt: You are the coordinator of fleet run ${runid}, taking over. Read ${c.absrun}/STATE.md in full, then sections 3b and 8b of the makarasty fleet-plan command (invoke /makarasty:fleet-plan only to read it if needed; do not re-run its interview or offer chips except those STATE.md lists as pending), then run \`sh ${fsh} resume ${c.absrun} --take-over\` and arm /makarasty:fleet-wait ${runid} ${total}.\n\n`);
    if (gap)
        out(`STILL WITHOUT A WORKER:\n${gap}\n`);
    out(`RELAUNCH READY for ${runid}: the run stays paused until the new coordinator resumes it.\n`);
    out('Do these now, in this order, in this one turn:\n');
    out(`  1. ${c.absrun}/STATE.md is current (checked: it is newer than the pause and the handbacks). Do not read diffs or dump files to add to it.\n`);
    out('  2. Stop your own watch: TaskStop on the fleet-wait monitor, so it does not report events the new coordinator must hear.\n');
    out('  3. Offer every CHIP above, the coordinator chip first, each as its own mcp__ccd_session__spawn_task with exactly that title, tldr and prompt.\n');
    out('  4. Tell the operator in one line: click the coordinator chip first, then the worker chips; the run stays paused until the new coordinator resumes it.\n');
    return 0;
}
export const commands = {
    pause,
    resume,
    paused,
    retire,
    handback: (c, a) => handback(c, need(c, a[0], 3, 'chip id required')),
    relaunch,
};
