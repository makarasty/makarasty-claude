import http from 'node:http';
import { AppError, NotFoundError, ValidationError } from './errors.js';
import { createRouter } from './router.js';

const MAX_BODY = 1024 * 1024;

function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY) {
                reject(new ValidationError('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (size === 0) return resolve(undefined);
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                reject(new ValidationError('request body is not valid JSON'));
            }
        });
        req.on('error', reject);
    });
}

function parseBool(value) {
    if (value === null) return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new ValidationError('done must be "true" or "false"');
}

function send(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
}

export function createServer({ tracker }) {
    const router = createRouter();

    router.add('GET', '/health', () => ({ status: 200, body: { ok: true } }));
    router.add('POST', '/tasks', ({ body }) => ({ status: 201, body: tracker.createTask(body) }));
    router.add('GET', '/tasks', ({ query }) => ({
        status: 200,
        body: {
            tasks: tracker.listTasks({
                userId: query.get('userId') ?? undefined,
                done: parseBool(query.get('done')),
            }),
        },
    }));
    router.add('GET', '/tasks/:id', ({ params }) => ({ status: 200, body: tracker.getTask(params.id) }));
    router.add('POST', '/tasks/:id/complete', ({ params }) => ({ status: 200, body: tracker.completeTask(params.id) }));

    return http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://localhost');
            const route = router.match(req.method, url.pathname);
            if (!route) throw new NotFoundError(`no route for ${req.method} ${url.pathname}`);
            const body = req.method === 'POST' || req.method === 'PUT' ? await readJson(req) : undefined;
            const result = await route.handler({ params: route.params, query: url.searchParams, body });
            send(res, result.status, result.body);
        } catch (err) {
            if (err instanceof AppError) {
                send(res, err.status, { error: { code: err.code, message: err.message } });
            } else {
                console.error(err);
                send(res, 500, { error: { code: 'internal_error', message: 'internal error' } });
            }
        }
    });
}
