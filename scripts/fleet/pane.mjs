// pane.mts - the pane broker: pane-ask, pane-next, pane-serve, pane-status. Part of fleet.mjs; see src/scripts/fleet.mts.
import { existsSync, mkdirSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { need, out, err, isDir, isFile, lf, read, names, field, now, cal, mtimeMs, firstLine, wakeLoop, STOP_WHAT_YOU_STARTED, asText } from './lib.mjs';
import { basename } from 'node:path';
// `cat` of stdin: every byte, however the pipe hands them over.
function stdin() {
    const parts = [];
    const b = Buffer.alloc(65536);
    for (;;) {
        let n;
        try {
            n = readSync(0, b, 0, b.length, null);
        }
        catch (e) {
            const code = e.code;
            if (code === 'EAGAIN')
                continue;
            if (code === 'EOF')
                break;
            throw e;
        }
        if (n === 0)
            break;
        parts.push(Buffer.from(b.subarray(0, n)));
    }
    return Buffer.concat(parts);
}
// The walk's owner line names exactly this host. The sh matched `host $host$` as a regular expression,
// unanchored at the start, so a host `0.` or `[0-9]2` could serve the walk host 02 had claimed.
function ownerMatches(text, host) {
    return lf(text).split('\n').includes(`host ${host}`);
}
// The walks waiting to be handed out: regular files `<id>.md`, no dotfiles (pane-status never counts them),
// no directories (a claimed directory could never be served), an id with a space kept whole.
function pendingWalks(run) {
    return names(`${run}/pane/requests`).filter((f) => f.endsWith('.md') && isFile(`${run}/pane/requests/${f}`));
}
function paneDirs(run) {
    for (const d of ['requests', 'results', 'running'])
        mkdirSync(`${run}/pane/${d}`, { recursive: true });
}
// A browser walk, filed as a file, for whichever session is holding a pane. The requester does not need
// a pane, does not wait, and claims a repo task while the answer is being produced.
function paneAsk(c, chip) {
    const run = c.run;
    paneDirs(run);
    let n = 1;
    while (existsSync(`${run}/pane/requests/${chip}-${n}.md`) || existsSync(`${run}/pane/results/${chip}-${n}.json`))
        n++;
    writeFileSync(`${run}/pane/requests/${chip}-${n}.md`, stdin());
    out(`FILED ${c.absrun}/pane/requests/${chip}-${n}.md\n`);
    out(`READ  ${c.absrun}/pane/results/${chip}-${n}.json at your next task boundary\n`);
    return 0;
}
function paneNext(c, host) {
    const run = c.run;
    // A retired host, a landed run and a paused one hand out nothing, as `next` refuses: a walk claimed then
    // is work nobody reads, or work done through a pause.
    if (existsSync(`${run}/${host}.retired`)) {
        out(`RETIRED: host ${host} was replaced. End this turn with one line and start nothing. ${STOP_WHAT_YOU_STARTED}\n`);
        return 9;
    }
    if (existsSync(`${run}/FINISHED`)) {
        out(`RUN FINISHED: ${basename(c.absrun)} has landed; no walk is handed out. ${STOP_WHAT_YOU_STARTED}\n`);
        return 9;
    }
    // A host that keeps taking walks never reaches the boundary `retire` waits for.
    if (existsSync(`${run}/${host}.retiring`)) {
        err(`RETIRING: host ${host} takes no new walk. Serve the walk you hold, if any, then call next: it retires you.\n`);
        return 2;
    }
    if (existsSync(`${run}/PAUSED`)) {
        out(`RUN PAUSED: ${firstLine(`${run}/PAUSED`)}. No walk is handed out while a pause stands.\n`);
        out('Background this, end your turn, and after it prints resumed ask for a walk again:\n');
        out(wakeLoop(c, host));
        return 8;
    }
    paneDirs(run);
    // Oldest first by the time it was filed. The glob's order is lexical, which put `07-10` before `07-2`
    // and every walk of chip 02 before any of chip 07, whatever waited longest.
    const d = `${run}/pane/requests`;
    const order = pendingWalks(run).map((f) => [mtimeMs(`${d}/${f}`), f.slice(0, -3)])
        .sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map((x) => x[1]);
    for (const id of order) {
        const f = `${d}/${id}.md`;
        if (existsSync(`${run}/pane/results/${id}.json`))
            continue;
        // Read before claiming: a request that cannot be read is refused without leaving a claim behind.
        let body;
        try {
            body = readFileSync(f);
        }
        catch (e) {
            err(`pane-next: cannot read ${f}: ${e.code ?? String(e)}; skipped\n`);
            continue;
        }
        try {
            mkdirSync(`${run}/pane/running/${id}`);
        }
        catch {
            continue;
        } // mkdir is the claim's atomicity
        writeFileSync(`${run}/pane/running/${id}/owner`, `host ${host}\nclaimed ${now()}\n`);
        out(`WALK ${id}\n---\n`);
        out(body);
        return 0;
    }
    out('NO WALKS PENDING\n');
    return 3;
}
function paneServe(c, host, id, release) {
    const run = c.run;
    if (!isDir(`${run}/pane/running/${id}`)) {
        err(`no claimed walk ${id}\n`);
        return 2;
    }
    const owner = `${run}/pane/running/${id}/owner`;
    if (!existsSync(owner) || !ownerMatches(read(owner), host)) {
        err(`WALK LOST ${id}\n`);
        return 4;
    }
    // A host that cannot serve (a blind pane, its subagent gone) gives the walk back now, not at the lease.
    if (release) {
        rmSync(`${run}/pane/running/${id}`, { recursive: true, force: true });
        out(existsSync(`${run}/pane/results/${id}.json`) ? `RELEASED ${id}: it was served already; only its claim was dropped\n` : `RELEASED ${id}: pending again for another host\n`);
        return 0;
    }
    const gateMin = cal(c, 'frame_gate_min_fps', '10');
    const claimedAt = field(read(owner), /^claimed ([^\n]*)/);
    const input = stdin().toString('utf8');
    const res = `${run}/pane/results/${id}.json`;
    if (!isDir(`${run}/pane/results`)) {
        err(`${c.sh}: ${res}: No such file or directory\n`);
        return 1;
    }
    let o;
    try {
        const v = JSON.parse(input);
        // `null`, a number or an array parses too, and has no fields to check.
        if (typeof v !== 'object' || v === null || Array.isArray(v))
            throw new Error('not an object');
        o = v;
    }
    catch (e) {
        err(`REFUSED: not one JSON object: ${e.message}\n`);
        rmSync(res, { force: true });
        return 1;
    }
    const p = [];
    // The requester never saw the pane, so the result has to carry the proof the pane was real. This is
    // the one thing a session driving its own pane could never check about itself.
    const floor = Number(gateMin);
    if (typeof o.gate !== 'number')
        p.push('gate: the frame count this walk was measured under, as a number');
    else if (o.gate < floor)
        p.push(`gate reads ${o.gate}, which is blind below ${floor}: do not serve a blind walk`);
    if (!o.conditions || !/\d/.test(asText(o.conditions)))
        p.push('conditions naming viewport and zoom');
    if (!Array.isArray(o.observations))
        p.push('observations: an array, empty is a real answer');
    if (p.length) {
        err(`REFUSED: ${p.join('; ')}\n`);
        rmSync(res, { force: true });
        return 1;
    }
    o.served_at = new Date().toISOString();
    o.host = host;
    // The claim time travels into the result because the claim directory is about to be deleted, and
    // without it nobody can say afterwards how long a walk actually took.
    if (claimedAt)
        o.claimed_at = claimedAt;
    writeFileSync(res, `${JSON.stringify(o)}\n`);
    rmSync(`${run}/pane/running/${id}`, { recursive: true, force: true });
    out(`SERVED ${id} -> ${res}\n`);
    return 0;
}
function paneStatus(c) {
    const run = c.run;
    if (!isDir(`${run}/pane/requests`)) {
        out('no pane broker in this run\n');
        return 0;
    }
    let pend = 0, oldest = 0;
    const nowsec = Math.floor(Date.now() / 1000);
    for (const n of pendingWalks(run)) {
        if (existsSync(`${run}/pane/results/${n.slice(0, -3)}.json`))
            continue;
        pend++;
        const m = mtimeMs(`${run}/pane/requests/${n}`);
        const t = Number.isNaN(m) ? nowsec : Math.floor(m / 1000);
        const age = Math.trunc((nowsec - t) / 60);
        if (age > oldest)
            oldest = age;
    }
    const d = `${run}/pane/results`;
    const results = names(d).filter((n) => n.endsWith('.json') && isFile(`${d}/${n}`));
    const served = results.length;
    let median = '';
    const mins = [];
    // One unreadable result skips itself, not every lease after it.
    for (const f of results) {
        let o;
        try {
            o = JSON.parse(readFileSync(`${d}/${f}`, 'utf8'));
        }
        catch {
            continue;
        }
        if (o && o.claimed_at && o.served_at) {
            const m = (Date.parse(o.served_at) - Date.parse(o.claimed_at)) / 60000;
            if (Number.isFinite(m) && m >= 0)
                mins.push(m);
        }
    }
    if (mins.length) {
        mins.sort((a, b) => a - b);
        median = String(Math.round(mins[Math.floor(mins.length / 2)] ?? 0));
    }
    out(`pane walks: ${pend} pending, oldest waiting ${oldest}m, ${served} served${median ? `, median lease ${median}m` : ''}\n`);
    // One host is enough until a walk waits longer than a walk takes. Falls back to a flat twenty minutes
    // only while no walk has been served yet and there is no lease to compare against.
    let behind = median;
    if (!behind) {
        behind = '20';
        if (pend > 0)
            out('  no walk has been served yet, so this compares against a flat 20 minutes\n');
    }
    if (pend > 0 && oldest > Number(behind)) {
        out('  the pane lane is behind: the oldest walk has waited longer than a lease takes. Offer one more host chip\n');
    }
    return 0;
}
export const commands = {
    'pane-ask': (c, a) => paneAsk(c, need(c, a[0], 3, 'chip id required')),
    'pane-next': (c, a) => paneNext(c, need(c, a[0], 3, 'host chip id required')),
    'pane-serve': (c, a) => paneServe(c, need(c, a[0], 3, 'host chip id required'), need(c, a[1], 4, 'walk id required'), a[2] === '--release'),
    'pane-status': (c) => paneStatus(c),
};
