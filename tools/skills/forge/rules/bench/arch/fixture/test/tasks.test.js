import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictError, NotFoundError, ValidationError, createTracker } from '../src/index.js';
import { fakeClock } from './helpers.js';

const clock = () => fakeClock('2026-01-01T00:00:00Z');

test('createTask stores a trimmed task with defaults', () => {
    const tracker = createTracker({ now: clock() });
    const t = tracker.createTask({ userId: ' u1 ', title: '  Buy milk ' });
    assert.equal(t.userId, 'u1');
    assert.equal(t.title, 'Buy milk');
    assert.equal(t.done, false);
    assert.equal(t.due, null);
    assert.equal(t.createdAt, '2026-01-01T00:00:00.000Z');
    assert.equal(t.completedAt, null);
});

test('createTask normalises due to ISO UTC', () => {
    const tracker = createTracker({ now: clock() });
    const t = tracker.createTask({ userId: 'u1', title: 'x', due: '2026-02-03T10:00:00+02:00' });
    assert.equal(t.due, '2026-02-03T08:00:00.000Z');
});

test('createTask rejects bad input', () => {
    const tracker = createTracker({ now: clock() });
    assert.throws(() => tracker.createTask({ title: 'x' }), ValidationError);
    assert.throws(() => tracker.createTask({ userId: 'u1', title: '   ' }), ValidationError);
    assert.throws(() => tracker.createTask({ userId: 'u1', title: 'x', due: 'soon' }), ValidationError);
    assert.throws(() => tracker.createTask({ userId: 'u1', title: 'x'.repeat(201) }), ValidationError);
    assert.throws(() => tracker.createTask(null), ValidationError);
});

test('getTask returns a copy and throws for unknown ids', () => {
    const tracker = createTracker({ now: clock() });
    const t = tracker.createTask({ userId: 'u1', title: 'a' });
    t.title = 'changed';
    assert.equal(tracker.getTask(t.id).title, 'a');
    assert.throws(() => tracker.getTask('nope'), NotFoundError);
});

test('listTasks filters by user and done, sorted by due with undated last', () => {
    const tracker = createTracker({ now: clock() });
    tracker.createTask({ userId: 'u1', title: 'no due' });
    tracker.createTask({ userId: 'u1', title: 'late', due: '2026-03-01T00:00:00Z' });
    tracker.createTask({ userId: 'u2', title: 'other', due: '2026-01-15T00:00:00Z' });
    const early = tracker.createTask({ userId: 'u1', title: 'early', due: '2026-02-01T00:00:00Z' });
    assert.deepEqual(tracker.listTasks({ userId: 'u1' }).map(t => t.title), ['early', 'late', 'no due']);
    tracker.completeTask(early.id);
    assert.deepEqual(tracker.listTasks({ userId: 'u1', done: false }).map(t => t.title), ['late', 'no due']);
    assert.deepEqual(tracker.listTasks({ done: true }).map(t => t.title), ['early']);
    assert.throws(() => tracker.listTasks({ done: 'yes' }), ValidationError);
});

test('completeTask marks the task done once', () => {
    const c = clock();
    const tracker = createTracker({ now: c });
    const t = tracker.createTask({ userId: 'u1', title: 'a' });
    c.set('2026-01-02T12:00:00Z');
    const done = tracker.completeTask(t.id);
    assert.equal(done.done, true);
    assert.equal(done.completedAt, '2026-01-02T12:00:00.000Z');
    assert.throws(() => tracker.completeTask(t.id), ConflictError);
    assert.throws(() => tracker.completeTask('nope'), NotFoundError);
});
