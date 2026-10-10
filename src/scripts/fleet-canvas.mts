/**
 * fleet-canvas.mjs - the file half of a design canvas: artboards on disk, checked, laid out, and seeded
 * into the Claude Design canvas editor.
 *
 * A canvas run has N workers each writing one `<Screen>.dc.html`, and nothing but this script standing
 * between those files and a published page. So this is where the canvas gate lives, the way `fleet.sh
 * find` is where the finding gate lives: an artboard that names no source file, or claims a measurement
 * it never made, is refused here rather than requested in prose.
 *
 *   node fleet-canvas.mjs stamp  <artboard> --source a.vue,b.vue [--route /x] [--viewport 1440x900]
 *                                           [--frames 301] [--frame 1440x900] [--recon path] [--page current]
 *   node fleet-canvas.mjs check  <dir|artboard> [--project <root>]      exit 0 clean, 1 refused
 *   node fleet-canvas.mjs layout <dir> [--title "..."] [--launch <page>]  -> canvas.json, and a cover
 *                                                                          Main.dc.html when there is none
 *   node fleet-canvas.mjs plain  <artboard> [--out file.html]             -> a standalone page a pane can
 *                                                                          open and measure
 *   node fleet-canvas.mjs seed   <dir> --title "..." --out <name>.html [--skill-dir <design skill dir>]
 *
 * The provenance block every artboard carries, as an HTML comment near the top of the file:
 *
 *   <!-- fleet-canvas
 *   source: src/pages/Cases.vue, src/components/CaseTable.vue
 *   route: /cases
 *   viewport: 1440x900 zoom 1
 *   frames: 301
 *   frame: 1440x900
 *   recon: .fleet/2026-09-03-canvas/recon/Cases.json
 *   page: current
 *   -->
 *
 * `source` names the files the artboard was built from, and every one must exist: a screen recreated from
 * memory of the application is the design equivalent of a blind pane. `viewport` plus `frames` say the
 * screen was measured through a live pane; a viewport without a frame count, or one under the gate, is a
 * measurement claimed and not made. `route` without `viewport` is allowed and reported as unmeasured.
 *
 * Node only, no dependencies. The editor payload and its seeding helper belong to the harness's `design`
 * skill, found under the temp directory once that skill has run on this machine.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cal } from '../hooks/run-dir.mjs';

type Prov = Record<string, string>;
interface WH { w: number; h: number }
interface Entry { file: string; stem: string; page: string; frame: WH; route: string | null | undefined; measured: boolean; mtime: number; generated: boolean }
interface Page { id: string; name: string }
interface Artboard { file: string; x?: number; y?: number; w?: number; h?: number; page?: string }
interface Launch { view: string; page?: string }
interface Canvas { artboards: Artboard[]; pages?: Page[]; annotations?: unknown[]; launch?: Launch }
type Newest = Entry & { pageId: string | undefined };
const argv = process.argv.slice(2);
const cmd = argv[0], target = argv[1];
const opt = <D extends string | undefined = undefined>(name: string, dflt?: D): string | D => { const i = argv.indexOf('--' + name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt as D; };
const flag = (name: string) => argv.includes('--' + name);
const usage = () => { console.error('usage: fleet-canvas.mjs stamp|check|layout|plain|seed <target> [options]  (read the header of this file)'); process.exit(2); };
if (!cmd || !target) usage();

const ARTBOARD_RE = /^[A-Za-z0-9_][A-Za-z0-9 _.-]{0,80}\.dc\.html$/;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg']);
const SUPPORT = '<script src="./support.js"></script>';
const MAX_ENTRY = 2 * 1024 * 1024;
const PAGES = [['current', 'Current'], ['proposed', 'Proposed'], ['directions', 'Directions'], ['system', 'System']];
const DEFAULT_FRAME = { w: 1440, h: 900 };
const GAP_X = 120, GAP_Y = 160, PER_ROW = 3;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u;

// Constants live in calibration.json beside the running plugin, never retyped here and never taken from a
// cache snapshot that happens to be newer by mtime (e774c09) - `cal` reads the sibling first.
const GATE = cal('frame_gate_min_fps', 10);

// ---------------------------------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------------------------------
const PROV_RE = /<!--\s*fleet-canvas\s*\n([\s\S]*?)-->/;
function readProvenance(src: string): Prov | null {
  const m = src.slice(0, 8192).match(PROV_RE);
  if (!m) return null;
  const out: Prov = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^\s*([a-z_-]+)\s*:\s*(.*?)\s*$/i);
    if (mm) out[mm[1].toLowerCase()] = mm[2];
  }
  return out;
}
const parseWH = (s: string | undefined): WH | null => { const m = String(s || '').match(/(\d+)\s*[x×]\s*(\d+)/i); return m ? { w: +m[1], h: +m[2] } : null; };
const listOf = (s: string | undefined) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

function stamp() {
  const file = path.resolve(target);
  if (!fs.existsSync(file)) { console.error(`no such artboard: ${file}`); process.exit(2); }
  const src = fs.readFileSync(file, 'utf8');
  const prev = readProvenance(src) || {};
  const next = { ...prev };
  for (const k of ['source', 'route', 'viewport', 'frames', 'frame', 'recon', 'page', 'title', 'generated']) { const v = opt(k); if (v !== undefined) next[k] = v; }
  if (!next.source && !next.generated) { console.error('REFUSED: --source names the files this artboard was built from, and it is required'); process.exit(1); }
  if (next.viewport && !next.frames) { console.error('REFUSED: a viewport records a measurement, so --frames must carry the frame count it was measured under'); process.exit(1); }
  if (next.frames !== undefined && !(parseInt(next.frames, 10) >= GATE)) { console.error(`REFUSED: frames ${next.frames} is under the gate (${GATE}); a blind pane measured nothing, so stamp nothing`); process.exit(1); }
  // Git Bash on Windows rewrites an argument that starts with `/` into a path under its own install
  // (`/cases` -> `C:/Program Files/Git/cases`). Measured while testing this script. Refuse the mangled form
  // rather than stamping it, and say the one variable that stops it.
  if (next.route && !/^(\/|https?:\/\/|#)/.test(next.route)) { console.error(`REFUSED: route "${next.route}" does not start with /: if you passed /route from Git Bash it was rewritten into a path - run with MSYS_NO_PATHCONV=1, or write the provenance block yourself`); process.exit(1); }
  const block = '<!-- fleet-canvas\n' + Object.entries(next).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n-->\n';
  let out;
  // Replacements as functions: a `$'` in a title is a replacement pattern, and copied the page into the block.
  if (PROV_RE.test(src.slice(0, 8192))) out = src.replace(PROV_RE, () => block.trimEnd());
  else if (/^<!doctype html>\s*\n/i.test(src)) out = src.replace(/^(<!doctype html>\s*\n)/i, (m) => m + block);
  else out = block + src;
  fs.writeFileSync(file, out);
  console.log(`STAMPED ${path.basename(file)}: ${Object.keys(next).join(', ')}`);
}

// ---------------------------------------------------------------------------------------------------
// Check: the gate
// ---------------------------------------------------------------------------------------------------
function checkOne(file: string, project: string) {
  const errors: string[] = [], warns: string[] = [];
  const name = path.basename(file);
  if (!ARTBOARD_RE.test(name)) errors.push(`name "${name}" is not <Name>.dc.html (a letter, digit or underscore first; letters, digits, space, _ . - after)`);
  const size = fs.statSync(file).size;
  if (size > MAX_ENTRY) errors.push(`${(size / 1048576).toFixed(1)} MiB: the editor silently drops an entry over 2 MiB`);
  const src = fs.readFileSync(file, 'utf8');
  const supports = src.split(SUPPORT).length - 1;
  if (supports !== 1) errors.push(`the head line ${SUPPORT} must appear exactly once (found ${supports}); the editor replaces it with its runtime`);
  if (!/<x-dc>/.test(src) || !/<\/x-dc>/.test(src)) errors.push('the design must be wrapped in <x-dc> ... </x-dc>');
  if (!/^\s*<!doctype html>/i.test(src)) warns.push('no <!doctype html> on the first line');
  const hasLogic = /<script[^>]*data-dc-script/.test(src);
  if (/\{\{/.test(src) && !hasLogic) errors.push('{{ holes }} with no <script data-dc-script>: nothing renders them');
  const empty = src.match(/<script[^>]*data-dc-script[^>]*>\s*<\/script>/);
  if (empty) errors.push('an empty <script data-dc-script> errors in the editor: omit it for a static artboard');
  if (EMOJI_RE.test(src)) warns.push('emoji or dingbat glyphs in the markup: icons are inline SVG, never emoji');
  if (/<helmet>/.test(src) && !/\ba\s*(?:,[^{]*)?\{[^}]*color/.test(src)) warns.push('no `a { color }` rule in <helmet>: links a viewer adds later render browser-default blue');

  const p = readProvenance(src);
  if (!p) errors.push('no provenance block: <!-- fleet-canvas ... --> naming source: files (stamp it with `fleet-canvas.mjs stamp`)');
  else {
    if (p.generated) { /* a cover the layout wrote; it comes from no screen */ }
    else {
      const sources = listOf(p.source);
      if (!sources.length) errors.push('provenance names no source: file');
      for (const s of sources) if (!fs.existsSync(path.resolve(project, s))) errors.push(`source ${s} does not exist under ${project}: an artboard built from memory of a file is not built from the file`);
      if (p.viewport) {
        const frames = parseInt(p.frames, 10);
        if (!Number.isFinite(frames)) errors.push('viewport recorded without frames: a measurement claimed and not made');
        else if (frames < GATE) errors.push(`frames ${frames} is under the gate (${GATE}): that pane was blind, and every number it gave is fiction`);
      } else if (p.route) warns.push(`route ${p.route} without a viewport: recreated from source alone, never measured against the screen`);
      else warns.push('no route: this artboard is not tied to a screen of the application');
    }
    if (p.frame && !parseWH(p.frame)) errors.push(`frame "${p.frame}" is not WxH`);
    if (!p.frame) warns.push(`no frame: WxH, so layout will use ${DEFAULT_FRAME.w}x${DEFAULT_FRAME.h}`);
    if (p.page && !PAGES.some(([id]) => id === p.page)) errors.push(`page "${p.page}" is not one of ${PAGES.map((x) => x[0]).join('|')}`);
  }
  return { file, errors, warns, prov: p };
}

function artboardsIn(dir: string) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.dc.html')).sort().map((f) => path.join(dir, f));
}

function check() {
  const t = path.resolve(target);
  const project = path.resolve(opt('project', process.cwd()));
  const files = fs.statSync(t).isDirectory() ? artboardsIn(t) : [t];
  if (!files.length) { console.error(`no .dc.html artboards under ${t}`); process.exit(1); }
  let bad = 0, warned = 0;
  for (const f of files) {
    const r = checkOne(f, project);
    const name = path.basename(f);
    if (r.errors.length) { bad++; console.log(`REFUSED ${name}`); for (const e of r.errors) console.log(`  error: ${e}`); }
    else console.log(`ok      ${name}${r.prov && r.prov.route ? '  ' + r.prov.route : ''}${r.prov && r.prov.viewport ? '  measured ' + r.prov.viewport + ' @ ' + r.prov.frames + ' frames' : ''}`);
    for (const w of r.warns) { warned++; console.log(`  warn:  ${w}`); }
  }
  console.log(`${files.length} artboards, ${bad} refused, ${warned} warnings`);
  process.exit(bad ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------------
// Layout: canvas.json, and a cover when there is none
// ---------------------------------------------------------------------------------------------------
function pageOf(name: string, prov: Prov | null) {
  if (prov && prov.page) return prov.page;
  if (/\.Proposed\.dc\.html$/i.test(name)) return 'proposed';
  if (/^Direction/i.test(name)) return 'directions';
  if (/^(System|Tokens|Primitives)\b/i.test(name)) return 'system';
  return 'current';
}
function frameOf(src: string, prov: Prov | null): WH | null {
  if (prov && prov.frame) { const f = parseWH(prov.frame); if (f) return f; }
  const m = src.match(/"\$preview"\s*:\s*\{\s*"width"\s*:\s*(\d+)\s*,\s*"height"\s*:\s*(\d+)/);
  if (m) return { w: +m[1], h: +m[2] };
  return null;
}
function esc(s: unknown) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function coverHtml(title: string, entries: Entry[]) {
  const byPage = new Map<string, Entry[]>();
  for (const e of entries) byPage.set(e.page, [...(byPage.get(e.page) || []), e]);
  const rows: string[] = [];
  for (const [id, label] of PAGES) {
    const list = byPage.get(id); if (!list) continue;
    rows.push(`      <div style="display: flex; flex-direction: column; gap: 6px">
        <div style="font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #6b6b66">${esc(label)}</div>
${list.map((e) => `        <div style="display: flex; gap: 12px; align-items: baseline"><span style="font-weight: 500">${esc(e.stem)}</span>${e.route ? `<span style="color: #6b6b66; font-size: 13px">${esc(e.route)}</span>` : ''}${e.measured ? '' : '<span style="color: #a1662f; font-size: 12px">unmeasured</span>'}</div>`).join('\n')}
      </div>`);
  }
  const date = new Date().toISOString().slice(0, 10);
  return `<!doctype html>
<!-- fleet-canvas
generated: fleet-canvas layout ${date}
frame: 880x560
page: current
-->
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #1f1f1c; background: #f7f6f2; }
    a { color: #1f1f1c; } a:hover { color: #6b6b66; }
  </style>
</helmet>
<div style="width: 880px; height: 560px; box-sizing: border-box; padding: 56px 64px; display: flex; flex-direction: column; gap: 40px; background: #f7f6f2">
  <div style="display: flex; flex-direction: column; gap: 8px">
    <div style="font-size: 36px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.1">${esc(title)}</div>
    <div style="font-size: 14px; color: #6b6b66">Captured from the running application and its source, ${date}. ${entries.length} artboard${entries.length === 1 ? '' : 's'}.</div>
  </div>
  <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 32px; font-size: 15px; line-height: 1.4">
${rows.join('\n')}
  </div>
</div>
</x-dc>
</body>
</html>
`;
}

function layout() {
  const dir = path.resolve(target);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { console.error(`no such directory: ${dir}`); process.exit(2); }
  const title = opt('title', path.basename(dir) === 'canvas' ? path.basename(path.dirname(dir)) : path.basename(dir));
  const canvasPath = path.join(dir, 'canvas.json');
  let prev: Canvas | null = null;
  if (fs.existsSync(canvasPath)) { try { prev = JSON.parse(fs.readFileSync(canvasPath, 'utf8')); } catch (e) { console.error(`existing canvas.json does not parse (${(e as Error).message}); refusing to overwrite it`); process.exit(1); } }

  let files = artboardsIn(dir);
  const entries: Entry[] = [];
  const warns: string[] = [];
  for (const f of files) {
    const name = path.basename(f), src = fs.readFileSync(f, 'utf8'), prov = readProvenance(src);
    const frame = frameOf(src, prov);
    if (!frame) warns.push(`${name}: no frame in provenance or $preview, using ${DEFAULT_FRAME.w}x${DEFAULT_FRAME.h}`);
    entries.push({ file: name, stem: name.replace(/\.dc\.html$/, ''), page: pageOf(name, prov), frame: frame || DEFAULT_FRAME, route: prov && prov.route, measured: !!(prov && prov.viewport), mtime: fs.statSync(f).mtimeMs, generated: !!(prov && prov.generated) });
  }
  if (!entries.length) { console.error(`no .dc.html artboards under ${dir}`); process.exit(1); }

  let coverWritten = false;
  if (!entries.some((e) => e.file === 'Main.dc.html')) {
    const cover = path.join(dir, 'Main.dc.html');
    fs.writeFileSync(cover, coverHtml(title, entries.filter((e) => !e.generated)));
    entries.unshift({ file: 'Main.dc.html', stem: 'Main', page: 'current', frame: { w: 880, h: 560 }, route: null, measured: true, mtime: Date.now(), generated: true });
    coverWritten = true;
  }

  const pagesUsed = PAGES.filter(([id]) => entries.some((e) => e.page === id));
  const multi = pagesUsed.length > 1 || (prev && Array.isArray(prev.pages) && prev.pages.length > 1);
  const pages: Page[] = multi ? [...(prev && Array.isArray(prev.pages) ? prev.pages.filter((p) => p && p.id && p.name) : [])] : [];
  if (multi) for (const [id, name] of pagesUsed) if (!pages.some((p) => p.id === 'page-' + id)) pages.push({ id: 'page-' + id, name });
  const pageId = (id: string) => (multi ? 'page-' + id : undefined);

  const kept = new Map<string, Artboard>();
  if (prev && Array.isArray(prev.artboards)) for (const a of prev.artboards) if (a && a.file && entries.some((e) => e.file === a.file)) kept.set(a.file, a);

  const artboards: Artboard[] = [];
  let newest = null as Newest | null;
  for (const [id] of pagesUsed) {
    const mine = entries.filter((e) => e.page === id);
    const oldOnes = mine.filter((e) => kept.has(e.file)), fresh = mine.filter((e) => !kept.has(e.file));
    for (const e of oldOnes) { const a = { ...kept.get(e.file)! }; if (multi) a.page = pageId(id); else delete a.page; artboards.push(a); }
    let y0 = 0;
    for (const e of oldOnes) { const a = kept.get(e.file)!; y0 = Math.max(y0, (a.y || 0) + (a.h || e.frame.h) + GAP_Y); }
    const maxW = Math.max(...fresh.map((e) => e.frame.w), 0), maxH = Math.max(...fresh.map((e) => e.frame.h), 0);
    fresh.forEach((e, i) => {
      const col = i % PER_ROW, row = Math.floor(i / PER_ROW);
      const a: Artboard = { file: e.file, x: col * (maxW + GAP_X), y: y0 + row * (maxH + GAP_Y), w: e.frame.w, h: e.frame.h };
      if (multi) a.page = pageId(id);
      artboards.push(a);
      if (!newest || e.mtime > newest.mtime) newest = { ...e, pageId: pageId(id) };
    });
  }

  const launchPage = opt('launch');
  const out: Canvas = { artboards };
  if (prev && Array.isArray(prev.annotations) && prev.annotations.length) out.annotations = prev.annotations;
  if (multi) out.pages = pages;
  if (launchPage) {
    if (!multi) out.launch = { view: 'canvas' };
    else if (pages.some((p) => p.id === 'page-' + launchPage || p.id === launchPage)) out.launch = { view: 'canvas', page: pages.find((p) => p.id === 'page-' + launchPage || p.id === launchPage)!.id };
    else { console.error(`--launch ${launchPage} is not a page here (${pages.map((p) => p.id).join(', ')})`); process.exit(1); }
  } else if (multi) out.launch = { view: 'canvas', page: newest && newest.pageId ? newest.pageId : pages[0].id };
  else if (prev && prev.launch) out.launch = prev.launch;
  else out.launch = { view: 'canvas' };

  fs.writeFileSync(canvasPath, JSON.stringify(out, null, 2) + '\n');
  console.log(`LAID OUT ${artboards.length} artboards${multi ? ' on ' + pages.length + ' pages' : ''} -> ${canvasPath}`);
  for (const [id, name] of pagesUsed) console.log(`  ${name}: ${entries.filter((e) => e.page === id).map((e) => e.stem).join(', ')}`);
  if (coverWritten) console.log('  wrote a cover Main.dc.html (the editor opens on Main; edit or replace it, never delete it before a first seed)');
  console.log(`  kept ${kept.size} positions from the previous canvas.json, placed ${artboards.length - kept.size} new`);
  for (const w of warns) console.log(`  warn: ${w}`);
  const unmeasured = entries.filter((e) => !e.generated && !e.measured);
  if (unmeasured.length) console.log(`  unmeasured: ${unmeasured.map((e) => e.stem).join(', ')} - recreated from source, never checked against the screen`);
}

// ---------------------------------------------------------------------------------------------------
// Plain: a standalone page for a pane to measure
// ---------------------------------------------------------------------------------------------------
function plain() {
  const file = path.resolve(target);
  if (!fs.existsSync(file)) { console.error(`no such artboard: ${file}`); process.exit(2); }
  const src = fs.readFileSync(file, 'utf8');
  const body = (src.match(/<x-dc>([\s\S]*?)<\/x-dc>/) || [])[1];
  if (body == null) { console.error('REFUSED: no <x-dc> ... </x-dc> block'); process.exit(1); }
  if (/<script[^>]*data-dc-script/.test(src) || /\{\{/.test(body) || /<(sc-for|sc-if|dc-import)\b/.test(body)) {
    console.error('REFUSED: this artboard needs the editor runtime (logic, holes, loops or imports) and cannot be rendered plain; measure a static artboard, or the canvas itself');
    process.exit(1);
  }
  const helmet = (body.match(/<helmet>([\s\S]*?)<\/helmet>/) || ['', ''])[1];
  const content = body.replace(/<helmet>[\s\S]*?<\/helmet>/, '');
  const outPath = path.resolve(opt('out', file.replace(/\.dc\.html$/i, '.plain.html')));
  // `Cart.DC.html` kept its name and the render went over the artboard.
  if (outPath.toLowerCase() === file.toLowerCase()) { console.error(`REFUSED: the plain render would overwrite the artboard ${file}; name it with --out`); process.exit(1); }
  const title = path.basename(file).replace(/\.dc\.html$/i, '');
  fs.writeFileSync(outPath, `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${esc(title)} (plain render of an artboard)</title>
${helmet.trim()}
</head>
<body style="margin: 0">
${content.trim()}
</body>
</html>
`);
  console.log(`PLAIN ${outPath}`);
  console.log('  serve it from the project over http and measure it in a live pane with design-probe.js; file:// panes cannot run a probe');
}

// ---------------------------------------------------------------------------------------------------
// Seed: the design skill's helper, driven from here
// ---------------------------------------------------------------------------------------------------
function findSkill() {
  const explicit = opt('skill-dir') || process.env.FLEET_DESIGN_SKILL_DIR;
  const roots: string[] = [];
  if (explicit) roots.push(explicit);
  const tmp = [process.env.TEMP, process.env.TMPDIR, process.env.TMP, os.tmpdir(), '/tmp', path.join(os.homedir(), 'AppData', 'Local', 'Temp')].filter(Boolean) as string[];
  for (const t of new Set(tmp)) {
    const bundled = path.join(t, 'claude', 'bundled-skills');
    if (!fs.existsSync(bundled)) continue;
    try {
      for (const v of fs.readdirSync(bundled)) for (const h of fs.readdirSync(path.join(bundled, v))) {
        const d = path.join(bundled, v, h, 'design');
        if (fs.existsSync(path.join(d, 'seed-canvas.mjs'))) roots.push(d);
      }
    } catch { /* keep looking */ }
  }
  const good = roots.filter((d) => fs.existsSync(path.join(d, 'seed-canvas.mjs')) && fs.existsSync(path.join(d, 'payload.template.html')));
  good.sort((a, b) => fs.statSync(path.join(b, 'seed-canvas.mjs')).mtimeMs - fs.statSync(path.join(a, 'seed-canvas.mjs')).mtimeMs);
  return good[0] || null;
}

function seed() {
  const dir = path.resolve(target);
  const title = opt('title'), out = opt('out');
  if (!title || !out) { console.error('seed needs --title "<what the design is called>" and --out <name>.html'); process.exit(2); }
  const skill = findSkill();
  if (!skill) {
    console.error('REFUSED: the design skill\'s helper (seed-canvas.mjs beside payload.template.html) is not on this machine.');
    console.error('  It is extracted under <temp>/claude/bundled-skills/ the first time the `design` skill runs in a session.');
    console.error('  Invoke /design once in any chat here, or pass --skill-dir <dir> / set FLEET_DESIGN_SKILL_DIR.');
    process.exit(2);
  }
  const project = path.resolve(opt('project', process.cwd()));
  let files = artboardsIn(dir);
  let refused = 0;
  for (const f of files) { const r = checkOne(f, project); if (r.errors.length) { refused++; console.error(`REFUSED ${path.basename(f)}: ${r.errors[0]}`); } }
  if (refused) { console.error(`${refused} artboard(s) refused by the gate; run \`fleet-canvas.mjs check ${target}\` for the full list`); process.exit(1); }
  // The layout is re-run here rather than trusted: it keeps every position it finds and only adds or
  // drops entries, so canvas.json can never name an artboard that was deleted after the last layout, which
  // is the one thing the helper refuses that a worker cannot see coming.
  layout();
  // The list is taken again after the layout, never before it: on a canvas with no cover the layout writes
  // Main.dc.html and names it in canvas.json, and a list snapshotted a line earlier sends every artboard
  // except the one the editor is about to open on. That is every canvas's first seed.
  files = artboardsIn(dir);
  const images = fs.readdirSync(dir).filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase())).map((f) => path.join(dir, f));
  const args = [path.join(skill, 'seed-canvas.mjs'), '--template', path.join(skill, 'payload.template.html'), '--out', path.resolve(out), '--title', title];
  for (const f of files) args.push('--artboard', f);
  for (const f of images) args.push('--image', f);
  args.push('--canvas', path.join(dir, 'canvas.json'));
  console.log(`seeding ${files.length} artboards and ${images.length} images with ${skill}`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: dir });
  if (r.status !== 0) { console.error(`seed-canvas.mjs exited ${r.status}`); process.exit(r.status || 1); }
  const c = spawnSync(process.execPath, [path.join(skill, 'seed-canvas.mjs'), '--check', path.resolve(out)], { stdio: 'inherit' });
  if (c.status !== 0) { console.error('the seeded page failed the helper\'s own check'); process.exit(c.status || 1); }
  console.log(`SEEDED ${path.resolve(out)}`);
  console.log('  Publish it with the Artifact tool by following the `design` skill\'s publish step: load that skill and');
  console.log('  do what its step 4 says. It carries the runtime version pin and the capability rule, both of which');
  console.log('  move with the harness, so neither is copied into any brief or document here.');
}

({ stamp, check, layout, plain, seed }[cmd] || usage)();
