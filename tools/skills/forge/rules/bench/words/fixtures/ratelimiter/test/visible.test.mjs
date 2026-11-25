import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket } from '../src/token-bucket.js';

test('starts full and empties', () => {
  let t = 0;
  const b = new TokenBucket({ capacity: 3, refillPerSecond: 1, now: () => t });
  assert.equal(b.tryConsume(), true);
  assert.equal(b.tryConsume(), true);
  assert.equal(b.tryConsume(), true);
  assert.equal(b.tryConsume(), false);
});

test('refills over time', () => {
  let t = 0;
  const b = new TokenBucket({ capacity: 2, refillPerSecond: 1, now: () => t });
  b.tryConsume(2);
  t = 1000;
  assert.equal(b.tryConsume(), true);
  assert.equal(b.tryConsume(), false);
});

test('rejects bad capacity', () => {
  assert.throws(() => new TokenBucket({ capacity: 0, refillPerSecond: 1 }));
});
