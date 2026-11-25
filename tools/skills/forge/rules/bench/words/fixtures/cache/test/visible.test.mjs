import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LRUCache } from '../src/lru-cache.js';

test('stores and reads', () => {
  const c = new LRUCache({ maxSize: 2 });
  c.set('a', 1).set('b', 2);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('x'), undefined);
  assert.equal(c.size, 2);
});

test('evicts the least recently used', () => {
  const c = new LRUCache({ maxSize: 2 });
  c.set('a', 1).set('b', 2);
  c.get('a');
  c.set('c', 3);
  assert.equal(c.has('b'), false);
  assert.deepEqual(c.keys(), ['c', 'a']);
});

test('entries expire', () => {
  let t = 0;
  const c = new LRUCache({ maxSize: 5, ttlMs: 100, now: () => t });
  c.set('a', 1);
  t = 100;
  assert.equal(c.get('a'), undefined);
});
