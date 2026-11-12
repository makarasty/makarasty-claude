// Git Bash rewrites an argument that starts with / into a path under its install folder, quoted or not
// (`/settings` -> `C:/Program Files/Git/settings`). unmsys undoes it for free text, selectors and routes, never for file paths.
// Only when MSYSTEM is set; the root comes from EXEPATH or SHELL. Self-check: node msys.mjs --selftest
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootOf = (env) => {
    const e = env.MSYSTEM && (env.EXEPATH || env.SHELL);
    if (!e) return '';
    const p = e.replaceAll('\\', '/').replace(/\/(usr\/)?bin(\/[^/]*\.exe)?$/i, '');
    return p ? `${p}/` : '';
};

export const unmsys = (s, env = process.env) => {
    const root = rootOf(env);
    return root && typeof s === 'string' && s.toLowerCase().startsWith(root.toLowerCase()) ? `/${s.slice(root.length)}` : s;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--selftest')) {
    const { default: assert } = await import('node:assert/strict');
    const git = { MSYSTEM: 'MINGW64', EXEPATH: 'C:\\Program Files\\Git\\bin' };
    assert.equal(unmsys('C:/Program Files/Git/settings/x', git), '/settings/x');
    assert.equal(unmsys('c:/program files/git/html/body', git), '/html/body', 'prefix is case-insensitive');
    assert.equal(unmsys('C:/Program Files/Git/x', { EXEPATH: git.EXEPATH }), 'C:/Program Files/Git/x', 'no MSYSTEM: untouched');
    assert.equal(unmsys('#app', git), '#app');
    assert.equal(unmsys('C:/other/x', git), 'C:/other/x');
    assert.equal(unmsys('C:/Program Files/Git/usr/x', { MSYSTEM: 'MSYS', SHELL: 'C:\\Program Files\\Git\\usr\\bin\\bash.exe' }), '/usr/x', 'root from SHELL');
    assert.equal(unmsys(undefined, git), undefined);
    console.log('msys.mjs selftest: ok');
}
