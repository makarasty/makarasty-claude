import { createServer, createTracker } from '../src/index.js';

export function fakeClock(startIso) {
    let t = Date.parse(startIso);
    const clock = () => t;
    clock.set = iso => { t = Date.parse(iso); };
    clock.advance = ms => { t += ms; };
    return clock;
}

export async function startServer(clock) {
    const tracker = createTracker({ now: clock });
    const server = createServer({ tracker });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, body) => {
        const res = await fetch(base + path, {
            method,
            headers: body === undefined ? {} : { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
    };
    return { call, close: () => new Promise(resolve => server.close(resolve)) };
}
