// waitwatch.mts - `fleet.sh wait-watch`: the watch loop commands/fleet-wait.md used to hold as a bash block the
// model retyped into every Monitor call. Part of fleet.mjs; see src/scripts/fleet.mts.
//
// It prints one line per event (task finished, NEEDS OPERATOR, SERVICE DOWN, STALL, run complete ...) and
// stays silent in between; the coordinator reads the lines, never the loop. Ticks are ten seconds apart.
// Test knobs: FLEET_WATCH_TICK (seconds per tick), FLEET_WATCH_EXPIRE (seconds before "watch expired"),
// FLEET_WATCH_TRACE (a `TICK <n>` line before each sleep). FLEET_WATCH_SERVICES: more URLs to probe, space-separated.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { err, out, isDir, isFile, read, names, sub, slashes, configDir, calint, context, pipeClosed } from './lib.mjs';
import { ctx } from './watch.mjs';
const secs = () => Math.floor(Date.now() / 1000);
const pause = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const say = (l) => out(`${l}\n`);
// `read -r x < file`: the first line as it stands.
const head1 = (p) => { const t = read(p), i = t.indexOf('\n'); return i < 0 ? t : t.slice(0, i); };
const mtimeSecs = (p) => Math.floor(statSync(p).mtimeMs / 1000);
const digits = (s) => /^[0-9]+$/.test(s);
const withSuffix = (dir, ...suffixes) => names(dir).filter((n) => suffixes.some((s) => n.endsWith(s)));
// Workers that landed: a .done, .blocked or .retired each, one per name.
const landed = (d) => new Set(withSuffix(d, '.done', '.blocked', '.retired').map((n) => n.slice(0, n.lastIndexOf('.')))).size;
// `sed -n '/start/,/end/p'`: both ends included, and a new range may start after one ends.
function sedRange(text, start, end) {
    const got = [];
    let inside = false;
    for (const l of text.split('\n')) {
        if (!inside) {
            if (!start.test(l))
                continue;
            inside = true;
            got.push(l);
            continue;
        }
        got.push(l);
        if (end.test(l))
            inside = false;
    }
    return got;
}
const lines = (text) => text === '' ? [] : text.replace(/\n$/, '').split('\n');
// A verb of fleet.sh, run in its own node: its output is filtered here.
function verb(c, name, stderr = 'inherit') {
    const r = spawnSync(process.execPath, [process.argv[1], c.sh, name, c.run], { encoding: 'utf8', stdio: ['ignore', 'pipe', stderr] });
    return r.stdout ?? '';
}
// Every URL on FLEET.md's one `- Services:` line that comes before an item's `(start: ...)` part.
function services(file) {
    const urls = [];
    for (const l of read(file).split('\n')) {
        const m = /^- Services: *(.*)$/.exec(l.replace(/\r$/, ''));
        if (m)
            for (const u of m[1].replace(/\(start:[^)]*\)/g, '').matchAll(/(?:^|; *)(https?:\/\/[^ ;]+)/g))
                urls.push(u[1]);
    }
    return urls;
}
function thisChatRecord() {
    const dir = `${configDir()}/sessions`, needle = `"sessionId":"${process.env.CLAUDE_CODE_SESSION_ID || 'none'}"`;
    try {
        for (const n of readdirSync(dir).sort())
            if (n.endsWith('.json') && readFileSync(`${dir}/${n}`, 'utf8').includes(needle))
                return `${dir}/${n}`;
    }
    catch { /* no record */ }
    return '';
}
// args: <run-id or run directory> <n> [quiet seconds]
export function waitWatch(sh, runArg, args) {
    const n0 = args[0] ?? '';
    if (!/^[0-9]+$/.test(n0) || (args[1] !== undefined && !digits(args[1]))) {
        err('usage: fleet.sh wait-watch <run-id> <expected worker count> [quiet seconds]\n');
        return 2;
    }
    let n = Number(n0);
    // The main checkout, from any worktree of it.
    const g = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = g.status === 0 && g.stdout.trim() ? dirname(g.stdout.trim()) : '.';
    const id = basename(runArg);
    let d = [runArg, `.fleet/${id}`].find(isDir) ?? `${m}/.fleet/${id}`;
    const fleetMd = isFile('FLEET.md') ? 'FLEET.md' : `${m}/FLEET.md`;
    const svc = services(fleetMd);
    const extra = (process.env.FLEET_WATCH_SERVICES || '').split(/\s+/).filter(Boolean); // the integration checkout's dev server
    if (!svc.length)
        say("WATCH: no '- Services:' line in FLEET.md, services are not being checked");
    if (!isDir(d)) {
        say(`NO RUN DIR ${d} from ${slashes(process.cwd())}`);
        return 1;
    }
    d = slashes(process.platform === 'win32' ? realpathSync.native(resolve(d)) : resolve(d));
    const c = context(sh, d);
    const quiet = args[1] !== undefined ? Number(args[1]) : calint(c, 'quiet_interval_seconds', 600);
    const tickMs = Number(process.env.FLEET_WATCH_TICK || 10) * 1000, expire = Number(process.env.FLEET_WATCH_EXPIRE || 1780);
    // .watch-seen holds paths relative to the run, wherever a watch was armed from; older watches wrote them
    // from the cwd (.fleet/<run>/...) or absolute, and an entry in another spelling would be announced again.
    // A .waiting is keyed by its mtime, so a worker blind a second time is announced again; an older watch's
    // bare entry gets the mtime of the file it announced.
    const seen = `${d}/.watch-seen`, prefix = new RegExp(`^.*\\.fleet/${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`);
    const old = lines(read(seen)).map((e) => e.replace(prefix, '')).map((e) => e.endsWith('.waiting') && existsSync(`${d}/${e}`) ? `${e}@${mtimeSecs(`${d}/${e}`)}` : e);
    writeFileSync(seen, old.map((e) => `${e}\n`).join(''));
    const seenNow = () => lines(read(seen));
    const add = (s) => { writeFileSync(seen, read(seen) + `${s}\n`); };
    const t0 = secs();
    let last = t0, tick = 0, ps = 0, ps0 = 0, pst = 0, stall = 0, pl = false;
    const down = new Set(), acks = new Set();
    const tok = `${process.pid}.${t0}`;
    writeFileSync(`${d}/.watch-owner`, `${tok}\n`); // one watch per run: arming a new one ends the one before
    const sf = thisChatRecord(); // this chat's record; gone when it ends
    if (process.env.CLAUDE_CODE_SESSION_ID)
        writeFileSync(`${d}/coordinator`, `${process.env.CLAUDE_CODE_SESSION_ID}\n`); // whoever watches, coordinates
    const claimed = `${d}/tasks/claimed`;
    const deadlines = () => names(claimed).map((t) => [t, `${claimed}/${t}/deadline`]).filter(([, f]) => isFile(f));
    // The 150 s `status` header of a pause, the stall report's sections: the lines of a range of `status`.
    const statusPaused = () => sedRange(verb(c, 'status'), /^== PAUSED/, /^== /).filter((l) => /^== PAUSED/.test(l) || /still working/.test(l));
    const statusStall = () => sedRange(verb(c, 'status'), /^== (markers|lanes with work|waits for ever|bottlenecks|waiting on the operator|task files)/, /^== workers/).filter((l) => !/^== workers/.test(l));
    for (;;) {
        if (pipeClosed())
            return 141;
        if (existsSync(`${d}/FINISHED`)) {
            say('run landed');
            break;
        }
        // It ends itself before the monitor's timeout: on Windows the timeout did not reach the shell version, and a
        // watch re-armed every 30 minutes left one more loop running each time (2026-10-08: one ran three hours past).
        if (secs() - t0 >= expire) {
            say('watch expired: re-arm it');
            break;
        }
        if (head1(`${d}/.watch-owner`) !== tok) {
            say('watch superseded: a newer watch runs this run');
            break;
        }
        tick++;
        const one = isDir(`${d}/slots`); // one chat: the run dir has slots/
        if (tick % 6 === 1) {
            if (sf && !existsSync(sf)) {
                say('coordinator chat gone');
                break;
            }
            for (const u of [...svc, ...extra]) {
                const rc = spawnSync('curl', ['-g', '-s', '-o', '/dev/null', '--max-time', '5', u], { stdio: 'ignore' }).status;
                const was = down.has(u);
                if (rc === 7 && !was) {
                    down.add(u);
                    say(`SERVICE DOWN: ${u} refuses connections`);
                }
                if (rc !== 7 && was) {
                    down.delete(u);
                    say(`SERVICE BACK: ${u}`);
                }
            }
            ctx(c);
        }
        if (tick % 30 === 2) { // every five minutes: what closed chats left running
            for (const l of verb(c, 'procs', 'ignore').split('\n').filter((l) => /^(CLOSED CHAT|ORPHANED RUN|CLOSED CHAT SERVING.*\))  pid /.test(l))) {
                const p = /.*  pid ([0-9]*) .*/.exec(l)?.[1] ?? '';
                if (lines(read(`${d}/.leftover-seen`)).includes(p))
                    continue;
                writeFileSync(`${d}/.leftover-seen`, read(`${d}/.leftover-seen`) + `${p}\n`);
                say(l.startsWith('CLOSED CHAT SERVING') ? `LEFTOVER, ASK THE OPERATOR: ${l}` : `LEFTOVER: ${l}`);
            }
        }
        if (existsSync(`${d}/PAUSED`)) { // a pause is announced once, each ack once, and the stall timer rests
            if (ps !== 1) {
                ps = 1;
                acks.clear();
                ps0 = pst = last = secs();
                stall = 0;
                say(`PAUSED: ${sub(head1(`${d}/PAUSED`))}`);
            }
            if (ps0 > 0 && secs() - ps0 >= 150) {
                ps0 = 0;
                for (const l of statusPaused())
                    say(l);
            } // once: who has not stopped 150 s in
            for (const w of names(`${d}/stopped`)) {
                if (acks.has(w))
                    continue;
                acks.add(w);
                last = secs();
                stall = 0;
                say(`worker ${w} stopped`);
            }
        }
        else if (ps === 1) {
            ps = 0;
            last = secs();
            stall = 0;
            say('RESUMED');
            // A pause must not eat a budget: every deadline moves out by the pause's length.
            // The length counts from this watch's first sight of PAUSED, so a pause that spans a re-arm shifts only the part after it; to fix, have the pause write its start time into PAUSED.
            for (const [, f] of deadlines()) {
                const dv = head1(f);
                if (digits(dv))
                    writeFileSync(f, `${Number(dv) + last - pst}\n`);
            }
        }
        // Budget deadlines, after the pause block so a resume has shifted them before they are read; one chat only has them.
        if (tick % 6 === 1 && ps === 0) {
            for (const [t, f] of deadlines()) {
                if (t.includes('.released-') || t.includes('.dead-'))
                    continue; // a handed-back claim
                if (existsSync(`${d}/tasks/done/${t}`))
                    continue;
                const dv = head1(f);
                if (!digits(dv))
                    continue;
                const k = `deadline:${t}@${dv}`;
                if (seenNow().includes(k))
                    continue; // a rearm writes a new value: announced again
                if (secs() >= Number(dv)) {
                    add(k);
                    say(`budget-elapsed-${t}`);
                }
            }
        }
        const sl = new Set(seenNow()); // read each tick: a watch being superseded appends here too
        const events = [
            ...names(claimed).map((t) => ['owner', `${claimed}/${t}/owner`]),
            ...names(`${d}/tasks/done`).map((t) => ['task', `${d}/tasks/done/${t}`]),
            ...withSuffix(`${d}/ask`, '.md').map((t) => ['ask', `${d}/ask/${t}`]),
            ...withSuffix(d, '.done').map((t) => ['done', `${d}/${t}`]),
            ...withSuffix(d, '.blocked').map((t) => ['blocked', `${d}/${t}`]),
            ...withSuffix(d, '.retired').map((t) => ['retired', `${d}/${t}`]),
            ...withSuffix(d, '.waiting').map((t) => ['waiting', `${d}/${t}`]),
        ];
        for (const [kind, f] of events) {
            if (!existsSync(f))
                continue;
            const r = f.slice(d.length + 1) + (kind === 'waiting' ? `@${mtimeSecs(f)}` : '');
            if (sl.has(r))
                continue;
            add(r);
            sl.add(r);
            last = secs();
            stall = 0;
            if (kind === 'waiting')
                say(`NEEDS OPERATOR: ${f} -- ${sub(read(f))}`);
            else if (kind === 'ask')
                say(`QUESTION FOR PLANNER: ${f} -- ${sub(readFileSync(f).subarray(0, 300).toString('utf8'))}`);
            else if (kind === 'task') {
                if (!one)
                    say(`task finished: ${f}`);
            }
            else if (kind === 'retired')
                say(`worker retired: ${f}`);
            else if (kind === 'done') {
                if (!one)
                    say(`worker finished queue: ${f}`);
            }
            else if (kind === 'blocked')
                say(`worker finished queue: ${f}`);
        }
        const now = secs();
        // Once per unchanged disk state: `stall` is set by the block and cleared by the next event, ack or resume,
        // so a run that waits only on the operator is not told every `quiet` seconds.
        if (ps === 0 && !one && stall === 0 && now - last >= quiet) { // not in one chat: there it is information only
            stall = 1;
            say(`STALL: nothing on disk changed for ${Math.floor((now - last) / 60)}m`);
            for (const t of names(claimed)) {
                if (!isDir(`${claimed}/${t}`) || existsSync(`${d}/tasks/done/${t}`))
                    continue;
                say(`  held: ${t} by ${isFile(`${claimed}/${t}/owner`) ? sub(head1(`${claimed}/${t}/owner`)) : 'NO OWNER'}`);
            }
            const rdy = withSuffix(`${d}/tasks/ready`, '.md').length, dne = names(`${d}/tasks/done`).length;
            say(`  progress: ${dne} of ${rdy} tasks done, ${landed(d)} of ${n} workers landed`);
            for (const l of statusStall())
                say(l);
            if (isDir(`${d}/pane/requests`))
                for (const l of lines(verb(c, 'pane-status')))
                    say(`  ${l}`);
            last = now;
        }
        // Every tick, right before the count: a retire writes the old worker's .retired and its replacement's
        // replaced/ in one command, and a count from a minute ago called the run complete in between.
        const reg = new Set();
        for (const dir of ['chips', 'replaced'])
            for (const f of names(`${d}/${dir}`))
                if (isFile(`${d}/${dir}/${f}`))
                    reg.add(head1(`${d}/${dir}/${f}`).replace(/\r$/, ''));
        const n2 = names(`${d}/offered`).filter((o) => reg.has(o)).length; // a chip that started, or a retire's replacement
        if (n2 > n)
            n = n2;
        const cnt = landed(d);
        // Never while paused: a relaunch hands its workers back (their .retired) before its replacements exist. A
        // run whose workers all landed under a pause is said once, since `landed` refuses a paused run too.
        if (existsSync(`${d}/PAUSED`)) {
            if (cnt >= n && !pl) {
                pl = true;
                say(`ALL ${cnt} OF ${n} WORKERS LANDED, BUT THE RUN IS PAUSED: resume it (fleet.sh resume) to collect`);
            }
        }
        else {
            pl = false;
            if (cnt >= n) {
                say(`run complete: ${cnt} of ${n}`);
                break;
            }
        }
        if (process.env.FLEET_WATCH_TRACE)
            say(`TICK ${tick}`);
        pause(tickMs);
    }
    return 0;
}
