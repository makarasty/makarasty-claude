// dispatch.mts - `dispatch`, `coded` and `rearm`: the coordinator's per-task bookkeeping in one call. Part of fleet.mjs; see src/scripts/fleet.mts.
//
// Before this the one-chat coordinator ran, per task: next, a hand-typed before.diff line, `prove ... before`, a
// backgrounded clock, then hand-filled a spawn template plus RULES.md into the Agent call (measured ~695 tokens of
// prompt and 3-4 Bash calls per spawn). `dispatch` claims, saves what the paths held, records the failing run,
// writes the deadline and writes the worker's and the reviewer's prompts to files; the Agent call is one line.
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HERE, NEEDS, HANDBACK_OF, calint, claimsOf, lf, field, firstLine, fmValues, frontmatter, isDir, names, need, noCr, now, out, err, read, slashes, taskKind, budgetOf, wakeLoop, draining, STOP_WHAT_YOU_STARTED } from './lib.mjs';
import { claim } from './queue.mjs';
import { ownsOf } from './planner.mjs';
const CODE = ['fix', 'root', 'implement', 'design'];
// Single-quoted for a shell, a `'` in it written `'\''`.
const sq = (s) => `'${s.replace(/'/g, "'\\''")}'`;
const q = (p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : sq(p));
const git = (args) => spawnSync('git', args, { encoding: 'utf8', cwd: process.cwd(), maxBuffer: 256 * 1024 * 1024 }).stdout || '';
// Which Agent runs a task (docs/ONECHAT.md, the table of subagent types).
function agentOf(kind, needs) {
    if (kind === 'review')
        return 'makarasty:fleet-reviewer';
    if (kind === 'critique')
        return 'makarasty:fleet-design-eye';
    if (['perf', 'speed', 'stability'].includes(kind))
        return 'makarasty:fleet-profiler';
    if (needs === 'pane')
        return 'makarasty:fleet-scenario';
    return 'makarasty:fleet-coder';
}
export function dispatch(c, chip, lane) {
    const run = c.run, ar = c.absrun;
    const taskOf = (i) => read(`${run}/tasks/ready/${i}.md`);
    // A claim of this slot that never got its prompt, whatever its lane: the coordinator fixed the task file and runs dispatch again.
    const open = claimsOf(c, chip).find((i) => !existsSync(`${run}/tasks/claimed/${i}/prompt.md`));
    let id = open ?? '';
    if (id) {
        // `next` answers these before it hands out; a resume is no way round them.
        if (existsSync(`${run}/FINISHED`)) {
            out(`RUN FINISHED: ${basename(c.absrun)} has landed. End this turn with one line, commit nothing, start nothing. ${STOP_WHAT_YOU_STARTED}\n`);
            return 9;
        }
        if (existsSync(`${run}/PAUSED`)) {
            out(`RUN PAUSED: ${firstLine(`${run}/PAUSED`)}. Nothing is handed out while a pause stands.\n`);
            out('Background this, end your turn, and after it prints resumed carry on with the claim you hold; call next only if you hold none (a pane worker may still take its one repo task):\n');
            out(wakeLoop(c, chip));
            return 8;
        }
    }
    else {
        // The caller is the coordinator: next's worker wait loop is not for it (watch.mts, ctx).
        if (draining(c)) {
            out('DRAINING: the run is draining before a relaunch, so dispatch starts nothing. Wait for the agents in flight to report; the watch prints DRAINED once none is left (fleet-plan, 8b).\n');
            return 13;
        }
        const r = claim(c, chip, lane);
        if (r.code !== 0) {
            out(r.text.split('\n---\n')[0] ?? '');
            return r.code;
        }
        id = r.id;
    }
    const d = `${run}/tasks/claimed/${id}`;
    const tf = `${run}/tasks/ready/${id}.md`;
    const text = taskOf(id);
    if (!text) {
        err(`dispatch: ${tf} cannot be read\n`);
        return 2;
    }
    const fm = frontmatter(text) ?? [];
    const kind = taskKind(text), code = CODE.includes(kind);
    const own = ownsOf(text).map((p) => p.split('\\').join('/'));
    if (code && !own.length) {
        out(`NO OWNS: add owns: to ${ar}/tasks/ready/${id}.md, then run dispatch again\n`);
        return 12;
    }
    const budget = budgetOf(text);
    const ho = noCr(field(text, HANDBACK_OF)).trim();
    // b. what the paths held before this task
    let copied = false;
    if (ho) {
        const olds = names(`${run}/tasks/claimed`).filter((n) => n.startsWith(`${ho}.released-`) && existsSync(`${run}/tasks/claimed/${n}/before.diff`))
            .sort((x, y) => statSync(`${run}/tasks/claimed/${y}`).mtimeMs - statSync(`${run}/tasks/claimed/${x}`).mtimeMs);
        if (olds[0]) {
            copyFileSync(`${run}/tasks/claimed/${olds[0]}/before.diff`, `${d}/before.diff`);
            copied = true;
        }
    }
    // Never git with an empty pathspec: it reads the whole tree.
    if (!copied)
        writeFileSync(`${d}/before.diff`, own.length ? git(['status', '--porcelain', '-uall', '--', ...own]) + git(['diff', '--', ...own]) : '');
    // c. a fix's failing run, recorded now (a handback carries the old one across in `next`)
    // A handback skips the run only when the carried claim already holds a before record (`next` copied it); else it runs as for a fresh task.
    const hasBefore = lf(read(`${d}/proof`)).split('\n').some((l) => l.includes('"phase":"before"'));
    if ((kind === 'fix' || kind === 'root') && !(ho && hasBefore)) {
        const repro = fmValues(fm, 'repro')[0] ?? '';
        if (!repro) {
            out(`NEED REPRO: write one shell command that fails while the defect is there into repro: of ${ar}/tasks/ready/${id}.md, then run dispatch again\n`);
            return 12;
        }
        // shortcut: the timeout kills only the gate process, not a repro child it started (Windows); upgrade: kill the tree.
        const p = spawnSync(process.execPath, [`${HERE}/fleet-gate.mjs`, 'prove', ar, id, 'before', '--', repro], { cwd: process.cwd(), encoding: 'utf8', timeout: Math.min(budget * 60, 590) * 1000, maxBuffer: 64 * 1024 * 1024 });
        const last = (p.stdout || '').split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean).pop() ?? '';
        if (p.status === null) {
            out(`PROVE FAILED ${id}: the before run was killed at its limit (${Math.min(budget * 60, 590)} s); it recorded nothing\n`);
            return 1;
        }
        out(`${last}\n`);
        if (last.includes('the reproduction passes already')) {
            out(`REFUTED ${id}: ${last}\n`);
            return 11;
        }
        if (p.status !== 0) {
            const why = (p.stderr || '').split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim()).pop() ?? '';
            out(`PROVE FAILED ${id}: the gate refused the before run${why ? `: ${why}` : ', see its line above'}\n`);
            return 1;
        }
    }
    // d. deadline, epoch seconds
    writeFileSync(`${d}/deadline`, `${Math.floor(Date.now() / 1000 + budget * calint(c, 'budget_multiplier', 2) * 60)}\n`);
    writeFileSync(`${d}/heartbeat`, `${now()}\n`);
    mkdirSync(`${run}/reports`, { recursive: true });
    const g = slashes(HERE), gate = `${g}/fleet-gate.mjs`, fsh = `${g}/fleet.sh`;
    const rules = read(`${run}/RULES.md`).replace(/\s+$/, '');
    const ownsLine = `owns: ${own.join(', ')}`;
    // f. the reviewer's prompt, for a code task
    if (code) {
        const paths = own.map(q).join(' ');
        writeFileSync(`${d}/review.md`, [
            `Review this task's change only. Task ${ar}/tasks/ready/${id}.md. Run ${ar}. Chip ${chip}.`,
            ...(rules ? [`Rules (pasted once, do not read RULES.md again): ${rules}`] : []),
            `Run \`git diff -- ${paths}\` and \`git status --porcelain -uall -- ${paths}\`. Read every \`??\` file whole (a new file is in no diff); never \`git add -N\`, the index is shared.`,
            `before.diff: ${ar}/tasks/claimed/${id}/before.diff (what those paths held before this task; empty = the whole owns diff is this task's).`,
            ...(existsSync(`${run}/answers/00-broadcast.md`) ? [`Also read ${ar}/answers/00-broadcast.md.`] : []),
            `Verdict: pass, or defects each with the input that breaks it. Write the full verdict to ${ar}/reports/${id}.review.md. Reply with at most 3 lines and 400 characters; the last line is PASS or DEFECTS: <count>.`,
        ].join('\n') + '\n');
    }
    // e. the worker's prompt, written last: it is the mark that a claim is prepared
    const test = fmValues(fm, 'test')[0] ?? '';
    const ts = Number(fmValues(fm, 'test-seconds')[0] ?? '');
    const S = ts > 0 ? Math.min(590, Math.ceil(2 * ts)) : 590;
    const repro = fmValues(fm, 'repro')[0] ?? '';
    const stamped = Number(firstLine(`${run}/RUN_FORMAT`).replace(/[^0-9]/g, '')) >= 2;
    const testProof = test && (kind === 'implement' || kind === 'design') && stamped;
    writeFileSync(`${d}/prompt.md`, [
        `Task ${ar}/tasks/ready/${id}.md. Run ${ar}. Chip ${chip}.`,
        ...(rules ? [`Rules (pasted once, do not read RULES.md again): ${rules}`] : []),
        ...(own.length ? [ownsLine] : []),
        ...(test && !testProof ? [`Test: timeout ${S} ${test}   (a hit limit is reported, never retried)`] : []),
        ...(kind === 'fix' || kind === 'root' ? [`Proof, after your change: node "${gate}" prove "${ar}" ${id} after -- ${sq(repro)}`] : []),
        ...(testProof ? [`Test proof, after your change: node "${gate}" prove "${ar}" ${id} after -- ${sq(`timeout ${S} ${test}`)}   (instead of running Test bare; no before; a hit limit is reported, never retried)`] : []),
        `Findings: sh "${fsh}" find "${ar}" ${chip}, one JSON finding on stdin; it files, it is no probe. Heartbeat: sh "${fsh}" beat "${ar}" ${chip} ${id}.`,
        'Never next, finish, drained, commit, git add -A, stash, checkout --, switch.',
        `Write your full report (files changed, test result, what is left) to ${ar}/reports/${id}.md. Reply with at most 3 lines and 400 characters; the last line is DONE, DONE_WITH_CONCERNS: <one line> or BLOCKED: <one line>.`,
    ].join('\n') + '\n');
    const one = (k) => fmValues(fm, k)[0] || '-';
    out(`DISPATCHED ${id} kind ${kind || '-'} lane ${lane || 'any'}\n`);
    out(`AGENT ${agentOf(kind, field(text, NEEDS))} model ${one('model')} verdict-model ${one('verdict-model')}\n`);
    out(`PROMPT Read ${ar}/tasks/claimed/${id}/prompt.md and follow it.\n`);
    if (code)
        out(`REVIEW_PROMPT Read ${ar}/tasks/claimed/${id}/review.md and follow it.\n`);
    return 0;
}
// The coder of a task has finished: a task that `after:` it and only needs its files may start. `finish` still
// waits for the review and the proof; verify and pane tasks wait for `done` (queue.mts, nextHeld).
export function coded(c, chip, id) {
    const d = `${c.run}/tasks/claimed/${id}`;
    if (!isDir(d) || !read(`${d}/owner`).split('\n').map((l) => l.replace(/\r$/, '')).includes(`chip ${chip}`)) {
        out(`CLAIM LOST ${id}\n`);
        return 4;
    }
    writeFileSync(`${d}/coded`, `${now()}\n`);
    out(`OK ${id} coded\n`);
    return 0;
}
// A hung subagent re-spawned on the same claim gets a fresh deadline; the watch announces `<id>@<deadline>`, so it speaks again.
export function rearm(c, chip, id) {
    const d = `${c.run}/tasks/claimed/${id}`;
    if (!isDir(d) || !read(`${d}/owner`).split('\n').map((l) => l.replace(/\r$/, '')).includes(`chip ${chip}`)) {
        out(`CLAIM LOST ${id}: chip ${chip} does not hold it\n`);
        return 1;
    }
    const at = Math.floor(Date.now() / 1000 + budgetOf(read(`${c.run}/tasks/ready/${id}.md`)) * calint(c, 'budget_multiplier', 2) * 60);
    writeFileSync(`${d}/deadline`, `${at}\n`);
    out(`REARMED ${id} ${at}\n`);
    return 0;
}
const lane = (a) => {
    const l = a ?? '';
    if (l === '' || l === 'pane' || l === 'repo' || l === 'verify')
        return l;
    err(`no such lane: ${l} (pane, repo, verify, or leave it out for any)\n`);
    return null;
};
export const commands = {
    dispatch: (c, a) => { const chip = need(c, a[0], 3, 'chip id required'), l = lane(a[1]); return l === null ? 2 : dispatch(c, chip, l); },
    rearm: (c, a) => rearm(c, need(c, a[0], 3, 'chip id required'), need(c, a[1], 4, 'task id required')),
    coded: (c, a) => coded(c, need(c, a[0], 3, 'chip id required'), need(c, a[1], 4, 'task id required')),
};
