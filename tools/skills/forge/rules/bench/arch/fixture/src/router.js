// Minimal path router: "/tasks/:id/complete" -> params { id }.
export function createRouter() {
    const routes = [];
    return {
        add(method, path, handler) {
            const keys = [];
            const source = path.replace(/:([A-Za-z]+)/g, (_, key) => {
                keys.push(key);
                return '([^/]+)';
            });
            routes.push({ method, re: new RegExp(`^${source}/?$`), keys, handler });
        },
        match(method, pathname) {
            for (const route of routes) {
                if (route.method !== method) continue;
                const m = route.re.exec(pathname);
                if (!m) continue;
                const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
                return { handler: route.handler, params };
            }
            return null;
        },
    };
}
