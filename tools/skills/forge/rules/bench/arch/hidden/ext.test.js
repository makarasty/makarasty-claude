// Hidden extension tests (follow-up change: yearly and interval recurrence). Copied to <workdir>/__ext__/.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ValidationError, createServer, createTracker } from '../src/index.js';

function clock(startIso) { let t = Date.parse(startIso); const c = () => t; c.set = iso => { t = Date.parse(iso); }; return c; }
const fresh = (iso = '2026-01-01T00:00:00Z') => { const c = clock(iso); return { c, tracker: createTracker({ now: c }) }; };
const rec = (tracker, recurrence, due) => tracker.createTask({ userId: 'u1', title: 'r', due, recurrence });
const nextOf = (tracker, id) => tracker.getTask(tracker.completeTask(id).nextTaskId);

async function http(clk) {
    const server = createServer({ tracker: createTracker({ now: clk }) });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, body) => {
        const res = await fetch(base + path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: await res.json() };
    };
    return { call, close: () => new Promise(r => server.close(r)) };
}

test('E1 yearly keeps month, day and time of day', () => {
    const { tracker } = fresh();
    const a = rec(tracker, { type: 'yearly' }, '2026-06-15T10:00:00Z');
    assert.equal(nextOf(tracker, a.id).due, '2027-06-15T10:00:00.000Z');
});

test('E2 yearly Dec 31 and Feb 28 stay put', () => {
    const { tracker } = fresh();
    assert.equal(nextOf(tracker, rec(tracker, { type: 'yearly' }, '2026-12-31T23:30:00Z').id).due, '2027-12-31T23:30:00.000Z');
    assert.equal(nextOf(tracker, rec(tracker, { type: 'yearly' }, '2027-02-28T00:00:00Z').id).due, '2028-02-28T00:00:00.000Z');
});

test('E3 yearly Feb 29 moves to Feb 28 in a non-leap year and stays on Feb 28', () => {
    const { tracker } = fresh();
    const a = rec(tracker, { type: 'yearly' }, '2028-02-29T12:00:00Z');
    const b = nextOf(tracker, a.id);
    assert.equal(b.due, '2029-02-28T12:00:00.000Z');
    assert.equal(nextOf(tracker, b.id).due, '2030-02-28T12:00:00.000Z');
});

test('E4 interval N days, repeatedly, across a month end', () => {
    const { tracker } = fresh();
    const a = rec(tracker, { type: 'interval', days: 3 }, '2026-01-30T08:00:00Z');
    const b = nextOf(tracker, a.id);
    assert.equal(b.due, '2026-02-02T08:00:00.000Z');
    assert.equal(nextOf(tracker, b.id).due, '2026-02-05T08:00:00.000Z');
    assert.deepEqual(b.recurrence, { type: 'interval', days: 3 });
});

test('E5 interval 365 over a leap day is plain day arithmetic', () => {
    const { tracker } = fresh();
    const a = rec(tracker, { type: 'interval', days: 365 }, '2027-03-01T00:00:00Z');
    assert.equal(nextOf(tracker, a.id).due, '2028-02-29T00:00:00.000Z');
});

test('E6 validation of the new types', () => {
    const { tracker } = fresh();
    const due = '2026-01-01T00:00:00Z';
    for (const [recurrence, d] of [[{ type: 'interval', days: 1 }, due], [{ type: 'interval', days: 366 }, due], [{ type: 'interval', days: 2.5 }, due], [{ type: 'interval', days: '3' }, due], [{ type: 'interval' }, due], [{ type: 'yearly' }, undefined], [{ type: 'interval', days: 3 }, undefined]]) {
        assert.throws(() => tracker.createTask({ userId: 'u1', title: 'x', due: d, recurrence }), ValidationError, JSON.stringify(recurrence));
    }
    assert.equal(tracker.listTasks().length, 0);
});

test('E7 reminders work for the next task of an interval task', () => {
    const { c, tracker } = fresh('2026-05-01T00:00:00Z');
    tracker.setReminderOffsets('u1', [60]);
    const a = rec(tracker, { type: 'interval', days: 2 }, '2026-05-01T10:00:00Z');
    const done = tracker.completeTask(a.id);
    c.set('2026-05-03T09:00:00Z');
    assert.deepEqual(tracker.pollReminders('u1').map(r => r.taskId), [done.nextTaskId]);
    assert.deepEqual(tracker.pollReminders('u1'), []);
});

test('E8 HTTP: yearly and interval recurrence, invalid interval is 400', async () => {
    const s = await http(clock('2026-01-01T00:00:00Z'));
    try {
        const y = await s.call('POST', '/tasks', { userId: 'u1', title: 'Birthday', due: '2026-09-01T07:00:00Z', recurrence: { type: 'yearly' } });
        assert.equal(y.status, 201);
        const yd = await s.call('POST', `/tasks/${y.body.id}/complete`);
        assert.equal(yd.status, 200);
        const i = await s.call('POST', '/tasks', { userId: 'u2', title: 'Pills', due: '2026-09-01T07:00:00Z', recurrence: { type: 'interval', days: 4 } });
        const id = await s.call('POST', `/tasks/${i.body.id}/complete`);
        const list = await s.call('GET', '/tasks?done=false');
        assert.deepEqual(list.body.tasks.map(t => [t.id, t.due]).sort(), [[yd.body.nextTaskId, '2027-09-01T07:00:00.000Z'], [id.body.nextTaskId, '2026-09-05T07:00:00.000Z']].sort());
        assert.equal((await s.call('POST', '/tasks', { userId: 'u1', title: 'bad', due: '2026-09-01T07:00:00Z', recurrence: { type: 'interval', days: 0 } })).status, 400);
    } finally { await s.close(); }
});

test('E9 older recurrence types still behave', () => {
    const { tracker } = fresh();
    assert.equal(nextOf(tracker, rec(tracker, { type: 'daily' }, '2026-01-31T00:00:00Z').id).due, '2026-02-01T00:00:00.000Z');
    assert.equal(nextOf(tracker, rec(tracker, { type: 'monthly', day: 31 }, '2026-01-31T00:00:00Z').id).due, '2026-02-28T00:00:00.000Z');
    assert.equal(nextOf(tracker, rec(tracker, { type: 'weekly', days: [1, 3] }, '2026-03-02T09:30:00Z').id).due, '2026-03-04T09:30:00.000Z');
    assert.throws(() => rec(tracker, { type: 'hourly' }, '2026-01-01T00:00:00Z'), ValidationError);
});
