// watch.mts - the coordinator's views: status, ctx, contexts. Part of fleet.mjs; see src/scripts/fleet.mts.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { tmpdir } from 'node:os';
import { lf, sub, out, isDir, read, firstLine, names, now, slashes, configDir, cal, calint, pluginVersion, live, claimsOf, laneGaps, cat, noCr, mtimeMs, newer, olderThanMin, chipFinished, started, recordedVersion, versionReadable, versionOlder, installedVersion, claimHolders, workerSessions, sessionCtx, coordinatorSid, coordCtx, gt, afterIds, operatorOwed, isFile } from './lib.mjs';
// ---- ctx and contexts ------------------------------------------------------------------------------------
// One line per session whose context crosses its next mark, nothing otherwise; the watch calls this every
// minute. Past either mark the coordinator asks the operator once (fleet-plan, 8b).
export function ctx(c) {
    const run = c.run, absrun = c.absrun;
    const at = calint(c, 'coordinator_handoff_k', 700), step = calint(c, 'coordinator_handoff_step_k', 100);
    const wat = calint(c, 'worker_relaunch_k', 700);
    const k = coordCtx(c);
    if (k) {
        if (Number(k) >= at) {
            const level = at + Math.floor((Number(k) - at) / step) * step;
            if (gt(level, cat(`${run}/.ctx-warned`, '0'))) {
                writeFileSync(`${run}/.ctx-warned`, `${level}\n`);
                out(`COORDINATOR CONTEXT ${k}K (mark ${at}K): bring ${absrun}/STATE.md up to date, then ask the operator once whether to relaunch the run with a fresh coordinator (fleet-plan, 8b). Do not hand off by chip and do not relaunch unasked. Past this size the reviews you hold start to fall out of context.\n`);
            }
        }
        else {
            rmSync(`${run}/.ctx-warned`, { force: true });
        }
    }
    // Workers: one state file per session, so a worker is named once per mark and a reopened chip starts over.
    for (const [chip, sid] of workerSessions(c)) {
        if (chipFinished(c, chip))
            continue;
        const wk = sessionCtx(sid);
        if (!wk)
            continue;
        const st = `${run}/chips/${sid}.ctx-warned`;
        if (Number(wk) < wat) {
            rmSync(st, { force: true });
            continue;
        }
        const lv = wat + Math.floor((Number(wk) - wat) / step) * step;
        if (!gt(lv, cat(st, '0')))
            continue;
        writeFileSync(st, `${lv}\n`);
        const h = claimsOf(c, chip).join(' ');
        const held = h ? `holds ${h}` : 'no claim';
        const relaunch = `put it in the ONE relaunch ask to the operator (fleet-plan, 8b; the option 'Replace workers ${chip} only' is fleet.sh relaunch ${absrun} --keep-coordinator ${chip}).`;
        if (existsSync(`${run}/${chip}.retiring`) || existsSync(`${run}/${chip}.retired`))
            continue;
        if (noCr(firstLine(`${run}/offered/${chip}`)) === 'brief') {
            out(`WORKER CONTEXT ${chip} ${wk}K (mark ${wat}K, ${held}): a brief worker; ${relaunch}\n`);
            continue;
        }
        const cv = recordedVersion(c, chip);
        if (cv && versionReadable(cv) && !versionOlder(cv, '1.5.14')) {
            out(`WORKER CONTEXT ${chip} ${wk}K (mark ${wat}K, ${held}): run fleet.sh retire ${absrun} ${chip} now, unasked, and do what it prints. The worker finishes the task it holds and leaves at its next claim; the run does not pause.\n`);
        }
        else {
            out(`WORKER CONTEXT ${chip} ${wk}K (mark ${wat}K, ${held}): runs makarasty ${cv || 'unknown'}, which does not leave on its own; ${relaunch}\n`);
        }
    }
    // The watch runs this in the coordinator's session: that keeps its fleet-sessions record fresh.
    const sid = process.env.CLAUDE_CODE_SESSION_ID || '';
    if (sid && coordinatorSid(c) === sid) {
        try {
            mkdirSync(`${configDir()}/makarasty/fleet-sessions`, { recursive: true });
            writeFileSync(`${configDir()}/makarasty/fleet-sessions/${sid}`, `${absrun}\n`);
        }
        catch { /* a courtesy */ }
    }
    runawayLogs(c);
    const iv = installedVersion();
    const runid = basename(absrun);
    for (const chip of names(`${run}/offered`)) {
        // A replacement nobody clicked leaves its lane short. Checked before the finished test: the old worker
        // is usually retired by the time this matters.
        const rp = noCr(cat(`${run}/replaced/${chip}`));
        if (rp && rp !== 'none' && existsSync(`${run}/offered/${rp}`) && !started(c, rp) &&
            olderThanMin(`${run}/replaced/${chip}`, 10) && !existsSync(`${run}/replaced/${chip}.nagged`)) {
            writeFileSync(`${run}/replaced/${chip}.nagged`, '');
            out(`REPLACEMENT ${rp} for worker ${chip} was offered over ten minutes ago and has not started: PushNotification the operator to click the chip titled 'fleet ${runid} ${rp}'.\n`);
        }
        if (chipFinished(c, chip))
            continue;
        // A worker that stopped itself at `whoami` waits for one act of the coordinator's; said again every
        // ten minutes, since a compaction loses a line printed once.
        const sw = `${run}/chips/${chip}.switch`, sww = `${run}/chips/${chip}.switch-warned`;
        if (existsSync(sw) && (cat(sw) !== cat(sww) || olderThanMin(sww, 10))) {
            let body;
            try {
                body = readFileSync(sw, 'utf8');
                writeFileSync(sww, body);
            }
            catch {
                continue;
            }
            // `read -r hm he _a wm we`: four words, and the rest of the line in the last.
            const words = (body.split('\n')[0] ?? '').replace(/^[ \t]+|[ \t]+$/g, '').split(/[ \t]+/);
            const [hm = '', he = '', , wm = ''] = words;
            const we = noCr(words.slice(4).join(' '));
            const calls = [];
            if (hm.split('[')[0] !== wm.split('[')[0])
                calls.push(`set_session_model ${wm}`);
            if (we !== 'any' && he !== we)
                calls.push(`set_session_effort ${we}`);
            out(`WORKER MODEL ${chip}: runs ${hm} at ${he}, wants ${wm} at ${we}, and waits for you. On the session titled 'fleet ${runid} ${chip}': ${calls.join(', ')}, then send_message it: "switched: run fleet.sh whoami again with switched as its last argument" (docs/MODELS.md, Switching a worker).\n`);
        }
        const sf = `${run}/chips/${chip}.switch-failed`;
        if (existsSync(sf) && !existsSync(`${sf}-warned`)) {
            writeFileSync(`${sf}-warned`, '');
            out(`WORKER MODEL ${chip} DID NOT TAKE: ${noCr(read(sf)).replace(/\n+$/, '')}. It works on what it has. Switch it again and message it, or accept it: rm ${absrun}/want/${chip}.\n`);
        }
        if (!started(c, chip))
            continue;
        // A brief worker never runs whoami: no record says its version.
        if (noCr(firstLine(`${run}/offered/${chip}`)) === 'brief')
            continue;
        let wv = recordedVersion(c, chip);
        if (!wv)
            wv = existsSync(`${run}/chips/${chip}.model`) ? '1.5.8-or-1.5.9' : 'older-than-1.5.8';
        const old = wv === '1.5.8-or-1.5.9' || wv === 'older-than-1.5.8' ||
            (versionReadable(wv) && versionReadable(iv) && versionOlder(wv, iv));
        if (!old)
            continue;
        const pw = `${run}/chips/${chip}.plugin-warned`, msg = `${run}/chips/${chip}.plugin-messaged`, esc = `${run}/chips/${chip}.plugin-escalated`;
        if (cat(pw) === `${wv} ${iv}`) {
            // Told once already: a claim made after the coordinator messaged it, with the record still old, means
            // the worker kept its old fleet.sh, and only a relaunch moves it.
            if (existsSync(esc) || !existsSync(msg))
                continue;
            for (const d of names(`${run}/tasks/claimed`, '/')) {
                const ow = `${run}/tasks/claimed/${d}/owner`;
                if (existsSync(ow) && newer(ow, msg) && lf(read(ow)).split('\n').includes(`chip ${chip}`)) {
                    writeFileSync(esc, '');
                    out(`WORKER PLUGIN ${chip} STILL ON ${wv} after a claim made since the last line: it keeps its old fleet.sh. Put it in the ONE relaunch ask (option 'Replace workers ${chip} only': fleet.sh relaunch ${absrun} --keep-coordinator ${chip}).\n`);
                    break;
                }
            }
            continue;
        }
        writeFileSync(pw, `${wv} ${iv}\n`);
        rmSync(msg, { force: true });
        rmSync(esc, { force: true });
        out(`WORKER PLUGIN ${chip} runs makarasty ${wv}, ${iv} is installed. A worker keeps the fleet.sh path it resolved at its start, so a restart alone does not move it: after the operator restarts Claude Code, message the session titled 'fleet ${runid} ${chip}' to invoke /makarasty:fleet-run ${absrun}/ again, which resolves the installed plugin, and then run: touch ${absrun}/chips/${chip}.plugin-messaged. Its next claim records ${iv}; a claim after that mark that still records ${wv} brings a STILL ON line for the relaunch ask.\n`);
    }
    return 0;
}
// A background command's output that has grown past runaway_log_gb, named once per file. 2026-10-08:
// interactive python loops in closed chats had written 5 GB of tasks/*.output, which nothing reported.
// Claude Code keeps a session's background output under <tmp>/claude/<project>/<session>/tasks/.
// ponytail: that layout is the Windows host's as observed; elsewhere the folder is not found and nothing prints.
function runawayLogs(c) {
    const gb = Number(cal(c, 'runaway_log_gb', '1')) || 1;
    const root = `${slashes(tmpdir())}/claude`;
    const sids = new Set([coordinatorSid(c), ...names(`${c.run}/chips`).filter((n) => !n.includes('.'))]);
    sids.delete('');
    const marks = `${c.run}/.log-warned`;
    const warned = new Set(read(marks).split('\n'));
    for (const p of names(root)) {
        for (const sid of sids) {
            const dir = `${root}/${p}/${sid}/tasks`;
            for (const f of isDir(dir) ? names(dir) : []) {
                if (!f.endsWith('.output'))
                    continue;
                const path = `${dir}/${f}`;
                let size = 0;
                try {
                    size = statSync(path).size;
                }
                catch {
                    continue;
                }
                if (size < gb * 1024 ** 3 || warned.has(path))
                    continue;
                appendFileSync(marks, `${path}\n`);
                const who = sid === coordinatorSid(c) ? 'your own session' : `the session registered as worker ${noCr(firstLine(`${c.run}/chips/${sid}`))} (${sid.slice(0, 8)})`;
                out(`RUNAWAY LOG: ${path} is ${(size / 1024 ** 3).toFixed(1)} GB, a background command of ${who} that keeps writing. TaskStop it in that session (send_message the worker if it is not you); deleting the file is the operator's call.\n`);
            }
        }
    }
}
// Every session the run knows and how full each one is: one line each, OVER past its mark.
export function contexts(c) {
    const at = calint(c, 'coordinator_handoff_k', 700), wat = calint(c, 'worker_relaunch_k', 700);
    if (existsSync(`${c.run}/coordinator`)) {
        const sid = coordinatorSid(c);
        const k = sessionCtx(sid);
        out(`coordinator  ${sid.slice(0, 8)}  ${k || '?'}K${k && Number(k) >= at ? `  OVER (mark ${at}K)` : ''}\n`);
    }
    else {
        out('coordinator  not recorded yet (the session that offers chips or arms the watch is it)\n');
    }
    for (const [chip, sid] of workerSessions(c).sort((a, b) => { const x = `${a[0]} ${a[1]}`, y = `${b[0]} ${b[1]}`; return x < y ? -1 : x > y ? 1 : 0; })) {
        const k = sessionCtx(sid);
        const h = claimsOf(c, chip).join(' ');
        let state = '';
        if (existsSync(`${c.run}/${chip}.retired`))
            state = '  retired';
        else if (chipFinished(c, chip))
            state = '  finished';
        else if (k && Number(k) >= wat)
            state = `  OVER (mark ${wat}K)`;
        out(`worker ${chip}  ${sid.slice(0, 8)}  ${k || '?'}K  ${h ? `holds ${h}` : 'no claim'}${state}\n`);
    }
    return 0;
}
// ---- status ----------------------------------------------------------------------------------------------
// `date '+%Y-%m-%d %H:%M %z'`
function clock() {
    const t = now();
    return `${t.slice(0, 10)} ${t.slice(11, 16)} ${t.slice(19).replace(':', '')}`;
}
// The planner's view: claims, ages, markers, questions, lane gaps, workers, budgets, coordinator context.
export function status(c) {
    const run = c.run;
    out(`== now ${clock()}\n`);
    // How long this run has been going, against the ceiling: a fleet cannot stop itself.
    const maxmin = calint(c, 'max_run_minutes', 480);
    const firsts = [`${run}/RUN_FORMAT`, ...names(`${run}/tasks/ready`).filter((n) => n.endsWith('.md')).map((n) => `${run}/tasks/ready/${n}`)];
    const first = firsts.map(mtimeMs).find((m) => !Number.isNaN(m));
    if (first !== undefined) {
        const runmin = Math.trunc((Math.floor(Date.now() / 1000) - Math.floor(first / 1000)) / 60);
        out(`== run age ${runmin}m of a ${maxmin}m ceiling\n`);
        if (runmin > maxmin)
            out('  PAST THE CEILING: continuing is a decision now. Land what exists or raise it in calibration.json.\n');
    }
    // A pause first: nothing below moves while it stands.
    if (existsSync(`${run}/PAUSED`)) {
        const hold = claimHolders(c);
        const slow = hold.filter((h) => !existsSync(`${run}/stopped/${h}`));
        out(`== PAUSED since ${firstLine(`${run}/PAUSED`).split(' ')[0]}: ${hold.length - slow.length} of ${hold.length} workers holding claims have stopped\n`);
        const pm = mtimeMs(`${run}/PAUSED`);
        const age = Number.isNaN(pm) ? 0 : Math.floor(Date.now() / 1000) - Math.floor(pm / 1000);
        const still = calint(c, 'pause_still_working_seconds', 150);
        for (const s of slow) {
            out(age >= still
                ? `  worker ${s}: still working ${age}s after the pause (message it by its title: fleet ${basename(c.absrun)} ${s})\n`
                : `  worker ${s}: no ack yet (${age}s after the pause; named still working past ${still}s)\n`);
        }
    }
    out('== claims\n');
    for (const id of names(`${run}/tasks/claimed`, '/')) {
        const d = `${run}/tasks/claimed/${id}`;
        if (!isDir(d) || !live(id) || existsSync(`${run}/tasks/done/${id}`))
            continue;
        const owner = existsSync(`${d}/owner`) ? read(`${d}/owner`) : undefined;
        const o = owner === undefined ? 'NO OWNER' : firstLine(`${d}/owner`);
        const hb = cat(`${d}/heartbeat`, 'none');
        const cl = owner === undefined ? '?' : sub(lf(owner).split('\n').filter((l) => l.startsWith('claimed ')).map((l) => `${l.slice(8)}\n`).join(''));
        out(`  ${id}  ${o}  claimed ${cl}  beat ${hb}${hb === cl ? ' NEVER-BEAT' : ''}\n`);
    }
    // Workers held on memory hold no claim, so nothing else here would show them.
    const tight = isDir(`${run}/tight`) ? names(`${run}/tight`) : [];
    if (tight.length)
        out(`== held on memory: ${tight.map((t) => `${t} `).join('')}\n`);
    out('== markers\n');
    const mk = names(run).filter((n) => /\.(done|blocked|retired|waiting)$/.test(n));
    out(mk.length ? mk.map((m) => `  ${m}\n`).join('') : '  none\n');
    out('== questions without answers\n');
    const bc = `${run}/answers/00-broadcast.md`;
    for (const b of names(`${run}/ask`)) {
        if (!b.endsWith('.md') || existsSync(`${run}/answers/${b}`))
            continue;
        // A broadcast written after the question may already have settled it.
        out(existsSync(bc) && newer(bc, `${run}/ask/${b}`)
            ? `  ${b}  (a broadcast landed after it - answer it by name with 'fleet.sh answer' if it is settled)\n`
            : `  ${b}\n`);
    }
    const gap = laneGaps(c);
    if (gap.length)
        out(`== lanes with work and no worker\n${gap.join('\n')}\n`);
    try {
        queueShape(run);
    }
    catch { /* the shape is advice; an unreadable file ends it, as before */ }
    out('== workers\n');
    const pv = pluginVersion();
    for (const nn of names(`${run}/offered`)) {
        const o = `${run}/offered/${nn}`;
        const model = `${run}/chips/${nn}.model`;
        const m = cat(model, 'model not recorded yet');
        let st = started(c, nn) ? 'yes' : 'no';
        if (existsSync(`${run}/${nn}.retired`))
            st += ', RETIRED';
        out(`  ${nn}  lane ${cat(o)}  started ${st}  ${m}\n`);
        if (existsSync(`${run}/want/${nn}`) && !chipFinished(c, nn)) {
            const w = noCr(read(`${run}/want/${nn}`)).split('\n')[0] ?? '';
            out(`    wants ${w}\n`);
            const rm = existsSync(model) ? read(model).split('\n').map((l) => l.split(' ')[0]).join('\n').replace(/\n+$/, '') : '';
            if (existsSync(`${run}/chips/${nn}.switch`))
                out(`    WAITS FOR A MODEL SWITCH: ${noCr(read(`${run}/chips/${nn}.switch`)).replace(/\n+$/, '')}\n`);
            else if (existsSync(`${run}/chips/${nn}.switch-failed`))
                out(`    SWITCH DID NOT TAKE: ${noCr(read(`${run}/chips/${nn}.switch-failed`)).replace(/\n+$/, '')}\n`);
            // A worker on 1.5.12 or older never compares; neither does one that skipped whoami.
            else if (rm && rm.split('[')[0] !== (w.split(' ')[0] ?? '').split('\n').map((l) => l.replace(/\[.*/, '')).join('\n'))
                out(`    RUNS OFF ITS WISH: records ${rm}\n`);
        }
        // A worker on another plugin version follows another protocol: say so while it still runs.
        const wv = recordedVersion(c, nn);
        if (existsSync(`${run}/${nn}.retired`) || existsSync(`${run}/${nn}.done`)) { /* finished */ }
        else if (wv && wv !== pv && !(versionReadable(wv) && versionReadable(pv))) {
            out(`    OTHER PLUGIN: worker ${nn} recorded makarasty '${wv}', which cannot be compared with this fleet.sh (${pv})\n`);
        }
        else if (wv && wv !== pv) {
            out(`    OTHER PLUGIN: worker ${nn} runs makarasty ${wv}, ${versionOlder(wv, pv) ? 'older' : 'newer'} than this fleet.sh (${pv}); its markers and acks follow that version's protocol\n`);
        }
        else if (!wv && existsSync(model)) {
            out(`    OTHER PLUGIN: worker ${nn} runs makarasty 1.5.8 or 1.5.9 (whoami recorded no version), older than this fleet.sh (${pv})\n`);
        }
        else if (st === 'yes' && !existsSync(model) && noCr(firstLine(o)) === 'brief') {
            out('    a brief worker: it runs no whoami, so its version is not recorded\n');
        }
        else if (st === 'yes' && !existsSync(model)) {
            out('    never ran whoami: a plugin older than 1.5.8, or it skipped the step; check its markers carry a branch line\n');
        }
    }
    try {
        budgets(run);
    }
    catch { /* fewer than three readable tasks say nothing */ }
    const k = coordCtx(c);
    if (k) {
        out(`== coordinator context: ${k}K\n`);
        if (Number(k) >= calint(c, 'coordinator_handoff_k', 700)) {
            out('  past the mark: update STATE.md and ask the operator once about a relaunch (fleet-plan, 8b); fleet.sh contexts lists every session\n');
        }
    }
    return 0;
}
// What the queue is waiting on: a task holding three or more open tasks behind it decides the run's
// speed, and a task carrying `operator: <what>` waits on a person. Measured 2026-10-06: every remaining
// task sat behind one permissions task for two hours and nothing printed that chain.
// Directory order as readdir gives it, as the inline node this replaces read it.
function queueShape(run) {
    const T = `${run}/tasks`;
    const ls = (d) => { try {
        return readdirSync(d);
    }
    catch {
        return [];
    } };
    const done = new Set(ls(`${T}/done`)), filed = new Set(), bad = [];
    const t = {};
    for (const f of ls(`${T}/ready`))
        if (f.endsWith('.md') && isFile(`${T}/ready/${f}`))
            filed.add(f.slice(0, -3));
    for (const id of filed) {
        const b = readFileSync(`${T}/ready/${id}.md`);
        // A file that went in by hand rather than through `fleet.sh file` is checked the same way here.
        let s;
        try {
            s = new TextDecoder('utf-8', { fatal: true }).decode(b);
        }
        catch {
            bad.push(`${id}: not valid UTF-8`);
            continue;
        }
        const fm = (s.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1];
        if (fm === undefined) {
            bad.push(`${id}: no --- frontmatter`);
            continue;
        }
        const g = (k) => ((fm.match(new RegExp(`^${k}:[ \t]*(.*)$`, 'm')) || [])[1] || '').trim();
        if (!/^(pane|repo|verify)\b/.test(g('needs')))
            bad.push(`${id}: needs: "${g('needs')}" is not pane, repo or verify, so no worker claims it`);
        if (done.has(id))
            continue;
        let who = '';
        try {
            who = (readFileSync(`${T}/claimed/${id}/owner`, 'utf8').match(/^chip (\S+)/m) || [])[1] || '';
        }
        catch { /* unclaimed */ }
        // What `next` holds the task on, read the way `next` reads it.
        t[id] = { after: afterIds(s), op: operatorOwed(s), who };
    }
    const behind = (id) => {
        const seen = new Set(), q = [id];
        while (q.length) {
            const x = q.pop() ?? '';
            for (const [k, v] of Object.entries(t))
                if (!seen.has(k) && v.after.includes(x)) {
                    seen.add(k);
                    q.push(k);
                }
        }
        return seen.size;
    };
    const st = (id) => t[id]?.who ? `claimed by ${t[id]?.who}` : 'ready, unclaimed';
    // `next` releases a task only on a done marker for every after: id, so one naming an id nothing filed
    // and nothing finished waits for ever.
    const dangling = Object.keys(t).flatMap((id) => (t[id]?.after ?? []).filter((a) => !done.has(a) && !filed.has(a)).map((a) => [id, a]));
    // So does one whose after: chain through open tasks comes back to it.
    const cyclic = Object.keys(t).filter((id) => {
        const seen = new Set(), q = [...(t[id]?.after ?? [])];
        while (q.length) {
            const x = q.pop() ?? '';
            if (x === id)
                return true;
            if (!seen.has(x) && t[x]) {
                seen.add(x);
                q.push(...(t[x]?.after ?? []));
            }
        }
        return false;
    });
    if (dangling.length || cyclic.length)
        out('== waits for ever\n');
    for (const [id, a] of dangling)
        out(`  ${id}: after: ${a}, which is neither filed nor done (${behind(id)} behind it)\n`);
    for (const id of cyclic)
        out(`  ${id}: its after: chain comes back to it, a cycle (${behind(id)} behind it)\n`);
    const roots = Object.keys(t).filter((id) => (t[id]?.after ?? []).every((a) => done.has(a))).map((id) => [id, behind(id)])
        .filter((x) => x[1] >= 3).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (roots.length) {
        out('== bottlenecks\n');
        for (const [id, n] of roots)
            out(`  ${id}: ${n} open task(s) wait behind it, ${st(id)}${t[id]?.op ? ', WAITS ON THE OPERATOR' : ''}\n`);
    }
    const ops = Object.keys(t).filter((id) => t[id]?.op);
    if (ops.length) {
        out('== waiting on the operator (next holds these until fleet.sh cleared <run> <id>)\n');
        for (const id of ops)
            out(`  ${id}: ${t[id]?.op} (${behind(id)} behind it, ${st(id)})\n`);
    }
    if (bad.length) {
        out('== task files fleet.sh file would refuse\n');
        for (const x of bad)
            out(`  ${x}\n`);
    }
}
// Budgets against what tasks actually took: the 2026-10-05 build ran a median of four minutes against
// budgets of 45 to 150, so no abort clock could ever fire.
function budgets(run) {
    const work = [], bud = [];
    for (const id of readdirSync(`${run}/tasks/done`)) {
        try {
            const o = readFileSync(`${run}/tasks/claimed/${id}/owner`, 'utf8').match(/claimed (\S+)/);
            const t = readFileSync(`${run}/tasks/ready/${id}.md`, 'utf8').match(/^budget:\s*(\d+)/m);
            if (!o)
                continue;
            work.push((statSync(`${run}/tasks/done/${id}`).mtimeMs - Date.parse(o[1] ?? '')) / 60000);
            bud.push(t ? Number(t[1]) : 25);
        }
        catch { /* a task without its files is not measured */ }
    }
    if (work.length < 3)
        return;
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
    const w = med(work), b = med(bud);
    out('== budgets\n');
    out(`  ${work.length} tasks done: median ${Math.round(w)} min of work against a median budget of ${b} min\n`);
    if (w * 4 < b)
        out('  BUDGETS TOO LOOSE: no abort clock can fire. Budget the next tasks at about three times the measured median.\n');
}
export const commands = {
    status: (c) => status(c),
    ctx: (c) => ctx(c),
    contexts: (c) => contexts(c),
};
