/**
 * fleet-merge.mjs - turn a run's findings into a backlog, mechanically.
 *
 * Measured 2026-08-28: a merge written by a model rendered 68 of 254 findings while its own summary
 * claimed 255, reported one blocker where the workers had filed six, and dropped two blockers entirely,
 * including the worst finding of the run. Nothing about the output looked wrong. So the merge is a
 * script, the counts come from the files, and a mismatch is an error rather than a sentence.
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
const read = (f) => fs.readFileSync(path.join(runDir, f), 'utf8').split('\n').filter(Boolean);
const key = (o) =>
  `${String(o.area || '').toLowerCase().trim()}|${String(o.observed || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)}`;

function load() {
  const findings = [], unreached = [], aux = [], torn = [];
  for (const f of fs.readdirSync(runDir).filter((x) => /^\d+\.jsonl$/.test(x))) {
    const chip = f.replace('.jsonl', '');
    read(f).forEach((line, i) => {
      let o;
      try { o = JSON.parse(line); } catch { torn.push({ chip, line: i + 1 }); return; }
      o.chip = chip;
      o.id = o.id || `${runId}-${chip}-${i + 1}`;
      if (o.severity) findings.push(o);
      else if (o.unreached) unreached.push(o);
      else aux.push(o);
    });
  }
  return { findings, unreached, aux, torn };
}

if (cmd === 'merge') {
  const { findings, unreached, aux, torn } = load();
  const windows = aux.filter((a) => a.state_changed && a.when).map((a) => ({ from: Date.parse(a.when), what: a.state_changed }))
    .filter((w) => !Number.isNaN(w.from));

  const groups = new Map();
  for (const f of findings) {
    const k = key(f);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }

  const merged = [], skipped = [];
  for (const g of groups.values()) {
    g.sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity));
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
    const w = entry.when ? Date.parse(entry.when) : NaN;
    const contaminated = windows.filter((x) => !Number.isNaN(w) && w >= x.from).map((x) => x.what);
    if (contaminated.length) entry.contaminated_by = contaminated;
    if (head.skip_reason) skipped.push({ ...entry, skip_reason: head.skip_reason });
    else merged.push(entry);
  }

  merged.sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity) ||
    b.workers.length - a.workers.length || String(a.area).localeCompare(String(b.area)));

  const w = (f, rows) => fs.writeFileSync(path.join(runDir, f), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  w('backlog.jsonl', merged);
  w('skipped.jsonl', skipped);
  w('unreached.jsonl', unreached);

  const count = (rows) => SEV.map((s) => `${rows.filter((r) => r.severity === s).length} ${s}`).join(' / ');
  const inBlockers = new Set(findings.filter((f) => f.severity === 'blocker').map((f) => key(f)));
  const outBlockers = new Set([...merged, ...skipped].filter((f) => f.severity === 'blocker').map((f) => key(f)));
  const lostBlockers = [...inBlockers].filter((k) => !outBlockers.has(k));
  const accounted = merged.reduce((n, m) => n + m.sightings.length, 0) + skipped.reduce((n, m) => n + m.sightings.length, 0);

  console.log(`input findings   ${findings.length}  (${count(findings)})`);
  console.log(`merged entries   ${merged.length}  (${count(merged)})`);
  console.log(`skipped entries  ${skipped.length}`);
  console.log(`deduped away     ${findings.length - merged.length - skipped.length}`);
  console.log(`unreached        ${unreached.length}`);
  console.log(`auxiliary lines  ${aux.length}${windows.length ? `, ${windows.length} shared-state window(s)` : ''}`);
  if (torn.length) console.log(`TORN LINES       ${torn.length}: ${torn.map((t) => t.chip + ':' + t.line).join(', ')}`);
  if (accounted !== findings.length) {
    console.error(`RECONCILE FAILED: ${accounted} sightings accounted for against ${findings.length} input findings`);
    process.exit(1);
  }
  if (lostBlockers.length) {
    console.error(`RECONCILE FAILED: ${lostBlockers.length} blocker(s) present in input and absent from output`);
    process.exit(1);
  }
  console.log('reconciled: every input finding is accounted for, every blocker survived');
}

if (cmd === 'render') {
  const rows = (f) => (fs.existsSync(path.join(runDir, f)) ? read(f).map((l) => JSON.parse(l)) : []);
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
    if (!g.length) { out.push('None.', ''); continue; }
    out.push('| id | Area | Observed | Repro | Evidence | Mechanism | Status | Conditions | Confirm | Workers |',
      '|---|---|---|---|---|---|---|---|---|---|');
    for (const m of g) out.push('| ' + [m.id, m.area, m.observed, m.repro, m.evidence, m.mechanism,
      m.mechanism_status, [m.conditions, (m.contaminated_by || []).join('; ')].filter(Boolean).join(' | '),
      m.confirmation, m.workers.join(' ')].map(esc).join(' | ') + ' |');
    out.push('');
  }
  out.push(`## Unreached (${unreached.length})`, '', '| Area | Reason | Worker |', '|---|---|---|');
  for (const u of unreached) out.push('| ' + [u.unreached, u.reason, u.chip].map(esc).join(' | ') + ' |');
  fs.writeFileSync(path.join(runDir, 'backlog.md'), out.join('\n') + '\n');

  const sk = [`# Skipped - run \`${runId}\``, '',
    'Findings set aside rather than deleted. Each keeps its full schema, so promoting one back needs no re-observation.', '',
    '| id | Area | Observed | Why skipped | Workers |', '|---|---|---|---|---|'];
  for (const s of skipped) sk.push('| ' + [s.id, s.area, s.observed, s.skip_reason, s.workers.join(' ')].map(esc).join(' | ') + ' |');
  fs.writeFileSync(path.join(runDir, 'skipped.md'), sk.join('\n') + '\n');
  console.log(`rendered backlog.md (${merged.length} entries) and skipped.md (${skipped.length})`);
}

if (cmd === 'fixqueue') {
  const merged = read('backlog.jsonl').map((l) => JSON.parse(l));
  const take = merged.filter((m) => m.severity === 'blocker' || m.severity === 'major');
  const dir = path.join(path.dirname(path.resolve(runDir)), `fix-${runId}`, 'tasks', 'ready');
  fs.mkdirSync(dir, { recursive: true });
  // Twins: entries whose evidence names the same file are one seam, so they carry each other's ids.
  const fileOf = (m) => [...String(m.evidence).matchAll(/([\w./-]+\.(?:ts|tsx|vue|js|mjs|sql|rules))/g)].map((x) => x[1]);
  const byFile = new Map();
  for (const m of take) for (const f of fileOf(m)) byFile.set(f, [...(byFile.get(f) || []), m.id]);
  take.forEach((m, i) => {
    const twins = [...new Set(fileOf(m).flatMap((f) => byFile.get(f) || []))].filter((id) => id !== m.id);
    const slug = String(m.area).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'finding';
    const n = String(i + 1).padStart(3, '0');
    fs.writeFileSync(path.join(dir, `task-${n}-${slug}.md`), `---
task-id: task-${n}-${slug}
kind: fix
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

**Conditions the observation depended on.** ${m.conditions || 'None recorded.'}${m.contaminated_by ? `\n\n**Measured after a shared-state change:** ${m.contaminated_by.join('; ')}. Re-read the observation under clean state before trusting it.` : ''}

## Done when

- The reproduction above fails before your change and passes after it.
- ${twins.length ? `The twins sharing this seam are checked for the same defect: ${twins.join(', ')}.` : 'No other entry names these files.'}
- A regression test covers the reproduction, per the project's own testing rules.
`);
  });
  console.log(`wrote ${take.length} fix tasks to ${dir}`);
}
