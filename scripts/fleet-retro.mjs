#!/usr/bin/env node
// fleet-retro.mjs - where a finished run's wall clock actually went, read from the workers' own transcripts.
//
// A run reports what it found. It does not report what it cost, and the questions that improve the next
// run are all about cost: how long a session stayed alive after its work was done, how many clocks nobody
// stopped, how much of a browser pane's life was spent driving a browser, how much of each worker's time
// was a gap where nothing happened. This reads those out of the host's session transcripts, so the answer
// is a measurement rather than fourteen chats' recollections.
//
//   node fleet-retro.mjs <run-id>                     the table, for a run in the current project
//   node fleet-retro.mjs <run-id> --dir <path>        transcripts elsewhere
//   node fleet-retro.mjs <run-id> --json              machine readable
//
// HOST SPECIFIC. It assumes Claude Code's transcript layout: one JSONL per session under
// ~/.claude/projects/<slug>/, each line an object with a `timestamp`, assistant lines carrying
// `message.usage` and `message.content[].tool_use`. Every other script in this plugin is portable; this one
// is a forensics tool for this host, and `PORTING.md` names what a substitute would have to provide.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const args = process.argv.slice(2);
const run = args.find((a) => !a.startsWith('--'));
const flag = (n, d = null) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
if (!run) {
    console.error('usage: node fleet-retro.mjs <run-id> [--dir <transcripts>] [--json] [--run-dir <.fleet/run>]');
    process.exit(2);
}
// The host names a project's transcript directory after its path, with every separator and underscore
// flattened to a dash. Fall back to a search when that rule changes rather than telling the operator the
// directory does not exist.
const projects = path.join(os.homedir(), '.claude', 'projects');
const slug = process.cwd().replace(/[\\/:_]/g, '-');
let guess = path.join(projects, slug);
if (!fs.existsSync(guess) && fs.existsSync(projects)) {
    const want = path.basename(process.cwd()).replace(/[_\-]/g, '').toLowerCase();
    const hit = fs.readdirSync(projects).find((d) => d.replace(/[_\-]/g, '').toLowerCase().endsWith(want));
    if (hit)
        guess = path.join(projects, hit);
}
const dir = flag('--dir') || guess;
const runDir = flag('--run-dir') || path.join('.fleet', run);
if (!fs.existsSync(dir)) {
    console.error(`no transcript directory at ${dir} - pass --dir`);
    process.exit(2);
}
// When a worker wrote its completion marker. Everything after that timestamp is a session that had nothing
// left to do, which is the single most expensive thing this tool measures. Beside it, the run's own chip
// register: `chips/<session-id>` is written at a worker's first claim, so it says which sessions belong to
// this run without reading a word of any prompt.
const doneAt = {};
const registered = new Map();
const runDirHere = fs.existsSync(runDir);
if (runDirHere) {
    for (const f of fs.readdirSync(runDir)) {
        const m = f.match(/^([\w-]+)\.(done|blocked)$/);
        if (m)
            doneAt[m[1]] = fs.statSync(path.join(runDir, f)).mtimeMs;
    }
    try {
        const c = path.join(runDir, 'chips');
        for (const f of fs.readdirSync(c))
            registered.set(f, fs.readFileSync(path.join(c, f), 'utf8').trim());
    }
    catch { /* nothing claimed yet */ }
}
// A run directory that is not there is not a run that wasted nothing. `--run-dir` defaults to a path under
// the cwd, so running this from anywhere but the project silently leaves every marker unread and every
// afterDone column measured against nothing, which prints as a clean run.
if (!runDirHere)
    console.error(`no run directory at ${path.resolve(runDir)}: pass --run-dir <path>. Without it there are no completion markers, and every afterDone number below is measured against nothing.`);
else if (!Object.keys(doneAt).length)
    console.error(`no .done or .blocked markers under ${path.resolve(runDir)}: every afterDone number below is measured against nothing.`);
// The run id has to match whole. As a substring, `2026-09-08-full-audit` also collects every session of
// `fix-2026-09-08-full-audit` and charges them against the parent run's completion markers, which is where
// this project's telemetry got its 1935 minutes of life after done.
const WHOLE_RUN = new RegExp(`(^|[^\\w-])${run.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`);
const BROWSER = /^mcp__(.*[Bb]rowser|claude-in-chrome)__/;
const rows = [];
let unattributed = 0;
for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    const p = path.join(dir, name);
    const objs = [];
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        if (line)
            try {
                objs.push(JSON.parse(line));
            }
            catch { /* torn line */ }
    }
    const first = objs.find((o) => o.type === 'queue-operation' || o.type === 'user');
    const seed = (first && (first.content || JSON.stringify(first.message || ''))) || '';
    const enrolled = registered.get(name.replace(/\.jsonl$/, ''));
    if (!enrolled && !WHOLE_RUN.test(seed))
        continue;
    const planner = /fleet-plan|Interview the operator/.test(seed);
    // A chip id is whatever the prompt said it was, and since 2026-09-03 that includes `cid-03`. The
    // register is the authority where it has an entry; the prompt is the fallback, and a session this run
    // claims whose chip neither can name is left out rather than filed under a number that collides.
    const m = seed.match(/chip id is `([\w-]+)`/) || seed.match(/worker ([\w-]+)/) || seed.match(/brief-([\w-]+)\.md/);
    const chip = enrolled || (m && m[1]) || (planner ? 'plan' : '');
    if (!chip) {
        unattributed++;
        continue;
    }
    // The lane is read from what the session did, not from what its prompt said: a paneless fix run's
    // prompt matched neither phrase the old heuristic looked for, and four repo workers printed as pane.
    let sawBrowser = false;
    const stamps = objs.filter((o) => o.timestamp).map((o) => Date.parse(o.timestamp));
    const t0 = Math.min(...stamps), t1 = Math.max(...stamps);
    let turns = 0, out = 0, cacheRead = 0, clocks = 0, helper = 0, handClaims = 0, asks = 0;
    let firstGate = null, firstAsk = null;
    // The three costs M24-M26 named, which this tool could see all along and was not reading: the context
    // each turn carries, whether file work went through the shell or the file tools, and the calls that
    // failed for a reason that was not the command's fault.
    let ctxTotal = 0, shellCalls = 0, fileCalls = 0, shellReads = 0, editRefusals = 0, limitFails = 0;
    // Peak context and compactions: a worker whose context reached the ceiling was summarised and restarted
    // by the harness, and the two hundred turns before that were the most expensive in the run [M30].
    let ctxMax = 0, compactions = 0;
    const use = new Map();
    const spans = [];
    const turnTimes = [];
    const seen = new Set();
    for (const o of objs) {
        if (o.type === 'user') {
            // An async agent returns immediately and reports its real completion as a notification, so the span
            // that matters is tool_use to notification, not tool_use to tool_result.
            const txt = JSON.stringify(o.message || o);
            if (/being continued from a previous conversation/.test(txt))
                compactions++;
            const n = txt.match(/<tool-use-id>(toolu_[A-Za-z0-9]+)<\/tool-use-id>/);
            if (n && use.has(n[1]) && use.get(n[1]).name === 'Agent')
                spans.push([use.get(n[1]).t, Date.parse(o.timestamp)]);
            if (o.message && Array.isArray(o.message.content)) {
                for (const c of o.message.content) {
                    if (c.type === 'tool_result' && use.has(c.tool_use_id)) {
                        const u = use.get(c.tool_use_id);
                        if (BROWSER.test(u.name))
                            spans.push([u.t, Date.parse(o.timestamp)]);
                        if (c.is_error) {
                            const body = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
                            // Three round trips instead of one: the harness requires a `Read` before an `Edit`, and a
                            // file read through the shell can never satisfy it [M25].
                            if (/File has not been read yet/.test(body))
                                editRefusals++;
                            // Not the command's fault, and it lands on shell calls because those are what the
                            // permission classifier judges [M26].
                            if (/rate-limited|temporarily unavailable|usage limit|overloaded/i.test(body))
                                limitFails++;
                        }
                    }
                }
            }
            continue;
        }
        if (o.type !== 'assistant' || !o.message)
            continue;
        // The host writes one line per content block and repeats the message's usage on each, so a turn is a
        // message id, not a line. Counting lines read every turn and token total 1.5 to 1.9x high.
        const t = Date.parse(o.timestamp);
        if (!o.message.id || !seen.has(o.message.id)) {
            if (o.message.id)
                seen.add(o.message.id);
            turns++;
            const u = o.message.usage || {};
            out += u.output_tokens || 0;
            cacheRead += u.cache_read_input_tokens || 0;
            const ctxNow = (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0);
            ctxTotal += ctxNow;
            if (ctxNow > ctxMax)
                ctxMax = ctxNow;
            turnTimes.push(t);
        }
        for (const c of o.message.content || []) {
            if (c.type !== 'tool_use')
                continue;
            use.set(c.id, { name: c.name, t });
            if (BROWSER.test(c.name))
                sawBrowser = true;
            if (c.name === 'Bash' || c.name === 'PowerShell')
                shellCalls++;
            if (['Read', 'Grep', 'Glob', 'Edit', 'Write'].includes(c.name))
                fileCalls++;
            const input = JSON.stringify(c.input || {});
            if (/requestAnimationFrame/.test(input) && firstGate === null)
                firstGate = t;
            if (c.name === 'AskUserQuestion') {
                asks++;
                if (firstAsk === null)
                    firstAsk = t;
            }
            const cmd = String(c.input?.command || '');
            if (/budget-elapsed/.test(cmd))
                clocks++;
            if (/(fleet\.sh|"\$f"|\$f)\s+(next|find|finish|drained|beat|clock|summary)/.test(cmd))
                helper++;
            if (/mkdir\s+[^|;]*tasks\/claimed/.test(cmd))
                handClaims++;
            // Reading a file through the shell. The cost is not the milliseconds - across a whole corpus the
            // shell is 13x slower for a plain read and FASTER for a `find` [M25] - it is that `cat` cannot
            // satisfy `Edit`'s precondition, so an edit that follows one pays three round trips. `grep`/`sed -n`
            // count too; `cat file | something` is a pipeline, not a read, so the pattern stops at the pipe.
            if (/(^|[;&]\s*)(cat|head|tail|sed -n|grep)\s+[^|]*$/.test(cmd.replace(/^cd [^&]*&&\s*/, '')))
                shellReads++;
        }
    }
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const s of spans) {
        if (merged.length && s[0] <= merged[merged.length - 1][1])
            merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], s[1]);
        else
            merged.push([...s]);
    }
    const driven = merged.reduce((a, [x, y]) => a + (y - x), 0) / 60000;
    let idle = 0;
    for (let i = 1; i < turnTimes.length; i++) {
        const g = (turnTimes[i] - turnTimes[i - 1]) / 60000;
        if (g >= 3)
            idle += g;
    }
    const d = doneAt[chip];
    rows.push({
        chip, planner, lane: sawBrowser ? 'pane' : 'repo',
        lifeMin: Math.round((t1 - t0) / 60000),
        turns, outK: Math.round(out / 1000), cacheM: Math.round(cacheRead / 1e6),
        paneDrivenMin: Math.round(driven),
        idleMin: Math.round(idle),
        afterDoneMin: d ? Math.round(Math.max(0, (t1 - d) / 60000)) : null,
        afterDoneTurns: d ? turnTimes.filter((t) => t > d + 60000).length : null,
        clocks, helperCalls: helper, handClaims,
        ctxK: turns ? Math.round(ctxTotal / turns / 1000) : 0,
        ctxMaxK: Math.round(ctxMax / 1000), compactions,
        shellCalls, fileCalls, shellReads, editRefusals, limitFails,
        gateAfterMin: firstGate === null ? null : Math.round((firstGate - t0) / 60000),
        askAfterMin: firstAsk === null ? null : Math.round((firstAsk - t0) / 60000),
        spans: merged,
    });
}
if (unattributed)
    console.error(`${unattributed} session(s) name this run but no chip id: left out rather than guessed at.`);
if (!rows.length) {
    console.error(`no session transcripts for run ${run} under ${dir}`);
    process.exit(1);
}
rows.sort((a, b) => (a.chip < b.chip ? -1 : 1));
if (args.includes('--json')) {
    console.log(JSON.stringify(rows.map(({ spans, ...r }) => r), null, 1));
    process.exit(0);
}
const col = (s, w) => String(s ?? '-').padStart(w);
console.log('chip lane  life  turns  outK cacheM  pane  idle  afterDone(min/turns) clocks helper hand gate ask  ctxK ctxMax cmp');
for (const r of rows) {
    console.log(`${col(r.chip, 4)} ${r.lane.padEnd(5)}${col(r.lifeMin, 5)}${col(r.turns, 7)}${col(r.outK, 6)}${col(r.cacheM, 7)}` +
        `${col(r.paneDrivenMin, 6)}${col(r.idleMin, 6)}${col(r.afterDoneMin, 12)}${col(r.afterDoneTurns, 7)}` +
        `${col(r.clocks, 7)}${col(r.helperCalls, 7)}${col(r.handClaims, 5)}${col(r.gateAfterMin, 5)}${col(r.askAfterMin, 4)}` +
        `${col(r.ctxK, 6)}${col(r.ctxMaxK, 7)}${col(r.compactions, 4)}`);
}
const sum = (k) => rows.reduce((a, b) => a + (b[k] || 0), 0);
console.log('');
console.log(`${rows.length} sessions, ${sum('turns')} turns, ${sum('outK')} K output tokens, ${sum('cacheM')} M cached reads`);
// A zero here reads as a run that wasted nothing, and it is the same zero a run whose markers were never
// found prints. Name the denominator so the two can be told apart.
const marked = rows.filter((r) => r.afterDoneMin !== null).length;
console.log(marked
    ? `after their own completion marker: ${sum('afterDoneMin')} minutes and ${sum('afterDoneTurns')} turns of session life, over the ${marked} of ${rows.length} sessions that have one`
    : `after their own completion marker: NOT MEASURED - no marker under ${path.resolve(runDir)} matches any of these ${rows.length} sessions`);
console.log(`clocks armed ${sum('clocks')}; helper calls ${sum('helperCalls')} against ${sum('handClaims')} hand rolled claims`);
// The bill is turns multiplied by context [M24], and the two habits that move it are visible from here.
const avgCtx = Math.round(rows.reduce((a, r) => a + r.ctxK * r.turns, 0) / Math.max(1, sum('turns')));
console.log(`context ${avgCtx} K per turn on average; ${sum('turns')} turns x that is what the run reads back`);
// A worker that compacted crossed the ceiling, and each task before that added 20-30 k it never gave
// back. The cure is delegating whole tasks once the worker holds a few, which `fleet.sh next` now asks for.
if (sum('compactions'))
    console.log(`${sum('compactions')} compaction(s): those workers reached the context ceiling working tasks inline; past the first few, each task belongs in its own subagent [M30]`);
console.log(`shell calls ${sum('shellCalls')} against ${sum('fileCalls')} file-tool calls, of which ${sum('shellReads')} read a file through the shell`);
if (sum('editRefusals'))
    console.log(`  ${sum('editRefusals')} Edit calls refused for a file read through the shell - three round trips each, and avoidable [M25]`);
// Shell calls are the ones a permission decision is made about, and a session in the classifier's slow
// mode pays 1.5-2 s on every one of them [M28]. The count is the exposure; the latency split that proves
// the mode is on lives in the host's own transcripts, not here.
if (sum('limitFails'))
    console.log(`${sum('limitFails')} tool calls failed on a rate limit or an unavailable model rather than on the command [M26]`);
// How many panes were being driven at once, minute by minute. This is the number that decides how many
// panes the next run should open, and it cannot be guessed from the task list.
const paneRows = rows.filter((r) => r.lane === 'pane' && r.spans.length);
if (paneRows.length) {
    const lo = Math.min(...paneRows.map((r) => r.spans[0][0]));
    const hi = Math.max(...paneRows.map((r) => r.spans[r.spans.length - 1][1]));
    const hist = {};
    let n = 0;
    for (let t = lo; t <= hi; t += 60000) {
        let busy = 0;
        for (const r of paneRows)
            if (r.spans.some(([a, b]) => t >= a && t <= b))
                busy++;
        hist[busy] = (hist[busy] || 0) + 1;
        n++;
    }
    const drivenTotal = sum('paneDrivenMin');
    console.log('');
    console.log(`panes: ${rows.filter((r) => r.lane === 'pane').length} opened, ${drivenTotal} minutes driven over a ${Math.round((hi - lo) / 60000)} minute span`);
    for (const k of Object.keys(hist).sort((a, b) => a - b)) {
        console.log(`  ${k} pane(s) driven at once: ${hist[k]} min (${Math.round(100 * hist[k] / n)}%)`);
    }
    console.log(`  that is ${(drivenTotal / ((hi - lo) / 60000)).toFixed(2)} panes' worth of demand; open that many next time, plus one`);
}
