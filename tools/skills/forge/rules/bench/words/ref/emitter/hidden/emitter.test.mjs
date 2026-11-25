import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Emitter } from '../src/emitter.js';

test('e01 emit returns the number of listeners called, 0 for none', () => {
  const e = new Emitter(); assert.equal(e.emit('nothing'), 0); e.on('a', () => { }); e.on('a', () => { }); e.on('*', () => { });
  assert.equal(e.emit('a'), 3); assert.equal(e.emit('b'), 1);
});
test('e02 wildcard runs after specific listeners and receives the event name', () => {
  const e = new Emitter(), log = []; e.on('*', (ev, ...a) => log.push(['*', ev, ...a])); e.on('a', (...a) => log.push(['a', ...a])); e.emit('a', 1, 2);
  assert.deepEqual(log, [['a', 1, 2], ['*', 'a', 1, 2]]);
});
test('e03 emit of the wildcard name throws, listenerCount counts wildcards', () => {
  const e = new Emitter(); e.on('*', () => { }); e.on('*', () => { }); e.on('a', () => { });
  assert.throws(() => e.emit('*'), Error); assert.equal(e.listenerCount('*'), 2); assert.equal(e.listenerCount('a'), 1); assert.equal(e.listenerCount('zzz'), 0);
});
test('e04 this is the emitter', () => {
  const e = new Emitter(); let self; e.on('a', function () { self = this; }); e.emit('a'); assert.equal(self, e);
});
test('e05 non-function listener throws TypeError', () => {
  const e = new Emitter(); for (const f of [undefined, null, 'x', 5, {}]) { assert.throws(() => e.on('a', f), TypeError); assert.throws(() => e.once('a', f), TypeError); }
  assert.equal(e.listenerCount('a'), 0);
});
test('e06 same function twice is called twice; off removes the latest one', () => {
  const e = new Emitter(); let n = 0; const f = () => n++; e.on('a', f); e.on('a', f); e.emit('a'); assert.equal(n, 2);
  assert.equal(e.off('a', f), true); assert.equal(e.listenerCount('a'), 1); assert.equal(e.off('a', f), true); assert.equal(e.off('a', f), false);
});
test('e07 off removes the most recent registration, order of the rest kept', () => {
  const e = new Emitter(), log = []; const f = () => log.push('f'); e.on('a', f); e.on('a', () => log.push('g')); e.on('a', f); e.off('a', f); e.emit('a'); assert.deepEqual(log, ['f', 'g']);
});
test('e08 off also removes a once listener', () => {
  const e = new Emitter(); let n = 0; const f = () => n++; e.once('a', f); assert.equal(e.off('a', f), true); e.emit('a'); assert.equal(n, 0);
});
test('e09 unsubscribe removes only its own registration and is idempotent', () => {
  const e = new Emitter(); let n = 0; const f = () => n++; const u1 = e.on('a', f); e.on('a', f); u1(); u1(); u1(); assert.equal(e.listenerCount('a'), 1); e.emit('a'); assert.equal(n, 1);
});
test('e10 once is removed before it runs: reentrant emit does not run it twice', () => {
  const e = new Emitter(); let n = 0; e.once('a', () => { n++; if (n < 5) e.emit('a'); }); e.emit('a'); assert.equal(n, 1); assert.equal(e.listenerCount('a'), 0);
});
test('e11 once unsubscribe works before firing', () => {
  const e = new Emitter(); let n = 0; const u = e.once('a', () => n++); u(); e.emit('a'); assert.equal(n, 0);
});
test('e12 listener added during emit is not called in that emit', () => {
  const e = new Emitter(), log = []; e.on('a', () => { log.push('first'); e.on('a', () => log.push('late')); }); assert.equal(e.emit('a'), 1); assert.deepEqual(log, ['first']); e.emit('a'); assert.deepEqual(log, ['first', 'first', 'late']);
});
test('e13 listener removed during emit before its turn is not called', () => {
  const e = new Emitter(), log = []; let u; e.on('a', () => { log.push('first'); u(); }); u = e.on('a', () => log.push('second')); e.on('a', () => log.push('third'));
  assert.equal(e.emit('a'), 2); assert.deepEqual(log, ['first', 'third']);
});
test('e14 a throwing listener does not stop the others; single error rethrown as is', () => {
  const e = new Emitter(), log = [], boom = new RangeError('boom'); e.on('a', () => { throw boom; }); e.on('a', () => log.push('after')); e.on('*', () => log.push('wild'));
  assert.throws(() => e.emit('a'), x => x === boom); assert.deepEqual(log, ['after', 'wild']);
});
test('e15 several errors become an AggregateError in order', () => {
  const e = new Emitter(), e1 = new Error('1'), e2 = new Error('2'); e.on('a', () => { throw e1; }); e.on('a', () => { }); e.on('*', () => { throw e2; });
  try { e.emit('a'); assert.fail('no throw'); } catch (x) { assert.ok(x instanceof AggregateError); assert.deepEqual(x.errors, [e1, e2]); }
});
test('e16 event keys: symbols, objects, numbers vs strings', () => {
  const e = new Emitter(), s = Symbol('s'), o = {}; let n = 0; e.on(s, () => n++); e.on(o, () => n += 10); e.on(1, () => n += 100);
  e.emit(s); e.emit(o); e.emit('1'); e.emit(1); assert.equal(n, 111);
});
test('e17 once listener that throws is still removed', () => {
  const e = new Emitter(); e.once('a', () => { throw new Error('x'); }); assert.throws(() => e.emit('a')); assert.equal(e.listenerCount('a'), 0); assert.equal(e.emit('a'), 0);
});
