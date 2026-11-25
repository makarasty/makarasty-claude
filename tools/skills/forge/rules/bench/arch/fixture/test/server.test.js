import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeClock, startServer } from './helpers.js';

test('POST /tasks creates and GET /tasks lists', async () => {
    const s = await startServer(fakeClock('2026-01-01T00:00:00Z'));
    try {
        const created = await s.call('POST', '/tasks', { userId: 'u1', title: 'Write docs', due: '2026-01-05T09:00:00Z' });
        assert.equal(created.status, 201);
        assert.equal(created.body.title, 'Write docs');
        const list = await s.call('GET', '/tasks?userId=u1&done=false');
        assert.equal(list.status, 200);
        assert.deepEqual(list.body.tasks.map(t => t.id), [created.body.id]);
    } finally {
        await s.close();
    }
});

test('POST /tasks/:id/complete completes, then 409', async () => {
    const s = await startServer(fakeClock('2026-01-01T00:00:00Z'));
    try {
        const { body } = await s.call('POST', '/tasks', { userId: 'u1', title: 'a' });
        const done = await s.call('POST', `/tasks/${body.id}/complete`);
        assert.equal(done.status, 200);
        assert.equal(done.body.done, true);
        const again = await s.call('POST', `/tasks/${body.id}/complete`);
        assert.equal(again.status, 409);
        assert.equal(again.body.error.code, 'conflict');
    } finally {
        await s.close();
    }
});

test('errors map to status codes', async () => {
    const s = await startServer(fakeClock('2026-01-01T00:00:00Z'));
    try {
        assert.equal((await s.call('POST', '/tasks', { userId: 'u1' })).status, 400);
        assert.equal((await s.call('GET', '/tasks/missing')).status, 404);
        assert.equal((await s.call('GET', '/nowhere')).status, 404);
        assert.equal((await s.call('GET', '/tasks?done=maybe')).status, 400);
        assert.equal((await s.call('GET', '/health')).status, 200);
    } finally {
        await s.close();
    }
});
