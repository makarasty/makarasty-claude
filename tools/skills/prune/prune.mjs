#!/usr/bin/env node
// prune.mjs - moves local branches and worktrees that nobody needs after a merge into an undoable trash.
// Local only: nothing here pushes, fetches or changes a remote ref, so other developers' branches stay.
//
//   node prune.mjs scan                          verdicts: trash | ask | keep, one reason each
//   node prune.mjs trash <id ...> | --safe       --safe = every `trash` verdict; ids come from scan (b:<branch>, w:<worktree>)
//   node prune.mjs list [--all]                  what is in the trash (--all: every repo with trash on this machine)
//   node prune.mjs restore <trash id> [--as <new branch name>]
//   node prune.mjs empty <trash id> ... | --older 30d | --all   (never automatic; the person picks what goes)
//   node prune.mjs --selftest
// Every command takes --repo <dir> (default: cwd) and --json.
//
// The trash is <git common dir>/makarasty-trash/: the same volume as the repo, so a worktree moves by rename and
// is never copied. index.jsonl there holds one record per entry; a pointer line goes to a global index
// (%LOCALAPPDATA%\makarasty\trash-index.jsonl, else ${XDG_DATA_HOME:-~/.local/share}/makarasty/trash-index.jsonl).
// - branch: a ref refs/makarasty-trash/<id>/<name> keeps the tip, then the branch ref goes.
// - worktree: locked (`git worktree prune` and gc skip a locked one, so git's metadata waits for a restore),
//   then its directory is renamed into the trash; a trash ref keeps its HEAD.
// - worktree-meta (a worktree whose directory is gone): git's admin dir is moved into the trash.
// `empty` deletes only what has a record, and unlinks every symlink and junction before a recursive delete:
// `git worktree remove` and recursive deletes follow a junction and empty its target [docs/MEASUREMENTS.md M32, M45].
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HOUR = 3600e3, DAY = 24 * HOUR;
const LOCK = 'makarasty-trash'; // the lock reason on a trashed worktree: `makarasty-trash <id>`
class Refusal extends Error { }

function run(args, cwd) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 << 20 });
    if (r.error) throw r.error;
    return { code: r.status, out: (r.stdout ?? '').replace(/\r?\n$/, ''), err: (r.stderr ?? '').trim() };
}
function git(args, cwd) {
    const r = run(args, cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.err.split('\n')[0] || 'exit ' + r.code}`);
    return r.out;
}
const text = p => { try { return readFileSync(p, 'utf8').trim(); } catch { return null; } };
// One spelling per directory, so two paths to it compare equal. Linux file names are case-sensitive.
const key = p => { let r = resolve(p); try { r = realpathSync.native(r); } catch { } return process.platform === 'linux' ? r : r.toLowerCase(); };
const inside = (p, dir) => key(p).startsWith(key(dir) + sep);
const ago = ms => { const h = (Date.now() - ms) / HOUR; return h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---- links: copied from src/scripts/fleet/trees.mts (findLinks, unlinkLinks), native paths for posix ones ----

// `find <d> -type l`: every symlink or junction under d at any depth, in directory order, never entering one.
function findLinks(d) {
    const found = [];
    const walk = dir => {
        let ents;
        try { ents = readdirSync(dir); } catch { return; }
        for (const n of ents) {
            const p = join(dir, n);
            let s;
            try { s = lstatSync(p); } catch { continue; }
            if (s.isSymbolicLink()) found.push(p);
            else if (s.isDirectory()) walk(p);
        }
    };
    let s;
    try { s = lstatSync(d); } catch { return found; }
    if (s.isSymbolicLink()) found.push(d);
    else if (s.isDirectory()) walk(d);
    return found;
}
const there = p => { try { lstatSync(p); return true; } catch { return false; } };

// Unlink every reparse point inside a tree, at any depth, leaving what they point at alone. This is the step that
// makes a later recursive delete safe [M32]. unlinkSync on a junction removes the link only. Callers re-scan.
function unlinkLinks(d) {
    let n = 0;
    for (const e of findLinks(d)) {
        try { unlinkSync(e); } catch { /* the rmdir below */ }
        // Windows: should the link survive, `rmdir` (no /S) removes the link, never its target.
        if (there(e) && process.platform === 'win32') {
            spawnSync('cmd', ['/c', `rmdir "${basename(e)}"`], { cwd: dirname(e), stdio: 'ignore', windowsVerbatimArguments: true });
        }
        if (!there(e)) n++;
    }
    return n;
}

// ---- the repo -----------------------------------------------------------------------------------------------

function context(repo) {
    if (!existsSync(repo)) throw new Refusal(`${repo} does not exist`);
    const r = run(['rev-parse', '--git-common-dir'], repo);
    if (r.code) throw new Refusal(`${repo} is not a git repository`);
    const common = realpathSync.native(resolve(repo, r.out));
    const t = run(['rev-parse', '--show-toplevel'], repo);
    const trash = join(common, 'makarasty-trash');
    return { cwd: repo, common, top: t.code ? null : resolve(t.out), trash, index: join(trash, 'index.jsonl') };
}

// origin/HEAD, else main, else master. Merged means reachable from it or from the local branch of that name.
function defaults(cwd) {
    const has = r => run(['rev-parse', '-q', '--verify', r + '^{commit}'], cwd).code === 0;
    const head = run(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], cwd);
    const remote = head.code === 0 && has(head.out) ? head.out : null;
    const name = remote ? remote.replace(/^refs\/remotes\/[^/]+\//, '') : ['main', 'master'].find(n => has('refs/heads/' + n));
    if (!name) throw new Refusal('no default branch: origin/HEAD, main and master are all missing (`git remote set-head origin -a` sets origin/HEAD)');
    const refs = [remote, has('refs/heads/' + name) ? 'refs/heads/' + name : null].filter(Boolean);
    return { name, refs, label: remote ? remote.slice('refs/remotes/'.length) : name };
}

// shortcut: a worktree path holding a newline breaks this split (`list -z` is git 2.36+); upgrade if one appears.
function worktrees(cwd) {
    return git(['worktree', 'list', '--porcelain'], cwd).split(/\n\n+/).filter(Boolean).map((blk, i) => {
        const w = { main: i === 0 };
        for (const l of blk.split('\n')) {
            const [k, ...v] = l.split(' ');
            if (k === 'worktree') w.path = resolve(v.join(' '));
            else if (k === 'HEAD') w.sha = v[0];
            else if (k === 'branch') w.branch = v.join(' ').replace(/^refs\/heads\//, '');
            else if (k === 'bare') w.bare = true;
        }
        return w;
    });
}

// git's admin dir per linked worktree: <common>/worktrees/<name>/{gitdir,HEAD,locked}.
function admins(common) {
    const d = join(common, 'worktrees');
    let names = [];
    try { names = readdirSync(d); } catch { }
    return names.map(name => {
        const dir = join(d, name), gd = text(join(dir, 'gitdir'));
        // worktree.useRelativePaths (git 2.48+) writes gitdir relative to the admin dir.
        return gd && { name, dir, gitdir: gd, path: dirname(isAbsolute(gd) ? gd : resolve(dir, gd)), locked: text(join(dir, 'locked')) };
    }).filter(Boolean);
}

function branches(cwd) {
    return git(['for-each-ref', '--format=%(refname)%09%(objectname)%09%(upstream)%09%(upstream:track)', 'refs/heads'], cwd)
        .split('\n').filter(Boolean).map(l => { const [ref, sha, up, track] = l.split('\t'); return { name: ref.slice(11), sha, up, gone: track === '[gone]' }; });
}

// Newest mtime of the worktree's tracked files and its .git file.
function touched(wt) {
    let t = 0;
    const st = p => { try { t = Math.max(t, lstatSync(p).mtimeMs); } catch { } };
    st(join(wt, '.git'));
    for (const f of git(['ls-files', '-z'], wt).split('\0')) if (f) st(join(wt, f));
    return t;
}

// Newest Claude transcript for a chat started in the worktree: projects/<path with non-alphanumerics as '-'>.
// shortcut: the `<slug>-` prefix (chats started in a subfolder) also catches a sibling named `<wt>-x`; that costs an
// extra ask, never a wrong trash.
function chatTouched(wt) {
    const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
    const fold = s => process.platform === 'linux' ? s : s.toLowerCase();
    const slug = fold(resolve(wt).replace(/[^a-zA-Z0-9]/g, '-'));
    let t = 0, names = [];
    try { names = readdirSync(root); } catch { return 0; }
    for (const n of names) if (fold(n) === slug || fold(n).startsWith(slug + '-')) {
        const d = join(root, n);
        try { t = Math.max(t, statSync(d).mtimeMs); for (const f of readdirSync(d)) t = Math.max(t, statSync(join(d, f)).mtimeMs); } catch { }
    }
    return t;
}

// Why the worktree is not clean, or null. Plain `git status --porcelain` obeys status.showUntrackedFiles=no,
// submodule ignore=all and assume-unchanged / skip-worktree marks, so a tree with an untracked note or a hidden
// edit would read clean and be trashed; each of those is overridden or checked here.
function changes(wt) {
    const fail = (what, r) => `git ${what} failed: ${r.err.split('\n')[0] || 'exit ' + r.code}`;
    const st = run(['-c', 'status.showUntrackedFiles=all', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], wt);
    if (st.code) return fail('status', st);
    let n = 0;
    const ents = st.out.split('\0');
    for (let i = 0; i < ents.length; i++) if (ents[i]) { n++; if (/^[RC]/.test(ents[i])) i++; } // a rename or copy carries its source as the next entry
    if (n) return plural(n, 'changed or untracked file');
    const lv = run(['ls-files', '-v', '-z'], wt);
    if (lv.code) return fail('ls-files -v', lv);
    // -v tags an assume-unchanged file in lowercase and a skip-worktree one with S: git does not look at either.
    const hid = lv.out.split('\0').filter(l => /^([a-z]|S) /.test(l));
    if (hid.length) return `${plural(hid.length, 'file')} marked assume-unchanged or skip-worktree (first: ${hid[0].slice(2)}); an edit there would not show`;
    const o = run(['ls-files', '-o', '--exclude-standard', '-z'], wt);
    if (o.code) return fail('ls-files -o', o);
    const un = o.out.split('\0').filter(Boolean);
    return un.length ? plural(un.length, 'untracked file') : null;
}

// A listed worktree (the main one too) inside p: moving p would carry it, its uncommitted work with it.
const heldIn = (p, paths) => paths.find(q => inside(q, p));
const worktreePaths = c => [...worktrees(c.cwd).map(w => w.path), ...admins(c.common).map(a => a.path)];

// Linux and macOS rename a folder that is another process's working directory without a word; Windows refuses.
// shortcut: best effort; /proc on Linux, else `lsof -d cwd` when installed, and only processes this user may
// inspect. A process that changes into the folder after this check still loses it; upgrade to a lock if that bites.
function cwdHolder(dir) {
    if (process.platform === 'win32') return null;
    const hit = p => key(p) === key(dir) || inside(p, dir);
    if (process.platform === 'linux' && existsSync('/proc/self/cwd')) {
        let pids = [];
        try { pids = readdirSync('/proc').filter(n => /^\d+$/.test(n) && +n !== process.pid); } catch { }
        for (const pid of pids) { try { if (hit(readlinkSync(`/proc/${pid}/cwd`))) return pid; } catch { } }
        return null;
    }
    const r = spawnSync('lsof', ['-a', '-d', 'cwd', '-Fpn'], { encoding: 'utf8', maxBuffer: 64 << 20 });
    if (r.error) return null; // no lsof
    let pid = null;
    for (const l of (r.stdout ?? '').split('\n')) {
        if (l[0] === 'p') pid = l.slice(1);
        else if (l[0] === 'n' && +pid !== process.pid && hit(l.slice(1))) return pid;
    }
    return null;
}

// strict: a branch checked out in any live worktree is kept, even one that is a trash candidate itself. `trash`
// rescans this way after moving worktrees, so a branch never goes while a worktree still has it checked out.
export function cmdScan(repo, strict = false) {
    const c = context(repo), def = defaults(c.cwd);
    const mergedTips = new Set(def.refs.flatMap(r => git(['for-each-ref', `--merged=${r}`, '--format=%(objectname)', 'refs/heads'], c.cwd).split('\n')));
    const merged = sha => mergedTips.has(sha) || def.refs.some(r => run(['merge-base', '--is-ancestor', sha, r], c.cwd).code === 0);
    const ahead = sha => {
        const n = +git(['rev-list', '--count', sha, '--not', ...def.refs], c.cwd);
        return `${plural(n, 'commit')} not in ${def.label}, last "${git(['log', '-1', '--format=%s', sha, '--not', ...def.refs], c.cwd)}"`;
    };
    // The merge `git merge-tree` (2.38+) would make adds nothing: the branch's changes are in already.
    const squashed = sha => { const r = run(['merge-tree', '--write-tree', def.refs[0], sha], c.cwd); return r.code === 0 && r.out.split('\n')[0] === git(['rev-parse', def.refs[0] + '^{tree}'], c.cwd); };
    const ads = admins(c.common), adOf = p => ads.find(a => key(a.path) === key(p));
    const brs = branches(c.cwd), wts = worktrees(c.cwd);
    const here = [c.top, process.cwd()].filter(Boolean).map(key);
    const items = [];
    for (const w of wts) {
        if (w.main || w.bare) continue;
        const a = adOf(w.path);
        if (a?.locked?.startsWith(LOCK)) { w.inTrash = true; continue; }
        const it = { id: 'w:' + (a?.name ?? basename(w.path)), kind: 'worktree', name: a?.name, path: w.path, branch: w.branch, sha: w.sha };
        const v = (verdict, reason) => Object.assign(it, { verdict, reason });
        w.item = it; items.push(it);
        const k = key(w.path);
        if (here.some(h => h === k || h.startsWith(k + sep))) { v('keep', 'prune runs inside it'); continue; }
        if (!a) { v('keep', 'git lists it but has no admin dir for it'); continue; }
        if (a.locked !== null) { v('keep', `locked: ${a.locked || 'no reason given'}`); continue; }
        const held = heldIn(w.path, [...wts.map(x => x.path), ...ads.map(x => x.path)]);
        if (held) { v('keep', `holds another worktree: ${held}`); continue; }
        if (!existsSync(w.path)) {
            // The trash ref keeps the commit only until `empty`; one found nowhere else is the person's call.
            if (w.sha && !merged(w.sha) && !git(['for-each-ref', '--count=1', '--contains', w.sha, 'refs/heads', 'refs/remotes', 'refs/tags'], c.cwd)) {
                v('ask', `folder gone, commit ${w.sha.slice(0, 8)} exists nowhere else; in the trash a trash ref keeps it until empty`);
            } else v('trash', "directory is gone; only git's record of it is left");
            continue;
        }
        const dirt = changes(w.path);
        if (dirt) { v('keep', dirt); continue; }
        if (!w.sha || !merged(w.sha)) {
            const b = w.branch && brs.find(x => x.name === w.branch);
            if (!w.sha) v('keep', 'no commit checked out');
            else if (b?.gone) v('ask', `branch ${w.branch} lost its upstream, ${ahead(w.sha)}`);
            else v('keep', `${w.branch ? 'branch ' + w.branch : 'detached HEAD'} has ${ahead(w.sha)}`);
            continue;
        }
        if (Date.now() - touched(w.path) < DAY) { v('ask', 'files changed in the last 24 h: a chat may still use it'); continue; }
        if (Date.now() - chatTouched(w.path) < 2 * HOUR) { v('ask', 'a Claude chat in it was active in the last 2 h: a chat may still use it'); continue; }
        v('trash', `clean, ${w.branch ? 'branch ' + w.branch : 'detached HEAD'} is in ${def.label}`);
    }
    const current = run(['symbolic-ref', '-q', '--short', 'HEAD'], c.cwd).out;
    for (const b of brs) {
        if (b.name === def.name || b.name === current) continue;
        const it = { id: 'b:' + b.name, kind: 'branch', name: b.name, sha: b.sha };
        const v = (verdict, reason) => Object.assign(it, { verdict, reason });
        items.push(it);
        const holder = wts.find(w => w.branch === b.name && !w.inTrash && (strict || w.item?.verdict !== 'trash'));
        if (holder) { v('keep', `checked out in ${holder.main ? 'the main checkout' : holder.item?.id ?? holder.path}`); continue; }
        const withWt = wts.find(w => w.branch === b.name && w.item?.verdict === 'trash');
        if (merged(b.sha)) {
            // A branch just made from the default has no commits of its own yet and looks merged.
            // The reflog entry's own time (`<name>@{<unix>}`), not the commit's: a new branch points at an old commit.
            const moved = 1000 * +(/@\{(\d+)\}/.exec(run(['log', '-g', '-1', '--date=unix', '--format=%gd', 'refs/heads/' + b.name], c.cwd).out)?.[1] ?? 0);
            if (!withWt && Date.now() - moved < DAY) v('ask', `in ${def.label}, but made or moved in the last 24 h: maybe new work`);
            else v('trash', `merged into ${def.label}${withWt ? `; goes with ${withWt.item.id}` : ''}`);
            continue;
        }
        if (b.gone) { v('ask', `upstream gone, ${ahead(b.sha)}${squashed(b.sha) ? '; its changes are already there (squash-merged)' : ''}`); continue; }
        const remote = git(['for-each-ref', '--count=1', '--format=%(refname:short)', '--contains', b.sha, 'refs/remotes'], c.cwd);
        v('keep', remote ? `not merged yet; on ${remote}` : `unique work: ${ahead(b.sha)}, on no remote`);
    }
    const order = { trash: 0, ask: 1, keep: 2 };
    items.sort((x, y) => order[x.verdict] - order[y.verdict]);
    return { repo: c.top ?? c.common, default: def.label, inTrash: readIdx(c.index).length, items };
}

// ---- the trash index ----------------------------------------------------------------------------------------

const LINE = Symbol('line'); // a record's line in index.jsonl, for refusals; JSON.stringify skips it
function readIdx(f) {
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8').split('\n').map((l, i) => {
        if (!l.trim()) return null;
        let r = null;
        try { r = JSON.parse(l); } catch { }
        if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Refusal(`${f} line ${i + 1} is not a JSON object; fix it by hand, nothing was changed`);
        r[LINE] = i + 1;
        return r;
    }).filter(Boolean);
}

// index.jsonl is a file anyone can edit: restore and empty act only on a record whose every ref and path is this
// trash's own. A line with ref refs/heads/main would otherwise delete main.
function checked(c, r) {
    const bad = why => { throw new Refusal(`${c.index} line ${r[LINE]}: ${why}; refused, nothing done for this entry`); };
    if (typeof r.id !== 'string' || !/^\d{8}-\d{6}-\d+$/.test(r.id)) bad(`id ${JSON.stringify(r.id)} is not a trash id`);
    if (!['branch', 'worktree', 'worktree-meta'].includes(r.kind)) bad(`kind ${JSON.stringify(r.kind)} is unknown`);
    if (r.sha != null && !/^[0-9a-f]{40,64}$/.test(r.sha)) bad(`sha ${JSON.stringify(r.sha)} is not a commit id`);
    if (typeof r.name !== 'string' || !r.name) bad('no name');
    const want = `refs/makarasty-trash/${r.id}/${r.kind === 'branch' ? r.name : 'worktree'}`;
    if ((r.kind === 'branch' || r.ref != null) && r.ref !== want) bad(`ref ${JSON.stringify(r.ref)} is not ${want}`);
    if (r.kind === 'branch') {
        if (!r.sha) bad('no sha');
        if (run(['check-ref-format', 'refs/heads/' + r.name], c.cwd).code) bad(`branch name ${JSON.stringify(r.name)} is not valid`);
        return r;
    }
    if (/[\\/]/.test(r.name) || /^\.\.?$/.test(r.name)) bad(`worktree name ${JSON.stringify(r.name)} is not a folder name`);
    const own = join(c.trash, r.id);
    if (typeof r.to !== 'string' || !inside(r.to, own)) bad(`${r.to} is outside ${own}`);
    if (typeof r.from !== 'string' || !isAbsolute(r.from) || key(r.from) === key(c.common) || inside(r.from, c.common)) bad(`${r.from} is not a folder outside the git dir`);
    if (r.branch != null && (typeof r.branch !== 'string' || run(['check-ref-format', 'refs/heads/' + r.branch], c.cwd).code)) bad(`branch name ${JSON.stringify(r.branch)} is not valid`);
    return r;
}
function writeIdx(f, recs) { writeFileSync(f + '.tmp', recs.map(r => JSON.stringify(r) + '\n').join('')); renameSync(f + '.tmp', f); }
export const globalIndex = () => join(process.platform === 'win32'
    ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'makarasty', 'trash-index.jsonl');

function record(c, r) {
    const rec = { id: r.id, at: new Date().toISOString(), ...r };
    appendFileSync(c.index, JSON.stringify(rec) + '\n');
    const g = globalIndex();
    mkdirSync(dirname(g), { recursive: true });
    appendFileSync(g, JSON.stringify({ repo: c.common, id: rec.id, at: rec.at }) + '\n');
    return rec;
}

function newId(c) {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const taken = new Set(readIdx(c.index).map(r => r.id));
    let k = 1;
    while (taken.has(`${stamp}-${k}`) || existsSync(join(c.trash, `${stamp}-${k}`))) k++;
    return `${stamp}-${k}`;
}

// Two chats pruning one repo at once would each rewrite index.jsonl; the second one waits for a retry instead.
function withLock(c, fn) {
    mkdirSync(c.trash, { recursive: true });
    const p = join(c.trash, '.lock');
    try { writeFileSync(p, String(process.pid), { flag: 'wx' }); } catch {
        if (Date.now() - statSync(p).mtimeMs < 10 * 60e3) throw new Refusal(`another prune is working on this repo (${p}); try again in a minute`);
        writeFileSync(p, String(process.pid)); // a lock older than ten minutes is from a run that died
    }
    try { return fn(); } finally { rmSync(p, { force: true }); }
}
const rmEmpty = d => { try { rmdirSync(d); } catch { } };

// ---- trash ------------------------------------------------------------------------------------------------

function trashBranch(c, it) {
    const id = newId(c), ref = `refs/makarasty-trash/${id}/${it.name}`;
    git(['update-ref', ref, it.sha, ''], c.cwd); // '' = create only
    if (git(['rev-parse', ref], c.cwd) !== it.sha) throw new Error(`trash ref ${ref} did not land; branch left as is`);
    // The old-value form: a branch that moved since the scan is not deleted.
    const d = run(['update-ref', '-d', 'refs/heads/' + it.name, it.sha], c.cwd);
    if (d.code) { run(['update-ref', '-d', ref, it.sha], c.cwd); throw new Error(`branch moved since the scan; left as is (${d.err.split('\n')[0]})`); }
    return record(c, { id, kind: 'branch', name: it.name, sha: it.sha, from: 'refs/heads/' + it.name, to: ref, ref });
}

function trashWorktree(c, it) {
    const id = newId(c), admin = join(c.common, 'worktrees', it.name);
    const sha = /^[0-9a-f]{40,64}$/.test(it.sha ?? '') && !/^0+$/.test(it.sha) ? it.sha : null;
    const ref = sha ? `refs/makarasty-trash/${id}/worktree` : null;
    mkdirSync(join(c.trash, id), { recursive: true });
    if (!existsSync(it.path)) {
        const to = join(c.trash, id, 'admin'), meta = { gitdir: text(join(admin, 'gitdir')), HEAD: text(join(admin, 'HEAD')) };
        if (ref) git(['update-ref', ref, sha, ''], c.cwd);
        try { renameSync(admin, to); } catch (e) {
            if (ref) run(['update-ref', '-d', ref, sha], c.cwd);
            rmEmpty(join(c.trash, id));
            throw new Error(`could not move git's admin dir (${e.code}); left in place`);
        }
        return record(c, { id, kind: 'worktree-meta', name: it.name, sha, from: it.path, to, ref, branch: it.branch, meta });
    }
    // The scan was a moment ago; a chat may have written, added a worktree inside or opened a shell there since.
    const dirt = changes(it.path), held = heldIn(it.path, worktreePaths(c)), pid = !dirt && !held && cwdHolder(it.path);
    if (dirt || held || pid) {
        rmEmpty(join(c.trash, id));
        throw new Error(`${dirt ? `has changes now (${dirt})` : held ? `holds another worktree: ${held}` : `a process (pid ${pid}) has its working directory in it`}; left in place`);
    }
    if (ref) git(['update-ref', ref, sha, ''], c.cwd);
    git(['worktree', 'lock', '--reason', `${LOCK} ${id}`, it.path], c.cwd);
    const to = join(c.trash, id, basename(it.path));
    try { renameSync(it.path, to); } catch (e) {
        // Never copy and delete instead: a copy crosses volumes slowly and a half-done delete loses files.
        run(['worktree', 'unlock', it.path], c.cwd);
        if (ref) run(['update-ref', '-d', ref, sha], c.cwd);
        rmEmpty(join(c.trash, id));
        const why = e.code === 'EXDEV' ? 'it is on another volume than the repo' : /^(EBUSY|EPERM|EACCES)$/.test(e.code) ? 'a process holds a file or the folder open' : e.message;
        throw new Error(`could not move it (${e.code}: ${why}); left in place, nothing deleted`);
    }
    return record(c, { id, kind: 'worktree', name: it.name, sha, from: it.path, to, ref, branch: it.branch });
}

export function cmdTrash(repo, ids, safe) {
    const c = context(repo);
    return withLock(c, () => {
        const done = [], failed = [], seen = new Set();
        const act = (items, kind, fn) => {
            for (const it of items) {
                if (it.kind !== kind) continue;
                seen.add(it.id);
                if (!(safe ? it.verdict === 'trash' : ids.includes(it.id))) continue;
                if (it.verdict === 'keep') { failed.push({ id: it.id, why: `kept: ${it.reason}` }); continue; }
                try { done.push(fn(c, it)); } catch (e) { failed.push({ id: it.id, why: e.message }); }
            }
        };
        act(cmdScan(repo).items, 'worktree', trashWorktree);
        act(cmdScan(repo, true).items, 'branch', trashBranch); // worktrees first, so their branches are free now
        for (const id of ids) if (!seen.has(id)) failed.push({ id, why: 'no such candidate in scan (ids look like b:<branch> or w:<worktree>)' });
        return { done, failed };
    });
}

// ---- list, restore, empty -----------------------------------------------------------------------------------

export function cmdList(repo, all) {
    const repos = all ? [...new Set(readIdx(globalIndex()).map(p => p.repo))] : [context(repo).common];
    return repos.flatMap(r => readIdx(join(r, 'makarasty-trash', 'index.jsonl')).map(x => ({ repo: r, ...x })));
}

function restoreBranch(c, r, as) {
    const name = as || r.name;
    if (run(['rev-parse', '-q', '--verify', 'refs/heads/' + name], c.cwd).code === 0) {
        throw new Refusal(`a branch ${name} exists now; nothing restored. Restore it under another name: restore ${r.id} --as <new name>`);
    }
    if (run(['cat-file', '-e', r.sha + '^{commit}'], c.cwd).code) throw new Refusal(`commit ${r.sha} is gone from the repo; nothing to restore`);
    git(['update-ref', 'refs/heads/' + name, r.sha, ''], c.cwd);
    run(['update-ref', '-d', r.ref, r.sha], c.cwd);
    return name;
}

function restoreWorktree(c, r, recs, notes) {
    const br = r.branch && recs.find(x => x.kind === 'branch' && x.name === r.branch);
    if (br) checked(c, br); // before anything moves
    if (existsSync(r.from)) throw new Refusal(`${r.from} exists now; move it away first, nothing restored`);
    if (!existsSync(r.to)) throw new Refusal(`the trashed folder ${r.to} is gone; nothing to restore`);
    mkdirSync(dirname(r.from), { recursive: true });
    renameSync(r.to, r.from);
    rmEmpty(dirname(r.to));
    const gone = [r.id];
    let head = r.sha;
    if (r.branch) {
        const live = worktrees(c.cwd).some(w => w.branch === r.branch && key(w.path) !== key(r.from));
        if (run(['rev-parse', '-q', '--verify', 'refs/heads/' + r.branch], c.cwd).code) {
            if (br) { restoreBranch(c, br); gone.push(br.id); notes.push(`branch ${r.branch} came back with it (${br.id})`); }
            else git(['update-ref', 'refs/heads/' + r.branch, r.sha, ''], c.cwd);
        } else if (git(['rev-parse', 'refs/heads/' + r.branch], c.cwd) !== r.sha) notes.push(`branch ${r.branch} moved while trashed; the tree shows that as changes`);
        if (live) notes.push(`branch ${r.branch} is checked out elsewhere now; the worktree is detached at ${r.sha.slice(0, 9)}`);
        else head = 'ref: refs/heads/' + r.branch;
    }
    const admin = join(c.common, 'worktrees', r.name), gd = text(join(admin, 'gitdir'));
    if (gd && key(dirname(isAbsolute(gd) ? gd : resolve(admin, gd))) === key(r.from)) {
        git(['worktree', 'repair', r.from], c.cwd);
        run(['worktree', 'unlock', r.from], c.cwd);
    } else {
        // git's metadata was pruned meanwhile (someone unlocked and pruned). `git worktree add` refuses an existing
        // folder, so this writes what `git worktree add --no-checkout` would: <common>/worktrees/<name>/ with gitdir
        // (the tree's .git file), commondir (../..) and HEAD, the tree's .git file pointing back, then a mixed
        // `git reset` builds the index from HEAD and leaves every file in the tree as it is.
        let name = r.name, n = 1;
        while (existsSync(join(c.common, 'worktrees', name))) name = `${r.name}-${n++}`;
        const dir = join(c.common, 'worktrees', name), fwd = p => p.replace(/\\/g, '/');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'gitdir'), fwd(join(r.from, '.git')) + '\n');
        writeFileSync(join(dir, 'commondir'), '../..\n');
        writeFileSync(join(dir, 'HEAD'), head + '\n');
        rmSync(join(r.from, '.git'), { force: true }); // Git for Windows hides .git, and Windows refuses to overwrite a hidden file
        writeFileSync(join(r.from, '.git'), `gitdir: ${fwd(dir)}\n`);
        git(['reset', '-q'], r.from);
        notes.push(`git had forgotten this worktree; re-attached as ${name}`);
    }
    if (r.ref) run(['update-ref', '-d', r.ref, r.sha], c.cwd);
    git(['status', '--porcelain'], r.from); // fails loudly when the tree is not a working worktree again
    return gone;
}

function restoreMeta(c, r) {
    const admin = join(c.common, 'worktrees', r.name);
    if (existsSync(admin)) throw new Refusal(`git has a worktree named ${r.name} again; nothing restored`);
    mkdirSync(dirname(admin), { recursive: true });
    renameSync(r.to, admin);
    rmEmpty(dirname(r.to));
    if (r.ref) run(['update-ref', '-d', r.ref, r.sha], c.cwd);
}

export function cmdRestore(repo, id, as) {
    const c = context(repo);
    return withLock(c, () => {
        const recs = readIdx(c.index), r = recs.find(x => x.id === id), notes = [];
        if (!r) throw new Refusal(`no trash entry ${id} in ${c.index} (see: list)`);
        checked(c, r);
        let gone = [id];
        if (r.kind === 'branch') notes.push(`branch ${restoreBranch(c, r, as)} at ${r.sha.slice(0, 9)}`);
        else if (r.kind === 'worktree') { gone = restoreWorktree(c, r, recs, notes); notes.unshift(`worktree ${r.from}`); }
        else { restoreMeta(c, r); notes.push(`git's record of the worktree ${r.from} (its folder was already gone)`); }
        writeIdx(c.index, readIdx(c.index).filter(x => !gone.includes(x.id)));
        return { restored: gone, notes };
    });
}

function emptyOne(c, r, notes) {
    // index.jsonl is a file anyone can edit: delete nothing outside this repo's trash folder.
    for (const p of [r.to].filter(p => r.kind !== 'branch' && p)) if (!inside(p, c.trash)) throw new Error(`${p} is outside ${c.trash}; nothing deleted`);
    checked(c, r); // and no ref but this entry's own trash ref
    if (r.kind !== 'branch' && existsSync(r.to)) {
        unlinkLinks(r.to);
        const left = findLinks(r.to);
        if (left.length) throw new Error(`${plural(left.length, 'link')} could not be unlinked (first: ${left[0]}); nothing deleted`);
        rmSync(r.to, { recursive: true, force: true, maxRetries: 3 });
    }
    if (r.kind === 'worktree') {
        const admin = join(c.common, 'worktrees', r.name), gd = text(join(admin, 'gitdir'));
        // Only git's record of this very worktree: same path, and that path still empty.
        if (gd && !existsSync(r.from) && key(dirname(isAbsolute(gd) ? gd : resolve(admin, gd))) === key(r.from)) { unlinkLinks(admin); rmSync(admin, { recursive: true, force: true }); }
        else if (gd) notes.push(`${r.id}: git's record ${admin} no longer matches ${r.from}; left`);
    }
    rmEmpty(join(c.trash, r.id));
    if (r.ref) run(['update-ref', '-d', r.ref, r.sha], c.cwd);
    // update-ref -d leaves branch.<name>.* (upstream) in the config for a restore; drop it once nothing can come back.
    if (r.kind === 'branch' && run(['rev-parse', '-q', '--verify', 'refs/heads/' + r.name], c.cwd).code) run(['config', '--remove-section', 'branch.' + r.name], c.cwd);
}

export function cmdEmpty(repo, ids, olderMs, all = false) {
    // Nothing is ever emptied on its own: the trash keeps everything until the person names what goes.
    if (!ids.length && olderMs === undefined && !all) throw new Refusal('empty needs a choice: trash ids, --older <age> (like 30d), or --all; see list');
    const c = context(repo);
    if (!existsSync(c.index)) return { gone: [], failed: [], notes: [] };
    return withLock(c, () => {
        const cut = olderMs === undefined ? Infinity : Date.now() - olderMs, gone = [], failed = [], notes = [];
        // Named ids go whatever their age unless --older is given too; --older alone takes entries past that age; --all takes everything.
        const pick = readIdx(c.index).filter(r => (!ids.length || ids.includes(r.id)) && Date.parse(r.at) <= cut);
        for (const r of pick) { try { emptyOne(c, r, notes); gone.push(r.id); } catch (e) { failed.push({ id: r.id, why: e.message }); } }
        for (const id of ids) if (!pick.some(r => r.id === id)) failed.push({ id, why: 'no such trash entry, or younger than --older' });
        writeIdx(c.index, readIdx(c.index).filter(r => !gone.includes(r.id)));
        return { gone, failed, notes };
    });
}

// ---- selftest -------------------------------------------------------------------------------------------------

function selftest() {
    const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'prune-selftest-')));
    const old = Math.floor((Date.now() - 3 * DAY) / 1000), oldDate = `@${old} +0000`;
    // A private git config (no hooks, signing or aliases of this machine), dates three days back, and every
    // index this script writes inside tmp.
    Object.assign(process.env, {
        GIT_CONFIG_GLOBAL: join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
        GIT_AUTHOR_DATE: oldDate, GIT_COMMITTER_DATE: oldDate,
        CLAUDE_CONFIG_DIR: join(tmp, 'claude'), LOCALAPPDATA: join(tmp, 'local'), XDG_DATA_HOME: join(tmp, 'local'),
    });
    writeFileSync(join(tmp, 'gitconfig'), '[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
    const g = (cwd, ...a) => git(a, cwd);
    const remote = join(tmp, 'remote.git'), repo = join(tmp, 'repo'), outside = join(tmp, 'outside'), wt = n => join(tmp, n);
    const commit = (cwd, f, msg) => { writeFileSync(join(cwd, f), msg + '\n'); g(cwd, 'add', f); g(cwd, 'commit', '-q', '-m', msg); };
    const backdate = d => { for (const f of [...g(d, 'ls-files', '-z').split('\0').filter(Boolean), '.git']) utimesSync(join(d, f), old, old); };
    const verdicts = () => Object.fromEntries(cmdScan(repo).items.map(i => [i.id, i.verdict]));
    const rec = (kind, name) => cmdList(repo).find(r => r.kind === kind && r.name === name);
    const remoteRefs = () => g(remote, 'for-each-ref', '--format=%(refname) %(objectname)');
    // The child holds its cwd until it is gone, and Windows refuses to delete that folder: wait for the exit.
    let child;
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const stop = () => {
        if (!child) return;
        child.kill();
        for (const end = Date.now() + 10e3; alive(child.pid) && Date.now() < end;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        child = null;
    };
    try {
        g(tmp, 'init', '-q', '--bare', remote);
        g(tmp, 'init', '-q', repo);
        writeFileSync(join(repo, '.gitignore'), 'node_modules\n'); g(repo, 'add', '.gitignore');
        commit(repo, 'a.txt', 'first');
        g(repo, 'remote', 'add', 'origin', remote);
        g(repo, 'push', '-q', 'origin', 'main');
        g(repo, 'remote', 'set-head', 'origin', 'main');
        for (const b of ['merged', 'wtclean']) {
            g(repo, 'switch', '-q', '-c', b); commit(repo, b + '.txt', b + ' work');
            g(repo, 'switch', '-q', 'main'); g(repo, 'merge', '-q', '--no-ff', '-m', 'merge ' + b, b);
        }
        g(repo, 'switch', '-q', '-c', 'unmerged'); commit(repo, 'u.txt', 'unique work'); g(repo, 'switch', '-q', 'main');
        g(repo, 'switch', '-q', '-c', 'gone'); commit(repo, 'g.txt', 'abandoned work'); g(repo, 'push', '-q', '-u', 'origin', 'gone');
        g(repo, 'switch', '-q', '-c', 'squashed', 'main'); commit(repo, 's.txt', 'squash me'); g(repo, 'push', '-q', '-u', 'origin', 'squashed');
        g(repo, 'switch', '-q', 'main'); g(repo, 'merge', '-q', '--squash', 'squashed'); g(repo, 'commit', '-q', '-m', 'squash of squashed');
        g(repo, 'push', '-q', 'origin', 'main');
        // The remote loses both branches, as after a merged PR; a fetch --prune marks the upstreams [gone].
        g(remote, 'update-ref', '-d', 'refs/heads/gone'); g(remote, 'update-ref', '-d', 'refs/heads/squashed');
        g(repo, 'fetch', '-q', '--prune', 'origin');
        delete process.env.GIT_COMMITTER_DATE; g(repo, 'branch', 'fresh'); process.env.GIT_COMMITTER_DATE = oldDate;
        g(repo, 'worktree', 'add', '-q', wt('wt-clean'), 'wtclean');
        mkdirSync(outside); writeFileSync(join(outside, 'keep.txt'), 'must survive\n');
        symlinkSync(outside, join(wt('wt-clean'), 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
        assert.ok(lstatSync(join(wt('wt-clean'), 'node_modules')).isSymbolicLink(), 'the junction exists');
        g(repo, 'worktree', 'add', '-q', '-b', 'dirty', wt('wt-dirty'), 'main'); writeFileSync(join(wt('wt-dirty'), 'a.txt'), 'changed\n');
        g(repo, 'worktree', 'add', '-q', '--detach', wt('wt-recent'), 'main');
        g(repo, 'worktree', 'add', '-q', '--detach', wt('wt-chat'), 'main');
        g(repo, 'worktree', 'add', '-q', '--detach', wt('wt-gone'), 'main'); rmSync(wt('wt-gone'), { recursive: true, force: true });
        for (const d of ['wt-clean', 'wt-dirty', 'wt-chat']) backdate(wt(d));
        const chat = join(tmp, 'claude', 'projects', wt('wt-chat').replace(/[^a-zA-Z0-9]/g, '-'));
        mkdirSync(chat, { recursive: true }); writeFileSync(join(chat, 'session.jsonl'), '{}\n');
        const before = remoteRefs();

        const s = cmdScan(repo);
        assert.deepEqual(verdicts(), {
            'b:merged': 'trash', 'b:wtclean': 'trash', 'w:wt-clean': 'trash', 'w:wt-gone': 'trash',
            'b:gone': 'ask', 'b:squashed': 'ask', 'b:fresh': 'ask', 'w:wt-recent': 'ask', 'w:wt-chat': 'ask',
            'b:unmerged': 'keep', 'b:dirty': 'keep', 'w:wt-dirty': 'keep',
        }, 'scan verdicts');
        assert.match(s.items.find(i => i.id === 'b:squashed').reason, /squash-merged/);
        assert.doesNotMatch(s.items.find(i => i.id === 'b:gone').reason, /squash-merged/);
        assert.match(s.items.find(i => i.id === 'w:wt-chat').reason, /chat/);
        assert.equal(s.default, 'origin/main');

        const t1 = cmdTrash(repo, [], true);
        assert.deepEqual(t1.failed, []);
        assert.deepEqual(t1.done.map(r => `${r.kind}:${r.name}`).sort(), ['branch:merged', 'branch:wtclean', 'worktree-meta:wt-gone', 'worktree:wt-clean']);
        assert.ok(existsSync(join(outside, 'keep.txt')), 'outside file after trash');
        assert.ok(!existsSync(wt('wt-clean')) && existsSync(wt('wt-dirty')), 'clean tree moved, dirty tree stays');
        assert.notEqual(g(wt('wt-dirty'), 'status', '--porcelain'), '', 'dirty tree still dirty');
        g(repo, 'rev-parse', '--verify', 'refs/heads/unmerged');
        assert.deepEqual(cmdScan(repo).items.filter(i => i.verdict === 'trash'), [], 'nothing left to trash');
        assert.ok(cmdList(null, true).some(r => r.repo === realpathSync.native(join(repo, '.git'))), 'list --all finds the repo');
        assert.match(cmdTrash(repo, ['b:unmerged'], false).failed[0]?.why ?? '', /^kept: unique work/, 'a keep item is refused');

        // Branch restore: refused while the name is taken, then under another name.
        g(repo, 'branch', 'merged', 'main');
        assert.throws(() => cmdRestore(repo, rec('branch', 'merged').id), /--as/);
        const mergedSha = rec('branch', 'merged').sha;
        cmdRestore(repo, rec('branch', 'merged').id, 'merged-old');
        assert.equal(g(repo, 'rev-parse', 'refs/heads/merged-old'), mergedSha);
        g(repo, 'update-ref', '-d', 'refs/heads/merged');
        // Worktree restore brings its branch back too.
        const r1 = cmdRestore(repo, rec('worktree', 'wt-clean').id);
        assert.equal(r1.restored.length, 2, 'worktree and its branch');
        assert.equal(g(wt('wt-clean'), 'status', '--porcelain'), '', 'restored tree is clean');
        assert.equal(g(wt('wt-clean'), 'symbolic-ref', '--short', 'HEAD'), 'wtclean');
        assert.ok(lstatSync(join(wt('wt-clean'), 'node_modules')).isSymbolicLink(), 'junction came back as a junction');
        cmdRestore(repo, rec('worktree-meta', 'wt-gone').id);
        assert.ok(existsSync(join(repo, '.git', 'worktrees', 'wt-gone', 'gitdir')), 'admin dir back');
        assert.deepEqual(cmdList(repo), [], 'restore removed every record');

        // Second round, then git loses the trashed worktree's metadata: restore re-attaches it.
        backdate(wt('wt-clean'));
        const t2 = cmdTrash(repo, [], true);
        assert.deepEqual(t2.done.map(r => `${r.kind}:${r.name}`).sort(), ['branch:merged-old', 'branch:wtclean', 'worktree-meta:wt-gone', 'worktree:wt-clean']);
        rmSync(join(repo, '.git', 'worktrees', 'wt-clean'), { recursive: true, force: true });
        const r2 = cmdRestore(repo, rec('worktree', 'wt-clean').id);
        assert.match(r2.notes.join(' '), /re-attached/);
        assert.equal(g(wt('wt-clean'), 'status', '--porcelain'), '', 're-attached tree is clean');
        assert.equal(g(wt('wt-clean'), 'symbolic-ref', '--short', 'HEAD'), 'wtclean');
        assert.ok(g(repo, 'worktree', 'list', '--porcelain').includes(wt('wt-clean').replace(/\\/g, '/')), 'git lists it again');

        backdate(wt('wt-clean'));
        const t3 = cmdTrash(repo, [], true);
        assert.deepEqual(t3.done.map(r => r.name).sort(), ['wt-clean', 'wtclean']);
        assert.equal(cmdList(repo).length, 4);
        assert.throws(() => cmdEmpty(repo, [], undefined), /empty needs a choice/, 'a bare empty deletes nothing');
        assert.equal(cmdList(repo).length, 4, 'and the trash is untouched');
        assert.deepEqual(cmdEmpty(repo, [], 30 * DAY).gone, [], '--older 30d keeps younger entries');
        const e = cmdEmpty(repo, [], 0);
        assert.deepEqual(e.failed, []);
        assert.equal(e.gone.length, 4);
        assert.ok(existsSync(join(outside, 'keep.txt')), 'the junction was not followed');
        assert.deepEqual(cmdList(repo), []);
        assert.equal(g(repo, 'for-each-ref', 'refs/makarasty-trash'), '', 'trash refs gone');
        assert.deepEqual(readdirSync(join(repo, '.git', 'makarasty-trash')).filter(n => n !== 'index.jsonl'), [], 'trash folder empty');
        assert.deepEqual(worktrees(repo).map(w => basename(w.path)).sort(), ['repo', 'wt-chat', 'wt-dirty', 'wt-recent']);
        g(repo, 'rev-parse', '--verify', 'refs/heads/unmerged');
        assert.equal(remoteRefs(), before, 'the remote is untouched');

        // Data a plain `status --porcelain` misses, a worktree inside a worktree, a gone folder with the only copy of
        // a commit, a process with its cwd in a tree, and a corrupted index line: each one must survive.
        const rp = join(tmp, 'rp');
        g(tmp, 'init', '-q', rp);
        writeFileSync(join(rp, '.gitignore'), '.worktrees/\n'); g(rp, 'add', '.gitignore'); commit(rp, 'a.txt', 'first');
        const add = n => { g(rp, 'worktree', 'add', '-q', '--detach', wt(n), 'main'); return wt(n); };
        const untr = add('r2-untracked'); writeFileSync(join(untr, 'notes.txt'), 'precious\n');
        const assumed = add('r2-assume'); g(assumed, 'update-index', '--assume-unchanged', 'a.txt'); writeFileSync(join(assumed, 'a.txt'), 'edited\n');
        const skipped = add('r2-skip'); g(skipped, 'update-index', '--skip-worktree', 'a.txt'); writeFileSync(join(skipped, 'a.txt'), 'edited\n');
        const outer = add('r2-outer'), inner = join(outer, '.worktrees', 'inner');
        g(outer, 'worktree', 'add', '-q', '-b', 'innerb', inner, 'main'); writeFileSync(join(inner, 'a.txt'), 'uncommitted\n');
        const lost = add('r2-gone'); commit(lost, 'b.txt', 'unique unpushed');
        const uniq = g(lost, 'rev-parse', 'HEAD'); rmSync(lost, { recursive: true, force: true });
        const late = add('r2-late'), busy = add('r2-busy');
        for (const d of [untr, assumed, skipped, outer, inner, late, busy]) backdate(d);
        g(rp, 'config', 'status.showUntrackedFiles', 'no');
        const s2 = cmdScan(rp), why = id => s2.items.find(i => i.id === id).reason;
        assert.deepEqual(Object.fromEntries(s2.items.map(i => [i.id, i.verdict])), {
            'w:r2-late': 'trash', 'w:r2-busy': 'trash', 'w:r2-gone': 'ask',
            'w:r2-untracked': 'keep', 'w:r2-assume': 'keep', 'w:r2-skip': 'keep', 'w:r2-outer': 'keep', 'w:inner': 'keep', 'b:innerb': 'keep',
        }, 'second repo verdicts');
        assert.match(why('w:r2-untracked'), /untracked/);
        assert.match(why('w:r2-assume'), /assume-unchanged/);
        assert.match(why('w:r2-outer'), /holds another worktree/);
        assert.match(why('w:r2-gone'), new RegExp(`commit ${uniq.slice(0, 8)} exists nowhere else`));
        // A worktree added inside after the scan: the move re-checks.
        g(rp, 'worktree', 'add', '-q', '--detach', join(late, '.worktrees', 'x'), 'main');
        assert.throws(() => trashWorktree(context(rp), s2.items.find(i => i.id === 'w:r2-late')), /holds another worktree/);
        assert.ok(existsSync(join(late, '.worktrees', 'x', 'a.txt')), 'the inner tree stays');
        // Windows refuses the rename (EBUSY); elsewhere the cwd check must.
        child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: busy, stdio: 'ignore' });
        const t4 = cmdTrash(rp, [], true);
        assert.deepEqual(t4.done, [], 'nothing moves');
        assert.match(t4.failed.find(f => f.id === 'w:r2-busy')?.why ?? '', /a process/);
        assert.ok(existsSync(join(busy, 'a.txt')) && existsSync(join(untr, 'notes.txt')) && existsSync(join(inner, 'a.txt')), 'every tree stays');
        stop();
        // The ask item, chosen: its trash ref keeps the commit.
        const t5 = cmdTrash(rp, ['w:r2-gone'], false);
        assert.equal(t5.done[0]?.kind, 'worktree-meta');
        g(rp, 'cat-file', '-e', uniq + '^{commit}');
        // A corrupted line: a ref outside the entry's own trash ref, or a folder in the git dir, is never acted on.
        const idx2 = join(rp, '.git', 'makarasty-trash', 'index.jsonl'), good = readFileSync(idx2, 'utf8'), gid = t5.done[0].id;
        writeFileSync(idx2, good.replace(/"ref":"[^"]*"/, '"ref":"refs/heads/main"'));
        assert.match(cmdEmpty(rp, [gid], undefined).failed[0]?.why ?? '', /line 1: ref "refs\/heads\/main"/);
        assert.throws(() => cmdRestore(rp, gid), /line 1/);
        g(rp, 'rev-parse', '--verify', 'refs/heads/main');
        writeFileSync(idx2, good.replace(/"from":"[^"]*"/, `"from":${JSON.stringify(join(rp, '.git', 'hooks'))}`));
        assert.throws(() => cmdRestore(rp, gid), /line 1: .* is not a folder outside the git dir/);
        writeFileSync(idx2, good);
        cmdRestore(rp, gid);
        assert.ok(existsSync(join(rp, '.git', 'worktrees', 'r2-gone', 'gitdir')), 'a good line still restores');
        console.log(`prune.mjs selftest done (${process.platform}, ${g(tmp, '--version')})`);
    } finally {
        stop();
        unlinkLinks(tmp);
        rmSync(tmp, { recursive: true, force: true });
    }
}

// ---- CLI ------------------------------------------------------------------------------------------------------

function parseAge(s) {
    const m = /^(\d+)([dhm]?)$/.exec(s ?? '');
    if (!m) throw new Refusal(`--older takes a number of days like 30d (or 12h, 90m); got ${s}`);
    return +m[1] * ({ d: DAY, h: HOUR, m: 60e3, '': DAY })[m[2]];
}

function main(argv) {
    if (argv[0] === '--selftest') return selftest();
    const take = (n, v) => { const i = argv.indexOf(n); if (i < 0) return undefined; const x = v ? argv[i + 1] : true; argv.splice(i, v ? 2 : 1); return x; };
    const json = take('--json'), safe = take('--safe'), all = take('--all');
    const repo = resolve(take('--repo', 1) ?? '.'), as = take('--as', 1), olderArg = take('--older', 1);
    const [cmd, ...args] = argv;
    const say = (obj, lines) => console.log(json ? JSON.stringify(obj, null, 1) : lines().join('\n'));
    const hint = `node prune.mjs`;
    if (cmd === 'scan') {
        const s = cmdScan(repo), w = Math.max(4, ...s.items.map(i => i.id.length));
        const n = v => s.items.filter(i => i.verdict === v).length;
        return say(s, () => [`${s.repo}  default ${s.default}`,
            ...s.items.map(i => `${i.verdict.padEnd(5)}  ${i.id.padEnd(w)}  ${i.kind === 'worktree' ? i.path + '  ' : ''}${i.reason}`),
            `trash ${n('trash')}, ask ${n('ask')}, keep ${n('keep')}${s.inTrash ? `; ${s.inTrash} already in the trash (${hint} list)` : ''}`]);
    }
    if (cmd === 'trash') {
        if (!safe && !args.length) throw new Refusal('trash takes ids from scan, or --safe for every trash verdict');
        const t = cmdTrash(repo, args, safe);
        process.exitCode = t.failed.length ? 1 : 0;
        return say(t, () => [
            t.done.length ? 'moved to the trash (local only; nothing on any remote was touched):' : 'nothing moved',
            ...t.done.map(r => `  ${r.id}  ${r.kind} ${r.kind === 'branch' ? r.name : r.from}  @${(r.sha ?? '').slice(0, 9)}`),
            ...(t.failed.length ? ['left in place:', ...t.failed.map(f => `  ${f.id}  ${f.why}`)] : []),
            ...(t.done.length ? [`undo: ${hint} restore <id>   see: ${hint} list   the trash stays until you empty it: ${hint} empty --all | --older 30d | <id>`] : []),
        ]);
    }
    if (cmd === 'list') {
        const rows = cmdList(repo, all);
        return say(rows, () => rows.length ? rows.map(r => `${all ? r.repo + '  ' : ''}${r.id}  ${ago(Date.parse(r.at)).padStart(3)}  ${r.kind.padEnd(13)} ${r.kind === 'branch' ? r.name : r.from}`) : ['the trash is empty']);
    }
    if (cmd === 'restore') {
        if (args.length !== 1) throw new Refusal('restore takes one trash id (see: list)');
        const r = cmdRestore(repo, args[0], as);
        return say(r, () => ['restored: ' + r.notes.join('; ')]);
    }
    if (cmd === 'empty') {
        const e = cmdEmpty(repo, args, olderArg === undefined ? undefined : parseAge(olderArg), Boolean(all));
        process.exitCode = e.failed.length ? 1 : 0;
        return say(e, () => [`deleted for good: ${e.gone.length ? e.gone.join(' ') : 'nothing'}`, ...e.notes, ...e.failed.map(f => `kept ${f.id}: ${f.why}`)]);
    }
    console.error('usage: node prune.mjs scan | trash <id ...>|--safe | list [--all] | restore <id> [--as <name>] | empty [--older 30d] [<id> ...] | --selftest   [--repo <dir>] [--json]');
    process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
    try { main(process.argv.slice(2)); } catch (e) {
        console.error(e instanceof Refusal ? e.message : e.stack);
        process.exitCode = 1;
    }
}
