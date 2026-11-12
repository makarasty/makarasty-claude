#!/usr/bin/env node
// hold-selftest.mjs - every verb of hold.mjs against a temporary config dir. No network, a few seconds.
//   node tools/skills/hold/hold-selftest.mjs
// Exit 0 = every check passed. Exit 1 = at least one failed; the failing line names what it wanted.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const hold = join(resolve(import.meta.dirname), 'hold.mjs');
const tmp = join(tmpdir(), `hold-selftest-${process.pid}`);
const cfg = join(tmp, 'cfg'), root = join(cfg, 'makarasty', 'hold');
mkdirSync(tmp, { recursive: true });
let pass = 0, fail = 0;
const envFor = (env) => { const e = { ...process.env, CLAUDE_CONFIG_DIR: cfg, ...env }; for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k]; return e; };
const base = { CLAUDE_CODE_SESSION_ID: undefined, CLAUDE_SESSION_ID: undefined, MSYSTEM: undefined }; // the Git Bash undo is tested on its own
// Old checks predate `means:`: a status call first gives the item a plain one, so they test what they tested.
const run = (args, input = '', env = {}) => {
  const k = args.indexOf('status'), sid = args[args.indexOf('--sid') + 1];
  if (k >= 0 && sid && args[k + 1] && existsSync(join(env.CLAUDE_CONFIG_DIR ?? cfg, 'makarasty', 'hold', sid, `${String(+args[k + 1]).padStart(2, '0')}.md`)) && !/^means:/m.test(read(join(env.CLAUDE_CONFIG_DIR ?? cfg, 'makarasty', 'hold', sid, `${String(+args[k + 1]).padStart(2, '0')}.md`)))) run(['--sid', sid, 'means', args[k + 1], 'plain test means'], '', env);
  const r = spawnSync(process.execPath, [hold, ...args], { input, encoding: 'utf8', env: envFor({ ...base, ...env }) });
  return { out: r.stdout.replace(/\n+$/, ''), err: r.stderr, code: r.status ?? 128 };
};
const H = (sid, args, input) => run(['--sid', sid, ...args], input);
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const D = (sid) => join(root, sid);
const F = (p) => p.replaceAll('\\', '/'); // init and dir print forward slashes
function t(name, ok, got = '') { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}\n        got: ${String(got).split('\n').join('|').slice(0, 400)}`); } }
const draft = (sid, name, body) => { mkdirSync(join(D(sid), 'inbox'), { recursive: true }); const p = join(D(sid), 'inbox', name); writeFileSync(p, body); return p; };
const quoted = (f) => read(f).split('\n\n').slice(1).join('\n\n').replace(/\n$/, '').split('\n').map((l) => l.replace(/^> ?/, '')).join('\n');
const png = (p, data = 'PNG') => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, data); return p; };
// A hold with the given texts, released, every item finalised unless told otherwise.
function quick(sid, texts) { H(sid, ['init']); for (const x of texts) H(sid, ['add'], x); return D(sid); }

// 1. which folder: the id is resolved by the script, the hold root is never a hold
console.log('folder');
let r = H('a1', ['init', 'апельсин']);
t('--sid makes hold/<sid>/ and prints it', r.out === F(D('a1')) && read(join(D('a1'), 'index.md')) === 'collecting апельсин\n' && existsSync(join(D('a1'), 'inbox')), r.out + r.err);
t('CLAUDE_CODE_SESSION_ID is used without --sid', run(['dir'], '', { CLAUDE_CODE_SESSION_ID: 'envsid' }).out === F(D('envsid')));
t('no id at all is refused', run(['dir']).code === 1);
t('an unsubstituted ${CLAUDE_SESSION_ID} is not an id; the env one is used', run(['--sid', '${CLAUDE_SESSION_ID}', 'dir'], '', { CLAUDE_CODE_SESSION_ID: 'envsid' }).out === F(D('envsid')));
t('an unsubstituted id with no env is refused', run(['--sid', '${CLAUDE_SESSION_ID}', 'dir']).code === 1);
t('an empty --sid is refused', run(['--sid', '', 'dir']).code === 1);
t('the hold root is refused', run(['--dir', root, 'add'], 'x').code === 1 && !existsSync(join(root, 'index.md')));
H('a2', ['init']); H('a2', ['add'], 'only in a2');
t('two sessions do not share a list', !read(join(D('a1'), 'index.md')).includes('only in a2') && read(join(D('a2'), 'index.md')).includes('only in a2'));

// 2. add from a file: argv carries no item text; a terminator word, $(), backticks, quotes survive
console.log('add');
const shot = png(join(tmp, 'shot.png'), 'PNGDATA');
const body = `Здесь $(rm -rf x) \`ls\` "кот" it's вместо «код»\nHOLD\necho pwned\n\nвторой абзац, div.orders > table\nскрин ${shot}`;
const p1 = draft('m', '1.md', `where: /patients\nreading: кот вместо код\nflag: ? "кот"\nflag: + to 02\n---\n${body}\n`);
H('m', ['init', 'апельсин']);
r = H('m', ['add', '--from', p1]);
t('add prints NN, chars, img copied/seen and where', r.out === `01 chars=${body.length} img=1/1 where=/patients`, r.out + r.err);
const f1 = read(join(D('m'), '01.md'));
t('the text is stored verbatim, terminator word and shell syntax included', quoted(join(D('m'), '01.md')) === body, quoted(join(D('m'), '01.md')));
t('where is stored exactly (no Git Bash path conversion), the reading is labelled apart', /^where: \/patients$/m.test(f1) && /^reading \(the chat's, not the person's\): кот вместо код$/m.test(f1) && /^time: \d{4}-/m.test(f1), f1);
t('the screenshot is copied into img/01-1.png', read(join(D('m'), 'img', '01-1.png')) === 'PNGDATA' && /^img: img\/01-1\.png/m.test(f1));
t('the index line carries both flags', read(join(D('m'), 'index.md')).includes('01 | open | кот вместо код | ? "кот", + to 02'), read(join(D('m'), 'index.md')));
t('the inbox draft is removed after add', !existsSync(p1));
const long = Array.from({ length: 80 }, (_, i) => `строка ${i} с много слов подряд`).join('\n');
t('add on stdin (the fallback) takes a long paste whole', H('m', ['add'], long).out.startsWith('02 chars=') && quoted(join(D('m'), '02.md')) === long);
r = H('m', ['add'], long);
t('an identical text is flagged dup=02', r.out.endsWith('dup=02'), r.out);
t('empty text is refused', H('m', ['add'], '').code === 1 && H('m', ['add'], '---\n').code === 1);
t('a text with --- in the middle and no header is kept whole', quoted((H('m', ['add'], 'one\n---\ntwo'), join(D('m'), '04.md'))) === 'one\n---\ntwo');
r = H('m', ['add'], `reading: ${'слово '.repeat(30)}\n---\nx`);
t('a long title is cut on a word boundary', /04|05/.test(r.out) && read(join(D('m'), 'index.md')).split('\n').at(-2).split(' | ')[2].replace(/ \|$/, '').endsWith('слово…'), read(join(D('m'), 'index.md')));
t('add recreates a missing index', (rmSync(join(D('r1'), 'x'), { force: true }), H('r1', ['add'], 'x').out.startsWith('01 ') && read(join(D('r1'), 'index.md')).startsWith('collecting')));

// 3. screenshots: spaces, parentheses, Git Bash form, more extensions, misses reported
console.log('images');
const sp = png(join(tmp, 'my shots (1)', 'Screen Shot (2).png'), 'SP');
const jp = png(join(tmp, 'p.jpeg'), 'JP'), hc = png(join(tmp, 'q.HEIC'), 'HC'), bm = png(join(tmp, 'r.bmp'), 'BM');
const gone = join(tmp, 'deleted', 'gone.png');
H('i', ['init']);
r = H('i', ['add'], `вот (${sp}) и ${jp}, ${hc} ещё ${bm}\nа это ${gone} уже нет`);
t('spaces and parentheses, .jpeg, .heic, .bmp are copied; the miss is named', r.out.includes('img=4/5') && r.out.includes(`missed: ${gone}`), r.out);
t('the copies carry the content and the lowercase extension', read(join(D('i'), 'img', '01-1.png')) === 'SP' && read(join(D('i'), 'img', '01-4.bmp')) === 'BM' && read(join(D('i'), 'img', '01-3.heic')) === 'HC', '');
if (process.platform === 'win32') {
  const gb = '/' + shot[0].toLowerCase() + shot.slice(2).replaceAll('\\', '/');
  r = H('i', ['add'], `Git Bash вид ${gb}`);
  t('a Git Bash /c/... path is converted', r.out.includes('img=1/1'), r.out);
}

// 4. status and check
console.log('status and check');
t('check on a hold with no items fails', H('a1', ['check']).code === 1 && H('a1', ['check']).out.includes('no items'));
H('m', ['release']);
r = H('m', ['check']);
t('check fails and lists open items', r.code === 1 && r.out.includes('01 open') && r.out.includes('02 open'), r.out);
t('an unknown status is refused', H('m', ['status', '01', 'fixed', 'one two three']).code === 1);
t('done with thin evidence (one word that is no path) is refused', H('m', ['status', '01', 'done', 'src/nope.css:12']).code === 1);
t('a screen item (it has img:) is not done on words alone', H('m', ['status', '01', 'done', 'fixed', 'in', 'the shared table style']).code === 1);
png(join(D('m'), 'img', '01-after.png'));
t('a screen item is not done with an after-shot but no judge', H('m', ['status', '01', 'done', 'img/01-after.png fixed it']).code === 1);
writeFileSync(join(D('m'), 'img', '01-after.png'), read(join(D('m'), 'img', '01-1.png')));
t('a copy of the before-shot is not an after-shot', H('m', ['status', '01', 'done', 'img/01-after.png judge: opus-eye fixed it']).code === 1);
png(join(D('m'), 'img', '01-after.png'));
t('a screen item is done with its after-shot and a judge',H('m', ['status', '01', 'done', 'fixed in the shared table style; img/01-after.png judge: opus-eye']).code === 0);
t('done with an existing path (file:line) is accepted', H('m', ['status', '02', 'done', `${hold}:12`]).code === 0);
t('partial without a "left:" part is refused', H('m', ['status', '04', 'partial', 'header is done, footer is not']).code === 1);
t('partial with "left:" is accepted', H('m', ['status', '04', 'partial', 'header done; left: footer']).code === 0);
t('evidence that starts with -- is accepted after --', H('m', ['status', '03', 'not-done', '--', '--flag is parsed as option here']).code === 0);
t('merge into a missing item is refused', H('m', ['status', '05', 'merged→09']).code === 1);
t('merge into itself is refused', H('m', ['status', '05', 'merged→05']).code === 1);
t('merged->N is stored padded as merged→0N', H('m', ['status', '05', 'merged->2']).code === 0 && read(join(D('m'), 'index.md')).includes('05 | merged→02 |'), read(join(D('m'), 'index.md')));
t('check passes when all are final and the index is released', H('m', ['check']).code === 0, H('m', ['check']).out);
t('status lands in the item file and the index', /^status: done \| fixed in the shared table style; img\/01-after\.png judge: opus-eye$/m.test(read(join(D('m'), '01.md'))) && /^01 \| done \|/m.test(read(join(D('m'), 'index.md'))));
r = (writeFileSync(join(D('m'), '09.md'), '# 09\n'), H('m', ['check']));
t('a stray item file is listed under strays, apart from the items', r.code === 1 && r.out.includes('strays:\n09.md is not in index.md') && !/^09 /m.test(r.out), r.out);
rmSync(join(D('m'), '09.md'));
H('c1', ['init']); H('c1', ['add'], 'a'); H('c1', ['add'], 'b'); H('c1', ['add'], 'c');
H('c1', ['status', '02', 'done', 'one two three']); H('c1', ['status', '01', 'merged→02']); H('c1', ['status', '03', 'merged→01']);
H('c1', ['release']);
r = H('c1', ['check']);
t('a merge whose target is itself merged is refused (no chains, no cycles)', r.code === 1 && /03 merges into 01/.test(r.out), r.out);
H('c2', ['init']); H('c2', ['add'], 'a'); H('c2', ['add'], 'b'); H('c2', ['status', '01', 'merged→02']); H('c2', ['release']);
t('a merge into an unfinished target is refused by check', /01 merges into 02/.test(H('c2', ['check']).out));
H('c3', ['init']); H('c3', ['add'], 'a'); H('c3', ['status', '01', 'done', 'one two three']);
t('a hold still reading collecting fails check', H('c3', ['check']).out.includes('still reads'));

// 5. edit, drop, release --drop
console.log('edit, drop, release --drop');
H('e', ['init']); H('e', ['add'], 'старый текст'); H('e', ['add'], 'второй'); H('e', ['add'], 'третий'); H('e', ['add'], 'четвёртый');
const pe = draft('e', 'e.md', 'reading: новый смысл\n---\nновый текст\nв две строки');
r = H('e', ['edit', '1', '--from', pe]);
const fe = read(join(D('e'), '01.md'));
t('edit replaces the text and keeps the old one as previous', quoted(join(D('e'), '01.md')).startsWith('новый текст\nв две строки') && /previous \(replaced [^)]+\):\n> старый текст/.test(fe), fe);
t('edit updates the index title and resets the status', read(join(D('e'), 'index.md')).includes('01 | open | новый смысл |'));
t('drop marks the item dropped with the reason, and needs one', H('e', ['drop', '2', 'человек убрал пункт']).code === 0 && /02 \| dropped \|/.test(read(join(D('e'), 'index.md'))) && H('e', ['drop', '3']).code === 1);
t('release --drop marks every unfinished item not-done with the reason', H('e', ['release', '--drop', 'сессия закрыта, не делали']).code === 0 && /01 \| not-done \|/.test(read(join(D('e'), 'index.md'))) && /^status: not-done \| сессия закрыта, не делали$/m.test(read(join(D('e'), '03.md'))) && read(join(D('e'), 'index.md')).startsWith('released') && /02 \| dropped \|/.test(read(join(D('e'), 'index.md'))));
t('a dropped item passes check', H('e', ['check']).code === 0, H('e', ['check']).out);

// 6. carry
console.log('carry');
H('o', ['init', 'абрикос']);
const s2 = png(join(tmp, 's2.png'), 'IMG2');
H('o', ['add', '--reading', 'первый'], 'один'); H('o', ['add', '--reading', 'второй'], `два ${s2}`); H('o', ['add', '--reading', 'третий'], 'три'); H('o', ['add', '--reading', 'четвёртый'], 'четыре');
H('o', ['status', '01', 'done', 'a.ts b.ts c.ts']); H('o', ['status', '02', 'not-done', 'причина', 'была', 'неверной']); H('o', ['status', '03', 'partial', 'шапка готова; left: подвал']);
H('o', ['release']);
r = H('n', ['carry', 'o']);
t('carry takes only unfinished items and prints old→new', r.out.startsWith('carried 3 of 4') && r.out.includes('o/02→01') && r.out.includes('o/03→02') && r.out.includes('o/04→03'), r.out + r.err);
const idx = read(join(D('n'), 'index.md'));
t('the new hold collects again with the old codeword; not-done first, then partial, then open', idx.startsWith('collecting абрикос\n') && /01 \| open \| второй[\s\S]*02 \| open \| третий[\s\S]*03 \| open \| четвёртый/.test(idx), idx);
const n1 = read(join(D('n'), '01.md'));
t('the carried item names its source and keeps the old status line whole', /^carried: o\/02$/m.test(n1) && /^previous-status: not-done \| причина была неверной$/m.test(n1) && n1.includes('> два'), n1);
t('the screenshot is copied and renumbered', read(join(D('n'), 'img', '01-1.png')) === 'IMG2' && n1.includes('img/01-1.png'));
t('the old folder is untouched', read(join(D('o'), 'index.md')).includes('01 | done |'));
t('the same source cannot be carried twice', H('n', ['carry', 'o']).code === 1 && read(join(D('n'), 'index.md')) === idx);
t('--all takes finished items too', H('n2', ['carry', 'o', '--all']).out.startsWith('carried 4 of 4'));
t('carry accepts a folder path', H('n3', ['carry', D('o')]).out.startsWith('carried 3 of 4'));

// 7. last: its own config dir, so the folders above do not count
console.log('last');
const ago0 = (h) => new Date(Date.now() - h * 3600000);
const R2 = (sid, args, input) => run(['--sid', sid, ...args], input, { CLAUDE_CONFIG_DIR: join(tmp, 'cfg2') });
const d2 = (sid) => join(tmp, 'cfg2', 'makarasty', 'hold', sid);
R2('lp', ['init']); R2('lp', ['add'], 'висит');
R2('lq', ['init']);
t('last names the earlier folder of this project that fails check', R2('lq', ['last']).out.startsWith(F(d2('lp'))), R2('lq', ['last']).out);
t('last is silent with nothing earlier', R2('lp', ['last']).out === '');
R2('lp', ['status', '01', 'done', 'one two three']); R2('lp', ['release']);
t('last is silent once every item of that folder is done', R2('lq', ['last']).out === '', R2('lq', ['last']).out);

// a properly closed hold (released, check passes) with a partial item is offered until it is carried
const R3 = (sid, args, input) => run(['--sid', sid, ...args], input, { CLAUDE_CONFIG_DIR: join(tmp, 'cfg3') });
const d3 = (sid) => join(tmp, 'cfg3', 'makarasty', 'hold', sid);
R3('c1', ['init']); R3('c1', ['add'], 'первое'); R3('c1', ['add'], 'второе');
R3('c1', ['status', '01', 'partial', 'шапка готова; left: подвал']); R3('c1', ['status', '02', 'done', 'one two three']); R3('c1', ['release']);
R3('c9', ['init']);
t('last offers a released folder whose check passes but has a partial item', R3('c1', ['check']).code === 0 && R3('c9', ['last']).out.startsWith(F(d3('c1'))), R3('c9', ['last']).out);
mkdirSync(join(tmp, 'cfg3', 'sessions'), { recursive: true });
writeFileSync(join(tmp, 'cfg3', 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'c1', cwd: tmp }));
t('a live chat does not hide its released folder', R3('c9', ['last']).out.startsWith(F(d3('c1'))), R3('c9', ['last']).out);
R3('c4', ['init']); R3('c4', ['add'], 'ещё собирается');
writeFileSync(join(tmp, 'cfg3', 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'c4', cwd: tmp }));
t('but a live chat still collecting is skipped', R3('c9', ['last']).out.startsWith(F(d3('c1'))) && !R3('c9', ['last']).out.includes('/c4'), R3('c9', ['last']).out);
R3('c5', ['init']); R3('c5', ['add'], 'первое'); R3('c5', ['add'], 'второе'); R3('c5', ['status', '01', 'partial', 'шапка готова; left: подвал']); R3('c5', ['release']);
writeFileSync(join(tmp, 'cfg3', 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'c5', cwd: tmp }));
t('a live chat that still has open items in its released folder is fixing them: skipped', !R3('c9', ['last']).out.includes('/c5'), R3('c9', ['last']).out);
rmSync(join(tmp, 'cfg3', 'sessions'), { recursive: true, force: true });
t('without a live chat that released folder is offered', R3('c9', ['last']).out.startsWith(F(d3('c5'))), R3('c9', ['last']).out);
rmSync(join(d3('c9'), 'rules2')); rmSync(join(d3('c9'), 'project.txt')); // carry must make them itself
R3('c9', ['carry', 'c1']);
t('once carried, last does not offer that folder again', !R3('c9', ['last']).out.includes(`${F(d3('c1'))} (`), R3('c9', ['last']).out);
t('carry into a folder with no rules2 and no project.txt writes both', existsSync(join(d3('c9'), 'rules2')) && read(join(d3('c9'), 'project.txt')).trim() !== '', '');
t('the same source cannot be carried into the same folder twice', R3('c9', ['carry', 'c1']).code === 1);
// init renames a released folder: the marker lives inside it, so the archive stays carried and the new <sid> is not
renameSync(d3('c1'), `${d3('c1')}-20260101-0000`);
R3('c1', ['init']); R3('c1', ['add'], 'новое под тем же id');
t('a renamed carried folder is not offered again, the new folder of that id is not "carried"', R3('c9', ['last']).out.startsWith(`${F(d3('c1'))} (`) && !R3('c9', ['last']).out.includes('c1-20260101'), R3('c9', ['last']).out);

// a newer finished folder does not hide an older unfinished one
R2('ls', ['init']); R2('ls', ['add'], 'старое, не доделано');
R2('lt', ['init']); R2('lt', ['add'], 'новое'); R2('lt', ['status', '01', 'done', 'one two three']); R2('lt', ['release']);
utimesSync(join(d2('ls'), 'index.md'), ago0(2), ago0(2));
R2('lu', ['init']);
t('last skips a newer finished folder and names the older unfinished one', R2('lu', ['last']).out.startsWith(F(d2('ls'))), R2('lu', ['last']).out);

// a live chat's folder is not "earlier": last skips it (its session file names a running pid)
R2('lv', ['init']); R2('lv', ['add'], 'идёт в другом чате');
R2('lw', ['init']);
t('last names lv while no live chat owns it', R2('lw', ['last']).out.startsWith(F(d2('lv'))), R2('lw', ['last']).out);
mkdirSync(join(tmp, 'cfg2', 'sessions'), { recursive: true });
writeFileSync(join(tmp, 'cfg2', 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'lv', cwd: tmp }));
t('last skips a folder whose chat is live', !R2('lw', ['last']).out.includes('/lv'), R2('lw', ['last']).out);
mkdirSync(join(tmp, 'cfg2', 'projects', 'p'), { recursive: true });
writeFileSync(join(tmp, 'cfg2', 'projects', 'p', 'lv.jsonl'), JSON.stringify({ type: 'user', timestamp: ago0(5).toISOString(), message: { content: 'x' } }) + '\n');
t('and one whose chat is open but idle for hours (its process still runs)', !R2('lw', ['last']).out.includes('/lv'), R2('lw', ['last']).out);
rmSync(join(tmp, 'cfg2', 'sessions'), { recursive: true, force: true });
rmSync(join(tmp, 'cfg2', 'projects'), { recursive: true, force: true });

// 7b. a second hold in one session after release starts fresh; the first is archived
console.log('second hold');
H('rr', ['init', 'слово']); H('rr', ['add'], 'первый пункт'); H('rr', ['release']);
r = H('rr', ['init', 'новое']);
const arch = readdirSync(root).filter((e) => /^rr-\d{8}-\d{4}(-2)?$/.test(e));
t('init after release archives the folder as <sid>-<YYYYMMDD-HHMM>', arch.length === 1 && read(join(root, arch[0], 'index.md')).startsWith('released слово') && r.out === F(D('rr')), r.out + arch);
t('and starts a fresh collecting folder with the new word', read(join(D('rr'), 'index.md')) === 'collecting новое\n' && !existsSync(join(D('rr'), '01.md')));
t('init on a folder still collecting keeps it', H('rr', ['init', 'другое']).code === 0 && read(join(D('rr'), 'index.md')) === 'collecting новое\n');
t('carry reads the archived folder by its name', H('rr', ['carry', arch[0]]).out.startsWith('carried 1 of 1'), H('rr', ['carry', arch[0]]).out);

// 8. clean: a day, not an hour; real holds and old-format lists stay
console.log('clean');
const cr = join(cfg, 'makarasty', 'hold');
mkdirSync(join(cr, 'stray1', 'img'), { recursive: true }); writeFileSync(join(cr, 'stray1', 'index.md'), 'collecting абрикос\n');
writeFileSync(join(cr, 'stray2.md'), 'collecting абрикос\n');
mkdirSync(join(cr, 'hour'), { recursive: true }); writeFileSync(join(cr, 'hour', 'index.md'), 'collecting абрикос\n');
writeFileSync(join(cr, 'old-list.md'), 'released абрикос\n1. пункт\n');
const ago = (h) => new Date(Date.now() - h * 3600000);
for (const p of [join(cr, 'stray1', 'index.md'), join(cr, 'stray2.md'), join(cr, 'old-list.md')]) utimesSync(p, ago(30), ago(30));
utimesSync(join(cr, 'hour', 'index.md'), ago(2), ago(2));
r = run(['clean']);
t('clean removes a folder and a file holding only a collecting line older than a day', !existsSync(join(cr, 'stray1')) && !existsSync(join(cr, 'stray2.md')), r.out);
t('clean keeps one a few hours old (it may be live), a real hold and an old-format list', existsSync(join(cr, 'hour')) && existsSync(join(D('m'), 'index.md')) && existsSync(join(cr, 'old-list.md')), r.out);

// 9. parallel add: no two items take one number
console.log('parallel');
H('par', ['init']);
const adds = Array.from({ length: 8 }, (_, k) => new Promise((done) => {
  const c = spawn(process.execPath, [hold, '--sid', 'par', 'add'], { env: envFor(base) });
  let out = ''; c.stdout.on('data', (d) => { out += d; });
  c.on('close', () => done(out.slice(0, 2)));
  c.stdin.end(`item ${k}`);
}));
const nums = await Promise.all(adds);
const texts = nums.map((n) => quoted(join(D('par'), `${n}.md`)));
t('eight simultaneous adds get eight distinct numbers and keep their own text', new Set(nums).size === 8 && new Set(texts).size === 8 && texts.every((x) => /^item \d$/.test(x)), nums.join(','));

// 10. Git Bash path conversion, a killed add, a long title
console.log('windows and crashes');
const gitEnv = { MSYSTEM: 'MINGW64', EXEPATH: 'C:\\Program Files\\Git\\bin' };
const G = (sid, args, input) => run(['--sid', sid, ...args], input, gitEnv);
quick('msys', ['first item text here']);
G('msys', ['drop', '01', 'C:/Program Files/Git/settings/profile больше не нужен']);
t('a /route Git Bash turned into C:/Program Files/Git/route is stored as /route', /status: dropped \| \/settings\/profile больше/.test(read(join(D('msys'), '01.md'))), read(join(D('msys'), '01.md')));
G('msys', ['add', '--where', 'C:/Program Files/Git/settings'], 'second');
t('--where gets the same undo', /^where: \/settings$/m.test(read(join(D('msys'), '02.md'))), read(join(D('msys'), '02.md')));
H('msys', ['drop', '02', 'C:/Program Files/Git/x without Git Bash']);
t('without MSYSTEM nothing is rewritten', /\| C:\/Program Files\/Git\/x/.test(read(join(D('msys'), '02.md'))), read(join(D('msys'), '02.md')));
writeFileSync(join(D('msys'), '03.md'), ''); utimesSync(join(D('msys'), '03.md'), ago(0.1), ago(0.1));
H('msys', ['release']);
r = H('msys', ['check']);
t('an empty NN.md left by a killed add is not a stray once a minute old', r.code === 0 && !/strays/.test(r.out), r.out);
writeFileSync(join(D('msys'), '04.md'), '');
t('a fresh empty NN.md (an add in progress) still counts', H('msys', ['check']).code === 1);
quick('emoji', ['😀'.repeat(70)]);
t('a title cut at 60 keeps whole emoji', !read(join(D('emoji'), 'index.md')).includes('\uFFFD'), read(join(D('emoji'), 'index.md')));
t('no temp index file is left behind', !readdirSync(D('msys')).some((f) => f.endsWith('.tmp')));
H('paths', ['init']);
let t0 = Date.now(); r = H('paths', ['add'], '/a.png '.repeat(4000));
t('a paste naming 4000 image paths is recorded in seconds, not minutes (a budget of file checks)', r.code === 0 && Date.now() - t0 < 5000, `${Date.now() - t0} ms ${r.err}`);

// 10b. closing table, means, scope, cover, came back
console.log('table, means, scope, cover, back');
{
  const P = (sid) => writeFileSync(join(D(sid), 'project.txt'), 'proj1\n');
  H('tb1', ['init']); P('tb1');
  H('tb1', ['add'], 'where: /orders\n---\nвсе таблицы без паддинга');
  H('tb1', ['add'], 'вторая мелочь');
  H('tb1', ['add'], 'третья мелочь');
  H('tb1', ['release']);
  const runDir = join(tmp, 'run1'); mkdirSync(join(runDir, 'tasks', 'ready'), { recursive: true });
  writeFileSync(join(runDir, 'tasks', 'ready', 't1.md'), '---\ntask-id: t1\n---\nhold: 01, 03\n');
  r = H('tb1', ['cover', runDir]);
  t('cover refuses while an item has no task and names it', r.code === 1 && r.out.includes('02 ') && !r.out.includes('03 '), r.out);
  writeFileSync(join(runDir, 'tasks', 'ready', 't2.md'), 'hold: 2\n');
  t('cover passes once every item is named', H('tb1', ['cover', runDir]).code === 0);
  H('tb1', ['drop', '3', 'человек убрал']);
  spawnSync(process.execPath, [hold, '--sid', 'tb1', 'status', '02', 'done', 'fixed in the shared place'], { env: envFor(base) }); // bypasses run(), which adds a means
  t('check wants a means: line for a done item', H('tb1', ['check']).out.includes('no means:'), H('tb1', ['check']).out);
  H('tb1', ['means', '2', 'second thing fixed in the shared place']);
  t('means is stored beside the status', /^means: second thing fixed/m.test(read(join(D('tb1'), '02.md'))));
  H('tb1', ['means', '1', 'every table has padding', '--visual']);
  t('--visual marks the item as a screen item', /^visual: yes$/m.test(read(join(D('tb1'), '01.md'))));
  t('scope refuses n > of and non-counts', H('tb1', ['scope', '1', '5', '4']).code === 1 && H('tb1', ['scope', '1', 'x', '4']).code === 1);
  H('tb1', ['scope', '1', '2', '14']);
  t('scope is stored as "n of N"', /^scope: 2 of 14$/m.test(read(join(D('tb1'), '01.md'))));
  png(join(D('tb1'), 'img', '01-after.png'));
  t('a 2 of 14 item is not done even with after-shot and judge', H('tb1', ['status', '01', 'done', 'img/01-after.png judge: opus-eye all fixed']).code === 1);
  t('it can be partial with left:', H('tb1', ['status', '01', 'partial', 'two done; left: 12 tables']).code === 0);
  H('tb1', ['scope', '1', '14', '14']);
  t('14 of 14 plus after-shot and judge is done', H('tb1', ['status', '01', 'done', 'img/01-after.png judge: opus-eye all fixed']).code === 0);
  H('tb1', ['status', '01', 'unseen', 'code changed, screen not opened']);
  t('unseen is a final status', H('tb1', ['check']).code === 0, H('tb1', ['check']).out);
  r = H('tb1', ['table']);
  t('table shows unseen in full, done as one line, and asks about the unseen', r.out.includes('01 | unseen |') && r.out.includes('done: 02') && r.out.includes('ask: 01'), r.out);
  // came back: same project, same where, an earlier done item
  H('tb2', ['init']); P('tb2');
  r = H('tb2', ['add'], 'where: /orders\n---\nопять таблица кривая');
  t('a where equal to an earlier done item of the project prints back=', r.out.includes('back=tb1/') === false, r.out); // 01 is unseen now: not a repeat
  H('tb1', ['status', '01', 'done', 'img/01-after.png judge: opus-eye all fixed']);
  H('tb3', ['init']); P('tb3');
  r = H('tb3', ['add'], 'where: /ORDERS\n---\nвернулось');
  t('after the earlier item is done the repeat is flagged, case ignored', r.out.endsWith('back=tb1/01') && /^back: tb1\/01$/m.test(read(join(D('tb3'), '01.md'))), r.out);
  H('tb3', ['means', '1', 'x y z']); H('tb3', ['release']); H('tb3', ['status', '01', 'not-done', 'not yet fixed here']);
  t('table shows the repeat in full with its mark', H('tb3', ['table']).out.includes('came back: tb1/01'));
  writeFileSync(join(runDir, 'tasks', 'ready', 't3.md'), 'hold: [01]   # items\n');
  t('cover reads the list form and a trailing comment', H('tb1', ['cover', runDir]).code === 0 && (rmSync(join(runDir, 'tasks', 'ready', 't1.md')), H('tb1', ['cover', runDir]).code === 0));
  H('tb5', ['init']); H('tb5', ['add'], 'x'); H('tb5', ['means', '1', 'one thing', '--visual']); png(join(D('tb5'), 'img', '01-after.png'));
  t('an after-shot given with the hold dir in front or backslashes is found; judge: none is not a judge',
    H('tb5', ['status', '01', 'done', `${F(D('tb5'))}/img/01-after.png judge: none`]).code === 1 && H('tb5', ['status', '01', 'done', `${D('tb5')}\\img\\01-after.png judge: opus-eye`]).code === 0);
  H('tb5', ['add'], 'text item'); H('tb5', ['means', '2', 'y z']); H('tb5', ['status', '02', 'done', 'fixed in the shared place']);
  H('tb5', ['add'], 'screen two'); H('tb5', ['means', '3', 'screen ok', '--visual']);
  t('a screen item cannot merge into a text item', H('tb5', ['status', '03', 'merged→02']).code === 1);
  H('tb5', ['status', '03', 'unseen', 'code changed, screen not opened']); H('tb6', ['init']);
  t('carry takes an unseen item', H('tb6', ['carry', 'tb5']).out.startsWith('carried 1 of 3'), H('tb6', ['carry', 'tb5']).out);
  mkdirSync(join(D('old1'), 'img'), { recursive: true }); writeFileSync(join(D('old1'), 'index.md'), 'released x\n01 | done | t |\n'); writeFileSync(join(D('old1'), '01.md'), '# 01\nstatus: done | fixed in the old way\n\n> t\n');
  t('a hold made before these rules (no rules2 marker) still passes check without means', H('old1', ['check']).code === 0, H('old1', ['check']).out);
  t('carry from an old folder (no rules2) into an empty one still writes rules2', H('old9', ['carry', 'old1']).code === 0 && existsSync(join(D('old9'), 'rules2')) && existsSync(join(D('old9'), 'project.txt')), '');
  // judge verdict and the case of the after-shot name
  H('tb7', ['init']); H('tb7', ['add'], `x ${shot}`); H('tb7', ['means', '1', 'one thing', '--visual']);
  writeFileSync(join(D('tb7'), 'img', '01-after.png'), read(shot));
  t('a copy of the before-shot is refused whatever case the evidence spells its name in', H('tb7', ['status', '01', 'done', 'img/01-after.PNG judge: opus-eye seen-fixed']).code === 1);
  png(join(D('tb7'), 'img', '01-after.png'), 'DIFFERENT');
  t('judge: <agent> not-fixed is not done', H('tb7', ['status', '01', 'done', 'img/01-after.png judge: opus-eye not-fixed']).code === 1);
  if (process.platform === 'win32') t('a real after-shot is accepted when the evidence spells its extension in capitals', H('tb7', ['status', '01', 'done', 'img/01-after.PNG judge: opus-eye seen-fixed']).code === 0, H('tb7', ['status', '01', 'done', 'img/01-after.PNG judge: opus-eye seen-fixed']).err);
  t('judge: <agent> seen-fixed is done', H('tb7', ['status', '01', 'done', 'img/01-after.png judge: opus-eye seen-fixed']).code === 0);
  H('tb4', ['init']); writeFileSync(join(D('tb4'), 'project.txt'), 'other\n');
  t('another project is never a repeat', !H('tb4', ['add'], 'where: /orders\n---\nx').out.includes('back='));
}

// 11. bad use
t('an unknown verb exits 1', run(['nope']).code === 1);
t('a missing argument exits 1', H('m', ['status']).code === 1);

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
