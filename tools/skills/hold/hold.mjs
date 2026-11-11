#!/usr/bin/env node
// hold.mjs - the list a hold keeps on disk: <dir>/index.md plus one NN.md per item and img/NN-k.ext copies.
// No dependencies. An item's text is stored verbatim in a quote block, never reworded.
//
// The folder is hold/<session id>/ under $CLAUDE_CONFIG_DIR/makarasty (default ~/.claude): the id comes from
// --sid, else $CLAUDE_CODE_SESSION_ID, else $CLAUDE_SESSION_ID. --dir <path> names a folder outright. Both
// refuse an empty id and the hold root itself.
//
//   init [codeword]                      make the folder, print its path; index.md starts `collecting <codeword>`.
//                                        A folder that reads `released` is first renamed <sid>-<YYYYMMDD-HHMM>: a second hold starts fresh
//   dir                                  print the folder
//   add [--from FILE]                    FILE (else stdin): optional header lines `where:` `reading:` `flag:` `img:`,
//                                        a `---` line, then the person's text. Prints `NN chars=.. img=ok/seen ..`
//   status NN <st> <evidence...>         st = open done partial not-done dropped merged->NN (evidence after `--` may start with --)
//   edit NN --from FILE                  replace the text, keep the old one in the file as `previous`
//   drop NN <reason>                     the person removed the item (status dropped)
//   check                                exit 1 and list every item or stray file that is not final
//   release [--drop REASON]              first line becomes `released <codeword>`; --drop marks every unfinished item not-done
//   carry <old-sid|old-dir> [--all]      copy unfinished items (not-done, partial, open) into this folder, print old->new
//   last                                 print the newest earlier folder of this project whose check fails
//   clean                                remove folders/files older than a day holding only a `collecting` line
//
// Exit 0 = ok, 1 = refused or check failed. Flags --reading --where --flag --img on add are a fallback to the header.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);

const die = (m) => { console.error(`hold: ${m}`); process.exit(1); };
const pad = (n) => String(n).padStart(2, '0');
const read = (p) => readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const lines = (s) => s.split('\n').filter((l) => l !== '');
const fwd = (p) => p.replaceAll('\\', '/'); // a backslash path breaks in a Git Bash command line
const one = (s) => String(s).replace(/\s+/g, ' ').trim();
const DAY = 86400000;
const FINAL = /^(done|partial|not-done|dropped|merged→\d+)$/;
const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'makarasty', 'hold');

// Positionals and --key value pairs; --all is a switch, --flag and --img repeat, a bare -- ends the options.
function parse(args) {
  const pos = [], opt = { flag: [], img: [] };
  let raw = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (raw) pos.push(a);
    else if (a === '--') raw = true;
    else if (a === '--all') opt.all = true;
    else if (a.startsWith('--')) {
      const k = a.slice(2), v = args[++i];
      if (v === undefined) die(`${a} needs a value`);
      if (k === 'flag' || k === 'img') opt[k].push(v); else opt[k] = v;
    } else pos.push(a);
  }
  return { pos, opt };
}

const validSid = (s) => typeof s === 'string' && /^[\w.-]+$/.test(s) && s !== '.' && s !== '..';
const sidOf = (opt) => [opt.sid, process.env.CLAUDE_CODE_SESSION_ID, process.env.CLAUDE_SESSION_ID].find(validSid);
function dirFor(opt, lenient = false) {
  const sid = sidOf(opt);
  const dir = opt.dir ? resolve(opt.dir) : sid ? join(root, sid) : '';
  if (!dir || resolve(dir) === resolve(root)) { if (lenient) return ''; die('no session id (use --sid or set CLAUDE_CODE_SESSION_ID); refusing to touch the hold root'); }
  return dir;
}

const indexOf = (dir) => join(dir, 'index.md');
const fmt = (i) => `${i.nn} | ${i.status} | ${i.title} | ${i.flags}`.replace(/ $/, '');
const ensureIndex = (dir, word = 'абрикос') => {
  mkdirSync(join(dir, 'img'), { recursive: true });
  if (!existsSync(indexOf(dir))) writeFileSync(indexOf(dir), `collecting ${word}\n`);
};
function items(dir) {
  if (!existsSync(indexOf(dir))) die(`no ${indexOf(dir)}`);
  return lines(read(indexOf(dir))).slice(1).flatMap((l) => {
    const m = /^(\d+) \| ([^|]*?) \| (.*?) \|(.*)$/.exec(l);
    return m ? [{ nn: m[1], status: m[2], title: m[3], flags: m[4].trim() }] : [];
  });
}
const firstLine = (dir) => read(indexOf(dir)).split('\n')[0];
const writeIndex = (dir, first, its) => writeFileSync(indexOf(dir), [first, ...its.map(fmt)].join('\n') + '\n');
const files = (dir) => readdirSync(dir).flatMap((f) => /^\d+\.md$/.test(f) ? [f.slice(0, -3)] : []);
const nextNn = (dir) => Math.max(0, ...items(dir).map((i) => +i.nn), ...files(dir).map(Number)) + 1;
const stdin = () => { try { return readFileSync(0, 'utf8'); } catch { return ''; } };
const quote = (t) => t.split('\n').map((l) => (l === '' ? '>' : `> ${l}`)).join('\n');
const unquote = (l) => l.replace(/^> ?/, '');
// The short title: cut on a word boundary, a bar cannot break the index line.
const title = (s) => { s = one(s).replaceAll('|', '/'); if (s.length <= 60) return s; const k = s.lastIndexOf(' ', 60); return `${s.slice(0, k > 20 ? k : 60)}…`; };
// The person's text of an item file: the first quote block, up to a `previous` section.
function textOf(file) {
  const L = read(file).split('\n'), q = L.findIndex((l) => /^>( |$)/.test(l));
  if (q < 0) return '';
  const e = L.findIndex((l, i) => i > q && /^previous \(replaced/.test(l));
  return L.slice(q, e < 0 ? L.length : e).join('\n').replace(/\n+$/, '').split('\n').map(unquote).join('\n');
}

// Header lines, a `---` line, then the text. Without a clean header the whole input is the text.
function draft(raw) {
  const L = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const h = { where: undefined, reading: undefined, flag: [], img: [] }, cut = L.indexOf('---');
  if (cut < 0 || !L.slice(0, cut).every((l) => /^(where|reading|flag|img):/.test(l))) return { h, text: L.join('\n') };
  for (const l of L.slice(0, cut)) {
    const [, k, v] = /^(\w+):\s*(.*)$/.exec(l);
    if (k === 'flag' || k === 'img') h[k].push(v); else h[k] = v;
  }
  return { h, text: L.slice(cut + 1).join('\n') };
}
function readInput(opt) {
  let raw;
  if (opt.from) {
    if (!existsSync(opt.from)) die(`no such file: ${opt.from}`);
    raw = read(opt.from);
  } else raw = stdin();
  const { h, text } = draft(raw);
  if (text.trim() === '') die('empty text, nothing to record');
  return { text, where: opt.where ?? h.where, reading: opt.reading ?? h.reading, flag: [...h.flag, ...opt.flag], img: [...h.img, ...opt.img] };
}

// ---- screenshots: a Temp file can be cleaned, so every image the text names is copied at once ----
const EXT = /\.(?:png|jpe?g|gif|webp|heic|bmp)(?![\w])/gi;
const START = /(?<![^\s"'(\[=<])(?:[A-Za-z]:[\\/]|\/)/g;
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
// A Git Bash path (/c/Users/..) is tried as C:/Users/.. when it does not exist as written.
const found = (p) => [p, p.replace(/^\/([A-Za-z])\//, '$1:/')].find(isFile);
// Paths in the text: from each start, the growing prefixes up to an image extension (spaces and parentheses
// belong to a path); the first that exists wins, else the shortest is a miss.
function imagesIn(text) {
  const seen = [];
  for (const line of text.split('\n')) {
    const ends = [...line.matchAll(EXT)].map((m) => m.index + m[0].length);
    let from = 0;
    for (const m of line.matchAll(START)) {
      if (m.index < from) continue;
      const cands = ends.filter((e) => e > m.index && e - m.index < 300);
      if (!cands.length) continue;
      const hit = cands.find((e) => found(line.slice(m.index, e)));
      const e = hit ?? cands[0];
      seen.push(line.slice(m.index, e));
      from = e;
    }
  }
  return seen;
}
function copyImgs(dir, nn, text, extra, k0 = 0) {
  mkdirSync(join(dir, 'img'), { recursive: true });
  const all = [...new Set([...imagesIn(text), ...extra])], got = new Map(), missed = [], out = [];
  for (const p of all) {
    const f = found(p);
    if (!f) { missed.push(p); continue; }
    if (got.has(resolve(f))) continue;
    const rel = `img/${nn}-${k0 + got.size + 1}${extname(f).toLowerCase()}`;
    copyFileSync(f, join(dir, rel));
    got.set(resolve(f), rel);
    out.push(`img: ${rel} (from ${p})`);
  }
  return { out, seen: all.length, copied: got.size, missed };
}

function add(dir, opt) {
  const x = readInput(opt);
  ensureIndex(dir);
  const norm = (s) => one(s).toLowerCase();
  const dup = items(dir).find((i) => existsSync(join(dir, `${i.nn}.md`)) && norm(textOf(join(dir, `${i.nn}.md`))) === norm(x.text));
  let nn; // wx: two adds at once cannot take one number
  for (let n = nextNn(dir); ; n++) {
    try { writeFileSync(join(dir, `${pad(n)}.md`), '', { flag: 'wx' }); nn = pad(n); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const im = copyImgs(dir, nn, x.text, x.img);
  const head = [`# ${nn}`, `time: ${new Date().toISOString()}`, 'status: open'];
  if (x.where) head.push(`where: ${one(x.where)}`);
  head.push(...im.out);
  if (x.reading) head.push(`reading (the chat's, not the person's): ${one(x.reading)}`);
  writeFileSync(join(dir, `${nn}.md`), `${head.join('\n')}\n\n${quote(x.text)}\n`);
  appendFileSync(indexOf(dir), `${fmt({ nn, status: 'open', title: title(x.reading ?? x.text.split('\n').find((l) => l.trim()) ?? ''), flags: x.flag.join(', ').replaceAll('|', '/') })}\n`);
  if (opt.from && resolve(opt.from).startsWith(resolve(dir, 'inbox'))) rmSync(opt.from, { force: true });
  console.log(`${nn} chars=${x.text.length} img=${im.copied}/${im.seen}${im.missed.length ? ` missed: ${im.missed.join(', ')}` : ''} where=${x.where ? one(x.where) : '-'}${dup ? ` dup=${dup.nn}` : ''}`);
}

// ---- status and its evidence ----
function evidenceOk(st, ev) {
  ev = one(ev);
  if (st === 'dropped') return ev !== '';
  if (st === 'partial' && !/(left|осталось):\s*\S/i.test(ev)) return false;
  const path = ev.split(' ').some((t) => { const p = t.replace(/:\d+(?:[-,]\d+)*$/, '').replace(/^["'(]|["'),.;]$/g, ''); return /[\\/.]/.test(p) && existsSync(p); });
  return path || ev.split(' ').length >= 3;
}
const WHY = { partial: 'partial needs "<what is done>; left: <what is not>"', dropped: 'dropped needs the reason' };
function status(dir, nn, st, ev, force = false) {
  nn = pad(+nn);
  st = st.replace('->', '→').replace(/^merged-(\d+)$/, 'merged→$1');
  const m = /^merged→(\d+)$/.exec(st);
  if (m) st = `merged→${pad(+m[1])}`;
  if (st !== 'open' && !FINAL.test(st)) die(`"${st}" is not open, done, partial, not-done, dropped or merged→NN`);
  if (m && !existsSync(join(dir, `${pad(+m[1])}.md`))) die(`merged target ${pad(+m[1])} does not exist`);
  if (m && pad(+m[1]) === nn) die('an item cannot merge into itself');
  if (!force && st !== 'open' && !m && !evidenceOk(st, ev)) die(`${st} needs evidence: an existing path (file:line) or at least three words${WHY[st] ? `; ${WHY[st]}` : ''}`);
  const its = items(dir), it = its.find((i) => i.nn === nn);
  if (!it) die(`no item ${nn}`);
  it.status = st;
  writeIndex(dir, firstLine(dir), its);
  const f = join(dir, `${nn}.md`), line = `status: ${st}${one(ev) ? ` | ${one(ev)}` : ''}`, body = read(f);
  writeFileSync(f, /^status:.*$/m.test(body) ? body.replace(/^status:.*$/m, () => line) : body.replace('\n', () => `\n${line}\n`));
}

// What stops a report: items not final (or final without proof), then stray files, then an unreleased index.
function problems(dir) {
  const its = items(dir), bad = [], strays = [], by = Object.fromEntries(its.map((i) => [i.nn, i]));
  for (const i of its) {
    const f = join(dir, `${i.nn}.md`), tag = `${i.nn} ${i.status}: ${i.title}`;
    if (!existsSync(f)) { bad.push(`${i.nn} has no ${i.nn}.md: ${i.title}`); continue; }
    const m = /^status: (\S+)(?: \| (.*))?$/m.exec(read(f));
    if (!FINAL.test(i.status)) bad.push(tag);
    else if (!m || m[1] !== i.status) bad.push(`${i.nn} index says ${i.status}, ${i.nn}.md says ${m?.[1] ?? 'nothing'}: ${i.title}`);
    else if (i.status.startsWith('merged')) {
      const t = by[i.status.split('→')[1]];
      if (!t) bad.push(`${i.nn} merges into a missing item: ${i.title}`);
      else if (!FINAL.test(t.status) || t.status.startsWith('merged')) bad.push(`${i.nn} merges into ${t.nn}, which is ${t.status} (a merge needs a final, unmerged target): ${i.title}`);
    } else if (!evidenceOk(i.status, m[2] ?? '')) bad.push(`${tag} (evidence missing or too thin${WHY[i.status] ? `; ${WHY[i.status]}` : ''})`);
  }
  for (const n of files(dir)) if (!by[n]) strays.push(`${n}.md is not in index.md`);
  const open = firstLine(dir).startsWith('released') ? [] : [`index.md still reads "${firstLine(dir)}": run release`];
  return { its, bad, strays, open };
}
function check(dir) {
  const { its, bad, strays, open } = problems(dir);
  const all = [...(its.length ? [] : ['no items: nothing was recorded']), ...bad];
  if (all.length) console.log(all.join('\n'));
  if (strays.length) console.log(`strays:\n${strays.join('\n')}`);
  if (open.length) console.log(open.join('\n'));
  if (all.length || strays.length || open.length) { console.log(`${bad.length} of ${its.length} items not final`); process.exit(1); }
  console.log(`ok, ${its.length} items final`);
}

function release(dir, opt) {
  if (opt.drop !== undefined) for (const i of items(dir)) if (!FINAL.test(i.status)) status(dir, i.nn, 'not-done', opt.drop, true);
  const [, word = ''] = /^\S+ ?(.*)$/.exec(firstLine(dir)) ?? [];
  writeIndex(dir, `released${word ? ` ${word}` : ''}`, items(dir));
}

function edit(dir, nn, opt) {
  nn = pad(+nn);
  const f = join(dir, `${nn}.md`);
  if (!existsSync(f)) die(`no item ${nn}`);
  if (!opt.from) die('edit needs --from FILE with the new text');
  const x = readInput(opt), L = read(f).split('\n'), q = L.findIndex((l) => /^>( |$)/.test(l));
  if (q < 0) die(`${nn}.md has no quote block`);
  let head = L.slice(0, q);
  while (head.at(-1) === '') head.pop();
  const set = (re, line) => { const k = head.findIndex((l) => re.test(l)); if (k < 0) head.push(line); else head[k] = line; };
  set(/^status:/, 'status: open');
  if (x.where) set(/^where:/, `where: ${one(x.where)}`);
  if (x.reading) set(/^reading \(/, `reading (the chat's, not the person's): ${one(x.reading)}`);
  head.push(...copyImgs(dir, nn, x.text, x.img, head.filter((l) => l.startsWith('img:')).length).out);
  const old = L.slice(q).join('\n').replace(/\n+$/, '');
  writeFileSync(f, `${head.join('\n')}\n\n${quote(x.text)}\n\nprevious (replaced ${new Date().toISOString()}):\n${old}\n`);
  const its = items(dir), it = its.find((i) => i.nn === nn);
  if (it) { it.status = 'open'; if (x.reading) it.title = title(x.reading); if (x.flag.length) it.flags = x.flag.join(', ').replaceAll('|', '/'); writeIndex(dir, firstLine(dir), its); }
  if (resolve(opt.from).startsWith(resolve(dir, 'inbox'))) rmSync(opt.from, { force: true });
  console.log(`${nn} edited chars=${x.text.length}`);
}

function carry(dir, src, all) {
  const from = /[\\/]/.test(src) ? resolve(src) : join(root, src);
  if (!existsSync(indexOf(from))) die(`no hold at ${from}`);
  if (resolve(from) === resolve(dir)) die('a hold cannot carry itself');
  ensureIndex(dir, firstLine(from).split(' ')[1] ?? 'абрикос');
  const tag = basename(from);
  if (files(dir).some((n) => new RegExp(`^carried: ${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, 'm').test(read(join(dir, `${n}.md`))))) die(`already carried from ${tag}`);
  const rank = { 'not-done': 0, partial: 1, open: 2 };
  const old = items(from).filter((i) => all || rank[i.status] !== undefined);
  old.sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || +a.nn - +b.nn);
  const map = [];
  for (const i of old) {
    const nn = pad(nextNn(dir));
    const body = read(join(from, `${i.nn}.md`)).split('\n').flatMap((l) => {
      if (l.startsWith('# ')) return [`# ${nn}`];
      if (/^status:/.test(l)) return ['status: open', `carried: ${tag}/${i.nn}`, `previous-status: ${l.slice(8)}`];
      const im = /^img: img\/\d+-(\d+)(\.\w+)/.exec(l);
      if (!im) return [l];
      const s = readdirSync(join(from, 'img')).find((f) => f.startsWith(`${i.nn}-${im[1]}.`));
      mkdirSync(join(dir, 'img'), { recursive: true });
      if (s) copyFileSync(join(from, 'img', s), join(dir, 'img', `${nn}-${im[1]}${im[2]}`));
      return [l.replace(/^img: img\/\d+-/, `img: img/${nn}-`)];
    }).join('\n');
    writeFileSync(join(dir, `${nn}.md`), body);
    appendFileSync(indexOf(dir), `${fmt({ nn, status: 'open', title: i.title, flags: i.flags })}\n`);
    map.push(`${tag}/${i.nn}→${nn}`);
  }
  console.log(`carried ${old.length} of ${items(from).length}${map.length ? `\n${map.join('\n')}` : ''}`);
}

// The newest earlier folder of this project whose check fails: what "carry over" refers to.
function last(opt) {
  const cur = dirFor(opt, true), proj = existsSync(join(cur, 'project.txt')) ? read(join(cur, 'project.txt')).trim() : process.cwd();
  if (!existsSync(root)) return;
  const unfinished = (p) => { const { bad, open } = problems(p); return bad.length || open.length; };
  const c = readdirSync(root).map((e) => join(root, e)).filter((p) => resolve(p) !== resolve(cur) && existsSync(indexOf(p)) && existsSync(join(p, 'project.txt')) && read(join(p, 'project.txt')).trim() === proj)
    .filter((p) => items(p).length && unfinished(p)).sort((a, b) => statSync(indexOf(b)).mtimeMs - statSync(indexOf(a)).mtimeMs)[0];
  if (c) console.log(`${fwd(c)} (${problems(c).bad.length} items not final)`);
}

// A lone `collecting` line is what a forked session leaves behind. Younger than a day may be live (the hooks use the same day).
function clean() {
  if (!existsSync(root)) { console.log('nothing to clean'); return; }
  const lone = (f) => { const l = lines(read(f)); return l.length === 1 && /^collecting(\s|$)/.test(l[0]); };
  let n = 0;
  for (const e of readdirSync(root)) {
    const p = join(root, e), st = statSync(p);
    let dead = false, at = p;
    if (st.isFile()) dead = e.endsWith('.md') && lone(p);
    else {
      const names = readdirSync(p).filter((x) => !(['img', 'inbox'].includes(x) && readdirSync(join(p, x)).length === 0) && x !== 'project.txt');
      dead = names.length === 1 && names[0] === 'index.md' && lone(join(p, 'index.md'));
      at = join(p, 'index.md');
    }
    if (dead && Date.now() - statSync(at).mtimeMs > DAY) { rmSync(p, { recursive: true, force: true }); console.log(`removed ${p}`); n++; }
  }
  if (!n) console.log('nothing to clean');
}

const { pos, opt } = parse(argv);
const verb = pos.shift();
const need = (k) => pos.length >= k || die(`${verb} needs ${k} argument(s); see the header of hold.mjs`);
switch (verb) {
  case 'init': { const d = dirFor(opt);
    // shortcut: minute resolution, a second archive in the same minute gets a -2 suffix only once; upgrade if holds are released that fast
    if (existsSync(indexOf(d)) && firstLine(d).startsWith('released')) { const t = new Date(), s = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}`; renameSync(d, existsSync(`${d}-${s}`) ? `${d}-${s}-2` : `${d}-${s}`); }
    ensureIndex(d, pos[0]); mkdirSync(join(d, 'inbox'), { recursive: true });
    if (!existsSync(join(d, 'project.txt'))) writeFileSync(join(d, 'project.txt'), `${process.cwd()}\n`);
    console.log(fwd(d)); break; }
  case 'dir': console.log(fwd(dirFor(opt))); break;
  case 'add': add(dirFor(opt), opt); break;
  case 'status': need(2); status(dirFor(opt), pos[0], pos[1], pos.slice(2).join(' ')); break;
  case 'edit': need(1); edit(dirFor(opt), pos[0], opt); break;
  case 'drop': need(2); status(dirFor(opt), pos[0], 'dropped', pos.slice(1).join(' ')); break;
  case 'check': check(dirFor(opt)); break;
  case 'release': release(dirFor(opt), opt); break;
  case 'carry': need(1); carry(dirFor(opt), pos[0], opt.all); break;
  case 'last': last(opt); break;
  case 'clean': clean(); break;
  default: die('verbs: init dir add status edit drop check release carry last clean');
}
