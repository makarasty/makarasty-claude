import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LRUCache } from '../src/lru-cache.js';

const mk = (o = {}) => { const c = { t: 0 }; const ev = []; const cache = new LRUCache({ maxSize: 3, now: () => c.t, onEvict: (k, v, r) => ev.push([k, v, r]), ...o }); return [cache, c, ev]; };

test('k01 set replaces value, is chainable, no eviction event, becomes most recent', () => {
  const [c, , ev] = mk(); c.set('a', 1).set('b', 2).set('a', 9);
  assert.equal(c.get('a'), 9); assert.deepEqual(c.keys(), ['a', 'b']); assert.deepEqual(ev, []);
});
test('k02 capacity eviction removes LRU, reports reason and value', () => {
  const [c, , ev] = mk(); c.set('a', 1).set('b', 2).set('c', 3); c.get('a'); c.set('d', 4);
  assert.deepEqual(ev, [['b', 2, 'capacity']]); assert.deepEqual(c.keys(), ['d', 'a', 'c']);
});
test('k03 peek and has do not change recency, get does', () => {
  const [c] = mk(); c.set('a', 1).set('b', 2).set('c', 3);
  c.peek('a'); c.has('a'); assert.deepEqual(c.keys(), ['c', 'b', 'a']);
  c.get('a'); assert.deepEqual(c.keys(), ['a', 'c', 'b']);
});
test('k04 expiry boundary: expired at exactly t + ttl', () => {
  const [c, clk] = mk({ ttlMs: 100 }); c.set('a', 1); clk.t = 99; assert.equal(c.get('a'), 1); clk.t = 100; assert.equal(c.get('a'), undefined); assert.equal(c.has('a'), false);
});
test('k05 get does not extend expiry, set resets it', () => {
  const [c, clk] = mk({ ttlMs: 100 }); c.set('a', 1); clk.t = 60; c.get('a'); clk.t = 100; assert.equal(c.has('a'), false);
  clk.t = 200; c.set('b', 1); clk.t = 260; c.set('b', 2); clk.t = 330; assert.equal(c.get('b'), 2);
});
test('k06 expired entries reported exactly once as expired', () => {
  const [c, clk, ev] = mk({ ttlMs: 50 }); c.set('a', 1).set('b', 2); clk.t = 50;
  assert.equal(c.size, 0); assert.equal(c.get('a'), undefined); assert.equal(c.has('b'), false); assert.equal(c.size, 0);
  assert.deepEqual(ev.map(e => e[2]), ['expired', 'expired']); assert.deepEqual(ev.map(e => e[0]).sort(), ['a', 'b']);
});
test('k07 expired entries are purged before live ones are evicted', () => {
  const [c, clk, ev] = mk(); c.set('old', 1, { ttlMs: 10 }); c.set('b', 2); c.set('c', 3); clk.t = 20;
  c.set('d', 4); assert.deepEqual(ev, [['old', 1, 'expired']]); assert.deepEqual(c.keys(), ['d', 'c', 'b']);
});
test('k08 expired entries do not count towards size or capacity', () => {
  const [c, clk] = mk({ maxSize: 2 }); c.set('a', 1, { ttlMs: 5 }); c.set('b', 2); clk.t = 5; assert.equal(c.size, 1); c.set('c', 3); assert.deepEqual(c.keys(), ['c', 'b']);
});
test('k09 per-entry ttl overrides default, Infinity means never', () => {
  const [c, clk] = mk({ ttlMs: 10 }); c.set('a', 1); c.set('b', 2, { ttlMs: 100 }); c.set('c', 3, { ttlMs: Infinity }); clk.t = 50;
  assert.deepEqual(c.keys(), ['c', 'b']); clk.t = 1e9; assert.equal(c.get('c'), 3);
});
test('k10 delete: true for live, false for missing and expired, reports reason', () => {
  const [c, clk, ev] = mk({ ttlMs: 10 }); c.set('a', 1); c.set('b', 2, { ttlMs: 1000 });
  assert.equal(c.delete('b'), true); assert.equal(c.delete('b'), false); clk.t = 10; assert.equal(c.delete('a'), false);
  assert.deepEqual(ev, [['b', 2, 'deleted'], ['a', 1, 'expired']]);
});
test('k11 clear reports live entries LRU first, expired as expired', () => {
  const [c, clk, ev] = mk(); c.set('a', 1).set('b', 2, { ttlMs: 5 }).set('c', 3); c.get('a'); clk.t = 5; c.clear();
  assert.equal(c.size, 0); assert.deepEqual(ev, [['b', 2, 'expired'], ['c', 3, 'deleted'], ['a', 1, 'deleted']]);
});
test('k12 onEvict sees the updated state', () => {
  let seen; const cache = new LRUCache({ maxSize: 1, onEvict(k) { seen = [cache.has(k), cache.size]; } }); cache.set('a', 1); cache.set('b', 2); assert.deepEqual(seen, [false, 1]);
});
test('k13 undefined value is stored, key semantics like Map', () => {
  const [c] = mk({ maxSize: 4 }); c.set('u', undefined); assert.equal(c.has('u'), true); assert.equal(c.get('u'), undefined);
  c.set(NaN, 'n'); c.set(1, 'one'); c.set('1', 'str'); assert.equal(c.get(NaN), 'n'); assert.equal(c.get(1), 'one'); assert.equal(c.get('1'), 'str'); assert.equal(c.size, 4);
});
test('k14 maxSize 1', () => {
  const [c, , ev] = mk({ maxSize: 1 }); c.set('a', 1); c.set('b', 2); assert.deepEqual(c.keys(), ['b']); assert.deepEqual(ev, [['a', 1, 'capacity']]);
});
test('k15 invalid constructor and set arguments throw', () => {
  for (const bad of [{ maxSize: 0 }, { maxSize: -1 }, { maxSize: 1.5 }, { maxSize: '3' }, { maxSize: undefined }, { ttlMs: 0 }, { ttlMs: -5 }, { ttlMs: NaN }, { ttlMs: '10' }, { now: 5 }, { onEvict: 'x' }])
    assert.throws(() => new LRUCache({ maxSize: 3, ...bad }), undefined, JSON.stringify(bad));
  const [c] = mk(); assert.throws(() => c.set('a', 1, { ttlMs: 0 })); assert.throws(() => c.set('a', 1, { ttlMs: NaN })); assert.equal(c.has('a'), false);
});
test('k16 works without onEvict and without ttl', () => {
  const c = new LRUCache({ maxSize: 2 }); c.set('a', 1).set('b', 2).set('c', 3); assert.deepEqual(c.keys(), ['c', 'b']); assert.equal(c.delete('c'), true);
});
