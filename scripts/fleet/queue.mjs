// queue.mts - a worker's side of the queue: next, clock, beat, finish, find, ask, drained, whoami. Part of fleet.mjs; see src/scripts/fleet.mts.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { HERE, RUN_FORMAT, lf, need, out, err, isDir, isFile, read, firstLine, names, field, NEEDS, HANDBACK_OF, operatorOwed, now, cal, calint, pluginVersion, loadScript, claimsOf, verifyHeld, laneGaps, registerChip, chatGone, wakeLoop, indent, cat, STOP_WHAT_YOU_STARTED, nativePath, takeLock, dropLock, closing, CLOSING_STALE_MS, afterIds, taskKind, asText, noCr, chipFinished, budgetOf, refiledAs, writeWhole, walksOf } from './lib.mjs';
// ---- next ------------------------------------------------------------------------------------------------
export function next(c, chip, lane) {
    const run = c.run;
    registerChip(c, chip);
    // The plugin this worker runs now: after an update and a restart a resumed worker runs the new one.
    const model = `${run}/chips/${chip}.model`;
    if (existsSync(model)) {
        const pv = pluginVersion();
        try {
            const body = readFileSync(model, 'utf8').split('\n').map((l) => l.replace(/ plugin [^ ]*$/, () => ` plugin ${pv}`)).join('\n');
            writeFileSync(`${model}.tmp`, body);
            renameSync(`${model}.tmp`, model);
        }
        catch {
            rmSync(`${model}.tmp`, { force: true });
        }
    }
    if (existsSync(`${run}/${chip}.retired`)) {
        out(`RETIRED: chip ${chip} was replaced by a fresh worker. You were retired: end this turn with one line, commit nothing, start nothing. ${STOP_WHAT_YOU_STARTED}\n`);
        return 9;
    }
    if (existsSync(`${run}/FINISHED`)) {
        out(`RUN FINISHED: ${basename(c.absrun)} has landed. End this turn with one line, commit nothing, start nothing. ${STOP_WHAT_YOU_STARTED}\n`);
        return 9;
    }
    if (existsSync(`${run}/brief-${chip}.md`)) {
        err(`chip ${chip} works brief-${chip}.md, not the queue: go on with the brief from where your notes stop.\n`);
        return 2;
    }
    // `retire` asked this worker to leave at a task boundary, and `next` with no claim open is that boundary.
    if (existsSync(`${run}/${chip}.retiring`) && claimsOf(c, chip).length === 0) {
        // A walk this host is still running is not a boundary: handback would hand it to another host under its
        // browser subagent, and the subagent's pane-serve would find no claim.
        // Under a pause it is not served either: the pause below answers, with its wake loop.
        const walks = walksOf(c, chip);
        if (walks.length && !existsSync(`${run}/PAUSED`)) {
            err(`HOLDING walk ${walks.join(', ')}: you are retiring. Serve it with pane-serve, or if you cannot (a blind pane, your subagent gone) give it back with pane-serve <run> ${chip} <walk> --release; then call next again: it retires you and hands out nothing.\n`);
            return 2;
        }
    }
    if (existsSync(`${run}/${chip}.retiring`) && claimsOf(c, chip).length === 0 && !walksOf(c, chip).length) {
        const hb = spawnSync('sh', [c.sh, 'handback', run, chip], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
        out(indent(hb.stdout || ''));
        const r = firstLine(`${run}/${chip}.retiring`).split('\r').join('');
        rmSync(`${run}/${chip}.retiring`, { force: true });
        // handback wrote the unanswered asks into .retired already.
        appendFileSync(`${run}/${chip}.retired`, `context${r ? `, replaced by ${r}` : ''}\n`);
        out(`RETIRED: your context is past its mark${r ? ` and worker ${r} takes your lane` : ''}. You were retired: end this turn with one line, commit nothing, start nothing. ${STOP_WHAT_YOU_STARTED}\n`);
        return 9;
    }
    if (existsSync(`${run}/PAUSED`)) {
        out(`RUN PAUSED: ${firstLine(`${run}/PAUSED`)}. Nothing is handed out while a pause stands.\n`);
        out('Background this, end your turn, and after it prints resumed carry on with the claim you hold; call next only if you hold none (a pane worker may still take its one repo task):\n');
        out(wakeLoop(c, chip));
        return 8;
    }
    if (existsSync(`${run}/chips/${chip}.switch`)) {
        out('SWITCH PENDING: run whoami before claiming; on exit 10 end this turn as it says.\n');
        return 10;
    }
    mkdirSync(`${run}/tasks/claimed`, { recursive: true });
    // One chip, one claim, even from two `next` calls at once (two Bash calls in one turn took four tasks
    // between them): the check that it holds none and the claim it then makes happen under one lock.
    const lock = `${run}/tasks/claimed/.chip-${chip}`;
    if (!takeLock(lock, 2 * 60 * 1000)) {
        err(`BUSY: another next for chip ${chip} is claiming right now; use the task it prints.\n`);
        return 2;
    }
    try {
        return nextHeld(c, chip, lane);
    }
    finally {
        dropLock(lock);
    }
}
function nextHeld(c, chip, lane) {
    const run = c.run;
    const mine = claimsOf(c, chip);
    const openid = mine[0];
    // One repo task beside one pane task: the pane worker's idle window (docs/LANES.md), while its browser
    // subagent runs. Anything more is a second claim the worker cannot be working.
    // Either order: a pane task that closed first leaves the repo one, and the pane may take its next walk.
    // A verify task is the repo task: it is claimed through the repo lane.
    const heldLane = mine.length === 1 ? (field(read(`${run}/tasks/ready/${openid}.md`), NEEDS) || 'repo').replace(/^verify$/, 'repo') : '';
    // Only a chip offered for the pane lane: a repo worker asking for `pane` has no pane to walk it with.
    const paneChip = noCr(firstLine(`${run}/offered/${chip}`)) === 'pane';
    const idleWindow = !existsSync(`${run}/${chip}.retiring`) && ((heldLane === 'pane' && lane === 'repo') || (heldLane === 'repo' && lane === 'pane' && paneChip));
    if (openid && !idleWindow) {
        err(`HOLDING ${openid}: chip ${chip} already holds an open claim. Finish it, or hand it back, before asking for another task: next hands out nothing while you hold one.\n`);
        return 2;
    }
    if (!existsSync(`${run}/RUN_FORMAT`)) {
        try {
            writeFileSync(`${run}/RUN_FORMAT`, `${RUN_FORMAT}\n`);
        }
        catch { /* stamped next time */ }
    }
    mkdirSync(`${run}/tasks/claimed`, { recursive: true });
    mkdirSync(`${run}/tasks/done`, { recursive: true });
    // The one throttle on a fleet's own appetite: refuse the TASK below the floor, release above the clear
    // mark. Two thresholds, so workers held on one reading do not all claim again on the next.
    const loader = loadScript();
    if (loader) {
        const floor = cal(c, 'memory_floor_gb', '2');
        const clear = cal(c, 'memory_clear_gb', '4');
        if (spawnSync(process.execPath, [loader, '--clear', floor], { stdio: 'ignore' }).status !== 0) {
            mkdirSync(`${run}/tight`, { recursive: true });
            writeFileSync(`${run}/tight/${chip}`, `${now()}\n`);
            const j = spawnSync(process.execPath, [loader, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).stdout || '';
            let free = '';
            for (const line of j.split('\n')) {
                const m = /.*"freeGB":([0-9.]*)/.exec(line);
                if (m)
                    free = m[1] ?? '';
            }
            out(`MACHINE TIGHT: ${free || 'unknown'} GB free, floor ${floor} GB. Nothing is wrong with you; the box is full.\n`);
            out('Background this and wait. Do NOT write .done, and do not end this turn without it running:\n');
            out(`  [ -e "${c.absrun}/FINISHED" ] && { echo run-finished; exit 0; }; until node "${loader}" --clear ${clear} >/dev/null 2>&1${chatGone()}; do sleep 60; done; echo memory-back\n`);
            out('Then claim again. While you wait, give back what your browser holds: a tab keeps its renderer until\n');
            out('it is closed, and a reload returns none of it [M34]. tabs_create, tabs_select the new tab, then\n');
            out('tabs_close the heavy one. Keep one tab open: the last one closing closes the pane, and only the\n');
            out('operator can show it again.\n');
            return 6;
        }
        rmSync(`${run}/tight/${chip}`, { force: true });
    }
    let waiting = 0;
    let held; // verify_held, read again after any claim this scan lost to another worker
    for (const n of names(`${run}/tasks/ready`)) {
        const f = `${run}/tasks/ready/${n}`;
        // A directory named `<id>.md` was claimed and then crashed the read, leaving a claim nobody could close.
        if (!n.endsWith('.md') || !isFile(f))
            continue;
        const id = n.slice(0, -3);
        if (existsSync(`${run}/tasks/done/${id}`))
            continue;
        const text = read(f);
        // A worker with no pane must not claim a pane task; a repo worker, or one that named no lane, takes a
        // verify task, one at a time across the fleet.
        const want = field(text, NEEDS) || 'repo';
        if (want === 'verify') {
            if (lane === 'pane')
                continue;
            held ??= verifyHeld(c);
            if (held) {
                waiting++;
                continue;
            }
        }
        else if (lane && want !== lane) {
            continue;
        }
        // Held for the operator (`operator:`) or for a wave (`after:`).
        if (operatorOwed(text)) {
            waiting++;
            continue;
        }
        const deps = afterIds(text);
        if (deps.some((d) => !existsSync(`${run}/tasks/done/${d}`))) {
            waiting++;
            continue;
        }
        // mkdir is the claim's atomicity. The verify lane is one worker wide, and two workers could pass the held
        // check with two different verify tasks at the same instant: for a verify task, the check and the claim
        // happen together under the lane's own lock.
        if (want === 'verify') {
            const vlock = `${run}/tasks/claimed/.verify-lane`;
            if (!takeLock(vlock, 2 * 60 * 1000)) {
                waiting++;
                continue;
            }
            let won = false;
            try {
                held = verifyHeld(c);
                if (!held) {
                    try {
                        mkdirSync(`${run}/tasks/claimed/${id}`);
                        won = true;
                    }
                    catch { /* taken */ }
                }
            }
            finally {
                dropLock(vlock);
            }
            if (!won) {
                if (held)
                    waiting++;
                continue;
            }
        }
        else {
            try {
                mkdirSync(`${run}/tasks/claimed/${id}`);
            }
            catch {
                held = undefined;
                continue;
            }
        }
        const t = now();
        writeFileSync(`${run}/tasks/claimed/${id}/owner`, `chip ${chip}\nclaimed ${t}\n`);
        writeFileSync(`${run}/tasks/claimed/${id}/heartbeat`, `${t}\n`);
        // A handed-back task carries its fix proof across: only the `before` line, never the old tree's `after`.
        // From the old claim as it stands too: handback files the new task before it closes the old claim.
        const ho = field(text, HANDBACK_OF).split('\r').join('');
        if (ho) {
            for (const d of names(`${run}/tasks/claimed`, '/proof')) {
                const p = `${run}/tasks/claimed/${d}/proof`;
                if ((d !== ho && !d.startsWith(`${ho}.released-`)) || !isFile(p))
                    continue;
                const before = lf(read(p)).split('\n').filter((l) => l.includes('"phase":"before"'));
                appendFileSync(`${run}/tasks/claimed/${id}/proof`, before.length ? `${before[before.length - 1]}\n` : '');
            }
        }
        const b = String(budgetOf(text));
        out(`CLAIMED ${id}\nLANE ${lane || 'any'}\n`);
        if (want === 'verify' && lane !== 'verify') {
            out('VERIFY LANE: this is a verify task and the lane is one worker wide across the fleet.\n');
            out('  Nobody else can run a full suite until you finish it, so keep it scoped and close it.\n');
        }
        out(`BUDGET_MIN ${b}\n`);
        out(`ABORT_AFTER_SEC ${Number(b) * calint(c, 'budget_multiplier', 2) * 60}\n`);
        // Past the first few tasks, a task belongs in its own subagent [M30].
        if (want !== 'pane') {
            let dn = 0;
            for (const d of names(`${run}/tasks/claimed`)) {
                const owner = `${run}/tasks/claimed/${d}/owner`;
                if (lf(read(owner)).split('\n').includes(`chip ${chip}`) && existsSync(`${run}/tasks/done/${d}`))
                    dn++;
            }
            if (dn >= calint(c, 'delegate_past_tasks', 3)) {
                out(`DELEGATE: you have finished ${dn} tasks in this session and each left 20-30 k of context behind [M30].\n`);
                out('  Hand this task to ONE subagent at the task\'s model - task file, RULES.md, your notes - with findings filed through find. Keep your own context flat.\n');
            }
        }
        out(`ARM_CLOCK background what this prints: sh "${c.sh}" clock "${c.absrun}" ${chip} ${id} ${b}\n---\n`);
        out(readFileSync(f));
        return 0;
    }
    // "Drained" and "waiting on a wave that has not landed" are different states with different exit codes:
    // a worker told the first writes its `.done`.
    if (waiting > 0) {
        out(`QUEUE WAITING${lane ? ` for lane ${lane}` : ''}: ${waiting} task(s) held by an unfinished \`after:\` dependency, a held verify lane, or an \`operator:\` line not yet cleared\n`);
        out('  Poll rather than finishing: this queue opens again when those tasks land.\n');
        return 7;
    }
    for (const l of laneGaps(c))
        if (l.includes('is not a lane'))
            out(`${l}\n`);
    out(`QUEUE DRAINED${lane ? ` for lane ${lane}` : ''}\n`);
    return 3;
}
// ---- the small readers this group shares -----------------------------------------------------------------
// Git Bash's grep, sed and awk read a CRLF line as if it ended at the LF; a lone CR stays.
const lines = (text) => lf(text).split('\n');
// The owner file names this chip on a line of its own. The sh's `grep "chip $chip$"` had no `^`, so a line
// `achip 07` counted as chip 07's, and the chip was read as a regular expression.
const owns = (owner, chip) => lines(read(owner)).includes(`chip ${chip}`);
// All of stdin as bytes, as `cat` reads it.
function stdin() { try {
    return readFileSync(0);
}
catch {
    return Buffer.alloc(0);
} }
// ---- clock -----------------------------------------------------------------------------------------------
// The abort clock, printed rather than described: it wakes every poll, exits silently once its task is
// closed or its worker finished, and speaks only if the budget really elapsed - 87 plain `sleep` clocks were
// armed across two runs and none was ever stopped. Paths are absolute (a worktree has no `.fleet/`),
// `.blocked` and `.retired` close it as `.done` does, `FINISHED` ends every clock at once, and a round is not
// counted while PAUSED stands, so a resumed worker is not told its budget elapsed.
export function clock(c, chip, id, mins) {
    const mult = calint(c, 'budget_multiplier', 2), poll = calint(c, 'clock_poll_seconds', 30);
    // Decimal even with a leading zero, as `next` reads the task's budget: the sh read 010 as octal (8) and
    // died on 08, so a clock armed from `budget: 09` never ran.
    const m = /^[ \t\n]*(-?)([0-9]+)[ \t\n]*$/.exec(mins);
    const v = !m ? NaN : Number(m[2]);
    if (Number.isNaN(v)) {
        err(`${c.sh}: ${mins}: not a number\n`);
        return 1;
    }
    const rounds = Math.trunc(((m?.[1] ? -v : v) * mult * 60) / poll);
    const r = c.absrun;
    out(`[ -e "${r}/FINISHED" ] && exit 0; i=0; while [ $i -lt ${rounds} ]; do sleep ${poll}; [ -e "${r}/PAUSED" ] || i=$((i+1)); ` +
        `[ -e "${r}/FINISHED" ] && exit 0; [ -e "${r}/tasks/done/${id}" ] && exit 0; [ -e "${r}/${chip}.done" ] && exit 0; ` +
        `[ -e "${r}/${chip}.blocked" ] && exit 0; [ -e "${r}/${chip}.retired" ] && exit 0; done; echo budget-elapsed-${id}\n`);
    return 0;
}
// ---- beat ------------------------------------------------------------------------------------------------
export function beat(c, chip, id) {
    const d = `${c.run}/tasks/claimed/${id}`;
    if (!isDir(d) || !owns(`${d}/owner`, chip)) {
        out(`CLAIM LOST ${id}\n`);
        return 4;
    }
    writeFileSync(`${d}/heartbeat`, `${now()}\n`);
    out(`OK ${id}\n`);
    return 0;
}
// ---- finish ----------------------------------------------------------------------------------------------
export function finish(c, chip, id, branch) {
    const run = c.run, d = `${run}/tasks/claimed/${id}`;
    // A claim that is gone was released or reclaimed while this worker was busy, and the work behind it was
    // never checked: closing the task would let `landed` pass over it, so refuse as `beat` does.
    if (!isDir(d) || !owns(`${d}/owner`, chip)) {
        out(`CLAIM LOST ${id}, done marker NOT written\n`);
        return 4;
    }
    // Held from here to the marker; a handback, sweep or recover that got here first renamed the claim.
    if (!takeLock(closing(d), CLOSING_STALE_MS, `chip ${chip}`)) {
        // The lock may be this chip's own finish, called twice: never tell a worker its finished task is lost.
        if (existsSync(`${run}/tasks/done/${id}`)) {
            out(`DONE ${id} (already)\n`);
            return 0;
        }
        if (read(`${closing(d)}/pid`).split('\n')[1] === `chip ${chip}`) {
            out(`BUSY: another finish of ${id} by chip ${chip} is running; run this again in a few seconds\n`);
            return 2;
        }
        out(`CLAIM LOST ${id}, done marker NOT written: it is being handed back\n`);
        return 4;
    }
    try {
        // A handback killed after filing the task again and before closing this claim left its lock to a dead
        // pid; finishing over it got the task done and worked a second time under its new id.
        const again = refiledAs(run, id);
        if (again) {
            out(`CLAIM LOST ${id}, done marker NOT written: it was handed back as ${again}; the coordinator runs handback again to close it\n`);
            return 4;
        }
        return finishHeld(c, chip, id, branch);
    }
    finally {
        dropLock(closing(d));
    }
}
function finishHeld(c, chip, id, branch) {
    const run = c.run, d = `${run}/tasks/claimed/${id}`;
    writeFileSync(`${d}/heartbeat`, `${now()}\n`);
    // A fix arrives with a reproduction that failed before it and passes after; one fix run landed 164
    // changes with nothing checking that. Every fix task walks through here, so the gate reads the proof the
    // worker recorded with `fleet-gate.mjs prove`, and refuses a green over a tree that never moved.
    let task;
    // No task file is no way to tell a fix from anything else, so no done marker: the sh ended here silently.
    const tf = `${run}/tasks/ready/${id}.md`;
    try {
        task = readFileSync(tf, 'utf8');
    }
    catch {
        err(`done marker NOT written for ${id}: ${tf} cannot be read, so whether it is a fix that needs its proof cannot be told. A planner who moved it can put it back.\n`);
        return 2;
    }
    // Any spelling of the kind line: `kind:fix`, `Kind: Fix` and `kind: "fix"` are fixes too.
    const kind = taskKind(task);
    if (kind === 'fix' || kind === 'root') {
        // The gate ships beside fleet.mjs.
        const g = `${HERE}/fleet-gate.mjs`;
        // No gate to ask is no proof, not a pass.
        if (!existsSync(g)) {
            err(`done marker NOT written for ${id}: it is a ${kind} task and node or fleet-gate.mjs is missing,\n`);
            err('  so no reproduction can be read. Install node, or leave the task open for the planner.\n');
            return 1;
        }
        if (spawnSync(process.execPath, [g, 'check', c.absrun, id], { stdio: 'inherit' }).status !== 0) {
            err(`done marker NOT written for ${id}\n`);
            err('  Run the reproduction through the gate, then finish again:\n');
            err(`    node "${g}" prove "${c.absrun}" ${id} before -- <the task reproduction>   # before your change\n`);
            err(`    node "${g}" prove "${c.absrun}" ${id} after  -- <the same command>        # after it\n`);
            err('  A reproduction that passes BEFORE the change refutes the finding, which is a result and\n');
            err('  not a failure: write it up in your notes and finish with FLEET_REFUTED=1 set.\n');
            if (!process.env.FLEET_REFUTED)
                return 1;
            err(`FLEET_REFUTED set: closing ${id} as a refutation rather than as a fix.\n`);
        }
    }
    // Created only when absent, and the branch line only when a branch is given: a second `finish` without
    // one used to truncate the line the first recorded.
    mkdirSync(`${run}/tasks/done`, { recursive: true });
    const marker = `${run}/tasks/done/${id}`;
    // Worked out first and written once, whole: a finish killed between an empty marker and its branch line
    // left a done task whose branch nobody would merge.
    let body = '';
    // Where the committed work is, for whoever merges it. Only the marker's existence means done.
    if (branch) {
        let wt = '';
        for (const l of lines(read(`${run}/worktrees/${chip}`)))
            if (l.startsWith('path ')) {
                wt = l.slice(5);
                break;
            }
        // A branch that does not resolve is a typo or a commit that never happened: warn, the marker stays.
        const ref = `refs/heads/${branch}`;
        const gd = wt ? nativePath(wt) : '.';
        if (spawnSync('git', ['-C', gd, 'rev-parse', '--verify', '-q', ref], { stdio: 'ignore' }).status !== 0) {
            err(`WARNING: branch '${branch}' does not resolve in ${wt || 'the current directory'}; the marker records it anyway.\n`);
        }
        // The commit the task finished at: `stranded` reads it to see a branch merged and then worked on.
        const g = spawnSync('git', ['-C', gd, 'rev-parse', '-q', '--verify', ref], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const tip = g.status === 0 ? (g.stdout || '').replace(/\n+$/, '') : '';
        body = `branch ${branch}\n${tip ? `tip ${tip}\n` : ''}`;
    }
    if (body || !existsSync(marker))
        writeWhole(marker, body);
    out(`DONE ${id}${branch ? ` (branch ${branch})` : ''}\n`);
    out('The clock guarding it sees this marker within 30 seconds and exits on its own.\n');
    return 0;
}
const get = (v, k) => (v !== null && typeof v === 'object' ? v[k] : undefined);
// A coordinate, when JSON put a number there; NaN otherwise.
const num = (v, k) => { const x = get(v, k); return typeof x === 'number' ? x : NaN; };
// One JSON finding on stdin, validated - the only place the finding contract is enforced rather than
// requested - and appended to <chip>.jsonl only once it passed: appending first left an empty file behind
// a refused first finding, read later as a chip that filed nothing.
export function find(c, chip) {
    const run = c.run;
    if (!existsSync(`${run}/RUN_FORMAT`)) {
        try {
            writeFileSync(`${run}/RUN_FORMAT`, `${RUN_FORMAT}\n`);
        }
        catch { /* stamped next time */ }
    }
    let o;
    try {
        o = JSON.parse(stdin().toString('utf8'));
    }
    catch (e) {
        err(`REFUSED: not one JSON object: ${e.message}\n`);
        return 1;
    }
    // fleet.sh's node crashed on `null` with a stack trace; the same refusal, without the trace.
    if (o === null) {
        err('REFUSED: not one JSON object: Cannot read properties of null (reading \'what\')\n');
        return 1;
    }
    const sev = ['blocker', 'major', 'minor', 'polish'];
    const problems = [];
    // The retired field name belongs to no shape, so it is asked about before the shapes divide.
    if (get(o, 'what'))
        problems.push('`what` is the retired field name, use `observed`');
    if (get(o, 'unreached')) {
        if (!get(o, 'reason'))
            problems.push('unreached line needs reason');
    }
    else if (get(o, 'created') || get(o, 'state_changed')) {
        // An auxiliary line says what this worker DID to the environment. It is a different shape, not a lesser
        // finding: one extra `created` key once carried a blocker past every check below, and the merge routes
        // on `severity` alone, so a severity here would enter the backlog with nothing behind it.
        if (get(o, 'severity'))
            problems.push('an auxiliary line carries no severity; file what you found as its own finding');
        if (get(o, 'created') && !asText(get(o, 'where')).trim())
            problems.push('created needs where: the next person to read that sandbox has to find the row');
        if (get(o, 'state_changed') && !asText(get(o, 'when')).trim())
            problems.push('state_changed needs when: collection reads it as the window every later sighting was measured in');
    }
    else {
        for (const k of ['area', 'severity', 'observed', 'evidence', 'mechanism_status']) {
            const v = get(o, k);
            if (!v || asText(v).trim() === '')
                problems.push(`missing ${k}`);
        }
        const s = get(o, 'severity'), ms = get(o, 'mechanism_status'), ev = get(o, 'evidence');
        if (s && !sev.includes(s))
            problems.push(`severity not one of ${sev.join('|')}`);
        if (ms && !['established', 'hypothesis', 'unknown'].includes(ms))
            problems.push('mechanism_status not established|hypothesis|unknown');
        // A `file:line` is evidence however short (`a.txt:1`), as the protocol says.
        if (ev && asText(ev).length < 12 && !/^([A-Za-z]:)?[^\s:#,]+\.\w+((:\d+)+([-,]\d+)?|#L\d+(-L?\d+)?)$/.test(asText(ev).trim()))
            problems.push('evidence too thin to reproduce from');
        // A visual claim carries the two rectangles it is about, and they have to intersect: a model shown a
        // screenshot reports overlaps that are not there; geometry does not.
        const rects = get(o, 'rects');
        if (rects) {
            const a = get(rects, 'a'), b = get(rects, 'b');
            if (!a || !b)
                problems.push('rects needs both a and b');
            else if (!['x', 'y', 'w', 'h'].every((k) => Number.isFinite(num(a, k)) && Number.isFinite(num(b, k)))) {
                // A string coordinate used to be concatenated ("10" + "5" is "105"), and anything else read as NaN,
                // which no comparison refuses: a pair that proved nothing passed as overlapping.
                problems.push('rects needs numbers for x, y, w and h in both a and b');
            }
            else {
                const ox = Math.min(num(a, 'x') + num(a, 'w'), num(b, 'x') + num(b, 'w')) - Math.max(num(a, 'x'), num(b, 'x'));
                const oy = Math.min(num(a, 'y') + num(a, 'h'), num(b, 'y') + num(b, 'h')) - Math.max(num(a, 'y'), num(b, 'y'));
                if (ox <= 0 || oy <= 0)
                    problems.push('the rects in this finding do not intersect');
            }
            if (!/\d/.test(asText(get(o, 'conditions'))))
                problems.push('a visual finding states its viewport and zoom in conditions');
        }
    }
    if (problems.length) {
        err(`REFUSED: ${problems.join('; ')}\n`);
        return 1;
    }
    const f = o;
    f.when = f.when || new Date().toISOString();
    f.chip = f.chip || chip;
    const file = `${run}/${chip}.jsonl`;
    appendFileSync(file, `${JSON.stringify(f)}\n`);
    out(`FILED ${readFileSync(file).filter((x) => x === 10).length} lines in ${chip}.jsonl\n`);
    return 0;
}
// ---- ask -------------------------------------------------------------------------------------------------
export function ask(c, chip) {
    mkdirSync(`${c.run}/ask`, { recursive: true });
    let n = 1;
    // A number an answer already holds is taken too: that answer was meant for another question.
    while (existsSync(`${c.run}/ask/${chip}-${n}.md`) || existsSync(`${c.run}/answers/${chip}-${n}.md`))
        n++;
    writeFileSync(`${c.run}/ask/${chip}-${n}.md`, stdin());
    // Absolute: the asker is often in a worktree, where `.fleet/` does not exist under its cwd.
    out(`ASKED ${c.absrun}/ask/${chip}-${n}.md, read ${c.absrun}/answers/${chip}-${n}.md at your next boundary\n`);
    return 0;
}
// ---- drained ---------------------------------------------------------------------------------------------
export function drained(c, chip, lane) {
    const run = c.run;
    registerChip(c, chip);
    // A retired chip is finished without a `.done` (its work went back to the queue under new ids), and a
    // `.done` under a pause would end a worker the run is about to need back. Both come before the pane line.
    if (existsSync(`${run}/${chip}.retired`)) {
        out(`RETIRED: chip ${chip} was replaced by a fresh worker. You were retired: end this turn with one line, commit nothing, start nothing. ${STOP_WHAT_YOU_STARTED}\n`);
        return 9;
    }
    if (existsSync(`${run}/PAUSED`)) {
        out(`RUN PAUSED: ${firstLine(`${run}/PAUSED`)}. Do NOT write .done.\n`);
        out('Background this, end your turn, and call drained again only after it prints resumed:\n');
        out(wakeLoop(c, chip));
        return 8;
    }
    // A worker that still holds a claim has not drained: .done would end it with the task open until a sweep.
    const holding = claimsOf(c, chip)[0];
    if (holding) {
        err(`HOLDING ${holding}: chip ${chip} still holds an open claim. Finish it, or hand it back, before drained: no .done was written.\n`);
        return 2;
    }
    // So does a host with a walk unserved: its requester would wait for it until the lease.
    const walks = walksOf(c, chip);
    if (walks.length) {
        err(`HOLDING walk ${walks.join(', ')}: serve it with pane-serve, or give it back with pane-serve <run> ${chip} <walk> --release, before drained: no .done was written.\n`);
        return 2;
    }
    // A drained worker still holds its renderer, and only closing that tab gives it back [M34]. Closing the
    // LAST tab closes the pane, which only the operator can show again, so the tab is swapped.
    out('GIVE YOUR BROWSER MEMORY BACK if you opened a pane: tabs_create, tabs_select the new tab, then\n');
    out('tabs_close the heavy one. Keep that empty tab: the last tab closing closes the pane, and only the\n');
    out('operator can show it again. One heavy page measured 2,061 MB [M34].\n');
    const poll = `  [ -e "${c.absrun}/FINISHED" ] && { echo run-finished; exit 0; }; sleep 300; echo recheck\n`;
    // A drained queue is not the end of the run while the planner still intends to file work.
    if (existsSync(`${run}/tasks/queue-open`)) {
        out(`QUEUE OPEN: ${firstLine(`${run}/tasks/queue-open`)}\n`);
        // The poll carries the clocks' escape: one `landed` call has to end every wait on the machine.
        out('Nothing ready right now. Poll again rather than finishing:\n');
        out(poll);
        return 5;
    }
    // Nor while a ready task this worker could claim is unheld: a task behind an `after:` answers QUEUE
    // WAITING, and a worker that took that for the end wrote `.done` while its wave was still coming. The lane
    // rules are next's.
    let unheld = 0, opheld = 0;
    const stranded = [];
    for (const n of names(`${run}/tasks/ready`)) {
        if (!n.endsWith('.md') || !isFile(`${run}/tasks/ready/${n}`))
            continue;
        const id = n.slice(0, -3);
        if (existsSync(`${run}/tasks/done/${id}`))
            continue;
        // A claim whose worker already wrote .done, .blocked or .retired is held by nobody: the last worker of
        // a lane writing .done over it left the task open while the watch called the run complete.
        if (isDir(`${run}/tasks/claimed/${id}`)) {
            const holder = noCr(field(read(`${run}/tasks/claimed/${id}/owner`), /^chip ([^\n]*)$/));
            if (holder && !chipFinished(c, holder))
                continue;
        }
        const text = read(`${run}/tasks/ready/${n}`);
        if (lane) {
            const want = field(text, NEEDS) || 'repo';
            if (want === 'verify') {
                if (lane === 'pane')
                    continue;
            }
            else if (want !== lane)
                continue;
        }
        unheld++;
        // `next` cannot hand those out: the claim stands until somebody hands it back.
        if (isDir(`${run}/tasks/claimed/${id}`))
            stranded.push(`${id} (chip ${noCr(field(read(`${run}/tasks/claimed/${id}/owner`), /^chip ([^\n]*)$/)) || 'unknown'})`);
        if (operatorOwed(text))
            opheld++;
    }
    if (unheld > 0) {
        out(`QUEUE NOT EMPTY: ${unheld} ready task(s) nobody holds yet. Do NOT write .done.\n`);
        if (opheld > 0)
            out(`  ${opheld} of them wait on the operator; the coordinator has asked, and fleet.sh cleared releases each one.\n`);
        if (stranded.length)
            out(`  still claimed by a chip that has finished: ${stranded.join(', ')}. next cannot hand ${stranded.length === 1 ? 'it' : 'those'} out: file one ask naming ${stranded.length === 1 ? 'it' : 'them'}, so the coordinator runs fleet.sh handback for that chip.\n`);
        out(stranded.length === unheld ? 'Poll while the coordinator hands them back, rather than finishing:\n'
            : 'Claim again with next, and while it answers QUEUE WAITING poll rather than finishing:\n');
        out(poll);
        return 5;
    }
    // A ready task whose `needs:` is no lane is in nobody's count above, and `landed` would refuse over it
    // later: name it, and leave the marker unwritten so `status` shows it.
    const badlane = laneGaps(c).filter((l) => l.includes('is not a lane'));
    if (badlane.length) {
        out('QUEUE NOT EMPTY: a ready task names a lane nobody can work. Do NOT write .done.\n');
        out(`${badlane.join('\n')}\n`);
        out('Tell the coordinator (fleet.sh ask) and poll rather than finishing:\n');
        out(poll);
        return 5;
    }
    writeFileSync(`${run}/${chip}.done`, '');
    out(`QUEUE DRAINED, ${chip}.done written\n\n`);
    const s = spawnSync('sh', [c.sh, 'summary', run, chip], { stdio: 'inherit' }).status;
    if (s !== 0)
        return s ?? 1; // set -e
    const n = existsSync(`${run}/${chip}.jsonl`) ? read(`${run}/${chip}.jsonl`).split('\n').filter((l) => l.includes('"severity"')).length : 0;
    out(`\nRENAME THIS SESSION TO: fleet ${basename(run)} ${chip} - done ${n}f\n`);
    out('That title is the only thing about you visible from the chat the operator is sitting in.\n');
    return 0;
}
// ---- whoami ----------------------------------------------------------------------------------------------
// What this worker runs on, recorded before its first claim: every task once said `model: sonnet` and all
// seven workers were Opus. A session cannot switch itself and the coordinator's switch lands only on the
// worker's next turn, so a worker on the wrong model ends its turn here.
export function whoami(c, chip, model, effort, after) {
    const run = c.run, ch = `${run}/chips/${chip}`;
    mkdirSync(`${run}/chips`, { recursive: true });
    const pv = pluginVersion();
    writeFileSync(`${ch}.model`, `${model} ${effort} plugin ${pv}\n`);
    out(`recorded: chip ${chip} runs ${model} at effort ${effort}, plugin ${pv}\n`);
    const rm = (...sfx) => { for (const x of sfx)
        rmSync(`${ch}${x}`, { force: true }); };
    if (existsSync(`${run}/want/${chip}`)) {
        const w = read(`${run}/want/${chip}`).split('\r').join('').split('\n')[0] ?? '';
        const sp = w.indexOf(' ');
        const wm = sp < 0 ? w : w.slice(0, sp);
        const we = w.slice(wm.length).replace(/^ /, '') || 'any';
        const base = (s) => { const i = s.indexOf('['); return i < 0 ? s : s.slice(0, i); };
        // `claude-opus-5-5[1m]` and `claude-opus-5-5` are one model here: a worker without get_session reports
        // the id from its instructions, which carries no suffix. An effort it could not read is no mismatch:
        // it would stop again after every switch.
        const off = base(model) !== base(wm) || (we !== 'any' && effort !== 'unknown' && effort !== we);
        if (off) {
            const line = `${model} ${effort} -> ${wm} ${we}`;
            // The same mismatch right after the coordinator's switch means it did not take; stopping again would
            // loop for ever, so the worker goes on and the coordinator is told once. Any other wake keeps waiting.
            if (after === 'switched' && cat(`${ch}.switch`) === line) {
                rm('.switch', '.switch-warned', '.switch-failed-warned');
                writeFileSync(`${ch}.switch-failed`, `${line}\n`);
                out(`SWITCH DID NOT TAKE: still ${model} at ${effort}. Go on with your work on this model; the coordinator is told.\n`);
                return 0;
            }
            rm('.switch-warned');
            writeFileSync(`${ch}.switch`, `${line}\n`);
            const held = claimsOf(c, chip).join(' and ');
            out(`SWITCH: this session runs ${model} at ${effort}, and the run wants ${wm} at ${we}. Claim nothing new.${held ? ` Beat ${held} first.` : ''}\n`);
            out('Then end this turn with the one line: waiting for the coordinator to switch my model. Its message\n');
            out('wakes you; run whoami again as it says, and on exit 0 go on.\n');
            return 10;
        }
    }
    rm('.switch', '.switch-warned', '.switch-failed', '.switch-failed-warned');
    return 0;
}
// A lane is one of three words. A typo (`Repo`) matched no task, so the worker was told the queue had drained
// while its lane still held work, and wrote `.done`.
function laneOf(a) {
    const l = a ?? '';
    if (l === '' || l === 'pane' || l === 'repo' || l === 'verify')
        return l;
    err(`no such lane: ${l} (pane, repo, verify, or leave it out for any)\n`);
    return null;
}
export const commands = {
    next: (c, a) => { const chip = need(c, a[0], 3, 'chip id required'), l = laneOf(a[1]); return l === null ? 2 : next(c, chip, l); },
    clock: (c, a) => clock(c, need(c, a[0], 3, 'chip id required'), need(c, a[1], 4, 'task id required'), a[2] || '25'),
    beat: (c, a) => beat(c, need(c, a[0], 3, 'chip id required'), need(c, a[1], 4, 'task id required')),
    finish: (c, a) => finish(c, need(c, a[0], 3, 'chip id required'), need(c, a[1], 4, 'task id required'), a[2] ?? ''),
    find: (c, a) => find(c, need(c, a[0], 3, 'chip id required')),
    ask: (c, a) => ask(c, need(c, a[0], 3, 'chip id required')),
    drained: (c, a) => { const chip = need(c, a[0], 3, 'chip id required'), l = laneOf(a[1]); return l === null ? 2 : drained(c, chip, l); },
    whoami: (c, a) => whoami(c, need(c, a[0], 3, 'chip id required'), need(c, a[1], 4, 'model required'), a[2] || 'unknown', a[3] ?? ''),
};
