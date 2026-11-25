// Hidden acceptance tests. Copied to <workdir>/__hidden__/ and run there; import paths assume that.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictError, ValidationError, createServer, createTracker } from '../src/index.js';

function clock(startIso) {
    let t = Date.parse(startIso);
    const c = () => t;
    c.set = iso => { t = Date.parse(iso); };
    return c;
}
const fresh = (iso = '2026-01-01T00:00:00Z') => { const c = clock(iso); return { c, tracker: createTracker({ now: c }) }; };
const rec = (tracker, recurrence, due, extra = {}) => tracker.createTask({ userId: 'u1', title: 'r', due, recurrence, ...extra });
const nextOf = (tracker, id) => tracker.getTask(tracker.completeTask(id).nextTaskId);

async function http(clk) {
    const tracker = createTracker({ now: clk });
    const server = createServer({ tracker });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, body) => {
        const res = await fetch(base + path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: await res.json() };
    };
    return { call, close: () => new Promise(r => server.close(r)) };
}

// ---- recurrence ----

test('01 daily: completing creates the next task one day later, same time of day', () => {
    const { tracker } = fresh();
    const t = rec(tracker, { type: 'daily' }, '2026-03-02T09:30:00Z');
    assert.equal(t.nextTaskId, null);
    assert.deepEqual(t.recurrence, { type: 'daily' });
    const done = tracker.completeTask(t.id);
    assert.equal(done.done, true);
    assert.ok(done.nextTaskId && done.nextTaskId !== t.id);
    const n = tracker.getTask(done.nextTaskId);
    assert.equal(n.due, '2026-03-03T09:30:00.000Z');
    assert.equal(n.done, false);
    assert.equal(n.nextTaskId, null);
});

test('02 daily crosses a month and a year boundary', () => {
    const { tracker } = fresh();
    const a = rec(tracker, { type: 'daily' }, '2026-01-31T23:00:00Z');
    const b = nextOf(tracker, a.id);
    assert.equal(b.due, '2026-02-01T23:00:00.000Z');
    const c = rec(tracker, { type: 'daily' }, '2026-12-31T00:00:00Z');
    assert.equal(nextOf(tracker, c.id).due, '2027-01-01T00:00:00.000Z');
});

test('03 the next task inherits user, title and recurrence and gets a fresh createdAt', () => {
    const { c, tracker } = fresh();
    const t = tracker.createTask({ userId: 'ann', title: 'Water plants', due: '2026-01-05T08:00:00Z', recurrence: { type: 'weekly', days: [1, 4] } });
    c.set('2026-01-05T08:10:00Z');
    const n = nextOf(tracker, t.id);
    assert.equal(n.userId, 'ann');
    assert.equal(n.title, 'Water plants');
    assert.deepEqual(n.recurrence, { type: 'weekly', days: [1, 4] });
    assert.equal(n.createdAt, '2026-01-05T08:10:00.000Z');
    assert.notEqual(n.id, t.id);
});

test('04 weekly picks the next listed weekday and wraps to the next week', () => {
    const { tracker } = fresh();
    const a = rec(tracker, { type: 'weekly', days: [1, 3] }, '2026-03-02T09:30:00Z'); // Monday
    const b = nextOf(tracker, a.id);
    assert.equal(b.due, '2026-03-04T09:30:00.000Z'); // Wednesday
    assert.equal(nextOf(tracker, b.id).due, '2026-03-09T09:30:00.000Z'); // next Monday
});

test('05 weekly with one day is exactly seven days later, never the same day', () => {
    const { tracker } = fresh();
    const a = rec(tracker, { type: 'weekly', days: [1] }, '2026-03-02T00:00:00Z');
    assert.equal(nextOf(tracker, a.id).due, '2026-03-09T00:00:00.000Z');
});

test('06 weekly across a year end, days given unsorted', () => {
    const { tracker } = fresh();
    const a = rec(tracker, { type: 'weekly', days: [3, 1] }, '2026-12-30T10:00:00Z'); // Wednesday
    assert.equal(nextOf(tracker, a.id).due, '2027-01-04T10:00:00.000Z'); // Monday
});

test('07 weekly with Sunday (0) and Saturday (6)', () => {
    const { tracker } = fresh();
    const a = rec(tracker, { type: 'weekly', days: [0, 6] }, '2026-03-07T12:00:00Z'); // Saturday
    const b = nextOf(tracker, a.id);
    assert.equal(b.due, '2026-03-08T12:00:00.000Z'); // Sunday
    assert.equal(nextOf(tracker, b.id).due, '2026-03-14T12:00:00.000Z');
});

test('08 monthly day 31 clamps to the last day, then returns to 31', () => {
    const { tracker } = fresh();
    const a = rec(tracker, { type: 'monthly', day: 31 }, '2026-01-31T06:00:00Z');
    const b = nextOf(tracker, a.id);
    assert.equal(b.due, '2026-02-28T06:00:00.000Z');
    const c = nextOf(tracker, b.id);
    assert.equal(c.due, '2026-03-31T06:00:00.000Z');
    assert.equal(nextOf(tracker, c.id).due, '2026-04-30T06:00:00.000Z');
});

test('09 monthly day 31 in a leap year ends on Feb 29', () => {
    const { tracker } = fresh();
    const a = rec(tracker, { type: 'monthly', day: 31 }, '2028-01-31T00:00:00Z');
    assert.equal(nextOf(tracker, a.id).due, '2028-02-29T00:00:00.000Z');
});

test('10 monthly rolls over the year, and a due earlier in the month fires in the same month', () => {
    const { tracker } = fresh();
    const a = rec(tracker, { type: 'monthly', day: 15 }, '2026-12-15T18:00:00Z');
    assert.equal(nextOf(tracker, a.id).due, '2027-01-15T18:00:00.000Z');
    const b = rec(tracker, { type: 'monthly', day: 31 }, '2026-01-15T18:00:00Z');
    assert.equal(nextOf(tracker, b.id).due, '2026-01-31T18:00:00.000Z');
});

test('11 the next due is computed from the old due, not from now', () => {
    const { c, tracker } = fresh();
    const a = rec(tracker, { type: 'daily' }, '2026-02-01T09:00:00Z');
    c.set('2026-02-10T20:00:00Z');
    assert.equal(nextOf(tracker, a.id).due, '2026-02-02T09:00:00.000Z');
});

test('12 non-recurring completion creates nothing; double completion creates nothing more', () => {
    const { tracker } = fresh();
    const plain = tracker.createTask({ userId: 'u1', title: 'once', due: '2026-02-01T00:00:00Z' });
    assert.equal(plain.recurrence, null);
    assert.equal(tracker.completeTask(plain.id).nextTaskId, null);
    assert.equal(tracker.listTasks().length, 1);
    const r = rec(tracker, { type: 'daily' }, '2026-02-01T00:00:00Z');
    tracker.completeTask(r.id);
    assert.throws(() => tracker.completeTask(r.id), ConflictError);
    assert.equal(tracker.listTasks({ done: false }).length, 1);
    assert.equal(tracker.listTasks().length, 3);
});

test('13 invalid recurrence is rejected: missing due, bad type, bad days, bad day', () => {
    const { tracker } = fresh();
    const bad = [
        [{ type: 'daily' }, undefined],
        [{ type: 'hourly' }, '2026-01-01T00:00:00Z'],
        [{ type: 'weekly', days: [] }, '2026-01-01T00:00:00Z'],
        [{ type: 'weekly', days: [7] }, '2026-01-01T00:00:00Z'],
        [{ type: 'weekly', days: [1, 1] }, '2026-01-01T00:00:00Z'],
        [{ type: 'weekly', days: [1.5] }, '2026-01-01T00:00:00Z'],
        [{ type: 'weekly' }, '2026-01-01T00:00:00Z'],
        [{ type: 'monthly', day: 0 }, '2026-01-01T00:00:00Z'],
        [{ type: 'monthly', day: 32 }, '2026-01-01T00:00:00Z'],
        [{ type: 'monthly', day: '5' }, '2026-01-01T00:00:00Z'],
        ['daily', '2026-01-01T00:00:00Z'],
    ];
    for (const [recurrence, due] of bad) {
        assert.throws(() => tracker.createTask({ userId: 'u1', title: 'x', due, recurrence }), ValidationError, JSON.stringify(recurrence));
    }
    assert.equal(tracker.listTasks().length, 0);
});

// ---- reminders ----

const HOUR = 3600e3;

test('14 offsets: default empty, stored sorted descending without duplicates, replaced on set', () => {
    const { tracker } = fresh();
    assert.deepEqual(tracker.getReminderOffsets('u1'), []);
    assert.deepEqual(tracker.setReminderOffsets('u1', [10, 60, 10]), [60, 10]);
    assert.deepEqual(tracker.getReminderOffsets('u1'), [60, 10]);
    assert.deepEqual(tracker.setReminderOffsets('u1', []), []);
    assert.deepEqual(tracker.getReminderOffsets('u1'), []);
});

test('15 offsets validation', () => {
    const { tracker } = fresh();
    for (const bad of [[0], [-5], [1.5], ['10'], [525601], [1, 2, 3, 4, 5, 6], 'x', null, undefined]) {
        assert.throws(() => tracker.setReminderOffsets('u1', bad), ValidationError, JSON.stringify(bad));
    }
    assert.deepEqual(tracker.setReminderOffsets('u1', [525600, 1]), [525600, 1]);
});

test('16 a reminder is delivered once, at its time, with the documented fields', () => {
    const { c, tracker } = fresh('2026-05-01T08:00:00Z');
    tracker.setReminderOffsets('u1', [60, 10]);
    const t = tracker.createTask({ userId: 'u1', title: 'Call', due: '2026-05-01T10:00:00Z' });
    assert.deepEqual(tracker.pollReminders('u1'), []);
    c.set('2026-05-01T09:00:00Z');
    const first = tracker.pollReminders('u1');
    assert.deepEqual(first, [{ taskId: t.id, userId: 'u1', title: 'Call', due: '2026-05-01T10:00:00.000Z', offsetMinutes: 60, remindAt: '2026-05-01T09:00:00.000Z' }]);
    assert.deepEqual(tracker.pollReminders('u1'), []);
    c.set('2026-05-01T09:50:00Z');
    const second = tracker.pollReminders('u1');
    assert.deepEqual(second.map(r => r.offsetMinutes), [10]);
    assert.deepEqual(tracker.pollReminders('u1'), []);
});

test('17 two passed offsets come out together, earliest remindAt first; none at or after due', () => {
    const { c, tracker } = fresh('2026-05-01T00:00:00Z');
    tracker.setReminderOffsets('u1', [10, 120]);
    tracker.createTask({ userId: 'u1', title: 'A', due: '2026-05-01T10:00:00Z' });
    c.set('2026-05-01T09:55:00Z');
    assert.deepEqual(tracker.pollReminders('u1').map(r => r.offsetMinutes), [120, 10]);
    const t2 = tracker.createTask({ userId: 'u1', title: 'B', due: '2026-05-01T10:00:00Z' });
    c.set('2026-05-01T10:00:00Z');
    assert.deepEqual(tracker.pollReminders('u1'), [], `task ${t2.id} is due now, too late for a reminder`);
});

test('18 completed tasks, tasks without due and other users produce no reminders', () => {
    const { c, tracker } = fresh('2026-05-01T00:00:00Z');
    tracker.setReminderOffsets('u1', [30]);
    tracker.setReminderOffsets('u2', [30]);
    const done = tracker.createTask({ userId: 'u1', title: 'done', due: '2026-05-01T05:00:00Z' });
    tracker.createTask({ userId: 'u1', title: 'nodue' });
    tracker.createTask({ userId: 'u2', title: 'theirs', due: '2026-05-01T05:00:00Z' });
    tracker.completeTask(done.id);
    c.set('2026-05-01T04:45:00Z');
    assert.deepEqual(tracker.pollReminders('u1'), []);
    assert.deepEqual(tracker.pollReminders('u2').map(r => r.title), ['theirs']);
    assert.deepEqual(tracker.pollReminders('u3'), []);
});

test('19 offsets are per user: one user polling does not consume another user reminders', () => {
    const { c, tracker } = fresh('2026-05-01T00:00:00Z');
    tracker.setReminderOffsets('a', [60]);
    tracker.setReminderOffsets('b', [30]);
    tracker.createTask({ userId: 'a', title: 'ta', due: '2026-05-01T03:00:00Z' });
    tracker.createTask({ userId: 'b', title: 'tb', due: '2026-05-01T03:00:00Z' });
    c.set('2026-05-01T02:35:00Z');
    assert.deepEqual(tracker.pollReminders('a').map(r => r.title), ['ta']);
    assert.deepEqual(tracker.pollReminders('b').map(r => r.title), ['tb']);
    assert.deepEqual(tracker.pollReminders('a'), []);
});

test('20 changing offsets applies to existing tasks but never repeats a delivered (task, offset)', () => {
    const { c, tracker } = fresh('2026-05-01T00:00:00Z');
    tracker.setReminderOffsets('u1', [60]);
    tracker.createTask({ userId: 'u1', title: 'x', due: '2026-05-01T10:00:00Z' });
    c.set('2026-05-01T09:00:00Z');
    assert.equal(tracker.pollReminders('u1').length, 1);
    tracker.setReminderOffsets('u1', [60, 30]);
    assert.deepEqual(tracker.pollReminders('u1'), []);
    c.set('2026-05-01T09:30:00Z');
    assert.deepEqual(tracker.pollReminders('u1').map(r => r.offsetMinutes), [30]);
    tracker.setReminderOffsets('u1', [30]);
    tracker.setReminderOffsets('u1', [60, 30]);
    assert.deepEqual(tracker.pollReminders('u1'), []);
});

test('21 the next task of a recurring task has its own reminders', () => {
    const { c, tracker } = fresh('2026-05-01T00:00:00Z');
    tracker.setReminderOffsets('u1', [60]);
    const a = rec(tracker, { type: 'daily' }, '2026-05-01T10:00:00Z');
    c.set('2026-05-01T09:00:00Z');
    assert.deepEqual(tracker.pollReminders('u1').map(r => r.taskId), [a.id]);
    const done = tracker.completeTask(a.id);
    assert.deepEqual(tracker.pollReminders('u1'), []);
    c.set('2026-05-02T09:00:00Z');
    assert.deepEqual(tracker.pollReminders('u1').map(r => r.taskId), [done.nextTaskId]);
    assert.deepEqual(tracker.pollReminders('u1'), []);
});

// ---- HTTP ----

test('22 HTTP: create a recurring task, complete it, the next one is listed', async () => {
    const s = await http(clock('2026-01-01T00:00:00Z'));
    try {
        const created = await s.call('POST', '/tasks', { userId: 'u1', title: 'Standup', due: '2026-03-02T09:00:00Z', recurrence: { type: 'weekly', days: [1, 3, 5] } });
        assert.equal(created.status, 201);
        assert.deepEqual(created.body.recurrence, { type: 'weekly', days: [1, 3, 5] });
        assert.equal(created.body.nextTaskId, null);
        const done = await s.call('POST', `/tasks/${created.body.id}/complete`);
        assert.equal(done.status, 200);
        assert.ok(done.body.nextTaskId);
        const list = await s.call('GET', '/tasks?userId=u1&done=false');
        assert.deepEqual(list.body.tasks.map(t => [t.id, t.due]), [[done.body.nextTaskId, '2026-03-04T09:00:00.000Z']]);
        assert.equal((await s.call('POST', `/tasks/${created.body.id}/complete`)).status, 409);
        assert.equal((await s.call('POST', '/tasks', { userId: 'u1', title: 'bad', recurrence: { type: 'daily' } })).status, 400);
        assert.equal((await s.call('POST', '/tasks', { userId: 'u1', title: 'bad', due: '2026-03-02T09:00:00Z', recurrence: { type: 'monthly', day: 40 } })).status, 400);
    } finally { await s.close(); }
});

test('23 HTTP: reminder offsets and polling', async () => {
    const c = clock('2026-05-01T08:00:00Z');
    const s = await http(c);
    try {
        const empty = await s.call('GET', '/users/u1/reminders');
        assert.equal(empty.status, 200);
        assert.deepEqual(empty.body, { userId: 'u1', offsetsMinutes: [] });
        const put = await s.call('PUT', '/users/u1/reminders', { offsetsMinutes: [15, 60, 15] });
        assert.equal(put.status, 200);
        assert.deepEqual(put.body, { userId: 'u1', offsetsMinutes: [60, 15] });
        assert.deepEqual((await s.call('GET', '/users/u1/reminders')).body.offsetsMinutes, [60, 15]);
        const task = await s.call('POST', '/tasks', { userId: 'u1', title: 'Pay rent', due: '2026-05-01T10:00:00Z' });
        assert.deepEqual((await s.call('POST', '/users/u1/reminders/poll')).body, { reminders: [] });
        c.set('2026-05-01T09:00:00Z');
        const poll = await s.call('POST', '/users/u1/reminders/poll');
        assert.equal(poll.status, 200);
        assert.equal(poll.body.reminders.length, 1);
        assert.equal(poll.body.reminders[0].taskId, task.body.id);
        assert.equal(poll.body.reminders[0].offsetMinutes, 60);
        assert.deepEqual((await s.call('POST', '/users/u1/reminders/poll')).body, { reminders: [] });
    } finally { await s.close(); }
});

test('24 HTTP: invalid offsets are 400, existing routes unchanged', async () => {
    const s = await http(clock('2026-05-01T08:00:00Z'));
    try {
        assert.equal((await s.call('PUT', '/users/u1/reminders', { offsetsMinutes: [0] })).status, 400);
        assert.equal((await s.call('PUT', '/users/u1/reminders', { offsetsMinutes: 'x' })).status, 400);
        assert.equal((await s.call('PUT', '/users/u1/reminders', {})).status, 400);
        assert.equal((await s.call('GET', '/users/u1/reminders')).body.offsetsMinutes.length, 0);
        assert.equal((await s.call('POST', '/tasks/missing/complete')).status, 404);
        const plain = await s.call('POST', '/tasks', { userId: 'u1', title: 'plain' });
        assert.equal(plain.status, 201);
        assert.equal((await s.call('POST', `/tasks/${plain.body.id}/complete`)).body.nextTaskId, null);
        assert.equal((await s.call('GET', '/health')).status, 200);
    } finally { await s.close(); }
});
