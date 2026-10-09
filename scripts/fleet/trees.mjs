// trees.mts - worktrees: worktree, unlink, clean. Part of fleet.mjs; see src/scripts/fleet.mts.
//
// The one destructive path in the plugin outside its own scratch. The procedure and the measurement behind
// the unlink-first step are in docs/WORKTREES.md [M32]; the reasoning behind the guards in docs/SAFETY.md.
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { posix } from 'node:path';
import { cal, err, field, isDir, names, need, out, read, slashes, nativePath, cksum } from './lib.mjs';
// `$(git ... 2>/dev/null || echo "")`: stdout with its trailing newlines cut whether git succeeded or not,
// and whether it did, for the `if git ...` callers. stderr is dropped unless the sh lets it through.
function git(args, stderr = 'ignore') {
    const r = spawnSync('git', args, { encoding: 'utf8', stdio: ['inherit', 'pipe', stderr], maxBuffer: 1 << 28 });
    return { ok: r.status === 0, out: (r.stdout || '').replace(/\n+$/, '') };
}
// `git ... >/dev/null 2>&1`, asked only whether it succeeded.
const gitQuiet = (args) => spawnSync('git', args, { stdio: ['inherit', 'ignore', 'ignore'] }).status === 0;
// `[ -L p ] || [ -e p ]`
function there(p) { try {
    lstatSync(p);
    return true;
}
catch {
    return false;
} }
const lines = (s) => s.split('\n');
// ---- the path gate ---------------------------------------------------------------------------------------
//
// WHY THIS EXISTS, before what it does - because the reason is what makes the rule survive an edit:
//
// A path is almost never got wrong in the middle. It is got wrong at the END, and always the same way: a
// variable that was empty, a `dirname` taken once too often, a split on the wrong character, a prefix
// stripped twice. Every one of those turns a path into its own PARENT. So the depth of a path is exactly
// its margin for error, counted in mistakes:
//
//   C:/wtmerge                        one slip from C:/ - the whole drive
//   <project>/.claude/worktrees/wtA   seven slips from C:/, and the first four land in directories this
//                                     plugin owns and would refuse
//
// A worktree at the root of a drive has no margin at all. Nothing about it is wrong today; it becomes
// wrong the first time somebody edits the deletion code and is slightly careless, and by then it takes the
// disk with it. Depth is the cheapest defence there is against a mistake nobody has made yet.
//
// Therefore: this plugin deletes nothing that is not absolute, deep, free of `..`, inside a directory it
// owns, and outside its own working directory.
// The floor, as a string: the refusal prints it as calibration spelled it.
function minFloor(c) {
    let m = cal(c, 'min_path_segments', '4');
    // A floor that is not a whole number must tighten the guard, never disable it.
    if (!/^[0-9]+$/.test(m))
        m = '4';
    if (Number(m) < 2)
        m = '2';
    return m;
}
const lowerAscii = (s) => s.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
// The reason the path is unsafe, or '' when it is safe. `keeps`: the caller deletes nothing (it registers,
// or unlinks the links inside a tree), so the working-directory term is skipped.
function unsafePath(path, needSeg, keeps, min) {
    if (!path)
        return 'the path is empty';
    const p = path.endsWith('/') ? path.slice(0, -1) : path; // a trailing slash must not change any answer
    if (p.startsWith('//'))
        return `${p} is a network path, which this does not delete`;
    if (!/^(\/|[A-Za-z]:\/)/.test(p))
        return `${p} is not absolute, so what it points at depends on where this ran`;
    if (`/${p}/`.includes('/../'))
        return `${p} contains .., so where it lands cannot be read off the path`;
    if (`/${p}/`.includes('/./'))
        return `${p} contains a . segment, which hides how deep it really is`;
    // Count named components with any drive letter dropped first, so Windows and POSIX are measured on one
    // scale: C:/a/b/c and /a/b/c are both three.
    const depth = p.replace(/^[A-Za-z]:/, '').split(/[/\n]/).filter((s) => s !== '').length;
    if (depth < Number(min))
        return `${p} is ${depth} level(s) below the root and the floor is ${min}: too shallow to delete safely`;
    if (needSeg) {
        // Something must FOLLOW the segment: the `worktrees` directory itself is not a worktree, and deleting
        // it would take every other run's trees with it.
        const s = `/${p}/`, i = s.indexOf(`/${needSeg}/`);
        if (i < 0 || i + needSeg.length + 2 >= s.length)
            return `${p} is not inside a ${needSeg} directory, the only place this may delete`;
    }
    // Deleting the directory this process stands in, or one above it, is how a script removes its own
    // footing and then keeps going. fleet.sh reads it in git's spelling (`pwd -W`), which is node's cwd.
    // ponytail: PWD too when it names this directory: a POSIX shell in a symlinked path spells `pwd` logically.
    if (!keeps) {
        const lp = lowerAscii(p), heres = [slashes(process.cwd())], pwd = process.env.PWD || '';
        try {
            if (pwd && realpathSync(pwd) === realpathSync(process.cwd()))
                heres.push(slashes(pwd));
        }
        catch { /* a stale PWD names nothing here */ }
        for (const h of heres) {
            if (h && `${lowerAscii(h.endsWith('/') ? h.slice(0, -1) : h)}/`.startsWith(`${lp}/`))
                return `${p} is this shell's working directory or one above it`;
        }
    }
    return '';
}
// ---- links -----------------------------------------------------------------------------------------------
// `find <d> -type l`: every symlink or junction under d at any depth, in directory order, never entering one.
function findLinks(d) {
    const found = [];
    const walk = (dir) => {
        let ents;
        try {
            ents = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const n of ents) {
            const p = dir.endsWith('/') ? dir + n : `${dir}/${n}`;
            let s;
            try {
                s = lstatSync(p);
            }
            catch {
                continue;
            }
            if (s.isSymbolicLink())
                found.push(p);
            else if (s.isDirectory())
                walk(p);
        }
    };
    let s;
    // find tests its start point too, and follows it only when it is spelled with a trailing slash.
    try {
        s = d.endsWith('/') ? statSync(d) : lstatSync(d);
    }
    catch {
        return found;
    }
    if (s.isSymbolicLink())
        found.push(d);
    else if (s.isDirectory())
        walk(d);
    return found;
}
// Unlink every reparse point inside a tree, at any depth, leaving what they point at alone. This is the
// step that makes a later recursive delete safe: `git worktree remove` follows a junction and removes the
// target's contents, at the top level and nested [M32]. unlinkSync on a junction removes the link only
// (checked on a junction to a directory holding a file: the file stays). Returns how many are gone.
function unlinkLinks(d) {
    let n = 0;
    for (const e of findLinks(d)) {
        try {
            unlinkSync(e);
        }
        catch { /* the rmdir below */ }
        // Windows: should the link survive, `rmdir` removes the link, never its target.
        if (there(e)) {
            spawnSync('cmd', ['/c', `rmdir "${posix.basename(e)}"`], { cwd: posix.dirname(e), stdio: 'ignore', windowsVerbatimArguments: true });
        }
        // Counted only once it is really gone. Callers re-scan rather than trust this number.
        if (!there(e))
            n++;
    }
    return n;
}
// ---- worktree --------------------------------------------------------------------------------------------
// POSIX `cksum`: CRC-32 (MSB first) over the bytes and then the length, printed as `<crc> <length>`.
const cksumLine = (s) => `${cksum(s)} ${Buffer.byteLength(s, 'utf8')}`;
// A worktree worker records its tree at its first claim, so `clean` later acts on THIS run's worktrees and
// no other run's. A path not under a `.claude/worktrees/` segment is refused: a worker not actually in a
// worktree has nothing to register, and recording its cwd would point `clean` at the project root.
function worktree(c, chip, arg, baseArg) {
    let wt = arg || slashes(process.cwd());
    // `--create [base]`: the session is not in a worktree of its own, so make one where cleanup can reach it,
    // link the dependencies, and register it. A coordinator with no such command put its trees at C:/wtRM01,
    // where registration refuses them and `clean` can never remove one.
    if (wt === '--create') {
        const g = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
        if (!g.ok) {
            err('not inside a git checkout\n');
            return 2;
        }
        const common = g.out;
        const main = posix.dirname(common);
        // The branch the coordinator merges into is the main checkout's current one; HEAD when it is detached.
        let base = baseArg;
        if (!base) {
            const h = git(['-C', main, 'symbolic-ref', '--short', 'HEAD']);
            base = h.ok ? h.out : 'HEAD';
        }
        const tag = cksumLine(posix.basename(c.absrun)).slice(0, 5);
        wt = `${main}/.claude/worktrees/fleet-${tag}-${chip}`;
        // Reuse needs the directory as well as git's record of it: a tree deleted by hand stays listed until
        // pruned, and "reusing" it handed the worker a path that does not exist.
        if (isDir(wt) && lines(git(['-C', main, 'worktree', 'list', '--porcelain'], 'inherit').out).includes(`worktree ${wt}`)) {
            out(`reusing ${wt}\n`);
        }
        else {
            gitQuiet(['-C', main, 'worktree', 'prune']);
            // A tree inside the checkout must not show up as untracked work in it. info/exclude is local to this
            // clone; it may not exist, and a last line with no newline would have the entry glued onto it.
            if (!gitQuiet(['-C', main, 'check-ignore', '-q', '.claude/worktrees/x'])) {
                const ex = `${common}/info/exclude`;
                mkdirSync(`${common}/info`, { recursive: true });
                let cur = Buffer.alloc(0);
                try {
                    cur = readFileSync(ex);
                }
                catch { /* none yet */ }
                if (cur.length && cur[cur.length - 1] !== 0x0a)
                    appendFileSync(ex, '\n');
                appendFileSync(ex, '.claude/worktrees/\n');
            }
            if (spawnSync('git', ['-C', main, 'worktree', 'add', '--detach', wt, base], { stdio: ['inherit', 'ignore', 'inherit'] }).status !== 0) {
                err(`git worktree add failed for ${wt} at ${base}\n`);
                return 2;
            }
            out(`created ${wt} at ${base}\n`);
        }
        // Dependencies are linked, not installed: one install per worktree is minutes and gigabytes. On reuse
        // too: a tree unlinked before `drained` comes back with no links. Every real node_modules within three
        // levels of the main checkout (a monorepo keeps them at apps/web/node_modules), never entering one.
        for (const nm of nodeModules(main)) {
            const relnm = nm.startsWith(`${main}/`) ? nm.slice(main.length + 1) : nm;
            const link = `${wt}/${relnm}`;
            if (!isDir(posix.dirname(link)) || existsSync(link))
                continue;
            const made = process.platform === 'win32'
                ? spawnSync('cmd', ['/c', 'mklink', '/J', link.split('/').join('\\'), nm.split('/').join('\\')], { stdio: ['inherit', 'ignore', 'inherit'] }).status === 0
                : spawnSync('ln', ['-s', nm, link], { stdio: 'inherit' }).status === 0;
            if (made)
                out(`linked ${relnm}\n`);
            else
                err(`warning: could not link ${relnm} into ${wt}; the worker there has no dependencies for it\n`);
        }
        out(`WORKTREE ${wt}\n`);
        out(`  Work there by absolute path, and start each task on its own branch: git -C "${wt}" switch -c <branch> ${base}\n`);
        out('  Never delete it yourself: the links in it lead into the main checkout. fleet.sh unlink, then clean.\n');
    }
    // Stored in git's own spelling, so `clean` can match it against `git worktree list` exactly.
    const canon = git(['-C', wt, 'rev-parse', '--show-toplevel']).out;
    if (canon)
        wt = canon;
    // Caught when the tree is CREATED, the moment somebody can still move it. Registration deletes nothing
    // and its default is the worker's own cwd, so the working-directory term is skipped.
    const why = unsafePath(wt, '.claude/worktrees', true, minFloor(c));
    if (why) {
        err(`REFUSED to register this worktree: ${why}\n`);
        err('  A worktree this plugin can clean up lives under <project>/.claude/worktrees/, which is where\n');
        err(`  the harness's own EnterWorktree puts it. Move it with:  git worktree move "${wt}" <project>/.claude/worktrees/<name>\n`);
        return 2;
    }
    const br = git(['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD']).out;
    mkdirSync(`${c.run}/worktrees`, { recursive: true });
    writeFileSync(`${c.run}/worktrees/${chip}`, `path ${wt}\nbranch ${br}\nchip ${chip}\n`);
    out(`registered worktree ${wt} (branch ${br || 'unknown'}) for chip ${chip}\n`);
    return 0;
}
// `find <main> -maxdepth 3 \( -name .git -o -name .claude \) -prune -o -type d -name node_modules -print -prune`
function nodeModules(main) {
    const found = [];
    const walk = (dir, depth) => {
        let ents;
        try {
            ents = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const n of ents) {
            if (n === '.git' || n === '.claude')
                continue;
            const p = `${dir}/${n}`;
            let s;
            try {
                s = lstatSync(p);
            }
            catch {
                continue;
            }
            if (!s.isDirectory())
                continue;
            if (n === 'node_modules')
                found.push(p);
            else if (depth < 3)
                walk(p, depth + 1);
        }
    };
    walk(main, 1);
    return found;
}
// ---- unlink ----------------------------------------------------------------------------------------------
// A worker leaving its worktree needs the unlink as a command rather than as a sentence in a document: it is
// the step most likely to be skipped. Safe to run twice and on a tree with no links. The path is this
// command's run-directory argument.
function unlink(c) {
    let wt = c.run;
    const t = git(['-C', wt, 'rev-parse', '--show-toplevel']).out;
    if (t)
        wt = t;
    // Only the reparse points inside the tree are deleted, never the tree, so the working-directory term does
    // not apply: the documents call this from inside the tree, the last thing a worker does there [M32].
    const why = unsafePath(wt, '.claude/worktrees', true, minFloor(c));
    if (why) {
        err(`REFUSED: ${why}\n`);
        return 2;
    }
    const n = unlinkLinks(wt);
    out(`unlinked ${n} reparse point(s) under ${wt}\n`);
    // A link that would not go is the whole hazard, so it is named and the exit says so.
    const left = findLinks(wt);
    if (left.length) {
        err(`STILL LINKED: ${left.length} reparse point(s) under ${wt} would not unlink. Nothing may delete this tree:\n`);
        err(left.map((l) => `  ${l}\n`).join(''));
        return 1;
    }
    return 0;
}
// ---- clean -----------------------------------------------------------------------------------------------
// The `locked` line of one tree's block in `git worktree list --porcelain`.
function locked(list, wt) {
    let f = false;
    for (const l of lines(list)) {
        if (l === `worktree ${wt}`) {
            f = true;
            continue;
        }
        if (l.startsWith('worktree '))
            f = false;
        if (f && l.startsWith('locked'))
            return true;
    }
    return false;
}
// Remove the worktrees this run created. Dry run unless --remove. There is deliberately no flag that
// deletes a tree holding work: the operator does that in git, having seen the reason printed here.
function clean(c, args) {
    const doRemove = args.includes('--remove');
    const min = minFloor(c);
    // One listing for the whole command.
    const wtlist = git(['worktree', 'list', '--porcelain']).out;
    const trees = lines(wtlist).filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
    // The main checkout is the first tree git lists, never `--show-toplevel`, which from inside a linked
    // worktree names that worktree.
    const main = trees[0] ?? '';
    // A worktree this run cannot clean is named rather than ignored: only the operator can move it. Never touched.
    for (const w of trees) {
        if (!w || w === main)
            continue;
        const why = unsafePath(w, '.claude/worktrees', false, min);
        if (why) {
            out(`STRAY ${why}\n`);
            out("      nothing here will delete it. Move it under <project>/.claude/worktrees/ with 'git worktree move', or remove it yourself.\n");
        }
    }
    const reg = `${c.run}/worktrees`;
    let regd = [];
    try {
        regd = readdirSync(reg);
    }
    catch { /* none */ }
    if (!isDir(reg) || !regd.length) {
        out('no worktrees registered for this run; nothing to clean\n');
        out(`(a worktree worker registers itself with 'fleet.sh worktree "${c.absrun}" <chip>'; a run with none is not swept)\n`);
        return 0;
    }
    let removed = 0, kept = 0;
    for (const chip of names(reg)) {
        const entry = `${reg}/${chip}`;
        if (!existsSync(entry))
            continue;
        // Git Bash's sed reads in text mode: a CRLF registration reads as LF there.
        const text = read(entry).split('\r\n').join('\n');
        let wt = field(text, /^path (.*)$/s);
        // The integration checkout serves every pane check and holds the run's merges; a fast-forward merge
        // leaves its tip inside a task branch, so mid-run it would read as removable.
        if (chip === 'integration' && !existsSync(`${c.run}/FINISHED`)) {
            out(`KEEP  integration: ${wt} is the run's integration checkout and the run has not landed\n`);
            kept++;
            continue;
        }
        // git's own spelling while the tree is on disk, so the membership test matches `git worktree list`.
        if (existsSync(nativePath(wt))) {
            const t = git(['-C', nativePath(wt), 'rev-parse', '--show-toplevel']).out;
            if (t)
                wt = t;
        }
        // The branch read from the tree NOW, never the registration: a worker may have switched since.
        let br = git(['-C', nativePath(wt), 'rev-parse', '--abbrev-ref', 'HEAD']).out;
        if (!br)
            br = field(text, /^branch (.*)$/s);
        // A detached tree says the literal HEAD, which the hints must never tell anybody to `git branch -D`.
        const brshow = br === 'HEAD' ? '' : br;
        // 1. The path gate, before anything reads the tree.
        const why = unsafePath(wt, '.claude/worktrees', false, min);
        if (why) {
            out(`SKIP  ${chip}: ${why}\n`);
            kept++;
            continue;
        }
        if (main && wt === main) {
            out(`SKIP  ${chip}: ${wt} is the main checkout\n`);
            kept++;
            continue;
        }
        if (!lines(wtlist).includes(`worktree ${wt}`)) {
            if (existsSync(nativePath(wt))) {
                out(`SKIP  ${chip}: ${wt} exists but git does not call it a worktree - leaving it for a human\n`);
                kept++;
            }
            else {
                out(`gone  ${chip}: ${wt} already removed\n`);
                if (doRemove)
                    gitQuiet(['worktree', 'prune']);
            }
            continue;
        }
        // 2. A locked worktree is one git will refuse: found out BEFORE unlinking anything, or the tree is left
        //    worse than it was found while the message claims nothing changed.
        if (locked(wtlist, wt)) {
            out(`SKIP  ${chip}: ${wt} is locked. Unlock it with 'git worktree unlock' if you meant to remove it\n`);
            kept++;
            continue;
        }
        // 3. Keep anything holding work: uncommitted changes, or commits neither in the main checkout's
        //    branch, nor on the upstream, nor on another local branch.
        const dirty = git(['-C', wt, 'status', '--porcelain']).out !== '';
        let unpushed = false;
        let brdesc;
        if (!br || br === 'HEAD') {
            // Detached: the commits belong to no branch unless some branch already contains them, which is the
            // shape `worktree --create` leaves a tree in until its first task starts a branch.
            brdesc = 'a detached HEAD';
            const sha = git(['-C', wt, 'rev-parse', 'HEAD']).out;
            if (!sha || (lines(git(['-C', wt, 'for-each-ref', '--contains', sha, 'refs/heads', 'refs/remotes']).out)[0] ?? '') === '')
                unpushed = true;
        }
        else {
            brdesc = br;
            // The question `git branch -d` asks, answered BEFORE the tree goes. Fail safe: anything not provably
            // merged or pushed counts as work.
            let merged = false;
            let mb = main ? git(['-C', main, 'rev-parse', '--abbrev-ref', 'HEAD']).out : '';
            // A detached main checkout says HEAD, which inside the worktree resolves to the worktree's own tip.
            if (mb === 'HEAD')
                mb = '';
            if (mb && gitQuiet(['-C', wt, 'merge-base', '--is-ancestor', br, mb]))
                merged = true;
            if (!merged) {
                const up = git(['-C', wt, 'rev-parse', '--abbrev-ref', `${br}@{upstream}`]).out;
                if (up && gitQuiet(['-C', wt, 'merge-base', '--is-ancestor', br, up]))
                    merged = true;
            }
            // Merged into another local branch holds too: tasks merge into the run's integration branch, which
            // the owner lands later.
            if (!merged) {
                const tip = git(['-C', wt, 'rev-parse', br]).out;
                if (tip && lines(git(['-C', wt, 'for-each-ref', '--contains', tip, '--format=%(refname:short)', 'refs/heads']).out).some((l) => l !== br && l !== ''))
                    merged = true;
            }
            if (!merged)
                unpushed = true;
        }
        if (dirty || unpushed) {
            let w = dirty ? 'uncommitted changes' : '';
            if (unpushed)
                w = `${w ? `${w}, ` : ''}commits on ${brdesc} neither merged nor pushed`;
            out(`KEEP  ${chip}: ${wt} has ${w}\n`);
            out(`      it stays. If you have written it off: git worktree remove --force "${wt}" (after 'fleet.sh unlink' on it)${brshow ? `, then git branch -D ${brshow}` : ''}\n`);
            kept++;
            continue;
        }
        // 4. Ignored files are invisible to every check above and go with the tree. Say what they are: a .env
        //    is exactly what a person did not mean to lose.
        const ign = lines(git(['-C', wt, 'status', '--porcelain', '--ignored']).out)
            .filter((l) => l.startsWith('!! ')).slice(0, 5).map((l) => `${l.slice(3)} `).join('');
        if (!doRemove) {
            const links = findLinks(wt).length;
            out(`would remove  ${chip}: ${wt}${brshow ? `  then branch -d ${brshow}` : ''}\n`);
            if (links)
                out(`              unlinks ${links} reparse point(s) first\n`);
            if (ign)
                out(`              ignored files that go with it: ${ign}\n`);
            continue;
        }
        if (ign)
            out(`      ignored files removed with the tree: ${ign}\n`);
        // 5. Unlink every reparse point, at any depth, before anything recursive runs [M32].
        unlinkLinks(wt);
        // A link that survived the unlink is the hole [M32] is about, so the tree is not removed over it.
        const left = findLinks(wt).length;
        if (left) {
            out(`SKIP  ${chip}: ${left} reparse point(s) under ${wt} would not unlink, and git would follow them. Nothing\n`);
            out(`      was removed. Unlink them by hand ('fleet.sh unlink "${wt}"' names them), then re-run\n`);
            kept++;
            continue;
        }
        // 6. No --force: a tree holding work was kept above, so a refusal here is something this code did not
        //    anticipate and the tree stays as it is.
        if (spawnSync('git', ['worktree', 'remove', wt], { stdio: ['inherit', 'inherit', 'ignore'] }).status === 0) {
            gitQuiet(['worktree', 'prune']);
            const m = main || '.';
            // 7. The branch, by the merge-checking form only. -D is never used here.
            if (br && br !== 'HEAD') {
                if (gitQuiet(['-C', m, 'branch', '-d', br]))
                    out(`removed  ${chip}: ${wt} and branch ${br}\n`);
                else
                    out(`removed  ${chip}: ${wt} (branch ${br} kept: git will not delete it, so it still holds something)\n`);
            }
            else {
                out(`removed  ${chip}: ${wt}\n`);
            }
            // A worker cuts one branch per task, fleet/<chip>/<task-id>, and only the last is checked out here.
            for (const tb of git(['-C', m, 'for-each-ref', '--format=%(refname:short)', `refs/heads/fleet/${chip}/`]).out.split(/[ \t\n]+/)) {
                if (tb && gitQuiet(['-C', m, 'branch', '-d', tb]))
                    out(`         branch ${tb} deleted (merged)\n`);
            }
            try {
                unlinkSync(entry);
            }
            catch { /* rm -f */ }
            removed++;
        }
        else {
            out(`SKIP  ${chip}: git refused to remove ${wt}. Its links were unlinked first, so re-run once the\n`);
            out('      reason is cleared; nothing else about the tree was changed\n');
            kept++;
        }
    }
    out(doRemove ? `clean: ${removed} removed, ${kept} kept\n` : 'dry run: nothing was changed. Add --remove to act.\n');
    return 0;
}
export const commands = {
    worktree: (c, a) => worktree(c, need(c, a[0], 3, 'chip id required'), a[1] ?? '', a[2] ?? ''),
    unlink: (c) => unlink(c),
    clean: (c, a) => clean(c, a),
};
