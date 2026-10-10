// fleet-manifest.mts - proof that the shipped .mjs files are what their TypeScript sources compile to,
// checkable without the compiler.
//
// The self-test can rebuild and compare only where `npm install --prefix src` put the pinned tsc, and a
// fresh clone has none: there a source edited without a rebuild, or a .mjs edited by hand, went unnoticed
// while the fleet ran the old .mjs. So the build records a SHA-256 of every source and every output in
// src/build.sha256, and `check` recomputes them with node alone.
//
//   node scripts/fleet-manifest.mjs write    after tsc (`npm run build --prefix src` does it)
//   node scripts/fleet-manifest.mjs check    exit 0 when every file matches, 1 with the paths that do not

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..').split('\\').join('/');
const MANIFEST = `${ROOT}/src/build.sha256`;
// Each source tree and where tsc writes its output (the tsconfig's outDir).
const TREES: Array<[string, string]> = [['src', ''], ['tools/src', 'tools']];

function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(`${dir}/${rel}`, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else if (e.name.endsWith('.mts')) out.push(r);
  }
  return out;
}

// Every source and the output it compiles to, as repo-relative paths, sorted.
function files(): string[] {
  const all: string[] = [];
  for (const [src, outDir] of TREES) {
    for (const r of walk(`${ROOT}/${src}`)) {
      all.push(`${src}/${r}`, `${outDir ? `${outDir}/` : ''}${r.slice(0, -4)}.mjs`);
    }
  }
  return all.sort();
}

// Hashed with LF line ends: git checks .mts and .mjs out as LF (.gitattributes), so a file built from a
// CRLF copy on one machine is the same file on every clone.
const sha = (p: string): string => existsSync(`${ROOT}/${p}`)
  ? createHash('sha256').update(readFileSync(`${ROOT}/${p}`, 'utf8').split('\r\n').join('\n')).digest('hex') : 'missing';

// The directories tsc writes into, and every .mjs there: one with no source left behind is stale too.
const OUTPUT_DIRS = ['scripts', 'scripts/fleet', 'hooks', 'tools/hooks'];
function outputs(): string[] {
  const out: string[] = [];
  for (const d of OUTPUT_DIRS) {
    try { for (const n of readdirSync(`${ROOT}/${d}`)) if (n.endsWith('.mjs')) out.push(`${d}/${n}`); } catch { /* none */ }
  }
  return out;
}

function main(mode: string | undefined): number {
  if (mode === 'write') {
    const all = files();
    const missing = all.filter((f) => sha(f) === 'missing');
    // A source tsc did not compile (outside the tsconfig `include`) would otherwise be recorded as fine.
    if (missing.length) { process.stderr.write(`fleet-manifest: not built: ${missing.join(' ')}\n`); return 1; }
    writeFileSync(MANIFEST, all.map((f) => `${sha(f)}  ${f}\n`).join(''));
    return 0;
  }
  if (mode === 'check') {
    if (!existsSync(MANIFEST)) { process.stdout.write('STALE: src/build.sha256 is missing: run npm run build --prefix src\n'); return 1; }
    const want = new Map<string, string>();
    for (const l of readFileSync(MANIFEST, 'utf8').split('\n')) {
      const m = /^([0-9a-f]{64}|missing) {2}(.+)$/.exec(l.replace(/\r$/, ''));
      if (m) want.set(m[2] ?? '', m[1] ?? '');
    }
    const bad: string[] = [];
    const now = files();
    for (const f of now) if (want.get(f) !== sha(f)) bad.push(f);
    for (const f of want.keys()) if (!now.includes(f)) bad.push(`${f} (gone)`);
    for (const f of outputs()) if (!now.includes(f)) bad.push(`${f} (no source)`);
    if (bad.length) {
      process.stdout.write(`STALE: changed since the last build, or never built: ${bad.join(' ')}\n  run npm run build --prefix src\n`);
      return 1;
    }
    process.stdout.write(`BUILD CURRENT: ${now.length} files match src/build.sha256\n`);
    return 0;
  }
  process.stderr.write('usage: node fleet-manifest.mjs write|check\n');
  return 2;
}

process.exitCode = main(process.argv[2]);
