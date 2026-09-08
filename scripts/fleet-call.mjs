#!/usr/bin/env node
/**
 * fleet-call.mjs - the gate on a call run. A script that speaks a number nobody wrote down as a fact,
 * a fact with nothing behind it, or a digit in a line meant to be read aloud, is refused here rather
 * than requested in prose. Same reason the finding gate and the canvas gate are scripts.
 *
 *   node fleet-call.mjs check <run-dir|call-dir> [--stale <days>]     exit 0 clean, 1 refused, 2 usage
 *
 * Reads call/facts/*.md - one fact per `## F<task>-<n> ·` heading, with `- how known:`, `- evidence:`
 * and `- when:` beneath it - and call/script.html, where every question carries data-facts="F02-7 ..."
 * and the spoken lines are the <p> inside a <div class="say">, every <li class="en">, and every
 * <td class="say-cell">. A .say block must not nest a <div>; the template does not.
 *
 * With --stale <days>, measured facts whose `when` is older than that many days are listed as warnings,
 * which is what the script's footer turns into "re-measure before the call". Never a refusal: an old
 * number said with its date is honest, and the operator decides whether to re-run the query.
 */
import fs from 'node:fs';
import path from 'node:path';

const HOW = ['measured', 'read', 'told', 'guess'];
const argv = process.argv.slice(2);
const cmd = argv.shift();
const target = argv.shift();
const staleAt = argv.indexOf('--stale');
const staleDays = staleAt >= 0 ? Number(argv[staleAt + 1]) : 0;

if (cmd !== 'check' || !target || (staleAt >= 0 && !(staleDays > 0))) {
  console.error('usage: fleet-call.mjs check <run-dir|call-dir> [--stale <days>]');
  process.exit(2);
}

const dir = fs.existsSync(path.join(target, 'call')) ? path.join(target, 'call') : target;
const errors = [];
const warnings = [];
const facts = new Map();

// The facts. One heading per fact; the fields are the `- key: value` lines under it until the next heading.
const factsDir = path.join(dir, 'facts');
if (!fs.existsSync(factsDir)) {
  errors.push(`${factsDir} does not exist: no facts task has written anything`);
} else {
  for (const name of fs.readdirSync(factsDir).filter((n) => n.endsWith('.md')).sort()) {
    let cur = null;
    const close = () => {
      if (!cur) return;
      const f = cur.fields;
      const where = `${name} ${cur.id}`;
      if (facts.has(cur.id)) errors.push(`${where} is defined twice (first in ${facts.get(cur.id).file})`);
      if (!HOW.includes(f['how known'])) errors.push(`${where}: "how known" must be one of ${HOW.join(', ')}, got "${f['how known'] || ''}"`);
      if (!f.evidence) errors.push(`${where} has no evidence`);
      if (!f.when) errors.push(`${where} has no when`);
      if (staleDays && f['how known'] === 'measured' && f.when) {
        const t = Date.parse(f.when);
        if (Number.isNaN(t)) warnings.push(`${where}: when "${f.when}" is not a date, so its age is unknown`);
        else if ((Date.now() - t) / 86400000 > staleDays) warnings.push(`${where} was measured ${f.when}, older than ${staleDays} days`);
      }
      if (!facts.has(cur.id)) facts.set(cur.id, { file: name, ...f });
      cur = null;
    };
    for (const line of fs.readFileSync(path.join(factsDir, name), 'utf8').split(/\r?\n/)) {
      // Any heading ends the fact above it. Without this, a heading whose id does not parse - a stray
      // space, a different level - silently hands its fields to the previous fact, replacing that fact's
      // evidence with another one's and passing the gate.
      if (/^#/.test(line)) {
        close();
        const h = line.match(/^##\s+(F[A-Za-z0-9]+-\d+)\b/);
        if (h) cur = { id: h[1], fields: {} };
        else if (/^##\s/.test(line)) errors.push(`${name}: heading "${line.trim().slice(0, 60)}" is not a fact id of the form "## F<task>-<n>"`);
        continue;
      }
      const kv = cur && line.match(/^- ([a-z][a-z ]*?):\s*(.*)$/);
      if (kv) cur.fields[kv[1].trim()] = kv[2].trim();
    }
    close();
  }
  if (!facts.size && !errors.length) errors.push(`${factsDir} holds no fact: no "## F<task>-<n> ·" heading in any file`);
}

if (!fs.existsSync(path.join(dir, 'CALL.md'))) errors.push(`${path.join(dir, 'CALL.md')} does not exist, and the live chat reads nothing else first`);

// The script. Provenance is data-facts; the spoken lines are the ones a person reads aloud.
const script = path.join(dir, 'script.html');
const cited = new Set();
let spoken = 0;
if (!fs.existsSync(script)) {
  errors.push(`${script} does not exist`);
} else {
  const html = fs.readFileSync(script, 'utf8');
  for (const m of html.matchAll(/data-facts="([^"]*)"/g)) for (const id of m[1].split(/[\s,]+/)) if (id) cited.add(id);
  if (!cited.size) errors.push('script.html cites no fact: no data-facts attribute on any question');
  for (const id of cited) if (!facts.has(id)) errors.push(`script.html cites ${id}, which no facts file defines`);

  // Match the class wherever it sits in the attribute and whatever else sits beside it. Anchoring on one
  // exact spelling means `class="say warn"` or an id before the class is not a failure - it is a block
  // the gate silently stops reading, which is worse.
  const cls = (tag, name) => new RegExp(`<${tag}\\b[^>]*\\bclass="[^"]*\\b${name}\\b[^"]*"[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  const lines = [];
  for (const block of html.matchAll(cls('div', 'say'))) {
    // A nested <div> ends the non-greedy match early and hides every line after it.
    if (/<div\b/.test(block[1])) errors.push('a .say block contains a nested <div>, so the lines after it are never checked');
    for (const p of block[1].matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)) lines.push(p[1]);
  }
  for (const m of html.matchAll(cls('li', 'en'))) lines.push(m[1]);
  for (const m of html.matchAll(cls('td', 'say-cell'))) lines.push(m[1]);
  spoken = lines.length;
  for (const raw of lines) {
    const text = raw.replace(/<[^>]+>/g, '').replace(/&[A-Za-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
    if (/\d/.test(text)) errors.push(`a spoken line carries a digit, and the speaker will stumble on it: "${text.slice(0, 90)}"`);
  }
}

const byHow = HOW.map((h) => `${[...facts.values()].filter((f) => f['how known'] === h).length} ${h}`).join(', ');
const uncited = [...facts.keys()].filter((id) => !cited.has(id));
for (const w of warnings) console.log(`STALE    ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`REFUSED  ${e}`);
  console.error(`${errors.length} problem(s); ${facts.size} facts (${byHow}), ${cited.size} cited, ${spoken} spoken lines`);
  process.exit(1);
}
console.log(`${facts.size} facts (${byHow}), ${cited.size} cited, ${uncited.length} uncited, ${spoken} spoken lines, ${warnings.length} stale`);
if (uncited.length) console.log(`uncited: ${uncited.join(' ')}`);
