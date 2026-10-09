/**
 * fleet-merge.mjs - turn a run's findings into a backlog, mechanically.
 *
 * Measured 2026-08-28: a merge written by a model rendered 68 of 254 findings while its own summary
 * claimed 255, reported one blocker where the workers had filed six, and dropped two blockers entirely,
 * including the worst finding of the run. Nothing about the output looked wrong. So the merge is a
 * script, the counts come from the files, and a mismatch is an error rather than a sentence. The
 * reconciliation matches the findings read off the chip files against the rows read back off the files it
 * wrote, by finding id: a check whose two halves cannot disagree is a sentence again.
 *
 *   node fleet-merge.mjs merge    <run-dir>   ->  backlog.jsonl, skipped.jsonl, and a reconciliation
 *   node fleet-merge.mjs render   <run-dir>   ->  backlog.md and skipped.md, rendered from the JSONL
 *   node fleet-merge.mjs fixqueue <run-dir>   ->  fix-<run-id>/tasks/ready/*.md for a second fleet
 *
 * The model's job is what a script cannot do: ranking judgement, annotation, and deciding what to fix.
 */
import fs from 'node:fs';
import path from 'node:path';
const [, , cmd, runDir] = process.argv;
if (!cmd || !runDir) {
    console.error('usage: fleet-merge.mjs merge|render|fixqueue <run-dir>');
    process.exit(2);
}
const runId = path.basename(path.resolve(runDir));
const SEV = ['blocker', 'major', 'minor', 'polish'];
// The three files this script writes into the run directory. They are output, and a second merge that read
// one back as a chip file would count its own backlog as findings.
const GENERATED = ['backlog.jsonl', 'skipped.jsonl', 'unreached.jsonl'];
// A blank or whitespace-only line (a stray `\r`, an editor's trailing newline) is no finding and no torn
// one either; counting it torn refused the whole merge over nothing.
const read = (f) => fs.readFileSync(path.join(runDir, f), 'utf8').split('\n').filter((l) => l.trim());
const rows = (f) => (fs.existsSync(path.join(runDir, f)) ? read(f).map((l) => JSON.parse(l)) : []);
const key = (o) => `${String(o.area || '').toLowerCase().trim()}|${String(o.observed || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)}`;
function load() {
    const findings = [], unreached = [], aux = [], torn = [], chips = [], ignored = [];
    // A chip id is whatever the worker was told it was: `07`, and since 2026-09-03 `cid-03` as well.
    // Matching only the bare numbers dropped every finding the other chips filed, silently, while `fleet.sh
    // find` had accepted each one and printed FILED. Read every chip file, and say which files were not one.
    for (const f of fs.readdirSync(runDir).filter((x) => x.endsWith('.jsonl')).sort()) {
        if (GENERATED.includes(f)) {
            ignored.push(`${f} (written by this merge, never read back as input)`);
            continue;
        }
        const chip = f.replace(/\.jsonl$/, '');
        chips.push(f);
        read(f).forEach((line, i) => {
            let o;
            try {
                o = JSON.parse(line);
            }
            catch {
                torn.push({ chip, line: i + 1 });
                return;
            }
            o.chip = chip;
            o.id = o.id || `${runId}-${chip}-${i + 1}`;
            if (o.severity)
                findings.push(o);
            else if (o.unreached)
                unreached.push(o);
            else
                aux.push(o);
        });
    }
    return { findings, unreached, aux, torn, chips, ignored };
}
if (cmd === 'merge') {
    const { findings, unreached, aux, torn, chips, ignored } = load();
    const windows = aux.filter((a) => a.state_changed && a.when).map((a) => ({ from: Date.parse(a.when), what: a.state_changed }))
        .filter((w) => !Number.isNaN(w.from));
    const groups = new Map();
    for (const f of findings) {
        const k = key(f);
        if (!groups.has(k))
            groups.set(k, []);
        groups.get(k).push(f);
    }
    const merged = [], skipped = [];
    for (const g of groups.values()) {
        // Which sighting the row is built from used to be whichever one `readdir` returned first, so a chip
        // that skipped its own sighting could hand the group its evidence and its fate. Within a severity the
        // sighting that saw the most goes first: one that was not skipped, then one confirmed, then the one
        // whose evidence is longest, which is a proxy for how much of it was written down.
        g.sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity) ||
            (a.skip_reason ? 1 : 0) - (b.skip_reason ? 1 : 0) ||
            (b.confirmation === 'confirmed') - (a.confirmation === 'confirmed') ||
            String(b.evidence || '').length - String(a.evidence || '').length);
        const head = g[0];
        const entry = {
            id: head.id,
            severity: head.severity,
            area: head.area,
            observed: head.observed,
            repro: head.repro || '',
            evidence: head.evidence,
            mechanism: head.mechanism || '',
            mechanism_status: head.mechanism_status || 'unknown',
            conditions: head.conditions || '',
            when: head.when || '',
            workers: [...new Set(g.map((x) => x.chip))].sort(),
            sightings: g.map((x) => x.id),
            confirmation: head.confirmation || 'unconfirmed',
        };
        // A design finding carries the geometry that proved it and the probe that found it; both decide
        // which kind of task the fix queue writes for it, so they travel.
        if (head.rects)
            entry.rects = head.rects;
        if (head.probe)
            entry.probe = head.probe;
        const w = entry.when ? Date.parse(entry.when) : NaN;
        const contaminated = windows.filter((x) => !Number.isNaN(w) && w >= x.from).map((x) => x.what);
        if (contaminated.length)
            entry.contaminated_by = contaminated;
        // A skip reason is a statement about the worker that wrote it, not about the finding: one chip's
        // misconfigured dev server took a second chip's independently reproduced blocker out of the backlog
        // with it. The group leaves the backlog only when every sighting in it was skipped; otherwise the
        // reasons travel on the row, for whoever reads it next.
        const reasons = g.filter((x) => x.skip_reason).map((x) => `${x.chip}: ${x.skip_reason}`);
        if (reasons.length)
            entry.skip_reasons = reasons;
        if (reasons.length === g.length)
            skipped.push({ ...entry, skip_reason: head.skip_reason });
        else
            merged.push(entry);
    }
    merged.sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity) ||
        b.workers.length - a.workers.length || String(a.area).localeCompare(String(b.area)));
    // A torn line is a finding this merge cannot read, so the backlog it would write is already missing one.
    // Refuse before writing rather than after: `landed` gates on backlog.jsonl existing, so a written
    // backlog beside a non-zero exit code is a run that can still land over the missing finding.
    if (torn.length) {
        console.error(`TORN LINES       ${torn.length}: ${torn.map((t) => t.chip + ':' + t.line).join(', ')}`);
        console.error('REFUSED: a torn line is a finding that would vanish from the backlog, so nothing was');
        console.error('         written. Fix the line, or delete it deliberately, and run merge again.');
        process.exit(1);
    }
    const w = (f, rows) => fs.writeFileSync(path.join(runDir, f), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    w('backlog.jsonl', merged);
    w('skipped.jsonl', skipped);
    w('unreached.jsonl', unreached);
    const count = (r) => SEV.map((s) => `${r.filter((x) => x.severity === s).length} ${s}`).join(' / ');
    console.log(`chip files read  ${chips.length}: ${chips.join(', ')}`);
    if (ignored.length)
        console.log(`files not read   ${ignored.join(', ')}`);
    console.log(`input findings   ${findings.length}  (${count(findings)})`);
    console.log(`merged entries   ${merged.length}  (${count(merged)})`);
    console.log(`skipped entries  ${skipped.length}`);
    console.log(`deduped away     ${findings.length - merged.length - skipped.length}`);
    console.log(`unreached        ${unreached.length}`);
    console.log(`auxiliary lines  ${aux.length}${windows.length ? `, ${windows.length} shared-state window(s)` : ''}`);
    // The two halves of this check have to be able to disagree, and the ones that stood here could not: both
    // were read off the arrays the grouping had just built, which agree by construction. Measured 2026-09-10
    // against a merge sabotaged to write one row fewer than it grouped, and one whose chip file was never
    // opened: both printed "every blocker survived" and exited 0. So the input is what was read off the chip
    // files and the output is what came back off backlog.jsonl and skipped.jsonl, matched by finding id.
    const carrier = new Map();
    for (const r of [...rows('backlog.jsonl'), ...rows('skipped.jsonl')])
        for (const s of r.sightings || [])
            carrier.set(s, r);
    const inIds = new Set(findings.map((f) => f.id));
    const name = (list) => list.slice(0, 8).join(', ') + (list.length > 8 ? `, and ${list.length - 8} more` : '');
    const lost = findings.filter((f) => !carrier.has(f.id)).map((f) => f.id);
    const demoted = findings.filter((f) => f.severity === 'blocker' && carrier.has(f.id) && carrier.get(f.id).severity !== 'blocker')
        .map((f) => `${f.id} -> ${carrier.get(f.id).severity}`);
    const invented = [...carrier.keys()].filter((id) => !inIds.has(id));
    // The directory is listed a second time here rather than trusted from `load`. A file that was never
    // opened files no findings, so nothing downstream of `load` can miss it, which is how `cid-03.jsonl`
    // went unread for a week under a reconciliation that said everything was accounted for.
    const unread = fs.readdirSync(runDir).filter((f) => f.endsWith('.jsonl') && !chips.includes(f) && !GENERATED.includes(f));
    const failed = [];
    if (unread.length)
        failed.push(`${unread.length} .jsonl file(s) in the run directory this merge never opened: ${name(unread)}`);
    if (lost.length)
        failed.push(`${lost.length} finding(s) read off the chip files reach no row on disk: ${name(lost)}`);
    if (demoted.length)
        failed.push(`${demoted.length} blocker(s) landed on a row of lower severity: ${name(demoted)}`);
    if (invented.length)
        failed.push(`${invented.length} sighting id(s) on disk that no chip file filed: ${name(invented)}`);
    if (failed.length) {
        for (const f of failed)
            console.error(`RECONCILE FAILED: ${f}`);
        // Same reason the torn line refuses before writing: `landed` gates on backlog.jsonl existing, so a
        // backlog that lost a finding is worse than none at all. This merge wrote these three seconds ago.
        for (const f of GENERATED)
            fs.rmSync(path.join(runDir, f), { force: true });
        console.error(`REFUSED: ${GENERATED.join(', ')} were removed rather than left behind for the run to land over.`);
        process.exit(1);
    }
    console.log(`reconciled: ${findings.length} findings off ${chips.length} chip file(s), ${carrier.size} carried by ${merged.length + skipped.length} rows read back off disk`);
}
if (cmd === 'render') {
    const merged = rows('backlog.jsonl'), skipped = rows('skipped.jsonl'), unreached = rows('unreached.jsonl');
    const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
    const out = [`# Backlog - run \`${runId}\``, '',
        `Rendered from \`backlog.jsonl\` by \`fleet-merge.mjs render\`. Counts come from the files, not from prose.`, '',
        `- **Entries:** ${merged.length} after dedupe`,
        `- **By severity:** ${SEV.map((s) => `${merged.filter((m) => m.severity === s).length} ${s}`).join(' / ')}`,
        `- **Skipped:** ${skipped.length} (see \`skipped.md\`)`,
        `- **Unreached:** ${unreached.length}`,
        `- **Confirmed:** ${merged.filter((m) => m.confirmation === 'confirmed').length}`, ''];
    for (const sev of SEV) {
        const g = merged.filter((m) => m.severity === sev);
        out.push(`## ${sev[0].toUpperCase() + sev.slice(1)} (${g.length})`, '');
        if (!g.length) {
            out.push('None.', '');
            continue;
        }
        out.push('| id | Area | Observed | Repro | Evidence | Mechanism | Status | Conditions | Confirm | Workers |', '|---|---|---|---|---|---|---|---|---|---|');
        for (const m of g)
            out.push('| ' + [m.id, m.area, m.observed, m.repro, m.evidence, m.mechanism,
                m.mechanism_status, [m.conditions, (m.contaminated_by || []).join('; '),
                    (m.skip_reasons || []).map((r) => `one worker skipped this - ${r}`).join('; ')].filter(Boolean).join(' | '),
                m.confirmation, m.workers.join(' ')].map(esc).join(' | ') + ' |');
        out.push('');
    }
    out.push(`## Unreached (${unreached.length})`, '', '| Area | Reason | Worker |', '|---|---|---|');
    for (const u of unreached)
        out.push('| ' + [u.unreached, u.reason, u.chip].map(esc).join(' | ') + ' |');
    fs.writeFileSync(path.join(runDir, 'backlog.md'), out.join('\n') + '\n');
    const sk = [`# Skipped - run \`${runId}\``, '',
        'Findings set aside rather than deleted. Each keeps its full schema, so promoting one back needs no re-observation.', '',
        '| id | Area | Observed | Why skipped | Workers |', '|---|---|---|---|---|'];
    for (const s of skipped)
        sk.push('| ' + [s.id, s.area, s.observed, s.skip_reason, s.workers.join(' ')].map(esc).join(' | ') + ' |');
    fs.writeFileSync(path.join(runDir, 'skipped.md'), sk.join('\n') + '\n');
    console.log(`rendered backlog.md (${merged.length} entries) and skipped.md (${skipped.length})`);
}
if (cmd === 'fixqueue') {
    const merged = read('backlog.jsonl').map((l) => JSON.parse(l));
    const take = merged.filter((m) => m.severity === 'blocker' || m.severity === 'major');
    const dir = path.join(path.dirname(path.resolve(runDir)), `fix-${runId}`, 'tasks', 'ready');
    // Tasks are numbered by backlog position, so a second fixqueue over a re-merged backlog would write
    // `task-003-*` for another finding beside the old one, and overwrite the `after:` gates `fleet-gate.mjs
    // cluster` put on the members while its root task stays. Refuse rather than mix two generations.
    if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.md'))) {
        console.error(`REFUSED: ${dir} already holds tasks. Remove ${path.dirname(path.dirname(dir))} to write the queue again.`);
        process.exit(1);
    }
    fs.mkdirSync(dir, { recursive: true });
    // Twins: entries whose evidence names the same file are one seam, so they carry each other's ids. Read
    // only here, so a merge run from a copy of this file (the selftest's sabotaged ones) never needs it.
    const { FILE_RE } = await import('../hooks/run-dir.mjs');
    const fileOf = (m) => [...String(m.evidence || '').matchAll(FILE_RE)].map((x) => x[1].split('\\').join('/'));
    const byFile = new Map();
    for (const m of take)
        for (const f of fileOf(m))
            byFile.set(f, [...(byFile.get(f) || []), m.id]);
    take.forEach((m, i) => {
        const twins = [...new Set(fileOf(m).flatMap((f) => byFile.get(f) || []))].filter((id) => id !== m.id);
        const slug = String(m.area).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'finding';
        const n = String(i + 1).padStart(3, '0');
        fs.writeFileSync(path.join(dir, `task-${n}-${slug}.md`), `---
task-id: task-${n}-${slug}
kind: ${m.rects || m.probe ? 'design' : 'fix'}
finding-id: ${m.id}
severity: ${m.severity}
needs: ${/\b(click|type|hover|scroll|drag|screenshot|overlaps?|zoom)\b/i.test(m.repro || '') ? 'pane' : 'repo'}
budget: 25
twins: [${twins.join(', ')}]
---

# ${m.area}

**Observed.** ${m.observed}

**Reproduce it first, and only then change anything.** ${m.repro || 'No recorded reproduction: establish one before editing, and if you cannot, move this entry to skipped with what you tried.'}

**Evidence recorded by the run.** ${m.evidence}

**Suspected mechanism, ${m.mechanism_status}.** ${m.mechanism || 'Not established.'} Treat this as a lead rather than a diagnosis: measured across one run, roughly 15 of every 100 findings were refuted when somebody tried to fix them, and the refutations were of the mechanism rather than the symptom.

**Conditions the observation depended on.** ${m.conditions || 'None recorded.'}${m.contaminated_by ? `\n\n**Measured after a shared-state change:** ${m.contaminated_by.join('; ')}. Re-read the observation under clean state before trusting it.` : ''}${m.rects || m.probe ? `\n\n**This is a design finding**${m.probe ? ` from \`${m.probe}\`` : ''}. The design model owns the screen end to end (docs/MISSIONS.md, design): the number the probe reported is the number to move, and the same probe run on the repaired screen is the proof.${m.rects ? ` Rectangles at the time: ${JSON.stringify(m.rects)}.` : ''}` : ''}

## Done when

- The reproduction above fails before your change and passes after it.
- ${twins.length ? `The twins sharing this seam are checked for the same defect: ${twins.join(', ')}.` : 'No other entry names these files.'}
- A regression test covers the reproduction, per the project's own testing rules.
`);
    });
    console.log(`wrote ${take.length} fix tasks to ${dir}`);
}
