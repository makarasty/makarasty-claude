// Tests for the sitemap route source of walk.mjs. walk.mjs is a script that runs on import, so the function is cut out of
// its source and run against a local http server; the fake page runs the in-page function in Node, where fetch behaves the same.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./walk.mjs', import.meta.url)), 'utf8');
const body = source.match(/async function sitemap\(page\) \{[\s\S]*?\n\}\n/)?.[0];
assert.ok(body, 'async function sitemap(page) not found in walk.mjs');
const build = new Function('ev', 'ORIGIN', 'HOST', 'BASE', `${body}\nreturn sitemap;`);
const fakePage = {};
const ev = (_page, fn, arg) => Promise.resolve().then(() => fn(arg));

const urlset = (...locs) => `<?xml version="1.0"?><urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join('')}</urlset>`;
const xml = { 'content-type': 'application/xml' };

const serve = async (routes) => {
    const server = createServer((req, res) => {
        const r = routes(req.url);
        if (!r) {
            res.writeHead(404, { 'content-type': 'text/html' });
            res.end('not found');
            return;
        }
        res.writeHead(200, r.headers ?? xml);
        res.end(r.text);
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const origin = `http://127.0.0.1:${server.address().port}`;
    return { server, origin };
};

const servers = [];
after(() => servers.forEach((s) => s.close()));
const walkSitemap = async (routes, base = '') => {
    const s = await serve((u) => routes(u, () => s.origin));
    servers.push(s.server);
    return build(ev, s.origin + base, s.origin, base)(fakePage);
};

describe('walk sitemap route source', () => {
    it('reads a plain sitemap: same-origin paths with their query, other hosts and malformed locs skipped', async () => {
        const routes = await walkSitemap((url, origin) =>
            url === '/sitemap.xml' ? { text: urlset(`${origin()}/`, `${origin()}/a`, `${origin()}/b/1?tab=x`, 'http://elsewhere.test/c', 'not a url') } : null,
        );
        assert.deepEqual(routes, ['/', '/a', '/b/1?tab=x']);
    });

    it('follows a sitemap index into its sitemaps and merges them', async () => {
        const routes = await walkSitemap((url, origin) => {
            if (url === '/sitemap.xml') return { text: `<sitemapindex><sitemap><loc>${origin()}/s1.xml</loc></sitemap><sitemap><loc>${origin()}/s2.xml</loc></sitemap></sitemapindex>` };
            if (url === '/s1.xml') return { text: urlset(`${origin()}/one`) };
            if (url === '/s2.xml') return { text: urlset(`${origin()}/two`, `${origin()}/three`) };
            return null;
        });
        assert.deepEqual(routes, ['/one', '/two', '/three']);
    });

    it('keeps only locs under the base path and strips it', async () => {
        const routes = await walkSitemap(
            (url, origin) => (url === '/app/sitemap.xml' ? { text: urlset(`${origin()}/app/x`, `${origin()}/application`, `${origin()}/other`) } : null),
            '/app',
        );
        assert.deepEqual(routes, ['/x']);
    });

    it('returns no routes, without throwing, for an absent sitemap, a non-xml answer, text with no loc and a dead server', async () => {
        assert.deepEqual(await walkSitemap(() => null), []);
        assert.deepEqual(await walkSitemap(() => ({ text: '<html>spa shell</html>', headers: { 'content-type': 'text/html' } })), []);
        assert.deepEqual(await walkSitemap(() => ({ text: '<urlset><url><loc>http://' })), []);
        const dead = await serve(() => null);
        dead.server.close();
        assert.deepEqual(await build(ev, dead.origin, dead.origin, '')(fakePage), []);
    });

    it('skips an index entry that is missing and still returns the others', async () => {
        const routes = await walkSitemap((url, origin) => {
            if (url === '/sitemap.xml') return { text: `<sitemapindex><sitemap><loc>${origin()}/gone.xml</loc></sitemap><sitemap><loc>${origin()}/ok.xml</loc></sitemap></sitemapindex>` };
            return url === '/ok.xml' ? { text: urlset(`${origin()}/fine`) } : null;
        });
        assert.deepEqual(routes, ['/fine']);
    });
});
